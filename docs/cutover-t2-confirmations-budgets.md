# Cutover runbook: confirmations and agent budgets (migrations 0018 and 0019)

This PR adds plan T2 WS-Z2 slices 4 and 5: the owner side of confirmations and agent budgets
(`docs/t2-projects-and-grants.md` sections 3-5). The data change is three new tables and their indexes
(`migrations/0018_confirmations.sql`, `migrations/0019_agent_budgets.sql`). No existing table is altered, no column is
renamed or dropped, no row is touched. Both migrations are `phase: expand` and every statement is `IF NOT EXISTS`, so
they are safe to run on a live production database and safe to run twice.

Like [cutover-pr-openvibe-network-34.md](cutover-pr-openvibe-network-34.md) (migration 0017), this is much smaller than
the SQLite → PostgreSQL cutover ([cutover-t2-postgres.md](cutover-t2-postgres.md)): no data move, no freeze window, no
snapshot import. The migrations run as part of the normal boot of the new release.

---

## What changes

| Object | Kind | Notes |
| --- | --- | --- |
| `dev_standing_rules` | table | identity `id`; FK → `dev_agents(id)`; CHECK on `rule` (`session`/`until`/`always`), `session_id` format, `source` (`cnf_…`), `session` ↔ `session_id`, `always` ↔ no `until_at` |
| `dev_standing_rules_live_idx` | partial index | `(agent_id, capability) WHERE revoked_at IS NULL` |
| `dev_confirmations` | table | `cnf_…` primary key; FK → `dev_projects(id)`, `dev_agents(id)`, `dev_standing_rules(id)`; CHECK on owner (`usr_…`), summary length, state, standing rule, digest (64 lowercase hex), and the decision/use columns against the state |
| `dev_confirmations_inbox_idx` | index | `(owner_subject, state, created_at)` |
| `dev_confirmations_due_idx` | partial index | `(expires_at) WHERE state = 'pending'` |
| `dev_confirmations_agent_idx` | index | `(agent_id, state)` |
| `dev_confirmations_spendable_idx` | partial index | `(agent_id, capability) WHERE state = 'approved' AND used_at IS NULL` |
| `dev_agent_budgets` | table | primary key `(agent_id, capability)`; FK → `dev_agents(id)`; CHECK `limit_value >= 0`, `budget_window` in `minute`/`hour`/`day`/`month`/`total`; `unit` defaults to `requests` |

No existing table, index, view or function is modified. The code that reads and writes the tables
(`server/developer/confirmations.js`, `server/developer/agents.js`, `server/developer/routes.js`,
`server/identity/grants-admin.js`, `server/index.js`) adds `/api/v1/confirmations`, the budget and rule routes under
`/api/v1/projects/:project/agents/:agent`, and a one-minute expiry sweep. Until an owning service creates a
confirmation (through `/internal/confirmations`, built in slice 7; no service holds `network.confirmation.manage` by
default yet) and an owner sets a budget, the tables stay empty;
the cascades that now also cancel confirmations find nothing to cancel.

---

## Prerequisites

1. **Production is on PostgreSQL and has applied 0017.** Confirm with `ov access run openvibe-ovh health network`
   (must say `ready`) and `validate network` (must say `checkout clean`). The runner refuses a pending file numbered
   below an applied one, so 0018 and 0019 must be the next numbers after what production has applied.
2. **`DATABASE_DIRECT_URL` is set and connects.** The migration runner uses the direct (owner-role) connection for
   schema changes. Check by name only:
   ```bash
   sudo grep -cE '^DATABASE_DIRECT_URL=.+' /etc/openvibe/network.env
   ```
   Must print `1`. Never print the value.
