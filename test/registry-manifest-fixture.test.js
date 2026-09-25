'use strict';
// WS-C task 1, the manifest-derived registry: a new service manifest (a fixture added the way Contracts adds
// one) appears in the discovery document, the registry's service list, the status page and the frame's site
// list, polled at its internalOrigin and linked at its publicOrigin, with no Network code edit; one whose
// exposure is internal stays out of the navigation and is polled on loopback only.
const assert = require('assert');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');

const base = { version: '0.1.0', status: 'alpha', repository: 'OpenVibers/OpenVibe.Zines', health: '/api/health', ready: '/api/ready',
    capabilities: [], eventsProduced: [], eventsConsumed: [], namespacesOwned: [], contractRanges: {} };

(async () => {
    const svc = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/ready') return res.end(JSON.stringify({ ready: true, status: 'ready', failed: [], degraded: [], checks: { db: { status: 'ok', required: true } } }));
        if (req.url === '/api/health') return res.end('{"status":"ok"}');
        res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => svc.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${svc.address().port}`;
    const fixtures = [
        { ...base, id: 'zines', name: 'OpenVibe.Zines', domains: ['openvibe.zines'], publicOrigin: 'https://openvibe.zines', internalOrigin: origin,
            exposure: { state: 'live', publicSite: 'service' },
            site: { name: 'Zines', icon: 'zines', tagline: 'Small magazines', what: 'Make and read small magazines.', legalProfile: 'ugc', position: 90 } },
        { ...base, id: 'almanac', name: 'OpenVibe.Almanac', domains: ['openvibe.almanac'], publicOrigin: 'https://openvibe.almanac', internalOrigin: origin,
            exposure: { state: 'internal', publicSite: 'placeholder', note: 'the domain serves a placeholder' },
            site: { name: 'Almanac', icon: 'almanac', tagline: 'Dates', what: 'What happened when.', legalProfile: 'info', position: 91 } },
    ];
    for (const m of fixtures) {
        const v = contracts.validate('registry.service-manifest@1', m);
        assert.ok(v.valid, JSON.stringify(v.errors));
        contracts.services.manifests.push(m);
    }
    // Loaded after the fixtures, like a Network release that installs a Contracts release with them.
    const { createEcosystemRegistry, INTERNAL } = require('../server/registry/ecosystem');
    const { exposureOf } = require('../server/registry/exposure');
    const { SITES, siteForHost } = require('../server/frame/sites');
    const { createStatusRoutes } = require('../server/status/routes');

    assert.strictEqual(INTERNAL.zines, origin, 'polled at its internalOrigin');
    assert.strictEqual(exposureOf('zines').state, 'live');
    assert.deepStrictEqual(SITES.filter((s) => ['zines', 'almanac'].includes(s.service)).map((s) => [s.id, s.status, s.host, s.profile]), [['zines', 'open', 'openvibe.zines', 'ugc'], ['almanac', 'soon', 'openvibe.almanac', 'info']]);
    assert.strictEqual(siteForHost('openvibe.zines').service, 'zines');

    const eco = createEcosystemRegistry({ issuer: 'https://openvibe.network' });
    await eco.pollAll();
    const app = express();
    app.use(createStatusRoutes({ ecosystem: eco }));
    app.use(eco.router());
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const json = (p) => fetch(url + p).then((r) => r.json());

    const disc = Object.fromEntries((await json('/.well-known/openvibe')).services.map((s) => [s.id, s]));
    assert.strictEqual(disc.zines.state, 'live'); assert.strictEqual(disc.almanac.state, 'internal');
    const listed = await json('/api/v1/registry/services');
    const rows = Object.fromEntries((listed.services || listed).map((s) => [s.id, s]));
    assert.ok(rows.zines && rows.almanac, 'both in the registry');
    const status = Object.fromEntries((await json('/api/v1/status')).services.map((s) => [s.id, s]));
    assert.strictEqual(status.zines.label, 'up'); assert.strictEqual(status.zines.origin, 'https://openvibe.zines');
    assert.strictEqual(status.almanac.label, 'up (loopback only)'); assert.strictEqual(status.almanac.origin, null);
    assert.strictEqual(status.almanac.planned_origin, 'https://openvibe.almanac');

    srv.close(); svc.close(); eco.stop && eco.stop();
    console.log('registry manifest fixture: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
