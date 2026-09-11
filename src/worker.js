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
  // /api/events is only built for these hosts (and local previews). The Cache API does
  // nothing on *.workers.dev, so every request there would re-read pretix ~30 times.
  hosts: ['buildinelsalvador.com', 'www.buildinelsalvador.com'],
  maxUpcoming: 8,
  maxPast: 6, // 2 list requests + 2 per event + 1 optional API call stays well under the 50-subrequest limit
  freshSeconds: 120, // how long one built copy is served before pretix is asked again
  retrySeconds: 30, // how long a build that lost some event details is served before retrying
  lastGoodSeconds: 7 * 24 * 3600, // how long the last good copy is kept to ride out a pretix outage
  browserSeconds: 60,
  buildMs: 9000, // one deadline for the whole build, under the Events page's 12 s wait (events.js)
  optionalMs: 3000, // the past list and the API extras, so upcoming events never wait on them
};

const ORG_URL = `${CFG.pretix}/${CFG.org}/`;
const EVENT_URL_RE = new RegExp(`^${escapeRe(ORG_URL)}([A-Za-z0-9][A-Za-z0-9._-]{0,49})/$`);
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])$/;
// pretix product "current_unavailability_reason" values for tickets the public can't buy at
// all: switched off, voucher-only, or hidden while another ticket is available. Left out.
const HIDDEN_REASONS = new Set(['active', 'require_voucher', 'hidden_if_item_available']);

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
  const url = new URL(request.url);
  const host = url.hostname.replace(/\.$/, '');
  if (!CFG.hosts.includes(host) && !LOCAL_HOST_RE.test(host)) {
    return json({ error: 'not_found' }, 404);
  }
  const freshKey = new Request(`${url.origin}/api/events`);
  const lastGoodKey = new Request(`${url.origin}/api/events?last-good`);
  const cache = caches.default; // per data centre; a no-op in local dev

  const hit = await cache.match(freshKey);
  if (hit) return withBrowserCache(hit);

  let built;
  try {
    built = await buildEvents(env);
  } catch (err) {
    console.error('events: build failed', err && err.stack ? err.stack : String(err));
    const saved = await readJson(cache, lastGoodKey);
    if (saved) {
      saved.stale = true;
      return json(saved, 200, 0);
    }
    return json({ error: 'unavailable', fallback_url: ORG_URL }, 503, 0);
  }

  const { data, gaps } = built;
  if (gaps.past || gaps.api || gaps.page.size || gaps.shop.size) {
    // pretix answered the upcoming list but not everything else. Fill what it can from the
    // last good copy, keep this build only briefly, and never let it replace that copy.
    console.warn(`events: partial build (past list ${gaps.past ? 'failed' : 'ok'}; API ${gaps.api ? 'failed' : 'ok'}; `
      + `pages failed: ${[...gaps.page].join(', ') || 'none'}; shops failed: ${[...gaps.shop].join(', ') || 'none'})`);
    fillGaps(data, gaps, await readJson(cache, lastGoodKey));
    const body = JSON.stringify(data);
    ctx.waitUntil(cache.put(freshKey, json(body, 200, CFG.retrySeconds)).catch((err) => warn('cache write failed', err)));
    return json(body, 200, CFG.retrySeconds);
  }

  const body = JSON.stringify(data);
  ctx.waitUntil(
    Promise.all([
      cache.put(freshKey, json(body, 200, CFG.freshSeconds)),
      cache.put(lastGoodKey, json(body, 200, CFG.lastGoodSeconds)),
    ]).catch((err) => warn('cache write failed', err)),
  );
  return json(body, 200, CFG.browserSeconds);
}

async function buildEvents(env) {
  const signal = AbortSignal.timeout(CFG.buildMs); // shared by every event-detail request
  const gaps = { past: false, api: false, page: new Set(), shop: new Set() };
  const details = (entries) => Promise.all(entries.map((entry) => eventDetail(entry, signal)));
  // Upcoming events load their details as soon as their list arrives. The past list and the
  // API extras are optional and get a shorter timeout of their own. Past details wait for
  // the upcoming list, so they never queue ahead of upcoming ones (Workers runs 6 fetches
  // at a time).
  const upcomingList = getList(`${ORG_URL}widget/product_list?lang=en&style=list`, signal); // pretix's own "upcoming, live, public" list
  const pastList = getList(`${ORG_URL}widget/product_list?lang=en&old=1&style=list`, AbortSignal.timeout(CFG.optionalMs))
    .catch((err) => {
      warn('past list skipped', err);
      gaps.past = true;
      return null;
    });
  const [upcoming, past, api] = await Promise.all([
    upcomingList.then((list) => details(listEntries(list, false).slice(0, CFG.maxUpcoming))),
    Promise.all([pastList, upcomingList.catch(() => null)])
      .then(([list]) => (list ? details(listEntries(list, true).slice(0, CFG.maxPast)) : [])),
    apiIndex(env, AbortSignal.timeout(CFG.optionalMs)).catch((err) => {
      warn('API extras skipped', err);
      gaps.api = true; // only reachable when PRETIX_TOKEN is set
      return null;
    }),
  ]);

  for (const d of [...upcoming, ...past]) {
    if (d.pageFailed) gaps.page.add(d.event.slug);
    if (d.shopFailed) gaps.shop.add(d.event.slug);
    applyExtras(d.event, api && api.get(d.event.slug));
  }
  const events = [...upcoming, ...past].map((d) => d.event);

  return {
    gaps,
    data: {
      generated_at: new Date().toISOString(),
      stale: false,
      organizer: { name: CFG.orgName, url: ORG_URL, ics_url: `${ORG_URL}events/ical/` },
      upcoming: events.filter((e) => !e.is_past).sort(byStart),
      past: events.filter((e) => e.is_past).sort(byStartDesc),
    },
  };
}

