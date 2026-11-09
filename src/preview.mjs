// Local preview of the whole site WITH live event data, no dependencies:
//
//   node src/preview.mjs          then open http://localhost:8788/events
//
// Serves the repo root like the live Worker does (/about -> about.html). Like Cloudflare,
// any path that matches no file goes to src/worker.js: /api/events (run against the real,
// public pretix pages) and the per-event share pages, /events/sn260926.
// Why not `npx wrangler dev`: the site's asset directory is the repo root, so wrangler's
// file watcher sees its own .wrangler/ scratch files change and reloads forever.
// `python3 -m http.server` still works too; events.js then falls back to
// assets/data/events.sample.json on localhost.
//
// Website admin (/admin/): the KV namespace (SITE) is stood in for by .wrangler/preview-kv.json,
// and the two admin secrets are read from .dev.vars (git-ignored), e.g.
//   ADMIN_PASSWORD=some-local-test-password
//   ADMIN_SESSION_KEY=any-long-random-string
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';
import { PHOTO_PAGES } from './photos.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8788;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json', '.zip': 'application/zip' };

// Stand-in for the Cloudflare Cache API. Like the real one, an entry expires after the
// s-maxage (else max-age) in its Cache-Control header, so pretix edits show up locally
// on the same 2-minute schedule as in production.
const memory = new Map();
globalThis.caches = { default: {
  match: async (req) => {
    const hit = memory.get(req.url);
    if (!hit) return undefined;
    if (Date.now() >= hit.expires) { memory.delete(req.url); return undefined; }
    return hit.res.clone();
  },
  delete: async (req) => memory.delete(req.url),
  put: async (req, res) => {
    const cc = res.headers.get('Cache-Control') || '';
    const age = /s-maxage=(\d+)/.exec(cc) || /max-age=(\d+)/.exec(cc);
    memory.set(req.url, { res: res.clone(), expires: Date.now() + (age ? Number(age[1]) : 0) * 1000 });
  },
} };

// Stand-in for a Workers KV namespace, kept in .wrangler/preview-kv.json between runs.
const KV_FILE = join(ROOT, '.wrangler', 'preview-kv.json');
const kvData = new Map(Object.entries(await readFile(KV_FILE, 'utf8').then(JSON.parse).catch(() => ({}))));
function kvLive(key) {
  const e = kvData.get(key);
  if (e && e.expires && Date.now() >= e.expires) { kvData.delete(key); return undefined; }
  return e;
}
function kvDecode(e, type) {
  const buf = Buffer.from(e.b64, 'base64');
  if (type === 'json') return JSON.parse(buf.toString('utf8'));
  if (type === 'arrayBuffer') return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (type === 'stream') return new Response(buf).body;
  return buf.toString('utf8');
}
const kvSave = () => mkdir(join(ROOT, '.wrangler'), { recursive: true })
  .then(() => writeFile(KV_FILE, JSON.stringify(Object.fromEntries(kvData))));
const SITE = {
  async get(key, opts = {}) { const e = kvLive(key); return e ? kvDecode(e, typeof opts === 'string' ? opts : opts.type) : null; },
  async getWithMetadata(key, opts = {}) {
    const e = kvLive(key);
    return e ? { value: kvDecode(e, typeof opts === 'string' ? opts : opts.type), metadata: e.metadata ?? null } : { value: null, metadata: null };
  },
  async put(key, value, opts = {}) {
    const buf = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    kvData.set(key, { b64: buf.toString('base64'), metadata: opts.metadata ?? null, expires: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 });
    await kvSave();
  },
  async delete(key) { kvData.delete(key); await kvSave(); },
};
const devVars = Object.fromEntries((await readFile(join(ROOT, '.dev.vars'), 'utf8').catch(() => ''))
  .split('\n').map((l) => /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));

const env = { ...devVars, SITE, ASSETS: { fetch: async (req) => {
  const found = await file(decodeURIComponent(new URL(req.url).pathname));
  return found
    ? new Response(found.body, { headers: { 'Content-Type': TYPES[extname(found.full)] || 'application/octet-stream' } })
    : new Response('', { status: 404 });
} } };

async function file(path) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  for (const candidate of [safe, `${safe}.html`, join(safe, 'index.html')]) {
    const full = join(ROOT, candidate);
    if (!full.startsWith(ROOT)) return null;
    try { if ((await stat(full)).isFile()) return { full, body: await readFile(full) }; } catch (_) { /* try next */ }
  }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // Like Cloudflare: /api/ and the pages in run_worker_first go to the Worker first.
    const found = url.pathname.startsWith('/api/') || PHOTO_PAGES.has(url.pathname) ? null
      : await file(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!found) {
      const waits = [];
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
      const r = await worker.fetch(new Request(url, { method: req.method, headers, body }), env, { waitUntil: (p) => waits.push(p) });
      const out = Object.fromEntries(r.headers);
      const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(r.status, out);
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await r.arrayBuffer()));
      await Promise.all(waits);
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(found.full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(found.body);
  } catch (err) {
    console.error(err);
    res.writeHead(500); res.end(String(err));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Preview: http://localhost:${PORT}/events  (Ctrl+C to stop)`));
