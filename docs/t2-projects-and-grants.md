# T2 WS-Z2 — projects, agents and delegated grants (design)

Status: **slices 1–2 built** (proposals, and agents: `migrations/0016_agents.sql`, `server/developer/agents.js`; PR #25,
merge `4ec36e1`) and **lane B step 3 built** (`GET /internal/projects/:project_id` under `network.project.read`, Host
only: `server/internal/routes.js:490`; PR #28, merge `e422342`) and **slice 3 built** (delegated grants and modes:
`migrations/0017_agent_grants.sql`, the ceiling in `server/developer/agents.js`), **slices 4–5 built** (confirmations,
owner side, and budgets: `0018`, `0019`) and **slices 6–7 built** (`GET /internal/agents/:agent` and the four
`/internal/confirmations` routes, `server/internal/routes.js`, with the pin at `openvibe-contracts` v0.90.0) and **slices
8–9 built** (agent tokens, `server/developer/agent-tokens.js`; `network.confirmation.changed@1` decision events from
`server/developer/confirmations.js`); the owner notification of slice 9 still waits on an openvibe-shared type (§8).
Plan T2, "Projects and grants: projects as the ownership boundary for every resource;
`agt_` principals, delegated grants with modes, sensitive capabilities, confirmation requests, budgets (WS-Z2)".
Pinned version: `openvibe-contracts` **v0.90.0** (`package.json:33`, since slice 7; still the pin at `origin/main` `fb34f33`,
the latest Contracts tag v0.94.0 is additive and not pinned yet); every contract claim below was
re-checked against the `v0.85.0` tag of OpenVibe.Contracts when slices 1–2 were built (it was written against v0.83.0).
v0.89.0 published `network.confirmation.manage` (`planned`, `implementedBy` the four `/internal/confirmations` routes),
the `agent` actor in `identity.service-token-claims@1` and `network.confirmation.changed@1`; v0.86–v0.90 are additive.

Scope: an **agent** is a principal (`agt_<ULID>`) that acts for one person, inside one developer project, run by one
host (a developer app or a first-party service such as OpenVibe.Actor). Its owner **delegates** part of the host's
authority to it, capability by capability, each in a **mode**. A **sensitive** capability always needs the owner's
**confirmation**, unless a standing rule the owner approved covers it. An owner can cap each capability with a
**budget**. Network stores and decides all of this; the owning services enforce it at their boundary, as they already do
for quotas (`docs/developer-projects.md`, "Quotas"). Nothing about apps, service principals, the grantability rule or the
allowances changes.

## 1. What exists (origin/main `4e7b56b`, before slices 1–2)

| Piece | Where | State |
|---|---|---|
| Projects, members, roles, apps, app grants, quotas, audit | `migrations/0001_initial.sql:436-530`, `server/developer/store.js`, `/api/v1/projects` (`server/index.js:608`) | built; the ownership boundary already used by node principals (`0008`) |
| App grant ceiling | `store.js:559` `withinAllowance`, `:591` `decideGrant` (`403 grant.beyond_allowance`), `:196` `setAllowance` (shrink revokes), `server/developer/tokens.js:48` `effectiveGrants` (issuance intersects again) | built |
| Grantability | `server/developer/policy.js:16-30` (`public` and `partner`, `active` only), `:100` `allowanceFor` (sandbox allowance for sandbox apps) | built |
| Service-principal grants | `principal_grants` + `principal_grant_changes`, `server/identity/grants-admin.js` (owner-only, reason, expiry, `network.principal_grant.changed`), `server/identity/principals.js:290` `grantsFor` | built |
| Subjects | `server/identity/subjects.js` resolves `usr_` and `gst_` only | no `agt_` |
| Capability guard | `principals.js:347` `guard(capability)` throws at boot on an id the catalog does not have | built |
| Delegated client capability | `docs/capabilities-proposal/network.project.manage.json` (in the catalog at v0.85.0 as `public`, `planned`) | proposed, unused |
| Service-side project read | `network.project.read` (catalog: `first-party`, `planned`); `GET /internal/projects/:project_id`, granted to Host only | built (lane B step 3); no caller yet; Contracts still has to make it `active` |
| Sensitive capabilities, confirmations, budgets, agents | — | missing (agents: built by slice 2) |

## 2. Contract vocabulary (v0.85.0, used verbatim)

- **`identity.subject-ref@1`** has the agent form `{ "type": "agent", "id": "agt_<ULID>" }` ("an agent (OpenVibe.Actor, or
  a developer app's agent) acting under grants its owner delegated"). `ids.PREFIX` has `agent: 'agt'` and
  `confirmation: 'cnf'`; `ids.principalSub({type:'agent', id})` returns `agent:agt_…`.
- **`events.event-envelope@1`** has an optional `on_behalf_of` (a SubjectRef): the person an agent acted for.
- **`capabilities.capability@1`** has an optional boolean **`sensitive`**: "the action has an external side effect (money,
  sending as the person, publishing, applying, deleting, physical control): an agent needs its owner's confirmation unless
  a standing rule covers it". 23 capabilities carry `sensitive: true` at v0.85.0. Two of them are grantable to apps
  today (`public` + `active`): `media.object.delete` (in the default sandbox allowance) and `space.post.write`. The other
  sensitive ones are `first-party` (e.g. `chat.message.send`, `blog.post.publish`, `tips.superchat.create`), `internal`
  (`billing.*`, `network.coins.transfer`) or `public` but `planned`/`deprecated`.
- **`network.confirmation-request@1`** (`additionalProperties: false`): required `id` (`^cnf_<ULID>$`), `owner`,
  `requested_by` (SubjectRefs), `capability`, `summary` (≤ 500), `state` (`pending | approved | denied | expired |
  cancelled`), `expires_at`, `created_at`; optional `details` (object), `resources` (`common.entity-ref@1[]`),
  `standing_rule` (`once | session | until | always`), `decided_at`.
- The capability `visibility` enum (since v0.83.0) is **`public | partner | first-party | internal`**. `docs/developer-projects.md`
  ("`partner` is not in the enum yet") and the comment at `policy.js:8` predate that; slice 1 corrects both. The rule
  itself does not change.

**Gaps — not in v0.85.0, so the slices that need them are blocked (section 8):**

