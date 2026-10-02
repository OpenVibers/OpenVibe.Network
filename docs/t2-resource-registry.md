# T2 — the resource registry (design)

Status: **slice 1 built** (`migrations/0007_resource_registry.sql`, `server/registry/offers.js` write path,
`test/resource-registry.test.js`); **cells and node principals built** (section 9, `migrations/0008`); slices 2-5 are design.
Pinned versions at time of writing: `openvibe-contracts` **v0.83.0** (`package.json:30`), `openvibe-sdk` v0.25.2,
`openvibe-shared` v2.3.1. Every claim below was checked against that pin.

Scope: one table and one module that store **what the network can sell or place on** — every compute node and every
provider — reported by the components that own them, listed publicly so that `openvibe-sdk/placement` can plan against
the network's real inventory. It follows the existing node registry (`server/registry/nodes.js`) exactly. It does not
plan, does not price, does not settle, and does not create cells or service instances.

## 1. Precedent

`server/registry/nodes.js` (65 lines) is the whole pattern being copied:

- `ensureSchema()` is a **no-op with a comment** — the schema is `migrations/NNNN_*.sql` (plan T2), nothing is created
  at runtime. The new table follows that rule; a service's migrations own its tables, the runtime role creates none.
- `report(db, {source, nodes}, now)` — one `INSERT … ON CONFLICT(id) DO UPDATE` per row inside `db.tx`, then every row of
  the **same `source`** with `status <> 'down'` whose id is absent from the report is set to `down` with
  `doc.health.checked_at = now`. Rows are **never deleted**.
- `list(db, …)` reads `doc`, `JSON.parse`s it and filters in JS.
- `routers({guard})` returns `{pub, internal}`; `open(res, maxAge)` sets `Cache-Control`, `Access-Control-Allow-Origin: *`
  and `Timing-Allow-Origin: *`. Not-found uses `contracts.http.sendProblem(res, 404, '<code>', {detail})` (the
  `server/registry/ecosystem.js` idiom).
- Guard: `require('./identity/principals').guard('<capability>')` wired in `server/index.js` next to the node routers.
  `principals.guard` **throws at boot on an unknown capability**, so no capability string may be invented here.

## 2. Migration — `migrations/0007_resource_registry.sql`

Header convention (`-- phase: expand`, `-- plan T2. <why>`, blank line, DDL; `IF NOT EXISTS` as in `0006_config.sql`):

```sql
CREATE TABLE IF NOT EXISTS platform_resource_offers (
    id            text COLLATE "C" PRIMARY KEY,   -- offer_id
    source        text COLLATE "C" NOT NULL,     -- the reporting principal (node id, provider id, service id)
    kind          text COLLATE "C" NOT NULL CHECK (kind IN ('node','provider')),
    region        text COLLATE "C" NOT NULL,
    cell          text COLLATE "C" NOT NULL DEFAULT 'wnam-1',
    trust         text COLLATE "C" NOT NULL CHECK (trust IN ('first-party','partner','community','external')),
    status        text COLLATE "C" NOT NULL CHECK (status IN ('up','degraded','down','draining')),
    price_usd     double precision NOT NULL DEFAULT 0,
    doc           text COLLATE "C" NOT NULL,     -- the full platform.resource-offer@1 doc
    reported_at   text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_resource_offers_source_idx ON platform_resource_offers (source, status);
CREATE INDEX IF NOT EXISTS platform_resource_offers_kind_idx   ON platform_resource_offers (kind, region, status);
```

Deliberate decisions:

- **`doc` stays `text`, not `jsonb`** — `platform_nodes.doc` is `text` and every read is `JSON.parse`d in JS
  (`nodes.js:37`). One jsonb table next to a text table buys nothing and splits the codebase.
- **The filter columns (`kind`, `region`, `cell`, `trust`, `status`, `price_usd`) are duplicated out of `doc` on purpose.**
  They are written from the validated doc in the same upsert, and `WHERE kind = $1 AND price_usd <= $n` in SQL replaces
  the JS filter. This is the one intentional break from `nodes.js:38`, and it is the only reason the columns exist.
- `status` must carry exactly the planner's `HEALTH_OK` complement — `up|degraded|down|draining` — because the planner
  excludes `down` and `draining`, so the registry must be able to *store* `draining` even though the default list hides
  `down`.
