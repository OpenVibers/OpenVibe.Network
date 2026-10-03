# T2 lane B — cells, the node principal and registry slice 5 (design)

Status: **N1–N7 merged** on `origin/main` `011355a` (registry slice 5, the node principal, node tokens and the registry
operator writers; each slice's state is in §8). The cells layer of `docs/t2-resource-registry.md` §9 was already on
`origin/main` (`d6ed8c4`, PR #5: `migrations/0008_cells_and_node_principals.sql`, `server/registry/cells.js`,
`test/cells-registry.test.js`); this document designed the rest of lane B on top of it and re-planned registry slice 5.
Pinned: Network `openvibe-contracts` **v0.85.0** (`package.json:33`), which closes every contract gap in §2 and the §9.1
T1 brief (the doc was written against v0.83.0, checked then against v0.84.0). OpenVibe.Bot
`origin/main` `17ce069` (pins Contracts v0.79.0, `package.json:29`), OpenVibe.Node `origin/main` `4d2b8e1`. Bot is not
deployed (`ov access run openvibe-ovh releases bot` → `unknown service "bot"`), so no production device exists.

Scope (plan §3 T2, T14, T15): "cells now, hardware later" finished on today's single host, and "node identity is a
Network principal": Network owns the node principal and its pairing credentials; Node presents capabilities; Bot keeps
robots, the robot binding, profiles, operators, command leases and physical safety. Not in scope: a second physical cell,
WireGuard, geo routing, a scheduler, Run/Media/Actor bindings (they reuse what is built here).

## 1. Precedent — what exists

| Piece | Where | Reused as |
|---|---|---|
| Cells, regions | `0008:9-26` (`platform_regions`, `platform_cells` with `residency`, `status` incl. `draining`, `route_weight`; seeds `us-west`, `wnam-1`) | the cell model, unchanged |
| Node principal | `0008:28-49` `platform_node_principals` (`nod_<ULID>`, `node_id` unique, `home_cell`, `owner_kind platform\|project`, `trust`, `status active\|draining\|revoked`); owner rule `0008:42-44` | extended (§3), never duplicated |
| Service instances | `0008:51-66` `platform_service_instances`; FK `(node_id, cell)` → principal `(node_id, home_cell)` `0008:64` | gets its writer (§4.1) |
| `project.home_cell` | `0008:68` `dev_projects.home_cell` default `wnam-1` | unchanged |
| `resource.home_cell` | `0007:13` `platform_resource_offers.cell` + FK `0008:70` (NOT VALID) | **is** the resource home cell; no new column |
| Node registry | `0001_initial.sql:651-657` `platform_nodes` (doc, status = health); `server/registry/nodes.js:19-41` report, adopt at `:27-28` | the **only** store of platform machine health; public list stays platform-only |
| Adoption, placement checks | `cells.js:23-29` (boot backfill), `:32-35` `cellForRegion`, `:49-58` `adoptPlatformNodes`, `:64-78` `checkPlacement` (called from `offers.js:144`) | reused by pairing and by the instance writer |
| Topology read | `cells.js:92-109` (`health: 'unknown'` for a principal with no `platform_nodes` row, `:98`) | gains `last_seen_at` and capabilities |
| Guards | `principals.js:344-345` `guard()` throws `unknown capability` at boot; `index.js:466,473,480` mount nodes/offers/cells with `network.node.report` and `network.registry.read`; `DEFAULT_GRANTS` `principals.js:151` (host → `network.node.report`), `:197` (live → `network.registry.read`) | no capability is invented (§5) |
| Service tokens | `principals.js:303-325` `issueToken` (refuses a non-slug client at `:306`), called from `oauth-routes.js:230-237`; claims validated by `assertValid('identity.service-token-claims@1')` `:323` | a node branch beside it (§4.3) |
| Service OAuth clients | `database.js:85-106` `contractClients` seed (no `bot`); `server/setup/service-principal.js` (owner provisions a secret into `/etc/openvibe/<id>.env`) | `bot` added to the seed |
| Principal precedents | `mod:<mod_id>` (`identity/mod-principals.js:24`, contract `network.mod-principal@1`); `agt_` (designed, `docs/t2-projects-and-grants.md`) | same shape: a `<type>:<prefix>_<ULID>` sub |

Bot today (`OpenVibe.Bot` `origin/main`), the thing being moved:

| Bot piece | Where |
|---|---|
| `devices` (`dev_<ULID>`, `robot_ids`, `kind onboard\|bridge\|server`, `drivers`, `capabilities`, `credential_hash`, `credential_prev_hash`, `prev_valid_until`, `publish_key_hash`, `revoked_at`) | `migrations/0001_bot.sql:39-60` |
| `pairing_codes` (`pair_<ULID>`, `robot_id`, `code_hash`, `expires_at`, `tries`, `used_at`) | `0001_bot.sql:63-75` |
| Code: 8 Crockford chars `XXXX-XXXX`; redeem (10 min, 5 tries, once) | `server/domain/index.js:39-49`, `:180-218` |
| Credential: 32 random bytes, sha256 stored, rotate keeps the old one `rotateGraceMs` (60 s), revoke instant | `domain/index.js:232-260`; `server/config.js:78` |
| Device link auth: `Authorization: Bearer <credential>` on `wss://openvibe.bot/device`, bad → close 4002 | `server/realtime.js:78-86,109-111`; `docs/protocol.md:23-36` |
| REST: `POST /pair` (code is the credential), `POST /devices/:id/rotate\|revoke` | `docs/protocol.md:298-303` |
| Service-token subs accepted | `server/api/auth.js:15` `PRINCIPAL_SUB = /^(svc\|app\|mod):/` |
| Tests | `test/pairing.test.js:13,27,36,48,67` (once; 10 min expiry; 5 tries; never logged; rotate 60 s / revoke disconnects) |

Node today (`OpenVibe.Node` `origin/main`): pairs with `POST <server>/api/v1/pair` (`internal/link/pair.go:47-48`),
`server` defaults to `https://openvibe.bot` (`internal/config/config.go:25`), stores `{device_id, credential,
publish_key, server, device_url}` mode 0600 (`internal/credentials/credentials.go:1,59-66`), and holds one outbound
WebSocket with the credential in the upgrade's `Authorization` header (`internal/link/link.go:1-2`; `docs/HANDOFF.md:40-42`).

## 2. Decision A — cells on one host: reuse, extend, never a second truth

Every plan field and the one place it lives:

| Plan field | Lives in | State |
|---|---|---|
| `cell_id` | `platform_cells.id` | built |
| `node_id` | `platform_node_principals.node_id` (identity) = `platform_nodes.id` (public platform doc) | built |
| `service_instance_id` | `platform_service_instances.id` | built; writer in slice N2 |
| `project.home_cell` | `dev_projects.home_cell` | built; shown in the project view (N3) |
| `resource.home_cell` | `platform_resource_offers.cell` | built |
| `preferred_regions` | `dev_projects.preferred_regions` (`0015_project_regions.sql`, N3) | built |
| `residency` | `platform_cells.residency`; a project's residency **is** its home cell's (no project column) | built |
| `capacity` | per offer: `platform_resource_offers.doc.capacity` (built); per machine: `platform_node_capabilities.doc` (`platform.node-capabilities@1`, `0014_node_pairing.sql`, N4c) | built |
| `health` | platform machine: `platform_nodes.status`; paired machine: `platform_node_principals.last_seen_at` (`0014_node_pairing.sql`); instance: `state`; offer: `status`; cell: `status` | built |
| `route_weight` | `platform_cells.route_weight`, `platform_service_instances.route_weight` | built; **never taken from a report** |
| `draining` | `platform_cells.status`, `platform_node_principals.status`, instance `state`, offer `status` | built |

Rules that keep one source of truth:

1. **`platform_nodes` is not replaced and not widened.** It stays what `network.node@1` says it is: "one machine of the
   OpenVibe platform", public. A paired (user or project) machine gets a principal and **no** `platform_nodes` row, so it
   never appears in `GET /api/v1/nodes`. The principal table is the identity of every machine; `platform_nodes` is the
   public health doc of platform machines only. Joined by `node_id`, as `cells.js:95-98` already does.
2. **Home cell, owner, trust are assigned by Network**, never by a report (`cells.js:7-10` boundary, kept): pairing sets
   them from the pairing code (§4.2); a report that disagrees is refused (`checkPlacement`, and the instance writer).
3. **Route weight** is a routing decision: reports never carry it; a first insert takes the column default (100), an
   upsert leaves the stored value. Writing weights waits for the scheduler (§8).
4. **Instance region** is derived from its cell: the table has no `region` column; the writer refuses an instance whose
   `region` ≠ its cell's region (`400 registry.region_mismatch`) and reads re-add it from `platform_cells.region`.

Contract gaps opened at v0.84.0 and **all closed by the v0.85.0 pin** (`package.json:33`); each was an item of the T1
brief, §9.1:

| Contract | Has | Closed at v0.85.0 |
|---|---|---|
| `platform.service-instance@1` (required `id service version cell node region endpoints state started_at`, `additionalProperties:false`) | the row's fields | optional `route_weight` (0–1000), so a read that carries the stored weight still validates |
| `platform.node-capabilities@1` (required `node_id cpu arch memory_mb storage network regions tags costs`; `costs.per_hour_usd` required) | hardware, regions, costs | optional `capabilities[]` (the resource-offer pattern `^[a-z][a-z0-9-]*:[a-z0-9.-]+$`, e.g. `robot:drive`, `video:whip`) so Bot binds to presented capabilities; optional `agent_version`; optional `updated_at` |
| `network.node@1` (required `id roles location health updated_at`, `additionalProperties:false`) | public platform machine | optional `cell` (Network fills it on read from the principal; a report carrying a different one is refused `409 registry.node_cell_mismatch`) |
| `identity.service-token-claims@1` (`sub` pattern `svc:\|app:\|mod:`, `actor_type` `service\|app\|mod`, lines 24-33) | — | node actor: `sub` gains `node:nod_<ULID>`, `actor_type` gains `node` (§4.3) |
| `lib/ids.js` (`PREFIX` line 9, `SUBJECT_TYPES` line 13, `principalSub` lines 54-57) | — | `node: 'nod'`, `principalSub({type:'node'})` → `node:nod_…` (not a SubjectRef type: a node never authors content) |

## 3. Migrations (exact columns)

Numbers: `0009` is reserved for slice 5 (`docs/t2-resource-registry.md` §2), `0010-0013` for WS-Z2
(`docs/t2-projects-and-grants.md`). Each slice below takes **the next free number when it is built**; the names are
fixed. Header convention as `0008` (`-- phase: expand`, `-- plan T2. <why>`, blank line, DDL, `IF NOT EXISTS`).

### 3.1 `00NN_project_regions.sql` (slice N3)

```sql
ALTER TABLE dev_projects ADD COLUMN IF NOT EXISTS preferred_regions text COLLATE "C" NOT NULL DEFAULT '[]';
```

A JSON array of `platform_regions.id`, at most 5, unique, order = preference. An array cannot carry a foreign key, so
the setter validates every id against `platform_regions` in the same transaction (`400 registry.unknown_region`).
`text`, not `jsonb`, as every other JSON column here (`dev_projects.allowance`, `platform_nodes.doc`).

### 3.2 `00NN_node_pairing.sql` (slice N4a)

```sql
ALTER TABLE platform_node_principals
    ADD COLUMN IF NOT EXISTS owner_subject        text COLLATE "C",
    ADD COLUMN IF NOT EXISTS name                 text COLLATE "C" CHECK (length(name) BETWEEN 1 AND 80),
    ADD COLUMN IF NOT EXISTS credential_hash      text COLLATE "C" CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN IF NOT EXISTS credential_prev_hash text COLLATE "C" CHECK (credential_prev_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN IF NOT EXISTS prev_valid_until     text COLLATE "C",
    ADD COLUMN IF NOT EXISTS paired_by_service    text COLLATE "C" CHECK (paired_by_service ~ '^[a-z][a-z0-9-]{1,39}$'),
    ADD COLUMN IF NOT EXISTS pairing_ref          text COLLATE "C" CHECK (length(pairing_ref) BETWEEN 1 AND 80),
    ADD COLUMN IF NOT EXISTS last_seen_at         text COLLATE "C";

ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_owner;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_owner CHECK (
       (owner_kind = 'platform' AND project_id IS NULL AND owner_subject IS NULL AND trust = 'first-party')
    OR (owner_kind = 'project' AND project_id IS NOT NULL AND owner_subject IS NULL AND trust <> 'first-party')
    OR (owner_kind = 'user' AND project_id IS NULL AND owner_subject IS NOT NULL
        AND owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$' AND trust = 'community'));
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_owner_kind_check;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_owner_kind_check
    CHECK (owner_kind IN ('platform', 'project', 'user'));
-- A paired machine always holds a credential; a platform machine reported by Host holds none (yet).
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_credential;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_credential
    CHECK (owner_kind = 'platform' OR credential_hash IS NOT NULL) NOT VALID;
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_prev;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_prev
    CHECK ((credential_prev_hash IS NULL) = (prev_valid_until IS NULL));
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_paired;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_paired
    CHECK ((paired_by_service IS NULL) = (pairing_ref IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS platform_node_principals_credential_idx ON platform_node_principals (credential_hash)
    WHERE status <> 'revoked' AND credential_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_node_principals_prev_idx ON platform_node_principals (credential_prev_hash)
    WHERE status <> 'revoked' AND credential_prev_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_node_principals_user_idx ON platform_node_principals (owner_subject) WHERE owner_subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_node_principals_paired_idx ON platform_node_principals (paired_by_service, pairing_ref) WHERE paired_by_service IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_node_pairings (
    id            text COLLATE "C" PRIMARY KEY CHECK (id ~ '^pair_[0-9A-HJKMNP-TV-Z]{26}$'),
    code_hash     text COLLATE "C" NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    owner_kind    text COLLATE "C" NOT NULL CHECK (owner_kind IN ('project', 'user')),
    project_id    text COLLATE "C" REFERENCES dev_projects(id),
    owner_subject text COLLATE "C",
    service       text COLLATE "C" NOT NULL CHECK (service ~ '^[a-z][a-z0-9-]{1,39}$'),
    ref           text COLLATE "C" NOT NULL CHECK (length(ref) BETWEEN 1 AND 80),
    home_cell     text COLLATE "C" REFERENCES platform_cells(id),
    created_by    text COLLATE "C" NOT NULL,
    created_at    text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    expires_at    text COLLATE "C" NOT NULL,
    tries         integer NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 5),
    used_at       text COLLATE "C",
    principal_id  text COLLATE "C" REFERENCES platform_node_principals(id),
    CONSTRAINT platform_node_pairings_owner CHECK (
           (owner_kind = 'project' AND project_id IS NOT NULL AND owner_subject IS NULL)
        OR (owner_kind = 'user' AND project_id IS NULL AND owner_subject IS NOT NULL
            AND owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')),
    CONSTRAINT platform_node_pairings_used CHECK (principal_id IS NULL OR used_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS platform_node_pairings_ref_idx ON platform_node_pairings (service, ref, created_at);

CREATE TABLE IF NOT EXISTS platform_node_capabilities (
    node_id       text COLLATE "C" PRIMARY KEY REFERENCES platform_node_principals(node_id),
    doc           text COLLATE "C" NOT NULL,
    reported_at   text COLLATE "C" NOT NULL
);
```

Deliberate decisions:

- **`owner_kind = 'user'`.** A robot owner is a person (`robots.owner_subject usr_…`, `0001_bot.sql:22`), not a
  developer project, and `dev_projects` has no personal project (`0001_initial.sql:436-446`). Creating developer
  projects for every robot owner would put them in the developer console with allowances and environments they never
  asked for. A user's machine is `community` trust: it is not first-party, and it is offered to nobody until an offer
  says so. If the owner later decides "every person has a personal project", the move is one `UPDATE` per row.
- **The `0008` owner_kind CHECK is unnamed inline** (`0008:32`), so PostgreSQL names it
  `platform_node_principals_owner_kind_check` (confirmed on PGlite with `SELECT conname FROM pg_constraint WHERE
  conrelid = 'platform_node_principals'::regclass` after `0007`+`0008`; likewise `0007:11` is
  `platform_resource_offers_kind_check`). Every `ADD CONSTRAINT` is preceded by `DROP CONSTRAINT IF EXISTS`, so the
  migration applies twice cleanly, and every regex CHECK on a nullable owner column is paired with `IS NOT NULL`
  (a `NULL ~ '…'` is NULL, which a CHECK lets through). The whole block was applied twice on PGlite over `0007`+`0008`
  while writing this, with the N4a accept/reject cases of §7.
- **The credential mirrors Bot's exactly** (sha256 of 32 random bytes, previous hash valid for a grace window,
  revoke clears the previous): the semantics `test/pairing.test.js` already proves move unchanged.
