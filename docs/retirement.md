# The shared internal key: retired

Network's `/internal/*` routes took a deployment-wide shared key in parallel with capability-scoped service
tokens while the estate moved to service identities (roadmap Wave 22). The per-route telemetry and the
route-by-route procedure used to live in this file; its history has them.

The key was removed on 2026-09-29 (plan T2, register rows C-50–C-58):

- every route takes only a service token carrying the capability it performs; the router gate answers
  `401 token.missing` without a Bearer and keeps the exact-spelling rule;
- `principals.guard` has no legacy option;
- `principal_usage` records service tokens only;
- Network reads no such variable from its environment, and no route accepts one.

Which principal holds which capability is in `server/identity/principals.js`; the capabilities themselves
are in `openvibe-contracts`. Network's own calls to Live, Media and Tools carry its self-signed service
token (`server/identity/self-token.js`).
