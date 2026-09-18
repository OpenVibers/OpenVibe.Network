# Shared contracts — what every OpenVibe site builds against

*2026-09-18. The shared browser modules live in `OpenVibe.Network/packages/openvibe-shared` and are
served from `https://openvibe.network/shared/<file>.js` (5-minute edge cache). Node helpers are
vendored (`vendor/openvibe-shared`, rsync, never edited). This file is the contract; the modules
are the implementation.*

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
| `canonical` | 200 | itself | yes |
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
`OpenVibeUI.alert({ title, message })`. Themed, stacked, accessible (`role=status|alert`), one
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

## 7. Chrome data (`GET https://openvibe.network/api/chrome?host=<hostname>`)

Public, CORS `*`, `max-age=600`, ETag. What the navbar and footer of every site show:
`nav` (open sites, most used first), `soon` (reserved domains), `footer.blurb`, `footer.discover`,
`footer.popular` (tools) and `footer.legal` (`terms`/`privacy`/`dmca` on the site's **own** domain).

- Ranking = each service's 7-day page views and visitors plus signed-in cross-site history,
  refreshed every 30 minutes and stored in `chrome_cache`, so an unreachable service keeps its last
  score. The Network itself counts page views only, at half weight.
- Copy = once a day the AI configured in admin (called through Live's internal
  `POST /internal/ai/site-copy`, budget-gated) may write a blurb per site and pick links **by id**
  from a list we supply. Ids resolve to our URLs server-side; text is length-capped and screened
  (no markup, no URLs, no cost claims). Anything that fails keeps the hand-written copy.
- Clients: `navbar.js` and `footer.js` share `window.OpenVibeChrome` — a per-host localStorage cache
  (30 min, refreshed in the background). Navbar options: `networkLinks` (`false` | count, default 4).

## 8. Legal (`require('openvibe-shared/legal')`)

`app.get(legal.PATHS, legal.handler({ id, service, host, name, profile }))` serves `/terms`,
`/privacy`, `/dmca` for that domain. Profiles: `streaming`, `tools`, `ugc`, `games`, `hosting`,
`account`, `info`. Live keeps its own longer documents (`/tos`, `/privacy`, `/dmca`; `/terms`
redirects). Placeholder domains and Games get static copies from OpenVibe.Sites. Facts in the
documents (retention windows, cookies, providers) must match the code; they are templates for the
owner to review, not legal advice.
