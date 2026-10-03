# T2 cutover: Network from SQLite to PostgreSQL

The production move of OpenVibe.Network from its SQLite file to PostgreSQL (plan T2, ADR-035). Every commit
after **20dd7ff** serves from PostgreSQL only: `DATABASE_URL` is required in production (there is no SQLite
path), migrations run as the owner on `DATABASE_DIRECT_URL`, and the limit counters live on Valkey
(`VALKEY_URL`).

**Observed state (read-only `ov access run openvibe-ovh`, 2026-10-03 UTC).** Production (`openvibe-ovh`) now
runs **bad7b106fda0**, a PostgreSQL-only release: `health` reports it `ready` with `openvibe-network=active`
and `validate` reports the checkout clean at that SHA. The serving code still refuses to boot in production
without `DATABASE_URL` (`server/db/database.js`), so an active, ready release is one serving from PostgreSQL.
`DATABASE_URL`, `DATABASE_DIRECT_URL` and `VALKEY_URL` are present and non-empty in
`/etc/openvibe/network.env` (mode `600`). The per-check detail, and what could not be checked, is in
[cutover-evidence-t2.md](cutover-evidence-t2.md).

**First-attempt history, kept.** Production ran **20dd7ff**, the last SQLite release, until 2026-10-02. The
deployments of the PostgreSQL-only range did not all come up: `ovhost releases network` records
`failed-rolled-back` for **5781a6b9daf5** (2026-10-01T18:56Z), **427e196f6276** (2026-10-02T01:10Z) and
**2c6b8b5eae59** (2026-10-02T14:49Z), each followed by a rollback to 20dd7ff. (This runbook first recorded two
failed attempts; the release log kept by ovhost shows three.) The first release in that range that stayed up
was **757dc98b1b67** (2026-10-02T16:56Z), then **cbaacc48bd07**, **4e7b56b2046f** and the current
**bad7b106fda0**. The leading explanation for the rollbacks — the server refused to boot without
`DATABASE_URL` (`server/db/database.js`) — was never confirmed and still is not: the journal no longer reaches
those windows, and `ovhost` records `failed-rolled-back` with no reason.

This runbook covers the data move those first deploys skipped. It was rehearsed with
`npm run rehearse-pg-cutover` (`scripts/rehearse-pg-cutover.js`) on 20dd7ff's full schema: the 51 tables
`initDb()` makes plus the 26 its modules create at boot. That rehearsal found two import blockers, fixed in
`scripts/migrate-to-postgres.js` with it:

