'use strict';
/**
 * Network's telemetry sink (openvibe-sdk/service telemetry, plan T1 §15.19). The kit aggregates requests
 * and emits platform.telemetry-sample@1; this is the one Network-specific piece: each flushed batch goes
 * into Network's ADR-021 analytics tracker as custom `telemetry.<operation>` events (the dashboard reads
 * them), then the tracker is flushed so one batch lands together. Wired in server/index.js.
 */

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

module.exports = { eventName, analyticsSink };
