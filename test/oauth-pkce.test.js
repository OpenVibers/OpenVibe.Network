'use strict';
// OAuth authorization-code flow with PKCE (RFC 7636, S256 only) and single-use codes.
//   node test/oauth-pkce.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-pkce-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'viewer', 'x')").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h', refreshTokenExpiry: '30d' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
const server = http.createServer(app);

const REDIRECT = 'https://openvibe.live/api/auth/callback';
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const userToken = jwt.sign({ sub: 7, id: 7, username: 'viewer' }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '5m' });

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(async r => ({ status: r.status, body: await r.json() }));
    const confirm = (extra = {}) => post('/oauth/confirm', { token: userToken, client_id: 'live', redirect_uri: REDIRECT, state: 'a b&c', ...extra });
    const codeOf = (redirect) => new URL(redirect).searchParams.get('code');
    const exchange = (code, extra = {}) => post('/oauth/token', { grant_type: 'authorization_code', client_id: 'live', client_secret: 'live-secret', code, redirect_uri: REDIRECT, ...extra });

    // authorize forwards the challenge to the account chooser; plain and malformed challenges are refused
    let r = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: 'live', redirect_uri: REDIRECT, response_type: 'code', state: 's', code_challenge: challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    const login = new URL(r.headers.get('location'));
    assert.strictEqual(login.searchParams.get('code_challenge'), challenge);
    assert.strictEqual(login.searchParams.get('code_challenge_method'), 'S256');
    r = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: 'live', redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'plain' })}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 400, 'plain PKCE is refused');
    r = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: 'live', redirect_uri: REDIRECT, response_type: 'code', code_challenge: 'short', code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 400, 'malformed challenge is refused');

    // state is URL-encoded in the redirect
    let c = await confirm({ code_challenge: challenge, code_challenge_method: 'S256' });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(new URL(c.body.redirect).searchParams.get('state'), 'a b&c');

    // a PKCE-bound code needs the verifier; a wrong verifier burns the code
    let t = await exchange(codeOf(c.body.redirect));
    assert.strictEqual(t.status, 400); assert.match(t.body.error_description, /PKCE/);
    t = await exchange(codeOf(c.body.redirect), { code_verifier: verifier });
    assert.strictEqual(t.status, 400, 'a failed verification burns the code');

    c = await confirm({ code_challenge: challenge, code_challenge_method: 'S256' });
    t = await exchange(codeOf(c.body.redirect), { code_verifier: crypto.randomBytes(32).toString('base64url') });
    assert.strictEqual(t.status, 400, 'wrong verifier');

    c = await confirm({ code_challenge: challenge, code_challenge_method: 'S256' });
    const code = codeOf(c.body.redirect);
    t = await exchange(code, { code_verifier: verifier });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.ok(t.body.access_token);
    t = await exchange(code, { code_verifier: verifier });
    assert.strictEqual(t.status, 400, 'codes are single-use');

    // clients that do not send PKCE keep working (confidential clients with a secret)
    c = await confirm();
    t = await exchange(codeOf(c.body.redirect));
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));

    // concurrent redemption of one code: exactly one wins
    c = await confirm({ code_challenge: challenge, code_challenge_method: 'S256' });
    const racing = await Promise.all([1, 2, 3].map(() => exchange(codeOf(c.body.redirect), { code_verifier: verifier })));
    assert.strictEqual(racing.filter(x => x.status === 200).length, 1);

    // discovery advertises S256
    const disc = await fetch(`${base}/oauth/.well-known/openid-configuration`).then(x => x.json());
    assert.deepStrictEqual(disc.code_challenge_methods_supported, ['S256']);

    console.log('oauth pkce: all checks passed');
    server.close();
})().catch(err => { console.error(err); process.exit(1); });
