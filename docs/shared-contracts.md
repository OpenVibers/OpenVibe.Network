# Shared contracts — what every OpenVibe site builds against

*2026-09-18. The shared browser modules live in OpenVibe.Shared, consumed as a pinned release
tarball, and are served from `https://openvibe.network/shared/<file>.js` (5-minute edge cache; a
year for a `?v=` content-hash URL). Node helpers come from the same pinned release in each
service's `node_modules`. This file is the contract; the modules are the implementation.*

## 1. Tool catalog and domains

**One catalog of tools, owned by OpenVibe.Tools**, merged with **domain overrides owned by the
Network** (owner-only admin).

`GET https://openvibe.tools/api/catalog.json` (public, CORS `*`, `Cache-Control: public, max-age=300`)

```jsonc
{
  "updated": "2026-09-18T05:00:00Z",
  "families": [ { "id": "net", "name": "Network Tools", "tagline": "…", "description": "…",
                  "icon": "network", "url": "https://net.openvibe.tools/", "path": "/network-tools" } ],
  "tools": [ {
      "id": "yt", "family": "media", "name": "YouTube Downloader",
      "tagline": "Save videos and audio from YouTube",          // ≤ 60 chars, human
      "description": "…2–3 sentences, plain words, what it does and for whom…",
      "keywords": ["youtube downloader", "youtube to mp3", "…"], // search terms people type
      "icon": "youtube",                                          // ov-icons name (§4)
      "hosts": { "canonical": "youtube-downloader.openvibe.tools", // what links, sitemaps and rel=canonical use
                 "short": "yt.openvibe.tools",                     // what a person types; serves 200, canonical → canonical host
                 "aliases": ["youtube.openvibe.tools", "ytdl.openvibe.tools"] }, // 301 → short
      "url": "https://youtube-downloader.openvibe.tools/"
  } ]
}
```

Host roles, enforced by the Tools gateway (and honoured by satellites through request headers):

| role | response | `<link rel=canonical>` | used in links / sitemaps |
|---|---|---|---|
| `canonical` | 200 for crawlers and API calls; **302 → short** for a person's page load | itself | yes |
| `short` | 200 | the canonical host | no (it is what people type and share) |
| `alias` | 301 → short (or canonical when there is no short) | — | no |
| unknown `*.openvibe.tools` | 301 → `https://openvibe.tools/` | — | — |
| unknown custom domain | 404 | — | — |

A **custom domain** (e.g. `youtubedownloadonline.com`) set as a tool's `canonical` makes that the
host every link, sitemap entry and canonical tag uses; the `*.openvibe.tools` hosts keep working.

`GET https://openvibe.network/api/domains` (public, CORS `*`, `max-age=60`)
→ `{ "updated": "...", "domains": [ { "tool_id": "yt", "host": "youtubedownloadonline.com", "role": "canonical" } ] }`
Owner-only management: `GET/POST/PUT/DELETE https://openvibe.network/api/admin/domains[/:id]`
(`{ tool_id, host, role: 'canonical'|'short'|'alias', enabled, note }`; a host belongs to one tool;
one enabled canonical and one enabled short per tool; hostnames validated; every change audited).
Tools merges: code defaults ← Network overrides (fetched server-side, cached 60 s, last good copy kept).

The gateway forwards to satellites with `X-OV-Tool`, `X-OV-Host-Role`, `X-OV-Canonical-Host`,
`X-OV-Short-Host` so a satellite renders the right canonical/OG/brand without its own registry.

## 2. Navbar (`navbar.js`)

`OpenVibeNavbar.init({ service, apiBase, token?, user?, links?, menu?, history?, silentLogin?, fedcm?, launcher?, notifications? })`

- Brand = hostname, three linked segments: **sub** → this tool's home (`/`), **OpenVibe** →
  `https://openvibe.network/`, **TLD** → the site's apex (`https://openvibe.tools/`). So from
  `yt.openvibe.tools` one click on "Tools" is the tools index.
- `launcher` (default on): the grid button next to the brand opens the network launcher — every
  site plus the tool families, fed by the catalog, keyboard navigable, cached in sessionStorage.
- `notifications` (default on): when signed in the navbar loads `notification-ui.js` itself and
  mounts the bell — pages no longer wire it.
- Everything else as before (links, menu.before/after, addMenuItem, history, silentLogin, fedcm).

## 3. Activity island (`island.js`, also `OpenVibeNavbar.activity`)

A page tells the navbar what it is doing; the brand mark becomes the indicator and a pill
("island") grows out of the brand with rich content.

```js
const a = OpenVibeIsland.start({ id: 'dl-123', title: 'Downloading', subtitle: 'Never Gonna Give You Up',
    icon: 'youtube', image: thumbUrl, progress: 0, state: 'busy', detail: '—',
    actions: [{ label: 'Cancel', onClick }] });
OpenVibeIsland.update('dl-123', { progress: 0.42, detail: '12.4 MiB/s · ETA 00:08' });
OpenVibeIsland.finish('dl-123', { state: 'ok', title: 'Ready', actions: [{ label: 'Save file', href, download: true }], ttl: 12000 });
OpenVibeIsland.fail('dl-123', { title: 'Download failed', detail: err });
```

