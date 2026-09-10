# BIES Website

Marketing site for Build in El Salvador — <https://buildinelsalvador.com>

## What this is

A **plain static site**. No framework, no build step, no `package.json`, no
dependencies. Hand-written HTML + CSS + a little vanilla JS. Keep it that way —
the whole point is that anyone on the team can open a file and edit it.

The one exception is `src/worker.js`: a small Cloudflare Worker script that adds a
single JSON route, `/api/events`, for the Events page. Every page is still a
static file.

## Preview locally

```bash
node src/preview.mjs          # whole site with LIVE event data: http://localhost:8788/events
python3 -m http.server 8000   # static only; events.html falls back to assets/data/events.sample.json
```

Do not use `npx wrangler dev`: the asset directory is the repo root, so wrangler's
watcher sees its own `.wrangler/` scratch files and reloads forever.

Always preview before pushing. There is no staging environment; `main` is production.

## Deploy

Push to `main` → **Cloudflare Workers Builds** deploys the Worker `bies-website`
(BIES Cloudflare account) in about a minute. Custom domains `buildinelsalvador.com`
and `www` are attached in the dashboard.

- `wrangler.jsonc` is the config: the repo root is served as static assets and
  `src/worker.js` answers `/api/events`. The name must stay `bies-website` (another
  name creates a second Worker). Never add a `routes` key (it would take the custom
  domains away from the dashboard).
- `.assetsignore` lists repo files that must never be public. **Anything not listed
  is served at `buildinelsalvador.com/<path>`** — add new non-website files there.
- The Workers Builds deploy command should be plain `npx wrangler deploy`, with no
  `--assets` / `--name` flags, so `wrangler.jsonc` is the single source of truth.
- Rollback: `git revert` the commit and push, or Deployments → roll back in the dashboard.
- Before 2026-09 the config lived only in the dashboard (autoconfig), which published
  the whole repo folder, `.git/` included. `.assetsignore` stops that.

## Layout

```
index.html  about.html  stories.html  membership.html  faq.html  privacy.html
events.html  404.html
assets/
  css/tokens.css   COLORS + FONTS ONLY — the single source of truth
  css/styles.css   everything else (layout, components)
  css/events.css   the Events page only (own ?v=)
  js/main.js       nav toggle + scroll reveal
  js/events.js     the Events page only (own ?v=)
  data/            local preview sample for events.html (not deployed)
  images/          site images; images/gallery/ holds photos + .mp4 video
src/worker.js      /api/events (not deployed as an asset)
src/preview.mjs    local preview server
wrangler.jsonc  .assetsignore
```

## Events page

- **pretix is the source of truth.** Events are created, edited and sold at
  `tickets.buildinelsalvador.com` (organizer `bies`). Never hard-code an event here.
  The staff recipe is `EVENTS-RUNBOOK.md` in the BIES CORE planning folder.
- `/api/events` reads pretix's public pages: the widget JSON (upcoming and past
  lists, description, tickets, prices, availability) and each event page's JSON-LD
  (exact start/end) and `og:image` (the event's "Social media image", used as the
  cover). Cached 2 minutes at the edge, plus a 7-day last-good copy for outages.
- Optional Worker secret `PRETIX_TOKEN` (a read-only pretix team token, dashboard →
  Settings → Variables and Secrets) adds per-event `host` and `status` (organizer
  properties) and map coordinates. Without it the page still works. Never put the
  token in the repo; `.dev.vars` is git-ignored.
- Buying: the popup's button links to the pretix event page (new tab). The site loads
  no pretix script and sets no cookies.
- If a Content-Security-Policy is ever added, allow `img-src https://tickets.buildinelsalvador.com`
  (covers) and keep `connect-src 'self'` (`/api/events`).

## Conventions

- **Colors and fonts live in `tokens.css` and nowhere else.** Never hard-code a
  hex value in a stylesheet or a page — add or reuse a token.
- Use the semantic tokens (`--ink`, `--accent`, `--surface`, `--line`) in
  components rather than the raw palette (`--navy`, `--orange`).
- Pages share their header and footer markup by copy — there are no includes.
  If you change nav or footer, **change it in all 7 full pages** (the six originals
  and `events.html`, which uses root-relative `/…` paths).
- Cache-bust CSS/JS edits by bumping the `?v=` query string on the `<link>` /
  `<script>` tags that reference them.
- The display font is **Saira Condensed**, a free stand-in for the licensed
  brand typeface PP Formula Narrow. If webfont licences are ever bought, drop the
  files in `assets/fonts/` and update `--font-display`.

## Gotchas

- `CNAME` and `.nojekyll` are leftovers from an old GitHub Pages setup; neither
  GitHub Pages nor the old Cloudflare Pages project serves this site any more.
- The Worker does not serve `404.html` for unknown paths (empty 404), matching how
  the site has always behaved on Workers. Setting `"not_found_handling": "404-page"`
  in `wrangler.jsonc` would switch it on.
- `assets/images/gallery/` contains multi-megabyte `.mp4` files. Compress video
  before adding more — the repo is already ~100 MB.
- `assets/eky-credit.svg` is the previous agency's footer credit.
