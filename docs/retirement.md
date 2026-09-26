# Retiring the shared internal key (roadmap Wave 22)

Services moved to Network service tokens in Wave 1; `X-Internal-Key` still works in parallel. It is removed
**route by route, only after telemetry shows no caller** (roadmap §8, W22 exit: "every compatibility shim is
gone or has a dated, owned removal plan").

## Telemetry

Since 2026-09-23 every request that authenticates with the key is counted in `principal_usage`:

- capability-guarded routes: `auth = 'internal-key'`, `principal = 'legacy-key'` (their guard's decision);
- every other internal route: `auth = 'internal-key-route'`, `capability = '-'`.

```sql
-- routes still called with the key in the last 14 days
SELECT route, SUM(count) AS calls, MAX(last_at) AS last
FROM principal_usage
WHERE principal = 'legacy-key' AND last_at > datetime('now', '-14 days')
GROUP BY route ORDER BY calls DESC;
```

## Procedure per route

1. Find the caller (the route tells which service; grep that service for the path).
2. Move the caller to a service token (`network-principal.js` / `openvibe-sdk/auth`), add the capability
   to the route (`principals.guard(...)` + `TOKEN_ROUTES`), deploy.
3. Wait until the route shows no legacy-key calls for 14 days.
4. Remove the key path for that route (`legacy: false` on its guard, or drop it from the key-only router).
5. When no route accepts the key, delete `INTERNAL_API_KEY` from every env file and the middleware.

First observation (2026-09-23 04:50 UTC): `GET /internal/url-registry/resolved` (Live's registry refresh).

## Routes that take a token (Network side of step 2)

| Route | Capability | Rule for a token | Default grant holders |
| --- | --- | --- | --- |
| `GET /internal/identity/resolve`, `POST /internal/identity/resolve-batch` | `identity.subject.resolve` | — | Live, Media, Chat, Community, Billing, Tips, VIP, Blog, News, Deals, Games |
| `POST /internal/coins/credit`, `/debit` (`/transfer`: nobody holds it) | `network.coins.credit` / `.debit` | `app_id` = its own service | Live |
| `POST /internal/notifications/push`, `/push-bulk`, `/events/stream-live` | `network.notifications.push` | `service` = its own service | Live |
| `GET\|PUT\|DELETE /internal/modules/:ns/:subject` | `network.modules.read` / `.write` | granted namespaces | Live, Chat, Tools, Games |
| `GET /internal/url-registry/resolved` | `identity.subject.resolve` | — | Live (its only caller; still sends the key) |
| `GET /internal/coins/stats` | `network.coins.credit` | — | Live (its only caller; still sends the key) |
| `POST /internal/resolve-anon` | `identity.subject.resolve` | — | Live (its only caller; still sends the key) |
| `POST /internal/identity/legacy-map` | `identity.subject.resolve` | every `source_system` = its own service | Live (its only caller; still sends the key) |
| `POST /internal/link-account` | `identity.subject.resolve` | `service` = its own service | Live (its only caller; still sends the key) |

The last five accept a token since 2026-09-24 and keep the key. No new grant was needed: their only caller,
Live, already holds `identity.subject.resolve` and `network.coins.credit` on `openvibe.network`. Live switches by
adding the five paths to `TOKEN_PATHS` in its `server/net/network-principal.js` and sending those calls through
`headersFor(path)`. The capability names are the closest existing ones in openvibe-contracts 0.33; narrower ones
(`network.registry.read`, `network.coins.read`, an identity legacy-map write) are a contracts change.

## Removed key calls

| Call | Removed | Instead |
| --- | --- | --- |
| Network → Live `POST /internal/user-role` (register C-55; Live's route, C-54, went in the same change) | 2026-09-26, WS-B task 2 step 5 | `network.user.updated`: the `users` trigger records a role change in the admin request's own transaction and `server/identity/profile-events.js` relays it; Live applies it, downgrades too (`test/admin-role-events.test.js`) |
