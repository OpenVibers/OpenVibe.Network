'use strict';
// Release health (roadmap WS-P task 15): the ecosystem poll reads the release-client series from the
// /metrics of services that collect release-watch reports, and /status shows tabs by generation,
// prompts, updates, deferrals, failures and drain times. Drain reads true only after the warm-up (tabs
// beat every 5 minutes into a process a deploy restarted); a release first seen late has no drain time.
//   node test/release-health.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createReleaseHealth, parseClientMetrics, WARM_MS } = require('../server/registry/release-health');

const METRICS = `# HELP release_client_sessions Open tabs
# TYPE release_client_sessions gauge
release_client_sessions{generation="current"} 7
release_client_sessions{generation="older"} 2
release_client_updates_total{outcome="prompted",reason="optional"} 3
release_client_updates_total{outcome="applied",reason="content+style"} 4
release_client_updates_total{outcome="deferred",reason="typing"} 2
release_client_updates_total{outcome="deferred",reason="media"} 1
release_client_updates_total{outcome="failed",reason="style"} 1
release_client_updates_total{outcome="bogus",reason="x"} 9
http_requests_total{route="/"} 12
`;

(async () => {
    // ── Parsing ──
    const p = parseClientMetrics(METRICS);
    assert.deepStrictEqual(p.sessions, { current: 7, older: 2 });
    assert.deepStrictEqual(p.updates, { prompted: { optional: 3 }, applied: { 'content+style': 4 }, deferred: { typing: 2, media: 1 }, failed: { style: 1 } }, 'unknown outcomes and other series are ignored');
    assert.deepStrictEqual(parseClientMetrics('http_requests_total 1\n'), { sessions: null, updates: {} });

    // ── Drain ──
    const t0 = Date.parse('2026-09-26T10:00:00Z');
    let t = t0;
    const iso = (x) => new Date(x).toISOString();
    const rh = createReleaseHealth({ now: () => t });
    const r1 = { release: 'aaaaaaa', booted_at: iso(t0) };
    const reading = (current, older) => ({ sessions: { current, older }, updates: {} });
    t = t0 + 60e3; rh.observe('live', r1, reading(5, 3));
    assert.strictEqual(rh.view('live').drain.state, 'warming', 'a fresh process has not heard from every tab');
    t = t0 + WARM_MS + 60e3; rh.observe('live', r1, reading(8, 2));
    assert.deepStrictEqual([rh.view('live').drain.state, rh.view('live').drain.older], ['draining', 2]);
    t = t0 + 9 * 60e3; rh.observe('live', r1, reading(10, 0));
    assert.deepStrictEqual(rh.view('live').drain, { state: 'drained', drained_at: iso(t), seconds: 540, within: false });
    t = t0 + 10 * 60e3; rh.observe('live', r1, reading(10, 1));
    assert.strictEqual(rh.view('live').drain.seconds, 540, 'drained once, not again');

    const r2 = { release: 'bbbbbbb', booted_at: iso(t0 + 10 * 60e3) };
    t = t0 + 11 * 60e3; rh.observe('live', r2, reading(0, 0));
    assert.strictEqual(rh.view('live').history[0].release, 'aaaaaaa', 'the last release goes to history');
    assert.strictEqual(rh.view('live').history[0].end, 'drained');
    t = t0 + 17 * 60e3; rh.observe('live', r2, reading(9, 0));
    assert.deepStrictEqual(rh.view('live').drain, { state: 'drained', drained_at: iso(t), seconds: 420, within: true }, 'no older tab by the first warm reading: within the warm-up');

    // Restarted on the same release: the counts start again, so does the warm-up.
    t = t0 + 20 * 60e3; rh.observe('chat', { release: 'ccccccc', booted_at: iso(t0) }, reading(3, 1));
    assert.strictEqual(rh.view('chat').drain.state, 'draining');
    rh.observe('chat', { release: 'ccccccc', booted_at: iso(t) }, reading(0, 0));
    assert.strictEqual(rh.view('chat').drain.state, 'warming');

    // First seen long after its start (Network restarted): no drain time is made up.
    const late = createReleaseHealth({ now: () => t0 + 3600e3 });
    late.observe('tools', { release: 'ddddddd', booted_at: iso(t0) }, reading(4, 0));
    assert.deepStrictEqual(late.view('tools').drain, { state: 'drained', drained_at: iso(t0 + 3600e3), seconds: null, within: false, seen_late: true });
    late.observe('wiki', { release: 'eeeeeee', booted_at: iso(t0) }, null);
    assert.deepStrictEqual([late.view('wiki').drain.state, late.view('wiki').sessions], ['unknown', null], 'a service that does not collect has no readings');

    // ── The poll reads /metrics only where /release.json names a metrics_url; /status shows it ──
    const { createEcosystemRegistry } = require('../server/registry/ecosystem');
    const asked = [];
    const res = (status, body, text) => ({ ok: status < 400, status, json: async () => body, text: async () => text ?? JSON.stringify(body) });
    const fetchImpl = async (url) => {
        const u = new URL(url);
        asked.push(`${u.port}${u.pathname}`);
        if (u.pathname === '/release.json') return res(200, { release: `rel${u.port}`, booted_at: iso(Date.now() - 3600e3), ...(u.port === '3000' ? { metrics_url: '/release-metrics' } : {}) });
        if (u.pathname === '/metrics') return res(200, null, METRICS);
        return res(200, { ready: true, status: 'ready', checks: {} });
    };
    const eco = createEcosystemRegistry({ issuer: 'https://openvibe.network', fetchImpl, internalOverrides: { live: 'http://127.0.0.1:3000' } });
    await eco.pollAll();
    assert.ok(asked.includes('3000/metrics'), 'a collecting service is read');
    assert.ok(!asked.some((a) => a.endsWith('/metrics') && !a.startsWith('3000')), 'no /metrics for services without a metrics_url');
    const view = eco.releaseHealth('live');
    assert.deepStrictEqual([view.sessions, view.counts], [{ current: 7, older: 2 }, { prompted: 3, applied: 4, reloaded: 0, deferred: 3, failed: 1 }]);

    const app = express();
    app.use(require('../server/status/routes').createStatusRoutes({ ecosystem: eco }));
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = await (await fetch(`${base}/api/v1/status`)).json();
    assert.strictEqual(json.services.find((s) => s.id === 'live').release_health.sessions.current, 7);
    assert.ok(json.release_health_since);
    const html = await (await fetch(`${base}/status`)).text();
    assert.ok(html.includes('id="h-release-health"'), 'the page has the section');
    assert.match(html, /7 \/ 2<small>78% on current<\/small>/, 'tabs by generation');
    assert.match(html, /typing 2, media 1/, 'deferral reasons');
    assert.match(html, /drained<small>before Network watched<\/small>|older tab/, 'a drain state');
    server.close();
    console.log('release health: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