// Fill what failed from the last good build, field by field. The date, cover, description
// and the API extras (status, host, map position) rarely change, so an older copy of those
// is fine. Ticket and sales data are never copied: an event whose shop data failed shows
// "View on ticket site" rather than an outdated "on sale".
function fillGaps(data, gaps, saved) {
  if (!saved) return;
  const old = new Map([...(saved.upcoming || []), ...(saved.past || [])].map((e) => [e.slug, e]));
  for (const ev of [...data.upcoming, ...data.past]) {
    const prev = old.get(ev.slug);
    if (!prev) continue;
    if (gaps.page.has(ev.slug)) {
      if (!ev.start) {
        ev.start = prev.start || null;
        ev.end = prev.end || null;
      }
      if (!ev.cover) ev.cover = prev.cover || null;
    }
    if (gaps.shop.has(ev.slug) && !ev.description_html) ev.description_html = prev.description_html || '';
    if (gaps.api) {
      ev.status = prev.status || null;
      ev.host = prev.host || ev.host;
      ev.timezone = prev.timezone || ev.timezone;
      if (prev.geo) {
        ev.geo = prev.geo;
        ev.map_url = prev.map_url;
      }
    }
  }
  if (gaps.past && Array.isArray(saved.past)) {
    const listed = new Set(data.upcoming.map((e) => e.slug));
    // An event that was upcoming in the saved copy, has left the upcoming list and is over
    // has ended since then: keep it, as a past event.
    const endedSince = (saved.upcoming || [])
      .filter((e) => e && !listed.has(e.slug) && (Date.parse(e.end) || Date.parse(e.start)) < Date.now())
      .map((e) => ({ ...e, is_past: true, sales: 'past' }));
    data.past = [...endedSince, ...saved.past.filter((e) => e && !listed.has(e.slug))];
  }
  data.upcoming.sort(byStart);
  data.past.sort(byStartDesc);
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

async function eventDetail(entry, signal) {
  let pageFailed = false;
  let shopFailed = false;
  const [page, shop] = await Promise.all([
    getText(entry.tickets_url, signal).catch((err) => {
      warn(`event page ${entry.slug}`, err);
      pageFailed = true;
      return '';
    }),
    getJson(`${entry.tickets_url}widget/product_list?lang=en`, {}, signal).catch((err) => {
      warn(`shop data ${entry.slug}`, err);
      shopFailed = true;
      return null;
    }),
  ]);

  const ld = eventJsonLd(page); // pretix renders schema.org Event JSON-LD with exact UTC start/end
  const tickets = shop ? shopTickets(shop) : [];
  const available = tickets.filter((t) => t.available);
  const prices = (available.length ? available : tickets)
    .map((t) => Number(t.price))
    .filter(Number.isFinite);

  let sales;
  let salesNote = shop && shop.error ? text(shop.error) : null;
  let availability = entry.availability;
  if (entry.is_past) sales = 'past';
  else if (shop && shop.error) sales = 'closed'; // e.g. "The booking period for this event is over."
  else if (!tickets.length) sales = 'none';
  else if (available.length) sales = 'open';
  else if (tickets.some((t) => t.reserved)) sales = 'reserved'; // the rest sit in other buyers' carts
  else if (tickets.every((t) => t.not_on_sale)) { // outside every ticket's own sale window
    sales = 'closed';
    const soon = tickets.some((t) => t.not_on_sale === 'soon');
    salesNote = soon ? 'Tickets are not on sale yet.' : 'Ticket sales for this event are closed.';
    if (soon) availability = { reason: 'soon', text: '' };
  } else sales = 'sold_out';

  return {
    pageFailed,
    shopFailed,
    event: {
      slug: entry.slug,
      title: entry.title || text(shop && shop.name) || text(ld.name),
      start: text(ld.startDate) || null,
      end: text(ld.endDate) || null,
      timezone: CFG.timezone,
      date_range: entry.date_range || text(shop && shop.date_range),
      location: entry.location || null,
      geo: null,
      map_url: mapUrl(null, entry.location),
      host: CFG.orgName,
      status: null,
      // The event's "Social media image" in pretix (Settings -> Shop design) is the cover.
      cover: safeUrl(metaContent(page, 'og:image') || firstImage(ld.image), entry.tickets_url),
      description_html: shop ? String(shop.frontpage_text || '') : '', // pretix-sanitised Markdown output
      currency: text(shop && shop.currency) || 'USD',
      tickets,
      price_from: prices.length ? Math.min(...prices).toFixed(2) : null,
      price_to: prices.length ? Math.max(...prices).toFixed(2) : null,
      availability,
      sales,
      sales_note: salesNote,
      waiting_list: Boolean(shop && shop.waiting_list_enabled),
      tickets_url: entry.tickets_url,
      ics_url: `${entry.tickets_url}ical/`,
      is_past: entry.is_past,
    },
  };
}

// The optional API token's extras take precedence over what the public pages gave.
function applyExtras(ev, extra) {
  if (!extra) return;
  ev.start = text(extra.date_from) || ev.start;
  ev.end = text(extra.date_to) || ev.end;
  ev.timezone = text(extra.timezone) || ev.timezone;
  if (Number.isFinite(extra.geo_lat) && Number.isFinite(extra.geo_lon)) {
    ev.geo = { lat: extra.geo_lat, lon: extra.geo_lon };
    ev.map_url = mapUrl(ev.geo, ev.location);
  }
  ev.host = text(extra.host) || ev.host;
  const status = text(extra.status).toLowerCase();
  if (status === 'cancelled' || status === 'postponed') ev.status = status;
}

function shopTickets(shop) {
  const priceOf = (x) => (x && x.price && x.price.gross != null ? Number(x.price.gross) : NaN);
  const availOf = (x) => (Array.isArray(x && x.avail) ? x.avail : [null, null]);
  const out = [];
  for (const cat of shop.items_by_category || []) {
    for (const it of cat.items || []) {
      if (HIDDEN_REASONS.has(it.current_unavailability_reason)) continue;
      const units = it.has_variations && Array.isArray(it.variations)
        ? it.variations.filter((v) => !HIDDEN_REASONS.has(v.current_unavailability_reason))
        : [it];
      if (!units.length) continue;
      // Outside the ticket's own sale window: pretix says available_from or available_until.
      const windowOf = (u) => it.current_unavailability_reason || (u !== it && u.current_unavailability_reason) || null;
      const open = units.filter((u) => availOf(u)[0] === 100 && !windowOf(u)); // pretix AVAILABILITY_OK
      const held = units.filter((u) => availOf(u)[0] === 20 && !windowOf(u)); // AVAILABILITY_RESERVED: in other buyers' carts
      const pool = open.length ? open : held.length ? held : units; // price what can be bought, else what may come back
      const prices = pool.map(priceOf).filter(Number.isFinite);
      const left = open.map((u) => availOf(u)[1]).filter(Number.isFinite); // only set if "show quota left" is on
      const windows = units.map(windowOf);
      out.push({
        id: it.id,
        name: text(it.name),
        description_html: String(it.description || ''),
        price: prices.length ? Math.min(...prices).toFixed(2) : null,
        price_varies: new Set(prices).size > 1,
        free_price: Boolean(it.free_price),
        available: open.length > 0,
        reserved: !open.length && held.length > 0,
        not_on_sale: !open.length && !held.length && windows.every(Boolean)
          ? (windows.includes('available_from') ? 'soon' : 'ended')
          : null,
        left: left.length ? left.reduce((sum, n) => sum + n, 0) : null,
      });
    }
  }
  return out;
}

// Optional: only runs when the PRETIX_TOKEN secret exists. One request for all events.
async function apiIndex(env, signal) {
  if (!env.PRETIX_TOKEN) return null;
  const data = await getJson(
    `${CFG.pretix}/api/v1/organizers/${CFG.org}/events/?live=true&is_public=true&ordering=-date_from`,
    { Authorization: `Token ${env.PRETIX_TOKEN}` },
    signal,
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

async function fetchOk(url, headers = {}, signal = AbortSignal.timeout(CFG.buildMs)) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'bies-website-events/1', 'Accept-Language': 'en', ...headers },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}
const getJson = (url, headers, signal) =>
  fetchOk(url, { Accept: 'application/json', ...headers }, signal).then((r) => r.json());
const getText = (url, signal) => fetchOk(url, { Accept: 'text/html' }, signal).then((r) => r.text());

// style=list in the URL pins the layout: without it pretix answers in the organizer's
// "Default overview style", and its calendar and week layouts have no `events` array.
async function getList(url, signal) {
  const data = await getJson(url, {}, signal);
  if (!data || !Array.isArray(data.events)) throw new Error(`no event list in ${url}`);
  return data;
}

async function readJson(cache, key) {
  try {
    const r = await cache.match(key);
    return r ? await r.json() : null;
  } catch (_) {
    return null;
  }
}

function byStart(a, b) {
  return (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0);
}
function byStartDesc(a, b) {
  return byStart(b, a);
}

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

// A cached copy never tells browsers to keep it longer than the edge does (30 s for a partial build).
function withBrowserCache(response) {
  const r = new Response(response.body, response);
  const stored = /max-age=(\d+)/.exec(response.headers.get('Cache-Control') || '');
  const maxAge = Math.min(CFG.browserSeconds, stored ? Number(stored[1]) : CFG.browserSeconds);
  r.headers.set('Cache-Control', `public, max-age=${maxAge}`);
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
