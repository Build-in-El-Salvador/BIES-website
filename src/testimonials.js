/**
 * Member testimonials, edited on /admin/testimonials/.
 *
 * One list holds every testimonial, in the order the Community (Stories) page shows them.
 * Each has a full quote (the Community page and the highlighted quotes) and a short one (the
 * small cards). "placements" picks who appears where:
 *   homeHighlight + homeCards (3)          index.html, What Members Are Saying (members.js swaps them)
 *   aboutCards (3)                         about.html, What Members Are Saying…
 *   membershipHighlight + membershipCards (3)   membership.html
 *
 * The pages mark each spot with <!-- testimonials:<key> --> … <!-- /testimonials:<key> -->.
 * Until an admin saves, the HTML in those spots is what visitors get, and the list is
 * src/testimonials-seed.json (made from that same HTML). After a save, the data is stored in
 * KV (binding SITE) under "testimonials:data", and the Worker writes every spot from it.
 *
 *   GET  /api/admin/testimonials            { list, placements, saved }
 *   PUT  /api/admin/testimonials            { list, placements }
 *   POST /api/admin/testimonials/upload     raw WebP or JPEG bytes -> { src }  (photos for cards)
 *   GET  /testimonial-images/<id>.<ext>     an uploaded photo
 */
import SEED from './testimonials-seed.json' with { type: 'json' };
import { json, readJson, isWebUrl, storeUpload, keepUploads, serveUpload } from './admin-lib.js';

const KEY = 'testimonials:data';
const UPLOAD_RE = /^\/testimonial-images\/([0-9a-f-]{36})\.(webp|jpg)$/;
const AVATAR_RE = /^\/?assets\/images\/testimonials\/[a-z0-9_-]{1,60}\.webp$/;
const GALLERY_RE = /^\/?assets\/images\/gallery\/[a-z0-9_-]{1,80}\.(webp|jpg|png)(\?v=\d{1,4})?$/;
const VIDEO_RE = /^\/?assets\/images\/gallery\/[a-z0-9_-]{1,80}\.mp4$/;
const ID_RE = /^[a-z0-9-]{1,64}$/;
const MAX_ITEMS = 300;

const PIN = (size, margin, fill) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" style="vertical-align:-1px;margin-right:${margin}px;fill:${fill}"><path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>`;
const PIN_STORIES = PIN(11, 3, 'var(--orange)');
const PIN_CARD = PIN(11, 3, 'currentColor');
const PIN_FEATURE = PIN(12, 4, 'var(--orange)');

// ---------- writing the pages ----------

const SPOT_RE = /<!-- testimonials:([a-z-]+) -->[\s\S]*?<!-- \/testimonials:\1 -->/g;

export function rewriteTestimonials(html, data) {
  if (!data || !Array.isArray(data.list)) return html;
  const byId = Object.fromEntries(data.list.map((t) => [t.id, t]));
  const p = data.placements || {};
  const pick = (ids) => (ids || []).map((id) => byId[id]).filter(Boolean);
  const render = {
    stories: () => data.list.filter((t) => t.stories).map(storyCard).join('\n'),
    home: () => byId[p.homeHighlight] ? `${homeSpot(byId[p.homeHighlight])}\n    <div class="grid3">\n${pick(p.homeCards).map(homeCard).join('\n')}\n    </div>` : null,
    about: () => cards(pick(p.aboutCards)),
    'membership-feature': () => byId[p.membershipHighlight] ? feature(byId[p.membershipHighlight]) : null,
    'membership-cards': () => cards(pick(p.membershipCards)),
  };
  return html.replace(SPOT_RE, (whole, key) => {
    const out = render[key] ? render[key]() : null;
    return out == null ? whole : `<!-- testimonials:${key} -->\n${out}\n<!-- /testimonials:${key} -->`;
  });
}

