'use strict';
// Universal telemetry (server/telemetry.js on openvibe-sdk/telemetry, plan T1): every emitted
// platform.telemetry-sample@1 validates, one flush posts one batch, stop() flushes once and is
// idempotent, the analytics sink maps a batch to custom events, and the HTTP middleware records the
// request plus its autoscaling signals. No database: the analytics store is injected.
//   node --test test/telemetry.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createNetworkTelemetry, analyticsSink, validateTelemetrySample } = require('../server/telemetry');

const quiet = { log() {}, warn() {}, error() {} };
const AT = '2026-09-30T10:00:00.000Z';
const valid = (sample, label) => {
    const r = validateTelemetrySample(sample);
    assert.ok(r.ok, `${label}: ${JSON.stringify(r.errors)} — ${JSON.stringify(sample)}`);
};

(async () => {
    // ── Every emitted sample is a well-formed platform.telemetry-sample@1 ──
    const batches = [];
    const t = createNetworkTelemetry({ sink: async (samples) => { batches.push(samples); }, intervalMs: 3600e3, now: () => Date.parse(AT), log: quiet });
    const request = t.record('http.request', 12.5, { status: '2xx', resource: '/api/v1/x', extra: { method: 'GET', http_status: 200 } });
    const gauge = t.gauge('http.active_requests', 3);
    const count = t.count('cache.miss');
    for (const [sample, label] of [[request, 'record'], [gauge, 'gauge'], [count, 'count']]) {
        valid(sample, label);
        assert.strictEqual(sample.service, 'network', `${label} carries the service`);
        assert.strictEqual(sample.at, AT, `${label} carries at`);
    }

    // ── A flush posts exactly one well-formed batch; stop() flushes once and is idempotent ──
    await t.flush();
    assert.strictEqual(batches.length, 1, 'one flush = one sink call');
    assert.deepStrictEqual(batches[0], [request, gauge, count], 'the batch is every buffered sample, in order');
    for (const s of batches[0]) valid(s, 'flushed batch');
    await t.flush();
    assert.strictEqual(batches.length, 1, 'an empty flush posts nothing');
    t.record('http.request', 7, { status: '5xx' });
    await t.stop();
    assert.strictEqual(batches.length, 2, 'stop() flushes the remaining buffer once');
    assert.strictEqual(batches[1].length, 1);
    await t.stop();
    await t.flush();
    assert.strictEqual(batches.length, 2, 'a second stop() (or a later flush) posts nothing');

    // ── The analytics sink writes the batch as custom events and flushes once ──
    const events = [];
    const analytics = { trackEvent: (name, data) => events.push({ name, data }), flush() { analytics.flushes = (analytics.flushes || 0) + 1; return Promise.resolve(); } };
    await analyticsSink(analytics)([
        { service: 'network', operation: 'http.request', at: AT, latency_ms: 12.5, status: '2xx', resource: '/api/v1/x', extra: { method: 'GET', http_status: 200 } },
        { service: 'network', operation: 'a b/c:d', at: AT, latency_ms: 1 },
    ]);
    assert.strictEqual(analytics.flushes, 1, 'the sink flushes the tracker once per batch');
    assert.strictEqual(events.length, 2);
    assert.match(events[0].name, /^telemetry\.http\.request$/);
    assert.deepStrictEqual(events[0].data, { path: '/api/v1/x', method: 'GET', status_code: 200, response_time_ms: 12.5 });
    assert.strictEqual(events[1].name, 'telemetry.a_b_c:d', 'spaces and slashes are sanitised; : is valid in analytics/event.v1');

    // ── The HTTP middleware records the request and the autoscaling signals ──
    const wired = [];
    const spy = { trackEvent: (name, data) => wired.push({ name, data }), flush: () => Promise.resolve() };
    require('../server/telemetry').init({ analytics: spy, intervalMs: 3600e3, log: quiet });
    const observability = require('../server/observability');
    const app = express();
    app.use(observability.telemetryMiddleware);
    app.get('/api/v1/things/:id', (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/things/42`);
    assert.strictEqual(res.status, 200);
    await require('../server/telemetry').flush();
    server.close();
    const names = wired.map((e) => e.name);
    assert.ok(names.includes('telemetry.http.request'), `the request is sampled: ${names.join(', ')}`);
    assert.ok(names.includes('telemetry.http.active_requests'), 'active requests is sampled');
    const requestEvent = wired.find((e) => e.name === 'telemetry.http.request');
    assert.strictEqual(requestEvent.data.path, '/api/v1/things/:id', 'the route template, never the raw id');
    assert.strictEqual(requestEvent.data.method, 'GET');
    assert.strictEqual(requestEvent.data.status_code, 200);

    console.log('telemetry: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
