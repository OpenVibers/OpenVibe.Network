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
 * server/observability.js feeds it every request (operation, latency_ms, status) plus the HTTP autoscaling
 * signals (active requests, p95, event-loop lag); gracefulStop's stop array flushes it once at shutdown.
 * The sink is the service's: the SDK holds no network code, and no sample carries a payload or a secret.
 */
const { createTelemetry, telemetrySample, validateTelemetrySample } = require('openvibe-sdk/telemetry');

const SERVICE = 'network';

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

/** Build one collector. `sink` overrides the analytics sink (tests inject one); everything else is the SDK. */
function createNetworkTelemetry({ analytics = null, sink = null, instance = null, intervalMs, now, log, maxBuffered } = {}) {
    const write = typeof sink === 'function' ? sink : analyticsSink(analytics);
    return createTelemetry({ service: SERVICE, instance, sink: write, intervalMs, now, log, maxBuffered });
}

// The process-wide collector. It exists only once the analytics tracker does (server/index.js), so an
// early request is recorded by neither; the HTTP middleware is mounted before any route runs.
let current = null;
function init(opts) {
    current = createNetworkTelemetry(opts);
    return current;
}

function record(...args) { return current ? current.record(...args) : undefined; }
function gauge(...args) { return current ? current.gauge(...args) : undefined; }
function count(...args) { return current ? current.count(...args) : undefined; }
function flush() { return current ? current.flush() : Promise.resolve(); }
function stop() { return current ? current.stop() : Promise.resolve(); }

module.exports = {
    SERVICE,
    eventName,
    analyticsSink,
    createNetworkTelemetry,
    telemetrySample,
    validateTelemetrySample,
    init,
    record,
    gauge,
    count,
    flush,
    stop,
};
