# Developer projects

Roadmap Wave 20 foundation. The binding decision is ADR-014 in OpenVibe.Contracts. Network owns developer projects: who may build on OpenVibe, which apps they run, what those apps may do, and how much they may use. OpenVibe.Codes (the portal, the next step) is a client of this API. It never enforces grants or quotas itself.

What exists today: the data model, the `/api/v1/projects` API, app tokens from `/oauth/token`, the sandbox check in Network's own capability guard, defaults that let a new project's sandbox apps work without staff (sandbox audiences and a sandbox allowance), the audit, and a relay of the audit's events to OpenVibe.Events (off until `OV_EVENTS_INTERNAL_URL` is set). The backend of the consent screen is built (`GET /oauth/client-info` with `scope`), the page that renders it is next (see [Consent screen](#known-gaps-next-steps)); what does not exist yet: a UI (Codes), the consent-screen page, and refresh tokens for apps. Owning services read a project through `GET /internal/projects/:project_id` ([Service-side project reads](#service-side-project-reads)). Quotas are enforced by the owning services, not here.

## Model

| Thing | Id | Notes |
|---|---|---|
| Project | `prj_<ULID>` | One owner (`usr_` subject). Has a name, an environment policy, an allowance and members. Archiving a project cannot be undone and revokes every app in it. |
| Member | subject `usr_<ULID>` | Role `owner`, `admin`, `developer` or `viewer`. There is exactly one owner, and ownership cannot be transferred through this API. |
| App | `app_<ULID>` (subject `app:app_<ULID>`) | An OAuth client. Its `client_id` is its app id. Environment `sandbox` or `production`. Type `confidential` (has a secret) or `public` (no secret, authorization code + PKCE only). Apps are stored apart from `oauth_clients`, so they never inherit first-party trust (CORS, SSO fan-out, FedCM). |
| Credential | `crd_<ULID>` | A client secret (`ovsec_…`, 256 random bits). Only its SHA-256 hash and last four characters are stored. |
| Grant | (app, capability) | `requested`, `approved`, `denied` or `revoked`. The audience is `openvibe.<capability owner>`. |
| Quota | (project, capability) | A limit, a window (`minute`, `hour`, `day`, `month`, `total`) and a unit (`requests`, `bytes`, `tokens`, …). |
| Audit | integer, append-only | PostgreSQL triggers refuse UPDATE and DELETE. |

### Roles

