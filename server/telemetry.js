'use strict';
/**
 * Network's platform.telemetry-sample@1 collector (openvibe-sdk/telemetry; plan T1 universal Fabric,
 * §15.19). One sample schema every service emits; autoscaling and routing consume it.
 *
 *   createNetworkTelemetry({ analytics })  service 'network', with a sink that writes each flushed batch
 *                                          into Network's ADR-021 analytics tracker as custom (non-HTTP)
 *                                          events and flushes it, so one batch lands together.
 *   init({ analytics })                    the process-wide collector, wired once at boot (server/index.js).
 *   record / gauge / count / flush / stop  the collector's API; before init they are no-ops.
 *
 * Volume: one analytics row per request does not scale (at 50 req/s that is ~200 rows/s). HTTP requests
 * are therefore aggregated per `route|method|status_class` per flush interval into count, sum, max and
 * p95, and ONE `http.request` sample per key is emitted per flush — not one per request. The HTTP
 * autoscaling gauges (active requests, p95, event-loop lag) are emitted once per flush from a timer
 * started in init(), never per request, so the SDK buffer (maxBuffered 1000) cannot overflow.
 *
 * Field mapping (platform.telemetry-sample@1; `latency_ms` is the schema's latency field, there is no
 * generic gauge field): an aggregated request carries its mean in `latency_ms` and count/sum/max/p95 in
 * `extra`; the p95 gauge carries its value in `latency_ms` (it is a latency); the active-requests and
 * event-loop-lag gauges carry their value in `extra` — never in `latency_ms`, which the analytics sink
 * maps to `response_time_ms` and would make indistinguishable from a latency.
 *
 * server/observability.js feeds the middleware's per-request observations and registers the event-loop
 * monitor (started by init, stopped by stop) so nothing starts at module load; gracefulStop's stop array
 * flushes it once at shutdown.
 */
const { createTelemetry, telemetrySample, validateTelemetrySample } = require('openvibe-sdk/telemetry');

const SERVICE = 'network';
const DEFAULT_INTERVAL_MS = 15000;

