# Same-owner machine pools

Several of one person's machines on the same local network can serve one model together through llama.cpp RPC:
`rpc-server` on the members and `llama-server --rpc` on the head (the pooled machines design, 2026-11-06). Network
holds the pool record (`bot.machine-pool@1`, `server/registry/machine-pools.js`, migration 0044); Node runs the
engines and the private link; AI routes and verifies the pool's offer. Pools across the internet, pools of different
owners and group pools are not enabled.

## How a pool comes together

1. **Each machine announces itself** with its own node token (`POST /api/v1/node/self/pools/announce`): a private
   IPv4 address and prefix configured on one of its interfaces (RFC 1918 only), its link port, its free VRAM and RAM
   and a short hardware name. Network takes the machine and its owner from the token and Bot, and the public address
   from the connection. A claimed owner, machine id or public address in the body is never trusted.
2. **The owner proposes the pool** on `/machines`. "Pool these machines" lists only machines that announced in the
   last five minutes, grouped by local network (one public address and one private subnet); the page gets an opaque
   network key, never an address or a public IP. Two to eight machines; the default head has the most free VRAM, and
   the owner can pick another.
3. **Each machine approves it on itself.** Node's local approve step shows the pool, asks the person at that machine,
   generates an Ed25519 key there, and uploads only its self-signed public certificate
   (`POST /api/v1/node/self/pools/:id/approve`). An owner session, an app or a service cannot approve for a machine,
   and one machine cannot approve for another. Every machine needs its own key; a private key is refused.
4. **Node measures each link** before serving (round trip under 5 ms; 1 Gb/s for models over 30B, 300 Mb/s below)
   and runs the engines.

A pool is never edited. Changing the head, the members or a key means a new pool and new approvals.

## While it serves

- Every member renews its readiness every two seconds (`POST /api/v1/node/self/pools/:id/status` with `{ ready }`);
  the answer carries the pool, so the same request rechecks membership. The pool's offer is ready only while every
  member has approved, renewed in the last ten seconds, and is still an active node of the owner.
- Idle-only and the kill switch hold across the pool: Node pauses the whole pool when any member is in use or
  stopped, and a member that is paused reports `ready: false`.
- Every read rechecks each member against Bot. A member removed from Bot, paired to a different owner or revoked, a
  member leaving (`POST /api/v1/node/self/pools/:id/leave`) or the owner pressing Stop pool
  (`POST /api/v1/machine-pools/:id/revoke`) revokes the whole pool and forgets its public certificates. Each Node
  sees the revocation at its next renewal and drops its private link and its key.

## The AI offer

`GET /internal/ai/offers` derives the pool from this record only. The head's offer gets `pool: { machines, head }`
(`ai.offer-pool@1`) and is ready only while the pool is; a member's own offer is left out while it is in a pool, so
the same GPU is never sold twice. A `pool` a reporter sends is dropped. One price, owner, audience and hours apply to
the whole pool. Certificates and addresses never go to AI. AI verifies the pool's answers as it would one machine's
and keeps a new or failed pool to the free tier only.

The owner's machines page shows each pool on its members' cards: the head, who has approved, who is ready, and each
machine's share of the pool's free VRAM, which is how its credits are split (a capacity share, not a speed claim).

## API

| Route | Who | Body → answer |
| --- | --- | --- |
| `GET /api/v1/machine-pools` | owner session | → `{ pools, candidates }` |
| `POST /api/v1/machine-pools` | owner session | `{ machines, head? }` → 201 `{ pool }` |
| `POST /api/v1/machine-pools/:id/revoke` | owner session | → `{ revoked }` |
| `POST /api/v1/node/self/pools/announce` | the machine | `{ address, port, free_vram, free_ram, hardware }` → `{ machine }` |
| `GET /api/v1/node/self/pools/:id` | a member | → `{ pool }` (`bot.machine-pool@1`) |
| `POST /api/v1/node/self/pools/:id/approve` | a member | `{ certificate }` → `{ pool }` |
| `POST /api/v1/node/self/pools/:id/status` | an approved member | `{ ready }` → `{ ok, pool }` |
| `POST /api/v1/node/self/pools/:id/leave` | a member | → `{ revoked }` |

The machine routes use the existing `network.node.self.manage` capability; each handler then checks the live node
principal and its exact membership. Migration 0044 is expand-only. `test/machine-pools.test.js` runs on the test
runner's isolated, migrated PGlite store.
