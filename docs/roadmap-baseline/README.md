# Wave 0 baseline

The audit baseline from the OpenVibe development roadmap (Wave 0; section 12 items 1-3): what exists across the estate, who owns each piece of data today and who should, what production looks like next to the repos, and which hazards constrain later waves. Every file here except `data/*.json` is generated.

Source commits: Live `e266060`, Network `1bc6a52`, Media `ddfefcf`, Tools `0346edc`, Community `d7c6e60`, Games `5710287`, Sites `185014f`. Production snapshot: openvibe-oregon, 2026-09-22.

## Deliverables

| # | Artifact | Contents |
|---|---|---|
| 1 | [01-services.md](01-services.md) | services, ports, units, env files, repo state, GitHub census |
| 2 | [02-schema.md](02-schema.md) | 262 tables with current/target owner |
| 3 | [03-routes.md](03-routes.md), [04-cross-service.md](04-cross-service.md) | 968 routes; 68 cross-service call sites |
| 4 | [05-realtime-and-jobs.md](05-realtime-and-jobs.md) | WebSocket servers and paths, non-HTTP protocols, background jobs |
| 5 | [06-secrets.md](06-secrets.md) | auth mechanisms and secret names (no values) |
| 6 | [07-ownership.md](07-ownership.md) | current vs target data ownership |
| 7 | [08-discrepancies.md](08-discrepancies.md) | 115 production-vs-repo items |
| 8 | [09-d-status.md](09-d-status.md) | D01-D46 family status from evidence |
| 9 | [10-hazards.md](10-hazards.md) | 14 hazards with owners, mitigations and waves |
| - | [inventory.json](inventory.json) | everything above, machine-readable |

## Exit criteria

|  | Criterion | Result |
|---|---|---|
| pass | Every table has an owner classification | 262 tables classified, 0 unclassified |
| pass | Every route is attributed to a repo and source line | 968 routes; 0 router mounts whose module could not be resolved (their routes are listed without the mount prefix) |
| pass | Every background job is listed with its location | 83 timers/jobs |
| pass | Every cross-service call records caller, callee, auth, timeout and retry | 68 call sites; 30 with no timeout detected |
| pass | Unknowns are marked unknown, not guessed | 2 unknown items recorded |
| pass | D01-D46 status resolved from evidence | 22/22 families verified |
| **open** | Hazard register reviewed by the production-host owner | pending: set reviewedBy in data/hazards.json after review |

## Regenerating

```bash
scripts/roadmap-baseline/collect-prod.sh      # read-only SSH: deployed SHAs, units, DB table names, env var NAMES
scripts/roadmap-baseline/collect-github.sh    # gh: repo list + charter STATUS.json
node scripts/roadmap-baseline/generate.js     # scan sibling checkouts, write this directory
node scripts/roadmap-baseline/generate.js --check   # also exit 1 while an exit criterion is open
```

The generator reads sibling checkouts under `OPENVIBE_ROOT` (default: the parent of this repo). Keep them on `main` and pulled before regenerating.

## What this baseline does not claim

- Extraction is static pattern matching. Routes built at runtime, calls through helper wrappers without an internal URL or port, and tables created by dependencies outside `vendor/openvibe-shared` can be missed. Treat counts as a floor.
- Timeout/retry/auth detection is per file, not per request. A module that exports several routers gets every mount prefix it is loaded under.
- No production row data, env values, provider console or payment record was read.
- `Source.OpenVibe.Games`, `AFResume` and `BreakRoomSimulator` are not scanned; the charter repos have no code to scan.
