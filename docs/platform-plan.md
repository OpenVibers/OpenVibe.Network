# The OpenVibe platform — domains, shared systems and the plan

*2026-09-18. Supersedes the two earlier drafts (the "kernel / product domains" map and the
"finish the monorepo runtime" prompt). Both were written for a monorepo that was never built;
this plan is written for the codebase as it actually exists: one repo per property, the shared
`openvibe-shared` package published from the Network, one host, nginx, SQLite, no Redis.*

## 1. The idea, in one paragraph

OpenVibe is one network with many rooms. **openvibe.network is the identity** — accounts,
sessions, themes, notifications, history, coins — and every other domain is a room that uses it.
A room owns one job (streaming, tools, pastes, games, media) and borrows everything else from
the network: the account, the navbar and footer, the theme, the history, the money. The user
should never feel a domain boundary: sign in once, everything knows you; your theme follows you;
the navbar is the same bar everywhere with the room's own name and links in it.

## 2. What exists today (after this pass)

| Domain | What it is | Runs as | Status |
|---|---|---|---|
| **openvibe.network** | identity: accounts, OAuth2/OIDC, sessions, themes, notifications, history, coins, admin | `openvibe-network` :4000 | live |
| **openvibe.live** | streaming product: watch, channels, broadcast, chat, VODs/clips, voice, restreams, arena | `openvibe-live` :3000 (socket-activated) | live |
| **openvibe.tools** + `*.openvibe.tools` | ~250 tool hosts across 8 apps (gateway, img, audio, docs, text, yt, maps, food) | `openvibe-tools*` :4001, :4010-4016 | live |
| **openvibe.media** | media backbone: VODs, clips, pastes, thumbnails, files; hot/cold storage (B2/R2) | `openvibe-media` :4100 | live |
| **openvibe.games** + `play.` | Scraplandia (Babylon/Havok), portal, editor | `openvibe-games` :8000 | live |
| **openvibe.community** | pastes (canonical home), soon spaces/threads/submissions | `openvibe-community` :4200 (new) | live |
| chat, codes, blog, wiki, news, reviews, tips, vip, trade, host, deals, coupons, **openre.stream** | real front pages: what the room will be, what to use meanwhile, network grid, sign-in — static, indexable, shared chrome | nginx static from `OpenVibe.Sites` | live (placeholders) |

Everything runs on the one OVH box behind Cloudflare; every zone has a wildcard Let's Encrypt
certificate (DNS-01 via Cloudflare) and its own nginx vhost.

## 3. Shared systems (the "kernel"), where they live, and how a room uses them

All of these are **in `OpenVibe.Network/packages/openvibe-shared`**, served to browsers from
`https://openvibe.network/shared/*` and vendored (`vendor/openvibe-shared`, re-synced, never edited)
into the Node services that need the server-side helpers.

| System | Module | How a room uses it |
|---|---|---|
| **Identity / SSO** | OAuth2 in the Network (`/oauth/authorize`, `/oauth/token`, JWKS, `prompt=none`); `auth-client.js` + `middleware.js` server-side | Register a client, implement `/auth/login` (`?silent=1&next=`), `/auth/callback` (sets `ov_token` + `ov_sso_hint`), `/auth/logout?next=`, `/auth/me`. Live, Tools, Games and Community do this today. |
| **Session pick-up (lazy SSO)** | `GET /sso/check` (`server/auth/sso-check.js`) + the `ov_sso` cookie + the navbar's `silentLogin` option | Nothing happens at sign-in. When a room is opened without a session it asks the network in a hidden iframe ("is this browser signed in?"); only a yes triggers one silent `prompt=none` sign-in that lands back on the same page. Browsers that partition third-party cookies answer no and the room falls back to its own `ov_sso_hint` from an earlier sign-in. `/sso/fanout` (the redirect chain) remains as the explicit "Sign in / out everywhere" buttons on `/my#linked`. |
| **Navbar** | `navbar.js` — brand from the hostname (`Pastes · OpenVibe · Tools`), compact mode, `links`, `menu.before/after`, `addMenuItem`, account switcher, bell, "Recently used" | `OpenVibeNavbar.init({ service, links, menu, history, silentLogin })`. Nothing else. |
| **Footer** | `footer.js` — network column, legal, socials, signed-in row, `full`/`compact` | `OpenVibeFooter.init({ service, variant, links })`. |
| **Theme** | `theme-loader.js` + `builtin-themes.js` + `theme-sync.js` (generated loader map, derived tokens `--on-accent`, `--accent-rgb`, `--accent-glow`) | Load the loader first in `<head>`; style with the tokens. The user's theme follows them to every room. |
| **Brand mark** | `ov-mark.js` — one animated mark, `data-variant` per room (live pulses red, tools spins, games bounces, community counter-orbits…) | `<span class="ov-mark" data-variant="chat">` |
| **History** | `history.js` + `/api/history` (record, list, search, pause, delete) | `history: { type, title }` on `init`, or `OpenVibeHistory.record()`. Shows in the navbar and on `/my#history`. |
| **Linked services** | recorded by the Network on every OAuth exchange (`linked_accounts.last_used_at`) | Free: any room that signs people in appears on `/my#linked`. |
| **Notifications** | `notification-ui.js`, web push via `openvibe-sw.js` | Bell in the navbar; server-to-server `/internal/notify`. |
| **Tooltips, user cards, account switcher** | `tooltip.js`, `user-card.js`, `account-switcher.js` | markup-driven / `init()`. |
| **URL registry** | `url-resolver.js` (+ admin UI) | Origins for every room, env-overridable; the source for white-labelling. |
| **Analytics** | `analytics.js` (`AnalyticsTracker`) | Per-service request/bot classification and roll-ups. |
| **Media** | OpenVibe.Media API (`/api/v1/:app/...`) with app keys | Rooms store files/VODs/clips/pastes there, never on their own disk. |
| **Money** | Live's Vibes/OpenCoins + PowerChat/PayPal, Network's coins wallet | see §5 (billing consolidation). |

