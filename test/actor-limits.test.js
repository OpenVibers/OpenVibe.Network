'use strict';
// Per-actor limits on the account API's writes (server/auth/actor-limits.js; roadmap WS-R task 4): a person's session
// writes count by subject, 429 problem+json rate_limited with Retry-After before the route runs, while another person
// passes; sensitive writes have tighter numbers on top; reads, signed-out writes, service tokens and sign-in routes are
// never counted; the window reopens.
//   node test/actor-limits.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createNetworkActorLimits, ROUTES } = require('../server/auth/actor-limits');

const ISS = 'https://openvibe.network';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const session = (id, subject) => jwt.sign({ sub: id, id, subject_id: subject, username: `u${id}` }, keys.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: '1h' });
const service = jwt.sign({ sub: 'svc:live', actor_type: 'service', cap: [] }, keys.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: '1h' });
console.warn = () => {};

(async () => {
    let t = Date.UTC(2026, 8, 28, 3, 0, 0);
    const counted = [];
    const app = express();
    app.use('/api/', createNetworkActorLimits({ env: { NETWORK_LIMITS_MINUTE: '5' }, publicKey: keys.publicKey, issuer: ISS, registry: { counter: () => ({ inc: (l) => counted.push(l) }) }, now: () => t }));
    let ran = 0;
    app.all('/api/*', (req, res) => { ran++; res.json({ ok: true }); });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, token) => {
        const r = await fetch(base + p, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
        return { status: r.status, retry: r.headers.get('retry-after'), body: await r.json().catch(() => ({})) };
    };
    const ann = session(1, 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1');
    const bob = session(2, 'usr_01JAB2C3D4E5F6G7H8J9K0MNP2');
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await call('PUT', '/api/themes/me', ann)).status, 200);
        const before = ran;
        const r = await call('PUT', '/api/themes/me', ann);
        assert.deepStrictEqual([r.status, r.body.code, Number(r.retry) > 0, ran], [429, 'rate_limited', true, before]);
        assert.strictEqual((await call('PUT', '/api/themes/me', bob)).status, 200, 'another person passes');
        for (let i = 0; i < 10; i++) {
            assert.strictEqual((await call('GET', '/api/v1/me/follows', ann)).status, 200, 'reads are not counted');
            assert.strictEqual((await call('POST', '/api/v1/projects')).status, 200, 'signed-out writes are not counted');
            assert.strictEqual((await call('POST', '/api/v1/projects', service)).status, 200, 'service tokens are not counted');
            assert.strictEqual((await call('POST', '/api/auth/login', ann)).status, 200, 'sign-in has its own limiter');
        }
        t += 60 * 1000;
        const carol = session(3, 'usr_01JAB2C3D4E5F6G7H8J9K0MNP3');
        for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', '/api/v1/projects', carol)).status, 200);
        const p = await call('POST', '/api/v1/projects', carol);
        assert.strictEqual(p.status, 429);
        assert.ok(ROUTES.find((x) => x[0] === 'network.theme.submit')[2].test('/themes/import'));
        assert.ok(ROUTES.find((x) => x[0] === 'network.account')[2].test('/v1/account/export'));
        t += 60 * 1000;
        assert.strictEqual((await call('PUT', '/api/themes/me', ann)).status, 200, 'the next minute');
        assert.ok(counted.some((l) => l.limit === 'network.api.write'));
    } finally {
        server.close();
    }
    console.log('actor limits: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
