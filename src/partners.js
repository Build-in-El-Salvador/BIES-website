/**
 * Partners and Collaborators: the logo strip on the About and Ecosystem (membership.html)
 * pages, edited on /admin/partners/.
 *
 *   GET  /api/partners              public list those pages draw (only partners that
 *                                   are switched on and have a logo), cached for a minute
 *   GET  /partner-logos/<id>.<ext>  a logo uploaded on the admin page
 *   GET  /api/admin/partners        the full list, hidden partners included   (signed in)
 *   PUT  /api/admin/partners        { partners: [...] } replaces the list     (signed in)
 *   POST /api/admin/logos           raw PNG or WebP bytes -> { logo }         (signed in)
 *
 * KV (binding SITE): the list under "partners:list", each uploaded logo under "logo:<id>".
 * Until an admin saves for the first time, the list is src/partners-seed.json, which is
 * what about.html and membership.html show as static HTML.
 */
import SEED from './partners-seed.json' with { type: 'json' };
import { PUBLIC_HOSTS, json, readJson, isWebUrl, storeUpload, keepUploads, serveUpload } from './admin-lib.js';

const LIST_KEY = 'partners:list';
const PUBLIC_SECONDS = 60;
const MAX_PARTNERS = 100;
const STATIC_LOGO_RE = /^\/assets\/images\/partners\/[a-z0-9-]{1,80}\.(webp|png|jpg|svg)$/;
const UPLOADED_LOGO_RE = /^\/partner-logos\/([0-9a-f-]{36})\.(webp|png)$/;
const ID_RE = /^[a-z0-9-]{1,64}$/;

export async function publicPartners(request, env, ctx) {
  const url = new URL(request.url);
  const cacheable = PUBLIC_HOSTS.includes(url.hostname);
  const cacheKey = new Request(`${url.origin}/api/partners`);
  if (cacheable) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  }
  const partners = (await readList(env))
    .filter((p) => p.visible && p.logo)
    .map(({ name, url: link, logo, size }) => ({ name, url: link, logo, size }));
  const res = json({ partners }, 200, PUBLIC_SECONDS);
  if (cacheable) ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
}

export function partnerLogo(pathname, env) {
  const m = UPLOADED_LOGO_RE.exec(pathname);
  return m ? serveUpload(env, `logo:${m[1]}`, m[2]) : new Response('', { status: 404 });
}

export async function adminPartners(env) {
  return json({ partners: await readList(env) });
}

export async function savePartners(request, env, ctx) {
  const body = await readJson(request, 256 * 1024);
  if (!body || !Array.isArray(body.partners)) return json({ error: 'bad_request', detail: 'partners must be a list' }, 400);
  if (body.partners.length > MAX_PARTNERS) return json({ error: 'bad_request', detail: `at most ${MAX_PARTNERS} partners` }, 400);

  const seen = new Set();
  const clean = [];
  for (const [i, raw] of body.partners.entries()) {
    const problem = (detail) => json({ error: 'bad_request', detail: `partner ${i + 1}: ${detail}` }, 400);
    if (!raw || typeof raw !== 'object') return problem('not an object');
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!ID_RE.test(id) || seen.has(id)) return problem('missing or repeated id');
    seen.add(id);
    const name = typeof raw.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 80) return problem('the name must be 1 to 80 characters');
    const link = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (link && !isWebUrl(link)) return problem('the website must start with https:// or http://');
    const logo = typeof raw.logo === 'string' ? raw.logo : '';
    if (logo && !STATIC_LOGO_RE.test(logo) && !UPLOADED_LOGO_RE.test(logo)) return problem('unknown logo');
    const size = Number(raw.size);
    if (!Number.isFinite(size) || size < 0.4 || size > 1.6) return problem('the logo size must be between 40% and 160%');
    clean.push({ id, name, url: link, logo, size: Math.round(size * 100) / 100, visible: raw.visible === true });
  }

  // Logos uploaded since the last save must still exist (unsaved uploads expire after a
  // day); saving keeps them for good. Logos the list no longer uses are deleted.
  const before = await readList(env);
  const used = (list) => list.map((p) => UPLOADED_LOGO_RE.exec(p.logo)).filter(Boolean).map((m) => `logo:${m[1]}`);
  const old = new Set(used(before));
  const fresh = used(clean).filter((k) => !old.has(k));
  if (!await keepUploads(env, fresh)) return json({ error: 'bad_request', detail: 'a logo upload was not found, upload it again' }, 400);
  await env.SITE.put(LIST_KEY, JSON.stringify(clean));
  const now = new Set(used(clean));
  ctx.waitUntil(Promise.all([...old].filter((k) => !now.has(k)).map((k) => env.SITE.delete(k))));
  ctx.waitUntil(purgePublic(request));
  return json({ partners: clean });
}

export async function uploadPartnerLogo(request, env) {
  const r = await storeUpload(request, env, { prefix: 'logo:', types: ['image/png', 'image/webp'], maxBytes: 400 * 1024 });
  return r.error || json({ logo: `/partner-logos/${r.id}.${r.ext}` });
}

async function readList(env) {
  const stored = env.SITE ? await env.SITE.get(LIST_KEY, { type: 'json' }) : null;
  return Array.isArray(stored) ? stored : SEED;
}

// The public list is cached per data centre for a minute. This clears the copy where the
// admin saved; elsewhere the new list shows up when the minute runs out.
async function purgePublic(request) {
  const { hostname } = new URL(request.url);
  if (!PUBLIC_HOSTS.includes(hostname)) return;
  await Promise.all(PUBLIC_HOSTS.map((h) => caches.default.delete(new Request(`https://${h}/api/partners`))));
}
