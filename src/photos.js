/**
 * Photos on the website's pages, edited on /admin/.
 *
 * Each editable spot is marked in the HTML with data-photos="<id>": on the <div> of a photo
 * strip, or on a single <img>. The HTML stays the original. When an admin saves, the new
 * photos are stored in KV (binding SITE) under "photos:sections" as { <id>: [photo, ...] },
 * and this Worker writes them into the page before it is sent (pageWithPhotos), so visitors
 * and search engines get the new photos in the HTML with no flash of the old ones. Saved
 * testimonials (src/testimonials.js) are written in at the same time.
 * wrangler.jsonc lists the pages in assets.run_worker_first so they pass through here.
 *
 *   GET  /site-photos/<id>.<ext>     an uploaded photo
 *   GET  /api/admin/photos           every spot: its original photos and the current ones
 *   PUT  /api/admin/photos           { sections: { <id>: [photo, ...] | null } } (null = original)
 *   POST /api/admin/photos/upload    raw WebP or JPEG bytes -> { src }
 *
 * A photo is { src, alt, pos }: pos is the CSS object-position ("40% 50%") that decides
 * which part stays in view when the frame crops the photo. A photo cropped on /admin/ also
 * has { orig, crop }: src is then the cropped copy the admin page made and uploaded, orig the
 * photo it was cut from, and crop [x, y, w, h] the part of orig kept, as fractions of its
 * width and height. Pages only use src and pos; orig and crop let the crop be changed later.
 */
import { json, readJson, storeUpload, keepUploads, serveUpload } from './admin-lib.js';
import { rewriteTestimonials, savedTestimonials } from './testimonials.js';

const KEY = 'photos:sections';
const UPLOAD_RE = /^\/site-photos\/([0-9a-f-]{36})\.(webp|jpg)$/;
const STATIC_RE = /^\/?assets\/images\/[a-z0-9_/-]{1,120}\.(webp|jpg|jpeg|png)(\?v=\d{1,4})?$/;
const POS_RE = /^(\d{1,3})% (\d{1,3})%$/;
const PAGE_CACHE_SECONDS = 60; // how long an edge keeps the saved photos before reading KV again

// Every editable spot, in page order. shape is the frame the admin preview draws (a CSS
// aspect ratio, or "natural" for a photo shown whole); phoneShape where phones differ.
export const SECTIONS = [
  { id: 'home-strip', page: 'Home', path: '/', title: 'Top photo strip', kind: 'strip', min: 3, max: 5, shape: '3/4',
    hint: 'Tall frames under the headline, side by side. On phones they show two to a row.' },
  { id: 'home-meet', page: 'Home', path: '/', title: 'Meet the Right People', kind: 'single', shape: 'natural',
    hint: 'Shown whole, beside the text, on the blue band.' },
  { id: 'home-events', page: 'Home', path: '/', title: 'Events', kind: 'single', shape: '4/3' },
  { id: 'home-media', page: 'Home', path: '/', title: 'Media', kind: 'single', shape: '4/3' },
  { id: 'home-digital', page: 'Home', path: '/', title: 'Digital Community', kind: 'single', shape: '4/3' },
  { id: 'home-about', page: 'Home', path: '/', title: 'About Build in El Salvador', kind: 'single', shape: 'natural',
    hint: 'Shown whole, beside the text.' },
  { id: 'about-strip', page: 'About', path: '/about', title: 'Top photo strip', kind: 'strip', min: 3, max: 5, shape: '3/4',
    hint: 'Tall frames under the headline. On phones the last photo of an odd number shows wide, across the page.' },
  { id: 'about-quote', page: 'About', path: '/about', title: 'Quote banner (Jess Allen)', kind: 'single', shape: '5/2', phoneShape: '9/10', defaultPos: '50% 26%',
    hint: 'A wide banner with the quote in white over the bottom left, so keep faces away from that corner.' },
  { id: 'about-contribute', page: 'About', path: '/about', title: 'How We Contribute', kind: 'single', shape: 'natural',
    hint: 'Shown whole, beside the text.' },
  { id: 'member-newsletter', page: 'Membership', path: '/membership', title: 'BIES Newsletter', kind: 'single', shape: '16/9' },
  { id: 'member-youtube', page: 'Membership', path: '/membership', title: 'YouTube Broadcast', kind: 'single', shape: '16/9' },
  { id: 'member-roundtable', page: 'Membership', path: '/membership', title: 'Workshops, Roundtables & Retreats', kind: 'single', shape: '16/9' },
  { id: 'member-chat', page: 'Membership', path: '/membership', title: 'Member Chat', kind: 'single', shape: '16/9' },
  { id: 'member-app', page: 'Membership', path: '/membership', title: 'BIES Digital App', kind: 'single', shape: '16/9' },
  { id: 'member-forum', page: 'Membership', path: '/membership', title: 'BIES Public Forum', kind: 'single', shape: '16/9' },
  { id: 'cta', page: 'Every page', path: '/', title: 'Join Our Ecosystem background', kind: 'single', shape: '2/1', phoneShape: '3/4',
    hint: 'Behind the sign-up cards at the bottom of every page, under a dark blue tint.' },
];
const BY_ID = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));

