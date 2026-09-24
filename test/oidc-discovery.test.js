'use strict';
// OpenID Connect discovery at the issuer (roadmap §4.1, §15.4): <issuer>/.well-known/openid-configuration
// answers with correct metadata (and so do RFC 8414's /.well-known/oauth-authorization-server and the older
// /oauth/.well-known/openid-configuration), and what it advertises is true: scope openid adds an id_token
// (RS256, kid from the JWKS, aud = client, the authorize nonce echoed), and /oauth/userinfo answers with
// the same sub for the access token.
//   node test/oidc-discovery.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { bootServer } = require('./helpers/boot-server');
const { initDb } = require('../server/db/database');

const REQUIRED = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri', 'response_types_supported', 'subject_types_supported', 'id_token_signing_alg_values_supported'];

(async () => {
    // ── The real server: discovery at the issuer's root ──
    const ISSUER = 'https://openvibe.network';
    const srv = await bootServer({ env: { OV_NETWORK_URL: ISSUER, BASE_URL: ISSUER } });
    try {
        const get = (p) => fetch(srv.base + p).then(async r => ({ status: r.status, type: r.headers.get('content-type') || '', body: await r.json().catch(() => null) }));
        const root = await get('/.well-known/openid-configuration');
        assert.strictEqual(root.status, 200, 'discovery answers at the issuer root');
        assert.ok(root.type.includes('application/json'), 'as JSON');
        for (const k of REQUIRED) assert.ok(root.body[k], `metadata has ${k}`);
        assert.strictEqual(root.body.issuer, ISSUER, 'issuer is exactly the URL the document is served under');
        assert.strictEqual(root.body.authorization_endpoint, `${ISSUER}/oauth/authorize`);
        assert.strictEqual(root.body.token_endpoint, `${ISSUER}/oauth/token`);
        assert.strictEqual(root.body.userinfo_endpoint, `${ISSUER}/oauth/userinfo`);
        assert.strictEqual(root.body.jwks_uri, `${ISSUER}/api/.well-known/jwks`);
        assert.deepStrictEqual(root.body.response_types_supported, ['code']);
        assert.deepStrictEqual(root.body.code_challenge_methods_supported, ['S256']);
        assert.ok(root.body.scopes_supported.includes('openid'));
        assert.ok(root.body.grant_types_supported.includes('authorization_code') && root.body.grant_types_supported.includes('refresh_token'));
        assert.deepStrictEqual(root.body.id_token_signing_alg_values_supported, ['RS256']);
        // The same document at RFC 8414's name and at the older path.
        for (const p of ['/.well-known/oauth-authorization-server', '/oauth/.well-known/openid-configuration']) {
            const r = await get(p);
            assert.strictEqual(r.status, 200, `${p} answers`);
            assert.deepStrictEqual(r.body, root.body, `${p} is the same document`);
        }
        // Every endpoint it names is served here (paths relative to this server).
        for (const k of ['jwks_uri', 'authorization_endpoint', 'userinfo_endpoint']) {
            const r = await fetch(srv.base + new URL(root.body[k]).pathname, { redirect: 'manual' });
            assert.notStrictEqual(r.status, 404, `${k} is served (got ${r.status})`);
        }
        // The platform descriptor points at the standard location.
        assert.strictEqual((await get('/.well-known/openvibe')).body.openid_configuration, `${ISSUER}/.well-known/openid-configuration`);
    } catch (err) { console.error(srv.logs()); throw err; } finally { await srv.stop(); }

    // ── What it advertises is true: id_token and userinfo ──
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-oidc-'));
    const log = console.log; console.log = () => {};
    const db = initDb(path.join(dir, 'network.db'));
    console.log = log;
    db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
    db.prepare("INSERT INTO users (id, username, password_hash, display_name) VALUES (7, 'viewer', 'x', 'Viewer')").run();
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.locals.db = db;
    app.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h', refreshTokenExpiry: '30d' } };
    app.locals.privateKey = keys.privateKey;
    app.locals.publicKey = keys.publicKey;
    app.use('/oauth', require('../server/auth/oauth-routes'));
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const REDIRECT = 'https://openvibe.live/api/auth/callback';
    const userToken = jwt.sign({ sub: 7, id: 7, username: 'viewer' }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '5m' });
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
    const codeOf = (redirect) => new URL(redirect).searchParams.get('code');
    const exchange = (code) => post('/oauth/token', { grant_type: 'authorization_code', client_id: 'live', client_secret: 'live-secret', code, redirect_uri: REDIRECT });

    // authorize carries the nonce to the account chooser; a malformed one is refused
    let r = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: 'live', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid profile', state: 's', nonce: 'n-0S6_WzA2Mj' })}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(new URL(r.headers.get('location')).searchParams.get('nonce'), 'n-0S6_WzA2Mj', 'the nonce reaches the account chooser');
    r = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: 'live', redirect_uri: REDIRECT, response_type: 'code', nonce: 'x'.repeat(300) })}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 400, 'an oversized nonce is refused');

    // scope openid: an id_token for this client, signed with the JWKS key, nonce echoed
    let c = await post('/oauth/confirm', { token: userToken, client_id: 'live', redirect_uri: REDIRECT, scope: 'openid profile', state: 's', nonce: 'n-0S6_WzA2Mj' });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    let t = await exchange(codeOf(c.body.redirect));
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.ok(t.body.id_token, 'scope openid returns an id_token');
    const header = JSON.parse(Buffer.from(t.body.id_token.split('.')[0], 'base64url').toString());
    assert.strictEqual(header.alg, 'RS256');
    assert.strictEqual(header.kid, 'ov-network-1', 'the kid /api/.well-known/jwks publishes');
    const id = jwt.verify(t.body.id_token, keys.publicKey, { algorithms: ['RS256'], issuer: ISSUER, audience: 'live' });
    assert.strictEqual(id.sub, '7', 'sub is the Network id as a string, as access tokens carry it');
    assert.strictEqual(id.nonce, 'n-0S6_WzA2Mj', 'the nonce is echoed');
    assert.strictEqual(id.preferred_username, 'viewer');
    assert.match(id.subject_id, /^usr_/, 'the canonical subject id');
    assert.ok(id.exp - id.iat <= 3600);

    // without openid: no id_token (the flow Live and the other sites use is unchanged)
    c = await post('/oauth/confirm', { token: userToken, client_id: 'live', redirect_uri: REDIRECT, scope: 'profile theme' });
    t = await exchange(codeOf(c.body.redirect));
    assert.strictEqual(t.status, 200);
    assert.strictEqual(t.body.id_token, undefined, 'no openid scope, no id_token');
    const access = t.body.access_token;

    // userinfo: the same sub for the access token; no token, a service-shaped token or garbage → 401
    let u = await fetch(`${base}/oauth/userinfo`, { headers: { authorization: `Bearer ${access}` } }).then(async x => ({ status: x.status, body: await x.json() }));
    assert.strictEqual(u.status, 200, JSON.stringify(u.body));
    assert.strictEqual(u.body.sub, '7');
    assert.strictEqual(u.body.preferred_username, 'viewer');
    assert.strictEqual(u.body.name, 'Viewer');
    assert.match(u.body.subject_id, /^usr_/);
    u = await fetch(`${base}/oauth/userinfo`, { method: 'POST', headers: { authorization: `Bearer ${access}` } });
    assert.strictEqual(u.status, 200, 'POST works too');
    u = await fetch(`${base}/oauth/userinfo`);
    assert.strictEqual(u.status, 401);
    assert.match(u.headers.get('www-authenticate'), /invalid_token/);
    u = await fetch(`${base}/oauth/userinfo`, { headers: { authorization: 'Bearer nope' } });
    assert.strictEqual(u.status, 401);
    const expired = jwt.sign({ sub: 7, id: 7, username: 'viewer', iat: Math.floor(Date.now() / 1000) - 7200 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
    u = await fetch(`${base}/oauth/userinfo`, { headers: { authorization: `Bearer ${expired}` } });
    assert.strictEqual(u.status, 401, 'an expired access token is refused');

    server.close();
    console.log('oidc discovery: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
