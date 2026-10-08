# OpenVibe.Network

## Purpose

Identity and account service for the OpenVibe network. Manages user accounts, OAuth2 authorization, theme preferences, notifications, email alerts, anonymous identities, the network-wide OpenCoins wallet, and internal APIs that connect all OpenVibe services together.

**Part of the [OpenVibe](../ARCHITECTURE.md)** — `https://openvibe.network`

---

## What it does

- **SSO Identity Provider** — "One Account. All of OpenVibe." Central registration and login, OAuth2 Authorization Code flow for OpenVibe.Live, OpenVibe.Tools, OpenVibe.Games, and OpenVibe.Media.
- **Refresh tokens** — stored only as a SHA-256, rotated on every use as the next `generation` of the sign-in's `family_id`; presenting an already rotated token again (after a 10-second grace for two tabs refreshing at once) revokes the whole family and is audited (`oauth_refresh_reuse`). Rows from before this change still work: a raw row is hashed the first time it is presented. `server/auth/refresh-tokens.js`.
- **OpenID Connect** — discovery at the issuer's root, `/.well-known/openid-configuration` (also RFC 8414's `/.well-known/oauth-authorization-server`; the older `/oauth/...` alias was retired in plan T2). With scope `openid` the code grant adds an RS256 `id_token` (aud = client, the authorize `nonce` echoed, `sub` = the Network id as a string, `subject_id` = the canonical usr_ id); `/oauth/userinfo` returns the same claims for an access token (`server/auth/oidc.js`).
- **Unified Notification System** — Cross-service notifications with priority levels, category filtering, toast popups, bell badge, sounds, and rich content (buttons, inputs, media). All services push notifications to the central API; clients poll every 15 seconds.
- **Email Alerts** — Critical notifications (moderation actions, system alerts) can be delivered by the built-in email service. Configuration is managed through the admin panel.
- **Anonymous Users** — Browse and interact without an account. Anon users receive a unique number, can accumulate stats, and optionally link to a registered account later.
- **Multi-Account Switching** — Google-style account management. Users can add multiple accounts and switch instantly, including an anonymous mode.
- **Theme Catalog** — Shared theme system with ~30 built-in themes and community submissions. Theme preferences sync across all services.
- **Admin Panel** — email configuration, user management (role changes, bans), broadcast notifications, system health dashboard, and audit log.
- **Internal API** — Server-to-server endpoints for token verification, user lookup, notification push, account linking, and audit logging. Every route takes a capability-scoped service token; the deployment-wide key they used to accept was retired on 2026-09-29 (plan T2, [docs/retirement.md](docs/retirement.md)) and opens nothing.
- **Developer projects (foundation)** — projects, members, apps (OAuth clients with `app_` subjects), hashed client secrets with rotation and revocation, capability grants within a staff-set allowance (sandbox apps also get a default sandbox allowance of public Media, Events-app and Tools-job capabilities, so a new project works without staff), recorded quotas, per-project usage from the services' hourly rollups (`GET /api/v1/projects/:project/usage`) and an append-only audit at `/api/v1/projects`. Its events can be relayed to OpenVibe.Events through an outbox when `OV_EVENTS_INTERNAL_URL` is set. Bearer user tokens only; the console over this API is OpenVibe.Services at openvibe.services (it moved there from OpenVibe.Codes on 2026-10-08). See [docs/developer-projects.md](docs/developer-projects.md).
- **Public discovery** — `/.well-known/openvibe`, `/api/v1/registry/*` and `/contracts/*.json` (services, capabilities, contract schemas) answer any origin with `Access-Control-Allow-Origin: *`, preflight included, so a browser app can discover the platform directly. Every other route keeps the first-party CORS allow-list (`server/public-cors.js`).
- **OpenCoins Wallet** — Network-wide currency. User balance/history at `/api/coins/*`; atomic credit/debit/transfer for services at `/internal/coins/*` with idempotency-key dedupe.
- **User modules** — versioned per-person preferences and summaries in namespaces owned by services (openvibe-contracts `manifests/namespaces`); see [User modules](#user-modules).

---

## Owns

- accounts, sessions, anonymous identities, canonical subjects (`usr_…`, `gst_…`) and account merges
- OAuth2/OIDC (the network's token issuer and its signing key), service principals and their grants,
  developer projects, apps, credentials, grants and quotas (ADR-014), mod principals
- notifications and email, themes and theme preferences, user modules, platform blocks, the follow
  graph (ADR-030), creator analytics (ADR-021), the OpenCoins wallet
- node principals: a person's paired machine (`nod_…`) with a one-time pairing code, a scoped credential and a
  token; a revoke — by the pairing service, its owner, or an account deletion — stops the machine and is announced
  as `network.node.revoked@1`
- the service registry (`/api/v1/registry/*`, `/.well-known/openvibe`), the status page, the network
  changelog proxy, and the files at `/shared/*` (the pinned openvibe-shared release)

## Does not own

- money (OpenVibe.Billing), channel points and streams (OpenVibe.Live), each service's data (a user
  module's namespace belongs to the service that owns it)
- the contracts it serves (OpenVibe.Contracts) and the Frame's code (OpenVibe.Shared)

## Depends on

- `openvibe-contracts` v0.111.0 (registry manifests, capability checks), `openvibe-sdk` v0.35.0 (PostgreSQL
  and Valkey adapters, events, per-actor limits, universal telemetry), `openvibe-shared` v2.13.2, pinned by release tarball
- OpenVibe.Events (Network's outbox relay; the events it consumes), OpenVibe.AI (the `network.site_copy`
  workflow), OpenVibe.Blog (the changelog feed it proxies)
- email (Resend), Discord and GitHub when their secrets are set ([Provider secrets](#provider-secrets))

## Capabilities

Implemented here (the service manifest's 20 `capabilities`, audience `openvibe.network`):
`identity.subject.resolve`, `mods.grant.manage`, `network.account.deletion.confirm`,
`network.account.export.contribute`, `network.analytics.creator.read`, `network.blocks.read`,
`network.coins.credit|debit|transfer`, `network.follows.read|write`, `network.integration.github.read`,
`network.modules.read|write`, `network.notifications.push`, `network.operator.alert`,
`network.project.manage|read`, `network.staff.read` and `network.status.incident`. The grants other
services hold are seeded in [server/identity/principals.js](server/identity/principals.js).

Called elsewhere: Network is the issuer, so it signs its own `svc:network` tokens: `events.event.publish`
(and `events.delivery.admin` for the admin Events views) at OpenVibe.Events, and `ai.run.create` /
`ai.run.read` at OpenVibe.AI for the footer's site copy.

## Architecture

```
openvibe.network (port 4000)
├── server/
│   ├── index.js              # Express app, CORS, service init, periodic tasks
│   ├── config.js             # Port, JWT, DB, OAuth, connected services
│   ├── auth/
│   │   ├── routes.js         # Register, login, profile, anon sessions, multi-account, follows
│   │   └── oauth-routes.js   # OAuth2 authorize, token, OIDC discovery
│   ├── notifications/
│   │   ├── notification-service.js  # CRUD, preferences, email queue, cleanup
│   │   ├── routes.js                # REST API for notification UI
│   │   └── email-service.js         # Resend email service with HTML templates
│   ├── admin/
│   │   └── routes.js         # Admin panel API (email settings, users, broadcast, health)
│   ├── themes/
│   │   └── routes.js         # Theme CRUD, user preferences
│   ├── internal/
│   │   └── routes.js         # Server-to-server API (verify-token, user sync, notif push)
│   └── db/
│       └── database.js       # PostgreSQL handle (openvibe-sdk/db), migrations/, boot seeding
├── public/
│   ├── index.html            # Landing page (hero + service cards)
│   ├── login.html            # Animated login/register page
│   └── my.html               # Account management (profile, sessions, notifications)
├── deploy/
│   ├── nginx/                # openvibe.network.conf
│   ├── scripts/              # deploy.sh (runs `ovhost deploy network`), deploy-legacy.sh (its fallback)
│   └── systemd/              # openvibe-network.service (EnvironmentFile=/etc/openvibe/network.env)
└── .env.example
```

---

## Setup

```bash
# 1. Install dependencies
cd OpenVibe.Network && npm install

# 2. Generate RSA keys for JWT signing
mkdir -p data/keys
openssl genrsa -out data/keys/private.pem 2048
openssl rsa -in data/keys/private.pem -pubout -out data/keys/public.pem

# 3. Configure environment
cp .env.example .env
# Edit .env — set ADMIN_USERNAME, ADMIN_PASSWORD, and optionally SETUP_TOKEN and BOOTSTRAP_PROFILE.
# In production also set DATABASE_URL (the runtime role through PgBouncer), DATABASE_DIRECT_URL (the owner
# role on a direct connection, for migrations) and VALKEY_URL (shared limit counters). Without
# DATABASE_URL, development uses an embedded PGlite database in data/pglite; production refuses to boot.

# 4. Run
npm start

After the first run the service will seed the URL registry with safe defaults and create an admin account from environment values. Visit `/api/setup/status` for setup health and use `/api/setup/bootstrap` to apply registry profiles manually.
```

The server applies `migrations/NNNN_*.sql` at boot (as the owner on `DATABASE_DIRECT_URL`) and seeds OAuth2 clients and site settings on first run into PostgreSQL. Client secrets are logged to console once on creation — copy them to the consuming services' env files (`/etc/openvibe/<svc>.env`). The tests run on PGlite (`npm test`) or the PostgreSQL + PgBouncer containers (`npm run test:pg`, after `eval "$(openvibe-sdk scripts/test-services.sh up)"`).

To rotate a service principal, load **Network's** environment before the script name and pass the target service's file with `--write-env`:

```bash
sudo node --env-file=/etc/openvibe/network.env server/setup/service-principal.js rotate <id> --write-env /etc/openvibe/<id>.env
```

The script requires the database named `ov_network` (or an explicit `--database-name <name>` override). Do not use `--env-file` after the script name: Node loads it as environment and can select the target service's database.

---

## Deploying

`sudo /opt/openvibe.network/deploy/scripts/deploy.sh` runs `ovhost deploy network --install-units`
(OpenVibe.Host, strategy `git-checkout`; roadmap WS-N task 11): a fast-forward pull as the checkout owner,
`npm install --omit=dev` when the lockfile or dependency fields changed, every dependency checked before
anything restarts, `deploy/systemd/openvibe-network.service` installed when it differs (daemon-reload), the
restart, `/api/ready` polled, an automatic rollback if it does not come up, and the release announced.
`--restart`, `--wait-idle`, `--force` and `--rollback` (`ovhost rollback network`) are passed on; `DRY_RUN=1`
prints `ovhost plan network`. When ovhost is missing, too old or does not manage Network, the wrapper runs
`deploy/scripts/deploy-legacy.sh`, the previous script, unchanged (`OVHOST_LEGACY=1` forces it).

The unit is `openvibe-network.service` (runs as `ubuntu` from `/opt/openvibe.network`) on
`127.0.0.1:4000`, the env file `/etc/openvibe/network.env`. Rollback: automatic when `/api/ready` does not
come up; afterwards `sudo ovhost rollback network --to <sha>`. Two blockers: `chrome_cache`/`chrome_hits`
became `frame_cache`/`frame_hits` on 2026-09-24 (an older release starts with empty caches), and
`tool_domains` was rebuilt once for the mirror role (an older release does not know mirror rows).

---

## TLS / Certbot Deploy Support

`openvibe.network` includes a built-in deploy subsystem under `server/deploy/` that can manage Let’s Encrypt certificates and preview Nginx config.

### What it does

- wraps local `certbot` calls via `server/deploy/cert-manager.js`
- supports `cloudflare` mode using `certbot-dns-cloudflare`
- supports `manual` DNS-01 issuance for wildcard certificates
- stores certs under `/etc/letsencrypt/live/<domain>/`
- generates Nginx config templates that reference `/etc/letsencrypt/live/.../fullchain.pem` and `privkey.pem`

### Requirements

- `certbot` installed and available in `PATH`
- for Cloudflare mode: `certbot-dns-cloudflare` plugin installed
- `/etc/letsencrypt` writable by the service user
- `nginx` installed if you want preview/apply support

### Deploy configuration keys

Use the `network` deploy setup API or URL registry to configure:

- `DEPLOY_ACME_EMAIL` — ACME registration email
- `DEPLOY_CERT_MODE` — `cloudflare`, `manual`, or `none`
- `DEPLOY_CLOUDFLARE_TOKEN` — Cloudflare API token for DNS-01 challenge
- `DEPLOY_DOMAINS` — array of domain objects, e.g. `[{domain:'openvibe.network',wildcard:false,certName:'openvibe.network',services:['network']}]`
- `DEPLOY_NGINX_MODE` — `preview`, `apply`, or `disabled`
- `DEPLOY_NGINX_SITES_PATH` — path where Nginx site files should be written
- `DEPLOY_NGINX_BACKUP_PATH` — backup directory for generated Nginx configs
- `DEPLOY_SERVICE_MAP` — optional service mapping override

### Admin deploy endpoints

The deploy subsystem exposes admin-only APIs at `/api/admin/deploy`:

- `GET /api/admin/deploy/prerequisites` — check `certbot`, plugin, `/etc/letsencrypt`, and `nginx`
- `GET /api/admin/deploy/config` — read current deploy config
- `PUT /api/admin/deploy/config` — save deploy config values
- `GET /api/admin/deploy/certs` — list certificates known to certbot
- `POST /api/admin/deploy/certs/issue-cloudflare` — issue a wildcard cert via Cloudflare DNS-01
- `POST /api/admin/deploy/certs/manual-info` — get manual DNS challenge instructions
- `POST /api/admin/deploy/certs/issue-manual` — run manual DNS issuance after TXT records are in place
- `POST /api/admin/deploy/certs/renew` — renew all certbot certificates
- `GET /api/admin/deploy/nginx/preview` — preview generated Nginx configs

### How to use it

1. Install certbot:

```bash
sudo apt update
sudo apt install certbot python3-certbot-dns-cloudflare
```

2. Ensure `nginx` is installed if you want config preview/apply support.

3. Set deploy registry values through the setup API or admin config.

4. For Cloudflare mode, provide a valid Cloudflare token. The wrapper writes `/etc/letsencrypt/cloudflare.ini`.

5. For manual mode, create the required DNS TXT records for `_acme-challenge.<domain>` and `*. <domain>` as instructed by the service.

6. After issuance, Nginx configs reference certs at `/etc/letsencrypt/live/<domain>/fullchain.pem` and `/etc/letsencrypt/live/<domain>/privkey.pem`.

7. Use `POST /api/admin/deploy/certs/renew` to renew existing certs.

### Notes

- The deploy module does not replace a full deployment toolchain; it is a built-in helper for cert issuance and Nginx preview.
- If `DEPLOY_CERT_MODE` is set to `none`, the service will still generate preview Nginx configs but will leave SSL certificate paths commented out.
- `certbot` must be installed on the host running openvibe.network, not just in Docker or another container.

---

## Notification System

### How it works

1. **Any service** pushes notifications to openvibe.network via `POST /internal/notifications/push`
2. **openvibe.network** stores them in PostgreSQL with priority, category, and optional rich content
3. **Clients** poll `GET /api/notifications` every 15 seconds, rendering toasts and updating the bell badge (or, where a site turned realtime on, hear each new notification over OpenVibe.Events and poll every 2 minutes as a safety net: see *Realtime badge* below)
4. **Critical notifications** are queued for email delivery via the built-in email service (Resend by default).

### Priorities

| Priority | Behavior |
|----------|----------|
| `low` | Silent — badge only, no toast or sound |
| `normal` | Standard toast with subtle notification sound |
| `high` | Persistent toast with attention sound, auto-dismiss 8s |
| `critical` | Sticky toast (must dismiss), urgent sound, **triggers email** |

### Categories

`social`, `chat`, `game`, `stream`, `economy`, `achievement`, `moderation`, `system`, `service`, `admin`

Users can toggle each category's enabled/sound/toast/email preferences at `openvibe.network/my` → Notifications tab.

### Cross-Service Push

Other services push notifications to openvibe.network via the internal API:

```bash
curl -X POST http://127.0.0.1:4000/internal/notifications/push \
  -H "Authorization: Bearer <service token with network.notifications.push>" \
  -H "Content-Type: application/json" \
  -d '{"userId": 42, "type": "new_follower", "data": {"actorName": "someone"}}'
```

### Notifications from Events

`POST /internal/events` (`server/notifications/events-consumer.js`) turns OpenVibe.Events deliveries
into inbox notifications for the person they name, through the same `NotificationService.create()`
as everything else, so a person who turned the `service` category off gets nothing and email follows
their per-category email choice.

| Event type | From | Person | Notification |
|---|---|---|---|
| `deals.watch.matched` | Deals (`source: deals`) | `payload.recipient` (`usr_…`) | `DEAL_WATCH_MATCH`, `service`, normal |
| `trade.alert.triggered` | Trade (`source: trade`) | `subject.id` (`subject.type: user`) | `TRADE_ALERT`, `service`, high |
| `live.stream.started` | Live (`source: live`) | every follower of `payload.channel.subject`, plus everyone with `stream_live_all` on | `STREAM_LIVE`, `stream`, high; the Discord live alert after commit |

**Go-lives.** The followers are Network's own follow graph (see "Follow graph"): the active
`user_follows` rows for `('channel', payload.channel.subject)`, read in the same transaction as the
notifications. Live is never asked. A channel whose subject has no Network account is `ignored:channel`;
a follower whose subject has no account is counted as `unresolved`; the streamer never hears about
themself; the `stream` category's mute and email choice apply. A start more
than 30 minutes old (a replay, or Events catching up) announces nothing. The per-streamer window (one
announcement an hour, eight a day; `stream_live_cooldown_min`, `stream_live_daily_cap`) is shared with
Live's direct `POST /internal/events/stream-live` (`server/notifications/stream-live.js`), so while Live
still makes that call, whichever arrives first announces and the other is skipped.
Until `NETWORK_GO_LIVE_FOLLOWS_READY=1` is set on Network, Events go-lives are acknowledged as
`ignored:follows_cutover_pending` and Live's direct POST remains the delivery path.

**Project usage.** `tools.usage.recorded` and `events.usage.recorded` (hourly rollups of a developer
project's use, `common.usage-recorded@1`) are kept per project and day (`server/developer/usage.js`,
tables `dev_usage_windows`, `dev_usage_daily`, `dev_usage_errors`) for `GET /api/v1/projects/:project/usage`
and the project's usage page on openvibe.services; they notify nobody. See
[docs/developer-projects.md](docs/developer-projects.md#usage).

Coupons publishes no watch event yet: its merchant watches never leave Coupons, and its `coupons.*`
events name no person. Every other type is acknowledged and ignored. Deliveries are v2-signed only
(`openvibe-sdk` `parseDelivery` with `requireV2`, ±300 s), and each `event_id` is handled once
(openvibe-sdk inbox, table `network_event_inbox`, consumer `network-notifications`). Links point at a
site only when its domain serves the service (the exposure overlay above); until then the URL is kept
in `rich_content.context.planned_url`.

The route is inert until the operator does both of these:

1. Generate the signing secret and give it to Network: add
   `NETWORK_EVENTS_SECRET=<openssl rand -hex 32>` to `/etc/openvibe/network.env` (comma-separate a
   second value to rotate), and make sure `OV_EVENTS_INTERNAL_URL=http://127.0.0.1:4300` is set.
   Restart `openvibe-network`; the log says `[Events consumer] on`.
2. Create the subscriptions in Events (consumer `network`, which Events takes from the token's
   `svc:network`; endpoint `http://127.0.0.1:4000/internal/events`; topic patterns
   `deals.watch.matched`, `trade.alert.triggered` and `live.stream.started`; secret = the first
   `NETWORK_EVENTS_SECRET`). On a host that already has the other two, add `live.stream.started` alone with
   `--topic live.stream.started` (and the project usage rollups with
   `--topic tools.usage.recorded --topic events.usage.recorded`):

   ```bash
   cd /opt/openvibe.network
   sudo node --env-file=/etc/openvibe/network.env scripts/subscribe-events.js --dry-run
   sudo node --env-file=/etc/openvibe/network.env scripts/subscribe-events.js
   ```

   The script signs its own 5-minute service token (Network is the issuer: `sub svc:network`,
   `aud openvibe.events`, `cap events.subscription.manage`) and hands the secret to Events in the
   subscription body, the way Deals, News and Tips do with theirs. It prints the subscription ids,
   never the secret, and reports an existing identical subscription instead of duplicating it.

Each go-live's outcome is logged, with counts only:

```
[Events consumer] live.stream.started evt_…: notified {"followers":3,"unresolved":0,"targets":3,"notified":3}
```

This is the evidence compatibility register row C-85 waits for. A `notified` line for a real go-live means the consumer, not Live's direct call, told the followers. While Live still makes the direct `POST /internal/events/stream-live`, that call usually claims the per-streamer window first, and the consumer logs `skipped:cooldown`.

### Realtime badge (network.notification.created)

Every notification `NotificationService.create()` stores is announced as **`network.notification.created`** (Contracts 0.61.0; ADR-005 amendment 2). The envelope goes into `network_event_outbox` in the same transaction as the notification: both exist or neither. The relay then publishes it to Events.
- **Envelope:** subject `{ type: user, id: <recipient usr_> }`, visibility `subject` (Events streams it to that person only), actor `system:network`.
- **Payload:** `notification_id`, `type`, `category`, `priority`, `service`, `created_at` and the recipient's `unread_count`. Never the title, message, link or sender.
- **Nothing announced:** a muted category, a blocked sender or a go-live dedupe stores nothing, so it announces nothing. Guests and accounts without a `usr_` subject get no event.

The badge on other sites cannot use a cookie of openvibe.events, so it asks here for a **realtime ticket**:

```
POST /api/v1/realtime/ticket          (Bearer Network JWT, or the ov_token cookie here; 60/min per IP)
→ 200 { ticket, expires_at, expires_in: 120, stream_url, topics: ["network.notification.*"], subject }
```

It then opens `${stream_url}?topics=network.notification.*&ticket=…[&last_event_id=…]`.
- **The ticket** (`server/auth/realtime-ticket.js`, `identity.realtime-ticket-claims@1`) is an RS256 JWT: `iss <issuer>/realtime`, `sub <usr_>`, `aud [openvibe.events]`, `typ` and `purpose` `realtime`, 120 s, `jti rtk_…`. Events accepts each one once.
- **Never a session:** its issuer, `typ` and audience each rule that out, and this session guard refuses it too.
- **Not stored, logged or audited:** it grants the person only their own stream.
- **Refusals:** a guest gets 403 `realtime.guest`. `REALTIME_TICKETS=off` in `/etc/openvibe/network.env` answers 503 `realtime.disabled`, and every badge stays on polling. `OV_EVENTS_PUBLIC_URL` overrides the stream origin (default `https://openvibe.events`).
- **Client:** openvibe-shared `notification-live.js`, on where a site sets `notificationsRealtime: true`.

A digest (a daily or weekly summary instead of one alert per notification) is designed in [docs/notification-digest.md](docs/notification-digest.md) for a later release.

---

## Email Setup

Email is optional — the notification system works without it. Email is only sent for **CRITICAL** priority notifications.

### Quick setup

1. Create a domain or sender identity at <https://resend.com/domains>.
2. Add the required SPF, DKIM, and MX records to your DNS provider.
3. Configure the Resend API key and from-addresses in the admin panel.
4. Verify your domain on Resend before sending production email.

### Admin panel configuration

Configure email at runtime via the admin panel (the API key only when `RESEND_API_KEY` is not set; see below):
- `GET /api/admin/email` — view current email config (`api_key_source`: `env`, `database` or `unset`)
- `PUT /api/admin/email` — update API key, default from address, and per-service from addresses
- `POST /api/admin/email/test` — send a test email

## Provider secrets

Each provider secret has an environment variable, read first; the `site_settings` row is only a
fallback (`server/secrets.js`, roadmap §18.2(12)). While a variable is set, the admin panel shows the
secret as "set in the environment" and never saves one into the database. `GET /api/admin/secrets`
(owner) and the boot line `[Secrets] resend_api_key=env …` say which source each one uses, never a value.

| Setting | Variable | Used for |
| --- | --- | --- |
| `resend_api_key` | `RESEND_API_KEY` | email delivery |
| `resend_webhook_secret` | `RESEND_WEBHOOK_SECRET` | Resend delivery webhooks (Svix `whsec_…`) |
| `discord_bot_token` | `DISCORD_BOT_TOKEN` | Discord bot alerts |
| `discord_oauth_client_secret` | `DISCORD_OAUTH_CLIENT_SECRET` | Discord account linking |
| `vapid_private_key` | `VAPID_PRIVATE_KEY` | web push (the public key is derived from it; `VAPID_PUBLIC_KEY` optional) |

`net.ipinfo_token`, `net.globalping_token` and the old `ses_*` keys are never read by Network (the Tools
gateway reads `NET_IPINFO_TOKEN` / `NET_GLOBALPING_TOKEN` from its own env file).

Moving them out of the database (operator):

```bash
cd /opt/openvibe.network
sudo node scripts/secrets-out-of-db.js                 # dry run: names, env file and running service, per secret
sudo node scripts/secrets-out-of-db.js --copy-to-env   # dry run of the copy into /etc/openvibe/network.env
sudo node scripts/secrets-out-of-db.js --copy-to-env --apply   # appends VAR=value lines (backup: network.env.bak-<time>)
sudo systemctl restart openvibe-network                # the boot line shows <key>=env
sudo node scripts/secrets-out-of-db.js --apply --backup data/network-pre-secrets-$(date +%F).db
# rollback: sudo node scripts/secrets-out-of-db.js --restore-from data/network-pre-secrets-<date>.db --apply
```

`--apply` blanks a database copy only when the env file sets the variable to the same value (a
different one only with `--allow-different`) and the running service already has it, plus the secrets
Network never reads; everything else is kept and the dry run says why. The script reads the env file
and the service's environment as root, then becomes the database owner. It never prints a value:
`--copy-to-env` reads the database in a child process running as its owner and hands the values to the
env file through a pipe (a value that would need quoting is left for the operator to add by hand).

---

## Anonymous Users

Anonymous users can browse and interact without creating an account:

- Each anon user gets a unique number (e.g., "Anonymous #42")
- Stats and preferences are tracked via a session token
- Fingerprint matching reconnects returning anonymous visitors
- Anon identities can be linked to a registered account at any time, merging stats; the guest's user modules move to the account (the account's own record wins in a namespace where it has one)
- Multi-account switcher includes a "Continue as Anonymous" option

### API

- `POST /api/auth/anon-session` — create anonymous session
- `GET /api/auth/anon/:token` — get anon user info
- `PUT /api/auth/anon/:token/preferences` — update anon preferences
- `POST /api/auth/anon/:token/link` — link anon identity to registered account

---

## User modules

One JSON record per (person, namespace), for portable preferences and summaries (never domain truth).
Namespaces, schemas, writers, public fields and quotas come from openvibe-contracts
(`manifests/namespaces`); `server/identity/modules.js` enforces them.

- People: `GET /api/modules` (export), `GET|PUT|DELETE /api/modules/:ns` (`If-Match: <revision>` on PUT).
  Anyone: `GET /api/modules/:ns/public/:subject` (public fields only).
- Services: `GET|PUT|DELETE /internal/modules/:ns/:subject`, service token only (`network.modules.read` /
  `network.modules.write` with the namespace in the grant); only the namespace's owner writes.
  `chat.preferences` is owned by Chat since the Wave 6 cutover (`OWNER_HANDOFFS`, until Contracts says so).
- Every change emits `network.module.updated` through `network_event_outbox` (relayed to OpenVibe.Events
  when `OV_EVENTS_INTERNAL_URL` is set; rows wait there otherwise). The payload names the owner subject,
  namespace, schema version, revision, change, reason and the changed keys; values only for fields the
  namespace declares public. Revisions only grow for a (person, namespace), deletes included.
- Accounts: `onSubjectRemoved` / `onSubjectMerged` delete or re-key a subject's records with events; triggers
  refuse deleting a `users`/`anon_users` row, or changing its `subject_id`, while records remain.
- Owning service retired (its manifest `status: retired`): the namespace turns read-only;
  `delete-after-retention` namespaces are emptied `retentionDays` after Network first saw it (daily sweep).

---

## Platform blocks

A person blocks someone once, on the network, and every product honours it (roadmap WS-E task 5,
Contracts 0.49.0; `server/identity/blocks.js`). `user_blocks` is keyed by subjects, one row per
(blocker, blocked) with `active` and a per-pair `revision` that grows on every change.

- People: `GET /api/v1/me/blocks` (who I blocked, with names and avatars), `PUT|DELETE /api/v1/me/blocks/:subjectOrUsername`.
  Nobody blocks themselves; guests neither block nor are blocked. Staff can be blocked, but a block never hides a
  staff action. The account page (Security → Blocked people) lists blocks with unblock buttons.
- Services: `GET /internal/blocks?subject=usr_…` → `{ subject, blocks, blocked_by }`, service token with
  `network.blocks.read` only (Chat and Community hold it by default; never the shared key).
- Every change writes `network.block.changed` into `network_event_outbox` in the same transaction. Chat
  (DMs, mentions) and Community (replies) keep projections from their own Events subscriptions.
- Network's notifications: nothing is created from a person the recipient blocked (`sender_id` as a Network
  id, or `actor_subject`); moderation, system and admin notices always are.
- Import (once, from Chat's `dm_blocks` export): `node scripts/import-blocks.js --file <json>` (dry run),
  then `--apply`. Pairs Network already knows are left alone.

---

## Follow graph (ADR-030)

Network owns follows, keyed by subjects (`server/identity/follows.js`; roadmap WS-E task 4, Contracts 0.65.0).
A target is a Live channel today (`channel`, named by its owner's subject), and other kinds join as products need them.

- **Public:** `GET /api/v1/follows/:type/:target` gives the follower count, and for a signed-in caller whether
  they follow and how they are notified.
- **People:** `GET /api/v1/me/follows` lists what the caller follows. `PUT|DELETE /api/v1/me/follows/:type/:target`
  follow and unfollow (`:target` is a subject or a username). Both are idempotent, and the PUT body can carry
  `{ notify_email, notify_push }`.
- **Who follows a target:** `GET /api/v1/follows/:type/:target/followers` is open to the target's owner, and to
  services with `network.follows.read` (service token only). Lists are never public.
- **Events:** every change writes `network.follow.created` or `network.follow.deleted` (subject visibility,
  growing per-pair revision) to the outbox in the same transaction. Live keeps a projection from them.
- **Products writing for a person** (ADR-030 step 4): `PUT|DELETE /internal/follows/:type/:target` needs
  `network.follows.write`, a service token and `network.follow-write-request@1`. It is granted to Live, whose
  buttons use it.
- **Go-live source:** go-live notifications read the followers here, and only here (plan T2); there is no
  switch back to Live.
- **Backfill from Live:** follows made on Live while Live's own `FOLLOWS_AUTHORITY` was unset never reached
  Network. `npm run follows-import -- --live-db /opt/openvibe.live/data/live.db` reads Live's `follows` and
  `linked_accounts` read-only and prints what it would import (dry run); add `--apply` to import in one
  transaction (no events, no notifications). A pair whose side has no subject is held in
  `follow_import_holds`; a pair Network already has, followed or unfollowed, is left alone. Safe to re-run;
  a later run imports newly mapped pairs and clears their holds. Both scripts use `DATABASE_URL` and never
  migrate or seed.
- **Cutover order:** Keep Live's direct `POST /internal/events/stream-live` enabled and leave
  `NETWORK_GO_LIVE_FOLLOWS_READY` unset. Pause Live follow writes, then run
  `npm run follows-import -- --live-db /opt/openvibe.live/data/live.db --reconcile` to preview the
  final Live snapshot and rerun with `--reconcile --apply`. Reconciliation deactivates Live-sourced
  active Network pairs missing from the snapshot, without emitting follow events or notifications;
  it preserves Network-sourced pairs and earlier Network unfollows. Check `npm run follows-preflight`
  and resolve holds before proceeding. Set Live's `FOLLOWS_AUTHORITY=network` and restart Live while
  writes are paused; verify a follow and unfollow reach Network, then resume Live writes. Only then
  set `NETWORK_GO_LIVE_FOLLOWS_READY=1` in Network's environment and restart Network. Keep Live's
  direct call enabled until Network's `live.stream.started` outcome logs show delivery.
- **Preflight:** `npm run follows-preflight` prints, read-only and counts only, the active follows (with
  their channels and followers), the unfollowed rows and the unresolved `follow_import_holds` by reason.

## Multi-Account Switching

Google-style account management supporting up to 5 accounts:

- Accounts stored client-side in `localStorage` (`openvibe_accounts`)
- Server tracks active sessions via `user_sessions` table
- Switch accounts instantly without re-authentication
- Includes anonymous mode as a switchable identity
- Shared `account-switcher.js` component renders the switcher UI on all services

### API

- `GET /api/auth/sessions` — list active sessions
- `POST /api/auth/sessions` — create session record
- `DELETE /api/auth/sessions/:id` — revoke single session
- `DELETE /api/auth/sessions` — revoke all sessions

---

## OAuth2 Flow

1. Service redirects user to `https://openvibe.network/oauth/authorize?client_id=...&redirect_uri=...`
2. If user has `ov_token` cookie → issue authorization code → redirect to service
3. If no cookie → redirect to `openvibe.network` → user signs in → cookie set → resume flow
4. Service exchanges code for access + refresh tokens via `POST /token`
5. Access tokens are RS256 JWT (24h) verified by any service with the public key
6. Refresh tokens rotate on use (30d)

---

## Observability and status

- `GET /api/ready`: named checks from `openvibe-shared/ready`, each with `status`, `required`,
  `latency_ms` and `checked_at`. `db` and `signing_key` are required (`signing_key` means an RS256
  keypair that signs and verifies a probe token; it is only optional outside production).
  `registry_poll` and `discord_bot` are optional. The answer is 503 only when a required check fails.
  Otherwise it is 200, with `status: "degraded"` when an optional check has failed.
- `GET /metrics`: Prometheus text for direct loopback callers only. Any proxied request gets a 404,
  and `deploy/nginx` blocks the path too. Besides the HTTP golden signals by route template, it
  exports process metrics, `release_info` and `release_client_updates_total{outcome,reason}` (what
  open tabs report to `POST /release-metrics`). Network's own counters are
  `network_tokens_issued_total{grant_type}`, `network_token_failures_total{grant_type,error}` and
  `network_principal_token_failures_total{code}`.
- Universal telemetry: requests are aggregated per `route|method|status_class` into a single
  `platform.telemetry-sample@1` per key per flush (count, sum, max and p95 in `extra`, mean in
  `latency_ms`), plus the HTTP autoscaling gauges (active requests, p95, event-loop lag) once per flush;
  health, readiness, metrics, chrome and static/shared assets are skipped. Buffered by
  `openvibe-sdk/telemetry` and written into the analytics store (`server/telemetry.js`,
  `server/observability.js`); `gracefulStop` flushes it once at shutdown.
- `GET /release.json` is Network's release manifest (ADR-016, `registry.release-manifest@1`, from
  `openvibe-shared/release`'s `release.mount`): the deployed commit, the library versions and, since
  openvibe-contracts 0.32.0, the 1.1.0 fields. No components are declared, so every release still
  prompts open tabs to reload.
- `GET /status` is the operator page: server-rendered, no JavaScript needed, `noindex`.
  `GET /api/v1/status` returns the same data as JSON. Each OpenVibe service shows as up, degraded,
  down, not running (placeholder or no runtime) or unknown, with its release, boot time and
  `checked_at`. The data comes from the ecosystem registry poll (`server/registry/ecosystem.js`),
  which reads each service's readiness endpoint and `/release.json` about once a minute. A service
  not checked yet, or whose last check is more than three intervals old, shows as unknown.
- Where each service can be reached is Network's exposure overlay (`server/registry/exposure.js`), not
  the manifest's maturity label: `live` (its public domain serves it), `internal` (loopback only, the
  domain still serves a placeholder page), `library` (released package), `repository` (code with CI,
  nothing to run) or `placeholder` (planned). The registry adds `exposure` to each service, the
  descriptor gives an `origin` only to `live` services (`planned_origin` otherwise), `/status` reads
  "up (loopback only)" for an internal service, and the Frame's nav lists only `live` sites. Change a
  row when a domain stops serving its placeholder; `test/registry-exposure.test.js` pins the states.
- The registry also answers `GET /api/v1/registry/topics` (every event type from the manifests'
  `eventsProduced`/`eventsConsumed` and the payload contracts, with producers, consumers, the matching
  consumer pattern and the payload contract; filters `service`, `producer`, `consumer`, `prefix`),
  `/topics/:topic`, `/releases` (each running service's `/release.json` from the same loopback poll,
  with its installed openvibe-contracts/sdk/shared versions and drift against the libraries' current
  releases), `/health` and `/search?q=`. A type a service's code publishes before its manifest lists
  it is added from `server/registry/topics.js` OBSERVED (marked `observed` on the service; empty since
  openvibe-contracts 0.32.0 lists Live's, Media's and Network's), and Network's consumed topics come
  from its own Events consumer.
  Payload schemas are served at their `$id` (`/contracts/events/payloads/<type>.v1.json`).
- `GET /api/v1/registry/categories[/:id]` groups every service by what it is, each with its rule:
  `site` (in the network's site list, `server/frame/sites.js`), `platform` (runs, but other services call
  it), `library`, `repository`, `planned`. `GET /api/v1/registry/featured` lists the open sites whose last
  check was up or degraded, in the navigation's usage order (7-day page views plus 14-day signed-in
  history, recounted every 30 minutes), with `ranked_at` and `stale`; the hub is not listed and nothing
  is featured by hand.
- Loopback addresses for the health poll: the built-in ports in `server/registry/ecosystem.js`, each
  overridable by `OV_<ID>_INTERNAL_URL` (loopback URLs only; anything else is ignored and logged). Site
  hosts come from each manifest's `publicOrigin`.
- `node scripts/contracts-drift.js` warns about services that pin an older openvibe-contracts than
  the latest tag, or a tag that was never published (`--dir ~/OpenVibers` for local checkouts,
  `--registry https://openvibe.network` for what is running, `--package all` for sdk and shared too).
  It exits 0 unless `--strict`; CI runs it as a warning-only step.
- `GET /api/v1/status/slo` returns the proposed SLO categories, as does
  [docs/slo.md](docs/slo.md) / [docs/slo.json](docs/slo.json).

## Analytics (ADR-021)

**Creator analytics** (roadmap WS-E task 6, Contracts 0.68.0; `server/analytics/creators.js`) are built from
events, not from Live's tables. Every `live.stream.ended` becomes one `creator_streams` row, with the stream's
totals from the event's `stats`: counts only, never who watched or chatted, and kept 400 days.
`GET /api/v1/creators/:creator/analytics?days=` shows everyone streams, minutes and peak viewers. The creator,
and services with `network.analytics.creator.read` (Live's dashboards), also get average viewers, chatters,
messages and watch minutes.

Network records one row per finished request in the `analytics_*` tables of its PostgreSQL database and rolls
them up hourly and daily for the admin analytics pages (`/api/admin/analytics`, which also gathers
Live, Tools, Games and Media). What a raw row may carry is bound by ADR-021 (OpenVibe.Contracts
`docs/adr/ADR-021-analytics.md`). The module is `openvibe-shared/analytics` (the same one Live and Tools
use), on the service database through its PostgreSQL tracker (`AnalyticsTrackerPg`). `server/analytics/network.js`
holds only Network's wiring: its path options (`paramPrefixes`, `pathRules`) and the prune job.

- **Stored:** event type, service, **route template** (the matched Express route, else the path
  without its query and with ids, usernames and tokens replaced by `:id` / `:param`), method, status,
  response time, a **rotating session id**, country (CDN header), **user-agent class**
  (`chrome/windows/desktop`, `bot:curl`), referer **origin** only, bot flags, a signed-in flag.
- **Never stored:** IP address, user or subject id, city, the user-agent string, full referer URLs.
  The `ip`, `user_id` and `city` columns stay for compatibility and are always NULL. Per-IP counters
  for the bot rate check live in memory only. Unique visitors come from a daily-salted hash kept only
  until that day's final rollup. "New vs returning visitors" is no longer measured.
- **Opt-out:** a request with `Sec-GPC: 1` or `DNT: 1` is not recorded at all (no raw row, visitor
  hash, session id or rate counter), so it is also missing from the rollups.
- **Admin panel:** the bot tables list user-agent classes and high-volume session ids, not IPs.
- **Connection:** the tracker buffers and flushes into the service's own PostgreSQL handle (the same
  database the identity tables live in), so there is no second connection or file of its own.
- **Retention:** raw events older than 30 days are deleted every night in batches of 5000 (the
  `analytics-prune` job: first run 5 minutes after boot, then every 24 h). Rollups are kept.
- **Operator CLI:** `scripts/analytics-prune.js` (over `openvibe-shared/analytics/pg`'s
  `pruneRawEventsPg`) runs a dry run by default and changes nothing; `--apply` deletes raw events older
  than `--days` (1..30, default 30). Run it where Network runs, with `DATABASE_URL` set. The SQLite
  prune CLI (online backup, VACUUM, one-time scrub) is gone with the file.

## Shared Client Libraries

The `openvibe-shared` package ([OpenVibers/OpenVibe.Shared](https://github.com/OpenVibers/OpenVibe.Shared), pinned in package.json) provides drop-in vanilla JS components served at `/shared/` (and `/shared/v1/`). Only the package's browser files are served; a `?v=` equal to a file's content hash is cached for a year, anything else for five minutes:

| File | Purpose |
|------|---------|
| `navbar.js` | Universal top bar with service links, notification bell mount, user dropdown |
| `nav-icons.js` | Navbar glyphs, loaded by navbar.js |
| `notification-ui.js` | Toast popups, bell badge, notification panel with category tabs |
| `account-switcher.js` | Multi-account switcher panel with anonymous mode |
| `user-card.js` | Right-click context menu + user profile card with name effects |
| `notifications.js` | Shared constants (priorities, categories, types) — also used server-side |

Include them in any service page:
```html
<script src="https://openvibe.network/shared/navbar.js"></script>
<script src="https://openvibe.network/shared/notification-ui.js"></script>
<script src="https://openvibe.network/shared/account-switcher.js"></script>
<script src="https://openvibe.network/shared/user-card.js"></script>
```

---

## Admin Panel

Accessible to users with `role = 'admin'`. All endpoints under `/api/admin/`.

| Endpoint | Description |
|----------|-------------|
| `GET /api/admin/email` | Email configuration status |
| `PUT /api/admin/email` | Update API key and email settings |
| `POST /api/admin/email/test` | Send test email |
| `GET /api/admin/settings` | All site settings (secrets masked) |
| `PUT /api/admin/settings` | Update site settings |
| `PUT /api/admin/users/:id/role` | Change user role |
| `PUT /api/admin/users/:id/ban` | Ban/unban user (sends notification) |
| `POST /api/admin/broadcast` | Send notification to all non-banned users |
| `GET /api/admin/health` | System health (counts, memory, uptime, email status) |
| `GET /api/admin/audit` | Audit log |

---

## Connected Services

| Service | Port | OAuth Client ID |
|---------|------|-----------------|
| OpenVibe.Live | 3000 | `live` |
| OpenVibe.Tools | 4001 | `tools` |
| OpenVibe.Games | 8000 | `games` |
| OpenVibe.Media | 4100 | `media` |

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `users` | Accounts (username, email, password hash, role, bio, effects) |
| `oauth_clients` | Registered OAuth2 applications |
| `oauth_codes` | Authorization codes (5-min TTL) |
| `refresh_tokens` | Rotating refresh tokens (30-day) |
| `linked_accounts` | Connected external service accounts |
| `themes` | Theme catalog entries |
| `user_theme_prefs` | Per-user theme selections |
| `site_settings` | Key-value admin settings (email config, etc.) |
| `audit_log` | Admin action audit trail |
| `notifications` | All user notifications (UUID PK) |
| `notification_preferences` | Per-user category preferences |
| `anon_users` | Anonymous user identities |
| `user_sessions` | Active session tracking for multi-account |
| `user_effects` | Equipped name/particle effects |
| `follows` | User follow relationships |
| `wallets` | OpenCoins balance per Network user |
| `coin_transactions` | OpenCoins ledger (idempotency-key deduped) |
| `dev_projects`, `dev_project_members` | Developer projects and member roles |
| `dev_apps`, `dev_credentials`, `dev_auth_codes` | Developer apps, hashed client secrets, app authorization codes |
| `dev_grants`, `dev_quotas` | App capability grants; per-project quotas (enforced by the owning service) |
| `dev_audit` | Append-only developer audit; rows that are platform events carry an event envelope |
| `dev_usage_windows`, `dev_usage_daily`, `dev_usage_errors` | Developer projects' usage from the services' hourly rollups (35 days), per day (400 days), sampled failures (30 days) |
| `analytics_events`, `analytics_hourly`, `analytics_daily` | Request analytics (raw ≤ 30 days) and rollups, within ADR-021; see [Analytics](#analytics-adr-021) |
| `user_modules`, `user_module_revisions`, `user_module_retirements` | User-module records, the last revision issued per (subject, namespace), retired namespace owners |
| `network_event_outbox` | Network's events on their way to OpenVibe.Events (developer projects, user modules, blocks) |
| `user_blocks` | Platform blocks by subject (blocker, blocked, active, per-pair revision) |
| `user_follows` | The follow graph by subject (follower, target type and id, active, notify flags, per-pair revision, source) |
| `follow_import_holds` | Imported follows held because a side had no subject (ADR-030 step 2) |
| `analytics_visitor_days`, `analytics_day_salts` | The current day's salted visitor hashes and salt, deleted after the day's final rollup |

---

## Acceptance

`npm test` runs the 74 test files listed in `package.json` (temp databases, no network). They
cover OAuth with PKCE, OIDC discovery, refresh-token rotation and reuse, SSO and FedCM, subjects,
principals and grants, account merge, export and deletion, developer projects, export tokens and usage,
user modules, blocks, follows and their authority switch, analytics privacy, the registry and its
exposure, notifications and events, status and incidents, operator alerts, per-actor limits, and the
security suites (`security-session`, `security-redirects`, `security-secrets`, `security-private`,
`security-idor`, `security-ssrf`), plus the deploy wrapper.

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). The rules the code keeps:

- **Tokens.** Network signs every token with its RS256 key (`JWT_PRIVATE_KEY` or `data/keys`); refresh
  tokens are stored as SHA-256 and a reused one revokes its family; `token_valid_after` cutoffs are
  published so services refuse older tokens; client secrets are stored hashed and shown once.
- **Redirects.** Post-sign-in targets (`/login?return=`, `/sso/fanout?next=`) never run `javascript:`
  URLs or leave for a host OpenVibe does not own (`test/security-redirects.test.js`); OAuth redirects
  must be one of the client's registered URIs.
- **Private data.** Analytics keep no personal data beyond a day's salted hash; account export and
  deletion follow ADR-033; the internal routes take a capability-scoped service token only (the shared
  internal key was retired in plan T2).
- **CORS.** Only discovery and the registry are open to any origin; every other route uses the
  first-party allow-list.
- **Secrets.** Provider secrets come from the environment first, never printed; `SETUP_TOKEN`,
  `ADMIN_PASSWORD`, `NETWORK_EVENTS_SECRET`, the webhook secrets and `GITHUB_TOKEN` live in
  `/etc/openvibe/network.env` (0600), by name only.

## License

Same as the parent [OpenVibe](../LICENSE) project.

<!-- versions:start -->
- openvibe-contracts: v0.113.0
- openvibe-sdk: v0.35.1
- openvibe-shared: v2.13.2
<!-- versions:end -->