// The pages wrangler.jsonc sends through this Worker (assets.run_worker_first).
export const PHOTO_PAGES = new Set(['/', '/about', '/membership', '/faq', '/events', '/stories']);

// ---------- pages ----------

export async function pageWithPhotos(request, env) {
  if (request.method !== 'GET' || !env.SITE) return env.ASSETS.fetch(request);
  try {
    const [saved, quotes] = await Promise.all([savedPhotos(env, PAGE_CACHE_SECONDS), savedTestimonials(env, PAGE_CACHE_SECONDS)]);
    if (!Object.keys(saved).length && !quotes) return env.ASSETS.fetch(request);
    // Ask for the whole page: a browser revalidating a copy from before the save would
    // otherwise get "304 Not Modified" and keep showing the old photos.
    const headers = new Headers(request.headers);
    headers.delete('If-None-Match');
    headers.delete('If-Modified-Since');
    const res = await env.ASSETS.fetch(new Request(request.url, { method: 'GET', headers }));
    if (!res.ok || !(res.headers.get('Content-Type') || '').includes('text/html')) return res;
    const out = new Headers(res.headers);
    out.delete('ETag');
    out.delete('Content-Length');
    out.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return new Response(rewriteTestimonials(rewritePage(await res.text(), saved), quotes), { status: res.status, headers: out });
  } catch (err) {
    console.error('photos: page:', err && err.stack ? err.stack : String(err));
    return env.ASSETS.fetch(request);
  }
}

// For pages the Worker builds itself (the Events share pages).
export async function withPhotos(html, env) {
  if (!env.SITE) return html;
  try {
    const [saved, quotes] = await Promise.all([savedPhotos(env, PAGE_CACHE_SECONDS), savedTestimonials(env, PAGE_CACHE_SECONDS)]);
    return rewriteTestimonials(rewritePage(html, saved), quotes);
  } catch (err) {
    console.error('photos: share page:', err && err.message ? err.message : String(err));
    return html;
  }
}

const STRIP_RE = /<div\b([^>]*\bdata-photos="([a-z0-9-]+)"[^>]*)>([\s\S]*?)<\/div>/g;
const IMG_RE = /<img\b[^>]*>/g;

// Writes saved photos into a page's HTML. Spots with nothing saved are left as they are.
export function rewritePage(html, saved) {
  if (!saved || !Object.keys(saved).length) return html;
  let out = html.replace(STRIP_RE, (whole, attrStr, id, inner) => {
    const photos = saved[id];
    if (!photos || !BY_ID[id] || BY_ID[id].kind !== 'strip') return whole;
    const first = (inner.match(IMG_RE) || [''])[0];
    const priority = /\bfetchpriority="high"/.test(first);
    const cls = attrStr.replace(/\bcols-\d\b/, `cols-${photos.length}`);
    const imgs = photos.map((p, i) => `<img src="${esc(p.src)}" alt="${esc(p.alt)}"${i === 0 && priority ? ' fetchpriority="high"' : ''}${posStyle(p.pos, BY_ID[id])}>`);
    return `<div${cls}>\n    ${imgs.join('\n    ')}\n  </div>`;
  });
  out = out.replace(IMG_RE, (tag) => {
    const m = /\bdata-photos="([a-z0-9-]+)"/.exec(tag);
    const photo = m && saved[m[1]] && saved[m[1]][0];
    return photo && BY_ID[m[1]] ? setImg(tag, photo, BY_ID[m[1]]) : tag;
  });
  return out;
}