- `analytics_rate_tracking` (openvibe-shared's old per-IP counters) has no PostgreSQL table, so the import refused
  to start. It is now in `SKIP_SOURCE`, so IPs are never carried over.
- The `users_profile_created` trigger fired on every imported account. That collided with the copied
  `user_profile_changes` rows, and would have published one profile event per account. The import now turns
  that trigger off while it copies (`QUIET_TRIGGERS`).

Every step ends with a **go / no-go** check. The steps are kept as the record of how the move was rehearsed and
run; a re-run (a rebuild, or a second environment) starts from the Prerequisites with the then-current target
SHA. At the time of the move, a no-go before step 8 (deploy) left production on SQLite with no data change:
restart the old release (`sudo systemctl start openvibe-network`), reopen, and reschedule. A no-go from step 8
on meant [rollback](#rollback).

Conventions:

- `$STAGE` is the staging checkout of the target commit (step 1).
- `$COPY` is the read-only SQLite copy (step 4).
- `$T0` is when writes stopped (step 3).
- `$T1` is when the PostgreSQL release started serving (step 8).
- Commands that need the database URLs load `/etc/openvibe/network.env` with `node --env-file`, which never
  prints it, as README.md does for `subscribe-events.js`. Never `cat`, `source -x`, `env` or `printenv` that file,
  and never paste a URL into a terminal, chat or ticket.

---

## Prerequisites (owner only, before the window)

These are done by the owner and never by an agent. Each must be true before the window opens.

1. **PostgreSQL, PgBouncer and Valkey run on openvibe-ovh.** PostgreSQL 18, with PgBouncer in transaction
   pooling mode in front of it, and Valkey. Network's database and its two roles are created by OpenVibe.Host
   `roles/data/add-service.sh network`:
   - an **owner** role that owns the schema, runs the migrations and does the import;
   - a **runtime** role with DML rights only, which serves requests through PgBouncer.
2. **The three URLs are in `/etc/openvibe/network.env`**, mode `0600`, and are never printed:
   - `DATABASE_URL`: the runtime role, through PgBouncer.
   - `DATABASE_DIRECT_URL`: the owner role, on a **direct** connection (not PgBouncer). Transaction pooling cannot
     hold the import's single transaction or the migration lock.
   - `VALKEY_URL`: the shared limit counters. Without it, each process counts on its own.

   Check them by name only. The first command must print `3`, the second `600`:

   ```bash
   sudo grep -cE '^(DATABASE_URL|DATABASE_DIRECT_URL|VALKEY_URL)=.+' /etc/openvibe/network.env
   sudo stat -c '%a' /etc/openvibe/network.env
   ```
3. **The URLs connect.** Run this from `$STAGE` (step 1). It prints three `ok` lines and never prints a URL:

   ```bash
   cd "$STAGE" && sudo node --env-file=/etc/openvibe/network.env -e '
     const { Client } = require("pg");
     (async () => {
       for (const k of ["DATABASE_URL", "DATABASE_DIRECT_URL"]) {
         const c = new Client({ connectionString: process.env[k] });
         await c.connect();
         await c.query("SELECT 1");
         await c.end();
         console.log(k, "ok");
       }
       const v = new (require("iovalkey"))(process.env.VALKEY_URL, { lazyConnect: true });
       await v.connect();
       console.log("VALKEY_URL", await v.ping() === "PONG" ? "ok" : "FAIL");
       v.disconnect();
     })().catch((e) => { console.error("FAIL", e.code || e.message.replace(/\/\/[^@]*@/, "//***@")); process.exit(1); });'
   ```
4. **A green rehearsal on a fresh production snapshot** (step 2). Only after it passes does the owner write
   `~/openvibe/agents/ds/deploy/rehearsals/network-t2-pg.json` with `{"ok": true}`. ds-finish refuses to deploy
   without that file and without the merged PR's `cutover` block.
5. **No case-fold collisions**, or each one resolved on the SQLite side (step 5 explains how). Check this at
   rehearsal time so the window does not stop on it.
6. **The window is announced.** Post a status-page maintenance (admin → Status, kind `maintenance`) at least a
   day ahead. While Network is stopped, nobody can sign in, run an OAuth authorize, or refresh a token on any
   OpenVibe site. Services verify JWTs they already have offline (cached JWKS), so signed-in pages keep working.
   Calls into Network fail until it is back: notifications, coins, follows and blocks. Expect about 15 minutes
   plus the import time that the snapshot rehearsal printed (`ms`).
7. **The target commit is fixed.** It is the merge commit of the PR carrying the `cutover` block (origin/main at
   merge). Steps 1, 2 and 8 must all use that one SHA.

---

## Step 1: stage the target release (T-1 day, no downtime)

At the time of the move, the running checkout `/opt/openvibe.network` stayed on 20dd7ff until step 8. The import
tools and migrations come from a separate checkout of the target commit. It is never served from.

```bash
TARGET=<merge sha>
STAGE=/var/tmp/network-t2-stage
sudo -u ubuntu git -C /opt/openvibe.network fetch origin
sudo -u ubuntu git clone --no-checkout /opt/openvibe.network "$STAGE"
sudo -u ubuntu git -C "$STAGE" checkout --detach "$TARGET"
cd "$STAGE" && sudo -u ubuntu npm ci    # dev dependencies too: the rehearsal's PGlite lives there
```

**Go:** `git -C "$STAGE" rev-parse HEAD` equals `$TARGET`, and
`node -e "require('better-sqlite3'); require('pg'); require('@electric-sql/pglite')"` exits 0 in `$STAGE`.
**No-go:** `npm ci` fails. Fix the host's build tools or network first.

## Step 2: rehearse on a production snapshot (T-1 day, no downtime)

Take an online copy (the service keeps running) and rehearse on it, on the host, so the data never leaves it:

```bash
SNAP=/var/backups/openvibe/network-rehearsal-$(date -u +%Y%m%dT%H%M%SZ).db
sudo -u ubuntu node -e "new (require('$STAGE/node_modules/better-sqlite3'))('/opt/openvibe.network/data/network.db', { readonly: true }).backup('$SNAP').then(() => console.log('ok'))"
cd "$STAGE" && sudo -u ubuntu node scripts/rehearse-pg-cutover.js --sqlite "$SNAP" --store pglite
```

The live file is `/opt/openvibe.network/data/network.db` unless `DB_PATH` says otherwise. A path is not a
secret, so `sudo grep '^DB_PATH=' /etc/openvibe/network.env` may be used to check it.

The rehearsal runs, in order:

1. pg-preflight;
2. `migrate-to-postgres.js --pglite`;
3. the same import into a PGlite directory;
4. the row-count parity check;
5. boots the target server on the result and requires `/api/ready` to answer 200 with `db` and `signing_key` ok.

It prints one JSON line, with counts only.

**Go:** exit 0 and `"ok":true`. The owner keeps that line and writes the `network-t2-pg` rehearsal file
(prerequisite 4).
**No-go:** read `problems` in the line.
- `preflight` collisions: see step 5.
- Import problems, for example a source table with no target or an unparseable date: fix them in the migrations
  or in `TABLES`/`SKIP_SOURCE` of `scripts/migrate-to-postgres.js` with a PR, then rehearse again.

`--store env` (only when given; the default never reads these URLs) runs the same rehearsal against a scratch
PostgreSQL database instead of PGlite. Put that database's own `DATABASE_URL`/`DATABASE_DIRECT_URL` in the
environment. The rehearsal empties its tables and refuses a target where any table holds a row (unless
`--truncate-target`), but **never** point it at the production URLs.

## Step 3: freeze writes (T0, the window opens)

```bash
sudo systemctl stop openvibe-network
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$T0"
```

**Go:** all three hold:
- `systemctl is-active openvibe-network` prints `inactive`;
- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/api/health` prints `000`;
- nothing restarts it within a minute. Check `systemctl is-active` again.

**No-go:** it comes back on its own (a watchdog or a deploy). Find what restarted it before going on. A write
made after the copy in step 4 would be lost.

## Step 4: back up, and copy the SQLite file

```bash
ov access run openvibe-ovh db-backup
COPY=/var/backups/openvibe/network-pre-t2-${T0//:/}.db
sudo -u ubuntu node -e "new (require('$STAGE/node_modules/better-sqlite3'))('/opt/openvibe.network/data/network.db', { readonly: true }).backup('$COPY').then(() => console.log('ok'))"
sudo chmod 0400 "$COPY" && sudo sha256sum "$COPY" | tee "$COPY.sha256"
sudo -u ubuntu node -e "const d = new (require('$STAGE/node_modules/better-sqlite3'))('$COPY', { readonly: true }); console.log(d.pragma('integrity_check', { simple: true }))"
```

The backup API copies the file together with its WAL. From here on, every step reads `$COPY`. The live
`data/network.db` is not opened again, and it is what a rollback serves.

**Go:** all three hold:
- `db-backup` exits 0;
- `integrity_check` prints `ok`;
- the user count of `$COPY` equals the live file's. Run this for each file:
  `node -e "…prepare('SELECT COUNT(*) n FROM users').get().n"`.

**No-go:** the backup fails or the integrity check is not `ok`. Restart the old release and investigate.

## Step 5: pg-preflight (case-fold collisions)

```bash
cd "$STAGE" && sudo -u ubuntu npm run pg-preflight -- --sqlite "$COPY"
```

The script is `scripts/pg-preflight-collisions.js` (`--sqlite <file>`, `--json`). It opens the copy read-only.

**Go:** exit 0, `no case-fold collisions: safe to import`.
**No-go:**
- **Exit 1 (collisions).** PostgreSQL keeps usernames unique on `lower(username)`, so `Alex` and `alex` cannot
  both be imported. This is a data decision, never made by a script. Restart the old release and close the
  window. For each listed pair:
  - `users.username`: ask the newer or inactive account to rename, or rename it from the old release's admin
    (users → edit username). That records the old name.
  - `verification_keys.target_username` (active keys): revoke the duplicate key in admin.
  - `username_history.old_username`: absent at 20dd7ff. The script reports `table absent`.

  Run the preflight on a fresh snapshot until it is clean, then schedule a new window.
- **Exit 2.** The file is unreadable or better-sqlite3 is missing. Fix that before going on.

## Step 6: migrate-to-postgres

The script reads these and nothing else:

| Input | Meaning |
|---|---|
| `--sqlite <file>` | The source: `$COPY`. Without it, `DB_PATH`, else `data/network.db` under the checkout. Always pass it. |
| `--pglite` | A dry run into an in-memory PostgreSQL. No URL is needed. |
| `--json` | The report as JSON. |
| `DATABASE_DIRECT_URL` | The owner, on a direct connection. Required without `--pglite`. `DATABASE_URL` is not used. |
| `.env` | Read from the working directory by dotenv. `$STAGE` has none. Keep it that way. |

```bash
cd "$STAGE"
sudo -u ubuntu node scripts/migrate-to-postgres.js --sqlite "$COPY" --pglite                      # dry run
sudo node --env-file=/etc/openvibe/network.env scripts/migrate-to-postgres.js --sqlite "$COPY"    # the import
```

The import does four things:

1. Applies `migrations/0001…0007` as the owner.
2. **Empties** every Network table and copies every table in one transaction, parents first. Ids are kept and
   sequences are moved past them. `users_profile_created` is disabled for the copy and enabled again afterwards,
   even when the copy fails. `analytics_rate_tracking` is left behind.
3. Drops a NUL or an unpaired surrogate, which PostgreSQL refuses, and reports it as `cleaned:`.
4. Verifies each table's row count and a checksum of every row.

The SQLite copy is opened read-only. Because the import empties first, it can be repeated.

**Go:** exit 0, first line `… : OK`, and no `problem:` line. A `cleaned:` line is expected and fine. Note it in
the log.
**No-go:** exit 1 or a `problem:` line. Leave the window closed, restart the old release, and fix the problem
with a PR and a new rehearsal. Nothing serves from PostgreSQL yet, so there is nothing to undo. If the process
was killed mid-import, the trigger is still off: run the import again. It ends by enabling the trigger, and
step 7 checks that it did.

## Step 7: row-count parity, per table

```bash
cd "$STAGE" && sudo node --env-file=/etc/openvibe/network.env scripts/pg-row-parity.js --sqlite "$COPY"
```

`scripts/pg-row-parity.js` reads `DATABASE_DIRECT_URL` (else `DATABASE_URL`). It compares every SQLite table:

- **SQLite** (`$COPY`, read-only): `SELECT COUNT(*) FROM "<table>"` for each table in
  `SELECT name FROM sqlite_master WHERE type = 'table'`. SQLite's own `sqlite_*` tables, FTS5 virtual tables and
  their shadow tables, and `SKIP_SOURCE` (`analytics_rate_tracking`: old per-IP counters, never carried over)
  are left out.
- **PostgreSQL**: `SELECT COUNT(*) FROM "<table>"` for the same name, in
  `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`.

PostgreSQL-only tables, new in T2, are listed and not compared. The script also requires the triggers that the
import turned off to be enabled again:
`SELECT tgenabled FROM pg_trigger WHERE tgname = 'users_profile_created'` must be `O`. Run the check **before** step 8. The new
release's boot seeds rows the SQLite file never had: built-in themes, OAuth clients and principal grants.

**Go:** exit 0, `OK`, and no `✗` row.
**No-go:** any table differs, or the trigger is reported disabled. Do not deploy. Run step 6 again; it empties first. If the same table still differs,
restart the old release and investigate.

## Step 8: deploy (T1)

```bash
ov access run openvibe-ovh deploy network
T1=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$T1"
```

ovhost fast-forwards `/opt/openvibe.network` to the target and runs `npm install --omit=dev`. It installs the unit
and starts it with `network.env`, polls `/api/ready`, and rolls back on its own if the release does not come up.
At boot, the migrations find everything applied, and the seed adds only the boot rows that are missing.

**Go:** the deploy exits 0, and its release is `$TARGET`.
**No-go:**
- **ovhost rolled back (exit 3).** At the time of the move, production was on 20dd7ff and SQLite again, and no
  write had reached PostgreSQL.
  Read `ovhost releases network` and the boot log
  (`sudo journalctl -u openvibe-network --since "$T0" | tail -50`). The log names its failure without printing
  URLs. Then close the window.
- **Any other failure.** Go to [rollback](#rollback).

## Step 9: checks

Do these within 30 minutes of T1. All must pass.

1. **Health.** `ov access run openvibe-ovh health network` reports healthy, on release `$TARGET`.
2. **Readiness.** This must print `true "ok" "ok"`:

   ```bash
   curl -s https://openvibe.network/api/ready | jq '.ready, .checks.db.status, .checks.signing_key.status'
   ```

   `status` may be `degraded` only because of optional checks (`registry_poll`, `discord_bot`).
   `failed` must be `[]`.
3. **Sign-in.** Sign in at `https://openvibe.network/login` with an account that existed before T0. That proves
   the imported password hashes. Then `GET /api/auth/me` returns the same username and subject id as before.
   A session from before T0 is still signed in: same RS256 key, imported `user_sessions`.
4. **OAuth authorize.** On a first-party site (openvibe.live, then openvibe.chat), sign out, then use "Sign in
   with OpenVibe". `/oauth/authorize` must redirect back with a code and the site must sign you in. That proves
   `oauth_clients`, the redirect URIs and token issuance. Also refresh a token on a site that was signed in
   before T0.
5. **Notifications.** `GET /api/notifications` lists the notifications from before T0, and
   `GET /api/notifications/unread-count` answers 200. Trigger a new one, for example a follow from a second
   account, and check that it arrives.
6. **OpenCoins wallet.** `GET /api/coins/me` returns the same balance that `$COPY` holds for that user. Check it
   with this, run in `$STAGE`:

   ```bash
   node -e "const d = new (require('better-sqlite3'))('$COPY', { readonly: true });
            console.log(d.prepare('SELECT w.balance FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.username = ?').get('<you>'))"
   ```

7. **Logs.** `sudo journalctl -u openvibe-network --since "$T1" -p warning` shows no database, PgBouncer or
   Valkey errors.

**Go:** all seven pass. Close the status-page maintenance. The cutover is done.
**No-go:** any check fails and cannot be fixed within the window. Go to [rollback](#rollback).

After a go, keep `$COPY` (0400) and the live `data/network.db` untouched for at least 30 days. They are the
rollback and the audit trail. `$STAGE` may be deleted.

---

## Rollback

```bash
ov access run openvibe-ovh rollback network
```

At the time of the move, this brought back the previous release, **20dd7ff**, which served from
`data/network.db` again. Nothing in this runbook writes to that file: the import read `$COPY`, and the
PostgreSQL release never opens `DB_PATH`. The file was exactly as it was at T0. The old release ignores
`DATABASE_URL`, `DATABASE_DIRECT_URL` and `VALKEY_URL`, so they stay in `network.env`. After the move
succeeded, the previous release is a PostgreSQL-only one, so a rollback is a code rollback only — it does not
by itself return serving to SQLite.

**Go (rollback worked):** at the time of the move, `ov access run openvibe-ovh health network` was healthy on
20dd7ff, and `/api/ready` answered 200. Sign-in worked.

**What is lost:** every write that reached PostgreSQL between T1 and the rollback. That includes:
- new accounts, and profile, username and password changes;
- sessions and refresh tokens issued in that time (those people sign in again);
- notifications, coin transactions and wallet balances;
- follows and blocks;
- preferences and developer projects.

Events that the PostgreSQL release already published stay published. Events treats a repeated `event_id` as a
duplicate.

**Replay or accept.** Decide before anything else is attempted. A later cutover empties PostgreSQL and imports
from a new SQLite copy, which discards these rows for good.

- **Accept** when the rollback came within the window and the list below is empty or trivial. Say so on the
  status page: "changes made between T1 and the rollback were not kept; sign in again if asked".
- **Replay** money and accounts. On PostgreSQL, as the owner (`DATABASE_DIRECT_URL`, from `$STAGE` with
  `node --env-file`, or `psql` on the host without echoing the URL), list them:

  ```sql
  SELECT id, user_id, app_id, delta, reason, ref, idempotency_key, created_at
    FROM coin_transactions WHERE created_at >= '<T1>' ORDER BY id;
  SELECT id, username, subject_id, created_at FROM users WHERE created_at >= '<T1>' ORDER BY id;
  SELECT 'notifications', COUNT(*) FROM notifications WHERE created_at >= '<T1>'
   UNION ALL SELECT 'user_follows', COUNT(*) FROM user_follows WHERE updated_at >= '<T1>'
   UNION ALL SELECT 'user_blocks', COUNT(*) FROM user_blocks WHERE updated_at >= '<T1>';
  ```

  - Re-apply each coin transaction through the old release's coins API with its **same `idempotency_key`**, so a
    second replay is a no-op. A row without a key is checked by hand against the wallet first.
  - New accounts are told to sign up again. Their PostgreSQL subject id does not exist on SQLite.
  - Follows and blocks that the person made again on the old release need nothing more.

  Keep the query output with the incident notes. It holds usernames, so it is not posted publicly.

After the rollback, read the boot log and `ovhost releases network`, fix the cause with a PR, and rehearse again
on a fresh snapshot (step 2) before a new window.