- **`paired_by_service` + `pairing_ref` are not the robot binding.** They record which service asked for the pairing
  and its opaque reference (`rob_…`), so only that service can read or revoke the principal and Bot can find its binding
  on first connect. Robot ↔ device, profiles, operators, leases and safety stay in Bot's tables.
- `platform_node_capabilities.doc` is the verbatim `platform.node-capabilities@1` the node presents (text, as every doc).
  The FK targets `node_id` (unique, `0008:30`).
- Pairing codes live in Network, not Bot (plan: "Network owns … pairing credentials"); `pair_` is Bot's own id shape,
  kept so the two never need translating. The ids are Network-local (not SubjectRefs) and need no Contracts prefix.

## 4. Decision B — node principal: module and API

### 4.1 Service instances — `server/registry/instances.js` (slice N2)

A copy of `nodes.js` / `offers.js`: `report(db, {source, instances}, now)` → `{instances, stopped}`; validate the whole
batch first (envelope `{source, instances}`, `source` `^[a-z][a-z0-9-]{1,39}$`, ≤ 500, each item
`validate('platform.service-instance@1')`), then placement (cell exists and is not `retired`; `node` is a principal,
not `revoked`, whose `home_cell` = `cell` → `409 registry.node_cell_mismatch` / `registry.node_revoked` /
`400 registry.unknown_node`; `region` = the cell's region → `400 registry.region_mismatch`), then one `db.tx`: upsert
by `id` (`route_weight` untouched on update), and every instance of the same `source` absent from the report and not
already `stopped` is set to `stopped` (never deleted). `endpoints` is stored as JSON text (`0008:57`).

Route: `POST /internal/registry/instances/report`, guard `network.node.report` (Host reports machines **and** what runs
on them; Host holds it, `principals.js:151`), mounted in `server/index.js` beside `cellRouters` (`:480-482`) as
`app.use('/internal/registry/instances', …)` **before** `app.use('/internal/registry', cellRouters.internal)`. Header
`X-Instances-Stopped`. Read: the existing topology (`cells.js:100-103`) plus `region` from the cell. No public route:
instances carry endpoints.

### 4.2 Pairing — `server/registry/node-principals.js` (slices N4b, N4c)

| Route | Auth | Behaviour |
|---|---|---|
| `POST /internal/node-pairings` | service token, `network.node.manage` | body `{owner: {kind:'user', subject:'usr_…'}, ref, home_cell?}`; the requesting service is the token's `svc:<id>`. Refuses an unknown, banned or deleted user (`404 registry.unknown_owner`) and a `home_cell` that is not `active`. Deletes that service's unused codes for the same `ref` (Bot's rule, `domain/index.js:164`), inserts one, → `201 {pairing_id, code: 'XXXX-XXXX', expires_at}`; the code is shown once, only its sha256 stored. TTL 10 min. `owner.kind:'project'` → `501 registry.not_yet` in this slice (§8). |
| `POST /api/v1/node-pairing` | none: the code is the credential; `rateLimit({windowMs: 60_000, max: 10})` on the route | body `{pairing?: 'pair_…', code, name?, region?}`. Same outcomes as Bot's redeem (`domain/index.js:180-205`): `422 registry.invalid_pairing_code` (shape), `403 registry.pairing_code_invalid\|_used\|_expired\|_locked`; with `pairing` a wrong code counts a try against that row, 5 kills it. In one `db.tx`: mark used, create the principal (`nod_<ULID>`; `node_id = 'n-' + ulid.toLowerCase()`, 28 chars, matches `network.node@1`'s id pattern; owner from the code; `trust` `community` for a user; `home_cell` = the code's, else `cellForRegion(region)` `cells.js:32`; `paired_by_service`/`pairing_ref` from the code; `created_by = 'pairing:<pair_id>'`), set `principal_id` on the code. → `201 {principal, node_id, home_cell, credential, token_endpoint: '<issuer>/oauth/token', paired_for: {service, ref}}`; `credential` shown once, `Cache-Control: no-store`, never logged. |
| `GET /internal/node-principals/:id` | `network.node.manage` | only a principal whose `paired_by_service` is the caller (else `404 registry.unknown_node`, never 403, so a service cannot probe others) → `{principal, node_id, name, owner, home_cell, status, paired_for, last_seen_at, created_at, revoked_at}`. No hash ever. |
| `POST /internal/node-principals/:id/revoke` | `network.node.manage`, same scoping | `status = 'revoked'`, `revoked_at`, `revoked_by = 'svc:<id>'`, previous hash cleared; idempotent. |
| `GET /api/v1/me/nodes`, `POST /api/v1/me/nodes/:principal/revoke` | session (`requireAuth`), the owner only (slice N5) | the person's own machines (`owner_subject = me`): the same view; revoke as above with `revoked_by = usr_…`. |

### 4.3 Node tokens and self routes (slice N4c)

**Token.** `POST /oauth/token` `grant_type=client_credentials` with `client_id = nod_…`, `client_secret = credential`,
`audience`. Branched in `oauth-routes.js:230` **before** `principals.issueToken` (`if (/^nod_/.test(client_id)) return
nodePrincipals.issueNodeToken(…)`), so `principals.js:306` stays as it is. One `401 invalid_client` for every refusal
(unknown, revoked, wrong or expired-previous secret). The audience must be `openvibe.network` or
`openvibe.<paired_by_service>` (`400 invalid_scope` otherwise): a Bot-paired machine can talk to Network and Bot only.

| Claim | Value |
|---|---|
| `sub`, `actor_type` | `node:nod_<ULID>`, `node` |
| `aud` | `[audience]` |
| `cap` | `openvibe.network` → `['network.node.self.manage']`; any other audience → `[]` (the receiving service authorises a node by its own binding, not by a capability) |
| `project_id` | the owning project, when `owner_kind = 'project'` |
| `iat`, `exp`, `jti` | 300 s (`TOKEN_TTL_S`), `tok_` + 12 random bytes hex, as `principals.js:321` |

Validated with `assertValid('identity.service-token-claims@1')` like every token (`principals.js:323`). Issuance sets
`last_seen_at` when it is older than 60 s — the health of a paired machine.

**Self routes** (guard `principals.guard('network.node.self.manage')`, no option). The guard checks the signature,
audience and capability only: it has no node-ownership option (`principals.js:344` takes `ownApp` and `namespace`, and
`ownApp` compares against `sub` stripped of `svc:`, `:391-393`), and nothing enforces a manifest's
`resourceConstraints: ['owner']`. So each self handler does the ownership check itself, before any write: take the
verified `req.principal.sub`, require `/^node:(nod_[0-9A-HJKMNP-TV-Z]{26})$/` (else `403 capability.owner_denied`),
load that `node_principals` row and require `status = 'active'` (else `401 registry.node_revoked`, since a token can
outlive a revoke by ≤ 300 s); the row's `node_id` and `id` are the only ones the handler then writes. The node is never
taken from the body or the path. Tested with a valid token for another node and a revoked node.

- `PUT /api/v1/node/self/capabilities` — body `platform.node-capabilities@1`; its `node_id` must equal the resolved
  row's `node_id` (`409 registry.node_mismatch`); upserts `platform_node_capabilities`. `regions` is what the machine can serve, never
  its home cell.
- `POST /api/v1/node/self/credential` — rotation by the machine itself: new credential (once), the old one valid 60 s
  (`credential_prev_hash`, `prev_valid_until`). The long-lived secret only ever travels between Network and the Node;
  no service relays it.

Topology (`cells.js:96-99`) gains `last_seen_at`, `name`, `paired_for` and the `capabilities` doc per node; a principal
without a `platform_nodes` row reports `health: 'up'` when `last_seen_at` is within 10 min, else `'unknown'`.

### 4.4 Who holds what

| Holder | Holds | Never holds |
|---|---|---|
| Network | the principal (`nod_`), owner, trust, home cell, status; pairing codes; credential hashes; node tokens; presented capabilities | robots, profiles, operators, leases, safety, publish keys |
| Bot | robot ↔ device binding (`devices.node_principal`), robots, profiles, operators, queue/leases, e-stop and limits, command audit, the WHIP publish key | any node credential (after B3), pairing codes (after B3) |
| Node | its credential (file 0600), short-lived tokens, the publish key Bot gave it; presents `platform.node-capabilities@1`; enforces local safety (deadman, latch) | anything it did not present |

## 5. Capabilities — none invented

`principals.guard` throws at boot on an id the catalog lacks (`principals.js:345`). At v0.84.0 the catalog has
`network.node.report` and `network.registry.read` and nothing for pairing; **no `bot.*` capability exists in the
catalog at all** (Bot's `bot.device.connect` etc. are Bot-local strings, `server/api/v1.js:36`). Therefore:

| Capability | Status | Used by |
|---|---|---|
| `network.node.report` | exists (`internal`, `active`) | Host's node report; also the instance report (N2) — T1 adds the route to its `implementedBy`, non-blocking |
| `network.registry.read` | exists | the topology read |
| `network.node.manage` | **T1 addition**, `internal`, `active`, `resourceConstraints: ['owner']` | N4b: pairing codes, scoped read and revoke; default grant `['bot', 'network.node.manage', SELF_AUDIENCE, []]` |
| `network.node.self.manage` | **T1 addition**, `internal`, `active`, `resourceConstraints: ['owner']` | N4c: the node's own capabilities and credential |
| `network.resource.report` | **T1 addition** (already planned, `t2-resource-registry.md` §3) | slice 5: the one-line switch in `index.js:473` |

`resourceConstraints: ['owner']` is declarative: no guard enforces it (§4.3). N4b's handlers scope every read and
revoke to `paired_by_service = <caller>` and N4c's self handlers to the token's own row; both are tested.

`bot` is not a seeded OAuth client (`database.js:85-106`); N4b adds `{ client_id: 'bot', name: 'OpenVibe.Bot',
redirect_uris: ['https://openvibe.bot/auth/callback'] }` (Bot's callback, Bot `server/config.js:54-56`).

## 6. Decision C — registry slice 5, re-planned

The §7 slice-5 plan ("widen the CHECK, validate the whole offer against the per-kind contract") does not fit v0.84.0:
`platform.resource-offer@1` `kind` is still `["node","provider"]` (`resource-offer.v1.json:22-26`); the five per-kind
contracts are **standalone** documents with their own ids and required fields and none of `offer_id`, `kind`, `trust`,
`health`, `pricing`, `updated_at` (`storage-offer` requires `id class capacity_gb price_per_gb_month_usd
price_per_operation_usd region node durability lifecycle_rules`; `delivery-offer` `id transports regions edge
price_per_gb_usd price_per_request_usd cache_rules`; `runtime-offer` `id kind region node limits price availability
constraints`; `agent-offer` `id harness provider model context_limits concurrency price_per_1k_tokens
availability_windows`; `harness-offer` `id name provider capabilities address price limits`). An offer cannot be both.

**Decided shape: the envelope stays `platform.resource-offer@1`; the per-kind document rides inside it as `detail`.**

- `kind` enum gains `storage`, `delivery`, `runtime`, `agent`, `harness` (widening passes the compat gate: it only
  flags removed values, `scripts/compat.js:30`).
- New optional property `detail` (`type: object`). A top-level `allOf` of five `if {kind: const X} then {required:
  ['detail'], properties: {detail: {$ref: 'X-offer.v1.json'}}}` — the same `allOf`/`if` idiom as
  `identity/service-token-claims.v1.json:86-106` and the relative `$ref` idiom of `ai/provider-manage-result.v1.json:14`.
  For `node` and `provider`, `detail` stays absent (a sixth `if` with `not: {required: ['detail']}`), so every v0.84.0
  offer is still valid and no old field becomes required (compat gate `:34`).
- What cannot be expressed in schema, Network checks before writing (`400`, nothing written, as `offers.js:37-49`):
  `detail.id === offer_id` (`registry.detail_id_mismatch`); when `detail.node` and `node_id` are both present they are
  equal (`registry.detail_node_mismatch`); `detail.region` (or every `detail.regions[]`) includes `region`
  (`registry.detail_region_mismatch`).
- The filter columns do not change: `kind`, `region`, `trust`, `status`, `cell`, `price_usd` keep the §2 mapping of
  `t2-resource-registry.md`; per-kind prices inside `detail` are not interpreted (the planner's job).
- `harness-offer` carries an `address`: the public list (which omits `capacity`) also omits `detail.address` for
  `kind: harness`; the internal read returns it whole.

Network side (slice N6): pin bump to the release; `migrations/0009_resource_offer_kinds.sql` (drop the unnamed `kind`
CHECK of `0007:11`, `platform_resource_offers_kind_check`, re-add with the seven kinds); `offers.js` `CONTRACT`
unchanged, plus the three cross-checks; `index.js:473` guard → `network.resource.report` and `DEFAULT_GRANTS` gains
`['host', 'network.resource.report', SELF_AUDIENCE, []]`; tests below.

## 7. Tests

All Network tests follow `test/cells-registry.test.js:1-30` (bare `express()`, generated RSA keys, `oauth_clients`
secrets set, tokens via `POST /oauth/token`), run with `node test/<file>.test.js` (PGlite) and
`NETWORK_TEST_STORE=pg node test/run.js` (`npm run test:pg`, `test/run.js:18`).

- **N2 `test/registry-instances.test.js`:** auth matrix (no token 403; token without `network.node.report` 403); a bad
  instance anywhere in the batch → 400 and zero rows; unknown node 400, node in another cell 409, revoked node 409,
  retired cell 409, region ≠ cell region 400 — each with nothing written; upsert keeps a hand-set `route_weight`;
  absent instance of the same source → `stopped`, other source untouched, `X-Instances-Stopped: 1`; topology lists it
  with `region`; every stored row re-validates as `platform.service-instance@1`.
- **N3 `test/developer-projects.test.js` (extend):** `PUT …/placement` by admin 200, by a member 403; unknown region 400;
  6 regions 400; duplicates 400; project view shows `home_cell: 'wnam-1'`, `residency: 'US'`, `preferred_regions`.
- **N4a `test/cells-registry.test.js` (extend):** the new constraints accept/reject — a `user` principal with `usr_`
  owner and `community` trust OK; `user` + `first-party` rejected; `user` without credential rejected; `platform` without
  credential OK; prev hash without `prev_valid_until` rejected; two live principals with one credential hash rejected;
  a pairing row with both owners rejected; migration applied twice (`IF NOT EXISTS`).
- **N4b `test/node-pairing.test.js`:** Bot's five checks moved verbatim (`pairing.test.js:13,27,36,48,67`: once; 10 min;
  5 tries; never logged and never in a read; revoke), plus: the code and credential appear in no log line and in no
  `GET`; `GET /internal/node-principals/:id` by another service → 404; pairing creates no `platform_nodes` row and the
  node is absent from `GET /api/v1/nodes`; home cell from `region`, else `wnam-1`; Host's report naming a paired
  `node_id` is refused `409 registry.node_not_platform` (`cells.js:43`).
- **N4c `test/node-tokens.test.js`:** credential → token whose claims validate as `identity.service-token-claims@1`
  with `sub node:nod_…`; audience `openvibe.bot` OK, `openvibe.chat` 400; revoked / wrong secret 401 with one message;
  rotation: new works, old works < 60 s and fails after (clock injected), revoke kills both; capabilities PUT with
  another `node_id` 409; node A's valid token cannot change node B's capabilities or credential (B's rows unchanged);
  a revoked node's still-unexpired token on either self route 401 `registry.node_revoked`; a `svc:` token holding
  `network.node.self.manage` 403 `capability.owner_denied`; topology shows `last_seen_at` and `health: 'up'`.
- **N5 `test/node-principals-me.test.js`:** a person lists only their machines; revoking another's → 404.
- **N6 `test/resource-registry.test.js` (extend):** one valid offer per new kind (fixtures copied from Contracts'
  `fixtures/platform.<kind>-offer/valid/`), each listed by `?kind=`; `kind: storage` without `detail` 400; `detail.id`
  mismatch 400; `kind: node` with `detail` 400; harness `detail.address` absent from the public read, present
  internally; test 8's lockstep mapping still holds; guard is `network.resource.report` and `network.node.report` alone
  is refused.

## 8. Slices — ordered, each independently mergeable

| # | Slice | Files | Blocked by | Model | State |
|---|---|---|---|---|---|
| N1 | Contracts pin → v0.84.0 | `package.json:32`, `package-lock.json`; a smoke `node -e "require('openvibe-contracts').validate('platform.service-instance@1', …)"` in the PR body | nothing (v0.84.0 published); full `npm test` + `npm run test:pg` | basic | **merged** at main `4e7b56b` (pin since N6 is `v0.85.0`) |
| N2 | Service-instance writer | `server/registry/instances.js` (new), `server/index.js` (mount), `test/registry-instances.test.js` | N1 | basic | **merged** |
| N3 | Project placement | `migrations/00NN_project_regions.sql`, `server/developer/store.js` (`setPlacement`, `projectView` + `home_cell`, `residency`, `preferred_regions`), `server/developer/routes.js` (`PUT /:project/placement`, audit `project.placement_changed`), test above | nothing | basic | **merged** (`0015_project_regions.sql`) |
| N4a | Pairing schema | `migrations/00NN_node_pairing.sql`, `test/cells-registry.test.js` | nothing | basic | **merged** (`0014_node_pairing.sql`) |
| N4b | Pairing + scoped read/revoke | `server/registry/node-principals.js` (new), `server/index.js`, `server/identity/principals.js` (`DEFAULT_GRANTS` bot), `server/db/database.js` (seed `bot`), `test/node-pairing.test.js` | N4a; **Contracts T1 release** (`network.node.manage`) + Network pin bump to it | **Opus** (security boundary) | **merged** |
| N4c | Node tokens + self routes + topology | `server/registry/node-principals.js`, `server/auth/oauth-routes.js:230`, `server/registry/cells.js` (topology), `test/node-tokens.test.js` | N4b; **T1** (node actor, `network.node.self.manage`) | **Opus** (token issuance) | **merged** (main `4e7b56b`, PR #19) |
| N5 | Owner API for own machines | `server/registry/node-principals.js` (`userRouter`), `server/index.js` (`/api/v1/me/nodes`, `rateLimit` as `/api/v1/me/blocks` `:427`), `test/node-principals-me.test.js` | N4b | basic (page: For Opus) | **merged** (PR #18) |
| N6 | Registry slice 5 (offer kinds as `detail`) | `package.json` pin, `migrations/0009_resource_offer_kinds.sql`, `server/registry/offers.js`, `server/index.js:473`, `principals.js` grant, `test/resource-registry.test.js` | **T1 release** (§9.1 items 4-5) | basic | **merged** (pin is v0.85.0) |
| N7 | Registry writers & operator reads | `server/registry/cells.js` (`cellView`, `setCell`, internal node-principals read), `server/registry/instances.js` (`setInstance`), `server/registry/nodes.js` (`GET /internal/nodes`), `server/index.js` (staff `/api/admin/registry`), tests | nothing (staff session; no new capability) | basic | **merged** (PR #27) |

Bot (T15) and Node (T14) follow, each step keeping Bot working (§9.2, §9.3). Owner steps: none for the Network
slices (main is not deployed and the PostgreSQL cutover waits on the owner); at Bot's deploy the owner provisions Bot's
client secret (`sudo node --env-file=/etc/openvibe/network.env server/setup/service-principal.js rotate bot --write-env /etc/openvibe/bot.env`) and later
flips `BOT_PAIRING_AUTHORITY=network`.

## 9. Follow-up job briefs

### 9.1 Contracts (T1) — one minor release (0.85.0), additive only

1. `lib/ids.js`: `PREFIX.node = 'nod'`; `principalSub({type:'node', id})` → `node:nod_<ULID>` (do **not** add `node`
   to `SUBJECT_TYPES` or `identity.subject-ref@1`: a node authors nothing). Test in `test/` beside the `agent` case.
2. `contracts/identity/service-token-claims.v1.json`: `sub` pattern gains `|node:nod_[0-9A-HJKMNP-TV-Z]{26}`;
   `actor_type` enum gains `node`; `lib/service-auth.js` `verifyServiceToken` accepts it (it validates against this
   contract, line 48). Fixtures `valid/node-token.json`, `invalid/node-bad-id.json`. Coordinate with the WS-Z2 `agent`
   addition (`docs/t2-projects-and-grants.md` §2) if both land in one release.
3. Two new manifests, every field `capability.v1.json` requires (`id version owner status visibility permissions
   resourceConstraints quotaClass events`) set; `inputSchema`/`outputSchema` are omitted (both optional) because the
   bodies are Network-local or several:
   ```json
   { "id": "network.node.manage", "version": "1.0", "owner": "network", "status": "active", "visibility": "internal",
     "description": "A service mints one-time pairing codes for its users' machines and reads or revokes the node principals it paired. Never grantable to apps.",
     "permissions": ["nodes:pair", "nodes:read", "nodes:revoke"], "resourceConstraints": ["owner"], "quotaClass": "admin",
     "events": [],
     "implementedBy": ["POST /internal/node-pairings", "GET /internal/node-principals/:id", "POST /internal/node-principals/:id/revoke"] }
   ```
   ```json
   { "id": "network.node.self.manage", "version": "1.0", "owner": "network", "status": "active", "visibility": "internal",
     "description": "A paired machine presents its own capabilities and rotates its own credential, never another machine's.",
     "permissions": ["nodes:self"], "resourceConstraints": ["owner"], "quotaClass": "admin", "events": [],
     "implementedBy": ["PUT /api/v1/node/self/capabilities", "POST /api/v1/node/self/credential"] }
   ```
   Add both ids to `manifests/services/network.json` `capabilities`. `network.node.report.json`: `implementedBy` gains
   `POST /internal/registry/instances/report` (nothing else changes).
4. `manifests/capabilities/network.resource.report.json` (as planned in `t2-resource-registry.md` §3; the report
   envelope `{source, offers}` is Network-local, `offers.js:34`, so no `inputSchema`; no `outputSchema`):
   ```json
   { "id": "network.resource.report", "version": "1.0", "owner": "network", "status": "active", "visibility": "internal",
     "description": "Report the complete set of a source's resource offers (platform.resource-offer@1) to the registry; offers absent from a later report of the same source are marked down.",
     "permissions": ["resources:write"], "resourceConstraints": ["none"], "quotaClass": "admin", "events": [],
     "implementedBy": ["POST /internal/resources/report"] }
   ```
   Added to `manifests/services/network.json` `capabilities`. The catalog test must load all three.
5. `contracts/platform/resource-offer.v1.json`: `kind` enum + `storage delivery runtime agent harness`; optional
   `detail` (`type: object`); top-level `allOf` with one `if/then` per new kind requiring `detail` and `$ref`-ing
   `<kind>-offer.v1.json`, and one for `node`/`provider` forbidding `detail`. Fixtures: one valid per kind, invalid
   `storage-without-detail.json`, `node-with-detail.json`.
6. `contracts/platform/service-instance.v1.json`: optional `route_weight` (`integer`, 0–1000).
   `contracts/platform/node-capabilities.v1.json`: optional `capabilities` (array of the resource-offer pattern),
   `agent_version` (string ≤ 40), `updated_at` (date-time). `contracts/network/node.v1.json`: optional `cell`
   (`^[a-z]{2,8}-[0-9]{1,3}$`, the `0008:16` rule).
7. `npm test` (compat gate vs v0.84.0 must pass: nothing removed, nothing newly required), regenerate OpenAPI, tag.

### 9.2 Bot (T15) — device identity moves to Network, Bot working at every step

- **B1 (dual-accept, no behaviour change).** Bump `openvibe-contracts` to the T1 release (`package.json:29`).
  Migration `0002_node_principal.sql`: `ALTER TABLE devices ADD COLUMN node_principal text`, `CREATE UNIQUE INDEX
  devices_node_principal ON devices (node_principal) WHERE node_principal IS NOT NULL AND revoked_at IS NULL`, and
  `credential_hash` becomes nullable (`ALTER … DROP NOT NULL`; the existing unique index already ignores revoked rows).
  `server/api/auth.js:15` `PRINCIPAL_SUB` gains `node`. A node token is a Bearer that decodes as a JWT with
  `actor_type: node` and `aud: openvibe.bot`, verified with `serviceAuth.verifyServiceToken`.
  **Binding** — one domain function `devices.bindNode(principalId)`, idempotent, used by both entry points below: if
  `devices WHERE node_principal = <nod_> AND revoked_at IS NULL` exists, return it. Else Bot calls Network
  `GET /internal/node-principals/:id` (its `svc:bot` token, `network.node.manage`), requires `status active`,
  `paired_for.service = 'bot'` and `paired_for.ref` a robot whose owner is the principal's owner (else 403
  `bot.node_not_bound`), and inserts the device row from **Network's record plus safe initial values**: `robot_ids
  [ref]`, `name` = the record's `name`, `kind 'onboard'`, `drivers []`, `capabilities {}`, `agent_version null`,
  `credential_hash NULL`, `node_principal = <nod_>`. Nothing the device says is needed to create it.
  **Bootstrap (HTTP, once after pairing)** — `POST /api/v1/devices/bind` (in `server/api/v1.js` beside `POST /pair`,
  `:193`), node token required, no body: `bindNode`, then issue (or re-issue: replace `publish_key_hash`) the publish
  key → `201 {device_id, publish_key, whip_url, robot_id, profile}`, exactly `POST /pair`'s answer (`v1.js:199`)
  without `credential`, `Cache-Control: no-store`. Calling it again (a Node that lost its file) answers the same
  `device_id` and a new publish key; the old key stops working.
  **Connect** — `/device` socket (`realtime.js:78-88`): a node-token Bearer runs `bindNode` (so a device that skipped
  bootstrap still connects; it just has no publish key until it calls bind), `attachDevice`, then the existing
  `sendHello` → `sendConfig` → `bringOnline` (`realtime.js:83-85`), Bot speaking first exactly as today; no `paired`
  frame on this path. Any other Bearer is today's `byCredential` path.
  **Later updates** — the device's `status` frame (`realtime.js:182`, today memory-only) gains optional
  `device_kind` (`onboard|bridge|server`), `drivers` (array of strings) and `agent_version` (string ≤ 40) beside
  `firmware, capabilities`; for a device with `node_principal`, Bot persists `kind`, `drivers`, `capabilities`
  (object) and `agent_version` to the row when they differ (invalid values ignored and answered `bot.bad_frame`, the
  row unchanged). `docs/protocol.md` §status documents the three fields. Credential devices keep today's behaviour.
  A node token expires after 300 s: the device sends `{"type":"reauth","token":…}` before expiry; no valid reauth
  within 330 s of the last → close 4002. Bot's `POST /devices/:id/revoke` on a Network-paired device also calls
  `POST /internal/node-principals/:id/revoke`, then closes the socket (instant, as today). Owner-forced
  `POST /devices/:id/rotate` on such a device sends `{"type":"rotate"}` to the Node, which rotates with Network itself;
  the answer carries no credential. Tests: `test/pairing.test.js` unchanged and green; a new
  `test/node-principal.test.js` with a stub Network (JWKS + `/internal/node-principals/:id`): bind creates the row
  with the initial values and answers no credential; bind twice → same `device_id`, new publish key; upgrade with a
  node token and no prior bind → `hello` then `config` arrive first; a `status` with `drivers`/`device_kind` updates
  the row; a principal paired for another robot's owner, revoked, or `paired_for.service` ≠ `bot` → 403 and close 4002.
- **B2 (Network pairing behind a flag).** `BOT_PAIRING_AUTHORITY=bot|network` (default `bot`). With `network`,
  `createPairingCode` (`domain/index.js:158`) calls `POST /internal/node-pairings {owner:{kind:'user',subject},
  ref: rob_…}` and stores no code; the installer command and QR carry `--network https://openvibe.network --pairing
  pair_…`; Bot's `POST /pair` and the `pair` frame answer `410 bot.pairing_moved` with the Network URL. Tests cover both
  flag values. Existing Bot-credential devices keep working throughout (dual-accept).
- **B3 (contract, after the owner flips the flag and `SELECT count(*) FROM devices WHERE node_principal IS NULL AND
  revoked_at IS NULL` is 0).** Drop `pairing_codes`, `credential_hash`, `credential_prev_hash`, `prev_valid_until`,
  `byCredential`, `POST /pair`, the `pair` frame and the flag; `docs/protocol.md` §1 and §3 rewritten. No credential
  import from Bot to Network ever: Bot is not deployed, so no live device needs one; any dev device re-pairs once.

### 9.3 Node (T14) — short brief, after N4c and B1

Today `credentials.Save` refuses a file without `device_id` (`credentials.go:78`), `Load` refuses one too (`:145`),
and the link ignores every frame before `hello` (`link.go:462`), so the Node can learn nothing from a `paired` frame
on the v2 path; Bot's `device_id` and publish key come over HTTP instead (B1's `POST /api/v1/devices/bind`).

- **Pair.** `openvibe-node pair --network <origin> [--pairing pair_…] CODE --server <bot>`: (1) redeem at
  `POST <network>/api/v1/node-pairing` (the `pair.go:47-61` https/loopback rules kept for both origins) →
  `{principal, node_id, credential, token_endpoint, paired_for}`; (2) save at once a v2 file (below) with
  `device_id` empty, so a crash here never loses the one-time credential; (3) fetch a token (`POST token_endpoint`,
  `client_credentials`, `client_id = principal`, `client_secret = credential`, `audience openvibe.bot`); (4)
  `POST <bot>/api/v1/devices/bind` with it → `{device_id, publish_key, whip_url, robot_id, profile}` (parsed by the
  existing `POST /pair` answer type, `credential` absent); (5) rewrite the file atomically with those filled in.
- **File, `version: 2`** (same path, 0600, same atomic write): v1 fields minus `credential`, plus `principal`,
  `node_id`, `node_credential`, `network`, `paired_for`. `Save`: v2 requires `principal` and `node_credential`;
  `device_id` may be empty only in v2. `Load`: v1 unchanged (requires `device_id` and `credential`); v2 requires
  `principal` and `node_credential`, and the secrets stay `Secret` (never marshalled, `credentials.go:37-41`).
- **Start / restart.** Load the file. v1 → today's path exactly. v2 → if `device_id` is empty, run steps 3-5 first
  (retry with backoff; bind is idempotent and re-issues the publish key); then connect `/device` with a fresh 300 s
  token as the Bearer (`link.go:309` reads it from a token source instead of the static credential), wait for `hello`
  as today, check `hello.device_id` equals the file's (mismatch → log and rewrite the file's `device_id`), send
  `reauth` every 240 s with a new token. A token fetch answered `401 invalid_client` is a refused credential: the
  existing `CredentialRetryMin` wait and the "pair again" log (`link.go:243-275`).
- **Status.** The first `status` after `config` carries `device_kind`, `drivers` and `agent_version` (B1's optional
  fields) from the configured plugins, and again when they change.
- **Rotate.** On Bot's `{"type":"rotate"}`, `POST <network>/api/v1/node/self/credential` and swap `node_credential`
  in the file atomically; the old one works 60 s.
- **Capabilities.** After pairing and at each start, `PUT <network>/api/v1/node/self/capabilities` with
  `platform.node-capabilities@1` built from the plugins' `describe` (audience `openvibe.network` token).
- Without `--network` it pairs with Bot exactly as today. Tests: `credentials_test.go` round-trips v1 and v2 and
  refuses v2 without `principal`; `link_test.go` with the `botfixture_test.go` fake plus a stub Network: pair → bind →
  connect; restart with `device_id` empty re-binds; `reauth` sent before expiry; `401` from the token endpoint
  backs off.

## 10. Unresolved

- **Project-owned machines** (`owner.kind: 'project'`): the schema carries them; the pairing route answers `501`
  until Services (T13) or Run (T14) is the requesting service and the member/role rule for "who may pair a machine
  into a project" is decided.
- **Route-weight writes** (cells and instances): no writer until the scheduler exists; weights stay at the default.
- **A second cell** (O24): `INSERT` into `platform_regions`/`platform_cells` by migration, then staff moves
  `home_cell`; no programming-model change. Changing a project's home cell is staff-only and not designed here.
- **Revocation latency outside Bot**: a revoke made on Network (N5) reaches a connected device at its next `reauth`
  (≤ 330 s). An event (`network.node.revoked`) would make it instant; deferred, it needs an event contract.
- **Bot's own capabilities** (`bot.robot.control`, `bot.device.connect`, …) are not in the Contracts catalog at
  v0.84.0 and there is no `manifests/services/bot.json`; that is a separate T1/T15 job, not a blocker here.
