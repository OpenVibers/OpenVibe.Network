# AGENTS.md — OpenVibe.Network

## Project Overview

OpenVibe.Network is the identity and account service of the OpenVibe network and its token issuer: accounts, sessions,
anonymous identities, canonical subjects (`usr_…`/`gst_…`), OAuth2/OIDC, refresh tokens, service principals and their
grants, developer projects/apps/quotas, notifications and email, themes and per-service overrides, user modules,
platform blocks, the follow graph, presence, the Dock's state, creator analytics, the OpenCoins wallet, the machines
hub, the Locker key directory, the service registry, the status page and the network changelog proxy.

- **Domain:** `openvibe.network` · **Port:** 4000 · **Service id:** `network` · **Env prefix:** `NETWORK`/`OV_`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey 9,
  RS256 signing key (`JWT_PRIVATE_KEY` or `data/keys`), email via Resend, optional Discord/GitHub.
- **Read first:** [README.md](README.md), [docs/developer-projects.md](docs/developer-projects.md),
  [docs/sign-in.md](docs/sign-in.md), [docs/dock.md](docs/dock.md), [docs/retirement.md](docs/retirement.md),
  [docs/security/](docs/security/), [.env.example](.env.example).

**Network context:** Network is the issuer every other service trusts. It signs `svc:network` tokens for OpenVibe.Events,
OpenVibe.AI (site copy) and OpenVibe.Bot (machines). It does **not** own money (OpenVibe.Billing), a service's data
(the user-module namespace belongs to its owner), the contracts it serves (OpenVibe.Contracts) or the Frame's code
(OpenVibe.Shared). Services call its internal routes only with a capability-scoped service token; the old
deployment-wide internal key was retired on 2026-09-29.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm run dev                    # NODE_ENV=development node server/index.js, PGlite under data/pglite
npm start                      # node server/index.js
npm test                       # every test/*.test.js on temp databases, no network
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- oauth              # only test files whose name contains the word
npm run reset-db               # node server/reset-db.js (development)
npm run grant-admin            # node server/grant-admin.js
node --check <file.js>         # syntax check (no linter configured)
```

No build step for the server. Public pages are plain HTML/JS under [public/](public/) (`index.html`, `login.html`,
`my.html`, `admin.html`, `wallet.html`, `pay.html`, assets and the brand). Production refuses to boot without
PostgreSQL settings.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — Express app, CORS, migrations, service/route init and periodic tasks;
  `openvibe-network.socket` keeps connections queued across restarts.
- **Config:** [server/config.js](server/config.js) — port 4000, JWT/DB/OAuth/connected services; production
  `/etc/openvibe/network.env`. Only variable names appear in code/docs.
- **Auth/OAuth/OIDC:** [server/auth/](server/auth/) — `routes.js` (register, login, profile, anon, multi-account,
  follows), `oauth-routes.js` (authorize, token), `oidc.js` (discovery, id_token, userinfo), `refresh-tokens.js`
  (SHA-256, rotating families), `session.js`, `fedcm.js`, `passkeys.js`, `mfa.js`, `qr-signin.js`, `sso-*.js`,
  `revocation.js`, `reauth.js`, `staff-claims.js`.
- **Identity/grants:** [server/identity/](server/identity/) — `principals.js` (seeded grants), `internal-routes.js`,
  `account-data.js`, `emails.js`, `follows.js`, `blocks.js`, `adult.js`, `friends.js`, `grants-admin.js`,
  `account-aliases.js`.
- **Developer platform:** [server/developer/](server/developer/) — projects, members, apps, credentials, grants,
  quotas, usage, audit; [docs/developer-projects.md](docs/developer-projects.md).
- **Notifications:** [server/notifications/](server/notifications/) + [server/push/](server/push/) — CRUD,
  preferences, quiet hours/digests, email queue, cross-service push, action center; [server/actions/](server/actions/).
- **Themes/modules/dock/presence:** [server/themes/](server/themes/); user modules in
  [server/identity/modules.js](server/identity/modules.js) and [server/identity/module-events.js](server/identity/module-events.js);
  the Dock in [server/dock/](server/dock/), presence in [server/presence/](server/presence/), the home/menu feeds in
  [server/home/](server/home/), [server/home-screen/](server/home-screen/), [server/menu-feeds/](server/menu-feeds/).
- **Wallet/money:** [server/coins/](server/coins/), [server/wallet/](server/wallet/), [server/money/](server/money/) —
  balance, history, and the idempotent `internal/coins/*` credit/debit/transfer.
- **Machines/Locker/Connect:** [server/registry/machines.js](server/registry/machines.js),
  [server/bot/](server/bot/), [server/link/](server/link/), [server/locker/](server/locker/),
  [server/connect/](server/connect/), [server/consent/](server/consent/), [server/qr-signin/](server/qr-signin/).
- **Analytics/profile/status/registry:** [server/analytics/](server/analytics/), [server/profile/public.js](server/profile/public.js),
  [server/status/](server/status/), [server/registry/](server/registry/), [server/seo/](server/seo/),
  [server/operator/](server/operator/), [server/history/](server/history/), [server/levels/](server/levels/).
- **Admin/setup:** [server/admin/routes.js](server/admin/routes.js), [server/admin/setup.js](server/admin/setup.js),
  [server/admin/ai-config-proxy.js](server/admin/ai-config-proxy.js); public [public/admin.html](public/admin.html).
- **Database:** [server/db/](server/db/) and [migrations/](migrations/) (73 migrations; every table in the README's
  Database Tables section is real): `users`, `oauth_clients`, `oauth_codes`, `refresh_tokens`, `anon_users`,
  `user_sessions`, `themes`, `user_theme_prefs`, `site_settings`, `audit_log`, `notifications`,
  `notification_preferences`, `follows`, `wallets`, `coin_transactions`, `dev_*`, `analytics_*`, `user_modules*`,
  `network_event_outbox`, `user_blocks`, `user_follows`, `locker_keys*`, etc.
- **Deploy:** [deploy/systemd/openvibe-network.service](deploy/systemd/openvibe-network.service) (+ socket/drop-in),
  [deploy/scripts/deploy.sh](deploy/scripts/deploy.sh) runs `ovhost deploy network --install-units`; `sudo
  /opt/openvibe.network/deploy/scripts/deploy.sh` (fast-forward, install on lockfile change, restart, `/api/ready`
  poll, automatic rollback). Database `ov_network`; nginx in [deploy/nginx/](deploy/nginx/).

## Ownership and Boundaries

Network owns accounts, sessions, anonymous identities, canonical subjects and aliases, the OAuth clients/codes,
refresh-token families, signing keys/JWKS, service principals and grants, mod principals, developer projects/apps/
credentials/grants/quotas/usage/audit, notifications/email, themes/preferences, user modules and their revisions,
platform blocks, the follow graph, creator analytics, presence, Dock state, the OpenCoins wallet/ledger, the machines
hub, the Locker key directory (public keys and wrapped backups, opaque), the registry/status/changelog proxy and the
public profile. It does **not** own money (Billing), streams/channel points (Live), any service's own rows, the
contracts (Contracts) or the Frame (Shared).

## Auth and Capabilities

- Network is the issuer: RS256 tokens signed with its key, JWKS published, `token_valid_after` cutoffs so services
  refuse older tokens. Refresh tokens are stored as SHA-256, rotate as a new generation of one `family_id`, and a
  reused token (after a 10-second two-tab grace) revokes the family and audits `oauth_refresh_reuse`.
- OIDC: discovery at `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`; scope
  `openid` adds an RS256 `id_token` (aud = client, nonce echoed, `sub` = Network id, `subject_id` = `usr_…`);
  `/oauth/userinfo` returns the same.
- Capabilities (audience `openvibe.network`): `identity.subject.resolve`, `mods.grant.manage`,
  `network.account.deletion.confirm`, `network.account.export.contribute`, `network.analytics.creator.read`,
  `network.blocks.read`, `network.coins.credit|debit|transfer`, `network.follows.read|write`,
  `network.presence.read`, `network.integration.github.read`, `network.modules.read|write`,
  `network.notifications.push`, `network.operator.alert`, `network.project.manage|read`, `network.secret.use`,
  `network.staff.read`, `network.status.incident`; the hub's `network.machines.read|manage`. Grants other services
  hold are seeded in [server/identity/principals.js](server/identity/principals.js).
- CORS: only discovery and the registry answer any origin (`Access-Control-Allow-Origin: *`, preflight included);
  every other route keeps the first-party allow-list ([server/public-cors.js](server/public-cors.js)).
- Staff roles are claim-based (`admin`, `global_mod`, …); the admin panel/API gates on them. Never trust a role from a
  request body; never accept a typed token where a session is required.
- Redirects after sign-in (`/login?return=`, `/sso/fanout?next=`) never run `javascript:` or leave an owned host;
  OAuth redirects must be one of the client's registered URIs.
- Errors are structured; internal routes take a capability-scoped service token only. The shared internal key is
  retired — do not reintroduce it.

## API and Pages

Pages: `/` (landing), `/login`, `/my` (account), `/@<username>` (public profile), `/wallet`, `/pay`, `/admin`
(+ `#setup`, `#glossary`), `/admin/review`, `/status`, `/connect`, and the shared Frame/legal pages.
API: `/api/auth/*`, `/oauth/*`, `/.well-known/*`, `/api/v1/{subjects,profiles,registry,projects,machines,presence,
coins,themes,modules,blocks,follows,notifications,dock,agent-keys,...}`, `/internal/*` (capability tokens),
`/contracts/*.json`, `/shared/*`, `/api/health`, `/api/ready`, `/release.json`, `/metrics`.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter. Async routes through
  [server/async-routes.js](server/async-routes.js).
- New schema = a new `migrations/NNNN_name.sql`; never edit one that has run. Services' rows are keyed by canonical
  `usr_…`; an alias resolves to the canonical subject.
- Session/auth changes are security changes: add a test in the matching security suite, not only the happy path.
- Public responses carry explicit fields; never return a password hash, a refresh token, a client secret or another
  person's email. A hidden profile shows only name and picture and is not indexed.
- Analytics keep no personal data beyond a day's salted hash; each day's visitor salts are deleted after the rollup.
- Notification events and the outbox are written in the change's transaction; a replay is one row.
- CSP/first-paint: public pages are server-served HTML; no Font Awesome; phone first; "Calm reduces, only Off
  removes".
- Provider secrets come from the environment first and are never printed; only names appear in docs.
- Admin/setup changes: the owner settings proxy writes a key once (fresh sign-in, the service's vault, audit, alert)
  and never shows it again.

## Key Pitfalls

- **Refresh-token reuse revokes the family.** Keep the 10-second grace and the hashed storage; never log or return a
  refresh token. A raw pre-change row is hashed on first use.
- **Redirects and CORS:** a post-login target must be owned and http(s); a wildcard belongs only to discovery/registry.
  Cross-site cookie writes must be refused; a Bearer is not a session.
- **Subjects:** `GET /api/auth/me` returns only the caller's own `subject_id`; an account without one gets it minted
  on first call. Other services ask via `identity.subject.resolve`.
- **Account export/deletion (ADR-033):** every row type is in the export, and deletion sweeps every namespace,
  including Locker keys, presence, Dock, modules, blocks, follows, analytics and outbox receipts; a redelivery changes
  nothing. Account deletion needs re-authentication.
- **Coins:** the wallet ledger is idempotent by key; OpenCoins are loyalty points, never money or Vibes. Never debit
  without an idempotency key.
- **Analytics privacy:** a raw event may be kept ≤30 days; a visitor is a day-salted hash only; no IP/user-agent in a
  rollup.
- **Machines:** pairing and choosing roles require the person's own session; a token acting for the person may only
  read/rename/revoke. Bot is the registry underneath.
- **Deploy blockers:** an older release starts with empty `frame_cache`/`frame_hits` (renamed from `chrome_*`), and
  does not know `tool_domains` mirror rows. Record the rollback target with that in mind.
- **Socket activation:** requests wait for the new process; do not replace the socket unit with a plain listen.

## Testing

`npm test` runs the files in [test/](test/) on temp databases with no network. They cover OAuth/PKCE, OIDC discovery,
refresh rotation/reuse, SSO/FedCM, subjects/principals/grants, export/deletion, developer projects/apps/usage, user
modules, blocks, follows, analytics privacy, the registry/exposure, notifications/events, status/incidents, operator
alerts, actor limits, machines, presence, Dock, Locker keys, Connect, consent, QR sign-in, levels, the admin panel and
the security suites (`security-session`, `security-redirects`, `security-secrets`, `security-private`,
`security-idor`, `security-ssrf`), plus the deploy wrapper. `npm run test:pg` for PostgreSQL. Run the narrowest file
first, then the suite; always `node --check` changed files.

## Documentation

- [README.md](README.md) — purpose, what it does, account ID, owns/does-not-own, capabilities, architecture, setup,
  deploying, TLS, notifications, Dock, email, provider/project secrets, anonymous users, user modules, blocks,
  follows, multi-account, OAuth2, observability, analytics, client libraries, admin panel, connected services,
  database tables, acceptance, security, sharing.
- [docs/developer-projects.md](docs/developer-projects.md), [docs/sign-in.md](docs/sign-in.md), [docs/dock.md](docs/dock.md),
  [docs/retirement.md](docs/retirement.md), [docs/security/authenticator.md](docs/security/authenticator.md),
  [docs/security/passkeys.md](docs/security/passkeys.md), [docs/slo.md](docs/slo.md),
  [docs/platform-plan.md](docs/platform-plan.md), [docs/capabilities-proposal/](docs/capabilities-proposal/).
- [SECURITY.md](SECURITY.md), [.env.example](.env.example).
