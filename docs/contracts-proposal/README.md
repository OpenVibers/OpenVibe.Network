# OpenVibe.Contracts proposal: developer projects (Wave 20 foundation)

Changes Network needs in the next openvibe-contracts release. Network works without them today, because the new claims fit into `additionalProperties: true` and the sandbox check runs at issuance. Releasing them makes the rules binding for every receiver. Everything here is additive and backward compatible.

## 1. `identity.service-token-claims@1`: optional app claims

File: `identity.service-token-claims.v1.json`, the full proposed schema.

- New optional `project_id` (`^prj_<ULID>$`).
- New optional `env` (`sandbox | production`).
- New optional `on_behalf_of` (`^usr_<ULID>$`, authorization-code tokens only).
- New `allOf` rule: when `actor_type` is `app`, both `project_id` and `env` are required.

First-party service tokens are unchanged: no `env`, and they are treated as production. Add fixtures: a valid app token with `env: sandbox`, and an invalid app token without `project_id`.

## 2. `serviceAuth`: refuse sandbox tokens by default

`verifyServiceToken(token, { ..., acceptSandbox = false })` returns `{ ok: false, code: 'token.sandbox_refused' }` for claims with `env: 'sandbox'` unless `acceptSandbox` is true. `requireCapability(capability, { ..., acceptSandbox })` passes it through, and the problem status is 401. An unknown `env` value fails claim validation (`token.invalid_claims`).

Network's reference implementation is `server/developer/policy.js` `environmentDecision()`. Network's own guard already applies it.

## 3. `ids`: a project prefix

Add `project: 'prj'` to `PREFIX`, so `ids.newId('project')` works. Network currently builds `prj_` + `ids.ulid()`. Projects are not subjects, so `SUBJECT_TYPES` is unchanged.

## 4. Capability `visibility`: add `partner`

Today the enum is `public | first-party | internal`. The rule Network applies:

| visibility | grantable to third-party apps |
|---|---|
| `public` | yes, within the project's allowance (and may appear in a default allowance) |
| `partner` (new) | yes, but only when staff add it to one project's allowance by hand, never by default |
| `first-party` | never |
| `internal` | never |

A capability must also have `status: active`. Network already treats `partner` as grantable, so releasing the enum value needs no Network change.

## 5. New capabilities

In `../capabilities-proposal/`:

- `network.project.read`: first-party, planned. Owning services read a project's apps, revocation state, grants and quotas, so they can enforce quotas and key tenancy by `project_id`.
- `network.project.manage`: public, planned. What a delegated client (Codes CLI, SDK) will hold to manage projects for a member. Today the API authorizes members' own user tokens by project role.

## 6. Network service manifest

File: `network.service-manifest.json`. It adds the two capabilities, and it adds these to `eventsProduced`:

- `network.app.created`
- `network.app.revoked`
- `network.credential.rotated`
- `network.credential.revoked`
- `network.grant.changed`

Payloads are in `../developer-projects.md#events`. They are recorded in Network's audit as envelopes but not relayed to Events yet.
