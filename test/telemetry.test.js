'use strict';
// Universal telemetry (plan T1) on openvibe-sdk/service's telemetry kit: Network's hand-rolled copy is
// gone (server/index.js wires the kit, server/observability.js exports none of the old telemetry names),
// HTTP requests are aggregated per route|method|status_class (one http.request sample per group per flush),
// stop() flushes once and is idempotent, Network's analytics sink (server/telemetry-sink.js) writes each
// sample as a telemetry.<operation> event and flushes the tracker once per batch, and the middleware wired
// with Network's options skips probes, chrome and static/shared assets. No database: the tracker is a fake.
//   node --test test/telemetry.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const svc = require('openvibe-sdk/service');
const metrics = require('openvibe-shared/metrics');
const { analyticsSink, eventName } = require('../server/telemetry-sink');
const observability = require('../server/observability');

const quiet = { log() {}, warn() {}, error() {} };
const AT = '2026-09-30T10:00:00.000Z';
const valid = (sample, label) => {
    const r = svc.validateTelemetrySample(sample);
    assert.ok(r.ok, `${label}: ${JSON.stringify(r.errors)} — ${JSON.stringify(sample)}`);
};
/** A stand-in for Network's ADR-021 tracker: records trackEvent calls and counts flushes. */
function fakeAnalytics() {
    const a = { events: [], flushes: 0 };
    a.trackEvent = (name, data) => { a.events.push({ name, data }); };
    a.flush = () => { a.flushes += 1; return Promise.resolve(); };
    return a;
}

