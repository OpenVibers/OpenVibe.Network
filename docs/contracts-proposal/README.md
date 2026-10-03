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

# Agents and confirmations (plan T2 WS-Z2)

Changes the agents of `../t2-projects-and-grants.md` need beyond the pinned openvibe-contracts **v0.85.0**. Sections 1–4 above are published (v0.85.0 has the app claims, `prj`, `partner` and the two project capabilities). Everything below is additive. Until it is released, Network builds agents, delegated grants and the owner side of confirmations, but mints no agent token and serves no `/internal/confirmations` route.

## 7. `identity.service-token-claims@1`: agent claims

File: `identity.service-token-claims.v1.json`, the full proposed schema (the v0.85.0 schema plus these).

- `sub` gains `agent:agt_<ULID>` (as `ids.principalSub({ type: 'agent', id })` already returns), `actor_type` gains `agent`.
- New optional `cap_confirm`: exact capability ids the agent may use only with an approved confirmation (or a standing rule). `cap` holds only the delegated grants whose effective mode is `auto`; the two lists never overlap.
- New optional `act` (`{ sub }`, RFC 8693): the host that minted the token, `app:app_…` or `svc:<name>`.
- `on_behalf_of` also describes the agent's owner.
- New `allOf` rule: when `actor_type` is `agent`, `project_id`, `env` and `on_behalf_of` are required.

Add fixtures: a valid agent token with `cap_confirm`, and an invalid one without `on_behalf_of`. `serviceAuth` should treat a `cap_confirm` capability as not granted by `requireCapability` (the receiver checks the confirmation instead).

## 8. Event payload `network.confirmation.changed@1`

File: `network.confirmation.changed.v1.json`. One payload for every transition of a confirmation request (`created`, `approved`, `denied`, `expired`, `cancelled`, `used`), with the agent, project, capability, audience and new state. It never carries `summary` or `details`. Add `network.confirmation.changed` to the Network manifest's `eventsProduced` with it.

## 9. Capability `network.confirmation.manage`

In `../capabilities-proposal/network.confirmation.manage.json`: first-party, planned. What an owning service holds to create, read, consume and cancel the confirmations of its own sensitive capabilities (`POST /internal/confirmations`, `GET /internal/confirmations/:id`, `POST …/:id/consume`, `POST …/:id/cancel`).
