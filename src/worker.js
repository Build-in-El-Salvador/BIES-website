/**
 * Worker for buildinelsalvador.com (Cloudflare Worker "bies-website").
 *
 * The site is still a static site. Requests that match a file in the repo are
 * answered by the assets layer before this script runs (see wrangler.jsonc and
 * .assetsignore). This script only sees paths that match no file, and it adds
 * exactly one route:
 *
 *   GET /api/events  ->  the JSON that the Events page (events.html) renders.
 *
 * pretix at tickets.buildinelsalvador.com is the single source of event data:
 * staff publish, edit and sell events there, and nobody edits this repo per
 * event. Only pretix's PUBLIC pages are read, so no secret is needed. If a
 * read-only pretix API token is ever stored as the Worker secret PRETIX_TOKEN,
 * it adds three extras the public pages do not carry: a per-event "host" and
 * "status" (organizer event properties) and map coordinates.
 */

const CFG = {
  pretix: 'https://tickets.buildinelsalvador.com',
  org: 'bies',
  orgName: 'Build in El Salvador',
  timezone: 'America/El_Salvador', // every BIES event; the optional API token can override per event
  maxUpcoming: 8,
  maxPast: 6, // 2 list requests + 2 per event + 1 optional API call stays well under the 50-subrequest limit
  freshSeconds: 120, // how long one built copy is served before pretix is asked again
  lastGoodSeconds: 7 * 24 * 3600, // how long the last good copy is kept to ride out a pretix outage
  browserSeconds: 60,
  timeoutMs: 8000,
};

const ORG_URL = `${CFG.pretix}/${CFG.org}/`;
const EVENT_URL_RE = new RegExp(`^${escapeRe(ORG_URL)}([A-Za-z0-9][A-Za-z0-9._-]{0,49})/$`);

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/events') return eventsRoute(request, env, ctx);
    if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    // Anything else that reached the script matched no file: let the assets
    // layer answer exactly as it did before this Worker had a script.
    return env.ASSETS.fetch(request);
  },
};

async function eventsRoute(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, 0, { Allow: 'GET, HEAD' });
  }
  const origin = new URL(request.url).origin;
  const freshKey = new Request(`${origin}/api/events`);
  const lastGoodKey = new Request(`${origin}/api/events?last-good`);
  const cache = caches.default; // per data centre; a no-op on *.workers.dev and in local dev

  const hit = await cache.match(freshKey);
  if (hit) return withBrowserCache(hit);

  try {
    const body = JSON.stringify(await buildEvents(env));
    ctx.waitUntil(
      Promise.all([
        cache.put(freshKey, json(body, 200, CFG.freshSeconds)),
        cache.put(lastGoodKey, json(body, 200, CFG.lastGoodSeconds)),
      ]).catch((err) => warn('cache write failed', err)),
    );
    return json(body, 200, CFG.browserSeconds);
  } catch (err) {
    console.error('events: build failed', err && err.stack ? err.stack : String(err));
    const saved = await cache.match(lastGoodKey);
    if (saved) {
      const data = await saved.json();
      data.stale = true;
      return json(data, 200, 0);
    }
    return json({ error: 'unavailable', fallback_url: ORG_URL }, 503, 0);
  }
}

async function buildEvents(env) {
  const [upcomingList, pastList, api] = await Promise.all([
    getJson(`${ORG_URL}widget/product_list?lang=en`), // pretix's own "upcoming, live, public" list
    getJson(`${ORG_URL}widget/product_list?lang=en&old=1`).catch((err) => {
      warn('past list skipped', err);
      return { events: [] };
    }),
    apiIndex(env).catch((err) => {
      warn('API extras skipped', err);
      return null;
    }),
  ]);

  const entries = [
    ...listEntries(upcomingList, false).slice(0, CFG.maxUpcoming),
    ...listEntries(pastList, true).slice(0, CFG.maxPast),
  ];
  const events = await Promise.all(entries.map((entry) => eventDetail(entry, api)));
  const byStart = (a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0);

  return {
    generated_at: new Date().toISOString(),
    stale: false,
    organizer: { name: CFG.orgName, url: ORG_URL, ics_url: `${ORG_URL}events/ical/` },
    upcoming: events.filter((e) => !e.is_past).sort(byStart),
    past: events.filter((e) => e.is_past).sort((a, b) => byStart(b, a)),
  };
}

function listEntries(list, isPast) {
  const events = list && Array.isArray(list.events) ? list.events : [];
  return events
    .map((e) => {
      const m = EVENT_URL_RE.exec(e.event_url || '');
      if (!m || e.subevent) return null; // only plain single events on our own organizer
      return {
        slug: m[1],
        title: text(e.name),
        location: text(e.location),
        date_range: text(e.date_range),
        availability: e.availability
          ? { reason: text(e.availability.reason), text: text(e.availability.text) }
          : null,
        tickets_url: e.event_url,
        is_past: isPast,
      };
    })
    .filter(Boolean);
}