(async () => {
    // ── Static: the kit replaces Network's copy ──
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
    assert.ok(index.includes("require('openvibe-sdk/service')"), 'server/index.js requires the kit');
    assert.ok(index.includes('svc.telemetry.init('), 'server/index.js initialises the kit\'s collector');
    assert.ok(index.includes('app.use(svc.telemetryMiddleware)'), 'server/index.js mounts the kit\'s middleware');
    assert.ok(index.includes('svc.telemetry.stop()'), 'gracefulStop stops the kit\'s collector');
    assert.ok(index.includes("svc.telemetrySkipped(req, { prefixes: ['/shared', '/api/chrome'] })"), 'the middleware skips /shared and /api/chrome');
    assert.ok(!/require\(['"]\.\/telemetry['"]\)/.test(index), 'server/index.js no longer requires ./telemetry');
    assert.ok(!fs.existsSync(path.join(root, 'server/telemetry.js')), 'server/telemetry.js is deleted');
    for (const name of ['telemetryMiddleware', 'telemetrySkipped', 'eventLoopMonitorEnabled']) {
        assert.ok(!(name in observability), `observability.js no longer exports ${name}`);
    }
    assert.strictEqual(svc.eventLoopMonitorEnabled(), false, 'requiring the modules starts no event-loop monitor');

    // ── 5 requests to one route = ONE http.request sample; the sink writes telemetry.<op> events ──
    const analytics = fakeAnalytics();
    const samples = [];
    const sink = analyticsSink(analytics);
    const c = svc.createHttpTelemetry({
        service: 'network', intervalMs: 3600e3, now: () => Date.parse(AT), log: quiet,
        sink: async (batch) => { samples.push(...batch); await sink(batch); },
    });
    for (let i = 0; i < 5; i++) c.requestStarted();
    for (let i = 0; i < 5; i++) c.requestFinished({ route: '/api/v1/things/:id', method: 'GET', httpStatus: 200, latencyMs: 10 + i });
    await c.flush();
    assert.strictEqual(analytics.flushes, 1, 'one flush = one tracker flush');
    const requests = samples.filter((s) => s.operation === 'http.request');
    assert.strictEqual(requests.length, 1, `five requests to one route = one sample: ${JSON.stringify(samples)}`);
    assert.strictEqual(requests[0].service, 'network');
    assert.strictEqual(requests[0].resource, '/api/v1/things/:id', 'the route template, never the raw id');
    assert.strictEqual(requests[0].latency_ms, 12, 'the mean latency is the sample\'s latency_ms');
    assert.deepStrictEqual(requests[0].extra, { method: 'GET', status_class: '2xx', count: 5, sum_ms: 60, max_ms: 14, p95_ms: 14, http_status: 200 });
    assert.strictEqual(samples.filter((s) => s.operation === 'http.active_requests').length, 1, 'the active gauge once per flush');
    for (const s of samples) valid(s, 'aggregated batch');
    const reqEvents = analytics.events.filter((e) => e.name === 'telemetry.http.request');
    assert.strictEqual(reqEvents.length, 1);
    assert.deepStrictEqual(reqEvents[0].data, { path: '/api/v1/things/:id', method: 'GET', status_code: 200, response_time_ms: 12 },
        'the sink maps a sample to path/method/status_code/response_time_ms');
    assert.strictEqual(analytics.events.length, samples.length, 'one event per sample');
    assert.ok(analytics.events.every((e) => e.name.startsWith('telemetry.')), 'every event is telemetry.<operation>');

    // ── stop() flushes once; a second stop() (or a later flush) changes nothing ──
    await c.stop();
    assert.strictEqual(analytics.flushes, 2, 'stop() flushes once');
    const after = analytics.events.length;
    await c.stop();
    await c.flush();
    assert.strictEqual(analytics.flushes, 2, 'a second stop() is a no-op');
    assert.strictEqual(analytics.events.length, after);

    // ── The sink on its own: the event mapping Network's ADR-021 dashboard reads ──
    const direct = fakeAnalytics();
    await analyticsSink(direct)([
        { service: 'network', operation: 'http.request', at: AT, latency_ms: 12.5, status: '2xx', resource: '/api/v1/x', extra: { method: 'GET', http_status: 200 } },
        { service: 'network', operation: 'a b/c:d', at: AT, latency_ms: 1 },
    ]);
    assert.strictEqual(direct.flushes, 1, 'the sink flushes the tracker once per batch');
    assert.deepStrictEqual(direct.events[0], { name: 'telemetry.http.request', data: { path: '/api/v1/x', method: 'GET', status_code: 200, response_time_ms: 12.5 } });
    assert.strictEqual(direct.events[1].name, 'telemetry.a_b_c:d', 'spaces and slashes are sanitised; : is valid in analytics/event.v1');
    assert.strictEqual(eventName(null), 'telemetry.operation');
    assert.throws(() => analyticsSink({}), TypeError, 'the sink needs a tracker');

    // ── The singleton with Network's options: the middleware aggregates and skips probes/chrome/assets ──
    const raw = [];
    svc.telemetry.init({
        service: 'network', intervalMs: 3600e3, log: quiet,
        sink: async (batch) => { raw.push(...batch); },
        skipPrefixes: ['/shared', '/api/chrome'],
        skipped: (req) => svc.telemetrySkipped(req, { prefixes: ['/shared', '/api/chrome'] }),   // as server/index.js
        routeLabel: metrics.routeLabel,
    });
    assert.strictEqual(svc.eventLoopMonitorEnabled(), true, 'init() enables the event-loop monitor');
    const app = express();
    app.use(svc.telemetryMiddleware);
    app.get('/api/v1/things/:id', (_req, res) => res.json({ ok: true }));
    for (const p of ['/api/health', '/metrics', '/api/ready', '/api/chrome', '/release.json']) app.get(p, (_req, res) => res.json({ ok: true }));
    app.get('/shared/navbar.js', (_req, res) => res.type('application/javascript').send('ok'));
    app.get('/logo.png', (_req, res) => res.type('image/png').send('ok'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/v1/things/42`);
    await fetch(`${base}/api/v1/things/43`);
    for (const p of ['/api/health', '/metrics', '/api/ready', '/api/chrome', '/shared/navbar.js', '/logo.png']) await fetch(base + p);
    await fetch(`${base}/release.json`);   // a JSON route is product API, not a static asset: still counted
    await svc.telemetry.flush();
    server.close();
    const sampled = raw.filter((s) => s.operation === 'http.request');
    const things = sampled.filter((s) => s.resource === '/api/v1/things/:id');
    assert.strictEqual(things.length, 1, `two requests to one route = one sample: ${JSON.stringify(sampled)}`);
    assert.strictEqual(things[0].extra.count, 2);
    const resources = new Set(sampled.map((s) => s.resource));
    for (const skipped of ['/api/health', '/metrics', '/api/ready', '/api/chrome', '/shared/navbar.js', '/logo.png']) {
        assert.ok(!resources.has(skipped), `skipped path ${skipped} produced no sample: ${JSON.stringify([...resources])}`);
    }
    assert.ok(resources.has('/release.json'), '/release.json is a route, not a static asset');
    for (const s of raw) valid(s, 'middleware batch');

    await svc.telemetry.stop();
    assert.strictEqual(svc.eventLoopMonitorEnabled(), false, 'stop() disables the event-loop monitor');
    await svc.telemetry.stop();

    console.log('telemetry: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