`progress`: 0–1 or `null` (indeterminate). `state`: `busy | ok | error | info`. Several
activities stack; the newest is shown compact, hover/tap expands to the rich card (image, title,
subtitle, progress bar, detail line, actions). The brand mark shows the progress ring and the
state colour for the top activity. Works without the navbar (falls back to a fixed pill).

## 4. Icons (`ov-icons.js`)

`<span class="ov-icon" data-icon="youtube" data-size="40" data-state="idle|busy|ok|error" data-progress="0.4" data-fx="orbit|pulse|draw|none"></span>`
— one animated SVG family (ring + glyph) drawn with the theme accent. `OpenVibeIcons.names()`,
`.register(name, { glyph: '<path …/>', accent?, fx? })`, `.mount(root?)`, `.set(el, { progress, state })`.
Built-ins cover every site and tool family (live, tools, network, media, games, community, chat,
codes, blog, wiki, news, reviews, tips, vip, trade, host, deals, coupons, stream, youtube, image,
audio, pdf, text, logo, json, code, dns, ip, ssl, ping, whois, map, food, paste, download, search …).
Unknown names fall back to the OV mark. Reduced motion is honoured.

## 5. UI (`ui.js`)

`OpenVibeUI.toast(message, { type: 'info|success|error|warning', title?, action?: { label, onClick|href }, ttl? })`,
`OpenVibeUI.confirm({ title, message, confirmLabel, danger })` → Promise<boolean>,
`OpenVibeUI.alert({ title, message })`,
`OpenVibeUI.notice({ id, type, title, message, links: [{ label, href }], dismissible })` — the one page-level
notice for status, maintenance and similar; it always sits directly under the navbar. Themed, stacked, accessible (`role=status|alert`), one
implementation for every site.

## 6. SEO (`seo.js`, Node — `require('openvibe-shared/seo')`)

```js
const seo = require('openvibe-shared/seo');
seo.headTags({ title, description, canonical, image, type, siteName, robots, locale, keywords,
               alternates: [{ hreflang, href }], jsonLd: [ … ] })      // → HTML string for <head>
seo.jsonLd.website({ name, url, description, searchUrl? })  .organization()  .softwareApp({ name, url, description, category, keywords })
seo.jsonLd.breadcrumbs([{ name, url }])  .itemList(name, [{ name, url, description }])  .faq([{ q, a }])
seo.sitemapXml([{ loc, lastmod?, changefreq?, priority?, alternates? }])    seo.sitemapIndexXml([...])
seo.robotsTxt({ sitemaps: [...], disallow: [...], allowAI: true })          // AI/search crawlers welcome by default
seo.llmsTxt({ name, summary, sections: [{ title, links: [{ title, url, note }] }] })   // /llms.txt
```

Rules: every public page is server-rendered (or static) and readable without JavaScript; one
canonical URL per page; titles ≤ 60 chars, descriptions 120–160; JSON-LD on every page type;
sitemaps list canonical hosts only; `/llms.txt` on every site; never the words "free", "$0",
"no ads" as claims about the platform.

## 7. Frame data (`GET https://openvibe.network/api/frame?host=<hostname>`)

The OpenVibe Frame is the navbar, footer and "shipped" views every OpenVibe site sits in. `/api/chrome` is the old name of this endpoint, kept for copies of openvibe-shared older than 1.11.0.

Public, CORS `*`, `max-age=600`, ETag. What the navbar and footer of every site show:
`nav` (open sites, most used first), `soon` (reserved domains), `footer.blurb`, `footer.discover`,
`footer.popular` (tools) and `footer.legal` (`terms`/`privacy`/`dmca` on the site's **own** domain).

- Ranking = each service's 7-day page views and visitors plus signed-in cross-site history,
  refreshed every 30 minutes and stored in `frame_cache`, so an unreachable service keeps its last
  score. The Network itself counts page views only, at half weight.
- Copy = once a day OpenVibe.AI's `network.site_copy` workflow (self-signed `svc:network` service
  token, `ns network.*`) may write a blurb per site and pick links **by id** from a list we supply.
  Ids resolve to our URLs server-side; text is length-capped and screened (no markup, no URLs, no
  cost claims). There is no fallback source: when AI fails, the last good copy (kept in
  `frame_cache`) stays, or the hand-written copy if there has never been one.
- Clients: `navbar.js` and `footer.js` share `window.OpenVibeFrame` (`OpenVibeChrome` is the old alias) — a per-host localStorage cache
  (30 min, refreshed in the background). Navbar options: `networkLinks` (`false` | count, default 4).

## 8. Legal (`require('openvibe-shared/legal')`)

