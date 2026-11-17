// Anonymous, read-only calendar feed used by Satlantis's own public embed.
// Only fields needed by the public website leave this adapter. No credentials,
// emails, full guest lists, ticket records or payment data are copied.
const FEED = 'https://api.satlantis.io/calendar/1000236/events';
const FRESH_SECONDS = 120;
const LAST_GOOD_SECONDS = 86400;

function webUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function normalizeSatlantisEvents(input, now = Date.now()) {
  if (!Array.isArray(input)) throw new Error('Invalid Satlantis calendar response');
  return input.filter((event) => event && Number.isSafeInteger(event.id) && event.id > 0 && event.isUnlisted !== true)
    .map((event) => {
      const title = String(event.title || 'BIES event').slice(0, 300);
      const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
      const ticketsUrl = `https://www.satlantis.io/events/${event.id}/${slug}`;
      const start = Number.isFinite(Date.parse(event.start)) ? event.start : null;
      const end = Number.isFinite(Date.parse(event.end)) ? event.end : null;
      const isPast = (Date.parse(end) || (Date.parse(start) + 6 * 3600000)) <= now;
      let timezone = String(event.startTzId || 'America/El_Salvador');
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { timezone = 'America/El_Salvador'; }
      const location = event.isHidingLocation ? null : String(event.location || 'To be announced').slice(0, 500);
      const pending = !location || /^(to be announced|tba|venue to be announced)$/i.test(location);
      const showAttendees = event.isHidingAttendees === false;
      const samples = showAttendees && Array.isArray(event.sampleAttendees) ? event.sampleAttendees.slice(0, 6) : [];
      const attendees = samples.filter((account) => account && typeof account === 'object').map((account) => ({
        name: String(account.displayName || account.name || account.username || 'Member').slice(0, 100),
        picture: webUrl(account.picture),
      }));
      const count = showAttendees && Number.isSafeInteger(event.attendeeCount) && event.attendeeCount >= 0
        ? event.attendeeCount : null;
      return {
        slug: event.id === 1003085 ? 'bies-christmas-party' : `satlantis-${event.id}`,
        provider: 'satlantis', provider_id: String(event.id), title, start, end, timezone,
        location, location_pending: pending, map_url: null, is_online: Boolean(event.isOnline),
        host: String(event.account?.displayName || event.account?.name || 'Build in El Salvador').slice(0, 150),
        status: null, cover: webUrl(event.image), category: String(event.type?.name || '').slice(0, 60),
        description_html: String(event.summary || '').split(/\n\s*\n/)
          .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join(''),
        attendees, attendee_count: count, currency: 'USD', tickets: [], price_from: null, price_to: null,
        availability: null, sales: isPast ? 'past' : 'external', waiting_list: false,
        tickets_url: ticketsUrl, ics_url: null, is_past: isPast,
      };
    });
}

function refreshDates(events) {
  return events.map((event) => {
    const ended = (Date.parse(event.end) || (Date.parse(event.start) + 6 * 3600000)) <= Date.now();
    return { ...event, is_past: ended, sales: ended ? 'past' : 'external' };
  });
}

export async function satlantisEvents(request, ctx) {
  const origin = new URL(request.url).origin;
  const key = new Request(`${origin}/api/events?satlantis-calendar=1000236`);
  const savedKey = new Request(`${origin}/api/events?satlantis-calendar=1000236&last-good=1`);
  const cache = caches.default;
  const cached = await cache.match(key);
  if (cached) return { events: refreshDates((await cached.json()).events), stale: false };
  try {
    const response = await fetch(FEED, {
      headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Satlantis HTTP ${response.status}`);
    const events = normalizeSatlantisEvents(await response.json());
    const body = JSON.stringify({ events });
    const store = (value, seconds) => new Response(value, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${seconds}` },
    });
    ctx.waitUntil(Promise.all([
      cache.put(key, store(body, FRESH_SECONDS)),
      // Last-good metadata remains useful during an outage; attendee previews
      // are omitted because their visibility may have changed in the meantime.
      cache.put(savedKey, store(JSON.stringify({ events: events.map((event) => ({
        ...event, attendees: [], attendee_count: null,
      })) }), LAST_GOOD_SECONDS)),
    ]).catch((error) => console.warn('satlantis: cache write failed', String(error))));
    return { events, stale: false };
  } catch (error) {
    console.warn('satlantis: public calendar unavailable', String(error));
    const saved = await cache.match(savedKey);
    return saved ? { events: refreshDates((await saved.json()).events), stale: true } : { events: null, stale: true };
  }
}
