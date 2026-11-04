# Developer API keys and per-project budgets

Plan G-P3 (AI Exchange). Network stays the identity authority: it owns the developer projects, the
apps in them, the grants those apps hold, and — since this document — the **developer API keys** and
the **per-project monthly budget**. OpenVibe.AI is the service that spends for a project; it reads
the budget and authenticates the keys with its own service token, and it never stores a secret.

Everything new here is behind `NETWORK_DEV_API_KEYS=1`. While the flag is off, every route below
answers `503 api_keys.disabled` and nothing is written.

## What exists today (before this change)

| Thing | Where | Notes |
|---|---|---|
| Developer projects | `migrations/0001_initial.sql:436` (`dev_projects`), `server/developer/store.js` | `prj_<ULID>`, one owner, members with roles, an allowance, an environment policy, an archive. |
| Project members and roles | `server/developer/store.js` (`addMember`, `updateMember`, `removeMember`) | owner / admin / developer / viewer. |
| Developer apps | `migrations/0001_initial.sql:457` (`dev_apps`), `server/developer/store.js` (`createApp`) | An OAuth client: `client_id` **is** its app id (`app_<ULID>`). Environment `sandbox` or `production`, type `confidential` or `public`. |
| App credentials (client secrets) | `migrations/0001_initial.sql:471` (`dev_credentials`), `server/developer/store.js` (`insertCredential`, `rotateCredential`, `revokeCredential`, `matchSecret`) | `ovsec_…`, 256 random bits, **only sha256(secret) is stored**; the secret is shown once; rotation keeps the old secret valid for an overlap; revocation is immediate. |
| Scoped grants | `migrations/0001_initial.sql:484` (`dev_grants`), `server/developer/store.js` (`requestGrant`, `decideGrant`) | One capability per app, `requested` / `approved` / `denied` / `revoked`, never outside the project's allowance. |
| Client-credentials tokens | `server/developer/tokens.js` (`handleTokenRequest`, `mint`), `server/auth/oauth-routes.js` (`POST /token`) | `/oauth/token` with `grant_type=client_credentials` for a confidential app: a 5-minute RS256 token, `sub app:app_<ULID>`, `cap` = approved grants ∩ allowance ∩ grantable, `ns [project_id, app.<project_id>.*]`, `project_id`, `env sandbox|production`. |
| Revocation | `server/developer/store.js` (`revokeAppTx`, `revokeCredential`), `server/developer/tokens.js` (`usableApp`) | A revoked credential fails at once; a revoked app or a revoked grant stops new tokens at once; issued tokens live at most 5 minutes. |
| The append-only audit | `migrations/0001_initial.sql:518` (`dev_audit`), `server/developer/store.js` (`audit`, `listAudit`) | One row per change, with ids and scopes — never a secret. |
| Project quotas (not money) | `migrations/0001_initial.sql:496` (`dev_quotas`), `server/developer/store.js` (`setQuota`) | A limit, a window and a unit. Network records them; the owning service enforces them. **Not a budget.** |
| Project secrets (ADR-056) | `server/developer/secrets.js`, `migrations/0023_project_secrets.sql` | Named, encrypted values a service may sign with or reveal. Not an API key. |
| Service-side project read | `server/internal/routes.js` (`GET /internal/projects/:project_id`), `server/developer/store.js` (`internalProjectView`) | `network.project.read` on a service token; the view carries the tenancy, the allowance, the quotas, the apps and their grants. |
| How OpenVibe.AI authenticates app tokens today | `OpenVibe.AI/server/auth.js` (`verify`, `requireCap`, `appOrCap`) | An app token (`sub app:app_<ULID>`, `actor_type app`) is refused on every first-party route and judged only on `ai.app.run` on the routes that take one (`appOrCap`). The token is verified offline against Network's JWKS, so a Network-minted token needs no change on AI's side. |

### There is no `hbt_` system

