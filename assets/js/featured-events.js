// Temporary, manually maintained listings while Satlantis embeds/API access are pending.
// Mike confirmed the Christmas Party date. Prices and availability stay on Satlantis.
const featuredEvents = [{
  slug: 'bies-christmas-party',
  provider: 'satlantis',
  title: 'BIES Christmas Party',
  start: '2026-12-16T18:00:00-06:00',
  end: '2026-12-16T23:00:00-06:00',
  timezone: 'America/El_Salvador',
  location: 'Venue to be announced',
  location_pending: true,
  map_url: null,
  host: 'Build in El Salvador',
  status: null,
  cover: null,
  cover_title: 'Christmas Party',
  summary: 'Celebrating connections & community. Join us for a relaxed evening with builders, founders and friends as we close out the year together.',
  description_html: '<p>Let’s get together one last time before 2027!</p>'
    + '<p>After a year of meaningful connections, we’re bringing the BIES community together for a Christmas celebration. Reconnect with familiar faces, meet new people and celebrate everything we’ve built together.</p>'
    + '<p>Food and drinks are included with your ticket. The venue and more event details will be announced soon.</p>'
    + '<p>Visit our Satlantis event page for ticket options and the latest updates.</p>',
  currency: 'USD',
  tickets: [],
  price_from: null,
  price_to: null,
  availability: null,
  sales: 'external',
  waiting_list: false,
  tickets_url: 'https://www.satlantis.io/events/1003085/bies-christmas-party',
  ics_url: null,
}];

// Shared with the Worker for event share pages. Prefer the local listing if a
// provider later returns it, and move it to Past after its confirmed end time.
export function withFeaturedEvents(data = {}, now = Date.now()) {
  const featuredSlugs = new Set(featuredEvents.map((ev) => ev.slug.toLowerCase()));
  const legacy = [...(data.upcoming || []), ...(data.past || [])]
    .filter((ev) => !featuredSlugs.has(String(ev.slug).toLowerCase()));
  const featured = featuredEvents.map((ev) => {
    const is_past = Date.parse(ev.end) <= now;
    return { ...ev, tickets: [], is_past, sales: is_past ? 'past' : ev.sales };
  });
  const events = [...featured, ...legacy];
  return {
    ...data,
    upcoming: events.filter((ev) => !ev.is_past).sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0)),
    past: events.filter((ev) => ev.is_past).sort((a, b) => (Date.parse(b.start) || 0) - (Date.parse(a.start) || 0)),
  };
}