- `region` is a provider-style region (`us-west`, `eu-central`), the same values the node registry uses, so the two agree.
- `cell` is a column in this slice. No `cells` / `service_instance` table: those come with the cells slice, not with offers.

### The duplicated columns — the exact mapping (single source of truth)

Not every column is a verbatim field of the offer doc: `cell` is optional in the contract and `status` / `price_usd` live
inside nested objects. So "the column equals the doc field" is only meaningful against this fixed mapping. The same
mapping is used in the SQL upsert (as bind values) and in test 8 — one definition, two consumers, no drift:

| Column | Written from the validated `platform.resource-offer@1` doc | Why it is not a plain copy |
|---|---|---|
| `id` | `doc.offer_id` | required by the contract |
| `kind` | `doc.kind` | required; enum `node\|provider` at v0.83.0 |
| `region` | `doc.region` | required |
| `trust` | `doc.trust` | required |
| `cell` | `doc.cell ?? 'wnam-1'` | `cell` is **optional** — it is not in the contract's `required` list, so an offer may omit it. The stored `doc` stays **verbatim** (no `cell` is synthesised into it), so when the field is absent the column legitimately holds the default. |
| `status` | `doc.health.status` | nested — the contract has no top-level `status`. `health` is required and `health.status` is required inside it, so the column can never be defaulted. |
| `price_usd` | `doc.pricing.marginal_usd_per_unit ?? 0` | nested **and optional** — `pricing` is required but only `pricing.model` is required inside it, so an offer may carry no marginal price. The column holds `0` then; the doc is still stored without the field. |

Invariants that follow from the table:

1. After **every** write, for every row: `id`, `kind`, `region`, `trust`, `status` equal the corresponding doc value, and
   `price_usd` equals `doc.pricing.marginal_usd_per_unit ?? 0`.
2. `cell` equals `doc.cell` whenever the doc has one, and `'wnam-1'` whenever it does not. The default is part of the
   mapping — it is not a lockstep violation.
3. Mark-down is the same mapping applied after the stored doc is updated: the row's `doc.health.status` is set to
   `'down'` and `doc.health.checked_at` to `now`, and then `status` is written as `'down'` from the updated doc. The row
   never gets a hand-written column value that the doc does not carry.

### The `kind` CHECK — reconciled with the pinned contract

`platform.resource-offer@1` at v0.83.0 defines `kind` as the enum `["node","provider"]` and
`additionalProperties: false`. The roadmap's *other* offer kinds (`storage`, `delivery`, `runtime`, `agent`,
`harness`) have **no contract at v0.83.0** — verified against `node_modules/openvibe-contracts/contracts/platform/`,
which ships 8 files, and `validate('platform.storage-offer@1', …)` throws `unknown contract`.

Therefore:

1. **`0007` permits only `node` and `provider`.** Nothing wider is written to the migration. A wider list would admit
   rows that the pinned contract cannot validate, so every read would be able to return a document that no writer could
   have produced.
2. The other five kinds are **reserved and documented, not implemented**. They appear in no migration, no `CHECK`,
   no constant, no test and no runtime code. Naming them in code — even inside a map — would reference contracts that
   do not exist, and `validate()` would throw inside the route and turn a 400 into a 500.
3. The `CHECK` is widened **only** by slice 5, after T1 publishes the tags and Network bumps the pin
   (`migrations/0009_resource_offer_kinds.sql`: `ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT`).

## 3. Module — `server/registry/offers.js`

A copy of `nodes.js` with four deltas.

**Report** — `report(db, {source, offers}, now)` → `{offers, marked_down}`; same upsert shape and same mark-down of the
same source's absent ids as `nodes.js`, with the six duplicated columns taken from the validated doc through the mapping
in §2. The response header is `X-Offers-Marked-Down`.

**Guard** — `principals.guard('network.node.report')` for the first slice. `network.resource.report` **does not exist
at v0.83.0**, and `principals.js` throws at boot on an unknown capability, so inventing the string breaks the service.
`network.node.report` is already held by Host, which is the component that reports. Slice 5 switches the constant to
`network.resource.report` in one line when T1 publishes it. Do not invent a capability string.

