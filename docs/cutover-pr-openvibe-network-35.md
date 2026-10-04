# Cutover runbook — OpenVibe.Network PR #35

PR #35 ("Scope the agent-grants index check to the test's own schema", merge `7b16a09`) lands slice 3 of plan T2 WS-Z2
(docs/t2-projects-and-grants.md §3, "Delegated grants and modes"): `migrations/0017_agent_grants.sql` adds the
`dev_agent_grants` table and two indexes, the grant routes in `server/developer/agents.js` (the delegation ceiling,
the cascades into `setAllowance`/`decideGrant`/`grants-admin.js`), the catalog reads for `sensitive`/`effective_mode`,
and `test/agent-grants.test.js` for the ceiling and cascades. `test/agent-schema.test.js` is updated to assert the
new migration and is given a schema-scoped `pg_indexes` query so a parallel test run cannot leak indexes into the
assertion (the original bug). The fix to `test/agent-schema.test.js` is a one-line addition of `WHERE schemaname =
current_schema()` to the existing `pg_indexes` query; it does not change behaviour.

## Why this is a data cutover

`ds/deploy-recipes.json` marks Network `risk: routine`. `ds-deploy.js:riskOf()` upgrades it to **`data`** because
`migrations/0017_agent_grants.sql` matches the gate's `DATA_RE` (`\.sql$`). The auto-finish pipeline will therefore
not deploy the merge until the PR body carries a `cutover` manifest (`{"runbook", "rehearsal"}`) and
`ds/deploy/rehearsals/<rehearsal>.json` on the harness says `{"ok": true}`. This runbook is that manifest.

## Where the data stands

The running release is **`bad7b106fda0`** (origin/main HEAD at the time of writing, PostgreSQL, `active`/`ready`,
`openvibe-network=active` per `ov access run openvibe-ovh health network`). Its boot applied the migrations through
`0016_agents.sql` (slice 2); `ov_migrations` records them and rejects re-application or edits (`node_modules/openvibe-sdk/src/db/migrate.js`,
checksum-pinned). Production's PostgreSQL is owned by the owner role, served through PgBouncer by the runtime role;
`/etc/openvibe/network.env` is `DATABASE_URL` + `DATABASE_DIRECT_URL` + `VALKEY_URL` (mode `0600`); `migrations/0001`…
`0017` apply in order under `openvibe-sdk/db`'s runner, each in `expand` mode. The only file this PR adds to that
list is `0017_agent_grants.sql`.

The new table is **`dev_agent_grants`** (one row per `(agent_id, capability)`, primary key, foreign key on
`dev_agents(id)`, two CHECK constraints on `mode`/`status`, an `audience` regex `^openvibe\.[a-z][a-z0-9-]{0,63}$`,
two indexes — `dev_agent_grants_active_idx` partial on `WHERE status = 'active'`, `dev_agent_grants_cap_idx` on
`(capability, status)`). It is empty on production before the deploy (no existing column changes, no backfill).

## Order of work

The pipeline (`ds-finish.js` deploy phase) runs these in order for a `data` risk; every one is the broker, never
SSH. The manual commands a person runs when the pipeline cannot (`manualLines(rec)`) are shown alongside each
broker action so the owner can replay them.

1. **Pre-check.** `ov access run openvibe-ovh health network`. Passes only on a line containing ` ready `
   (`openvibe-network=active` on the current SHA).
2. **Backup.** `ov access run openvibe-ovh db-backup`. This is the only pre-deploy restore point for the migration.
   The deploy itself creates the new table on a database that already has `0016` applied; a rollback (step 5)
   returns the service to the previous release, which sees the new table as empty. A restore to the pre-0017
   snapshot requires the previous release to be active and is the only path that drops the table.
3. **Deploy.** `ov access run openvibe-ovh deploy network`. The ordinary release swap. The first boot of the
   merged release runs `0017_agent_grants.sql` as the owner on `DATABASE_DIRECT_URL` (because the migration lock
   cannot sit behind PgBouncer), records it in `ov_migrations`, and continues to `/api/ready`. The runner is the
   `openvibe-sdk/db` one, the same as for every previous migration in this repo. A database that already has
   `0017` applied is a no-op (`applied` ledger row, nothing to do).
4. **Smoke.** `ov access run openvibe-ovh health network`, again ` ready ` on the new SHA, plus the in-app
   readiness checks below.
