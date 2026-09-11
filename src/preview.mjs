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
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8788;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json' };

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
  put: async (req, res) => {
    const cc = res.headers.get('Cache-Control') || '';
    const age = /s-maxage=(\d+)/.exec(cc) || /max-age=(\d+)/.exec(cc);
    memory.set(req.url, { res: res.clone(), expires: Date.now() + (age ? Number(age[1]) : 0) * 1000 });
  },
} };
const env = { ASSETS: { fetch: async (req) => {
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
    const found = url.pathname.startsWith('/api/') ? null
      : await file(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!found) {
      const waits = [];
      const r = await worker.fetch(new Request(url, { method: req.method }), env, { waitUntil: (p) => waits.push(p) });
      res.writeHead(r.status, Object.fromEntries(r.headers));
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
