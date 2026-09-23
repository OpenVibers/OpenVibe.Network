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