// The original photos of every spot found in one page's HTML: { <id>: [photo, ...] }.
export function readPage(html) {
  const found = {};
  for (const m of html.matchAll(STRIP_RE)) {
    found[m[2]] = (m[3].match(IMG_RE) || []).map((tag) => photoFromTag(tag, BY_ID[m[2]]));
  }
  for (const tag of html.match(IMG_RE) || []) {
    const m = /\bdata-photos="([a-z0-9-]+)"/.exec(tag);
    if (m && !found[m[1]]) found[m[1]] = [photoFromTag(tag, BY_ID[m[1]])];
  }
  return found;
}

function photoFromTag(tag, section) {
  const a = Object.fromEntries(attrs(tag));
  const pos = /object-position:\s*([^;]+)/.exec(a.style || '');
  return { src: a.src || '', alt: decode(a.alt || ''), pos: pos ? pos[1].trim() : defaultPos(section) };
}

function setImg(tag, photo, section) {
  const list = attrs(tag).map(([k, v]) => {
    if (k === 'src') return [k, photo.src];
    if (k === 'alt') return [k, photo.alt];
    if (k === 'style') return [k, (v || '').split(';').map((d) => d.trim()).filter((d) => d && !d.startsWith('object-position')).join(';')];
    return [k, v];
  });
  const style = list.find(([k]) => k === 'style');
  const pos = photo.pos && photo.pos !== defaultPos(section) ? `object-position:${photo.pos}` : '';
  if (style) style[1] = [style[1], pos].filter(Boolean).join(';');
  else if (pos) list.push(['style', pos]);
  const html = list.filter(([k, v]) => k !== 'style' || v).map(([k, v]) => (v === null ? k : `${k}="${esc(v)}"`)).join(' ');
  return `<img ${html}>`;
}

function posStyle(pos, section) {
  return pos && pos !== defaultPos(section) ? ` style="object-position:${esc(pos)}"` : '';
}

function defaultPos(section) {
  return (section && section.defaultPos) || '50% 50%';
}

// Attributes of one tag, in order, as [name, value] (value null for a bare attribute).
function attrs(tag) {
  const out = [];
  for (const m of tag.replace(/^<img\b/, '').replace(/\/?>$/, '').matchAll(/([a-zA-Z][\w:-]*)(?:="([^"]*)")?/g)) {
    out.push([m[1], m[2] === undefined ? null : decode(m[2])]);
  }
  return out;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return NAMED[e.toLowerCase()] ?? whole;
  });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- admin ----------

export async function adminPhotos(request, env) {
  return json({ sections: await describe(request, env) });
}

