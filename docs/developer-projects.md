# Developer projects

Roadmap Wave 20 foundation. The binding decision is ADR-014 in OpenVibe.Contracts. Network owns developer projects: who may build on OpenVibe, which apps they run, what those apps may do, and how much they may use. OpenVibe.Codes (the portal, the next step) is a client of this API. It never enforces grants or quotas itself.

What exists today: the data model, the `/api/v1/projects` API, app tokens from `/oauth/token`, the sandbox check in Network's own capability guard, defaults that let a new project's sandbox apps work without staff (sandbox audiences and a sandbox allowance), the audit, and a relay of the audit's events to OpenVibe.Events (off until `OV_EVENTS_INTERNAL_URL` is set). What does not exist yet: a UI (Codes), a consent screen that lists capabilities, refresh tokens for apps, and service-side reads of projects (`network.project.read`, proposed). Quotas are enforced by the owning services, not here.

## Model

| Thing | Id | Notes |
|---|---|---|
| Project | `prj_<ULID>` | One owner (`usr_` subject). Has a name, an environment policy, an allowance and members. Archiving a project cannot be undone and revokes every app in it. |
| Member | subject `usr_<ULID>` | Role `owner`, `admin`, `developer` or `viewer`. There is exactly one owner, and ownership cannot be transferred through this API. |
| App | `app_<ULID>` (subject `app:app_<ULID>`) | An OAuth client. Its `client_id` is its app id. Environment `sandbox` or `production`. Type `confidential` (has a secret) or `public` (no secret, authorization code + PKCE only). Apps are stored apart from `oauth_clients`, so they never inherit first-party trust (CORS, SSO fan-out, FedCM). |
| Credential | `crd_<ULID>` | A client secret (`ovsec_…`, 256 random bits). Only its SHA-256 hash and last four characters are stored. |
| Grant | (app, capability) | `requested`, `approved`, `denied` or `revoked`. The audience is `openvibe.<capability owner>`. |
| Quota | (project, capability) | A limit, a window (`minute`, `hour`, `day`, `month`, `total`) and a unit (`requests`, `bytes`, `tokens`, …). |
| Audit | integer, append-only | SQLite triggers refuse UPDATE and DELETE. |

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
| Set the allowance, environment policy and quotas | | | | | yes |

Non-members get `404 project.not_found`, so a project's existence is not disclosed. Any member can leave, except the owner.

### Environments

A new project is `sandbox` only. Staff switch it to `sandbox+production`, which allows production apps. Apps never change environment: to move to production, create a production app. It gets its own credentials.

## Grants, the allowance and the capability catalog

- The only grants that exist are capabilities in the openvibe-contracts catalog, at the version Network has installed.
- **The grantability rule.** The contracts `visibility` enum is `public | first-party | internal`. Only `active` capabilities with visibility `public` may be granted to apps. `first-party` and `internal` capabilities are never grantable: staff cannot add them to an allowance, members cannot request them, and token issuance filters them out again. The code also accepts a proposed `partner` visibility. Staff may put a `partner` capability in one project's allowance by hand, but it never comes from the default allowance. `partner` is not in the enum yet; see `docs/contracts-proposal/`.
- **The allowance** is the set of grantable capabilities one project's apps may hold. Only staff set it. `DEV_DEFAULT_ALLOWANCE` seeds new projects, with public capabilities only. It is empty by default, so staff decide each project's **production** apps.
- **The sandbox allowance** is added to the allowance for **sandbox apps only**, in every project, without a staff decision. It comes from `DEV_SANDBOX_ALLOWANCE`. When that is unset, the code default is `media.object.upload`, `media.object.read`, `events.app.publish`, `events.app.read`, `events.app.subscribe`, `tools.job.create`, `tools.job.read` and `tools.job.cancel`. Only `public` + `active` capabilities of the installed openvibe-contracts catalog count. `partner`, `first-party`, `internal` and unknown ids are dropped. With openvibe-contracts v0.26.0 installed, the three `events.app.*` ids are not defined yet, so they are left out; they join the sandbox allowance on the first boot with v0.27.0 (not tagged at the time of writing). The project view and `GET /catalog` show it as `sandbox_allowance`. Production apps never use it.
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
| `ns` | `[project_id]`. Tenancy in other services is keyed by project id (ADR-014). |
| `project_id` | `prj_<ULID>` (optional in the contract today; proposed as required for apps) |
| `env` | `sandbox` or `production` (same) |
| `on_behalf_of` | `usr_<ULID>` of the person who authorized the app (authorization code only) |
| `iat`, `exp`, `jti` | 300-second lifetime |

No refresh tokens are issued to apps. A confidential app asks again with its secret, and a public app goes through authorization again.

### Sandbox tokens

The sandbox check works in two layers.

1. **Issuance.** A sandbox app gets a token only for an audience listed in `DEV_SANDBOX_AUDIENCES`. When that is unset, the code default is `openvibe.media`, `openvibe.events` and `openvibe.tools`. Set it to an empty value to turn sandbox tokens off. Any other audience gets `400 invalid_target`. `openvibe.network` is not in the default. This layer protects every receiver today, including ones whose openvibe-contracts `verifyServiceToken` does not know about `env` yet.
2. **Receivers.** A receiver refuses `env: sandbox` with `401 token.sandbox_refused` unless it opted in. Network does this in its own capability guard (`server/identity/principals.js`) and accepts sandbox only if `openvibe.network` is in `DEV_SANDBOX_AUDIENCES`. `server/developer/policy.js` exports `environmentDecision(claims, { acceptSandbox })` for the check. The proposal adds the same check to openvibe-contracts `verifyServiceToken` / `requireCapability` as an `acceptSandbox` option that defaults to false.

