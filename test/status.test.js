'use strict';
// Operator status (server/status/routes.js over server/registry/ecosystem.js): every row is
// up | degraded | down | not-running | unknown with checked_at, built from each service's readiness
// and /release.json — never an optimistic default. Roadmap Track O.
//   node test/status.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');
const { createEcosystemRegistry } = require('../server/registry/ecosystem');
const { createStatusRoutes } = require('../server/status/routes');

function fakeService(routes) {
    const srv = http.createServer((req, res) => {
        const h = routes[req.url];
        if (!h) { res.statusCode = 404; return res.end('{"error":"Not found"}'); }
        const [status, body] = typeof h === 'function' ? h() : h;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
const check = (status, required, extra = {}) => ({ status, required, latency_ms: 1.2, checked_at: '2026-09-23T00:00:00.000Z', ...extra });
const rel = (release) => [200, { service: 'x', release, released_at: '2026-09-22T20:00:00.000Z', booted_at: '2026-09-23T00:00:00.000Z' }];

(async () => {
    let communityDown = false;
    const network = await fakeService({ '/api/ready': [200, { ready: true, status: 'ready', failed: [], degraded: [], checks: { db: check('ok', true) } }], '/release.json': rel('aaaaaaaaaaaa') });
    const media = await fakeService({ '/api/ready': [200, { ready: true, status: 'degraded', failed: [], degraded: ['remote_b2'], checks: { db: check('ok', true), remote_b2: check('fail', false, { error: 'timeout' }) } }], '/release.json': rel('bbbbbbbbbbbb') });
    const community = await fakeService({ '/api/ready': () => (communityDown ? [503, { ready: false, status: 'not_ready', failed: ['db'], degraded: [], checks: { db: check('fail', true, { error: 'SQLITE_CANTOPEN' }) } }] : [200, { ready: true, status: 'ready', failed: [], degraded: [], checks: { db: check('ok', true) } }]), '/release.json': rel('cccccccccccc') });
    const tools = await fakeService({ '/api/health': [200, { status: 'ok' }] });          // no /api/ready yet, no release.json
    const events = await fakeService({ '/api/ready': [200, { status: 'ready', checks: { db: true } }] });   // an older ad-hoc shape

    let clock = Date.parse('2026-09-23T01:00:00Z');
    const eco = createEcosystemRegistry({
        issuer: 'https://openvibe.network', pollMs: 60000, now: () => clock,
        internalOverrides: { network: network.url, media: media.url, community: community.url, tools: tools.url, events: events.url, live: 'http://127.0.0.1:1', games: 'http://127.0.0.1:1', billing: 'http://127.0.0.1:1' },
    });
    const app = express();
    app.use(createStatusRoutes({ ecosystem: eco, now: () => new Date(clock) }));
    app.use(eco.router());
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (p) => fetch(base + p).then(async r => ({ status: r.status, headers: r.headers, body: await r.json() }));

    // Before any poll: everything that runs is 'unknown' with no checked_at — never 'up'.
    let r = await json('/api/v1/status');
    let by = Object.fromEntries(r.body.services.map(s => [s.id, s]));
    assert.strictEqual(by.network.status, 'unknown');
    assert.strictEqual(by.network.checked_at, null);
    assert.strictEqual(r.body.last_poll_at, null);
    assert.ok(r.body.services.every(s => r.body.states.includes(s.status)));

    await eco.pollAll();
    r = await json('/api/v1/status');
    by = Object.fromEntries(r.body.services.map(s => [s.id, s]));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(by.network.status, 'up');
    assert.strictEqual(by.network.basis, 'ready');
    assert.strictEqual(by.network.release.release, 'aaaaaaaaaaaa');
    assert.strictEqual(by.network.release.booted_at, '2026-09-23T00:00:00.000Z');
    assert.strictEqual(by.media.status, 'degraded', 'an optional failure degrades, it does not read as healthy or down');
    assert.deepStrictEqual(by.media.ready.degraded, ['remote_b2']);
    assert.strictEqual(by.media.ready.checks.remote_b2.error, 'timeout');
    assert.strictEqual(by.community.status, 'up');
    assert.strictEqual(by.tools.status, 'up');
    assert.strictEqual(by.tools.basis, 'health', 'no readiness endpoint: liveness only, and the row says so');
    assert.strictEqual(by.tools.release, null);
    assert.ok(by.tools.release_error);
    assert.strictEqual(by.events.basis, 'ready-legacy');
    assert.strictEqual(by.live.status, 'down', 'unreachable is down');
    assert.strictEqual(by.realtime.status, 'not-running');
    assert.strictEqual(by.realtime.label, 'not running (placeholder)');
    assert.strictEqual(by.contracts.status, 'not-running');
    assert.strictEqual(by.contracts.label, `not running (library, released v${require('openvibe-contracts/package.json').version})`);
    for (const s of r.body.services) assert.ok(s.checked_at, `${s.id} says when it was checked`);
    assert.strictEqual(r.body.summary.up + r.body.summary.degraded + r.body.summary.down + r.body.summary['not-running'] + r.body.summary.unknown, contracts.services.manifests.length);

    // A required failure on the service is 'down', with its failed checks.
    communityDown = true;
    await eco.pollAll();
    by = Object.fromEntries((await json('/api/v1/status')).body.services.map(s => [s.id, s]));
    assert.strictEqual(by.community.status, 'down');
    assert.deepStrictEqual(by.community.ready.failed, ['db']);

    // The registry's runtime field says the same thing.
    r = await json('/api/v1/registry/services/community');
    assert.strictEqual(r.body.runtime.status, 'down');

    // Stale: older than three poll intervals is 'unknown', never the last good state.
    clock += 4 * 60000;
    by = Object.fromEntries((await json('/api/v1/status')).body.services.map(s => [s.id, s]));
    assert.strictEqual(by.network.status, 'unknown');
    assert.strictEqual(by.network.stale, true);
    assert.strictEqual(by.network.last_status, 'up');
    clock -= 4 * 60000;

    // The page: server-rendered, noindex, no JavaScript needed to read it.
    const page = await fetch(base + '/status');
    const html = await page.text();
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('x-robots-tag'), /noindex/);
    assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
    assert.ok(html.includes('id="svc-media"') && /id="svc-media"[\s\S]*?Degraded/.test(html));
    assert.ok(/id="svc-community"[\s\S]*?Down[\s\S]*?SQLITE_CANTOPEN/.test(html));
    assert.ok(/id="svc-realtime"[\s\S]*?not running \(placeholder\)/.test(html));
    assert.ok(/id="svc-tools"[\s\S]*?liveness only/.test(html));
    assert.ok(html.includes('<noscript>'), 'navigation without JavaScript');
    assert.ok(html.includes('SLO categories (proposals)'));
    const noScript = html.replace(/<script[\s\S]*?<\/script>/g, '');
    assert.ok(noScript.includes('aaaaaaaaaaaa'), 'the rows are in the HTML itself');

    // SLO categories: the ten from §15.19, every target labelled a proposal.
    r = await json('/api/v1/status/slo');
    assert.strictEqual(r.body.status, 'proposal');
    assert.strictEqual(r.body.categories.length, 10);
    for (const c of r.body.categories) {
        assert.ok(c.id && c.name && c.sli && c.proposed_target && ['integrity', 'availability', 'continuity'].includes(c.priority), c.id);
        assert.ok(Array.isArray(c.measured_by));
        if (!c.measured_by.length) assert.ok(/not instrumented/.test(c.measurement_status), `${c.id} says it is not measured`);
    }

    for (const s of [network, media, community, tools, events]) s.srv.close();
    srv.close();
    console.log('status: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
