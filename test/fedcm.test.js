'use strict';
// FedCM identity-provider endpoints and the jwt-bearer exchange rules.
//   node test/fedcm.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fedcm = require('../server/auth/fedcm');
const { clientOriginMatcher } = require('../server/auth/sso-owned');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', expiresIn: '1h' }, networkUrl: 'https://openvibe.network' };
const users = { 7: { id: 7, username: 'goosely', display_name: 'Goosely', email: 'g@example.net', avatar_url: '/data/avatars/7.png', is_banned: 0, token_valid_after: null } };
const db = { prepare: () => ({ get: (id) => users[id] || null }) };
const ctx = () => ({ db, publicKey, privateKey, config });
const session = jwt.sign({ sub: 7, id: 7, username: 'goosely' }, privateKey, { algorithm: 'RS256', issuer: config.jwt.issuer, expiresIn: '1h' });

// ── pure rules ───────────────────────────────────────────────
assert.strictEqual(fedcm.rpOrigin('https://yt.openvibe.tools'), 'https://yt.openvibe.tools');
assert.strictEqual(fedcm.rpOrigin('https://openvibe.xyz'), null);
assert.strictEqual(fedcm.rpOrigin('https://openvibe.tools/x'), null);
const tools = clientOriginMatcher({ client_id: 'tools', redirect_uris: '["https://openvibe.tools/auth/callback"]' });
assert.ok(tools('https://yt.openvibe.tools') && tools('https://openvibe.tools') && !tools('https://openvibe.live'), 'tools may exchange for any *.openvibe.tools origin only');
const live = clientOriginMatcher({ client_id: 'live', redirect_uris: '["https://openvibe.live/api/auth/callback"]' });
assert.ok(live('https://openvibe.live') && !live('https://openvibe.tools'));
const a = fedcm.accountOf(users[7], 'https://openvibe.network');
assert.deepStrictEqual(Object.keys(a).sort(), ['email', 'given_name', 'id', 'name', 'picture', 'username']);
assert.strictEqual(a.picture, 'https://openvibe.network/data/avatars/7.png');

// ── verifyAssertion: audience + single use ───────────────────
const tok = fedcm.signAssertion(users[7], 'https://openvibe.live', 'n1', ctx());
const decoded = fedcm.verifyAssertion(tok, ctx(), live);
assert.strictEqual(decoded.nonce, 'n1'); assert.strictEqual(decoded.typ, 'fedcm');
assert.throws(() => fedcm.verifyAssertion(tok, ctx(), live), /already used/, 'replay refused');
const tok2 = fedcm.signAssertion(users[7], 'https://openvibe.live', null, ctx());
assert.throws(() => fedcm.verifyAssertion(tok2, ctx(), tools), /audience/, 'a client cannot redeem another site\'s assertion');
assert.throws(() => fedcm.verifyAssertion(session, ctx(), live), /not a FedCM assertion/, 'an ordinary session JWT is not an assertion');

// ── HTTP contract ────────────────────────────────────────────
const app = express();
app.use(cookieParser());
app.get('/.well-known/web-identity', fedcm.wellKnown(ctx));
app.use('/fedcm', fedcm.createFedcmRoutes(ctx));
const server = http.createServer(app);
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, opts = {}) => fetch(base + path, opts).then(async r => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));

    let r = await call('/.well-known/web-identity');
    assert.deepStrictEqual(r.body, { provider_urls: ['https://openvibe.network/fedcm/config.json'] });
    r = await call('/fedcm/config.json');
    assert.strictEqual(r.body.accounts_endpoint, 'https://openvibe.network/fedcm/accounts');
    assert.strictEqual(r.body.id_assertion_endpoint, 'https://openvibe.network/fedcm/assertion');
    assert.strictEqual(r.body.login_url, 'https://openvibe.network/login');
    assert.ok(r.body.branding && r.body.branding.icons.length);

    r = await call('/fedcm/accounts', { headers: { cookie: `ov_sso=${session}` } });
    assert.strictEqual(r.status, 400, 'without Sec-Fetch-Dest: webidentity the request is refused (CSRF guard)');
    r = await call('/fedcm/accounts', { headers: { 'sec-fetch-dest': 'webidentity' } });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.headers.get('set-login'), 'logged-out');
    r = await call('/fedcm/accounts', { headers: { 'sec-fetch-dest': 'webidentity', cookie: `ov_sso=${session}` } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.accounts[0].id, '7'); assert.strictEqual(r.headers.get('set-login'), 'logged-in');

    const form = (o) => new URLSearchParams(o).toString();
    const post = (body, headers) => call('/fedcm/assertion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(body) });
    r = await post({ account_id: '7', client_id: 'https://openvibe.tools', nonce: 'abc' }, { 'sec-fetch-dest': 'webidentity', origin: 'https://openvibe.tools', cookie: `ov_sso=${session}` });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://openvibe.tools');
    assert.strictEqual(r.headers.get('access-control-allow-credentials'), 'true');
    const claims = jwt.verify(r.body.token, publicKey, { algorithms: ['RS256'], audience: 'https://openvibe.tools' });
    assert.strictEqual(claims.nonce, 'abc'); assert.strictEqual(claims.sub, 7);
    r = await post({ account_id: '7', client_id: 'https://openvibe.live', nonce: 'abc' }, { 'sec-fetch-dest': 'webidentity', origin: 'https://openvibe.tools', cookie: `ov_sso=${session}` });
    assert.strictEqual(r.status, 403, 'client_id must equal the requesting origin');
    r = await post({ account_id: '8', client_id: 'https://openvibe.tools' }, { 'sec-fetch-dest': 'webidentity', origin: 'https://openvibe.tools', cookie: `ov_sso=${session}` });
    assert.strictEqual(r.status, 403, 'account must be the signed-in one');
    r = await post({ account_id: '7', client_id: 'https://evil.example' }, { 'sec-fetch-dest': 'webidentity', origin: 'https://evil.example', cookie: `ov_sso=${session}` });
    assert.strictEqual(r.status, 400, 'foreign origins get nothing');
    r = await post({ account_id: '7', client_id: 'https://openvibe.tools' }, { 'sec-fetch-dest': 'webidentity', origin: 'https://openvibe.tools' });
    assert.strictEqual(r.status, 401, 'no session → access_denied');

    server.close();
    console.log('fedcm: all checks passed');
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