No `hbt_` prefix, no API-token table and no bearer-API-key route exist in this repository (the
`hbt_` naming in the plan is not implemented anywhere). The only API-key-like things are the
operator's own secrets (`RESEND_API_KEY`, `resend_api_key` in `server/secrets.js`) and the app
client secrets above. Both are first-party configuration, not developer credentials.

### The gap

- **No developer API key.** A developer who wants to call OpenVibe.AI from their own backend must
  keep an app client secret and run the OAuth client-credentials exchange themselves. There is no
  credential that is shown once, bound to a project, scoped, environment-separated, rotatable and
  revocable — and none that a service can authenticate directly from a bearer header.
- **No per-project money ceiling.** `dev_quotas` counts requests, bytes and tokens; it is not
  money and it is not a monthly ceiling. Nothing in Network told OpenVibe.AI how much a project may
  spend in a month (decision D1: integer nano-USD, never a float).
- **No scoped opaque exchange.** The plan's P3 asks for "hashing (and/or scoped opaque exchange to
  Network token)". Only the client-secret exchange existed; there was no way to present a project
  credential to a service and get a short-lived, scoped Network token back.

## What this change adds

### The key (`server/developer/api-keys.js`, table `dev_api_keys`)

A key is bound to **a project and one of that project's apps**, so the token it exchanges for is an
ordinary app token with the project's tenancy. The secret is `ovk_` plus 32 random bytes, base64url.

| Method and path | Who | Body / result |
|---|---|---|
| `GET /api/v1/projects/:project/api-keys` | viewer+, staff | `{ keys: [...] }` — metadata only, never a secret |
| `POST /api/v1/projects/:project/api-keys` | developer+ (admin+ for `live`) | `{ name, app_id, scopes, environment }` → the key plus `api_key` **once** (`shown_once: true`) |
| `POST /api/v1/projects/:project/api-keys/:key/rotate` | as the key's app needs | the same key id with a new secret, shown once; the old secret fails at once |
| `POST /api/v1/projects/:project/api-keys/:key/revoke` | as the key's app needs, staff | the key stops authenticating at once |

- **Stored:** `sha256(secret)` only (`key_hash`), the last four characters (`hint`), the scopes, the
  environment, the state and the dates. The secret is never stored, never logged, never audited.
- **Environment:** `test` or `live`. A `test` key belongs to a sandbox app and exchanges for a
  sandbox token (`env: sandbox`); a `live` key belongs to a production app and exchanges for a
  production token (`env: production`). A key that does not match its app's environment is refused.
- **Scopes:** Network's own vocabulary. `ai.inference` is the only scope today: it maps to the
  capability `ai.inference.create` (plan D8, contracts 0.284.0) and to the audience `openvibe.ai`.
- **Audit:** `api_key.created`, `api_key.rotated`, `api_key.revoked` and `api_key.exchanged` rows in
  `dev_audit`, with ids, scopes and the environment — never a secret.
- **Cascades:** revoking the app revokes its keys with it (`server/developer/store.js`,
  `revokeAppTx` → `apiKeys.revokeForApp`); archiving the project does the same through the app.

### The exchange (`POST /internal/api-keys/exchange`)

A developer shows their key to a service (OpenVibe.AI); the service sends it to Network with its
own service token and Network answers with the facts and a short-lived scoped token.

```
POST /internal/api-keys/exchange
Authorization: Bearer <the service's token for openvibe.network>   (network.project.read)
{ "api_key": "ovk_…", "audience": "openvibe.ai" }
```

```json
{
  "access_token": "<a 5-minute RS256 app token>",
  "token_type": "Bearer", "expires_in": 300,
  "project_id": "prj_…", "app_id": "app_…", "subject": "app:app_…",
  "environment": "test", "token_env": "sandbox",
  "scopes": ["ai.inference"], "capability": ["ai.inference.create"],
  "jti": "tok_…"
}
```