3. **A green rehearsal on a copy of the production database.** See [Step 1](#step-1-rehearse-on-a-copy). Only after
   it passes does the owner write the rehearsal file the deploy gates on.
4. **The target commit is fixed.** It is the merge commit of this PR into `origin/main`. Steps 1 and 2 must use that
   one SHA.

---

## Step 1: rehearse on a copy

```bash
TARGET=<merge sha of this PR>
STAGE=/var/tmp/network-confirmations-stage
sudo -u ubuntu git clone --no-checkout /opt/openvibe.network "$STAGE"
sudo -u ubuntu git -C "$STAGE" checkout --detach "$TARGET"
cd "$STAGE" && sudo -u ubuntu npm ci
```

Then run the agent-schema test, which builds a fresh database at 0015, applies 0016 to 0019, and asserts the
constraints, foreign keys and indexes of every table they add:

```bash
cd "$STAGE" && sudo -u ubuntu NETWORK_TEST_STORE=pglite node test/run.js agent-schema
```

**Go:** exit 0 and `agent schema: all tests passed`.
**No-go:** read the failure. A migration syntax error or a constraint mismatch means the PR is not ready; do not
deploy.

The harness rehearses the PR's head by itself (`ov rehearse OpenVibe.Network 37`) on a scratch PostgreSQL: it applies
`origin/main`'s migrations, the repository's fixtures and then this PR's migrations, and finally the commands
declared in this fenced block. They assert that the rehearsal database carries both migrations and all three tables:

```rehearse
migrations: migrations
node -e 'const{Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.REHEARSAL_DATABASE_URL});await c.connect();const t=await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=ANY($1) ORDER BY table_name",[["dev_standing_rules","dev_confirmations","dev_agent_budgets"]]);const m=await c.query("SELECT id FROM ov_migrations WHERE id=ANY($1) ORDER BY id",[["0018","0019"]]);await c.end();const tables=t.rows.map(r=>r.table_name),ids=m.rows.map(r=>r.id);if(tables.length!==3||ids.length!==2){console.error("FAIL tables="+tables+" migrations="+ids);process.exit(1);}console.log("rehearse: tables "+tables.join(",")+", migrations "+ids.join(","));})().catch(e=>{console.error("FAIL",e.code||e.message);process.exit(1)})'
```

**Go:** the rehearsal job's last line is `rehearse: tables dev_agent_budgets,dev_confirmations,dev_standing_rules,
migrations 0018,0019` (exit 0).
**No-go:** a held migration or a missing table means the migration does not apply on top of production's schema; fix
it and push (the new head is rehearsed again).

For an extra check against the real production schema (optional, recommended), point the test at a scratch
PostgreSQL database restored from a production dump (`NETWORK_TEST_STORE=pg` with `OV_TEST_PG_URL` /
`OV_TEST_PG_DIRECT_URL`) and run the same test. The scratch database must never be the production URLs.

The owner writes `~/openvibe/agents/ds/deploy/rehearsals/pr-<number>-confirmations-budgets.json` with
`{"ok": true}` only after the rehearsal passes.

---

## The backup

Before the deploy, take the pre-deploy restore point into the broker's backup area:

```bash
ov access run openvibe-ovh db-backup
```

It writes outside the release and outside the repository; keep it. The migrations are additive and the three tables
are empty until a service creates a confirmation or an owner sets a budget, so a code rollback ([below](#rollback))
is usually enough and does not need this backup. But it is the only restore point that knows the schema state
before `0018` and `0019`, and it costs one command in a pipeline that already holds the host lock. A restore of this
backup overwrites every write made after it (accounts, sessions, notifications, coin transactions, follows, blocks,
preferences, and any confirmation, standing rule or budget created on this PR's routes); restores are an owner
decision, coordinate with the database owner separately.

---

## Step 2: deploy

`server/db/database.js` runs every pending migration at startup, using `DATABASE_DIRECT_URL` for schema changes. No
manual SQL, no script, no freeze.

```bash
ov deploy OpenVibe.Network "PR #<number>: confirmations and agent budgets (migrations 0018, 0019)"
```

After merge, the deploy:

1. Checks out the merge commit on `/opt/openvibe.network`.
2. Restarts `openvibe-network.service`.
3. The new process boots, runs `0018_confirmations.sql` then `0019_agent_budgets.sql` (the only pending migrations),
   starts the confirmation expiry sweep and starts serving.

**Go:** `health network` says `ready` on the merge SHA; `validate network` says `checkout clean` at that SHA;
`journal openvibe-network.service` shows the boot banner with no migration error and no `[Confirmations] expiry:`
warning.
**No-go:** the service fails to start. Check the journal; a migration error here means the rehearsal did not match
production: roll back (below).

---

## Verification after deploy

```bash
ov access run openvibe-ovh journal openvibe-network.service 200 | grep -i '0018\|0019\|migration\|confirmation'

# On the host, with the owner connection:
sudo node --env-file=/etc/openvibe/network.env -e '
  const { Client } = require("pg");
  (async () => {
    const c = new Client({ connectionString: process.env.DATABASE_DIRECT_URL });
    await c.connect();
    for (const t of ["dev_standing_rules", "dev_confirmations", "dev_agent_budgets"]) {
      const r = await c.query(`SELECT count(*) FROM ${t}`);
      console.log(t, "rows:", r.rows[0].count);
    }
    const m = await c.query("SELECT id FROM ov_migrations WHERE id IN ($1, $2) ORDER BY id", ["0018", "0019"]);
    console.log("migrations:", m.rows.map((r) => r.id).join(",") || "MISSING");
    await c.end();
  })().catch((e) => { console.error("FAIL", e.message.replace(/\/\/[^@]*@/, "//***@")); process.exit(1); });'
```

Expected: each table `rows: 0`, `migrations: 0018,0019`. An unauthenticated
`curl -s -o /dev/null -w '%{http_code}' https://openvibe.network/api/v1/confirmations` answers `401`.

---

## Rollback

The migrations are additive and the tables are empty until a service creates a confirmation or an owner sets a budget.

- **Code rollback, tables stay.** Revert to the previous release. Its code never references the new tables, so they
  are inert; the migrations stay recorded in `ov_migrations`, and a later re-deploy sees them as applied.
- **Full rollback, tables dropped.** Only when all three tables are empty, as the owner role:
  ```sql
  DROP TABLE IF EXISTS dev_agent_budgets;
  DROP TABLE IF EXISTS dev_confirmations;
  DROP TABLE IF EXISTS dev_standing_rules;
  DELETE FROM ov_migrations WHERE id IN ('0018', '0019');
  ```
  `dev_confirmations` references `dev_standing_rules`, so drop it first. If any row exists, owners' budgets, rules or
  pending decisions are in use and the tables cannot be dropped without losing them.

Restart the service after either rollback and confirm `health network` says `ready`.

---

## What is not covered here

- **Data move.** None; the tables start empty.
- **Freeze window.** None; three `CREATE TABLE` and six `CREATE INDEX` on empty tables take milliseconds.
- **Contracts.** No pin bump: `network.confirmation-request@1` is in the pinned v0.85.0. The internal routes (slice 7)
  were built after this cutover, with the pin at v0.90.0 and no migration; agent tokens and decision events (slices
  8-9) still wait on Network work.
