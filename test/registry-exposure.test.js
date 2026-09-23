'use strict';
// Exposure overlay (server/registry/exposure.js): every service has one honest state, and the
// registry, the status page and the chrome nav all say the same thing. A service that runs on
// loopback while its public domain still serves a placeholder is never "up" at that domain.
//   node test/registry-exposure.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');
const exposure = require('../server/registry/exposure');
const { createEcosystemRegistry } = require('../server/registry/ecosystem');
const { createStatusRoutes } = require('../server/status/routes');
const { SITES } = require('../server/chrome/sites');

// Observed 2026-09-23 with curl against every public domain. Change a row only after the domain
// stops answering "this page is a placeholder" (or a library ships a new release).
const PINNED = {
    network: 'live', live: 'live', tools: 'live', media: 'live', games: 'live', community: 'live', events: 'live',
    billing: 'live', codes: 'live', blog: 'live', wiki: 'live', sites: 'live',
    news: 'internal', reviews: 'internal', deals: 'internal', coupons: 'internal', trade: 'internal', host: 'internal',
    tips: 'internal', vip: 'internal', openre: 'internal', search: 'live', sources: 'internal', chat: 'internal', ai: 'internal',
    sdk: 'library', shared: 'library', contracts: 'library',
    examples: 'repository',
    realtime: 'placeholder',
};
const PLACEHOLDER_DOMAINS = ['news', 'reviews', 'deals', 'coupons', 'trade', 'host', 'tips', 'vip', 'openre'];