**Validation — one pass over the whole batch, then one transaction for the writes.** The report has exactly two phases,
in this order:

1. **Validation pass, before any write.** Every offer in the array is validated, in order, with
   `validate('platform.resource-offer@1', offer)`. The envelope is Network-local (as `nodes.js:54-57` validates a whole
   body against `network.node-report-request@1`) because no `platform.resource-offer-report@1` exists. On the first bad
   offer the request ends there, with `400 {error: 'offer 3 does not match platform.resource-offer@1',
   details: (v.errors || []).slice(0, 5)}`. No transaction has been opened, so a bad offer anywhere in the batch —
   including the last of 500 — leaves the table byte-for-byte unchanged: no upsert, no mark-down, no partial batch.
2. **Write pass, one transaction.** Only once the whole array has validated does `db.tx(async () => …)` run: one
   `INSERT … ON CONFLICT(id) DO UPDATE` per offer with the mapped column values, then the mark-down of the same
   source's absent ids, all inside that single transaction, which commits or rolls back as a unit. There is **no second
   validation inside the write loop** — re-validating per row there would make "a bad offer writes nothing" a property
   of the transaction's rollback rather than of the validation pass, and would give a batch that failed halfway through
   the loop the same (correct) outcome by a different, untested route. `nodes.js` has the same shape: it validates the
   whole body before its loop, because there is no per-node contract to check; here the per-item check moves into that
   same up-front pass.

Body `express.json({limit: '256kb'})`; array capped at 500, matching `network.node-report-request.v1.json`'s
`maxItems`.

**Routing** — mounted in `server/index.js` beside the node routers: `app.use('/internal/resources', internal)` and
`app.use('/api/v1/resources', pub)`. `ensureSchema(db)` is added to the boot work in `server/db/database.js` next to
the nodes call, purely as documentation.

## 4. Public read API

| Route | Behaviour | Cache |
|---|---|---|
| `GET /api/v1/resources` | `{offers: [<platform.resource-offer@1> minus capacity…], generated_at, filters, count}`; filters `?kind=&region=&trust=&status=&cell=&max_price_usd=`; **default excludes `status='down'`** | `public, max-age=60`, `ACAO: *`, `Timing-Allow-Origin: *` |
| `GET /api/v1/resources/:offer_id` | the single offer minus capacity (any status), or 404 `problem+json` `registry.unknown_offer` via `contracts.http.sendProblem` | `public, max-age=60` |
| `GET /api/v1/resources/:offer_id/beacon` | 204 — the same idiom as `nodes.js:52`, for `openvibe-sdk/geo` | `no-store` |
| `GET /internal/resources` | the same list and filters, docs **whole** (capacity included); the report's guard, `network.node.report` | `no-store` |
| `GET /internal/resources/:offer_id` | the single offer whole, or 404 `registry.unknown_offer`; the same guard | `no-store` |

**Exposure (decided, slice 2).** `platform.resource-offer@1` describes itself as *first-party only: it carries capacity
the public node registry (`network.node@1`) deliberately leaves out*. So the unauthenticated `/api/v1/resources` list and
single read return each contract document verbatim **except the `capacity` object**, which is omitted (`capacity` is
optional in the contract, so the public doc still validates). Everything else — capabilities, region, cell, trust,
health, pricing, latency — is what `openvibe-sdk/geo` and a planner's trust/price filter need, and is no more than the
public node list already says. The full documents, capacity included, are read from `GET /internal/resources[/:id]`,
behind exactly the guard of `POST /internal/resources/report` (`network.node.report` today, the one-line switch in
slice 5): that is the read `placement.plan()` consumers use, since capacity is what it places on. No capability is added
to Contracts for this; a dedicated read capability, if one is wanted, arrives with T1 like `network.resource.report`.

- Filters are applied in **SQL**, not JS. A `kind` the pinned contract does not define yields an empty list with 200,
  never a 500. Unknown query keys are ignored. `?status=down` is how a caller sees the hidden-down rows.
- Query values are taken once, as strings; `max_price_usd` must be a finite number ≥ 0, else it is ignored. `filters`
  echoes only the filters that were applied.