// analytics/event.v1 event_type: [A-Za-z][A-Za-z0-9_.:-]{0,63}; an operation is sanitised to fit.
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
function eventName(operation) {
    const name = `telemetry.${String(operation == null ? 'operation' : operation)}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
    return EVENT_RE.test(name) ? name : 'telemetry.operation';
}

/**
 * The sink: write each sample in the batch into Network's analytics tracker (its `trackEvent`, the
 * non-HTTP form; ADR-021 reduces the personal fields), then await its flush so the batch lands together.
 * Only the fields analytics/event.v1 can hold are passed; the numbers live in `extra.http_status`.
 */
function analyticsSink(analytics) {
    if (!analytics || typeof analytics.trackEvent !== 'function') {
        throw new TypeError('analyticsSink: Network\'s analytics tracker (trackEvent) is required');
    }
    return async function sink(samples) {
        for (const s of samples) {
            const extra = s.extra || {};
            analytics.trackEvent(eventName(s.operation), {
                path: typeof s.resource === 'string' ? s.resource : (typeof extra.route === 'string' ? extra.route : undefined),
                method: typeof extra.method === 'string' ? extra.method : undefined,
                status_code: Number.isInteger(extra.http_status) ? extra.http_status : undefined,
                response_time_ms: Number.isFinite(s.latency_ms) ? s.latency_ms : undefined,
            });
        }
        if (typeof analytics.flush === 'function') await analytics.flush();
    };
}

// ── HTTP aggregation (volume) ─────────────────────────────────────
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const statusClass = (code) => (code ? `${Math.floor(code / 100)}xx` : 'aborted');
const round = (n, digits = 3) => { const f = 10 ** digits; return Math.round(n * f) / f; };

/** p95 (nearest-rank) of an array of ms latencies; null when empty. Computed at most once per flush. */
function percentile95(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

// The event-loop monitor lives in observability.js and is injected here at its require: requiring either
// module starts nothing. telemetry.init() calls start(), telemetry.stop() calls stop(), and the gauges
// read lag(). Unregistered (unit tests, a bare collector) they are safe no-ops.
let signals = { start() {}, stop() {}, lag() { return null; } };
function registerSignals(injected) {
    signals = { ...signals, ...(injected || {}) };
}

/**
 * Build one collector. `sink` overrides the analytics sink (tests inject one); everything else is the SDK.
 * HTTP observations are aggregated in memory and drained on flush(); the flush timer itself starts in
 * init(), so a bare collector only flushes when asked.
 */
function createNetworkTelemetry({ analytics = null, sink = null, instance = null, intervalMs = DEFAULT_INTERVAL_MS, now, log, maxBuffered } = {}) {
    const write = typeof sink === 'function' ? sink : analyticsSink(analytics);
    const sdk = createTelemetry({ service: SERVICE, instance, sink: write, intervalMs, now, log, maxBuffered });

    let routes = new Map();      // key -> { route, method, status, count, sumMs, maxMs, latencies, codes }
    let allLatencies = [];       // the flush interval's latencies, for the single p95 gauge
    let active = 0;              // requests in flight right now
    let activeMax = 0;           // the interval's peak, sampled at request start (item 3)
    let stopped = false;

    /** A request began: track the in-flight peak here, not after the decrement. */
    function requestStarted() {
        active += 1;
        if (active > activeMax) activeMax = active;
    }

    function observeRequest(info = {}) {
        const r = String(info.route == null ? 'unmatched' : info.route).slice(0, 200);
        const m = HTTP_METHODS.has(info.method) ? info.method : 'OTHER';
        const s = statusClass(info.httpStatus);
        const latency = Number.isFinite(info.latencyMs) && info.latencyMs >= 0 ? info.latencyMs : 0;
        const key = `${r}|${m}|${s}`;
        let bucket = routes.get(key);
        if (!bucket) {
            bucket = { route: r, method: m, status: s, count: 0, sumMs: 0, maxMs: 0, latencies: [], codes: new Set() };
            routes.set(key, bucket);
        }
        bucket.count += 1;
        bucket.sumMs += latency;
        if (latency > bucket.maxMs) bucket.maxMs = latency;
        bucket.latencies.push(latency);
        if (Number.isInteger(info.httpStatus) && info.httpStatus > 0) bucket.codes.add(info.httpStatus);
        allLatencies.push(latency);
    }

    /** A request ended: free the in-flight slot, then fold it into its aggregation key. */
    function requestFinished(info) {
        if (active > 0) active -= 1;
        observeRequest(info);
    }

    /** Push a gauge whose value(s) live in `extra`; the schema has no generic gauge field and latency_ms
     *  is the sink's response_time_ms, so extra is the documented home (never latency_ms). */
    function emitExtraGauge(name, extra) {
        const sample = sdk.record(name, 0, { extra });
        delete sample.latency_ms;
        return sample;
    }

    /** Drain this interval: one http.request sample per route|method|status_class, then the three gauges. */
    function emitSamples() {
        const buckets = [...routes.values()];
        const latencies = allLatencies;
        routes = new Map();
        allLatencies = [];
        for (const b of buckets) {
            const mean = b.count ? b.sumMs / b.count : 0;
            const p95 = percentile95(b.latencies);
            const extra = {
                method: b.method,
                status_class: b.status,
                count: b.count,
                sum_ms: round(b.sumMs),
                max_ms: round(b.maxMs),
            };
            if (p95 != null) extra.p95_ms = round(p95);
            if (b.codes.size === 1) extra.http_status = b.codes.values().next().value;
            sdk.record('http.request', round(mean), { status: b.status, resource: b.route, extra });
        }
        // The gauges, once per flush (never per request).
        emitExtraGauge('http.active_requests', { last: active, max: activeMax });
        activeMax = active;   // the next interval's peak starts from what is still in flight
        const p95 = percentile95(latencies);
        if (p95 != null) sdk.record('http.latency_p95_ms', round(p95));   // latency_ms: the schema's latency field
        const lag = signals.lag();
        if (lag != null) emitExtraGauge('http.eventloop_lag_ms', { value: round(lag) });
    }

    /** Emit the interval's samples, then hand the SDK everything buffered (a flush is also the tick). */
    function flush() {
        if (stopped) return Promise.resolve();
        emitSamples();
        return sdk.flush();
    }

    /** Emit once, then let the SDK clear its timer and flush (idempotent). */
    async function stop() {
        if (stopped) return;
        stopped = true;
        emitSamples();
        await sdk.stop();
    }

    return { record: sdk.record, gauge: sdk.gauge, count: sdk.count, flush, stop, requestStarted, requestFinished, observeRequest };
}

// The process-wide collector. It exists only once the analytics tracker does (server/index.js), so an
// early request is recorded by neither; the HTTP middleware is mounted before any route runs.
let current = null;
let timer = null;
function init(opts = {}) {
    current = createNetworkTelemetry(opts);
    signals.start();   // the event-loop monitor (observability.js): created and enabled here, not at load
    if (timer) clearInterval(timer);
    const interval = Number.isFinite(opts.intervalMs) ? opts.intervalMs : DEFAULT_INTERVAL_MS;
    timer = setInterval(() => { current.flush(); }, interval);
    if (timer.unref) timer.unref();
    return current;
}

function record(...args) { return current ? current.record(...args) : undefined; }
function gauge(...args) { return current ? current.gauge(...args) : undefined; }
function count(...args) { return current ? current.count(...args) : undefined; }
function requestStarted() { return current ? current.requestStarted() : undefined; }
function requestFinished(info) { return current ? current.requestFinished(info) : undefined; }
function flush() { return current ? current.flush() : Promise.resolve(); }
async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (current) await current.stop();
    signals.stop();   // disable the event-loop monitor that init enabled
}

module.exports = {
    SERVICE,
    eventName,
    analyticsSink,
    createNetworkTelemetry,
    telemetrySample,
    validateTelemetrySample,
    registerSignals,
    init,
    record,
    gauge,
    count,
    requestStarted,
    requestFinished,
    flush,
    stop,
};