5. **Record.** `ov access run openvibe-ovh releases network` lists the new release id (the merged SHA), and
   `ov access run openvibe-ovh journal openvibe-network.service 200` shows the boot lines (one
   `migration 0017_agent_grants applied in <ms>ms`, no `migrations held`, no error).

Manual commands to run if the broker is offline (the orchestrator shows them in the card):

```bash
ov access run openvibe-ovh health network
ov access run openvibe-ovh db-backup
ov access run openvibe-ovh deploy network
ov access run openvibe-ovh health network
ov access run openvibe-ovh releases network
ov access run openvibe-ovh journal openvibe-network.service 200
```

## The backup

`ov access run openvibe-ovh db-backup` writes outside the release (the broker's backup area), not into the
repository. Keep it. Even though this migration only adds a table, a later, unrelated migration may need to be
undone, and the step-2 backup is the only restore point that knows the schema state before `0017`. It costs one
command in a pipeline that already holds the host lock.

## How the result is verified

The pipeline's smoke step is `health network`. The rest is the owner (or this runbook's manual counterpart):

1. **Health.** `ov access run openvibe-ovh health network` reports `ready` on the new release.
2. **Readiness.** `curl -s https://openvibe.network/api/ready | jq '.ready, .checks.db.status, .checks.signing_key.status'`
   prints `true "ok" "ok"`. `status` may be `degraded` only because of optional checks (`registry_poll`, `discord_bot`).
   `failed` must be `[]`.
3. **Boot log.** `ov access run openvibe-ovh journal openvibe-network.service 200` shows
   `migration 0017_agent_grants applied in <ms>ms` once, with the same SHA as `releases network`. No
   `migrations held`, no database or PgBouncer error.
4. **Ledger.** Read-only, on the host as the owner (never printing the URL):

   ```bash
   sudo node --env-file=/etc/openvibe/network.env -e '
     const { Client } = require("pg");
     (async () => {
       const c = new Client({ connectionString: process.env.DATABASE_DIRECT_URL });
       await c.connect();
       const r = await c.query(
         "SELECT id, phase, applied_at FROM ov_migrations WHERE id = ANY($1::text[]) ORDER BY id",
         [["0016", "0017"]]
       );
       console.log(JSON.stringify(r.rows, null, 2));
       await c.end();
     })().catch((e) => { console.error("FAIL", e.code || e.message.replace(/\/\/[^@]*@/, "//***@")); process.exit(1); });'
   ```

   Expects both `0016` and `0017` present, both with `phase: 'expand'`, `0017`'s `applied_at` matching the boot
   time. No row may have `error` set.
5. **Schema.** Same script, different query:

   ```bash
   sudo node --env-file=/etc/openvibe/network.env -e '
     const { Client } = require("pg");
     (async () => {
       const c = new Client({ connectionString: process.env.DATABASE_DIRECT_URL });
       await c.connect();
       const t = await c.query("SELECT to_regclass(current_schema() || %L) AS table", ["dev_agent_grants"]);
       const i = await c.query(
         "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = %L ORDER BY indexname",
         ["dev_agent_grants"]
       );
       console.log("table:", t.rows[0].table);
       console.log("indexes:", i.rows.map((r) => r.indexname).join(", "));
       await c.end();
     })().catch((e) => { console.error("FAIL", e.code || e.message.replace(/\/\/[^@]*@/, "//***@")); process.exit(1); });'
   ```

   Expects `table: dev_agent_grants` (not null) and `indexes: dev_agent_grants_active_idx, dev_agent_grants_cap_idx, dev_agent_grants_pkey`.
6. **Routes.** Sign in at `https://openvibe.network/login`. Create a developer project (or reuse one) and an agent
   in the project (the slice-2 routes are already in production). Then
   `GET /api/v1/projects/<prj>/agents/<agt>/grants` returns `{"grants": []}`. `PUT …/grants/<capability>` with a
   capability the agent's host app may use returns the grant (the `ceiling` rejects a capability the host does not
   hold with `403 grant.beyond_host` — the regression case in `test/agent-grants.test.js`). A `revoked` grant
   appears in the list with `status: "revoked"` and a non-null `revoked_at`. No `dev_agent_grants` row from before
   the deploy; nothing is backfilled.