function storyCard(t) {
  const media = !t.media ? ''
    : t.media.kind === 'video'
      ? `<video class="mcard-video" controls preload="none" poster="${esc(t.media.poster)}"><source src="${esc(t.media.src)}" type="video/mp4">Your browser does not support video.</video>`
      : `<img src="${esc(t.media.src)}" alt="${esc(t.media.alt || '')}" loading="lazy">`;
  const avatar = t.photo
    ? `<img class="avatar" src="${esc(t.photo)}" alt="${esc(t.name)}" loading="lazy" width="88" height="88">`
    : `<div class="avatar mono" style="background:var(--navy)">${esc(initial(t.name))}</div>`;
  const role = roleHtml(t);
  return `    <figure class="mcard${t.quote ? '' : ' no-quote'}">
      ${media}
      <div class="body">
        ${t.quote ? `<p>${q(t.quote)}</p>` : ''}
        <div class="who">${avatar}<div><b>${esc(t.name)}</b>${role ? `<span>${role}</span>` : ''}${t.location ? `<span class="loc">${PIN_STORIES}${esc(t.location)}</span>` : ''}</div></div>
      </div>
    </figure>`;
}

function homeSpot(t) {
  const role = roleHtml(t);
  return `    <figure class="feature-quote member-spot reveal" id="member-spot" data-member="${esc(t.id)}" aria-live="polite">
      <img class="fq-avatar" src="${esc(t.photo)}" alt="${esc(t.name)}" loading="lazy">
      <div>
        <blockquote class="fq-quote" data-short="${esc(`“${t.short}”`)}">${q(t.quote)}</blockquote>
        <div class="fq-who"><b class="m-name">${esc(t.name)}</b><span class="m-role"${role ? '' : ' hidden'}>${role}</span><span class="fq-loc">${PIN_FEATURE}${esc(t.location)}</span></div>
      </div>
    </figure>`;
}

function homeCard(t) {
  const role = roleHtml(t);
  return `        <figure class="tcard member-card reveal" data-member="${esc(t.id)}">
          <img class="avatar" src="${esc(t.photo)}" alt="${esc(t.name)}" loading="lazy" width="140" height="140">
          <blockquote data-long="${esc(`“${t.quote}”`)}"><p>${q(t.short)}</p></blockquote>
          <figcaption class="who"><b class="m-name">${esc(t.name)}</b><span class="m-role"${role ? '' : ' hidden'}>${role}</span><span class="loc">${PIN_CARD}${esc(t.location)}</span></figcaption>
          <button type="button" class="member-more" aria-controls="member-spot" aria-label="Read ${esc(t.name)}’s full quote" hidden>Read full quote</button>
        </figure>`;
}

function cards(list) {
  return `    <div class="grid3">\n${list.map((t) => {
    const role = roleHtml(t);
    return `        <figure class="tcard reveal">
          <img class="avatar" src="${esc(t.photo)}" alt="${esc(t.name)}" loading="lazy" width="140" height="140">
          <blockquote><p>${q(t.short)}</p></blockquote>
          <figcaption class="who"><b>${esc(t.name)}</b>${role ? `<span>${role}</span>` : ''}${t.location ? `<span class="loc">${PIN_CARD}${esc(t.location)}</span>` : ''}</figcaption>
        </figure>`;
  }).join('\n')}\n    </div>`;
}

function feature(t) {
  const role = roleHtml(t);
  return `  <figure class="feature-quote reveal">
    <img class="fq-avatar" src="${esc(t.photo)}" alt="${esc(t.name)}" loading="lazy">
    <div>
      <blockquote class="fq-quote">${q(t.quote)}</blockquote>
      <div class="fq-who">${esc(t.name)}${role ? `<span>${role}</span>` : ''}${t.location ? `<span class="fq-loc">${PIN_FEATURE}${esc(t.location)}</span>` : ''}</div>
    </div>
  </figure>`;
}