| Action | viewer | developer | admin | owner | staff (`users.role = admin`) |
|---|---|---|---|---|---|
| See the project, members, apps, grants, quotas | yes | yes | yes | yes | yes, any project |
| Create or edit sandbox apps; rotate or revoke their secrets | | yes | yes | yes | |
| Create or edit production apps; rotate or revoke their secrets | | | yes | yes | |
| Revoke an app or a credential | | sandbox | yes | yes | yes |
| Request a grant | | yes | yes | yes | |
| Approve or deny a grant (inside the allowance only) | | | yes | yes | |
| Revoke a grant | | | yes | yes | yes |
| Add or remove developers and viewers | | | yes | yes | |
| Add or remove admins | | | | yes | |
| Read the audit | | | yes | yes | yes |
| Archive the project | | | | yes | yes |
| Mint an export token (read-only, for OpenVibe.Codes' project export) | | | yes | yes | only as an admin member |
| Set the allowance, environment policy and quotas | | | | | yes |

Non-members get `404 project.not_found`, so a project's existence is not disclosed. Any member can leave, except the owner.

### Environments

A new project is `sandbox` only. Staff switch it to `sandbox+production`, which allows production apps. Apps never change environment: to move to production, create a production app. It gets its own credentials.

## Grants, the allowance and the capability catalog

- The only grants that exist are capabilities in the openvibe-contracts catalog, at the version Network has installed.
- **The grantability rule.** The contracts `visibility` enum is `public | partner | first-party | internal` (`partner` since the v0.83.0 release; Network pins v0.99.0). Only `active` capabilities with visibility `public` or `partner` may be granted to apps. Staff may put a `partner` capability in one project's allowance by hand, but it never comes from the default or the sandbox allowance. `first-party` and `internal` capabilities are never grantable: staff cannot add them to an allowance, members cannot request them, and token issuance filters them out again.
- **The allowance** is the set of grantable capabilities one project's apps may hold. Only staff set it. `DEV_DEFAULT_ALLOWANCE` seeds new projects, with public capabilities only. It is empty by default, so staff decide each project's **production** apps.
- **The sandbox allowance** is added to the allowance for **sandbox apps only**, in every project, without a staff decision. It comes from `DEV_SANDBOX_ALLOWANCE`. When that is unset, the code default is `media.object.upload`, `media.object.read`, `media.object.list`, `media.object.delete`, `events.app.publish`, `events.app.read`, `events.app.subscribe`, `tools.job.create`, `tools.job.read` and `tools.job.cancel`. Only `public` + `active` capabilities of the installed openvibe-contracts catalog count. `partner`, `first-party`, `internal` and unknown ids are dropped. The three `events.app.*` ids are defined from openvibe-contracts v0.28.0 (Network pins v0.99.0); with an older release they would be left out. `media.object.list` and `media.object.delete` (Media's list and delete verbs, WS-G task 2) are left out the same way until the pinned release defines them; until then a sandbox app's upload and read grants cover them at Media. The project view and `GET /catalog` show it as `sandbox_allowance`. Production apps never use it.
- **A grant never exceeds the allowance** (for a sandbox app: allowance ∪ sandbox allowance). It is checked in three places. Approval refuses with `403 grant.beyond_allowance`. Shrinking the allowance revokes approved grants, and denies requested ones, that fall outside it. A sandbox app's grant that is still inside the sandbox allowance is kept. Token issuance intersects approved grants with the current allowance and with the current grantability.
- A developer's grant request waits in `requested`. When an owner or admin makes the request and the capability is inside the allowance, it is approved at once.
- `GET /api/v1/projects/catalog` lists what could ever be granted.

## Tokens

Apps use the same `/oauth/token` endpoint as service principals. A client id of the form `app_<ULID>` routes the request to the developer path.

| App type | Grant | Request |
|---|---|---|
| confidential | `client_credentials` | `client_id`, `client_secret`, `audience`, optional `scope` (space-separated capability ids to narrow) |
| public or confidential | `authorization_code` | `client_id`, `code`, `redirect_uri`, `code_verifier`, `audience`, optional `scope`, plus `client_secret` if confidential |

Authorization code flow: `/oauth/authorize` needs `code_challenge` with `code_challenge_method=S256` for every app, public or confidential. The redirect URI must match a registered one exactly. `prompt=none` is refused with `error=interaction_required`, so an app never gets a code without the person choosing to continue. The account chooser labels the app "(third-party app)". A sandbox app can be authorized only by members of its project. Codes are single use and expire after 5 minutes. A failed PKCE check burns the code. The `scope` passed to `/authorize` (capability ids) limits what the code can yield, and the exchange can narrow it but never widen it.

### Claims

Tokens are RS256 and last 5 minutes. They are signed with Network's key (JWKS at `/api/.well-known/jwks`) and shaped by `identity.service-token-claims@1`.

| Claim | Value |
|---|---|
| `sub` | `app:app_<ULID>` |
| `actor_type` | `app` |
| `aud` | `[audience]`, one audience per token |
| `cap` | approved grants for that audience ∩ allowance ∩ grantable now (or the requested `scope` subset) |
| `ns` | `[project_id, app.<project_id>.*]`. Tenancy in other services is keyed by project id (ADR-014). Media names the project's namespaces `app.<project_id>` (production) and `app.<project_id>.sandbox`, with children below them, and checks each verb (read, list, write, delete, transform) per namespace; it reads an older token's `[project_id]` as `app.<project_id>.*` (roadmap WS-G task 2). |
| `project_id` | `prj_<ULID>` (optional in the contract today; proposed as required for apps) |
| `env` | `sandbox` or `production` (same) |
| `on_behalf_of` | `usr_<ULID>` of the person who authorized the app (authorization code only) |
| `iat`, `exp`, `jti` | 300-second lifetime |

No refresh tokens are issued to apps. A confidential app asks again with its secret, and a public app goes through authorization again.

### Sandbox tokens

The sandbox check works in two layers.

1. **Issuance.** A sandbox app gets a token only for an audience listed in `DEV_SANDBOX_AUDIENCES`. When that is unset, the code default is `openvibe.media`, `openvibe.events` and `openvibe.tools`. Set it to an empty value to turn sandbox tokens off. Any other audience gets `400 invalid_target`. `openvibe.network` is not in the default. This layer protects every receiver today, including ones whose openvibe-contracts `verifyServiceToken` does not know about `env` yet.
2. **Receivers.** A receiver refuses `env: sandbox` with `401 token.sandbox_refused` unless it opted in. Network does this in its own capability guard (`server/identity/principals.js`) and accepts sandbox only if `openvibe.network` is in `DEV_SANDBOX_AUDIENCES`. `server/developer/policy.js` exports `environmentDecision(claims, { acceptSandbox })` for the check. openvibe-contracts (≥ 0.26.0) `verifyServiceToken` / `requireCapability` do the same with an `acceptSandbox` option that defaults to false.

An audience opts in when it can keep sandbox traffic apart from real data: for example, test-flagged money in Billing (ADR-012 rule 9), or a sandbox tenant in Media. First-party service tokens carry no `env` and are treated as production. The three default audiences must accept sandbox tokens themselves. Issuance working does not mean they do. Media (sandbox tenants keyed by project id) and Events (env-marked app events) take that on in the same Wave 20 step. Tools must accept `env: sandbox` on `/api/v1/jobs`; until it does, a sandbox app's Tools token is refused with `401 token.sandbox_refused` there.

### Export tokens

A project's owner or admin exports everything the project holds on openvibe.codes (roadmap WS-N task 9). Codes calls `POST /api/v1/projects/:project/export-tokens { audience, env }` with the person's own token, once per audience and environment, and reads with what Network returns. Network checks the role at mint time; developers and viewers get `403 project.forbidden`, non-members `404`, and staff who are not an admin member of the project `403`. An archived project can still be exported.

The token is shaped as an app token, so Media and Events accept it without changes:

| Claim | Value |
|---|---|
| `sub` | `app:app_<the project's ULID>`: the project's export principal. No app has this id and `/oauth/token` never issues it, so a receiver log line naming it is an export of that project. |
| `actor_type` | `app` |
| `aud` | `[openvibe.media]` or `[openvibe.events]` (anything else is `422 export.invalid_audience`) |
| `cap` | Media: `media.object.list`, `media.object.read`. Events: `events.app.read`. Never a write, publish or subscribe capability. |
| `ns`, `project_id` | as for app tokens: `[project_id, app.<project_id>.*]` |
| `env` | `sandbox` or `production`, as asked (anything else is `422 export.invalid_env`). Each receiver still decides whether it accepts `env: sandbox`. |
| `on_behalf_of` | the person exporting |
| `purpose` | `export` |
| `iat`, `exp`, `jti` | 300-second lifetime, no refresh (Codes asks again during a long export) |

The capabilities do not come from the project's grants or allowance. Those bound what the project's apps may do; an export token reads back what the project already holds, for its owner or admin. Every mint writes a `dev_audit` row, `project.export_token_issued`, with the audience, environment, capabilities, `jti` and expiry. The row is not a platform event, and the token itself is never stored or logged (`test/developer-export-tokens.test.js`).

### A new project without staff

With the defaults above, this works with no staff action:

1. Create a project (`POST /api/v1/projects`). You are the owner.
2. Create a sandbox confidential app (`POST /:project/apps` with `environment: sandbox`). The secret is shown once.
3. Request grants from the sandbox allowance (`POST /:project/apps/:app/grants`). An owner's or admin's request is approved at once. A developer's request waits for an owner or admin, who can approve it without staff.
4. `POST /oauth/token` with `grant_type=client_credentials` and `audience=openvibe.media` (or `openvibe.events`, `openvibe.tools`). The token has `env: sandbox`, `project_id` and `ns: [project_id, app.<project_id>.*]`.

Production apps still need staff: the project's environment policy (`sandbox+production`) and its allowance.

### Revocation

| Action | Effect on new tokens | Effect on tokens already issued |
|---|---|---|
| Revoke a credential | That secret fails at once (`401 invalid_client`) | They stay valid until `exp`, at most 5 minutes |
| Rotate a credential | New secret returned once. Previous secrets stay valid for `overlap_seconds` (default `DEV_CREDENTIAL_OVERLAP_S` = 86400, range 0–604800), then fail. | unchanged |
| Revoke an app | All of its credentials and pending codes fail at once | at most 5 minutes |
| Revoke a grant, or shrink the allowance | The capability leaves new tokens at once | at most 5 minutes |
| Archive a project | Every app is revoked | at most 5 minutes |

This is ADR-014's acceptance rule: "a revoked credential fails everywhere within one token lifetime (5 minutes)". Receivers verify tokens offline, so Network cannot recall a token it has already issued.

## Quotas

A quota says how much of one capability a project may use: for example, `media.object.upload` with limit 1073741824, window `total`, unit `bytes`. Network records quotas and shows them to members. **Network does not enforce them.** The service that owns the capability does (`enforced_by` in the response is that audience). An owning service reads a project's quotas through `GET /internal/projects/:project_id` ([Service-side project reads](#service-side-project-reads)). Until that service enforces what it reads, a quota is a recorded limit and not a guarantee. What a quota's current window has used is measured from the services' usage rollups ([Usage](#usage)).

## Usage

The services that own developer capabilities count each project's use per environment and UTC hour, and send one rollup per closed hour through OpenVibe.Events (roadmap WS-N task 4): `tools.usage.recorded` from each Tools satellite (jobs, per `tools.job.create` or `tools.tool.run` and job type or tool) and `events.usage.recorded` from Events (`events.app.publish` in `events`, `events.app.subscribe` in `deliveries`). The payload is `common.usage-recorded@1` (openvibe-contracts 0.63.0): project, environment, capability, dimension, unit, window, quantity, errors, errors by code and up to ten sampled failures (time, code, status, trace id, job or event id). A rollup never names who did the work.

Rollups are counts for quotas and dashboards, never money. Network never ingests the `platform.usage-sample` readings and stores no subject with a count. Money lives only in Billing.

The Events consumer (`POST /internal/events`, [server/developer/usage.js](../server/developer/usage.js)) records each one inside its inbox transaction:

- `dev_usage_windows`: one row per rollup key (service, project, environment, capability, dimension, unit, window start). A later rollup for the same key replaces it (the higher `revision` wins), so a re-sent hour is never counted twice. Kept 35 days.
- `dev_usage_daily`: the same key per UTC day, added up again from its windows on every change. Kept 400 days.
- `dev_usage_errors`: the sampled failures. Kept 30 days, at most 200 per project.

A rollup for a project Network does not know, from the wrong source, whose subject is not its project, whose window is not a whole hour (or day), from the future or older than 35 days, or that fails its contract is ignored (the consumer's `outcome` says which).

`GET /api/v1/projects/:project/usage?days=30&env=all` (owner and admins, and staff) answers `network.project-usage-result@1`: `daily` rows (newest first), `totals` for the range, `quotas` (each recorded quota with `used` and `remaining` for its current window: today or this month in UTC, or the 400 days kept for `total`, in every environment together; `null` with a `note` for a minute or hour window, which rollups cannot show, and for a capability or unit no service reports), and `errors` (`total`, `by_code`, and the 50 most recent sampled failures). `days` is 1 to 90; `env` is `all`, `sandbox` or `production`; anything else is `422 usage.invalid`. The numbers lag by one hour: an hour appears a few minutes after it closes. OpenVibe.Codes shows it as the project's usage page (`/projects/:project/usage`).

Operator steps: subscribe Network to the two topics once (`node --env-file=/etc/openvibe/network.env scripts/subscribe-events.js --topic tools.usage.recorded --topic events.usage.recorded`), with Events' usage on (default) and Tools' job events on (`EVENTS_URL` set for the satellites).

## API

Base: `/api/v1/projects`. Every call needs `Authorization: Bearer <Network user access token>`.

- Cookies are not read, so this API has no CSRF surface.
- The shared internal key Network retired (plan T2) is never accepted.
- Service and app tokens are not users and get `401`.
- Tokens past `exp` are refused, even inside the normal 60-day session grace period.
- Errors are RFC 9457 `application/problem+json`, with a stable `code`.
- Every response carries `X-OpenVibe-Request-Id` (a caller's own id is echoed back) and `traceparent`.
- Responses are `Cache-Control: private, no-store`.
- Rate limit: 60 requests per minute (plus the global `/api` limit).

| Method and path | Who | Body / result |
|---|---|---|
| `GET /catalog` | any user | grantable capabilities |
| `POST /` | any user | `{ name }` → project (caller is owner). At most `DEV_MAX_PROJECTS_PER_OWNER` active projects. |
| `GET /[?all=1]` | any user | my projects; staff may pass `all=1` |
| `GET /:project` | viewer+ | project with `role`, `allowance`, `environments`, counts |
| `PATCH /:project` | admin+ | `{ name }` |
| `POST /:project/archive` | owner, staff | irreversible; revokes every app |
| `PUT /:project/allowance` | staff | `{ capabilities: [...] }` → `{ allowance, trimmed }` |
| `PUT /:project/environment-policy` | staff | `{ environment_policy: 'sandbox' \| 'sandbox+production' }` |
| `GET /:project/members` | viewer+ | |
| `POST /:project/members` | admin+ (owner for `admin`) | `{ username \| subject_id, role }` |
| `PATCH /:project/members/:subject` | admin+ (owner for admins) | `{ role }` |
| `DELETE /:project/members/:subject` | admin+, or yourself | |
| `GET /:project/apps`, `GET /:project/apps/:app` | viewer+ | never secrets |
| `POST /:project/apps` | developer+ (admin+ for production) | `{ name, environment, type, redirect_uris }` → app, plus `credential.client_secret` **once** if confidential |
| `PATCH /:project/apps/:app` | as above | `{ name, redirect_uris }` |
| `DELETE /:project/apps/:app` | as above, or staff | revoke |
| `GET /:project/apps/:app/credentials` | viewer+ | id, last four characters, state (`active`, `expiring`, `expired`, `revoked`), dates |
| `POST /:project/apps/:app/credentials/rotate` | as app | `{ overlap_seconds? }` → new secret **once** |
| `POST /:project/apps/:app/credentials/:credential/revoke` | as app, or staff | immediate |
| `GET /:project/apps/:app/grants` | viewer+ | |
| `POST /:project/apps/:app/grants` | developer+ | `{ capability }` |
| `POST /:project/apps/:app/grants/:capability/approve` / `deny` | admin+ | |
| `DELETE /:project/apps/:app/grants/:capability` | admin+, staff | revoke |
| `GET /:project/agents[?owner=me]`, `GET /:project/agents/:agent` | viewer+, staff | agents acting for a member through an app or service host (`docs/t2-projects-and-grants.md`) |
| `POST /:project/agents` | developer+ for yourself (admin+ for a production app host) | `{ name, host: { type: 'app' \| 'service', id } }` |
| `PATCH /:project/agents/:agent` | its owner, admin+ | `{ name }` |
| `POST /:project/agents/:agent/pause` / `resume`, `DELETE /:project/agents/:agent` | its owner, admin+ (staff may pause and revoke) | pausing or revoking cancels its pending and approved-unused confirmations |
| `GET /:project/agents/:agent/grants` | viewer+, staff | delegated grants with `effective_mode` and `within_host` |
| `PUT /:project/agents/:agent/grants/:capability` | its owner only | `{ mode: 'auto' \| 'confirm', expires_at? }`, inside the host's ceiling |
| `DELETE /:project/agents/:agent/grants/:capability` | its owner, admin+, staff | revoke; deletes its budget, cancels its confirmations and standing rules |
| `GET /:project/agents/:agent/budgets` | viewer+, staff | `{ budgets: [{ capability, limit, window, unit, enforced_by }] }` |
| `PUT /:project/agents/:agent/budgets/:capability` / `DELETE` | its owner, admin+ (not staff) | `{ limit, window, unit? }`; needs an active grant (`404 grant.not_found`), never above the project's quota for it, same window and unit (`422 budget.beyond_quota`); `0` is allowed |
| `GET /:project/agents/:agent/rules` | viewer+, staff | the live standing rules left by approvals |
| `DELETE /:project/agents/:agent/rules/:rule` | its owner, admin+, staff | revoke a standing rule |
| `GET /:project/quotas` | viewer+ | |
| `PUT /:project/quotas/:capability` / `DELETE` | staff | `{ limit, window, unit }` |
| `GET /:project/usage[?days=&env=]` | admin+, staff | usage per day, totals, quotas with their use, errors ([Usage](#usage)) |
| `GET /:project/audit[?before=&limit=]` | admin+, staff | newest first, paged by `next_before` |
| `POST /:project/export-tokens` | owner, admin (not staff as such) | `{ audience, env }` → a 5-minute read-only export token ([Export tokens](#export-tokens)) |

### The confirmation inbox

Base: `/api/v1/confirmations`, with the same rules as above (Bearer user tokens only, problems, request ids, private
no-store, 60 requests per minute). A confirmation is a sensitive use of a delegated grant waiting for the agent's owner
(`network.confirmation-request@1`, `server/developer/confirmations.js`); only that owner sees it, so anyone else,
admins and staff included, gets `404 confirmation.not_found`.

| Method and path | Body / result |
|---|---|
| `GET /[?state=pending&before=&limit=]` | `{ confirmations: [<network.confirmation-request@1>], agents: { "agt_…": { name, project_id, host } }, next_before }`; `state` is `pending` (default), `approved`, `denied`, `expired` or `cancelled`; newest first |
| `GET /:id` | `{ confirmation, agent }` |
| `POST /:id/approve` | `{ standing_rule?: 'once' \| 'session' \| 'until' \| 'always', until? }` → `{ confirmation, rule? }`; `session` needs the request's `session_id` (`422 confirmation.no_session`) and lasts at most 24 hours, `until` is required for `until` and at most 30 days away |
| `POST /:id/deny` | `{}` → `{ confirmation }` |

A decision on anything but a pending row is `409 confirmation.not_pending`; a pending row past `expires_at` is
`409 confirmation.expired`. Pending rows past `expires_at` read as `expired` at once and are recorded so by a sweep every
minute. Pausing or revoking the agent, revoking or expiring its grant, shrinking its host's ceiling, the owner leaving
the project or being erased, revoking the host app and archiving the project cancel the affected pending and
approved-unused confirmations (`cancel_reason` names the cause) and revoke the matching standing rules. The owning
services create, read, consume and cancel them at `/internal/confirmations` ([Service-side agent reads and
confirmations](#service-side-agent-reads-and-confirmations)); agent tokens come in a later slice. When a new
confirmation is left pending, the owner gets a `CONFIRMATION_REQUESTED` notification (best-effort) whose message is the
agent's name and the summary as plain text, never the details; a standing rule's approval notifies nobody.

### Service-side project reads

`GET /internal/projects/:project_id` (loopback only, like all of `/internal`) needs a service token holding `network.project.read` for `openvibe.network`. Owning services use it to key tenancy by `project_id` and to enforce the quotas Network records (ADR-014).

- **Who.** By default only Host holds it (`DEFAULT_GRANTS`), because Host places and runs workloads per project. Another service gets a row only when it ships a caller. The capability is `first-party` and is never granted to apps: staff cannot add it to an allowance, and a person's session or an app token gets `401`/`403`.
- **Result** (`Cache-Control: no-store`): `{ project, allowance, quotas, apps, grants }`.
  - `project`: `id`, `name`, `owner` (`{ type: 'user', id: usr_… }`), `environment_policy`, `home_cell`, `residency` (the home cell's), `preferred_regions`, `created_at`, `archived_at`.
  - `quotas[]`: `capability`, `limit`, `window`, `unit`, `enforced_by`.
  - `apps[]`: `id`, `name`, `environment`, `status` (`active` or `revoked`), `created_at`, `revoked_at`. Revoked apps are listed too.
  - `grants[]`: `app_id`, `capability`, `audience`, `status` (`requested`, `approved`, `denied` or `revoked`), `decided_at`. These are every app's grants, including those of revoked apps: a revoked app's grant that was not denied reads `revoked`, with `decided_at` the app's revocation time (revoking an app or archiving its project leaves the grant rows themselves unchanged).
- **Never in it:** secrets or their hashes, client ids, redirect URIs, credentials, members other than the owner, or who requested or decided a grant.
- **Archived projects** still read, with `archived_at` set and every app revoked.
- **Errors:** an unknown or malformed id is `404 project.not_found`; no token is `401 token.missing`; a token without the capability is `403`.
- **Catalog.** `network.project.read` is `planned` in openvibe-contracts until Contracts makes it `active`. The guard accepts `planned` and refuses only `retired`.

Redirect URIs must be https. `http://localhost`, `127.0.0.1` and `[::1]` are allowed for sandbox apps only. Fragments and embedded credentials are refused. At most 10 per app. A public app needs at least one. A project has at most `DEV_MAX_APPS_PER_PROJECT` active apps.

### Service-side agent reads and confirmations

Loopback only, service tokens for `openvibe.network`, `Cache-Control: no-store`. The caller's audience is `openvibe.<service>` from its token (`svc:media` → `openvibe.media`); it only ever sees its own audience's grants and its own confirmations (`docs/t2-projects-and-grants.md` §4–5).

| Route | Capability | Result |
|---|---|---|
| `GET /internal/agents/:agent` | `network.project.read` | `{ agent, grants, budgets }`: the agent's active, unexpired grants at the caller's audience (`capability`, `audience`, `mode`, `effective_mode`, `sensitive`, `expires_at`) and those grants' budgets; `grants: []` when the caller's audience has none or the agent is not `active`. `project_id`, `owner` and `host` only for a service the agent concerns (an active grant at its audience, or its service host); any other caller gets `agent: { id, subject }`; `404 agent.not_found` |
| `POST /internal/confirmations` | `network.confirmation.manage` | `{ requested_by: { type: 'agent', id }, capability, summary, details?, resources?, request_digest, session_id?, ttl_s? }` → `201 { confirmation }` pending, or `200` when a standing rule approved it. The owner is the agent's, never the body's; the capability must be the caller's own (`403 confirmation.wrong_audience`) |
| `GET /internal/confirmations/:id` | `network.confirmation.manage` | `{ confirmation, used_at }` |
| `POST /internal/confirmations/:id/consume` | `network.confirmation.manage` | `{ request_digest }` → `{ confirmation, used_at }`, once, after re-checking the agent, its owner, host, grant and budget; `409 confirmation.used`, `.mismatch`, `.expired`, `.cancelled`, `.not_pending`, `.agent_inactive`, or `403 grant.not_delegated` |
| `POST /internal/confirmations/:id/cancel` | `network.confirmation.manage` | `{ confirmation }`; a pending or approved-unused one becomes `cancelled`, again is a no-op, a used, denied or expired one is `409 confirmation.not_pending` |

Another service's confirmation is `404 confirmation.not_found`. No token is `401 token.missing`; a token without the capability is `403`. Host holds `network.project.read`; no service holds `network.confirmation.manage` by default until one ships a receiver.

## Events

Topic, with subject and payload:

- `network.app.created`: subject `{ type: 'app', id }`, payload `{ project_id, environment, client_type }`
- `network.app.revoked`: subject `{ type: 'app', id }`, payload `{ project_id, environment, reason }`
- `network.credential.rotated`: subject `{ type: 'app', id }`, payload `{ project_id, credential_id, previous_valid_until }`
- `network.credential.revoked`: subject `{ type: 'app', id }`, payload `{ project_id, credential_id }`
- `network.grant.changed`: subject `{ type: 'app', id }`, payload `{ project_id, capability, audience, from, to }`

Each event is written as a validated `events.event-envelope@1` (source `network`, visibility `internal`) in the same transaction as the change, inside its `dev_audit` row (`event_type`, `event`).

**Relay to OpenVibe.Events** (`server/developer/event-relay.js`, openvibe-sdk v0.2.2 `createOutbox` and `createEventsClient`):

- It runs only when `OV_EVENTS_INTERNAL_URL` is set (production: `http://127.0.0.1:4300`). When it is unset, nothing is sent and no outbox table is created.
- When the relay is on, `audit()` also enqueues the envelope into `network_event_outbox` in the same transaction as the audit row. If the enqueue fails, no audit row and no change are written.
- On start it backfills every `dev_audit` event that is not in the outbox yet (`INSERT OR IGNORE` by `event_id`, in `dev_audit` id order). Events written while the relay was off are delivered too.
- Rows are published in id order and at least once. Events answers a repeated `event_id` as a duplicate. Sent rows are kept (never pruned), so a later backfill cannot republish an event that Events has already forgotten.
- Authentication: Network is the issuer, so it signs its own 5-minute service token: `sub svc:network`, `actor_type service`, `aud [openvibe.events]`, `cap [events.event.publish]`, shaped by `identity.service-token-claims@1`. Events allows the `network` source to publish `network.*`.

Until the relay is turned on in an environment, nobody else receives these events there.

## Secrets

- A client secret is returned only in the response that created it (app creation or rotation), marked `shown_once`. After that it cannot be retrieved. Rotate to get a new one.
- Only `sha256(secret)` is stored. The secret is 256 random bits, so a fast hash is enough.
- Audit rows, error responses and logs carry credential ids and the last four characters, never the secret. Unexpected errors are logged without request bodies.
- The test (`test/developer-projects.test.js`) scans every table and all captured log output for each secret it created.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `DEV_SANDBOX_AUDIENCES` | unset: `openvibe.media,openvibe.events,openvibe.tools` | Audiences that accept sandbox tokens (comma list). Unset means the code default; an empty value means none. |
| `DEV_SANDBOX_ALLOWANCE` | unset: `media.object.upload,media.object.read,media.object.list,media.object.delete,events.app.publish,events.app.read,events.app.subscribe,tools.job.create,tools.job.read,tools.job.cancel` | Public capabilities sandbox apps may hold without staff (comma list, filtered to public + active capabilities of the installed catalog). Unset means the code default; an empty value means none. |
| `OV_EVENTS_INTERNAL_URL` | unset (relay off) | OpenVibe.Events base URL for relaying developer-project events |
| `DEV_CREDENTIAL_OVERLAP_S` | 86400 | Default rotation overlap (0–604800) |
| `DEV_DEFAULT_ALLOWANCE` | empty | Public capabilities a new project starts with |
| `DEV_MAX_PROJECTS_PER_OWNER` | 10 | Active projects per owner |
| `DEV_MAX_APPS_PER_PROJECT` | 20 | Active apps per project |
| `AGENT_HOST_SERVICES` | unset: `actor` | First-party services (OAuth client ids) that may host a member's agents (comma list; `docs/t2-projects-and-grants.md`). Each must also be an OAuth client. Unset means the code default; an empty value means none. |

## Known gaps (next steps)

- **Consent screen (backend built; page next).** The account chooser shows the app's name, not the capabilities it asks for. Codes and Network need a consent step before third-party production apps go live, and it must list the capability ids the app asks for, marking the ones `capability@1` marks `sensitive`; a request without a `scope` must not consent to capabilities the screen did not name. This screen is the app path's compensation for not using the agent confirmation flow — an authorization-code app acts for a person who is present and authorizes it capability by capability, so it carries no `cap_confirm` (decided 2026-10-04, `docs/t2-projects-and-grants.md` section 9). **The backend half is built:** `GET /oauth/client-info` with the authorize request's `scope` returns `capabilities: [{ id, name, description, sensitive }]` — the app-grantable requested ids, in the order requested, with `description` and `sensitive` from the `capability@1` catalog (`name` is the catalog id, since `capability@1` has no separate display name) — and `refused: [id]` for the unknown or ungrantable ones the page must not name; without a `scope` it returns `capabilities: []`. The authorization code an app receives now carries the explicit consented set (`tokens.issueCode`), so an absent or empty `scope` consents to nothing: the code stores an empty set and the token exchange mints a token with `cap: []` (the person is still identified by `on_behalf_of`), and asking the token endpoint for an id outside that set is `invalid_scope`. Apps have no refresh tokens, so no refreshed token can widen the set either. What remains is the API design session's page: render `capabilities` from `client-info`, mark the `sensitive` ones, and say the `refused` ids will not be granted (`test/consent-screen.test.js`).
- **Service-side project reads.** The route is built, but no service calls it yet. Host holds the grant. Contracts still has to make `network.project.read` `active`.
- **PowerChat as the first project** (ADR-014 migration). This is not done. PowerChat's existing OAuth client is unchanged.
- **Receivers.** Every default sandbox audience must refuse `env: sandbox` except on routes that keep sandbox data apart, and must key tenancy by `project_id`. Media and Events do this in Wave 20. Tools does not yet (see [Sandbox tokens](#sandbox-tokens)).
- **Revocation fan-out.** The relayed `network.app.revoked` event is the signal receivers can use to disable an app's subscriptions or tenants early. OpenVibe.Events acts on it (and on `network.grant.changed` withdrawing `events.app.subscribe`): it disables the app's subscriptions and refuses its tokens issued before the revocation. That needs this relay switched on. A receiver that does not act on it only stops the app when its issued tokens expire (within 5 minutes); state the app created there (for example a Media object) is untouched by Network.

## Public discovery and CORS

`/.well-known/openvibe`, `/api/v1/registry` with everything under it, and `/contracts/<domain>/<name>.v<N>.json` answer any origin (`server/public-cors.js`):

- `Access-Control-Allow-Origin: *`, never with credentials
- preflight `204` with `GET, HEAD, OPTIONS` and the request headers `traceparent`, `X-OpenVibe-Request-Id`, `Authorization` and `Content-Type`
- `X-OpenVibe-Request-Id` and `traceparent` exposed
- `Cross-Origin-Resource-Policy: cross-origin`

A browser app can discover services, capabilities and schemas without a server of its own. Caching is unchanged (`public, max-age=…`). Every other route, including this projects API, `/api/auth/*` and `/oauth/*`, keeps the first-party CORS allow-list.
