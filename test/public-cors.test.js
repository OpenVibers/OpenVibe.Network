'use strict';
// Public discovery CORS (server/public-cors.js): /.well-known/openvibe, /api/v1/registry/* and
// /contracts/*.json answer any origin (preflight included); every other route keeps the allow-list.
//   node test/public-cors.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const cors = require('cors');
const publicCors = require('../server/public-cors');
const { createEcosystemRegistry } = require('../server/registry/ecosystem');

(async () => {
    // Path decision
    for (const p of ['/.well-known/openvibe', '/api/v1/registry', '/api/v1/registry/', '/api/v1/registry/services', '/api/v1/registry/services/network',
        '/api/v1/registry/domains/openvibe.community', '/api/v1/registry/capabilities/media.object.upload', '/contracts/identity/subject-ref.v1.json', '/contracts/events/payloads/deals.watch.matched.v1.json']) {
        assert.ok(publicCors.isPublicDiscoveryPath(p), `${p} is public`);
    }
    for (const p of ['/api/v1/registryx', '/api/v1/registry-admin', '/api/v1/registry/../projects', '/api/v1/registry/%2e%2e/projects', '/api/v1/registry/a%2Fb',
        '/api/v1/registry//services', '/contracts/../x', '/contracts/foo', '/contracts/identity/subject-ref.json', '/contracts/identity/subject-ref.v1.json/x',
        '/.well-known/openvibe/x', '/.well-known/openid-configuration', '/api/.well-known/jwks', '/api/auth/login', '/api/v1/projects', '/oauth/token', '/']) {
        assert.ok(!publicCors.isPublicDiscoveryPath(p), `${p} is not public`);
    }

    // The same wiring as server/index.js: gate(restricted cors) in front of everything.
    const allowed = new Set(['https://openvibe.live']);
    const eco = createEcosystemRegistry({ issuer: 'https://openvibe.network', internalOverrides: {} });
    const app = express();
    const warned = [];
    const guard = publicCors.originGuard((o) => allowed.has(o), { log: { warn: (m) => warned.push(m) } });
    app.use(publicCors.gate(cors({ origin: guard.origin, credentials: true })));
    app.use(guard.denied);
    app.use(eco.router());
    app.post('/api/auth/login', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/projects', (_req, res) => res.json({ projects: [] }));
    app.post('/oauth/token', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/registryx', (_req, res) => res.json({ ok: true }));
    app.use((err, _req, res, _next) => res.status(500).json({ error: String(err.message) }));
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const FOREIGN = 'https://someones-app.example';
    const req = (method, p, headers = {}) => fetch(base + p, { method, headers });

    for (const p of ['/.well-known/openvibe', '/api/v1/registry', '/api/v1/registry/services', '/api/v1/registry/capabilities', '/api/v1/registry/contracts',
        '/contracts/identity/subject-ref.v1.json']) {
        let r = await req('OPTIONS', p, { origin: FOREIGN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'traceparent, x-openvibe-request-id, authorization, content-type' });
        assert.strictEqual(r.status, 204, `${p} preflight`);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
        assert.match(r.headers.get('access-control-allow-methods'), /GET/);
        const allowHeaders = r.headers.get('access-control-allow-headers').toLowerCase();
        for (const h of ['traceparent', 'x-openvibe-request-id', 'authorization', 'content-type']) assert.ok(allowHeaders.includes(h), `${p} allows ${h}`);
        assert.ok(Number(r.headers.get('access-control-max-age')) > 0);
        assert.strictEqual(r.headers.get('access-control-allow-credentials'), null, 'never with credentials');

        r = await req('GET', p, { origin: FOREIGN, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
        assert.strictEqual(r.status, 200, `${p} GET`);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
        assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
        assert.match(r.headers.get('access-control-expose-headers'), /X-OpenVibe-Request-Id/);
        assert.strictEqual(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
        assert.match(r.headers.get('cache-control') || '', /^public, max-age=\d+$/, `${p} keeps its caching headers`);
        await r.arrayBuffer();
    }
    // Problem responses on public paths are readable too.
    let r = await req('GET', '/api/v1/registry/services/nope', { origin: FOREIGN });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    r = await req('GET', '/contracts/identity/nope.v1.json', { origin: FOREIGN });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');

    // Everything else keeps the allow-list: a foreign origin gets no CORS grant (and an error).
    for (const [method, p] of [['POST', '/api/auth/login'], ['GET', '/api/v1/projects'], ['POST', '/oauth/token'], ['GET', '/api/v1/registryx'], ['OPTIONS', '/api/v1/projects'], ['OPTIONS', '/oauth/token']]) {
        r = await req(method, p, { origin: FOREIGN, 'access-control-request-method': 'POST' });
        assert.notStrictEqual(r.headers.get('access-control-allow-origin'), '*', `${method} ${p} is not opened`);
        assert.notStrictEqual(r.headers.get('access-control-allow-origin'), FOREIGN, `${method} ${p} does not reflect a foreign origin`);
        assert.strictEqual(r.status, 403, `${method} ${p} refuses the foreign origin (the route never runs)`);
    }
    assert.strictEqual(warned.length, 1, 'a refused origin is logged once, not per request');
    // ...while first-party origins still work there, with credentials.
    r = await req('GET', '/api/v1/projects', { origin: 'https://openvibe.live' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://openvibe.live');
    assert.strictEqual(r.headers.get('access-control-allow-credentials'), 'true');

    eco.stop(); srv.close();
    console.log('public discovery CORS: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
