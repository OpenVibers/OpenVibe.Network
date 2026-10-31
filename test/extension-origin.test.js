'use strict';
// Extension origins on Network (2026-10-30): chrome-extension:// and moz-extension:// are never refused
// for the origin alone, get no CORS grant (no echoed Origin, no Allow-Credentials), and a cookie session
// never authenticates from one — only a Bearer does.
//
//   node --import ./test/helpers/pg-preload.mjs test/extension-origin.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const authRoutes = require('../server/auth/routes');
const publicCors = require('../server/public-cors');
const { makeRequireAuth } = require('../server/auth/session');

(async () => {
    const db = getDb();
    const keys = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    const id = (await db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES ('extana', 'extana@example.test', 'x', 'user') RETURNING id").run()).lastInsertRowid;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    await subjects.ensureUserSubject(db, user);
    const token = authRoutes.signToken(user, keys.privateKey, config);
    const requireAuth = makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
    const app = express();
    app.use(require('cookie-parser')());
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    const allowed = new Set(['https://openvibe.network']);
    const guard = publicCors.originGuard((o) => allowed.has(o), { log: { warn() {} } });
    app.use(publicCors.gate(publicCors.restrictedCors(guard.origin)));
    app.use(guard.denied);
    app.get('/api/v1/me/private', requireAuth, (req, res) => res.json({ ok: true, user: req.user.username }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (origin, { bearer = null, cookie = null } = {}) => fetch(`${base}/api/v1/me/private`, {
        headers: { ...(origin ? { origin } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { cookie } : {}) },
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), acao: r.headers.get('access-control-allow-origin'), acac: r.headers.get('access-control-allow-credentials') }));
    try {
        for (const origin of ['chrome-extension://bjcjcfcecpkkmfndegkjekoipdmbgakd', 'moz-extension://8d3b2a5e-0a9c-4f7e-9c3b-2a1f6d4e8c11']) {
            const r = await call(origin, { bearer: token });
            assert.deepStrictEqual([r.status, r.acao, r.acac], [200, null, null], `${origin}: not refused, no CORS grant`);
        }
        assert.strictEqual((await call('chrome-extension://abc', { cookie: `ov_token=${token}` })).status, 401, 'a cookie never acts from an extension origin');
        assert.strictEqual((await call('moz-extension://abc', { cookie: `ov_token=${token}` })).status, 401);
        assert.strictEqual((await call('chrome-extension://abc', { bearer: token, cookie: 'ov_token=wrong' })).status, 200, 'the Bearer acts, the cookie is ignored');
        assert.strictEqual((await call('https://evil.example', { bearer: token })).status, 403, 'a foreign web origin is still refused');
        assert.strictEqual((await call('https://openvibe.network', { cookie: `ov_token=${token}` })).status, 200, 'first-party cookies still work');
        console.log('extension origin: all checks passed');
    } finally {
        await new Promise((r) => server.close(r));
    }
})().catch((err) => { console.error(err); process.exit(1); });
