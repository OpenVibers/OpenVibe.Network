'use strict';
// Session-token confusion and revocation:
//  - a FedCM assertion (typ fedcm, minted for one RP origin) is not a Network session anywhere
//  - a token revoked by a password change (token_valid_after) cannot start an OAuth sign-in
//  - refresh tokens issued before a password change stop working
//   node test/security-session.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { initDb } = require('../server/db/database');
const { verifySession } = require('../server/auth/session');
const { signAssertion } = require('../server/auth/fedcm');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-secsess-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'viewer', 'x')").run();
db.prepare("INSERT INTO users (id, username, password_hash) VALUES (8, 'changed', 'x')").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const config = { internalKey: 'k'.repeat(32), baseUrl: ISSUER, loginUrl: ISSUER, networkUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h', refreshTokenExpiry: '30d' } };
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.locals.db = db;
app.locals.config = config;
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/auth', require('../server/auth/routes'));
app.use('/internal', require('../server/internal/routes'));
const server = http.createServer(app);

const REDIRECT = 'https://openvibe.live/api/auth/callback';
const ctx = { db, publicKey: keys.publicKey, privateKey: keys.privateKey, config };
const user7 = db.prepare('SELECT * FROM users WHERE id = 7').get();
const assertion = signAssertion(user7, 'https://evil.openvibe.tools', 'n', ctx);
const sign = (sub, opts = {}) => jwt.sign({ sub, id: sub, username: 'u' }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h', ...opts });

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
        .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    // ── FedCM assertions are not sessions ────────────────────────────
    assert.ok(!verifySession(sign(7), ctx).error, 'a normal user token is a session');
    assert.ok(verifySession(assertion, ctx).error, 'a FedCM assertion is not a Network session');
    let r = await post('/oauth/confirm', { token: assertion, client_id: 'live', redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 401, 'a FedCM assertion cannot sign in to another client through /oauth/confirm');
    r = await post('/api/auth/refresh', {}, { authorization: `Bearer ${assertion}` });
    assert.strictEqual(r.status, 401, 'a FedCM assertion cannot be refreshed into a full session');
    r = await post('/internal/verify-token', { token: assertion }, { 'x-internal-key': config.internalKey });
    assert.strictEqual(r.body.valid, false, 'internal verify-token does not call a FedCM assertion a user token');
    r = await post('/internal/verify-token', { token: sign(7) }, { 'x-internal-key': config.internalKey });
    assert.strictEqual(r.body.valid, true);

    // ── Revoked tokens (password changed after iat) ──────────────────
    const old = sign(8, { expiresIn: '1h' });
    // one refresh token issued before the change
    r = await post('/oauth/confirm', { token: old, client_id: 'live', redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const code = new URL(r.body.redirect).searchParams.get('code');
    const t = await post('/oauth/token', { grant_type: 'authorization_code', client_id: 'live', client_secret: 'live-secret', code, redirect_uri: REDIRECT });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    // backdate what was issued so far, then change the password now
    db.prepare("UPDATE oauth_tokens SET created_at = datetime('now', '-10 minutes') WHERE user_id = 8").run();
    db.prepare("UPDATE users SET token_valid_after = CURRENT_TIMESTAMP WHERE id = 8").run();
    const stale = jwt.sign({ sub: 8, id: 8, username: 'changed', iat: Math.floor(Date.now() / 1000) - 600 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
    assert.ok(verifySession(stale, ctx).error, 'the session guard refuses the revoked token');
    r = await post('/oauth/confirm', { token: stale, client_id: 'live', redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 401, 'a revoked token cannot start an OAuth sign-in');
    r = await post('/oauth/token', { grant_type: 'refresh_token', client_id: 'live', client_secret: 'live-secret', refresh_token: t.body.refresh_token });
    assert.strictEqual(r.status, 400, 'a refresh token issued before the password change is dead');
    assert.strictEqual(r.body.error, 'invalid_grant');

    // an unaffected user keeps refreshing, and rotation still works
    r = await post('/oauth/confirm', { token: sign(7), client_id: 'live', redirect_uri: REDIRECT });
    const t7 = await post('/oauth/token', { grant_type: 'authorization_code', client_id: 'live', client_secret: 'live-secret', code: new URL(r.body.redirect).searchParams.get('code'), redirect_uri: REDIRECT });
    assert.strictEqual(t7.status, 200);
    r = await post('/oauth/token', { grant_type: 'refresh_token', client_id: 'live', client_secret: 'live-secret', refresh_token: t7.body.refresh_token });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await post('/oauth/token', { grant_type: 'refresh_token', client_id: 'live', client_secret: 'live-secret', refresh_token: t7.body.refresh_token });
    assert.strictEqual(r.status, 400, 'a rotated refresh token is single-use');
    r = await post('/oauth/token', { grant_type: 'refresh_token', client_id: 'live', client_secret: 'wrong-secret', refresh_token: t7.body.refresh_token });
    assert.strictEqual(r.status, 401, 'wrong client secret');

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('session token confusion and revocation: all checks passed');
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
