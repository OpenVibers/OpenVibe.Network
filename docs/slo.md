# SLO categories (proposal)

Status: **proposal**. None of these targets is agreed or enforced, and nothing alerts on them.
They exist so that each service's metrics can be read against a stated intent. The categories come
from the realignment roadmap §15.19. The machine-readable copy is [`slo.json`](slo.json), served at
`GET /api/v1/status/slo`. The operator page `GET /status` lists them under the live service table.

Binding rule from the roadmap: correctness-sensitive systems (billing, authentication) prioritise
**integrity over availability**. Live transport prioritises **continuity**, and the control plane
converges afterwards.

| Category | Services | Priority | Proposed target | Measured today by |
|---|---|---|---|---|
| Identity login and token exchange | network | integrity | 99.9% of token requests without a 5xx over 30 days; p95 under 0.5 s | `http_requests_total{route="/oauth/token"}`, `network_tokens_issued_total{grant_type}`, `network_token_failures_total{grant_type,error}` |
| Public page availability | live, community, tools, media, network | availability | 99.5% of GETs without a 5xx over 30 days | `http_requests_total` per service |
| Control APIs | live, media, events, community, tools | availability | 99.5% without a 5xx; p95 under 1 s | `http_requests_total`, `http_request_duration_seconds` by route template |
| Chat message persistence and delivery | live, chat | integrity | 99.99% of accepted messages persisted; delivery p95 under 1 s | **not instrumented**: only `live_ws_connections` exists |
| Ingest acceptance | live, openre | continuity | 99.5% of valid publish attempts accepted | **not instrumented** |
| Active stream continuity | live, openre, media | continuity | fewer than 1 unplanned interruption per 1000 stream-hours | partly: `live_streams_live` counts streams; the cause of a stream ending is not recorded |
| Media upload and processing | media | integrity | every upload or recording ends ready or explicitly failed; p95 under 10 min | partly: `media_recordings_in_progress`, `media_objects{lifecycle_status}`, `media_object_locations{provider,state}`; time-to-ready is not measured |
| Ledger settlement correctness | billing | integrity | zero unbalanced or duplicate settlements | **not instrumented** by this change (Billing is another track) |
| Event delivery latency | events | integrity | p95 under 30 s; no dead letter unreviewed after 24 h | `events_delivery_latency_seconds`, `events_deliveries{status}`, `events_dlq_depth` |
| Developer API availability | network, events, media | availability | 99.9% without a 5xx over 30 days | `http_requests_total` by route template |

## Where the numbers come from

Every service (Network, Community, Media, Events, the Tools gateway and satellites, and Live once
`docs/patches/live-observability.diff` is applied) uses `openvibe-shared/metrics` ≥ 1.3.0:

- `GET /metrics` returns Prometheus text to a direct loopback caller only. Through nginx it is a 404,
  both in the app (any `X-Forwarded-For`/`X-Real-IP`/`Forwarded` header) and in the nginx config.
- The HTTP golden signals are `http_requests_total{method,route,status_class}`,
  `http_request_duration_seconds{method,route}` and `http_requests_in_flight`. `route` is the route
  template, never a raw URL.
- The process metrics are `process_resident_memory_bytes`, `nodejs_heap_*`,
  `nodejs_eventloop_lag_seconds{stat}`, `process_cpu_seconds_total` and `process_uptime_seconds`.
- `release_info{service,release}` names the deployed release.

No Prometheus server scrapes these yet. Setting one up on the host, with a loopback scrape of each
port, is the next operational step.

## Readiness

`/api/ready` on each service follows `openvibe-shared/ready`. It lists named checks, each with
`status`, `required`, `latency_ms` and `checked_at`. `ready` is false (HTTP 503) only when a
required check fails. A failed optional dependency is listed in `degraded` (HTTP 200,
`status: "degraded"`), so losing one capability never reads as healthy or as fully down.
`GET /status` shows each row as up, degraded, down, not running or unknown, using those bodies.
