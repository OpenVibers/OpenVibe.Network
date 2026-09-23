'use strict';
// Ecosystem registry (server/registry/ecosystem.js): descriptor, services with timestamped health,
// capability/namespace/contract listings, and schemas served at their $id URLs.
const assert = require('assert');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');
const { createEcosystemRegistry } = require('../server/registry/ecosystem');

(async () => {
    const up = http.createServer((req, res) => { res.statusCode = req.url === '/api/health' ? 200 : 404; res.end('{}'); });
    await new Promise(r => up.listen(0, '127.0.0.1', r));
    const upUrl = `http://127.0.0.1:${up.address().port}`;
    const eco = createEcosystemRegistry({ issuer: 'https://openvibe.network', internalOverrides: { network: upUrl, live: 'http://127.0.0.1:1', media: upUrl } });
    await eco.pollAll();
    const app = express();
    app.use(eco.router());
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = (p) => fetch(base + p).then(async r => ({ status: r.status, type: r.headers.get('content-type'), cors: r.headers.get('access-control-allow-origin'), body: await r.json() }));

    let r = await get('/.well-known/openvibe');
    assert.strictEqual(r.body.jwks_uri, 'https://openvibe.network/api/.well-known/jwks');
    assert.ok(r.body.services.some(s => s.id === 'community'));
    assert.strictEqual(r.cors, '*');

    r = await get('/api/v1/registry/services');
    const byId = Object.fromEntries(r.body.services.map(s => [s.id, s]));
    assert.strictEqual(byId.network.runtime.status, 'up');
    assert.ok(byId.network.runtime.checked_at, 'every health value says when it was checked');
    assert.strictEqual(byId.live.runtime.status, 'down', 'unreachable is reported, not hidden');
    assert.strictEqual(byId.realtime.runtime.status, 'not-running', 'placeholders are never shown as running');
    assert.ok(r.body.services.every(s => contracts.validate('registry.service-manifest@1', Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'runtime' && k !== 'exposure'))).valid));
    r = await get('/api/v1/registry/services?status=placeholder');
    // openvibe-contracts 0.30: realtime is the only placeholder manifest left (AI, SDK, Shared, Examples are alpha).
    assert.ok(r.body.services.length >= 1 && r.body.services.every(s => s.status === 'placeholder'));
    assert.ok(r.body.services.some(s => s.id === 'realtime'));

    r = await get('/api/v1/registry/services/network');
    assert.ok(r.body.capability_details.some(c => c.id === 'network.coins.credit'));
    r = await get('/api/v1/registry/services/nope');
    assert.strictEqual(r.status, 404); assert.strictEqual(r.body.code, 'registry.unknown_service');
    r = await get('/api/v1/registry/domains/openvibe.community');
    assert.strictEqual(r.body.service.id, 'community');
    r = await get('/api/v1/registry/capabilities?owner=community');
    assert.ok(r.body.capabilities.length >= 3 && r.body.capabilities.every(c => c.owner === 'community'));
    r = await get('/api/v1/registry/namespaces');
    assert.ok(r.body.namespaces.some(n => n.namespace === 'chat.tts_defaults'));

    r = await get('/api/v1/registry/contracts');
    const sub = r.body.contracts.find(c => c.id === 'identity.subject-ref');
    const path = new URL(sub.$id).pathname;
    r = await get(path);
    assert.strictEqual(r.status, 200); assert.ok(r.type.startsWith('application/schema+json'));
    assert.strictEqual(r.body.$id, sub.$id, 'the schema is served at its own $id');
    r = await get('/contracts/identity/nope.v1.json');
    assert.strictEqual(r.status, 404);

    eco.stop(); srv.close(); up.close();
    console.log('ecosystem registry: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
