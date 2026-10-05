'use strict';
// The backend of the third-party OAuth consent screen (plan T2; docs/t2-projects-and-grants.md §9).
// GET /oauth/client-info carries the requested capability ids with their catalog metadata (sensitive
// marked) and refuses the rest; an authorization code carries an explicit consented set (an absent or
// empty scope = nothing), and the token exchange can only narrow it, never widen it.
//   node test/consent-screen.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { serviceAuth } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-consent-'));
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (1, 'owner', 'x', 'user'), (2, 'ops', 'x', 'admin')`).run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = {
    baseUrl: ISSUER, loginUrl: ISSUER,
    jwt: { issuer: ISSUER, accessTokenExpiry: '1h' },
    // A staff-set allowance only: the sandbox default is switched off, so the grants below are the
    // whole story (test/developer-defaults.test.js covers the code default).
    developer: { sandboxAudiences: 'openvibe.media', sandboxAllowance: '', credentialOverlapS: 60 },
};
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);

const userToken = (id) => jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const T = { owner: userToken(1), ops: userToken(2) };

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const h = { ...(who ? { authorization: `Bearer ${T[who]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, text, body: text ? JSON.parse(text) : null };
    };
    const token = (form) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
        .then(async r => ({ status: r.status, body: await r.json() }));
    const verify = (t) => serviceAuth.verifyServiceToken(t, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.media', acceptSandbox: true });

    // ── A sandbox project with two approved, app-grantable capabilities ──
    let r = await api('owner', 'POST', '', { name: 'Consent Demo' });
    assert.strictEqual(r.status, 201, r.text);
    const P = r.body.id;
    r = await api('ops', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.delete', 'media.object.read'] });
    assert.strictEqual(r.status, 200, r.text);
    const REDIRECT = 'https://dev.example.com/cb';
    r = await api('owner', 'POST', `/${P}/apps`, { name: 'Consent Demo App', environment: 'sandbox', type: 'public', redirect_uris: [REDIRECT] });
    assert.strictEqual(r.status, 201, r.text);
    const A = r.body.id;
    for (const cap of ['media.object.delete', 'media.object.read']) {
        r = await api('owner', 'POST', `/${P}/apps/${A}/grants`, { capability: cap });
        assert.strictEqual(r.body.status, 'approved', `${cap}: ${r.text}`);
    }

    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const info = (q) => fetch(`${base}/oauth/client-info?${new URLSearchParams({ client_id: A, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', ...q })}`)
        .then(async x => ({ status: x.status, body: await x.json() }));
    const confirm = (scope) => fetch(`${base}/oauth/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: T.owner, client_id: A, redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256', ...(scope === undefined ? {} : { scope }) }) })
        .then(async x => ({ status: x.status, body: await x.json() }));
    const exchange = (code, extra = {}) => token({ grant_type: 'authorization_code', client_id: A, code, redirect_uri: REDIRECT, audience: 'openvibe.media', code_verifier: verifier, ...extra });
    const codeFor = async (scope) => new URL((await confirm(scope)).body.redirect).searchParams.get('code');

    // ── client-info names the capability ids the app asks for; a scope-less call gets none ──
    let ci = await info({});
    assert.strictEqual(ci.status, 200, JSON.stringify(ci.body));
    assert.deepStrictEqual(ci.body.capabilities, []);
    assert.deepStrictEqual(ci.body.refused, []);
    assert.strictEqual(ci.body.client_secret, undefined, 'nothing about the app\'s secret');

    ci = await info({ scope: 'media.object.delete media.object.read nope.not.real network.coins.credit media.object.delete' });
    assert.strictEqual(ci.status, 200);
    assert.deepStrictEqual(ci.body.capabilities.map(c => c.id), ['media.object.delete', 'media.object.read'], 'app-grantable ids, in the order requested, deduped');
    const del = ci.body.capabilities.find(c => c.id === 'media.object.delete');
    assert.strictEqual(del.sensitive, true, 'the sensitive capability is marked');
    assert.strictEqual(del.name, 'media.object.delete');
    assert.match(del.description, /Delete an object/);
    const read = ci.body.capabilities.find(c => c.id === 'media.object.read');
    assert.strictEqual(read.sensitive, false);
    assert.deepStrictEqual(ci.body.refused, ['nope.not.real', 'network.coins.credit'], 'unknown/ungrantable ids the screen must not name');

    // ── A scope-less authorize consents to nothing: no code can obtain media.object.delete ──
    let code = await codeFor(undefined);
    let t = await exchange(code);
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    let v = verify(t.body.access_token);
    assert.strictEqual(v.ok, true, v.reason);
    assert.deepStrictEqual(v.claims.cap, [], 'an absent scope consents to nothing');
    assert.ok(v.claims.on_behalf_of, 'the person is still identified');
    assert.strictEqual(v.claims.project_id, P);
    assert.strictEqual(t.body.scope, '');
    assert.strictEqual(t.body.refresh_token, undefined, 'app tokens have no refresh token to widen with');

    // The same code, asking for a capability at the token endpoint, is refused.
    code = await codeFor(undefined);
    t = await exchange(code, { scope: 'media.object.delete' });
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'invalid_scope');

    // An empty scope string is the same as absent.
    code = await codeFor('');
    t = await exchange(code);
    assert.strictEqual(t.status, 200); assert.deepStrictEqual(verify(t.body.access_token).claims.cap, []);

    // A refresh_token request never widens: apps do not support the grant at all.
    t = await token({ grant_type: 'refresh_token', client_id: A, refresh_token: 'x'.repeat(96) });
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'unsupported_grant_type');

    // ── A scope-bearing authorize consents to exactly the named grantable ids ──
    code = await codeFor('media.object.read media.object.delete nope.not.real');
    t = await exchange(code);
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    v = verify(t.body.access_token);
    assert.deepStrictEqual(v.claims.cap.slice().sort(), ['media.object.delete', 'media.object.read'], 'the named grantable ids only');
    assert.deepStrictEqual(t.body.scope.split(' ').sort(), ['media.object.delete', 'media.object.read'], 'exactly the consented ids');

    // The exchange narrows, never widens.
    code = await codeFor('media.object.read');
    t = await exchange(code, { scope: 'media.object.read media.object.delete' });
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'invalid_scope');

    code = await codeFor('media.object.read media.object.delete');
    t = await exchange(code, { scope: 'media.object.read' });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.deepStrictEqual(verify(t.body.access_token).claims.cap, ['media.object.read'], 'narrowed to the asked subset');

    console.log('consent screen: all checks passed');
    server.close();
})().catch(err => { console.error(err); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
