# Wave 0 baseline

The audit baseline from the OpenVibe development roadmap (Wave 0; section 12 items 1-3): what exists across the estate, who owns each piece of data today and who should, what production looks like next to the repos, and which hazards constrain later waves. Every file here except `data/*.json` is generated.

Source commits: Live `03f49b7`, Network `c022f86`, Shared `b5a9bd7`, Media `14cac06`, Tools `4f4ed6e`, Community `2da3501`, Games `eb2d008`, Sites `304e8b1`, Events `19919ec`, Chat `d87c8d3`, OpenRe.Stream `c77ec2a`, Billing `f24684b`, Tips `13986b5`, VIP `95b3e19`, AI `6c8b833`, Search `e8511d8`, Sources `1670853`, Wiki `3302540`, Blog `8a7f8eb`, News `97dae43`, Reviews `c87b344`, Deals `533450f`, Coupons `b91cd79`, Trade `273bce7`, Codes `64d8feb`, Host `6d2aaaa`, Examples `92eb7c3`. Production snapshot: openvibe-oregon, 2026-09-28.

## Deliverables

| # | Artifact | Contents |
|---|---|---|
| 1 | [01-services.md](01-services.md) | services, ports, units, env files, repo state, GitHub census |
| 2 | [02-schema.md](02-schema.md) | 639 tables with current/target owner |
| 3 | [03-routes.md](03-routes.md), [04-cross-service.md](04-cross-service.md) | 2453 routes; 112 cross-service call sites |
| 4 | [05-realtime-and-jobs.md](05-realtime-and-jobs.md) | WebSocket servers and paths, non-HTTP protocols, background jobs |
| 5 | [06-secrets.md](06-secrets.md) | auth mechanisms and secret names (no values) |
| 6 | [07-ownership.md](07-ownership.md) | current vs target data ownership |
| 7 | [08-discrepancies.md](08-discrepancies.md) | 377 production-vs-repo items |
| 8 | [09-d-status.md](09-d-status.md) | D01-D46 family status, derived from the requirement ledger (families: 0 met, 21 partial, 0 not met, 1 blocked on owner) |
| 9 | [10-hazards.md](10-hazards.md) | 18 hazards with owners, mitigations and waves; 10 need the owner's review |
| 10 | [requirement-ledger.md](requirement-ledger.md), [requirement-ledger.json](requirement-ledger.json) | D01-D46 with acceptance artifacts (roadmap §22.4/§25): 3 met, 36 partial, 0 not met, 7 blocked on owner |
| - | [inventory.json](inventory.json) | everything above, machine-readable |

## Exit criteria

|  | Criterion | Result |
|---|---|---|
| pass | Every table has an owner classification | 639 tables classified, 0 unclassified |
| pass | Every route is attributed to a repo and source line, with an owner classification | 2453 routes, 0 unclassified; 0 router mounts whose module could not be resolved (their routes are listed without the mount prefix) |
| pass | Every background job is listed with its location and an owner classification | 179 timers/jobs, 0 unclassified |
| pass | Every cross-service call records caller, callee, auth, timeout and retry | 112 call sites; 39 with no timeout detected |
| pass | Unknowns are marked unknown, not guessed | 2 unknown items recorded |
| pass | Every D01-D46 requirement has a status and verified acceptance artifacts (requirement ledger) | 46/46 requirements verified |
| **open** | Hazard register reviewed by the production-host owner | pending: set reviewedBy in data/hazards.json after review |

## Regenerating

```bash
scripts/roadmap-baseline/collect-prod.sh      # read-only SSH: deployed SHAs, units, timers, DB table names, env var NAMES
scripts/roadmap-baseline/collect-github.sh    # gh: repo list + charter STATUS.json
scripts/roadmap-baseline/scan-root.sh /tmp/ov-scan --fetch   # origin/main clones; sibling working trees are not touched
OPENVIBE_ROOT=/tmp/ov-scan node scripts/roadmap-baseline/generate.js           # write this directory
OPENVIBE_ROOT=/tmp/ov-scan node scripts/roadmap-baseline/generate.js --check   # also exit 1 while an exit criterion is open
```

Without `OPENVIBE_ROOT` the generator scans the sibling checkouts next to this repo as they are (a stale branch or uncommitted work included); `scan-root.sh` builds clones at each repository's origin/main so the scan describes what is pushed. The hand-maintained inputs are `data/services.json`, `data/ownership-rules.json` (tables, routes, jobs), `data/hazards.json` and `data/requirement-ledger.json`.

## What this baseline does not claim

- Extraction is static pattern matching. Routes built at runtime, calls through helper wrappers without an internal URL or port, and tables created by dependencies other than the `openvibe-shared` modules a repo requires can be missed (the `openvibe-publishing` stores create prefixed tables at runtime; they appear as production-only tables). Treat counts as a floor.
- Timeout/retry/auth detection is per file, not per request. A module that exports several routers gets every mount prefix it is loaded under.
- The collector reads table names and env var names, never rows or values. The ledger's production observations are read-only checks (row counts, GETs, unit state) recorded with their time; the generator re-checks their age, not their result. No provider console or payment record was read.
- `Source.OpenVibe.Games`, `AFResume` and `BreakRoomSimulator` are not scanned. The libraries and clients (`OpenVibe.Contracts`, `OpenVibe.SDK`, `OpenVibe.Publishing`, `OpenVibe.Extensions`) are cited by the ledger but not scanned for routes or tables; `OpenVibe.Realtime` is closed (ADR-005).