`app.get(legal.PATHS, legal.handler({ id, service, host, name, profile }))` serves `/terms`,
`/privacy`, `/dmca` for that domain. Profiles: `streaming`, `tools`, `ugc`, `games`, `hosting`,
`account`, `info`. Live keeps its own longer documents (`/tos`, `/privacy`, `/dmca`; `/terms`
redirects). Placeholder domains and Games get static copies from OpenVibe.Sites. Facts in the
documents (retention windows, cookies, providers) must match the code; they are templates for the
owner to review, not legal advice.

## 9. App icons (`require('openvibe-shared/app-icon')`)

One mark for every site, tinted per site (`SITES`): `svg({ site, maskable })`, `favicon({ site })`,
`manifest({ site, name, shortName, description, iconBase })`, `headTags({ site, iconBase })`.
`scripts/build-app-icons.js <site> <outDir> [--sharp <module>]` renders `logo.svg`,
`logo-{72,192,512}.png` and `logo-maskable-{192,512}.png`. `theme-loader.js` repaints
`link[rel=icon][data-ov-icon]` and `meta[name=theme-color]` on every theme apply and emits `ov:theme`.

## 10. Display preferences (in `theme-loader.js`)

`OpenVibeThemeLoader.display.get()` / `.set({ motion: 'auto'|'reduced', text: '100'|'112'|'125' })`.
Applied before first paint as `<html data-ov-motion>` and `--ov-text-scale` / `data-ov-text`; stored
in `localStorage.ov_display`, synced across tabs, saved to the account through
`PUT /api/themes/me/display` and returned by `GET /api/themes/me/active` (`display`). Emits
`ov:display`. Controls: the navbar launcher everywhere, the user menu on Live. Site-specific layout
choices (card density, chat width, units) stay local to the site that owns them.

## 11. Internal routes

Service-to-service routes need `X-Internal-Key` = the deployment's `INTERNAL_API_KEY` **and** a
loopback caller with no proxy headers (Tools: `apps/_shared/internal-auth.js`; Live:
`server/internal/routes.js`). No secret is ever a constant in a repository. Tools' gateway sums its
satellites at `GET /api/internal/analytics`; Games and Media have no analytics, so the admin panel
shows their navbar page-view count, labelled as such.

Icon glyphs are optically centred from measured bounds: after adding or editing a glyph run
`node scripts/measure-icons.js <cdp harness>` (in OpenVibe.Shared) to regenerate the offsets table.

## 12. Avatar — one picture per account, always on openvibe.media

Source of truth: `users.avatar_url` on the Network (`server/profile/avatar.js`). It is only ever an
`https://openvibe.media/…` address. Clients never supply the stored address:

| input to `PUT /api/profile/avatar { source }` | what happens |
|---|---|
| a paste link or slug (community, live, media) | resolved to `https://openvibe.media/p/<slug>/screenshot`, checked to be an image |
| an `https://openvibe.media/…` image | checked to be an image |
| any other https picture link | **imported**: Media fetches it once (`POST /internal/avatar-ingest`: public addresses only, connection pinned to the checked address, ≤ 3 redirects, 8 MB, 10 s), re-encodes to a 512×512 WebP and stores it as an unlisted avatar paste (`app_id = 'network'`) |
| anything else | refused |

`DELETE /api/profile/avatar` clears it. `GET https://openvibe.network/avatar/<username>[?s=96]` is public and
cacheable: 302 to the picture, or a generated initial; usable in any `<img>` on any site.
Sync: the Network pushes changes to Live (`POST /internal/user-avatar` on Live); Live reports its own avatar
picker's changes to the Network (`POST /internal/user-avatar` on the Network, media addresses only). A change
that came from a site is not echoed back to it.

## 13. Navbar for app-style sites (what Live uses)

`OpenVibeNavbar.init({ …, auth: 'external', className, links, chips, menu, onNavigate, onLogout, accounts, adminLink })`

- `links[]`: `{ id, page, label, href, icon, elId, hidden, external, dot, dotId, onClick, children[] }` — children make a
  dropdown; on narrow screens every link moves into the drawer behind the hamburger.
- `chips[]` (beside the bell) and `menu.headerChips[]`: `{ id, icon, value, valueId, title, tone: 'gold'|'green', onClick }`.
- `menu.sections[]`: `{ id, label, items: [{ id, label, icon, href, onClick, hidden, danger, value, elId }] }`;
  `menu.defaults: false` drops the built-in "You"/account rows, the Display and Across OpenVibe groups stay.
- `auth: 'external'`: the site signs people in itself and calls `setUser(user, token)`.
- `onNavigate(href, event)`: same-origin links and menu rows go through the site's router (return `false` when handled).
- API: `setUser`, `setActive(page)`, `setChip(id, text)`, `updateLink(id, patch)`, `updateMenuItem(id, patch)`.
- State classes a site puts on the bar (Live's `nav-hero-top`) survive re-renders. Icons are inline SVG for the
  31 names in `NAV_ICONS`; other Font Awesome names fall back to the page's font.
Live's whole navbar is `public/js/ov-navbar-live.js` (config only) mounted in `#navbar-mount`.
