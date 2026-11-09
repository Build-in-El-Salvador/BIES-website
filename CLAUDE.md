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
  js/members.js    home "What Members Are Saying" swap (own ?v=)
  js/partners.js   About page partner logos from /api/partners (own ?v=)
  js/admin-*.js, css/admin.css   the admin pages
  js/team.js       About page team cards: click a card to open its bio (own ?v=)
  data/            local preview sample for events.html (not deployed)
  images/          site images; images/gallery/ holds photos + .mp4 video
src/worker.js      /api/events, /events/<code>, NIP-05 (not deployed as an asset)
src/admin.js       website admin routes; photos.js, testimonials.js, partners.js, admin-lib.js (see Website admin)
admin/             the admin pages (noindex; robots.txt disallows /admin/)
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
  cover). Cached 2 minutes at the edge, plus a 7-day last-good copy for outages. If
  some event details fail, only the date, cover, description and API extras are filled
  from that copy (never tickets or sales state); the result is kept 30 seconds and never replaces
  it. The build has a 9-second deadline (the page waits 12); the past list and API
  extras get 3 seconds. It only runs on buildinelsalvador.com, www and localhost.
- Optional Worker secret `PRETIX_TOKEN` (a read-only pretix team token, dashboard →
  Settings → Variables and Secrets) adds per-event `host` and `status` (organizer
  properties) and map coordinates. Without it the page still works. Never put the
  token in the repo; `.dev.vars` is git-ignored.
- Share links: `/events/<code>` (e.g. `/events/sn260926`, any case) is the Events page with
  that event's title, date and cover in its link-preview tags, filled in by the Worker, and
  the page opens that event's popup. Older `/events#SN260926` links still open the popup
  but preview as the generic Events page (link previews never see the `#` part).
- Buying: the popup's button links to the pretix event page (new tab). The site loads
  no pretix script and sets no cookies.
- If a Content-Security-Policy is ever added, allow `img-src https://tickets.buildinelsalvador.com`
  (covers) and keep `connect-src 'self'` (`/api/events`).

## Website admin

BIES admins edit three things at `buildinelsalvador.com/admin/`, with no code change or
deploy: **Photos** (`/admin/`), **Testimonials** (`/admin/testimonials/`) and **Partners**
(`/admin/partners/`). The pages are `admin/**/index.html` with `assets/js/admin-*.js` and
`assets/css/admin.css`. The server side is `src/admin.js` (routes), `src/admin-lib.js`
(sign-in, uploads), `src/photos.js`, `src/testimonials.js` and `src/partners.js`.

- **Storage:** one Workers KV namespace bound as `SITE`. It holds:
  - `photos:sections` and `photo:<id>` (uploads)
  - `testimonials:data` and `timg:<id>`
  - `partners:list` and `logo:<id>`

  Unsaved uploads expire after a day.
- **How saved edits reach visitors:** `wrangler.jsonc` lists `/`, `/about`, `/membership`,
  `/faq`, `/events` and `/stories` in `assets.run_worker_first`. For those pages the Worker
  writes saved photos and testimonials into the HTML before sending it, so there is no flash
  and search engines see the new content. KV reads are edge-cached for 60 s, so a save shows
  within a minute. With nothing saved, or on any error, the page is the plain file.
- **Editable spots are marked in the HTML:**
  - photos: `data-photos="<id>"` on a strip `<div>` or an `<img>`; the list is `SECTIONS` in `src/photos.js`
  - testimonials: `<!-- testimonials:<key> -->…<!-- /testimonials:<key> -->` comments

  Keep the markers when editing pages. **Once testimonials have been saved on the admin
  page, edit them there, not in the HTML:** the saved copy replaces the marked spots. The
  starting list is `src/testimonials-seed.json`, made from the HTML on 2026-11-09.
- **Partners:** `assets/js/partners.js` redraws the About strip from `/api/partners` (cached a
  minute). A partner only shows with a logo and "Show on website" ticked.
- **Sign-in:** one shared password, the Worker secret `ADMIN_PASSWORD` (kept in the BIES
  Bitwarden). Sessions last 12 hours and are signed with the secret `ADMIN_SESSION_KEY`;
  changing that key signs everyone out. Eight wrong passwords from one IP block sign-in for
  15 minutes. Every change needs a same-site `Origin` header.
- **Uploads:** the browser shrinks photos (longest side 2000 px), logos (660x260, edges
  trimmed) and profile photos (320 px square) before upload. That also drops camera and
  location data. The Worker accepts only WebP, JPEG or PNG, and checks the file bytes.
- **Cropping photos:** the photo editor shows the whole photo with a box for the part the
  website shows (and a dashed one for phones where the shape differs). Moving the box only
  changes the saved `pos` (CSS object-position). A box smaller than the frame is a crop: the
  browser cuts it from the original, uploads the copy as `src`, and saves `orig` (the photo it
  came from) and `crop` ([x, y, w, h] fractions of `orig`) so it can be changed later. Pages
  only use `src` and `pos`.
- **Switched on 2026-11-09:** the KV namespace `bies-site` is bound in `wrangler.jsonc`.
  The two secrets are set (or changed) from this folder with
  `npx wrangler secret put ADMIN_PASSWORD` and `npx wrangler secret put ADMIN_SESSION_KEY`
  (any long random string, e.g. `openssl rand -base64 48`), or in the dashboard under
  Workers → bies-website → Settings → Variables and Secrets. Until both are set, `/admin/`
  says it isn't set up; the pages work either way.
- **Local preview:** `node src/preview.mjs` stands in for KV with `.wrangler/preview-kv.json`
  and reads the two secrets from `.dev.vars` (git-ignored). To start over, stop the server,
  delete the JSON file, and start it again (the server keeps the data in memory).

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
