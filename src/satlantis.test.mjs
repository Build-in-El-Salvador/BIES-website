import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSatlantisEvents, satlantisEvents } from './satlantis.js';
import { withFeaturedEvents } from '../assets/js/featured-events.js';

const sample = {
  id: 1003085, title: 'BIES Christmas Mixer 2026', start: '2026-12-17T00:00:00Z', end: '2026-12-17T05:00:00Z',
  startTzId: 'America/El_Salvador', isUnlisted: false, isHidingAttendees: false, isHidingLocation: false,
  location: 'To be announced', summary: '<script>unsafe()</script>\n\nPublic description',
  account: { displayName: 'BIES', email: 'organizer@example.com', isAdmin: true },
  image: 'https://cdn.satlantis.io/example.png', type: { name: 'Party' }, attendeeCount: 10,
  sampleAttendees: [{ displayName: 'Member One', email: 'member@example.com', picture: 'javascript:unsafe()', isAdmin: true }],
  calendarEventRsvps: [{ account: { email: 'private@example.com' } }],
};

test('public card projection omits emails and guest records, escapes copy, and rejects unsafe image URLs', () => {
  const [event] = normalizeSatlantisEvents([sample], Date.parse('2026-11-17T00:00:00Z'));
  assert.equal(event.slug, 'bies-christmas-party');
  assert.equal(event.location_pending, true);
  assert.equal(event.map_url, null);
  assert.equal(event.attendee_count, 10);
  assert.deepEqual(event.attendees, [{ name: 'Member One', picture: null }]);
  assert.equal(JSON.stringify(event).includes('example.com'), false);
  assert.equal('calendarEventRsvps' in event, false);
  assert.match(event.description_html, /&lt;script&gt;/);
  assert.equal(event.description_html.includes('<script>'), false);
  assert.equal(event.tickets_url, 'https://www.satlantis.io/events/1003085/bies-christmas-mixer-2026');
});

test('visibility settings omit unlisted events and hide attendee/location details', () => {
  assert.deepEqual(normalizeSatlantisEvents([{ ...sample, isUnlisted: true }]), []);
  const [hidden] = normalizeSatlantisEvents([{ ...sample, isHidingAttendees: true, isHidingLocation: true }]);
  assert.deepEqual(hidden.attendees, []);
  assert.equal(hidden.attendee_count, null);
  assert.equal(hidden.location, null);
  assert.deepEqual(normalizeSatlantisEvents([{ ...sample, isHidingAttendees: undefined }])[0].attendees, []);
});

test('an authoritative empty calendar does not resurrect the manual event', () => {
  assert.deepEqual(withFeaturedEvents({ satlantis_synced: true, upcoming: [], past: [] }).upcoming, []);
  assert.throws(() => normalizeSatlantisEvents({ error: 'not an event list' }));
});

test('calendar reads are anonymous, cached, and fall back to saved metadata without attendee previews', async () => {
  const originalFetch = globalThis.fetch, originalCaches = globalThis.caches;
  const memory = new Map(), tasks = [];
  globalThis.caches = { default: {
    match: async (key) => memory.get(key.url)?.clone(),
    put: async (key, value) => { memory.set(key.url, value.clone()); },
  } };
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.satlantis.io/calendar/1000236/events');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, undefined);
    return Response.json([sample]);
  };
  const request = new Request('https://buildinelsalvador.com/api/events');
  const ctx = { waitUntil: (promise) => tasks.push(promise) };
  try {
    const fresh = await satlantisEvents(request, ctx); await Promise.all(tasks);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.events[0].attendee_count, 10);
    await satlantisEvents(request, ctx);
    assert.equal(requests, 1);
    memory.delete('https://buildinelsalvador.com/api/events?satlantis-calendar=1000236');
    globalThis.fetch = async () => { throw new Error('Expected upstream outage'); };
    const saved = await satlantisEvents(request, ctx);
    assert.equal(saved.stale, true);
    assert.equal(saved.events[0].title, sample.title);
    assert.deepEqual(saved.events[0].attendees, []);
    assert.equal(saved.events[0].attendee_count, null);
  } finally {
    globalThis.fetch = originalFetch; globalThis.caches = originalCaches;
  }
});

test('cached events move to Past when their end passes', async () => {
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => Response.json({ events: [{
    ...normalizeSatlantisEvents([sample])[0], end: '2020-01-01T00:00:00Z', is_past: false, sales: 'external',
  }] }) } };
  try {
    const data = await satlantisEvents(new Request('https://buildinelsalvador.com/api/events'), {});
    assert.equal(data.events[0].is_past, true);
    assert.equal(data.events[0].sales, 'past');
  } finally { globalThis.caches = originalCaches; }
});