All six must pass. A no-go at any step is [rollback](#rollback).

## The way back

- **Code.** `ov access run openvibe-ovh rollback network` brings back the previous release (the SHA in
  `releases network` before step 3). The previous release was already on PostgreSQL with `0016` applied; it
  reads the new table as empty and writes nothing to it, so the rollback is a code rollback only. It does not
  drop the table.
- **Data.** Only if the table must be dropped (there is no operational reason to expect this for a `CREATE TABLE
  IF NOT EXISTS` `expand` migration). The step-2 backup is the only restore that takes the database back to
  before `0017` was applied. **A restore of the step-2 backup overwrites every write made between step 2 and
  the restore** (new accounts, sessions, notifications, coin transactions, follows, blocks, preferences, grants
  on this PR's routes). Restores are an owner decision; coordinate with the database owner separately. Never
  drop `dev_agent_grants` from the previous release by hand: the next deploy would refuse to reapply (`IF NOT
  EXISTS` succeeds but the ledger row would not be created).
- **Downtime.** None beyond the ordinary restart: the deploy is the same swap every Network release takes.
  `openvibe-network=active` drops for the duration of the boot and comes back with `/api/ready` answering.

## The rehearsal

Proposed marker name: **`network-pr35-0017-grants`**. It is written by whoever runs this runbook against a copy
of the data, never by this PR:

1. Take a PostgreSQL snapshot of production (or use the harness's PG scratch database) and restore it into an
   isolated database. The snapshot is the only point at which production data leaves the host. The isolated
   database must already have `0016_agents.sql` applied, so the rehearsal exercises the upgrade path
   (`0015 → 0016 → 0017`), the real path production will take.
2. From a checkout of the merged commit (`7b16a09`), with the isolated database's URLs in
   `/etc/openvibe/network.env`, run the migration step directly through the same `openvibe-sdk/db` runner the
   server uses at boot:

   ```bash
   sudo node --env-file=/etc/openvibe/network.env -e '
     const { createDb } = require("openvibe-sdk/db");
     const path = require("path");
     (async () => {
       const db = createDb({ url: process.env.DATABASE_DIRECT_URL, service: "network-rehearsal", max: 1 });
       try {
         const r = await db.migrate({ dir: path.join(process.cwd(), "migrations") });
         console.log(JSON.stringify({ applied: r.applied.map((m) => m.id), total: r.applied.length }, null, 2));
       } finally { await db.close(); }
     })().catch((e) => { console.error("FAIL", e.message); process.exit(1); });'
   ```

   Expects `applied: ["0016", "0017"]` on a clean rehearsal database (or `applied: []` on a database that already
   has them). `0017` must apply once, change nothing on a second run, and run its file body a third time without
   error (`IF NOT EXISTS` throughout).
3. Run `NETWORK_TEST_STORE=pg OV_TEST_PG_URL=<the isolated DATABASE_URL> OV_TEST_PG_DIRECT_URL=<its owner URL> node test/agent-schema.test.js`.
   Expects `agent schema: all tests passed`. The `pg_indexes` query inside it is the fix this PR carries (the
   `schemaname = current_schema()` clause); without the fix the assertion reads every other parallel worker's
   `dev_agent_grants` indexes and fails.
4. Run the same three env vars with `node test/agent-grants.test.js`. Expects all assertions pass (the ceiling
   for app, sandbox and service hosts; `auto` on a sensitive capability is `422`; only the owner may `PUT`;
   cascades from `setAllowance`, an app grant revoke, a service grant revoke and its expiry each carry their
   audit row with the right `revoked_by` and `revoke_reason`).
5. Only if every step above passed, the rehearsal operator writes
   `{"ok": true}` to `ds/deploy/rehearsals/network-pr35-0017-grants.json` on the harness (the directory
   `/home/workstation/openvibe/agents/ds/deploy/rehearsals/`). The auto-finish pipeline reads that file via
   `deploy.js:rehearsalOk` and only then allows the merge to deploy.

If the rehearsal fails:

- A `preflight` collision (a `dev_agent_grants` row already in the copy with a different shape) is a data
  problem, not a code one. Take a fresh snapshot.
- `0017` refuses to apply because `0016` is missing: the snapshot was taken from a pre-slice-2 release.
  Restore a more recent snapshot.
- `test/agent-schema.test.js` fails on the `pg_indexes` assertion: the PR was rebased without the
  `schemaname = current_schema()` clause. Re-merge from `7b16a09`.
- `test/agent-grants.test.js` fails on the ceiling: `openvibe-contracts` is not pinned to v0.85.0+
  (`capabilities.get(id).visibility === 'internal'` is what the service-host ceiling checks). Run
  `node scripts/contracts-drift.js` and follow its findings before re-rehearsing.