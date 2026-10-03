# T2 cutover: closeout evidence

What the read-only interfaces can actually prove about the OpenVibe.Network PostgreSQL cutover (plan T2,
ADR-035; procedure in [cutover-t2-postgres.md](cutover-t2-postgres.md)). Checked **2026-10-03 (UTC, host
clock)** through `ov access run openvibe-ovh <action>` — `health`, `service-status`, `releases`, `plan`,
`validate`, `env-names`, `env-set`, `show`, `journal`, `certs`. Every result below is a literal output of one
of those actions or of a read-only Git query on this checkout.

Nothing here was deployed, restarted, rolled back or imported; no credential, URL or env **value** was read or
printed; no check that needs one was guessed. Checks that need an interface the broker does not expose are
marked **pending** in their own section.

SHAs are printed as `ovhost` reports them (12 hex characters).

## Release and readiness — verified

- `health network` (exit 0): `network  bad7b106fda0 ready  openvibe-network=active`. `ovhost` needs its
  readiness probe (the service's `/api/ready`) to answer before it calls a service `ready`.
- `service-status network` (exit 0): the same line.
- `plan network` (exit 0): `network: bad7b106fda0 → bad7b106fda0 (up to date) on main`; strategy
  `git-checkout`, `0` files changed, `restart no`.
- `validate network` (exit 0): `ok checkout /opt/openvibe.network owned by ubuntu`; `ok checkout clean at
  bad7b106fda0`; `ok units openvibe-network.service active/running from
  /etc/systemd/system/openvibe-network.service`; `ok port 4000 held by node(734262)`; `ok nginx
  /etc/nginx/sites-enabled/openvibe.network.conf enabled`; `ok nginx nginx -t clean`; `ok deps every
  dependency resolves`; lifecycle `network` manifest in openvibe-contracts v0.83.0, checkout
  openvibe-contracts 0.85.0; `network: valid (0 error(s), 0 warning(s))`.

`bad7b106fda0` is origin/main HEAD (`git ls-remote origin` → `bad7b106fda07771109fdd41295ae481aa373dfb	HEAD`).

**Why this is a PostgreSQL-only release.** `bad7b106fda0` is a descendant of `206ab36`, the commit that made
production refuse a SQLite path. At that commit `server/db/database.js` throws when `NODE_ENV=production` and
`DATABASE_URL` is unset, and `server/config.js` states there is no SQLite file. Locally, `git diff --name-only
4e7b56b bad7b10` (this checkout is one commit behind) touches 26 files and none of `server/db/`,
`server/config.js` or `package.json`, so the running release has that same boot rule. A release that is
`active` and `ready` therefore booted with `DATABASE_URL` set and serves from PostgreSQL.

**Boot of the running release** (`journal openvibe-network.service`, 2026-10-03T04:37:53–04:37:59Z): the old
process stops in 5 ms, systemd starts `env[734262]`, then `[DB] Synced 35 built-in themes`,
`[Identity] subject ids: 0 users, 0 guests assigned; 3 legacy map rows seeded`, `[DB] Central database
seeded`, `[Auth] RS256 keypair loaded`, `[Email] Resend initialized`, `[Events consumer] on:
POST /internal/events`, `[push] VAPID initialized`, the banner on port 4000. There is no
`DATABASE_URL unset: embedded PGlite database` warning (the development fallback). The `journal` action clips
its answer to a recent window (the call returned about 90 lines, 02:54–04:39Z), so older boots are not
readable.

### Release history, as observed (`releases network`, from 2026-10-01)

```
2026-10-01T18:56:31.170Z  deploy   20dd7ff02e0c → 5781a6b9daf5  failed-rolled-back ovbroker lockfile
2026-10-01T18:57:19.036Z  rollback 20dd7ff02e0c → b5d870737f33  rolled-back        ovbroker
2026-10-01T19:03:06.415Z  rollback b5d870737f33 → 20dd7ff02e0c  rolled-back        ubuntu
2026-10-02T01:10:14.248Z  deploy   20dd7ff02e0c → 427e196f6276  failed-rolled-back ovbroker lockfile
2026-10-02T14:49:54.343Z  deploy   20dd7ff02e0c → 2c6b8b5eae59  failed-rolled-back ovbroker lockfile
2026-10-02T16:56:32.756Z  deploy   20dd7ff02e0c → 757dc98b1b67  deployed           ubuntu lockfile
2026-10-02T17:19:12.262Z  deploy   757dc98b1b67 → cbaacc48bd07  deployed           ovbroker
2026-10-03T00:54:33.837Z  deploy   cbaacc48bd07 → 4e7b56b2046f  deployed           ovbroker
2026-10-03T04:37:53.267Z  deploy   4e7b56b2046f → bad7b106fda0  deployed           ovbroker
```

`20dd7ff` was deployed on 2026-09-29T14:31:31Z (the runbook's "last SQLite release"). All five later SHAs are
descendants of the PostgreSQL-only `206ab36`. Three attempts ended `failed-rolled-back` (the first ran a
rollback to `b5d870737f33`, then a second rollback returned production to `20dd7ff`); the first release that
stayed up is `757dc98b1b67`. `ovhost` records no failure reason, so the runbook's unconfirmed
missing-`DATABASE_URL` explanation stays unconfirmed.

## Env presence and mode — verified

- `validate network`: `ok env /etc/openvibe/network.env mode 600`; `ok env 4 required name(s) present and
  non-empty`.
- `env-set network` (names only): file `/etc/openvibe/network.env`, `found: true`, `empty: []`. The set
  includes **`DATABASE_URL`**, **`DATABASE_DIRECT_URL`**, **`VALKEY_URL`** and `VALKEY_PREFIX`, alongside
  `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `NETWORK_EVENTS_SECRET`,
  `RESEND_API_KEY`, `VAPID_PRIVATE_KEY`, `DB_PATH`, `FOLLOWS_AUTHORITY` and the port/host/base-URL names.
  `fromUnits`: `NODE_ENV`, `PATH`.
- `env-names network`: `/opt/openvibe.network/.env.example` declares 30 names, `DATABASE_URL`,
  `DATABASE_DIRECT_URL`, `VALKEY_URL` and `DATA_DIR` among them.

`DB_PATH` and `DATA_DIR` remain declared/set but are the legacy names the PostgreSQL release no longer reads
for serving (`server/config.js`).

## Row parity — pending

The step-7 parity result for the production import cannot be established from the interfaces available.
`scripts/pg-row-parity.js` needs the SQLite source (`$COPY`) and `DATABASE_DIRECT_URL` (or `DATABASE_URL`);
no broker action exposes either, and none runs a query or lists a file. **Not checked.**

What does exist is the rehearsal: `test/pg-cutover-rehearsal.test.js` runs the whole sequence
(pg-preflight → `migrate-to-postgres.js` → row-count parity → server boot with `/api/ready` green) on a seeded
`20dd7ff` fixture, on PGlite by default and on a scratch database under `npm run test:pg`. That proves the
tools, not production's rows.

## Valkey ACL scope — pending

Only presence is provable: `VALKEY_URL` and `VALKEY_PREFIX` are set and non-empty (above). The scope of the
Valkey user — which commands it holds and that it is confined to the service's key prefix — needs a
connection to Valkey, which no read-only action opens. **Not checked.**

## Rollback copies — pending

The runbook keeps `$COPY` (`/var/backups/openvibe/network-pre-t2-<T0>.db`, `chmod 0400`) and the live
`/opt/openvibe.network/data/network.db` untouched for 30 days as the rollback and audit trail. No read-only
action lists or stats those paths: `show network` returns only the inventory entry
(`network /opt/openvibe.network units: openvibe-network.service`) and `validate network` does not cover
backups. **Not checked.**

The nearest interface, `ov access run openvibe-ovh db-backup network`, is a medium (write) action that would
take a *new* backup; it cannot prove the pre-T2 copy or its mode, so it was not run. Note also that, with the
cutover done, the previous release is PostgreSQL-only: a rollback is a code rollback and does not by itself
return serving to SQLite (see the runbook's [Rollback](cutover-t2-postgres.md#rollback) note).

## Unresolved, owner-only

- **Cause of the three rollbacks.** `releases` carries no reason and the journal is clipped to recent boots,
  so this stays unconfirmed as the runbook says.
- **Whether steps 3–7 ran**, and with what values for `$T0`, `$T1`, the `cleaned:` count and the parity
  output: not observable from any read-only action.
- **Functional checks** (runbook step 9.3–9.6: sign-in with a pre-cutover account, OAuth authorize on a
  first-party site, notifications, the OpenCoins balance against `$COPY`): need an account and a browser and
  were not run.

## Reproduce

```bash
ov access run openvibe-ovh health network
ov access run openvibe-ovh service-status network
ov access run openvibe-ovh plan network
ov access run openvibe-ovh releases network
ov access run openvibe-ovh validate network
ov access run openvibe-ovh env-set network
ov access run openvibe-ovh env-names network
ov access run openvibe-ovh show network
ov access run openvibe-ovh journal openvibe-network.service 200
```

Every one of these is a low-risk read. `health`, `releases` and `validate` are granted to `rung:*`;
`deploy`, `rollback`, `restart` and `db-backup` are not, and were not used.
