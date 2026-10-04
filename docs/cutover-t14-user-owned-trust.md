# Cutover runbook: the user-owned trust class (migration 0020)

This PR lets the resource registry hold the trust class `user-owned`, a person's own Node (ADR-046, the universal
adaptive fabric). The class has been in the `platform.resource-offer@1` enum since Contracts 0.87.0, and Network's pin
has carried it since 0.90.0. Until now, though, PostgreSQL refused it, so a user's own Node could never be reported.
The data change is `migrations/0020_user_owned_trust.sql`. It drops and re-adds three CHECK constraints, each one
wider than before. No column is added, renamed or dropped, and no row is rewritten. The migration is `phase: expand`
and every drop is `IF EXISTS`, so it is safe to run on a live production database and safe to run twice.

Like [cutover-t2-confirmations-budgets.md](cutover-t2-confirmations-budgets.md), this is much smaller than the SQLite →
PostgreSQL cutover ([cutover-t2-postgres.md](cutover-t2-postgres.md)): no data move, no freeze window, no snapshot
import. The migration runs as part of the normal boot of the new release.

---

## What changes

| Constraint | Table | Before (0007 / 0008 / 0014) | After (0020) |
| --- | --- | --- | --- |
| `platform_resource_offers_trust_check` | `platform_resource_offers` | `trust IN ('first-party','partner','community','external')` (inline in 0007, so PostgreSQL's default name) | the same plus `user-owned` |
| `platform_node_principals_trust_check` | `platform_node_principals` | the same four (inline in 0008, PostgreSQL's default name) | the same plus `user-owned` |
| `platform_node_principals_owner` | `platform_node_principals` | a `user` machine is `community`; a `project` machine is anything but `first-party` (0014) | a `user` machine is `community` or `user-owned`; a `project` machine is neither `first-party` nor `user-owned` |

Widening the owner rule is required too. Without it, a `user` principal could still be only `community`. An offer
must carry its node's trust class (`server/registry/cells.js` `checkPlacement`, `registry.trust_mismatch`), so a
user-owned offer from a person's own Node would still be refused. The only thing the owner rule newly refuses is a
`project` machine marked `user-owned`, and no such row can exist, because both trust CHECKs refused that value until
now. Every row in production therefore passes all three new constraints. Each ADD validates the table, which takes
milliseconds on a table this size.

The code is unchanged apart from a comment in `server/registry/offers.js` `check()`. The contract already accepts
the value, and `columns()` copies `trust` through as it is. Pairing (`server/registry/node-principals.js` `redeem`)
still creates a paired user machine as `community`. Which machines become `user-owned`, and with what consent, are
ADR-046's open questions for the owner. Until a principal holds the class, no `user-owned` offer reaches the table.

---

## Prerequisites

1. **Production is on PostgreSQL and has applied 0019.** Confirm with `ov access run openvibe-ovh health network`
   (must say `ready`) and `validate network` (must say `checkout clean`). The runner refuses a pending file numbered
   below an applied one, so 0020 must be the next number after what production has applied.
2. **`DATABASE_DIRECT_URL` is set and connects.** The migration runner uses the direct (owner-role) connection for
   schema changes. Check by name only:
   ```bash
   sudo grep -cE '^DATABASE_DIRECT_URL=.+' /etc/openvibe/network.env
   ```
   Must print `1`. Never print the value.
3. **A green rehearsal of this PR's head.** See [Step 1](#step-1-rehearse). The deploy gates on its marker.
4. **The target commit is fixed.** It is the merge commit of this PR into `origin/main`. Steps 1 and 2 must use that
   one SHA.

---

## Step 1: rehearse

The repository test builds a database at 0019 and loads the rehearsal seed
(`test/fixtures/rehearsal/user-owned-trust.sql`: one node principal per owner kind, and one offer for each of the four
old trust classes). It then applies 0020 and asserts the following:

- 0020 applies once and leaves every seeded row unchanged.
- Each table has exactly one trust CHECK, and it names `user-owned`.
- A `user-owned` principal is stored and listed, and its `user-owned` offer passes `check()` and `checkPlacement`,
  is stored, and is listed by `trust=user-owned`.
- A project machine marked `user-owned`, a user machine marked `partner`, and the unknown class `stranger` are all
  still refused.

```bash
NETWORK_TEST_STORE=pg node test/run.js user-owned-trust
```

**Go:** exit 0 and `user-owned trust: all tests passed`.

The harness also rehearses the PR's head by itself (`ov rehearse OpenVibe.Network <PR>`) on a scratch PostgreSQL.
It applies `origin/main`'s migrations (up to 0019), loads the seed named below, applies this PR's migrations (a
second run must apply nothing), and then runs the commands in this block against that database. The first command
checks the migration, the constraints and the seeded rows. The second writes a user-owned principal and offer inside
a transaction that it rolls back, and shows that a `stranger` class and a user-owned project machine are refused.

```rehearse
seed: test/fixtures/rehearsal/user-owned-trust.sql
migrations: migrations
node -e 'const{Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.REHEARSAL_DATABASE_URL});await c.connect();const m=await c.query("SELECT id FROM ov_migrations WHERE id=$1",["0020"]);const k=await c.query("SELECT conname,pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid IN (\x27platform_resource_offers\x27::regclass,\x27platform_node_principals\x27::regclass) AND conname=ANY($1) ORDER BY conname",[["platform_resource_offers_trust_check","platform_node_principals_trust_check","platform_node_principals_owner"]]);const p=await c.query("SELECT node_id||\x27=\x27||trust AS v FROM platform_node_principals WHERE node_id LIKE \x27rh-%\x27 ORDER BY node_id");const o=await c.query("SELECT id||\x27=\x27||trust AS v FROM platform_resource_offers WHERE id LIKE \x27rh-%\x27 ORDER BY id");await c.end();const rows=p.rows.map(r=>r.v).concat(o.rows.map(r=>r.v)).join(",");const want="rh-platform=first-party,rh-project=partner,rh-user=community,rh-platform=first-party,rh-project=partner,rh-provider=external,rh-user=community";if(m.rows.length!==1||k.rows.length!==3||!k.rows.every(r=>r.d.includes("user-owned"))||rows!==want){console.error("FAIL migration="+m.rows.length+" constraints="+JSON.stringify(k.rows)+" rows="+rows);process.exit(1);}console.log("rehearse: 0020 applied, "+k.rows.map(r=>r.conname).join(",")+" name user-owned, seed rows unchanged");})().catch(e=>{console.error("FAIL",e.code||e.message);process.exit(1)})'
node -e 'const{Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.REHEARSAL_DATABASE_URL});await c.connect();const refused=async(sql,args)=>{await c.query("SAVEPOINT s");try{await c.query(sql,args);return false}catch(e){await c.query("ROLLBACK TO SAVEPOINT s");return e.code==="23514"}};const P="INSERT INTO platform_node_principals (id,node_id,home_cell,owner_kind,project_id,owner_subject,trust,created_by,credential_hash) VALUES ($1,$2,\x27wnam-1\x27,$3,$4,$5,$6,\x27rehearsal\x27,$7)";const usr="usr_0000000000000000000000RH01",prj="prj_0000000000000000000000RH01";await c.query("BEGIN");try{await c.query(P,["nod_0000000000000000000000RH04","rh-mine","user",null,usr,"user-owned","d".repeat(64)]);await c.query("INSERT INTO platform_resource_offers (id,source,kind,region,cell,trust,status,doc,reported_at) VALUES (\x27rh-mine\x27,\x27rh-mine\x27,\x27node\x27,\x27us-west\x27,\x27wnam-1\x27,\x27user-owned\x27,\x27up\x27,\x27{}\x27,\x272026-10-04T00:00:00Z\x27)");const a=await refused(P,["nod_0000000000000000000000RH05","rh-stranger","user",null,usr,"stranger","e".repeat(64)]);const b=await refused(P,["nod_0000000000000000000000RH06","rh-prj-mine","project",prj,null,"user-owned","f".repeat(64)]);const d=await refused("INSERT INTO platform_resource_offers (id,source,kind,region,cell,trust,status,doc,reported_at) VALUES (\x27rh-odd\x27,\x27rh\x27,\x27node\x27,\x27us-west\x27,\x27wnam-1\x27,\x27stranger\x27,\x27up\x27,\x27{}\x27,\x272026-10-04T00:00:00Z\x27)");if(!a||!b||!d){console.error("FAIL refused stranger-principal="+a+" project-user-owned="+b+" stranger-offer="+d);process.exitCode=1}else console.log("rehearse: user-owned principal and offer stored; stranger and a user-owned project machine refused (rolled back)")}finally{await c.query("ROLLBACK");await c.end()}})().catch(e=>{console.error("FAIL",e.code||e.message);process.exit(1)})'
```

**Go:** the rehearsal job ends with `rehearse: 0020 applied, platform_node_principals_owner,
platform_node_principals_trust_check,platform_resource_offers_trust_check name user-owned, seed rows unchanged` and
`rehearse: user-owned principal and offer stored; stranger and a user-owned project machine refused (rolled back)`
(exit 0).
**No-go:** a held migration, a constraint without `user-owned`, a changed seed row, or a write that is stored when it
should be refused (or refused when it should be stored) means the migration does not apply cleanly on top of
production's schema. Fix it and push; the new head is rehearsed again.

The harness writes the marker `~/openvibe/agents/ds/deploy/rehearsals/openvibe-network-<PR>.json` from the
rehearsal's exit code. No agent writes it.

---

## The backup

Before the deploy, take the pre-deploy restore point into the broker's backup area:

```bash
ov access run openvibe-ovh db-backup
```

It writes outside the release and outside the repository; keep it. The migration only widens constraints, so a code
rollback ([below](#rollback)) is enough and does not need this backup. A restore of this backup overwrites every write
made after it (accounts, sessions, notifications, coin transactions, follows, blocks, preferences, offers and node
principals). Restores are an owner decision; coordinate with the database owner separately.

---

## Step 2: deploy

`server/db/database.js` runs every pending migration at startup, using `DATABASE_DIRECT_URL` for schema changes. No
manual SQL, no script, no freeze.

```bash
ov deploy OpenVibe.Network "PR #<number>: user-owned trust class (migration 0020)"
```

After merge, the deploy:

1. Checks out the merge commit on `/opt/openvibe.network`.
2. Restarts `openvibe-network.service`.
3. The new process boots, runs `0020_user_owned_trust.sql` (the only pending migration), and starts serving.

**Go:** `health network` says `ready` on the merge SHA; `validate network` says `checkout clean` at that SHA;
`journal openvibe-network.service` shows the boot banner with no migration error.
**No-go:** the service fails to start. Check the journal. A `check constraint … is violated by some row` error here
means production holds a row the rehearsal seed did not foresee. Roll back (below), and find the row with the
constraint's expression before trying again.

---

## Verification after deploy

```bash
ov access run openvibe-ovh journal openvibe-network.service 200 | grep -i '0020\|migration\|constraint'

# On the host, with the owner connection:
sudo node --env-file=/etc/openvibe/network.env -e '
  const { Client } = require("pg");
  (async () => {
    const c = new Client({ connectionString: process.env.DATABASE_DIRECT_URL });
    await c.connect();
    const k = await c.query("SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid IN ('platform_resource_offers'::regclass, 'platform_node_principals'::regclass) AND conname = ANY($1) ORDER BY conname",
      [["platform_resource_offers_trust_check", "platform_node_principals_trust_check", "platform_node_principals_owner"]]);
    for (const r of k.rows) console.log(r.conname, r.d.includes("user-owned") ? "names user-owned" : "MISSING user-owned");
    const m = await c.query("SELECT id FROM ov_migrations WHERE id = $1", ["0020"]);
    console.log("migration:", m.rows.length ? "0020" : "MISSING");
    await c.end();
  })().catch((e) => { console.error("FAIL", e.message.replace(/\/\/[^@]*@/, "//***@")); process.exit(1); });'
```

Expected: three lines ending `names user-owned`, and `migration: 0020`. `GET https://openvibe.network/api/v1/resources`
answers as before. It lists no `user-owned` offer until a Node holding that class reports one.

---

## Rollback

- **Code rollback, constraints stay.** Revert to the previous release. Its code never writes `user-owned` (pairing
  writes `community`), so the wider constraints are inert. The migration stays recorded in `ov_migrations`, and a
  later re-deploy sees it as applied.
- **Full rollback, constraints narrowed.** Only when no row holds `user-owned`
  (`SELECT count(*) FROM platform_node_principals WHERE trust = 'user-owned'` and the same on
  `platform_resource_offers` both print 0). Run as the owner role, re-adding the definitions from 0007, 0008 and
  0014:
  ```sql
  ALTER TABLE platform_resource_offers DROP CONSTRAINT IF EXISTS platform_resource_offers_trust_check;
  ALTER TABLE platform_resource_offers ADD CONSTRAINT platform_resource_offers_trust_check
      CHECK (trust IN ('first-party', 'partner', 'community', 'external'));
  ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_trust_check;
  ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_trust_check
      CHECK (trust IN ('first-party', 'partner', 'community', 'external'));
  ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_owner;
  ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_owner CHECK (
         (owner_kind = 'platform' AND project_id IS NULL AND owner_subject IS NULL AND trust = 'first-party')
      OR (owner_kind = 'project' AND project_id IS NOT NULL AND owner_subject IS NULL AND trust <> 'first-party')
      OR (owner_kind = 'user' AND project_id IS NULL AND owner_subject IS NOT NULL
          AND owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$' AND trust = 'community'));
  DELETE FROM ov_migrations WHERE id = '0020';
  ```
  If any row holds `user-owned`, a person's Node is registered with that class, and narrowing the constraints would
  fail. Revoke or reclassify those principals first; that is an owner decision.

Restart the service after either rollback and confirm `health network` says `ready`.

---

## What is not covered here

- **Data move.** None. No row is rewritten, and nothing holds `user-owned` until a principal is given the class.
- **Freeze window.** None. Three constraint swaps on small tables take milliseconds.
- **Contracts.** No pin bump. v0.90.0 is already pinned, and it accepts `user-owned`.
- **Who becomes user-owned.** Pairing still creates `community` principals. Switching a paired user machine to
  `user-owned`, and the consent and revocation rule for running work on it, are ADR-046's open questions for the owner.