// "Founder, <a>WeSpark</a> & <a>EverybodyKnowsYou</a>"
function roleHtml(t) {
  const orgs = (t.orgs || []).map((o) => (o.url && isWebUrl(o.url)
    ? `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.name)}</a>` : esc(o.name)));
  const title = esc(t.title || '');
  return orgs.length ? `${title}${title ? ', ' : ''}${orgs.join(' &amp; ')}` : title;
}

const q = (s) => `&ldquo;${esc(s)}&rdquo;`;
const initial = (name) => (name.trim()[0] || '?').toUpperCase();
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- admin ----------

// Page views reuse what this Worker instance read in the last 20 seconds (see photos.js).
let memo = { at: 0, value: null, set: false };
export async function savedTestimonials(env, cacheTtl) {
  if (!env.SITE) return null;
  if (cacheTtl && memo.set && Date.now() - memo.at < 20000) return memo.value;
  const stored = await env.SITE.get(KEY, cacheTtl ? { type: 'json', cacheTtl } : { type: 'json' });
  const value = stored && Array.isArray(stored.list) ? stored : null;
  if (cacheTtl) memo = { at: Date.now(), value, set: true };
  return value;
}

export async function adminTestimonials(env) {
  const saved = await savedTestimonials(env, 0);
  return json({ ...(saved || SEED), saved: Boolean(saved) });
}

