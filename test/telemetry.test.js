'use strict';
// Universal telemetry (server/telemetry.js on openvibe-sdk/telemetry, plan T1): every emitted
// platform.telemetry-sample@1 validates, HTTP requests are aggregated per route|method|status_class
// (one sample for each such group at each flush, with count, sum, max and p95 in extra), skipped paths produce nothing, the three
// autoscaling gauges are emitted once per flush, one flush posts one batch, stop() flushes once and is
// idempotent, the analytics sink maps a batch to custom events, and nothing starts at module load.
// No database: the sink is injected.
//   node --test test/telemetry.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const telemetry = require('../server/telemetry');
const { createNetworkTelemetry, analyticsSink, validateTelemetrySample } = require('../server/telemetry');
const observability = require('../server/observability');

const quiet = { log() {}, warn() {}, error() {} };
const AT = '2026-09-30T10:00:00.000Z';
const valid = (sample, label) => {
    const r = validateTelemetrySample(sample);
    assert.ok(r.ok, `${label}: ${JSON.stringify(r.errors)} — ${JSON.stringify(sample)}`);
};

(async () => {
    // ── Item 2: requiring the modules starts nothing (no monitor, no timer) ──
    assert.strictEqual(observability.eventLoopMonitorEnabled(), false, 'requiring observability starts no event-loop monitor');

    // ── Every emitted sample is a well-formed platform.telemetry-sample@1 ──
    const batches = [];
    const t = createNetworkTelemetry({ sink: async (samples) => { batches.push(samples); }, intervalMs: 3600e3, now: () => Date.parse(AT), log: quiet });
    const request = t.record('http.request', 12.5, { status: '2xx', resource: '/api/v1/x', extra: { method: 'GET', http_status: 200 } });
    const gauge = t.gauge('demo.queue_depth', 3);
    const count = t.count('cache.miss');
    for (const [sample, label] of [[request, 'record'], [gauge, 'gauge'], [count, 'count']]) {
        valid(sample, label);
        assert.strictEqual(sample.service, 'network', `${label} carries the service`);
        assert.strictEqual(sample.at, AT, `${label} carries at`);
    }

    // ── A flush posts exactly one well-formed batch, drains the interval's gauges, stop() is idempotent ──
    await t.flush();
    assert.strictEqual(batches.length, 1, 'one flush = one sink call');
    assert.deepStrictEqual(batches[0].slice(0, 3), [request, gauge, count], 'the buffered samples, in order');
    const active0 = batches[0].find((s) => s.operation === 'http.active_requests');
    assert.ok(active0, 'the active-requests gauge is emitted once per flush');
    assert.deepStrictEqual(active0.extra, { last: 0, max: 0 }, 'the gauge value lives in extra, not latency_ms');
    assert.ok(!('latency_ms' in active0), 'a gauge is never in the latency field');
    for (const s of batches[0]) valid(s, 'flushed batch');
    await t.flush();
    assert.strictEqual(batches.length, 2, 'a second flush emits the gauges again (once per flush)');
    assert.strictEqual(batches[1].length, 1);
    assert.strictEqual(batches[1][0].operation, 'http.active_requests');
    t.record('http.request', 7, { status: '5xx' });
    await t.stop();
    assert.strictEqual(batches.length, 3, 'stop() flushes the remaining buffer once');
    assert.strictEqual(batches[2].length, 2);
    await t.stop();
    await t.flush();
    assert.strictEqual(batches.length, 3, 'a second stop() (or a later flush) posts nothing');

    // ── Item 1: N requests to one route aggregate into ONE http.request sample with count N ──
    const aggBatches = [];
    const a = createNetworkTelemetry({ sink: async (s) => { aggBatches.push(s); }, intervalMs: 3600e3, now: () => Date.parse(AT), log: quiet });
    for (let i = 0; i < 5; i++) a.requestStarted();   // all in flight at once: the peak is 5
    for (let i = 0; i < 5; i++) a.requestFinished({ route: '/api/v1/things/:id', method: 'GET', httpStatus: 200, latencyMs: 10 + i });
    await a.flush();
    const httpSamples = aggBatches[0].filter((s) => s.operation === 'http.request');
    assert.strictEqual(httpSamples.length, 1, `five requests to one route = one sample: ${JSON.stringify(aggBatches[0])}`);
    const agg = httpSamples[0];
    assert.strictEqual(agg.resource, '/api/v1/things/:id', 'the route template, never the raw id');
    assert.strictEqual(agg.status, '2xx');
    assert.strictEqual(agg.latency_ms, 12, 'the mean latency is the sample’s latency_ms');
    assert.deepStrictEqual(agg.extra, { method: 'GET', status_class: '2xx', count: 5, sum_ms: 60, max_ms: 14, p95_ms: 14, http_status: 200 },
        'count, sum, max and p95 live in extra');
    for (const s of aggBatches[0]) valid(s, 'aggregated batch');
    const activeAgg = aggBatches[0].filter((s) => s.operation === 'http.active_requests');
    assert.strictEqual(activeAgg.length, 1, 'the active gauge is emitted once per flush');
    assert.deepStrictEqual(activeAgg[0].extra, { last: 0, max: 5 }, 'item 3: the peak is sampled at request start');
    assert.strictEqual(aggBatches[0].filter((s) => s.operation === 'http.latency_p95_ms').length, 1, 'p95 is emitted once per flush');
    assert.strictEqual(aggBatches[0].find((s) => s.operation === 'http.latency_p95_ms').latency_ms, 14);
    await a.flush();
    assert.strictEqual(aggBatches[1].filter((s) => s.operation === 'http.request').length, 0, 'an idle interval emits no request sample');
    assert.strictEqual(aggBatches[1].filter((s) => s.operation === 'http.active_requests').length, 1);
    assert.strictEqual(aggBatches[1].filter((s) => s.operation === 'http.latency_p95_ms').length, 0, 'no requests: no p95');
    await a.stop();

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

    // ── Items 1 & 2: the middleware aggregates; skipped paths are never counted; init starts the monitor ──
    const raw = [];
    telemetry.init({ sink: async (samples) => { for (const s of samples) raw.push(s); }, intervalMs: 3600e3, log: quiet });
    assert.strictEqual(observability.eventLoopMonitorEnabled(), true, 'init() creates and enables the event-loop monitor');
    await new Promise((r) => setTimeout(r, 60));   // let the monitor take a sample before the flush
    const app = express();
    app.use(observability.telemetryMiddleware);
    app.get('/api/v1/things/:id', (req, res) => res.json({ ok: true }));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.get('/metrics', (_req, res) => res.type('text/plain').send('ok'));
    app.get('/api/ready', (_req, res) => res.json({ ok: true }));
    app.get('/api/chrome', (_req, res) => res.json({ ok: true }));
    app.get('/shared/navbar.js', (_req, res) => res.type('application/javascript').send('ok'));
    app.get('/logo.png', (_req, res) => res.type('image/png').send('ok'));
    app.get('/data/avatars/a.png', (_req, res) => res.type('image/png').send('ok'));
    app.get('/release.json', (_req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/v1/things/42`);
    await fetch(`${base}/api/v1/things/43`);
    for (const p of ['/api/health', '/metrics', '/api/ready', '/api/chrome', '/shared/navbar.js', '/logo.png', '/data/avatars/a.png']) await fetch(base + p);
    await fetch(`${base}/release.json`);   // a JSON route is product API, not a static asset: still counted
    await telemetry.flush();
    server.close();
    const sampled = raw.filter((s) => s.operation === 'http.request');
    const things = sampled.filter((s) => s.resource === '/api/v1/things/:id');
    assert.strictEqual(things.length, 1, `two requests to one route = one sample: ${JSON.stringify(sampled)}`);
    assert.strictEqual(things[0].extra.count, 2);
    assert.strictEqual(things[0].status, '2xx');
    const resources = new Set(sampled.map((s) => s.resource));
    for (const skipped of ['/api/health', '/metrics', '/api/ready', '/api/chrome', '/shared/*', '/logo.png', '/data/avatars/a.png']) {
        assert.ok(!resources.has(skipped), `skipped path ${skipped} produced no sample: ${JSON.stringify([...resources])}`);
    }
    assert.ok(resources.has('/release.json'), '/release.json is a route, not a static asset');
    assert.strictEqual(raw.filter((s) => s.operation === 'http.active_requests').length, 1, 'gauges once per flush');
    assert.deepStrictEqual(raw.find((s) => s.operation === 'http.active_requests').extra, { last: 0, max: 1 }, 'the two requests are sequential, so the peak is one in flight');
    const lag = raw.filter((s) => s.operation === 'http.eventloop_lag_ms');
    assert.strictEqual(lag.length, 1, 'the event-loop lag gauge is emitted once per flush');
    assert.ok(Number.isFinite(lag[0].extra.value), 'lag lives in extra');
    assert.ok(!('latency_ms' in lag[0]), 'lag is never in the latency field');
    for (const s of raw) valid(s, 'middleware batch');

    await telemetry.stop();
    assert.strictEqual(observability.eventLoopMonitorEnabled(), false, 'stop() disables the event-loop monitor');

    console.log('telemetry: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
