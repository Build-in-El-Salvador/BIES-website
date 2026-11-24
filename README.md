# buildinelsalvador.com — your website package

Last updated June 2026.

## What's here
This folder is your whole website. `index.html` is the home page, with `membership.html`, `stories.html`, `about.html`, and `privacy.html` alongside it. Your photos and logo live under `assets/images/`, and all of your colors and fonts live in one file, `assets/css/tokens.css`.

This build is **English only** for now. Spanish can be added later as a `/es/` mirror of every page.

## Preview it locally
Just open `index.html` in your browser. All links and images use relative paths, so it works straight from the folder. (For a server-style preview you can also run `python3 -m http.server` inside this folder and visit `http://localhost:8000`.)

## Replace the photos
Drop your originals into `_source/photos-original/` (any format). The web-ready versions go under `assets/images/` in the right subfolder:

| Where it appears | Goes to | Recommended size |
|---|---|---|
| Hero photo strips | `assets/images/hero/` | min 1100px wide |
| Section photos | `assets/images/gallery/` | min 1200px wide |
| Logo | `assets/images/logos/` | vector (SVG) if possible |
| Testimonial cards | `assets/images/testimonials/` | min 800px wide |

Save them as `.webp` for speed (the same name as the file you're replacing).

## Change your colors or fonts
Everything is in `assets/css/tokens.css`. Editing that one file re-skins the whole site.

## The newsletter signup
The "Subscribe" forms point to your Substack at https://buildinelsalvador.substack.com/. The "Become a Partner / Get in touch" buttons point to your sponsor Google Form. Replace those URLs in the page if they move.

## Things to wire up before launch
- The contact email throughout the site is `info@buildinelsalvador.com` (the address from your live site).
- "Subscribe" -> your Substack, and "Become a Partner / Get in touch" -> your sponsor Google Form are already wired.
- "Apply to join" is still a placeholder (it scrolls to the membership section). Point it at a real application form, the app, or a Calendly when ready.
- Replace the two "Partner" placeholder blocks with real partner content when available.

## Request a change
Message everybodyknowsyou.com with what you'd like changed, and we'll handle it.

## BIES Lightning addresses

The Worker resolves a published `name@buildinelsalvador.com` through `/.well-known/lnurlp/name`. To provision an alias, the domain operator records the verified account's 64-character hex Nostr public key and its confirmed **live** Satlantis Lightning address in the existing `SITE` KV binding. The key is `lightning:alias:<name>` and the JSON value has `pubkey` and `address` fields. The Worker checks the BIES NIP-05 owner on each lookup and passes through the provider's invoice callback and original metadata. An unassigned alias or an owner mismatch returns an error. The simulator uses Satlantis development wallets.
