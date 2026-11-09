/**
 * Shared by the website admin tools (src/admin.js routes to them): sign-in, sessions and
 * small request helpers.
 *
 * Sign-in is one shared admin password, the Worker secret ADMIN_PASSWORD (kept in the BIES
 * Bitwarden). A session is a cookie signed with the Worker secret ADMIN_SESSION_KEY;
 * changing that key signs everyone out. Data lives in the Workers KV namespace bound as SITE.
 */

export const COOKIE = 'bies_admin';
const SESSION_SECONDS = 12 * 3600;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES = 8;
export const PUBLIC_HOSTS = ['buildinelsalvador.com', 'www.buildinelsalvador.com'];

export function adminConfigured(env) {
  return Boolean(env.SITE && env.ADMIN_PASSWORD && env.ADMIN_SESSION_KEY);
}

// ---------- sign-in ----------

export async function login(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const rlKey = `login-failures:${ip}`;
  const failures = Number(await env.SITE.get(rlKey)) || 0;
  if (failures >= LOGIN_MAX_FAILURES) return json({ error: 'too_many_attempts' }, 429);

  const body = await readJson(request, 2048);
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!password || !await samePassword(password, env)) {
    await env.SITE.put(rlKey, String(failures + 1), { expirationTtl: LOGIN_WINDOW_SECONDS });
    await new Promise((r) => setTimeout(r, 400));
    return json({ error: 'wrong_password' }, 401);
  }
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const token = `v1.${expires}.${await sign(`v1.${expires}`, env)}`;
  return json({ ok: true }, 200, 0, { 'Set-Cookie': cookie(token, SESSION_SECONDS) });
}

export function logout() {
  return json({ ok: true }, 200, 0, { 'Set-Cookie': cookie('', 0) });
}

export async function validSession(request, env) {
  const token = readCookie(request, COOKIE);
  const m = /^v1\.(\d{9,12})\.([A-Za-z0-9_-]{43})$/.exec(token || '');
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', await hmacKey(env), unb64url(m[2]), new TextEncoder().encode(`v1.${m[1]}`));
}

// Browsers send Origin on every fetch that changes something; another site's page can't fake it.
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return Boolean(origin) && origin === new URL(request.url).origin;
}

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_SESSION_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(data, env) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(data));
  return b64url(new Uint8Array(mac));
}

// Compares HMACs of the two passwords, so the comparison takes the same time however
// many characters match.
async function samePassword(given, env) {
  const key = await hmacKey(env);
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(env.ADMIN_PASSWORD));
  return crypto.subtle.verify('HMAC', key, expected, new TextEncoder().encode(given));
}

function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/api/admin; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

// ---------- uploads ----------

// Stores an uploaded image under `<prefix><uuid>`. Unsaved uploads expire after a day;
// keepUploads() makes the ones a saved list uses permanent.
export async function storeUpload(request, env, { prefix, types, maxBytes }) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!types.includes(type)) return { error: json({ error: 'bad_request', detail: `upload a ${types.map((t) => t.split('/')[1].toUpperCase()).join(' or ')} image` }, 415) };
  if (Number(request.headers.get('Content-Length')) > maxBytes) return { error: json({ error: 'too_large' }, 413) };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) return { error: json({ error: 'too_large' }, 413) };
  if (sniff(bytes) !== type) return { error: json({ error: 'bad_request', detail: 'the file is not the image type it claims to be' }, 415) };
  const id = crypto.randomUUID();
  await env.SITE.put(`${prefix}${id}`, bytes, { metadata: { type }, expirationTtl: 24 * 3600 });
  return { id, ext: EXT[type] };
}

// keys: KV keys of uploads a list now uses. Returns false if one has expired or never existed.
export async function keepUploads(env, keys) {
  const found = await Promise.all(keys.map((key) => env.SITE.getWithMetadata(key, { type: 'arrayBuffer' }).then((r) => ({ key, ...r }))));
  if (found.some((f) => !f.value)) return false;
  await Promise.all(found.map((f) => env.SITE.put(f.key, f.value, { metadata: f.metadata })));
  return true;
}

export async function serveUpload(env, key, ext) {
  if (!env.SITE) return new Response('', { status: 404 });
  const { value, metadata } = await env.SITE.getWithMetadata(key, { type: 'arrayBuffer', cacheTtl: 3600 });
  if (!value || !metadata || metadata.type !== TYPE_FOR_EXT[ext]) return new Response('', { status: 404 });
  return new Response(value, {
    headers: {
      'Content-Type': metadata.type,
      // An upload's address changes whenever it is replaced, so it can be cached for good.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}

const EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };
const TYPE_FOR_EXT = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' };

function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return '';
}

// ---------- helpers ----------

export async function readJson(request, limit) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return null;
  if (Number(request.headers.get('Content-Length')) > limit) return null;
  const text = await request.text();
  if (text.length > limit) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

export function isWebUrl(s) {
  if (s.length > 300) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname) && !u.username && !u.password;
  } catch (_) { return false; }
}

export function json(body, status = 200, maxAge = 0, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
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

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