**Rules that keep it one network**
1. Brand names are never typed by hand — the hostname is the brand (`json.openvibe.tools` →
   JSON.OpenVibe.Tools). Sub-brands like "Paste.OpenVibe" are gone.
2. A room never re-implements the navbar, footer, theme loader, login page or history.
3. The Network never hosts product features; a room never hosts identity.
4. Copy says *open, community-run, free speech within the rules* — never "free", "$0", "no ads":
   the network may carry ads or paid tiers later and the voice must not need rewriting.
5. Every public page is server-rendered or static, has a canonical URL, OG/Twitter tags,
   JSON-LD, a sitemap and honest `robots` (draft/AI content is `noindex` until it earns indexing).

## 4. What the two old plans got right, and what changed

Kept from the *domain map*: the split between identity (network) and rooms; one job per domain;
Community as the home of pastes/posts/comments; OpenRe.Stream as the ingest/restream layer
behind Live; Chat as the communication layer; content rooms (news/reviews/deals/coupons/trade)
being source-backed and honest. Kept from the *runtime prompt*: capability-style shared
contracts, real tests over route-existence, readiness that says yellow when it is yellow.

Changed: no monorepo, no Postgres/Redis/MinIO/Socket.IO gateway until a room needs it — the
current SQLite + one host stack is fast and it is what is deployed. Sub-domains of the network
(`auth.`, `api.`, `events.`, `billing.`, `ai.`, `themes.`, `admin.`) stay **paths on
openvibe.network** (`/oauth`, `/api`, `/admin`, `/themes`) — splitting them into hosts adds
cookies and CORS and buys nothing at this size. `my.openvibe.network` already redirects to `/my`.

## 5. Roadmap — each step is a shippable increment

### Now → next (weeks)
1. **Community phase 2** — spaces, threads, posts, comments as reusable primitives
   (`/api/comments?target=live:vod:123`) used by Live VOD/clip pages, Media, Blog and Wiki.
   Discord relay tagging. Moderation shared with Live's tools.
2. **OpenRe.Stream** — move the restream engine's *config UI and status API* to the domain
   (Live keeps the ingest processes); a public "what's live where" status page.
3. **Chat** — `openvibe.chat` embeds Live's chat server with rooms not bound to a stream
   (global rooms, DMs) and the voice channels; Live embeds it back. One `/ws/chat`, one moderation.
4. **Codes** — docs portal generated from the repos' `docs/` folders + OpenAPI extracted from
   the Express routers; capability explorer reading the URL registry.
5. **Billing consolidation** — one ledger in the Network (Vibes, OpenCoins, channel points
   reconcile through it); `openvibe.tips` and `openvibe.vip` become the product faces
   (alerts/overlays, memberships) of that ledger. Providers stay PayPal/PowerChat.

### Then (months)
6. **Blog / Wiki** — one content engine (revisions, media via Media, comments via Community),
   two front doors. AI drafts default to `noindex` until edited by a person.
7. **News / Reviews / Deals / Coupons / Trade** — one ingestion/source registry, entity
   resolution, provenance-first pages; nothing indexable without sources; no fake ratings, prices
   or advice. Community threads underneath.
8. **Host** — the deploy tooling every repo already ships (`deploy/scripts/deploy.sh`,
   systemd units, nginx generators, certbot) exposed as a product for bots/mods/static sites.
9. **Cross-room features for accounts** — favourites and "continue where you left off"
   (history already exists), shared collections (a paste + a clip + a post), profile page on the
   network that aggregates every room.

### Infrastructure when it is actually needed
- Second host → nginx generator already emits per-site configs; the Network's URL registry
  already resolves origins per environment.
- Postgres/Redis only for a room whose write volume demands it (Chat first).
- A real event bus only when two rooms need to react to the same event asynchronously
  (today: Network `/internal/notify` + webhooks are enough).

## 6. Operating notes
- Deploys: each repo's `deploy/scripts/deploy.sh` (Live: `--wait-idle` holds while someone
  streams). Client-only Live changes go live on `git pull`.
- Certificates: `certbot --dns-cloudflare` wildcard per zone; renewal is automatic.
- Cloudflare: DNS for all 19 zones points at the host (apex + www; wildcards on
  network/tools). Zone settings (SSL mode, TLS min, Brotli, HTTP/3) need a token with *Zone
  Settings: Edit* — the DNS token cannot read them.
- Shared package changes: edit in the Network, `npm test`, deploy the Network (browsers pick
  it up within the hour — nginx caches `/shared/` for 1h, Cloudflare respects it), then
  re-sync vendor copies in Live/Tools/Media/Community for the server-side helpers.