export async function savePhotos(request, env) {
  const body = await readJson(request, 256 * 1024);
  const input = body && body.sections;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'bad_request', detail: 'sections must be an object' }, 400);

  const clean = {};
  for (const [id, photos] of Object.entries(input)) {
    const s = BY_ID[id];
    if (!s) return json({ error: 'bad_request', detail: `unknown section ${id}` }, 400);
    if (photos === null) continue; // back to the original
    const problem = (detail) => json({ error: 'bad_request', detail: `${s.page}, ${s.title}: ${detail}` }, 400);
    const min = s.kind === 'strip' ? s.min : 1;
    const max = s.kind === 'strip' ? s.max : 1;
    if (!Array.isArray(photos) || photos.length < min || photos.length > max) {
      return problem(min === max ? 'needs exactly one photo' : `needs ${min} to ${max} photos`);
    }
    const list = [];
    for (const p of photos) {
      if (!p || typeof p !== 'object') return problem('a photo is missing');
      const src = typeof p.src === 'string' ? p.src : '';
      if (!STATIC_RE.test(src) && !UPLOAD_RE.test(src)) return problem('unknown photo');
      const alt = typeof p.alt === 'string' ? p.alt.trim().replace(/\s+/g, ' ') : '';
      if (!alt || alt.length > 250) return problem('every photo needs a description of up to 250 characters');
      const pm = POS_RE.exec(typeof p.pos === 'string' ? p.pos : '');
      if (!pm || Number(pm[1]) > 100 || Number(pm[2]) > 100) return problem('bad focus point');
      const photo = { src, alt, pos: `${Number(pm[1])}% ${Number(pm[2])}%` };
      if (p.crop !== undefined && p.crop !== null) {
        const crop = cleanCrop(p.crop);
        if (!crop) return problem('bad crop');
        const orig = typeof p.orig === 'string' ? p.orig : '';
        if (!STATIC_RE.test(orig) && !UPLOAD_RE.test(orig)) return problem('unknown original photo');
        if (!UPLOAD_RE.test(src)) return problem('a cropped photo must be uploaded');
        Object.assign(photo, { orig, crop });
      }
      list.push(photo);
    }
    clean[id] = list;
  }

  // Photos uploaded since the last save must still exist (unsaved uploads expire after a
  // day); saving keeps them for good. Uploads no longer used anywhere are deleted.
  const before = await savedPhotos(env, 0);
  const used = (map) => Object.values(map).flat().flatMap((p) => [p.src, p.orig]).map((src) => UPLOAD_RE.exec(src || '')).filter(Boolean).map((m) => `photo:${m[1]}`);
  const old = new Set(used(before));
  const fresh = [...new Set(used(clean))].filter((k) => !old.has(k));
  if (!await keepUploads(env, fresh)) return json({ error: 'bad_request', detail: 'a photo upload was not found, upload it again' }, 400);
  await env.SITE.put(KEY, JSON.stringify(clean));
  memo = { at: 0, value: null };
  const now = new Set(used(clean));
  await Promise.all([...old].filter((k) => !now.has(k)).map((k) => env.SITE.delete(k)));
  return json({ sections: await describe(request, env, clean) });
}

// [x, y, w, h], each a fraction of the original photo, inside it and not vanishingly small.
function cleanCrop(c) {
  if (!Array.isArray(c) || c.length !== 4 || !c.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  const [x, y, w, h] = c.map((v) => Math.round(v * 10000) / 10000);
  if (w < 0.02 || h < 0.02 || x + w > 1.0001 || y + h > 1.0001) return null;
  return [x, y, w, h];
}

export async function uploadPhoto(request, env) {
  const r = await storeUpload(request, env, { prefix: 'photo:', types: ['image/webp', 'image/jpeg'], maxBytes: 1536 * 1024 });
  return r.error || json({ src: `/site-photos/${r.id}.${r.ext}` });
}

export function sitePhoto(pathname, env) {
  const m = UPLOAD_RE.exec(pathname);
  return m ? serveUpload(env, `photo:${m[1]}`, m[2]) : new Response('', { status: 404 });
}

async function describe(request, env, saved) {
  const current = saved || await savedPhotos(env, 0);
  const paths = [...new Set(SECTIONS.map((s) => s.path))];
  const pages = await Promise.all(paths.map(async (p) => {
    const res = await env.ASSETS.fetch(new Request(new URL(p, request.url)));
    return [p, res.ok ? readPage(await res.text()) : {}];
  }));
  const originals = Object.fromEntries(pages);
  return SECTIONS.map((s) => {
    const original = originals[s.path][s.id] || [];
    return {
      id: s.id, page: s.page, path: s.path, title: s.title, kind: s.kind, min: s.kind === 'strip' ? s.min : 1, max: s.kind === 'strip' ? s.max : 1,
      shape: s.shape, phoneShape: s.phoneShape || null, hint: s.hint || '', defaultPos: defaultPos(s),
      original, photos: current[s.id] || original, changed: Boolean(current[s.id]), missing: original.length === 0,
    };
  });
}

// Page views reuse what this Worker instance read in the last 20 seconds, so a busy page
// doesn't read KV on every visit. Admin reads (cacheTtl 0) always go to KV.
let memo = { at: 0, value: null };
async function savedPhotos(env, cacheTtl) {
  if (cacheTtl && memo.value && Date.now() - memo.at < 20000) return memo.value;
  const stored = await env.SITE.get(KEY, cacheTtl ? { type: 'json', cacheTtl } : { type: 'json' });
  const value = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  if (cacheTtl) memo = { at: Date.now(), value };
  return value;
}