- `offers[]` elements are the contract documents **verbatim** (the public list minus `capacity`) — no envelope fields are added inside them, so a client can
  pass the array straight into `plan()`. `filters` and `count` live beside `offers`, never inside it. The convenience
  columns (`cell`, `price_usd`) are therefore *not* re-added to each doc: a doc that omitted `cell` is returned without
  one, exactly as reported.

## 5. Consumption by `openvibe-sdk/placement`

`openvibe-sdk/placement` (`src/placement.js`) is pure: `plan(requirements, offers, {rateCards, states, now, current}) →
platform.placement-result@1`. Network is the registry, not the planner, and imports nothing from the SDK in production
code. The contract between the two is therefore exact:

- **`offers[]` is `platform.resource-offer@1` verbatim**, so `plan()` consumes the HTTP response unchanged. A planner
  that weighs capacity reads `GET /internal/resources`; the public list has no `capacity` (§4).
- `trust` and `health.status` must use the enums the planner knows — `first-party|partner|community|external`
  (`TRUST_ORDER`) and `up|degraded|down|draining` (`HEALTH_OK`). `down` and `draining` are excluded by the planner, so the
  registry stores them faithfully and lets the default list hide only `down`.
- `price_usd` **is** `pricing.marginal_usd_per_unit`, `0` when the field is absent — the same mapping as the column in
  §2, so `?max_price_usd=` filters exactly the price the planner would marginalise. Network never recomputes a price;
  the SDK's `marginalCost` / `priceOf` do. `pricing.rate_card` points at a `platform.rate-card@1` id and is not
  dereferenced here.
- `capabilities[]` items are `namespace:name` strings (`node:http`, `events:gateway`, `object:r2`, …) — the contract's
  own pattern; they are stored, not interpreted.

### Worked example — `GET /api/v1/resources?kind=provider` → `plan()`

Two provider offers in one region, both `health.status: 'up'` and priced per request at `$0.02` and `$0.03`:

```json
GET /api/v1/resources?kind=provider
{ "offers": [
    { "offer_id": "p-provider",   "kind": "provider", "region": "us-central", "trust": "community",
      "health": { "status": "up" }, "pricing": { "model": "per-request", "marginal_usd_per_unit": 0.02 } },
    { "offer_id": "p-provider-b", "kind": "provider", "region": "us-central", "trust": "community",
      "health": { "status": "up" }, "pricing": { "model": "per-request", "marginal_usd_per_unit": 0.03 } }
  ] }
```

That `offers` array goes to `plan()` unchanged:

```js
const req = { kind: 'request', mobility: 'request', latency_class: 'interactive',
              objective: 'cheapest', region: 'us-central', capabilities: [], units: 1 };
const result = require('openvibe-sdk/placement').plan(req, response.offers, { now });
// → { selected: 'p-provider', objective: 'cheapest',
//     reasons: ['objective cheapest'], candidates: [ … ], decided_at: '<now as ISO>' }
```

The fields that matter: `selected` is the cheaper eligible offer (`p-provider`, `$0.02` < `$0.03`); every offer is
listed in `candidates` with `eligible: true` and its `estimated_cost_usd` (from `pricing.marginal_usd_per_unit`,
since the public list has no `capacity` to price prepaid capacity from); and the whole result validates as
`platform.placement-result@1`. `test/resource-registry.test.js` test 9 does exactly this — reporting a node offer
at `$0.05` alongside the two providers and feeding the **unfiltered** list, with `region: 'us-central'` narrowing
eligibility to the three — and asserts both the contract validity and the same winner.

## 6. Tests — `test/resource-registry.test.js`

Modelled on `test/nodes.test.js`: temp dir + `getDb()`, `oauth_clients.client_secret` set for `host` and `live`, a
generated RSA keypair, a bare `express()` app with `app.locals.{db, config, privateKey, publicKey}`, the two routers
mounted, a service token minted through `POST /oauth/token` `client_credentials`. Runner label line at the top.

1. **Auth matrix** — no token → 403; `x-internal-key: legacy-key` → 401/403 (the retired shared internal key is never
   accepted); a service token without the capability → 403.
2. **Validation, nothing written** — a well-formed offer → 200; `trust: 'random'`, a missing `region`, or an unknown extra
   property (`additionalProperties: false`) → 400 and a re-GET shows **zero** rows. Then the partial-batch case, which is
   the one that separates "validate the whole array first" from "validate inside the write loop": a batch of two good
   offers plus one bad offer *last* → 400, and the two good offers are **not** present either — no upsert ran, and the
   pre-existing row of that same source was not marked down. Validate-everything-then-write is what is under test.
