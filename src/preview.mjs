// Local preview of the whole site WITH live event data, no dependencies:
//
//   node src/preview.mjs          then open http://localhost:8788/events
//
// Serves the repo root like the live Worker does (/about -> about.html) and answers
// /api/events by running src/worker.js against the real, public pretix pages.
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

const memory = new Map(); // stand-in for the Cloudflare Cache API
globalThis.caches = { default: {
  match: async (req) => (memory.has(req.url) ? memory.get(req.url).clone() : undefined),
  put: async (req, res) => { memory.set(req.url, res.clone()); },
} };
const env = { ASSETS: { fetch: async () => new Response('', { status: 404 }) } };

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
    if (url.pathname.startsWith('/api/')) {
      const waits = [];
      const r = await worker.fetch(new Request(url, { method: req.method }), env, { waitUntil: (p) => waits.push(p) });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      await Promise.all(waits);
      return;
    }
    const found = await file(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!found) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(found.full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(found.body);
  } catch (err) {
    console.error(err);
    res.writeHead(500); res.end(String(err));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Preview: http://localhost:${PORT}/events  (Ctrl+C to stop)`));
