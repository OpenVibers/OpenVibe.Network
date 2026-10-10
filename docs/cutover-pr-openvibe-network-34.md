# Cutover runbook: PR #34 — delegated agent grants (migration 0017)

PR [#34](https://github.com/OpenVibers/OpenVibe.Network/pull/34) adds plan T2 WS-Z2 slice 3: delegated agent
grants. The data change is one new table, `dev_agent_grants`, and two indexes on it
(`migrations/0017_agent_grants.sql`). No existing table is altered, no column is renamed or dropped, no row is
touched. The migration is `phase: expand` and every statement is `IF NOT EXISTS`, so it is safe to run on a
live production database and safe to run twice.

This runbook covers the deploy of that migration. There is no data move, freeze window or snapshot
import. The migration runs as part of the normal boot of the new release.

---

## What changes

| Object | Kind | Notes |
| --- | --- | --- |
| `dev_agent_grants` | table | one row per (agent, capability); FK → `dev_agents(id)`; CHECK on `mode`, `status`, `audience` format, and `revoked` ↔ `revoked_at` |
| `dev_agent_grants_active_idx` | partial index | `(agent_id) WHERE status = 'active'` |
| `dev_agent_grants_cap_idx` | index | `(capability, status)` |

No existing table, index, view or function is modified. The application code that reads and writes the table
(`server/developer/agents.js`, `server/developer/routes.js`, `server/developer/store.js`,
`server/identity/grants-admin.js`) only activates when an owner creates a grant through the developer API;
before that, the table is empty and the indexes cost nothing.

---

## Prerequisites

1. **Production is on PostgreSQL.** The migration is SQL that targets PostgreSQL (and PGlite in tests). The
   current production release (`bad7b106fda0` at the time of writing) already serves from PostgreSQL; confirm
   with `ov access run openvibe-ovh health network` (must say `ready`) and `validate network` (must say
   `checkout clean`).
2. **`DATABASE_DIRECT_URL` is set and connects.** The migration runner uses the direct (owner-role) connection
   for schema changes. Check by name only:
   ```bash
   sudo grep -cE '^DATABASE_DIRECT_URL=.+' /etc/openvibe/network.env
   ```
   Must print `1`. Never print the value.
3. **A green rehearsal on a copy of the production database.** See [Step 1](#step-1-rehearse-on-a-copy). Only
   after it passes does the owner write the rehearsal file the deploy gates on.
4. **The target commit is fixed.** It is the merge commit of PR #34 into `origin/main`. Steps 1 and 2 must use
   that one SHA.

---

## Step 1: rehearse on a copy

Run the migration against a throwaway copy of the production schema. The goal is to prove that 0017 applies
cleanly on top of 0015 (the last migration production has applied) and that the resulting schema matches what
the tests assert.

```bash
TARGET=<merge sha of PR #34>
STAGE=/var/tmp/network-pr34-stage
sudo -u ubuntu git clone --no-checkout /opt/openvibe.network "$STAGE"
sudo -u ubuntu git -C "$STAGE" checkout --detach "$TARGET"
cd "$STAGE" && sudo -u ubuntu npm ci
```

Then run the agent-schema test, which builds a fresh database at 0015, applies 0016 and 0017, and asserts the
indexes, constraints and FK:

```bash
cd "$STAGE" && sudo -u ubuntu NETWORK_TEST_STORE=pglite node test/agent-schema.test.js
```

**Go:** exit 0 and `agent schema: all tests passed` on stdout.
**No-go:** read the failure. A migration syntax error or a constraint mismatch means the PR is not ready; do
not deploy.

For an extra check against the real production schema (optional, recommended), point `NETWORK_TEST_STORE=env`
at a scratch PostgreSQL database that has been restored from a production dump, and run the same test. The
scratch database must never be the production URLs.

The owner writes `~/openvibe/agents/ds/deploy/rehearsals/pr-34-agent-grants.json` with `{"ok": true}` only
after the rehearsal passes. ds-finish refuses to deploy without that file and without the merged PR's
`cutover` block.

---

## Step 2: deploy

The migration runs as part of the normal boot of the new release. `server/db/database.js` runs every pending
migration in `migrations/` at startup, using `DATABASE_DIRECT_URL` for the schema changes. No manual SQL, no
script, no freeze.

```bash
ov deploy OpenVibe.Network "PR #34: delegated agent grants (migration 0017)"
```

The pipeline's own gates (verify, review, merge-by-policy) run before this. After merge, the deploy:

1. Checks out the merge commit on `/opt/openvibe.network`.
2. Restarts `openvibe-network.service`.
3. The new process boots, runs `0017_agent_grants.sql` (the only pending migration), and starts serving.

**Go:** `ov access run openvibe-ovh health network` says `ready` on the merge SHA; `validate network` says
`checkout clean` at that SHA; `journal openvibe-network.service` shows the boot banner with no migration error.
**No-go:** the service fails to start. Check the journal. A migration error at this point means the rehearsal
did not match production; roll back (below).

---

## Verification after deploy

```bash
# The migration is recorded.
ov access run openvibe-ovh journal openvibe-network.service 200 | grep -i '0017\|migration\|agent_grants'

# The table exists and is empty (no grants have been created yet).
# This requires a DATABASE_DIRECT_URL connection; run on the host:
sudo node --env-file=/etc/openvibe/network.env -e '
  const { Client } = require("pg");
  (async () => {
    const c = new Client({ connectionString: process.env.DATABASE_DIRECT_URL });
    await c.connect();
    const t = await c.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1)", ["dev_agent_grants"]);
    const r = await c.query("SELECT count(*) FROM dev_agent_grants");
    const m = await c.query("SELECT id FROM ov_migrations WHERE id = $1", ["0017"]);
    console.log("table:", t.rows[0].exists, "rows:", r.rows[0].count, "migration:", m.rows.length === 1 ? "applied" : "MISSING");
    await c.end();
  })().catch((e) => { console.error("FAIL", e.message.replace(/\/\/[^@]*@/, "//***@")); process.exit(1); });'
```

Expected: `table: true rows: 0 migration: applied`.

---

## Rollback

The migration is additive and the table is unused until an owner creates a grant. Two rollback paths:

- **Code rollback, table stays.** Revert the deploy to the previous release. The new release's code no longer
  references `dev_agent_grants`, so the empty table is inert. No data is lost because no row was ever written.
  The migration remains recorded in `ov_migrations`; a future re-deploy of PR #34 will see it as already
  applied (`IF NOT EXISTS` throughout) and move on.
- **Full rollback, table dropped.** If the table must be removed (for example, to re-run the migration from
  scratch after a schema fix), connect as the owner role:
  ```sql
  DROP TABLE IF EXISTS dev_agent_grants;
  DELETE FROM ov_migrations WHERE id = '0017';
  ```
  Do this only when no grant row exists (`SELECT count(*) FROM dev_agent_grants` = 0). If any row exists, the
  grants are in use and the table cannot be dropped without losing them.

In either case, restart the service after the rollback and confirm `health network` says `ready`.

---

## What is not covered here

- **Data move.** There is none. The table starts empty.
- **Freeze window.** There is none. The migration is a fast `CREATE TABLE` + two `CREATE INDEX` on an empty
  table; it takes milliseconds.