An audience opts in when it can keep sandbox traffic apart from real data: for example, test-flagged money in Billing (ADR-012 rule 9), or a sandbox tenant in Media. First-party service tokens carry no `env` and are treated as production. The three default audiences must accept sandbox tokens themselves. Issuance working does not mean they do. Media (sandbox tenants keyed by project id) and Events (env-marked app events) take that on in the same Wave 20 step. Tools must accept `env: sandbox` on `/api/v1/jobs`; until it does, a sandbox app's Tools token is refused with `401 token.sandbox_refused` there.

### A new project without staff

With the defaults above, this works with no staff action:

1. Create a project (`POST /api/v1/projects`). You are the owner.
2. Create a sandbox confidential app (`POST /:project/apps` with `environment: sandbox`). The secret is shown once.
3. Request grants from the sandbox allowance (`POST /:project/apps/:app/grants`). An owner's or admin's request is approved at once. A developer's request waits for an owner or admin, who can approve it without staff.
4. `POST /oauth/token` with `grant_type=client_credentials` and `audience=openvibe.media` (or `openvibe.events`, `openvibe.tools`). The token has `env: sandbox`, `project_id` and `ns: [project_id]`.

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

A quota says how much of one capability a project may use: for example, `media.object.upload` with limit 1073741824, window `total`, unit `bytes`. Network records quotas and shows them to members. **Network does not enforce them.** The service that owns the capability does (`enforced_by` in the response is that audience). Until an owning service reads project quotas (proposed capability `network.project.read`), a quota is a recorded limit and not a guarantee. No usage numbers are collected here.

## API

Base: `/api/v1/projects`. Every call needs `Authorization: Bearer <Network user access token>`.

- Cookies are not read, so this API has no CSRF surface.
- `X-Internal-Key` is never accepted.
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
| `GET /:project/quotas` | viewer+ | |
| `PUT /:project/quotas/:capability` / `DELETE` | staff | `{ limit, window, unit }` |
| `GET /:project/audit[?before=&limit=]` | admin+, staff | newest first, paged by `next_before` |

Redirect URIs must be https. `http://localhost`, `127.0.0.1` and `[::1]` are allowed for sandbox apps only. Fragments and embedded credentials are refused. At most 10 per app. A public app needs at least one. A project has at most `DEV_MAX_APPS_PER_PROJECT` active apps.

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
| `DEV_SANDBOX_ALLOWANCE` | unset: `media.object.upload,media.object.read,events.app.publish,events.app.read,events.app.subscribe,tools.job.create,tools.job.read,tools.job.cancel` | Public capabilities sandbox apps may hold without staff (comma list, filtered to public + active capabilities of the installed catalog). Unset means the code default; an empty value means none. |
| `OV_EVENTS_INTERNAL_URL` | unset (relay off) | OpenVibe.Events base URL for relaying developer-project events |
| `DEV_CREDENTIAL_OVERLAP_S` | 86400 | Default rotation overlap (0–604800) |
| `DEV_DEFAULT_ALLOWANCE` | empty | Public capabilities a new project starts with |
| `DEV_MAX_PROJECTS_PER_OWNER` | 10 | Active projects per owner |
| `DEV_MAX_APPS_PER_PROJECT` | 20 | Active apps per project |

## Known gaps (next steps)

- **Consent screen.** The account chooser shows the app's name, not the capabilities it asks for. Codes and Network need a consent step before third-party production apps go live.
- **Service-side project reads.** `network.project.read` (proposed) and `GET /internal/projects/:id` let owning services enforce quotas and check tenancy.
- **PowerChat as the first project** (ADR-014 migration). This is not done. PowerChat's existing OAuth client is unchanged.
- **Receivers.** Every default sandbox audience must refuse `env: sandbox` except on routes that keep sandbox data apart, and must key tenancy by `project_id`. Media and Events do this in Wave 20. Tools does not yet (see [Sandbox tokens](#sandbox-tokens)).
- **Revocation fan-out.** The relayed `network.app.revoked` event is the signal receivers can use to disable an app's subscriptions or tenants early. A receiver that does not act on it only stops the app when its issued tokens expire (within 5 minutes); state the app created there (for example a webhook subscription) is untouched by Network.

## Public discovery and CORS

`/.well-known/openvibe`, `/api/v1/registry` with everything under it, and `/contracts/<domain>/<name>.v<N>.json` answer any origin (`server/public-cors.js`):

- `Access-Control-Allow-Origin: *`, never with credentials
- preflight `204` with `GET, HEAD, OPTIONS` and the request headers `traceparent`, `X-OpenVibe-Request-Id`, `Authorization` and `Content-Type`
- `X-OpenVibe-Request-Id` and `traceparent` exposed
- `Cross-Origin-Resource-Policy: cross-origin`

A browser app can discover services, capabilities and schemas without a server of its own. Caching is unchanged (`public, max-age=…`). Every other route, including this projects API, `/api/auth/*` and `/oauth/*`, keeps the first-party CORS allow-list.