3. **Upsert** — two offers from one source both listed; re-reporting the same `offer_id` with a changed `price_usd`
   updates both the doc and the column.
4. **Mark-down** — source A's offer missing from A's next report → `status='down'`, `doc.health.status='down'`,
   `checked_at` set, still listed under `?status=down`, header `X-Offers-Marked-Down: 1`; source B untouched.
5. **Filters** — `?kind=provider`, `?region=`, `?trust=community`, `?max_price_usd=0.05`, `?cell=wnam-1`; the default list
   excludes `down`; an unknown `kind` returns `{offers: []}` with 200. The public list never contains `capacity`; the
   internal list returns the stored docs whole and refuses a call without the guard's token.
6. **Single read** — `GET /internal/resources/:id` is the stored doc, `GET /api/v1/resources/:id` the same minus
   `capacity`, both matching `platform.resource-offer@1`; an unknown id → 404 `registry.unknown_offer` on both.
7. **Headers** — `cache-control: public, max-age=60` and `access-control-allow-origin: *` on list and single; beacon 204
   with `no-store` and `timing-allow-origin: *`.
8. **Schema lockstep** — after a report, every row is compared against the **mapping table in §2**, not against a
   guessed field path: `id === doc.offer_id`, `kind === doc.kind`, `region === doc.region`, `trust === doc.trust`,
   `status === doc.health.status`, `price_usd === (doc.pricing.marginal_usd_per_unit ?? 0)`, and
   `cell === (doc.cell ?? 'wnam-1')`. The suite reports at least one offer **without** `cell` and at least one without
   `pricing.marginal_usd_per_unit`, so the two defaulted columns are covered rather than assumed. The assert helper is
   written once against the mapping and reused by the upsert test and the mark-down test, so SQL and the test cannot
   drift apart. This is the invariant a later migration or a partial write breaks.
9. **Placement proof** (slice 4) — feed a live `GET /api/v1/resources` response into
   `require('openvibe-sdk/placement').plan()` and assert the result matches `platform.placement-result@1`.

Run `node test/resource-registry.test.js` while iterating, `npm run test:pg` (`NETWORK_TEST_STORE=pg`) for the SQL
filter path — PGlite and a real PostgreSQL must agree on it — and `npm test` once at the end.

## 7. Slices — five, each independently mergeable

1. **Table + report (write path).** `migrations/0007_resource_registry.sql`, `server/registry/offers.js` (`ensureSchema`
   no-op + `report`), the `ensureSchema` call in `server/db/database.js`, `app.use('/internal/resources', internal)` in
   `server/index.js`, `test/resource-registry.test.js` tests 1-4. Guard reuses `network.node.report`.