1. `identity.service-token-claims@1`: `sub` allows only `svc:` / `app:` / `mod:` / `node:` and `actor_type` only
   `service | app | mod | node`. An agent token cannot validate. (v0.85.0 closed the same gap for the node actor of
   `docs/t2-resource-registry.md` §9.)
2. No capability for a service to create or consume a confirmation (`network.*` at v0.85.0 has none; inventing one makes
   `principals.guard` throw at boot).
3. No event payload for a confirmation decision or an agent/delegated-grant change, so these changes are audit rows
   without `event` (the export-token precedent: "The row is not a platform event").
4. No notification type for "an agent asks you" in `openvibe-shared/notifications` `TYPES`.

## 3. Data model

Agents are `0016` and delegated grants `0017` (built); confirmations and budgets take the next free numbers when their
slices land (`0018`–`0019` if nothing else lands first). The design first reserved `0010`–`0013`, but the `openvibe-sdk/db`
runner tracks applied migrations by id and **refuses** a pending file numbered below one already applied (`migrate:
0010_agents.sql is older than applied migration 0014`), and main already ships `0014` and `0015`; `test/agent-schema.test.js` pins
this. `0010`–`0013` stay unused. Header convention of the existing migrations: `-- phase: expand`, `-- plan T2 WS-Z2.
<why>`, then DDL with `IF NOT EXISTS`. The runtime creates nothing (`ensureSchema()` stays a no-op with a comment).

