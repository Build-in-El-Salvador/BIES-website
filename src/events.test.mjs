import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from './worker.js';

const origin = 'https://buildinelsalvador.com';
const feedUrl = 'https://api.satlantis.io/calendar/1000236/events';
const publicEvent = {
  id: 1003085, title: 'BIES Christmas Mixer 2026',
  start: '2026-12-17T00:00:00Z', end: '2026-12-17T05:00:00Z',
  startTzId: 'America/El_Salvador', location: 'To be announced',
  isUnlisted: false, isHidingAttendees: false, isHidingLocation: false,
  image: 'https://cdn.satlantis.io/event.png', attendeeCount: 1,
  sampleAttendees: [{ name: 'Public member', email: 'private@example.com', picture: 'https://example.org/avatar.png' }],
};
const legacy = {
  generated_at: '2026-11-17T00:00:00Z', upcoming: [], stale: false,
  past: [{ slug: 'SN260926', title: 'Launch Party', start: '2026-09-26T23:00:00Z', is_past: true }],
};
const html = await readFile(new URL('../events.html', import.meta.url), 'utf8');

async function usingFeed(feed, run) {
  const oldFetch = globalThis.fetch, oldCaches = globalThis.caches;
  const memory = new Map([[`${origin}/api/events`, Response.json(legacy)]]);
  const requests = [], tasks = [];
  globalThis.caches = { default: {
    match: async (key) => memory.get(key.url)?.clone(),
    put: async (key, response) => { memory.set(key.url, response.clone()); },
  } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    assert.equal(url, feedUrl, 'Only the fixed public calendar is fetched');
    if (feed instanceof Error) throw feed;
    if (feed instanceof Response) return feed.clone();
    return Response.json(feed);
  };
  const env = { ASSETS: { fetch: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) } };
  const ctx = { waitUntil: (promise) => tasks.push(promise) };
  try { await run({ env, ctx, requests }); }
  finally {
    await Promise.allSettled(tasks);
    globalThis.fetch = oldFetch; globalThis.caches = oldCaches;
  }
}

test('combined public endpoint preserves history and never forwards visitor credentials or private account fields', async () => {
  await usingFeed([publicEvent], async ({ env, ctx, requests }) => {
    const response = await worker.fetch(new Request(`${origin}/api/events`, {
      headers: { Authorization: 'Bearer visitor-secret', Cookie: 'session=visitor-secret' },
    }), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    const data = await response.json();
    assert.equal(data.satlantis_synced, true);
    assert.equal(data.upcoming[0].slug, 'bies-christmas-party');
    assert.deepEqual(data.past, legacy.past);
    assert.equal(JSON.stringify(data).includes('private@example.com'), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.credentials, 'omit');
    assert.deepEqual(requests[0].options.headers, { Accept: 'application/json' });
    assert.equal(requests[0].options.redirect, 'manual');
  });
});

test('unsupported hosts and methods never fetch the public calendar', async () => {
  await usingFeed([publicEvent], async ({ env, ctx, requests }) => {
    const post = await worker.fetch(new Request(`${origin}/api/events`, { method: 'POST' }), env, ctx);
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('Allow'), 'GET, HEAD');
    const otherHost = await worker.fetch(new Request('https://unrecognized.example/api/events'), env, ctx);
    assert.equal(otherHost.status, 404);
    assert.equal(requests.length, 0);
  });
});

test('an empty or entirely unlisted calendar is authoritative while legacy history remains available', async () => {
  for (const feed of [[], [{ ...publicEvent, isUnlisted: true }]]) {
    await usingFeed(feed, async ({ env, ctx }) => {
      const data = await (await worker.fetch(new Request(`${origin}/api/events`), env, ctx)).json();
      assert.equal(data.satlantis_synced, true);
      assert.deepEqual(data.upcoming, []);
      assert.deepEqual(data.past, legacy.past);
      const removed = await worker.fetch(new Request(`${origin}/events/bies-christmas-party`), env, ctx);
      assert.equal(removed.status, 302);
      assert.equal(removed.headers.get('Location'), `${origin}/events`);
    });
  }
});

test('malformed calendar responses and upstream outages retain a clearly marked fallback and legacy history', async () => {
  for (const feed of [{ error: 'bad payload' }, new Error('Expected upstream failure')]) {
    await usingFeed(feed, async ({ env, ctx }) => {
      const response = await worker.fetch(new Request(`${origin}/api/events`), env, ctx);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.upcoming_stale, true);
      assert.equal(data.upcoming[0].provider_id, '1003085');
      assert.deepEqual(data.past, legacy.past);
      assert.equal(data.upcoming[0].attendees, undefined);
    });
  }
});

test('calendar redirects are rejected using Cloudflare-supported manual mode', async () => {
  const redirect = new Response(null, { status: 302, headers: { Location: 'https://unrecognized.example/events' } });
  await usingFeed(redirect, async ({ env, ctx, requests }) => {
    const data = await (await worker.fetch(new Request(`${origin}/api/events`), env, ctx)).json();
    assert.equal(data.upcoming_stale, true);
    assert.equal(data.upcoming[0].provider_id, '1003085');
    assert.equal(requests.length, 1, 'Redirect destination is never fetched');
    assert.equal(requests[0].options.redirect, 'manual');
  });
});

test('event share metadata escapes hostile titles and rejects unsafe cover URLs', async () => {
  await usingFeed([{
    ...publicEvent,
    title: '</title><script data-qa-attack>globalThis.bad=true</script>',
    image: 'javascript:globalThis.bad=true',
    summary: '</script><script data-qa-attack>globalThis.bad=true</script>',
  }], async ({ env, ctx }) => {
    const response = await worker.fetch(new Request(`${origin}/events/bies-christmas-party`), env, ctx);
    const page = await response.text();
    assert.equal(response.status, 200);
    assert(page.includes('&lt;/title&gt;&lt;script data-qa-attack&gt;'));
    assert.equal(page.includes('<script data-qa-attack>'), false);
    assert.equal(page.includes('content="javascript:'), false);
    const oldLink = await worker.fetch(new Request(`${origin}/events/sn260926`), env, ctx);
    assert.equal(oldLink.status, 200);
    assert((await oldLink.text()).includes('<title>Launch Party | Build in El Salvador</title>'));
    const head = await worker.fetch(new Request(`${origin}/events/sn260926`, { method: 'HEAD' }), env, ctx);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
});