async function eventDetail(entry, api) {
  const [page, shop] = await Promise.all([
    getText(entry.tickets_url).catch((err) => {
      warn(`event page ${entry.slug}`, err);
      return '';
    }),
    getJson(`${entry.tickets_url}widget/product_list?lang=en`).catch((err) => {
      warn(`shop data ${entry.slug}`, err);
      return null;
    }),
  ]);

  const ld = eventJsonLd(page); // pretix renders schema.org Event JSON-LD with exact UTC start/end
  const extra = (api && api.get(entry.slug)) || {};
  const geo = Number.isFinite(extra.geo_lat) && Number.isFinite(extra.geo_lon)
    ? { lat: extra.geo_lat, lon: extra.geo_lon }
    : null;
  const tickets = shop ? shopTickets(shop) : [];
  const available = tickets.filter((t) => t.available);
  const prices = (available.length ? available : tickets)
    .map((t) => Number(t.price))
    .filter(Number.isFinite);

  let sales;
  if (entry.is_past) sales = 'past';
  else if (shop && shop.error) sales = 'closed'; // e.g. "The booking period for this event is over."
  else if (!tickets.length) sales = 'none';
  else if (available.length) sales = 'open';
  else sales = 'sold_out';

  return {
    slug: entry.slug,
    title: entry.title || text(shop && shop.name) || text(ld.name),
    start: text(extra.date_from) || text(ld.startDate) || null,
    end: text(extra.date_to) || text(ld.endDate) || null,
    timezone: text(extra.timezone) || CFG.timezone,
    date_range: entry.date_range || text(shop && shop.date_range),
    location: entry.location || null,
    geo,
    map_url: mapUrl(geo, entry.location),
    host: text(extra.host) || CFG.orgName,
    status: ['cancelled', 'postponed'].includes(text(extra.status).toLowerCase())
      ? text(extra.status).toLowerCase()
      : null,
    // The event's "Social media image" in pretix (Settings -> Shop design) is the cover.
    cover: safeUrl(metaContent(page, 'og:image') || firstImage(ld.image), entry.tickets_url),
    description_html: shop ? String(shop.frontpage_text || '') : '', // pretix-sanitised Markdown output
    currency: text(shop && shop.currency) || 'USD',
    tickets,
    price_from: prices.length ? Math.min(...prices).toFixed(2) : null,
    price_to: prices.length ? Math.max(...prices).toFixed(2) : null,
    availability: entry.availability,
    sales,
    sales_note: shop && shop.error ? text(shop.error) : null,
    waiting_list: Boolean(shop && shop.waiting_list_enabled),
    tickets_url: entry.tickets_url,
    ics_url: `${entry.tickets_url}ical/`,
    is_past: entry.is_past,
  };
}

function shopTickets(shop) {
  const priceOf = (x) => (x && x.price && x.price.gross != null ? Number(x.price.gross) : NaN);
  const availOf = (x) => (Array.isArray(x && x.avail) ? x.avail : [null, null]);
  const out = [];
  for (const cat of shop.items_by_category || []) {
    for (const it of cat.items || []) {
      const variations = it.has_variations && Array.isArray(it.variations) ? it.variations : null;
      const prices = (variations || [it]).map(priceOf).filter(Number.isFinite);
      const avails = (variations || [it]).map(availOf);
      const open = avails.filter((a) => a[0] === 100); // pretix AVAILABILITY_OK
      const left = open.map((a) => a[1]).filter(Number.isFinite); // only set if "show quota left" is on
      out.push({
        id: it.id,
        name: text(it.name),
        description_html: String(it.description || ''),
        price: prices.length ? Math.min(...prices).toFixed(2) : null,
        price_varies: new Set(prices).size > 1,
        free_price: Boolean(it.free_price),
        available: open.length > 0,
        left: left.length ? left.reduce((sum, n) => sum + n, 0) : null,
      });
    }
  }
  return out;
}

// Optional: only runs when the PRETIX_TOKEN secret exists. One request for all events.
async function apiIndex(env) {
  if (!env.PRETIX_TOKEN) return null;
  const data = await getJson(
    `${CFG.pretix}/api/v1/organizers/${CFG.org}/events/?live=true&is_public=true&ordering=-date_from`,
    { Authorization: `Token ${env.PRETIX_TOKEN}` },
  );
  const index = new Map();
  for (const ev of data.results || []) {
    const meta = ev.meta_data || {};
    index.set(ev.slug, {
      date_from: ev.date_from,
      date_to: ev.date_to,
      timezone: ev.timezone,
      geo_lat: ev.geo_lat == null ? NaN : Number(ev.geo_lat),
      geo_lon: ev.geo_lon == null ? NaN : Number(ev.geo_lon),
      host: meta.host,
      status: meta.status,
    });
  }
  return index;
}

// ---------- small helpers ----------

async function fetchOk(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'bies-website-events/1', 'Accept-Language': 'en', ...headers },
    signal: AbortSignal.timeout(CFG.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}
const getJson = (url, headers) =>
  fetchOk(url, { Accept: 'application/json', ...headers }).then((r) => r.json());
const getText = (url) => fetchOk(url, { Accept: 'text/html' }).then((r) => r.text());

function eventJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1]);
      const nodes = Array.isArray(data) ? data : data['@graph'] || [data];
      const ev = nodes.find((n) => n && /Event$/.test(String(n['@type'])));
      if (ev) return ev;
    } catch (_) {
      // a malformed block is skipped, not fatal
    }
  }
  return {};
}

function metaContent(html, prop) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if ((attr(tag, 'property') || attr(tag, 'name')) === prop) return decodeEntities(attr(tag, 'content') || '');
  }
  return null;
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function firstImage(image) {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return firstImage(image[0]);
  return typeof image.url === 'string' ? image.url : null;
}

function safeUrl(value, base) {
  if (!value) return null;
  try {
    const u = new URL(value, base);
    return u.protocol === 'https:' ? u.href : null;
  } catch (_) {
    return null;
  }
}

function mapUrl(geo, location) {
  if (geo) return `https://www.google.com/maps/search/?api=1&query=${geo.lat}%2C${geo.lon}`;
  if (location) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function warn(label, err) {
  console.warn(`events: ${label}:`, err && err.message ? err.message : String(err));
}

function withBrowserCache(response) {
  const r = new Response(response.body, response);
  r.headers.set('Cache-Control', `public, max-age=${CFG.browserSeconds}`);
  return r;
}

function json(body, status = 200, maxAge = 0, extraHeaders = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}