2. **Public read + filters.** `list()`, `get()`, `routers().pub` in `server/registry/offers.js`,
   `app.use('/api/v1/resources', pub)`, tests 5-7. Also the full internal read (`GET /internal/resources[/:id]`, the
   report's guard), because the public read leaves capacity out (§4).
3. **Discovery entry.** (done) Add `resources: '/api/v1/resources'` to the `/api/v1/registry` index in
   `server/registry/ecosystem.js`. Nothing else.
4. **Placement consumption proof.** (done) §5 gains a worked example; test 9 added. No production-code change — this
   slice exists to fail loudly if the response shape drifts from what `plan()` accepts.
5. **Contracts bump + kind widening.** *Blocked on T1.* `package.json:30` pin bump, a
   `node -e "validate('platform.storage-offer@1', …)"` smoke check, `migrations/0009_resource_offer_kinds.sql` widening
   the `kind` CHECK to the published kinds, the one-line capability switch, a `KIND → CONTRACT` map used for per-kind
   validation (`validate(KIND_CONTRACT[kind], offer)` when the map has an entry, else the base offer contract), and a
   test per new kind. Nothing waits on this slice; it is only startable once T1 publishes the tags, and
   `scripts/contracts-drift.js` is what flags the pin in the meantime.
   **Re-planned** in `docs/t2-cells-and-node-principal.md` §6 (per-kind offer as `detail`, slice N6); it supersedes this item.

## 8. Unresolved

- **T1's contract release** blocks slice 5 and nothing else. Until it lands, five roadmap offer kinds are documented and
  unreachable, and the registry accepts `node` and `provider` only.
- **Route weight and `service_instance`** are first-class in the roadmap but absent from `platform.resource-offer@1`
  (it has no route-weight field and no service-instance reference). They belong to `platform.placement-plan@1` /
  `platform.service-instance@1`, neither of which is at v0.83.0, so they cannot be modelled here now.
- **`network.resource.report`** does not exist at v0.83.0; `network.node.report` is reused for slice 1. The semantic
  mismatch (nodes reporting offers) is deliberate and temporary, and it is the only reason slice 1 does not need T1.

## 9. Cells and node principals (lane B, first slice)

Built: `migrations/0008_cells_and_node_principals.sql`, `server/registry/cells.js`, `test/cells-registry.test.js`.
Plan T2: "cells now, hardware later" and "node identity is a Network principal", on today's single host.

**Schema.**

| Table | What it is | Constraints that carry the rule |
|---|---|---|
| `platform_regions` | `us-west`, … (`network.node@1`'s region pattern) + country | id pattern |
| `platform_cells` | `wnam-1`, … with region, residency, `status` (`planned\|active\|draining\|retired`), `route_weight` | region FK; the migration seeds `us-west` and `wnam-1` (`active`) |
| `platform_node_principals` | one per machine: `nod_<ULID>`, `node_id` (unique), `home_cell`, owner, `trust`, `status` (`active\|draining\|revoked`) | `owner_kind = 'platform'` ⇔ no project and `first-party`; `owner_kind = 'project'` ⇔ a `dev_projects` row and never `first-party`; `revoked` ⇔ `revoked_at`; home cell FK |
| `platform_service_instances` | `platform.service-instance@1`'s columns (`state` is its enum) + `route_weight`, `source` | `(node_id, cell)` FK to the principal's `(node_id, home_cell)`: an instance runs on a registered node, in its home cell |
| `dev_projects.home_cell` | `project.home_cell` | FK to cells; existing rows take `wnam-1` |
| `platform_resource_offers.cell` | (0007) | FK to cells, `NOT VALID`: new writes are checked, rows written before 0008 are not |

Ownership reuses `dev_projects` (the project is the ownership boundary) and the trust classes of
`platform.resource-offer@1`; no second identity store, no new capability string.

**The node-principal boundary.** A report never assigns identity, owner, trust class or home cell:

- Host's node report (`POST /internal/nodes/report`, `network.node.report`) creates a platform-owned, first-party
  principal for a machine it is the first to name, in the first active cell of the machine's region, else `wnam-1`.
  It is refused whole (`409 registry.node_not_platform` / `registry.node_revoked`, nothing written, nothing marked down)
  when it names a machine a project owns or one that was revoked.
- At boot, every machine already in `platform_nodes` without a principal gets its platform principal (the backfill;
  `created_by = 'bootstrap'`).
- An offer (`POST /internal/resources/report`) must name a known, non-retired cell (`400 registry.unknown_cell`,
  `409 registry.cell_retired`); an offer for a registered node must carry that node's home cell and trust class
  (`409 registry.node_cell_mismatch`, `registry.trust_mismatch`, `registry.node_revoked`). Checked before anything is
  written, like the contract validation.
- A node principal holds no token yet: `identity.service-token-claims@1` has no node actor, and a `nod_` id is refused
  as a client-credentials client (`unauthorized_client`).

**Read API.** `GET /api/v1/cells` and `/api/v1/cells/:id` (public, `max-age=60`, `ACAO: *`; 404
`registry.unknown_cell`): id, region, residency, status, route weight. `GET /internal/registry/cells/:id`
(`network.registry.read`, `no-store`): the cell's nodes (principal id, owner, trust, status, health from the node
registry), service instances and offers (capabilities, capacity). Project machines are never public.

**Not in this slice.** A writer for service instances and for project-owned principals (pairing credentials) — both
wait for the contracts pin bump to v0.84.0, which publishes `platform.service-instance@1` and
`platform.node-capabilities@1`; the node actor in service-token claims; a second physical cell, WireGuard, geo routing.
