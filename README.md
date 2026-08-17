# OpenVibe.Network

Identity and account service for the OpenVibe network. Manages user accounts, OAuth2 authorization, theme preferences, notifications, email alerts, anonymous identities, the network-wide OpenCoins wallet, and internal APIs that connect all OpenVibe services together.

**Part of the [OpenVibe](../ARCHITECTURE.md)** — `https://openvibe.network`

---

## What it does

- **SSO Identity Provider** — "One Account. All of OpenVibe." Central registration and login, OAuth2 Authorization Code flow for OpenVibe.Live, OpenVibe.Tools, OpenVibe.Games, and OpenVibe.Media.
- **Unified Notification System** — Cross-service notifications with priority levels, category filtering, toast popups, bell badge, sounds, and rich content (buttons, inputs, media). All services push notifications to the central API; clients poll every 15 seconds.
- **Email Alerts** — Critical notifications (moderation actions, system alerts) can be delivered by the built-in email service. Configuration is managed through the admin panel.
- **Anonymous Users** — Browse and interact without an account. Anon users receive a unique number, can accumulate stats, and optionally link to a registered account later.
- **Multi-Account Switching** — Google-style account management. Users can add multiple accounts and switch instantly, including an anonymous mode.
- **Theme Catalog** — Shared theme system with ~30 built-in themes and community submissions. Theme preferences sync across all services.
- **Admin Panel** — email configuration, user management (role changes, bans), broadcast notifications, system health dashboard, and audit log.
- **Internal API** — Server-to-server endpoints for token verification, user lookup, notification push, account linking, and audit logging. Protected by `X-Internal-Key`.
- **OpenCoins Wallet** — Network-wide currency. User balance/history at `/api/coins/*`; atomic credit/debit/transfer for services at `/internal/coins/*` with idempotency-key dedupe.

---

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
│       └── database.js       # SQLite schema, migrations, seeding
├── public/
│   ├── index.html            # Landing page (hero + service cards)
│   ├── login.html            # Animated login/register page
│   └── my.html               # Account management (profile, sessions, notifications)
├── deploy/
│   ├── nginx/                # openvibe.network.conf
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
# Edit .env — set INTERNAL_API_KEY, ADMIN_USERNAME, ADMIN_PASSWORD, and optionally SETUP_TOKEN and BOOTSTRAP_PROFILE

# 4. Run
npm start

After the first run the service will seed the URL registry with safe defaults and create an admin account from environment values. Visit `/api/setup/status` for setup health and use `/api/setup/bootstrap` to apply registry profiles manually.
```

The server auto-creates the SQLite database and seeds OAuth2 clients on first run. Client secrets are logged to console once on creation — copy them to the consuming services' env files (`/etc/openvibe/<svc>.env`).

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
2. **openvibe.network** stores them in SQLite with priority, category, and optional rich content
3. **Clients** poll `GET /api/notifications` every 15 seconds, rendering toasts and updating the bell badge
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
  -H "X-Internal-Key: $INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": 42, "type": "new_follower", "data": {"actorName": "someone"}}'
```

---

## Email Setup

Email is optional — the notification system works without it. Email is only sent for **CRITICAL** priority notifications.

### Quick setup

1. Create a domain or sender identity at <https://resend.com/domains>.
2. Add the required SPF, DKIM, and MX records to your DNS provider.
3. Configure the Resend API key and from-addresses in the admin panel.
4. Verify your domain on Resend before sending production email.

### Admin panel configuration

Instead of `.env`, configure email at runtime via the admin panel:
- `GET /api/admin/email` — view current email config
- `PUT /api/admin/email` — update API key, default from address, and per-service from addresses
- `POST /api/admin/email/test` — send a test email

---

## Anonymous Users

Anonymous users can browse and interact without creating an account:

- Each anon user gets a unique number (e.g., "Anonymous #42")
- Stats and preferences are tracked via a session token
- Fingerprint matching reconnects returning anonymous visitors
- Anon identities can be linked to a registered account at any time, merging stats
- Multi-account switcher includes a "Continue as Anonymous" option

### API

- `POST /api/auth/anon-session` — create anonymous session
- `GET /api/auth/anon/:token` — get anon user info
- `PUT /api/auth/anon/:token/preferences` — update anon preferences
- `POST /api/auth/anon/:token/link` — link anon identity to registered account

---

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

## Shared Client Libraries

The `packages/openvibe-shared/` directory provides drop-in vanilla JS components served at `/shared/`:

| File | Purpose |
|------|---------|
| `navbar.js` | Universal top bar with service links, notification bell mount, user dropdown |
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

---

## License

Same as the parent [OpenVibe](../LICENSE) project.