**Stores.** Network runs on PostgreSQL only (the 2026-10-02 cutover): production on PostgreSQL, development and
`npm test` on embedded PGlite, `npm run test:pg` on real PostgreSQL. The migration runner applies the files below, in the
dialect of `0007`/`0008`: `text COLLATE "C"`, timestamps as ISO `text` (`ov_now_iso()`), `~` regex CHECKs, JSON as `text`
parsed in JS (never `jsonb`, as `platform_nodes.doc`), `bigint GENERATED ALWAYS AS IDENTITY`, partial indexes, no
triggers. There are no SQLite forms: nothing reads a SQLite copy of these tables, and they did not exist before the
cutover. The accept/reject cases live in `test/agents.test.js` (and the later slices' tests) against the migrated
database.

### 0016 — `0016_agents.sql` (built)

```sql
CREATE UNIQUE INDEX IF NOT EXISTS dev_apps_project_env_key ON dev_apps (id, project_id, environment);

CREATE TABLE IF NOT EXISTS dev_agents (
    id             text COLLATE "C" PRIMARY KEY CHECK (id ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'),
    project_id     text COLLATE "C" NOT NULL REFERENCES dev_projects(id),
    owner_subject  text COLLATE "C" NOT NULL CHECK (owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    host_kind      text COLLATE "C" NOT NULL CHECK (host_kind IN ('app', 'service')),
    host_app_id    text COLLATE "C",
    host_service   text COLLATE "C" REFERENCES oauth_clients(client_id),
    environment    text COLLATE "C" NOT NULL CHECK (environment IN ('sandbox', 'production')),
    name           text COLLATE "C" NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    status         text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
    created_at     text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    created_by     text COLLATE "C" NOT NULL,
    updated_at     text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    revoked_at     text COLLATE "C",
    revoked_by     text COLLATE "C",
    FOREIGN KEY (host_app_id, project_id, environment) REFERENCES dev_apps (id, project_id, environment),
    CHECK ((host_kind = 'app') = (host_app_id IS NOT NULL)),
    CHECK ((host_kind = 'service') = (host_service IS NOT NULL)),
    CHECK (host_kind = 'app' OR environment = 'production'),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS dev_agents_project_idx ON dev_agents (project_id, status);
CREATE INDEX IF NOT EXISTS dev_agents_owner_idx   ON dev_agents (owner_subject, status);
CREATE INDEX IF NOT EXISTS dev_agents_app_idx     ON dev_agents (host_app_id) WHERE host_app_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dev_agents_service_idx ON dev_agents (host_service) WHERE host_service IS NOT NULL;
```

- `owner_subject` is the person the agent acts for (`on_behalf_of`), always a `usr_` — never a guest, an app or another
  agent (no agent owns an agent). `created_by` is the same person (section 5).
- **An app host belongs to the agent's project, in the agent's environment.** The composite foreign key makes a row
  whose `host_app_id` is an app of another project (or of the other environment) impossible; `dev_apps.id` is already
  the primary key, so the new unique index only gives the key a target and costs one index. With `MATCH SIMPLE` a
  service host (`host_app_id IS NULL`) is not checked against `dev_apps`. The routes check it first anyway (an app of
  another project is `404 app.not_found`, section 4), and token issuance checks it again (section 4, "Agent tokens").
- An app-hosted agent copies its app's `environment` and never changes it (apps never change environment either). A
  service-hosted agent is `production`: the code that runs it is first-party, not the project's.
- `revoked` is final, like an app. `paused` is the owner's kill switch and is reversible.

### 0017 — `0017_agent_grants.sql` (built, slice 3)

```sql
CREATE TABLE IF NOT EXISTS dev_agent_grants (
    agent_id       text COLLATE "C" NOT NULL REFERENCES dev_agents(id),
    capability     text COLLATE "C" NOT NULL,
    audience       text COLLATE "C" NOT NULL CHECK (audience ~ '^openvibe\.[a-z][a-z0-9-]{0,63}$'),
    mode           text COLLATE "C" NOT NULL CHECK (mode IN ('auto', 'confirm')),
    status         text COLLATE "C" NOT NULL CHECK (status IN ('active', 'revoked')),
    granted_at     text COLLATE "C" NOT NULL,
    granted_by     text COLLATE "C" NOT NULL,
    updated_at     text COLLATE "C" NOT NULL,
    expires_at     text COLLATE "C",
    revoked_at     text COLLATE "C",
    revoked_by     text COLLATE "C",
    revoke_reason  text COLLATE "C",
    PRIMARY KEY (agent_id, capability),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS dev_agent_grants_active_idx ON dev_agent_grants (agent_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS dev_agent_grants_cap_idx    ON dev_agent_grants (capability, status);
```

`sensitive` is **not a column**: it is read from the installed catalog every time (`capabilities.get(id).sensitive`), so a
capability Contracts marks sensitive later is treated as sensitive on the next token with no data migration. The stored
`mode` is what the owner chose; `effective_mode` (section 5) is computed.

As built: `PUT` takes the project row's lock (as the cascades do) and, for a service host, holds the host's
`principal_grants` row `FOR SHARE`, so a ceiling change and a `PUT` never miss each other. A ceiling cascade sets
`revoked_by` to the subject label of whoever shrank the ceiling (`system:network` for the expiry sweep) and
`revoke_reason = 'beyond_host'`; a person's revoke leaves `revoke_reason` empty. Each change is one `dev_audit` row,
action `grant.changed`, target `agent:agt_…`, detail `{ capability, audience, from, to, mode, reason? }`, without an
event (section 2, gap 3). A revoked agent's grants stay as they are and read back `within_host: false`.

### 0018 — `0018_confirmations.sql` (built, slice 4)

```sql
CREATE TABLE IF NOT EXISTS dev_standing_rules (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id       text COLLATE "C" NOT NULL REFERENCES dev_agents(id),
    capability     text COLLATE "C" NOT NULL,
    rule           text COLLATE "C" NOT NULL CHECK (rule IN ('session', 'until', 'always')),
    session_id     text COLLATE "C" CHECK (session_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
    until_at       text COLLATE "C",
    source         text COLLATE "C" NOT NULL CHECK (source ~ '^cnf_[0-9A-HJKMNP-TV-Z]{26}$'),
    created_at     text COLLATE "C" NOT NULL,
    created_by     text COLLATE "C" NOT NULL,
    revoked_at     text COLLATE "C",
    revoked_by     text COLLATE "C",
    CHECK ((rule = 'session') = (session_id IS NOT NULL)),
    CHECK ((rule = 'always') = (until_at IS NULL))
);
CREATE INDEX IF NOT EXISTS dev_standing_rules_live_idx ON dev_standing_rules (agent_id, capability) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS dev_confirmations (
    id             text COLLATE "C" PRIMARY KEY CHECK (id ~ '^cnf_[0-9A-HJKMNP-TV-Z]{26}$'),
    project_id     text COLLATE "C" NOT NULL REFERENCES dev_projects(id),
    agent_id       text COLLATE "C" NOT NULL REFERENCES dev_agents(id),       -- requested_by {type: agent}
    owner_subject  text COLLATE "C" NOT NULL CHECK (owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'), -- owner {type: user}
    capability     text COLLATE "C" NOT NULL,
    audience       text COLLATE "C" NOT NULL,                                 -- the service that created it
    summary        text COLLATE "C" NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
    details        text COLLATE "C" NOT NULL DEFAULT '{}',
    resources      text COLLATE "C" NOT NULL DEFAULT '[]',
    state          text COLLATE "C" NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
    standing_rule  text COLLATE "C" CHECK (standing_rule IN ('once', 'session', 'until', 'always')),
    session_id     text COLLATE "C",
    request_digest text COLLATE "C" NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    rule_id        bigint REFERENCES dev_standing_rules(id),
    expires_at     text COLLATE "C" NOT NULL,
    created_at     text COLLATE "C" NOT NULL,
    decided_at     text COLLATE "C",
    decided_by     text COLLATE "C",
    used_at        text COLLATE "C",
    cancel_reason  text COLLATE "C",
    CHECK (state <> 'pending' OR decided_at IS NULL),
    CHECK (state NOT IN ('approved', 'denied') OR decided_at IS NOT NULL),
    CHECK (used_at IS NULL OR state = 'approved')
);
CREATE INDEX IF NOT EXISTS dev_confirmations_inbox_idx   ON dev_confirmations (owner_subject, state, created_at);
CREATE INDEX IF NOT EXISTS dev_confirmations_due_idx     ON dev_confirmations (expires_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS dev_confirmations_agent_idx   ON dev_confirmations (agent_id, state);
CREATE INDEX IF NOT EXISTS dev_confirmations_spendable_idx ON dev_confirmations (agent_id, capability) WHERE state = 'approved' AND used_at IS NULL;
```

- Columns map 1:1 to the contract fields; `owner`/`requested_by` are rebuilt as SubjectRefs from `owner_subject` /
  `agent_id`, `details`/`resources` are `JSON.parse`d. `audience`, `session_id`, `request_digest`, `rule_id`, `used_at`,
  `decided_by`, `cancel_reason` and `project_id` are Network-local and never appear inside the contract document
  (`additionalProperties: false`).
- `standing_rule` is the rule the owner chose when approving (`once` when none); `rule_id` is the rule that approved it
  automatically, if any (`decided_by = 'rule:<id>'`).
- `request_digest` is the SHA-256 of the action the owning service will perform (method, route, canonical body). The
  approval is for **that** action; consuming with any other digest fails.
- `cancel_reason` says why a row was cancelled (`service`, `agent_revoked`, `agent_paused`… section 5, step 6). An
  `approved`, unused row may be cancelled too (its `decided_at` stays); the spendable index finds those rows for the
  cascades.

### 0019 — `0019_agent_budgets.sql` (built, slice 5)

```sql
CREATE TABLE IF NOT EXISTS dev_agent_budgets (
    agent_id       text COLLATE "C" NOT NULL REFERENCES dev_agents(id),
    capability     text COLLATE "C" NOT NULL,
    limit_value    bigint NOT NULL CHECK (limit_value >= 0),
    budget_window  text COLLATE "C" NOT NULL CHECK (budget_window IN ('minute', 'hour', 'day', 'month', 'total')),
    unit           text COLLATE "C" NOT NULL DEFAULT 'requests',
    updated_at     text COLLATE "C" NOT NULL,
    updated_by     text COLLATE "C" NOT NULL,
    PRIMARY KEY (agent_id, capability)
);
```

The same shape as `dev_quotas` (`limit_value`, window set, `unit`), one budget per (agent, capability), so a budget and the
project's quota for the same capability compare field by field.

## 4. Routes

Public routes follow the projects API exactly (`docs/developer-projects.md`, "API"): a Network **user** access token in
`Authorization: Bearer`, no cookies, service/app/agent tokens get `401`, `problem+json` with a stable `code`,
`X-OpenVibe-Request-Id` and `traceparent`, `Cache-Control: private, no-store`, 60 requests per minute. Non-members get
`404 project.not_found`; a confirmation that is not yours is `404 confirmation.not_found`.

### Agents and their grants — under `/api/v1/projects/:project`

| Method and path | Body → result |
|---|---|
| `GET /agents[?owner=me]` | `{ agents: [agent] }` |
| `POST /agents` | `{ name, host: {type:'app', id:'app_…'} \| {type:'service', id:'actor'} }` → `201 agent`; an app host must be a non-revoked app **of `:project`** (otherwise `404 app.not_found`, the same answer as an unknown id, so other projects' app ids are not probed) |
| `GET /agents/:agent` | `agent` with `grants`, `budgets`, `rules` (each added by its slice; slice 2 returns the `agent` alone) |
| `PATCH /agents/:agent` | `{ name }` → `agent` |
| `POST /agents/:agent/pause`, `/resume` | → `agent` |
| `DELETE /agents/:agent` | revoke (final) → `agent` |
| `GET /agents/:agent/grants` | `{ grants: [grant] }` |
| `PUT /agents/:agent/grants/:capability` | `{ mode: 'auto'\|'confirm', expires_at? }` → `grant` |
| `DELETE /agents/:agent/grants/:capability` | revoke → `grant` |
| `GET /agents/:agent/budgets` | `{ budgets: [budget] }` |
| `PUT /agents/:agent/budgets/:capability` / `DELETE` | `{ limit, window, unit }` → `budget` |
| `GET /agents/:agent/rules` | `{ rules: [rule] }` |
| `DELETE /agents/:agent/rules/:rule` | revoke a standing rule → `rule` |

```jsonc
// agent
{ "id": "agt_…", "subject": { "type": "agent", "id": "agt_…" }, "project_id": "prj_…",
  "owner": { "type": "user", "id": "usr_…" }, "host": { "type": "app", "id": "app_…" },
  "environment": "sandbox", "name": "Release bot", "status": "active",
  "created_at": "…", "updated_at": "…", "revoked_at": null }
// grant
{ "capability": "media.object.delete", "audience": "openvibe.media", "mode": "auto", "effective_mode": "confirm",
  "sensitive": true, "status": "active", "within_host": true, "expires_at": null, "granted_at": "…", "granted_by": "user:usr_…" }
// budget
{ "capability": "media.object.upload", "limit": 1073741824, "window": "day", "unit": "bytes", "enforced_by": "openvibe.media" }
// rule
{ "id": 7, "capability": "chat.message.send", "rule": "until", "until_at": "…", "session_id": null, "source": "cnf_…", "created_at": "…" }
```

`host` and `owner` are SubjectRefs (`{type:'service', id:'actor'}` is the contract's PrincipalSubject form).
`within_host: false` marks an active grant the ceiling no longer covers (it is left out of tokens until it is covered
again or revoked by the cascade, section 6).

### The owner's confirmation inbox — `/api/v1/confirmations`

| Method and path | Body → result |
|---|---|
| `GET /?state=pending&before=&limit=` | `{ confirmations: [<network.confirmation-request@1>], agents: { "agt_…": { name, project_id, host } }, next_before }` |
| `GET /:id` | `{ confirmation: <network.confirmation-request@1>, agent: {…} }` |
| `POST /:id/approve` | `{ standing_rule?: 'once'\|'session'\|'until'\|'always', until?: <date-time> }` → `{ confirmation, rule? }` |
| `POST /:id/deny` | `{}` → `{ confirmation }` |

Elements of `confirmations` are the contract documents verbatim, validated in tests; context lives beside them, never
inside (the `docs/t2-resource-registry.md` §4 rule).

### Internal — service tokens, loopback only (`docs/shared-contracts.md` §11)

| Method and path | Capability | Body → result |
|---|---|---|
| `GET /internal/agents/:agent` (built, slice 6) | `network.project.read` (exists, first-party) | `{ agent, grants, budgets }`, grants and budgets filtered to the caller's own audience (`openvibe.<caller>`) |
| `POST /internal/confirmations` (built, slice 7) | **`network.confirmation.manage`** (published in v0.89.0, `status: planned`) | `{ requested_by: {type:'agent', id}, capability, summary, details?, resources?, request_digest, session_id?, ttl_s? }` → `201 { confirmation }` (pending) or `200 { confirmation }` (approved by a standing rule) |
| `GET /internal/confirmations/:id` | same | `{ confirmation, used_at }` |
| `POST /internal/confirmations/:id/consume` | same | `{ request_digest }` → `200 { confirmation, used_at }` |
| `POST /internal/confirmations/:id/cancel` | same | → `{ confirmation }` |

`ttl_s` is 60–86400, default 900. All `/internal/confirmations` routes answer only the audience that created the
confirmation (others: `404`), with `Cache-Control: no-store`. The owner is always the agent's: a body's `owner` is never
read. Cancel takes a `pending` or `approved` but unused one (`cancel_reason = 'service'`; again is a no-op), refuses a
used, denied or expired one (`409 confirmation.not_pending`) and leaves the owner's standing rules alone. No service holds
`network.confirmation.manage` by default yet: a service gets its `DEFAULT_GRANTS` row when it ships a receiver.

`GET /internal/agents/:agent` lists only the agent's `active`, unexpired grants at the caller's audience, each `{
capability, audience, mode, effective_mode, sensitive, expires_at }`, and the budgets of those grants alone; another
audience gets `grants: []` (never a `404`) and `agent: { id, subject }` alone: `project_id`, `owner` and `host` go only
to a service the agent concerns (an active, unexpired grant at its audience, or its service host). An agent that is
not `active` lists no grants. It never carries a label
(`granted_by`, `updated_by`), a request digest or a secret; an unknown or malformed id is `404 agent.not_found`.

### Agent tokens — `POST /oauth/token`

The **host** authenticates as itself, exactly as today (an app with its `client_secret` through the developer path, a
service through `principals.issueToken`), and adds `agent=agt_…` plus `audience` and an optional `scope`.

**Host binding, checked on every issuance** (`400 invalid_grant` for all of them, one message, so a host cannot learn
whether someone else's agent exists): the authenticated client **is** the agent's host (`app.id = agent.host_app_id`,
or `client_id = agent.host_service`); for an app host, `app.project_id = agent.project_id`, `app.environment =
agent.environment` and the app is not revoked (the foreign key of `0016` already makes the first two true for every
stored row; issuance re-reads them so a future change to that key cannot widen tokens); the project is not archived;
the agent is `active`; the owner is still a member and not banned or deleted.

| Claim | Value |
|---|---|
| `sub`, `actor_type` | `agent:agt_<ULID>` (`ids.principalSub`), `agent` |
| `aud` | `[audience]` |
| `cap` | active grants with `effective_mode = 'auto'` ∩ ceiling ∩ budgets not set to 0 |
| `cap_confirm` | active grants with `effective_mode = 'confirm'` ∩ ceiling ∩ budgets not set to 0 |
| `on_behalf_of`, `project_id`, `env` | the owner `usr_`, the project, the agent's environment |
| `ns` | **app host:** `[project_id, app.<project_id>.*]`, as the host app's own token. **Service host:** `projectNamespaces(project_id)` (`tokens.js:56`) ∩ the namespaces of the host's `principal_grants` rows for the capabilities in `cap` ∪ `cap_confirm` (`grantsFor(host, audience)`, the same rows the host's own token takes `ns` from): a project namespace is kept only if one of those rows names it, or names a `*` pattern that matches it under the contracts' namespace matcher (the one `principals.guard({ namespace })` uses). A grant with `namespaces = []` contributes none; a host whose grants cover no namespace of the project gives `ns: []`, and the receiver refuses every namespaced action |
| `act` | `{ sub: 'app:app_…' \| 'svc:actor' }`, the host (RFC 8693 actor claim) |
| `iat`, `exp`, `jti` | 300 seconds, no refresh |

An agent token never carries a namespace its host's own token for that audience would not carry: the ceiling covers
namespaces as well as capabilities.

**Fail closed by construction:** a confirm-mode capability is never in `cap`. A receiver that does not know agents sees
only `cap`, so it can never perform a sensitive action without a confirmation; it simply refuses it. Issuance consumes no
confirmation: `cap_confirm` says the agent may *ask*, and each use is one approval the owning service spends once
(`consume`, §5 step 4, under the agent row's `FOR UPDATE`).

**Refusals** (built, slice 8; OAuth errors, after the host's own credentials passed): `400 invalid_grant` (the host
binding above, one message, also an unknown or malformed `agt_` id), `400 invalid_request` (no `audience`), `400
invalid_target` (a sandbox agent at an audience not in `DEV_SANDBOX_AUDIENCES`), `400 invalid_scope` (a `scope` naming a
capability the agent does not hold now — no grant, revoked or expired, outside the ceiling, budget `0` — or nothing held
at the audience), `400 unsupported_grant_type` (`agent` with anything but `client_credentials`); a node client id never
hosts an agent (`invalid_grant`). Every issuance and refusal is a `dev_audit` row (`agent.token_issued` with audience,
`cap`, `cap_confirm`, `jti`, expiry; `agent.token_refused` with the error and its internal reason), never a secret or the
token. Network's own guard (`principals.guard`) answers `403 capability.denied` to an agent token on every route.

## 5. Auth rules

### Who may do what

| Action | Who |
|---|---|
| Create an agent hosted by a **sandbox app** | a project member with role developer+ (who could create that app), for **themselves** only |
| Create an agent hosted by a **production app** | admin+ of the project, for themselves only |
| Create an agent hosted by a **service** | developer+ of the project, for themselves; the service must be in `AGENT_HOST_SERVICES` (default `actor`) and be an `oauth_clients` row |
| Read agents, grants, budgets | any member (viewer+); staff, any project |
| Rename | the agent's owner, admin+ |
| Pause | the agent's owner, admin+, staff |
| Resume | the agent's owner, admin+ (never staff: a staff pause is lifted by the owner) |
| Revoke the agent | the agent's owner, admin+, staff |
| **Set a delegated grant (PUT)** | **the agent's owner only** — a person delegates their own authority; an admin cannot delegate for another member, staff never |
| Revoke a delegated grant | the agent's owner, admin+, staff |
| Set or remove a budget | the agent's owner, admin+ (an admin may cap a member's agent) |
| Revoke a standing rule | the agent's owner, admin+, staff |
| Read, approve or deny a confirmation | **its `owner` only** (not admins, not staff; staff see the audit row) |
| Create, read, consume, cancel a confirmation | the owning service of the capability (`audience = openvibe.<capability owner>`), with `network.confirmation.manage` |
| Mint an agent token | the agent's host, authenticated as itself |

There is no route that creates an agent for another person, and no agent can create an agent, set a grant or approve a
confirmation: agent, app and service tokens are not users on the public API (`401`).

### The delegation ceiling (the agent analogue of "a grant never exceeds the allowance")

An agent never holds more than its host may do *for that project*:

- **App host:** the capability must be in `effectiveGrants(host app, audience)` (`tokens.js:48`): the app's approved
  grant ∩ the project allowance (∪ the sandbox allowance for a sandbox app) ∩ grantable now. The grantability rule and
  both allowance rules therefore apply to agents **unchanged and without a second implementation**: no new path reaches a
  `first-party` or `internal` capability.
- **Service host:** the capability must be in the host's current `principals.grantsFor(host, audience)` (unexpired
  `principal_grants`) **and** its visibility must be `public`, `partner` or `first-party` — never `internal`
  (`billing.*`, `network.coins.*` stay service-to-service). This is how Actor's agents may e.g. send a chat message as
  their owner (`chat.message.send`, first-party, sensitive → always confirmed). The token's namespaces are bounded the
  same way, by the namespaces of those `principal_grants` rows (section 4, `ns`).
- **Everyone:** the capability exists in the installed catalog and is `active` (`grant.unknown_capability`,
  `grant.not_grantable`), and the agent is not `revoked`.

It is checked in three places, as the allowance is: `PUT …/grants/:capability` refuses `403 grant.beyond_host`; a change
that shrinks the ceiling revokes the delegated grants outside it (section 6); token issuance intersects again.

### Modes

| Mode | Meaning | Allowed for |
|---|---|---|
| `auto` | the agent may use the capability with its token alone | non-sensitive capabilities only; `PUT` with `auto` on a sensitive one is `422 grant.sensitive_requires_confirm` |
| `confirm` | every use needs an approved confirmation request (or a standing rule) | any capability; the default when `mode` is omitted |

`effective_mode = sensitive ? 'confirm' : mode`. A capability Contracts marks sensitive after a grant was set to `auto`
becomes `confirm` on the next token; the stored row is not rewritten. Expiry (`expires_at`) ends a grant at that instant
(issuance filters it; a sweep records `grant.expired` once, as `grants-admin.js` `expireDue` does).

### Sensitive capabilities and the confirmation lifecycle

The owning service is the one that knows what the action really is, so it — not the agent — writes the `summary` and
the digest. An agent cannot describe its own request to its owner.

1. **Ask.** The agent calls the owning service with a token whose `cap_confirm` has the capability. Without a usable
   `OpenVibe-Confirmation: cnf_…` header the service answers `403 confirmation.required` after calling
   `POST /internal/confirmations` (owner derived by Network from the agent, never from the body), and returns the
   `cnf_` id to the agent. Network refuses `409 confirmation.agent_inactive` (agent paused/revoked or owner banned or
   deleted), `403 grant.not_delegated` (no active grant, or the grant's effective mode is `auto` — nothing to confirm),
   `403 confirmation.wrong_audience` (the capability is not the caller's), `429 confirmation.too_many_pending` (20 pending
   per agent).
2. **Standing rule shortcut.** If a live rule covers (agent, capability) — `always`; `until` with `until_at` in the
   future; `session` with the same `session_id` and `until_at` in the future — the confirmation is created already
   `approved` (`decided_by = 'rule:<id>'`, `rule_id` set, `200`). Every sensitive use still leaves a row.
3. **Decide.** The owner sees it in the inbox (and, once openvibe-shared has its type, a notification). `approve` / `deny` move
   `pending` → `approved` / `denied` and set `decided_at`. Anything else is `409 confirmation.not_pending`; a pending row
   past `expires_at` is `409 confirmation.expired` (and is marked expired). Approving with `session`, `until` (`until`
   required, at most 30 days) or `always` also inserts a `dev_standing_rules` row; `session` lasts at most 24 hours and
   needs the confirmation's `session_id` (`422 confirmation.no_session` otherwise). Denying never creates a rule.
4. **Use once.** The agent retries with the header. The service calls `consume` with its digest of *this* request. An
   approval is only as good as the authority behind it **now**, so consume re-checks everything that let it be created,
   in one transaction (`db.tx`) that first locks the agent row (`SELECT … FROM dev_agents WHERE id = ? FOR UPDATE` on
   PostgreSQL) so a revocation cannot interleave:
   - the agent is `active`, its project is not archived, and its owner is still a member, not banned and not deleted;
   - for an app host, the app is not revoked and still belongs to the agent's project and environment;
   - the delegated grant (agent, capability) is `active`, unexpired, and its `effective_mode` is still `confirm`;
   - the capability is still inside the ceiling (`effectiveGrants(host app, audience)` or `grantsFor(host service,
     audience)` minus `internal`), and its budget is not `0`.

   Then one statement spends it: `UPDATE dev_confirmations SET used_at = ? WHERE id = ? AND audience = ? AND state =
   'approved' AND used_at IS NULL AND expires_at > ? AND request_digest = ?` — one row → `200`. Otherwise `409
   confirmation.used`, `confirmation.mismatch`, `confirmation.expired`, `confirmation.cancelled`,
   `confirmation.agent_inactive` (agent, project, app or owner) or `403 grant.not_delegated` (grant gone or outside the
   ceiling). Pausing an agent or revoking its grant therefore stops its sensitive actions **at once**, not after the
   5-minute token lifetime, even for an approval given before the change.
5. **Expire.** A sweep every minute moves `pending` rows past `expires_at` to `expired`; reads already report them as
   expired before the sweep. An approved but unused confirmation simply stops being consumable at `expires_at`.
6. **Cancel.** The creating service may cancel a pending one (the agent's run ended; `cancel_reason = 'service'`).
   Every change that takes authority away cancels, **in its own transaction**, both the `pending` and the `approved`
   but unused (`used_at IS NULL`) confirmations it affects, and revokes the matching standing rules: pausing or revoking
   the agent (all of the agent's), revoking or expiring a delegated grant (that capability's), a ceiling cascade
   (section 6: the capabilities it revokes), the owner leaving the project or being erased, the app being revoked and the
   project being archived (all of the agents'). `cancel_reason` names the cause (`agent_paused`, `agent_revoked`,
   `grant_revoked`, `grant_expired`, `beyond_host`, `member_removed`, `account_erased`, `app_revoked`,
   `project_archived`). Resuming a paused agent revives nothing: its next sensitive action asks again. The consume
   re-check of step 4 stays as the second line, for authority that lapses without a Network write (a `principal_grants`
   or delegated-grant `expires_at` passing before its sweep, a capability leaving the catalog on upgrade).

Every transition writes a `dev_audit` row (`confirmation.created|approved|denied|expired|cancelled|used`, project id,
agent id, capability; never `summary` or `details`, which may hold message text) carrying a
`network.confirmation.changed@1` event (built, slice 9) in the same transaction, so the outbox relays it exactly when the
change commits. Each transition is a conditional `UPDATE` that one writer wins, so each (confirmation, change) is emitted
once: a second sweep, a repeated cancel or a lost race writes nothing. The payload is the contract's (ids, capability,
audience, state, change, `standing_rule`/`rule_id`, `cancel_reason`, `expires_at` on created and approved,
`changed_at`), never the summary, details, request digest or a label; the envelope's actor is the deciding owner for
approve/deny and the system otherwise, `on_behalf_of` the owner. A cascade skips rows already past `expires_at`, and
`cancel` refuses them (`409 confirmation.not_pending`): an approved but expired confirmation is reported `expired` and
stays as it is.

### Budgets: who checks what

| Check | Who | When |
|---|---|---|
| A budget is within the project's quota (same capability, window and unit) | Network | `PUT …/budgets/:capability` → `422 budget.beyond_quota` |
| A budget only exists for a capability the agent holds | Network | `PUT` → `404 grant.not_found`; revoking the grant deletes its budget |
| Usage against the budget | **the owning service**, before the side effect, with its own counters | per action → `429 budget.exceeded` (AI's `quota.exceeded` precedent) |
| A budget of `0` | Network | issuance leaves the capability out of `cap` and `cap_confirm` (a per-capability off switch that needs no metering) |
| Money across services (Vibes / promo) | Billing's universal `govern` (plan T5) | recorded only until T5 |

Network never meters. Its usage rollups (`dev_usage_*`) are per project and "never name who did the work", so they
cannot measure an agent; reading them for budgets would also lag by an hour. This keeps the rule of
`docs/developer-projects.md` ("Quotas are enforced by the owning services, not here") true for budgets: `enforced_by` is
the capability's audience. Owning services read budgets from `GET /internal/agents/:agent`.

## 6. How it fits what exists — nothing breaks

- **App grants (`dev_grants`, `store.js`).** Untouched: same table, statuses, roles, approval, `grant.beyond_allowance`,
  `network.grant.changed`. Three existing transactions gain one cascade each, **after** their current work and in the
  same transaction: `setAllowance` (`:196`) and `decideGrant`/the grant revoke (`:591`) revoke the delegated grants of
  the app's agents that fall outside `effectiveGrants`; `revokeAppTx` (`:436`) and `archiveProject` (`:183`) revoke the
  agents themselves (`revoked_by = 'app_revoked'` / `'project_archived'`; built, slice 2 — the archive revokes its agents
  before its apps, so each records the archive as the cause). `removeMember` (`:319`) revokes the leaving person's
  agents in that project (`'member_removed'`). Each of these transactions, and an account erasure, first takes the
  project row's lock (`store.lockProject`, `FOR NO KEY UPDATE`); agent creation takes it too and re-checks the project,
  the membership and the host under it, so no agent is created against a state a cascade is ending. A pause, resume or
  revoke re-reads the agent `FOR UPDATE` and updates only from that status, so a resume never undoes a concurrent revoke
  (`test/agents-concurrency.test.js`). Each of these cascades also cancels the affected pending and approved-unused
  confirmations and revokes the standing rules (section 5, step 6). A sandbox agent's grant still inside the sandbox allowance survives a staff change,
  for the same reason the app's grant does.
- **App tokens (`tokens.js`).** Unchanged byte for byte when no `agent` parameter is sent; the new branch is taken only
  for `agent=agt_…`. `effectiveGrants` is reused, not copied.
- **Service-principal grants (`principal_grants`, `grants-admin.js`).** Untouched; agents never get `principal_grants`
  rows. `POST /api/admin/grants/revoke` and the expiry sweep gain the cascade for agents hosted by that service.
  `DEFAULT_GRANTS` are not extended.
- **The grantability rule and the allowances.** Not reimplemented: the ceiling *is* `effectiveGrants` for app hosts. The
  one new rule (service-hosted agents never get `internal`) only narrows.
- **Sensitive app grants.** `media.object.delete` and `space.post.write` keep working for apps exactly as today:
  `capability@1` defines confirmation for **agents**. Apps acting with `on_behalf_of` are listed as unresolved.
- **Mod principals, node principals, export tokens.** Untouched.
- **Account deletion (`account-data.js:319` `erase`)** revokes the subject's agents (`revoked_by = 'account_deleted'`,
  then `'project_archived'` for the rest of a project it archives; built, slice 2), cancels their pending and approved-unused
  confirmations and revokes their rules; the account export (`:162` `networkPart`) lists the person's agents (built: `developer_projects.json` `agents`, without `revoked_by`), grants, rules and
  confirmations (without other people's data).
- **Migration of existing rows.** None needed: the four tables start empty, no existing column changes, no backfill,
  `0016` and its successors are `expand` only. Rolling back a slice means its routes disappear; its empty or orphaned rows are inert
  because issuance and the routes are the only readers.

## 7. Test plan

New files (the `test/nodes.test.js` / `test/developer-projects.test.js` setup: temp DB via `getDb()`, a generated RSA
keypair, a bare express app, user tokens, service tokens through `POST /oauth/token`):

- `test/agents.test.js` — roles matrix for create/rename/pause/resume/revoke (viewer refused, developer only for sandbox
  hosts, admin for production, staff may pause/revoke but not create or resume); creating for another person is
  impossible; `AGENT_HOST_SERVICES` refuses an unlisted service; CHECK constraints reject a bad row (app host without
  `host_app_id`, service host in sandbox, revoked without `revoked_at`); **an app of another project as host**: the route
  answers `404 app.not_found`, and a direct insert of such a row (or of an app of the other environment) fails on the
  composite foreign key; cascades: revoke app, archive project, remove member, account erase.
- `test/agent-schema.test.js` — through the normal runner only: a database migrated to `0015` without the agents
  migration gains `0016` (once; re-running the file changes nothing), a file numbered below an applied one is refused
  (why the design's `0010` became `0016`), and the composite foreign key holds on the migrated database. Each later
  slice adds its migration to it.
- `test/agent-grants.test.js` — ceiling: an app-hosted agent cannot get a capability the app lacks, outside the
  allowance, or `first-party`; a sandbox agent gets a sandbox-allowance capability; a service-hosted agent never gets an
  `internal` one; `auto` on `media.object.delete` → `422`; `effective_mode` follows the catalog; only the owner may PUT;
  cascades from `setAllowance` shrink, app grant revoke and `/api/admin/grants/revoke`, each with its audit row.
- `test/agent-budgets.test.js` — `budget.beyond_quota`; budget needs a grant; grant revoke removes it; read via
  `/internal/agents/:agent` filtered to the caller's audience; auth matrix (no token, retired shared key, wrong
  capability, sandbox token).
- `test/confirmations.test.js` — every view validates as `network.confirmation-request@1`; create → approve → consume
  once (second consume `409 confirmation.used`); digest mismatch; deny; approve after expiry; lazy expiry and the sweep;
  cancel; standing rules `once`/`session`/`until`/`always` and their revocation; owner B and staff get `404`; 20-pending
  limit; wrong audience; audit rows contain no `summary`/`details`. **Revoke after approval**, one case per cause:
  approve, then pause the agent / revoke it / revoke the delegated grant / shrink the allowance (app host) / revoke the
  host's `principal_grants` row (service host) / remove the owner from the project / revoke the app / archive the project
  → the row is `cancelled` with that `cancel_reason`, consume answers `409 confirmation.cancelled`, and resuming the agent
  does not make it spendable again. **Lapse without a write**: approve, then let the delegated grant's `expires_at` (and,
  separately, the host `principal_grants` row's) pass with the sweep stopped → consume answers `403 grant.not_delegated`
  and `used_at` stays `NULL`. Two concurrent consumes of one approval: exactly one `200`.
- `test/agent-tokens.test.js` — claims match the proposed `identity.service-token-claims@1`; `cap` holds only auto
  grants and `cap_confirm` only confirm ones; a revoked/paused agent, a banned owner, an archived project, a budget of 0
  and a host mismatch each refuse or drop as specified; **cross-project host**: app B (project B) asking for a token for
  an agent of project A gets `400 invalid_grant`, as does app A' of project A that is not the agent's host, and a row
  forced past the foreign key in the test (constraint dropped) is still refused at issuance; **service-host namespaces**:
  with the host's `principal_grants` row restricted to one project namespace, the agent token's `ns` holds only that one;
  with `namespaces = []` it is `[]`; an app-hosted agent's `ns` equals its app's; **app tokens without `agent` are identical to before** (snapshot
  of the claim keys and values except `jti`/`iat`/`exp`).

Regression runs each slice: `test/developer-projects.test.js`, `test/developer-defaults.test.js`,
`test/developer-export-tokens.test.js`, `test/grants-admin.test.js`, `test/principals.test.js`,
`test/service-principal.test.js`, `test/account-data.test.js`, `test/security-idor.test.js`. Every slice: the new file
alone while iterating, then `npm test` and `npm run test:pg` (PGlite and real PostgreSQL must both apply the migration
and agree).

## 8. Slices — each one PR

1. **Docs and proposals** (built). `docs/developer-projects.md` and the `policy.js:8` comment: `partner` is in the enum.
   `docs/capabilities-proposal/network.confirmation.manage.json` (first-party, `implementedBy` the four
   `/internal/confirmations` routes). `docs/contracts-proposal/`: `identity.service-token-claims@1` gains `actor_type
   agent`, `sub agent:agt_…`, `cap_confirm`, `act`, and requires `project_id`, `env`, `on_behalf_of` for agents; a
   `network.confirmation.changed@1` payload. No migration. Checks: `npm test` (docs-only, sanity).
2. **Agents** (built). `migrations/0016_agents.sql`, `server/developer/agents.js` (store + `ensureSchema` no-op), routes in
   `server/developer/routes.js`, cascades in `store.js` (`revokeAppTx`, `archiveProject`, `removeMember`) and
   `account-data.js` (`erase`, `networkPart`), `AGENT_HOST_SERVICES` in `.env.example` and the config table of
   `docs/developer-projects.md`, `test/agents.test.js`,
   `test/agent-schema.test.js`. Checks: `npm test`, `npm run test:pg`.
3. **Delegated grants and modes** (built). `migrations/0017_agent_grants.sql`, grant routes, the ceiling (reusing
   `tokens.effectiveGrants` and `principals.grantsFor`), cascades in `setAllowance`, `decideGrant`/grant revoke and
   `grants-admin.js` revoke + `expireDue`, `test/agent-grants.test.js`,
   cases added to `test/agent-schema.test.js`. Checks: `npm test`, `npm run test:pg`. `GET /agents/:agent` still returns
   the `agent` alone; its grants are `GET /agents/:agent/grants`.
4. **Confirmations, owner side** (built). `migrations/0018_confirmations.sql`, `server/developer/confirmations.js` (store,
   lifecycle, expiry sweep started next to `grants-admin` `start`), `/api/v1/confirmations` mounted in `server/index.js`,
   rule routes, the store's `consume` with the step-4 re-checks, the confirmation cancel step added to every cascade of
   slices 2–3 (pause, revoke, grant revoke and expiry, ceiling cascades, member removal, erase, app revoke, archive),
   `test/confirmations.test.js` creating and consuming rows through the
   store functions (the internal routes wait for slice 7), cases added to `test/agent-schema.test.js`. Checks: `npm test`,
   `npm run test:pg`.
5. **Budgets** (built). `migrations/0019_agent_budgets.sql`, budget routes, `budget.beyond_quota`,
   `test/agent-budgets.test.js` (without the internal read), cases added to
   `test/agent-schema.test.js`. Checks: `npm test`, `npm run test:pg`.
6. **Internal agent read** (built). `GET /internal/agents/:agent` under `network.project.read` (already in the catalog),
   `internalAgentView` in `server/developer/agents.js`, the route in `server/internal/routes.js`;
   `test/internal-agents.test.js`. Checks: `npm test`, `npm run test:pg`.
7. **Internal confirmations** (built). The pin moved to `openvibe-contracts` v0.90.0 (v0.89.0 published
   `network.confirmation.manage`), the four `/internal/confirmations` routes (`internalRouter`, `read` and `cancel` in
   `server/developer/confirmations.js`, mounted under the guard in `server/internal/routes.js`), no `DEFAULT_GRANTS`
   row yet (none until a receiver ships), internal cases in `test/confirmations.test.js`. Checks: `npm test`,
   `npm run test:pg`, `node scripts/contracts-drift.js`.
8. **Agent tokens** (built). `server/developer/agent-tokens.js` (`mint`), the `agent` branch in
   `server/developer/tokens.js` and `principals.issueToken`, `cap`/`cap_confirm` split, `test/agent-tokens.test.js`.
   Network's own guard refuses agent tokens on its routes until a route needs them. No migration. Checks: `npm test`,
   `npm run test:pg`.
9. **Decision events** (built) **and the owner notification** (*still blocked on an openvibe-shared notification
   type*). Audit rows carry `network.confirmation.changed@1` (`store.audit` takes the envelope's `actor` and
   `on_behalf_of`), `test/confirmation-events.test.js`. Still to do: `notification-service.js` notifies the owner on
   create (payload rules of `docs/notification-digest.md`: never the summary). No migration. Checks: `npm test`,
   `npm run test:pg`.

Slices 2–9 are built, in this order (2–5 each added the next migration number; 6–9 need none); only the slice-9 owner
notification waits on a release outside Network.

## 9. Unresolved

- **Apps acting `on_behalf_of` a person** (authorization-code tokens) are not agents, and `capability@1` asks confirmation
  of agents. Whether a third-party app's sensitive actions should also be confirmed is a separate decision (the consent
  screen gap in `docs/developer-projects.md`).
- **Per-agent usage display.** Owners cannot see an agent's `used` until `common.usage-recorded@1` gains an agent
  dimension; whether an agent id may appear in a rollup is a privacy decision for Contracts.
- **Money budgets across services** belong to Billing (T5); Network records nothing for them yet.
- **The approval inbox UI** (Network pages or Codes/Actor) is not designed here.