export async function saveTestimonials(request, env) {
  const body = await readJson(request, 512 * 1024);
  if (!body || !Array.isArray(body.list) || !body.placements || typeof body.placements !== 'object') {
    return json({ error: 'bad_request', detail: 'send a list and placements' }, 400);
  }
  if (body.list.length > MAX_ITEMS) return json({ error: 'bad_request', detail: `at most ${MAX_ITEMS} testimonials` }, 400);

  const str = (v, max) => (typeof v === 'string' ? v.trim().replace(/[ \t]+/g, ' ') : '').slice(0, max + 1);
  const list = [];
  const seen = new Set();
  for (const [i, raw] of body.list.entries()) {
    const who = raw && typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `testimonial ${i + 1}`;
    const problem = (detail) => json({ error: 'bad_request', detail: `${who}: ${detail}` }, 400);
    if (!raw || typeof raw !== 'object') return problem('not an object');
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!ID_RE.test(id) || seen.has(id)) return problem('missing or repeated id');
    seen.add(id);
    const t = {
      id,
      name: str(raw.name, 80), photo: typeof raw.photo === 'string' ? raw.photo : '',
      title: str(raw.title, 80), location: str(raw.location, 40),
      quote: str(raw.quote, 2500).replace(/^[“"]|[”"]$/g, '').trim(),
      short: str(raw.short, 300).replace(/^[“"]|[”"]$/g, '').trim(),
      orgs: [], media: null, stories: raw.stories === true,
    };
    if (!t.name || t.name.length > 80) return problem('the name must be 1 to 80 characters');
    if (t.title.length > 80 || t.location.length > 40) return problem('the title or country is too long');
    if (t.quote.length > 2500 || t.short.length > 300) return problem('the full quote can be up to 2,500 characters and the short one up to 300');
    if (t.photo && !AVATAR_RE.test(t.photo) && !UPLOAD_RE.test(t.photo)) return problem('unknown photo');
    if (!Array.isArray(raw.orgs || []) || (raw.orgs || []).length > 3) return problem('up to 3 businesses');
    for (const o of raw.orgs || []) {
      const name = str(o && o.name, 80);
      const url = str(o && o.url, 300);
      if (!name && !url) continue;
      if (!name || name.length > 80) return problem('each business needs a name');
      if (url && !isWebUrl(url)) return problem(`the link for ${name} must start with https://`);
      t.orgs.push({ name, url });
    }
    const m = raw.media;
    if (m && m.kind === 'image') {
      if (typeof m.src !== 'string' || (!GALLERY_RE.test(m.src) && !UPLOAD_RE.test(m.src))) return problem('unknown card picture');
      t.media = { kind: 'image', src: m.src, alt: str(m.alt, 200) || `${t.name} with Build in El Salvador` };
    } else if (m && m.kind === 'video') {
      if (!VIDEO_RE.test(m.src || '') || !GALLERY_RE.test(m.poster || '')) return problem('unknown video');
      t.media = { kind: 'video', src: m.src, poster: m.poster };
    } else if (m) {
      return problem('unknown card picture');
    }
    if (!t.quote && !(t.media && t.media.kind === 'video')) return problem('needs a quote (only a video card can be without one)');
    list.push(t);
  }

  const byId = Object.fromEntries(list.map((t) => [t.id, t]));
  const P = body.placements;
  const placements = {};
  const need = (label, id, { short, quote }) => {
    const t = byId[id];
    if (!t) return `${label}: choose a testimonial`;
    if (!t.photo) return `${label}: ${t.name} needs a photo first`;
    if (quote && !t.quote) return `${label}: ${t.name} needs a full quote first`;
    if (short && !t.short) return `${label}: ${t.name} needs a short quote first`;
    return '';
  };
  const three = (label, ids, rules) => {
    if (!Array.isArray(ids) || ids.length !== 3) return `${label}: choose 3 testimonials`;
    if (new Set(ids).size !== 3) return `${label}: choose 3 different people`;
    for (const id of ids) { const e = need(label, id, rules); if (e) return e; }
    return '';
  };
  const errors = [
    need('Home, highlighted quote', P.homeHighlight, { quote: true, short: true }),
    three('Home cards', P.homeCards, { quote: true, short: true }),
    Array.isArray(P.homeCards) && P.homeCards.includes(P.homeHighlight) ? 'Home: the highlighted person can’t also be one of the cards' : '',
    three('About cards', P.aboutCards, { short: true }),
    need('Membership, highlighted quote', P.membershipHighlight, { quote: true }),
    three('Membership cards', P.membershipCards, { short: true }),
  ].filter(Boolean);
  if (errors.length) return json({ error: 'bad_request', detail: errors[0] }, 400);
  for (const k of ['homeHighlight', 'homeCards', 'aboutCards', 'membershipHighlight', 'membershipCards']) placements[k] = P[k];

  // Photos uploaded since the last save must still exist (unsaved uploads expire after a
  // day); saving keeps them for good. Uploads no longer used are deleted.
  const before = (await savedTestimonials(env, 0)) || SEED;
  const used = (l) => l.flatMap((t) => [t.photo, t.media && t.media.kind === 'image' ? t.media.src : ''])
    .map((s) => UPLOAD_RE.exec(s || '')).filter(Boolean).map((mm) => `timg:${mm[1]}`);
  const old = new Set(used(before.list));
  const fresh = [...new Set(used(list))].filter((k) => !old.has(k));
  if (!await keepUploads(env, fresh)) return json({ error: 'bad_request', detail: 'a photo upload was not found, upload it again' }, 400);
  const data = { list, placements };
  await env.SITE.put(KEY, JSON.stringify(data));
  memo = { at: 0, value: null, set: false };
  const now = new Set(used(list));
  await Promise.all([...old].filter((k) => !now.has(k)).map((k) => env.SITE.delete(k)));
  return json({ ...data, saved: true });
}

export async function uploadTestimonialImage(request, env) {
  const r = await storeUpload(request, env, { prefix: 'timg:', types: ['image/webp', 'image/jpeg'], maxBytes: 1024 * 1024 });
  return r.error || json({ src: `/testimonial-images/${r.id}.${r.ext}` });
}

export function testimonialImage(pathname, env) {
  const m = UPLOAD_RE.exec(pathname);
  return m ? serveUpload(env, `timg:${m[1]}`, m[2]) : new Response('', { status: 404 });
}