function fakeService(routes) {
    const srv = http.createServer((req, res) => {
        const h = routes[req.url];
        if (!h) { res.statusCode = 404; return res.end('{}'); }
        res.statusCode = h[0]; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(h[1]));
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
const ready = [200, { ready: true, status: 'ready', failed: [], degraded: [], checks: { db: { status: 'ok', required: true } } }];

(async () => {
    // 1. Every manifest is classified, and the classification is the pinned one.
    for (const m of contracts.services.manifests) assert.notStrictEqual(exposure.exposureOf(m.id).state, 'unknown', `${m.id} has no exposure state`);
    const actual = Object.fromEntries(contracts.services.manifests.map(m => [m.id, exposure.exposureOf(m.id).state]));
    assert.deepStrictEqual(actual, PINNED);
    assert.deepStrictEqual(Object.keys(exposure.EXPOSURE).sort(), Object.keys(PINNED).sort(), 'no stale rows for services that no longer exist');
    for (const id of PLACEHOLDER_DOMAINS) {
        assert.strictEqual(exposure.EXPOSURE[id].public_site, 'placeholder', `${id}'s domain serves a placeholder`);
        assert.strictEqual(exposure.publicOriginOf(contracts.services.get(id)), null, `${id} has no public origin`);
    }
    assert.strictEqual(exposure.exposureOf('sdk').release, `v${require('openvibe-sdk/package.json').version}`);
    assert.strictEqual(exposure.exposureOf('shared').release, `v${require('openvibe-shared/package.json').version}`, 'the release is the installed version');
    assert.strictEqual(exposure.exposureOf('nope').state, 'unknown', 'an unclassified id is unknown, not public');

    // 2. Registry and status over fake loopback services.
    const up = await fakeService({ '/api/ready': ready, '/ready': ready, '/api/health': [200, { status: 'ok' }], '/health': [200, {}], '/healthz': [200, {}] });
    const ai = await fakeService({ '/api/ready': ready, '/api/health': [200, { status: 'ok' }] });   // AI answers its manifest's /api/ready (contracts 0.30)
    const overrides = {};
    for (const id of Object.keys(exposure.EXPOSURE)) overrides[id] = up.url;
    overrides.ai = ai.url;
    const eco = createEcosystemRegistry({ issuer: 'https://openvibe.network', internalOverrides: overrides });
    await eco.pollAll();
    const app = express();
    app.use(createStatusRoutes({ ecosystem: eco }));
    app.use(eco.router());
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (p) => fetch(base + p).then(r => r.json());

    const d = await json('/.well-known/openvibe');
    const dBy = Object.fromEntries(d.services.map(s => [s.id, s]));
    assert.strictEqual(dBy.news.state, 'internal');
    assert.strictEqual(dBy.news.origin, null, 'clients never route to a placeholder page');
    assert.strictEqual(dBy.news.planned_origin, 'https://openvibe.news');
    assert.strictEqual(dBy.live.origin, 'https://openvibe.live');
    assert.strictEqual(dBy.live.state, 'live');
    for (const s of d.services) assert.strictEqual(s.state, PINNED[s.id]);

    let r = await json('/api/v1/registry/services');
    const by = Object.fromEntries(r.services.map(s => [s.id, s]));
    assert.strictEqual(by.deals.exposure.state, 'internal');
    assert.strictEqual(by.deals.exposure.public_site, 'placeholder');
    assert.strictEqual(by.deals.runtime.status, 'up');
    assert.strictEqual(by.deals.runtime.scope, 'loopback');
    assert.match(by.deals.runtime.reason, /loopback only/);
    assert.strictEqual(by.ai.runtime.status, 'up', 'AI is polled on loopback although its pinned manifest says placeholder');
    assert.strictEqual(by.ai.runtime.basis, 'ready');
    assert.strictEqual(by.sdk.runtime.status, 'not-running');
    assert.strictEqual(by.sdk.runtime.reason, `library, released v${require('openvibe-sdk/package.json').version}`);
    assert.strictEqual(by.examples.runtime.reason, 'repository, nothing to run');
    assert.strictEqual(by.realtime.runtime.reason, 'placeholder');
    assert.strictEqual(by.live.runtime.scope, 'public');
    r = await json('/api/v1/registry/services?state=internal');
    assert.deepStrictEqual(r.services.map(s => s.id).sort(), Object.keys(PINNED).filter(k => PINNED[k] === 'internal').sort());
    r = await json('/api/v1/registry/domains/openvibe.coupons');
    assert.strictEqual(r.service.exposure.state, 'internal');

    const st = await json('/api/v1/status');
    const sBy = Object.fromEntries(st.services.map(s => [s.id, s]));
    assert.strictEqual(sBy.news.label, 'up (loopback only)');
    assert.strictEqual(sBy.news.origin, null);
    assert.strictEqual(sBy.news.planned_origin, 'https://openvibe.news');
    assert.strictEqual(sBy.live.label, 'up');
    assert.strictEqual(sBy.live.origin, 'https://openvibe.live');
    assert.strictEqual(sBy.shared.label, `not running (library, released v${require('openvibe-shared/package.json').version})`);
    assert.deepStrictEqual(st.exposure_summary, { live: 13, internal: 12, library: 3, repository: 1, placeholder: 1 });

    // The page: no row for a service whose domain serves a placeholder shows a bare "Up".
    const html = await fetch(base + '/status').then(x => x.text());
    for (const id of PLACEHOLDER_DOMAINS.concat(['chat', 'ai'])) {
        const row = html.match(new RegExp(`<tr id="svc-${id}">[\\s\\S]*?</tr>`))[0];
        assert.ok(!/>Up<\/span>/.test(row), `${id} row must not read a bare Up`);
        assert.ok(row.includes('Up · loopback only'), `${id} row says loopback only`);
        assert.ok(row.includes('internal (loopback only, no public site yet)'), `${id} row names its exposure`);
    }
    assert.ok(/<tr id="svc-news">[\s\S]*?openvibe\.news: not this service yet/.test(html));
    assert.ok(/<tr id="svc-live">[\s\S]*?>Up<\/span>/.test(html), 'a public service still reads Up');

    // 3. Chrome: the nav lists only sites whose domain serves the service; the rest are soon with a reason.
    const open = SITES.filter(s => s.status === 'open').map(s => s.id);
    assert.deepStrictEqual(open, ['live', 'tools', 'community', 'games', 'media', 'network', 'codes', 'blog', 'wiki']);
    for (const s of SITES) {
        assert.ok(s.service && PINNED[s.service], `${s.id} names its service`);
        assert.strictEqual(s.status === 'open', PINNED[s.service] === 'live', `${s.id} nav status follows exposure`);
    }
    for (const id of ['news', 'reviews', 'deals', 'coupons', 'trade', 'host', 'tips', 'vip', 'stream', 'chat']) {
        const s = SITES.find(x => x.id === id);
        assert.strictEqual(s.status, 'soon'); assert.strictEqual(s.state, 'internal');
    }

    eco.stop(); srv.close(); up.srv.close(); ai.srv.close();
    console.log('registry exposure: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
