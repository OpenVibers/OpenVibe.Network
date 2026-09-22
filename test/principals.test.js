'use strict';
// Service principals (server/identity/principals.js): client_credentials tokens, capability guards on
// /internal routes, the legacy-key compatibility path and the usage audit. Roadmap Wave 1, ADR-003.
//   node test/principals.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { serviceAuth, validate } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-principals-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;

db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
db.prepare("UPDATE oauth_clients SET client_secret = 'media-secret' WHERE client_id = 'media'").run();
db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'payee', 'x'), (8, 'payer', 'x')").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { internalKey: 'legacy-key', jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal', require('../server/internal/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = (form) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', ...form }) })
        .then(async r => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }));
    const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
        .then(async r => ({ status: r.status, type: r.headers.get('content-type') || '', body: await r.json() }));
    const credit = (extra = {}) => ({ user_id: 7, app_id: 'live', amount: 5, reason: 'test', idempotency_key: `k-${crypto.randomBytes(4).toString('hex')}`, ...extra });

    // ── Issuing ──
    let t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.strictEqual(t.cache, 'no-store');
    const claims = serviceAuth.verifyServiceToken(t.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.network' });
    assert.ok(claims.ok, claims.reason);
    assert.strictEqual(claims.claims.sub, 'svc:live');
    assert.deepStrictEqual(claims.claims.cap, ['identity.subject.resolve', 'network.coins.credit', 'network.coins.debit', 'network.coins.transfer', 'network.modules.read', 'network.modules.write', 'network.notifications.push']);
    assert.ok(validate('identity.service-token-claims@1', claims.claims).valid);
    assert.ok(claims.claims.exp - claims.claims.iat <= 300, 'short-lived');
    const full = t.body.access_token;

    t = await token({ client_id: 'live', client_secret: 'wrong', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 401); assert.strictEqual(t.body.error, 'invalid_client');
    t = await token({ client_id: 'live', client_secret: 'live-secret' });
    assert.strictEqual(t.status, 400, 'audience required');
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network', scope: 'network.coins.credit' });
    assert.strictEqual(t.status, 200); assert.strictEqual(t.body.scope, 'network.coins.credit', 'scope narrows the token');
    const creditOnly = t.body.access_token;
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network', scope: 'network.coins.credit network.coins.mint' });
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'invalid_scope', 'asking for an ungranted capability fails');
    t = await token({ client_id: 'media', client_secret: 'media-secret', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'invalid_scope', 'a client with no grants gets no token');
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.media' });
    assert.strictEqual(t.status, 400, 'no grants for that audience');

    // ── Guarded routes ──
    let r = await post('/internal/coins/credit', credit(), { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.balance, 5);
    r = await post('/internal/coins/credit', credit({ app_id: 'games' }), { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'capability.owner_denied', 'a token acts only for its own app');
    assert.ok(r.type.startsWith('application/problem+json'));
    r = await post('/internal/coins/debit', credit({ amount: 1 }), { authorization: `Bearer ${creditOnly}` });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'capability.denied', 'narrowed token cannot debit');
    r = await post('/internal/coins/transfer', { from_user_id: 7, to_user_id: 8, app_id: 'live', amount: 2, reason: 't', idempotency_key: 'tr-1' }, { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await post('/internal/coins/credit', credit(), { authorization: 'Bearer not-a-jwt' });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'token.malformed');
    r = await post('/internal/coins/credit', credit(), { authorization: 'Bearer not-a-jwt', 'x-internal-key': 'legacy-key' });
    assert.strictEqual(r.status, 401, 'a bad token is not rescued by the legacy key');
    const forged = serviceAuth.signServiceToken({ ...claims.claims, jti: 'tok_forged000' }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
    r = await post('/internal/coins/credit', credit(), { authorization: `Bearer ${forged}` });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'token.bad_signature');
    const expired = serviceAuth.signServiceToken({ ...claims.claims, iat: 1000, exp: 1300 }, keys.privateKey);
    r = await post('/internal/coins/credit', credit(), { authorization: `Bearer ${expired}` });
    assert.strictEqual(r.body.code, 'token.expired');
    const wrongAud = serviceAuth.signServiceToken({ ...claims.claims, aud: ['openvibe.media'] }, keys.privateKey);
    r = await post('/internal/coins/credit', credit(), { authorization: `Bearer ${wrongAud}` });
    assert.strictEqual(r.body.code, 'token.wrong_audience');
    r = await post('/internal/notifications/push', { user_id: 7, service: 'games', title: 'x' }, { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 403, 'notifications are sent only as the principal\'s own service');
    r = await fetch(`${base}/internal/coins/stats`, { headers: { authorization: `Bearer ${full}` } }).then(x => ({ status: x.status }));
    assert.strictEqual(r.status, 403, 'unguarded internal routes still need the key');
    r = await post('/internal/identity/legacy-map', { entries: [] }, { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 403, 'token routes are an explicit list');

    // Community resolves authors with its own token; Live's token lacks that grant.
    db.prepare("UPDATE oauth_clients SET client_secret = 'community-secret' WHERE client_id = 'community'").run();
    const com = await token({ client_id: 'community', client_secret: 'community-secret', audience: 'openvibe.network' });
    assert.strictEqual(com.status, 200, JSON.stringify(com.body));
    assert.deepStrictEqual(com.body.scope.split(' '), ['identity.subject.resolve']);
    r = await post('/internal/identity/resolve-batch', { system: 'network', ids: ['7'] }, { authorization: `Bearer ${com.body.access_token}` });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.results['7'].username, 'payee');
    r = await post('/internal/identity/resolve-batch', { system: 'network', ids: ['7'] }, { authorization: `Bearer ${creditOnly}` });
    assert.strictEqual(r.status, 403, 'a token narrowed to coins cannot resolve identities');
    const media = await token({ client_id: 'community', client_secret: 'community-secret', audience: 'openvibe.media' });
    assert.strictEqual(media.body.scope, 'media.object.upload', 'community may upload screenshot bytes to Media');
    const cm = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.community' });
    assert.deepStrictEqual(cm.body.scope.split(' '), ['community.paste.create', 'community.paste.moderate', 'community.paste.write']);

    // ── Legacy key keeps working ──
    r = await post('/internal/coins/credit', credit(), { 'x-internal-key': 'legacy-key' });
    assert.strictEqual(r.status, 200);
    r = await post('/internal/coins/credit', credit(), {});
    assert.strictEqual(r.status, 403);

    // ── Revocation: new tokens stop carrying a revoked grant ──
    db.prepare("UPDATE principal_grants SET revoked_at = CURRENT_TIMESTAMP WHERE client_id = 'live' AND capability = 'network.coins.debit'").run();
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network' });
    assert.ok(!t.body.scope.split(' ').includes('network.coins.debit'));

    // ── Usage audit ──
    const usage = db.prepare('SELECT principal, route, auth, allowed, code, count FROM principal_usage ORDER BY principal, route, allowed').all();
    assert.ok(usage.some(u => u.principal === 'svc:live' && u.route === 'POST /internal/coins/credit' && u.allowed === 1 && u.count === 1));
    assert.ok(usage.some(u => u.principal === 'legacy-key' && u.auth === 'internal-key' && u.allowed === 1));
    assert.ok(usage.some(u => u.code === 'capability.denied' && u.allowed === 0));
    assert.ok(usage.some(u => u.code === 'capability.owner_denied' && u.allowed === 0), 'ownership denials are audited as denials');
    assert.ok(usage.some(u => u.code === 'token.bad_signature'));

    server.close(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('principals: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