- The token is signed with Network's key and shaped by `identity.service-token-claims@1`, so a
  receiver verifies it offline exactly as it verifies an app token today
  (`sub app:app_<ULID>`, `actor_type app`, `aud [openvibe.ai]`, `cap [ai.inference.create]`,
  `ns [project_id, app.<project_id>.*]`, `project_id`, `env`).
- **The scope is enforced by Network.** A key may only be exchanged for an audience its scopes
  cover: `403 api_key.scope_denied` otherwise. The key's scopes decide the `cap` claim.
- A revoked key, an unknown key and a malformed key are the same `401 api_key.invalid`: a guess
  learns nothing, and a revoked key stops working at once.
- The key, its hash and the issued token never reach a log or an error message.

### The budget (`monthly_budget_nano_usd`)

The project's own monthly ceiling, an **integer number of nano-USD** (decision D1: 1e-9 USD, never
a float), kept as a decimal string so the value is exact at any size. `null` means no budget was
set.

| Method and path | Who | Body / result |
|---|---|---|
| `GET /api/v1/projects/:project/budget` | admin+, staff | `{ project_id, monthly_budget_nano_usd, currency: "nano_usd", updated_at }` |
| `PUT /api/v1/projects/:project/budget` | admin+, staff | `{ monthly_budget_nano_usd: "5000000000" }` (or `null` to clear) |
| `GET /internal/projects/:project_id/budget` | a service token with `network.project.read` | the same shape, `Cache-Control: no-store` |

The project view (`GET /api/v1/projects/:project`) carries `monthly_budget_nano_usd` too. Every
change is audited (`project.budget_set`) with the old and the new value, never anything else.

**OpenVibe.AI holds `network.project.read` by default** (`server/identity/principals.js`,
`DEFAULT_GRANTS`), so it reads the budget with its service token. The capability is first-party and
is never grantable to an app.

### Money stays in Billing

This budget is the **project's own ceiling**, not an account balance and not a hold. Billing owns
the money (the credit subledger, decision D2/D9): it reserves, settles and reports. Network stores
and publishes the ceiling; OpenVibe.AI reads it and refuses to start a run above it. No float ever
touches either side.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `NETWORK_DEV_API_KEYS` | unset (off) | `1` turns on the key lifecycle, the exchange and the budget routes |

## What is not here yet

- **The scope vocabulary is Network's own.** It is not the contracts capability catalog: the key
  holds `ai.inference`, and the exchange maps it to `ai.inference.create`. When the contracts
  catalog grows the scope list, the mapping moves into it.
- **A key is not bounded by its app's grants.** The key's scopes decide what the exchanged token
  may do. Intersecting them with the app's approved grants needs `ai.inference.create` in the
  installed contracts catalog (Network pins 0.280.0 today), which lands with the next contracts
  pin.
- **OpenVibe.AI does not read `ovk_` keys yet.** It authenticates app tokens today
  (`OpenVibe.AI/server/auth.js`). The exchange is what lets AI accept a developer's key: AI calls
  `/internal/api-keys/exchange` and uses the token it gets back, unchanged.
- **No public exchange route.** The exchange is internal: a third party cannot mint a token
  without a first-party service token. A public `POST /oauth/api-key/token` for developer CLIs is
  a later slice.
- **The budget is a ceiling, not a meter.** What a project actually spent comes from Billing's
  settlements; Network only holds the number the project set.

## Tests

`test/developer-api-keys.test.js` proves, with every log line captured:

- the key is shown once and only `sha256(secret)` is stored (the secret is nowhere in the row);
- a revoked key is refused at once, and rotating it invalidates the old secret at once;
- the scope is enforced: an audience the key's scopes do not cover is `403 api_key.scope_denied`,
  and the exchanged token carries `cap: ["ai.inference.create"]` (D8);
- the budget is read and written as a nano-USD string, a fraction is refused, and OpenVibe.AI reads
  it with its service token (`no-store`);
- the key never reaches a log line, an audit row or an error message;
- every route answers `503 api_keys.disabled` while the flag is off.
