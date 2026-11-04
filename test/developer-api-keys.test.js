'use strict';
// Developer API keys and per-project budgets (plan G-P3, server/developer/api-keys.js):
//   - a key is shown once, and only sha256(secret) is stored;
//   - a revoked key is refused at once (the exchange says so immediately);
//   - the scope is enforced: a key may only be exchanged for an audience its scopes cover, and the
//     token carries the capability of the scope (ai.inference -> ai.inference.create, D8);
//   - the per-project monthly budget is an integer number of nano-USD (D1), read and written;
//   - the key never reaches a log, an audit row or an error message (every log line is captured here);
//   - everything is off unless NETWORK_DEV_API_KEYS=1.
//   node test/developer-api-keys.test.js
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
const subjects = require('../server/identity/subjects');
const apiKeys = require('../server/developer/api-keys');

(async () => {
const logged = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logged.push(a.map(String).join(' ')); };
const out = (...a) => orig.log(...a);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-apikeys-'));
const db = getDb();
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (10, 'owner', 'x', 'user'), (11, 'dev', 'x', 'user'), (12, 'viewer', 'x', 'user'), (13, 'stranger', 'x', 'user'),
    (14, 'staff', 'x', 'admin')`).run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'ai-secret' WHERE client_id = 'ai'").run();
const sid = async (id) => await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = {
    baseUrl: ISSUER, loginUrl: ISSUER,
    jwt: { issuer: ISSUER, accessTokenExpiry: '1h' },
    // The feature is on here; the flag-off case is proved below with a second app.
    developer: { sandboxAudiences: 'openvibe.ai', sandboxAllowance: '', credentialOverlapS: 60, apiKeys: true },
};
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal', require('../server/internal/routes'));
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);

const userToken = (id) => jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const T = { owner: userToken(10), dev: userToken(11), viewer: userToken(12), stranger: userToken(13), staff: userToken(14) };
const secretsSeen = [];

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const h = { ...(who ? { authorization: `Bearer ${T[who]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('content-type') || '', text, body: text ? JSON.parse(text) : null };
    };
    const serviceToken = async (id, secret) => (await (await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network' }),
    })).json()).access_token;
    const exchange = async (apiKey, audience, token) => {
        const r = await fetch(`${base}/internal/api-keys/exchange`, {
            method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ api_key: apiKey, audience }),
        });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('content-type') || '', text, body: text ? JSON.parse(text) : null };
    };
    const readBudget = async (id, token) => {
        const r = await fetch(`${base}/internal/projects/${encodeURIComponent(id)}/budget`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        const text = await r.text();
        return { status: r.status, cache: r.headers.get('cache-control'), text, body: text ? JSON.parse(text) : null };
    };
    try {
        // ── A project, a sandbox app and a live app ──
        let r = await api('owner', 'POST', '', { name: 'Keys' });
        assert.strictEqual(r.status, 201, r.text);
        const P = r.body.id;
        r = await api('owner', 'POST', `/${P}/members`, { username: 'dev', role: 'developer' });
        assert.strictEqual(r.status, 201, r.text);
        r = await api('owner', 'POST', `/${P}/members`, { username: 'viewer', role: 'viewer' });
        assert.strictEqual(r.status, 201, r.text);
        r = await api('owner', 'POST', `/${P}/apps`, { name: 'Test app', environment: 'sandbox', type: 'confidential' });
        assert.strictEqual(r.status, 201, r.text);
        const TEST_APP = r.body.id;
        // Production needs a staff-set environment policy.
        r = await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' });
        assert.strictEqual(r.status, 200, r.text);
        r = await api('owner', 'POST', `/${P}/apps`, { name: 'Live app', environment: 'production', type: 'confidential' });
        assert.strictEqual(r.status, 201, r.text);
        const LIVE_APP = r.body.id;
        // The apps hold the D8 capability (ai.inference.create, public and active in contracts 0.284.0):
        // staff set the project's allowance, then the grant is requested and approved.
        r = await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['ai.inference.create'] });
        assert.strictEqual(r.status, 200, r.text);
        for (const appId of [TEST_APP, LIVE_APP]) {
            r = await api('owner', 'POST', `/${P}/apps/${appId}/grants`, { capability: 'ai.inference.create' });
            assert.strictEqual(r.status, 201, r.text);
            r = await api('owner', 'POST', `/${P}/apps/${appId}/grants/ai.inference.create/approve`);
            assert.strictEqual(r.status, 200, r.text);
        }

        // ── The key is shown once, and only its hash is stored ──
        r = await api('owner', 'POST', `/${P}/api-keys`, { name: 'CI key', app_id: TEST_APP, scopes: ['ai.inference'], environment: 'test' });
        assert.strictEqual(r.status, 201, r.text);
        const KEY = r.body;
        assert.match(KEY.id, /^key_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.match(KEY.api_key, /^ovk_[A-Za-z0-9_-]{40,}$/, 'the secret is an ovk_ key');
        assert.strictEqual(KEY.shown_once, true);
        assert.strictEqual(KEY.environment, 'test');
        assert.deepStrictEqual(KEY.scopes, ['ai.inference']);
        assert.strictEqual(KEY.hint, KEY.api_key.slice(-4), 'the hint is the last four characters');
        secretsSeen.push(KEY.api_key);
        const row = await db.prepare('SELECT * FROM dev_api_keys WHERE id = ?').get(KEY.id);
        assert.ok(row, 'the key has a row');
        assert.strictEqual(row.key_hash, crypto.createHash('sha256').update(KEY.api_key).digest('hex'), 'only sha256(secret) is stored');
        assert.ok(!JSON.stringify(row).includes(KEY.api_key), 'the secret is nowhere in the row');
        assert.ok(!KEY.api_key.includes(row.key_hash) && !row.key_hash.includes(KEY.api_key), 'the secret is not the hash');
        assert.ok(row.key_hash.length === 64, 'a sha256 hex digest');

        // It is never shown again: the list carries metadata only.
        r = await api('owner', 'GET', `/${P}/api-keys`);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.keys.length, 1);
        assert.ok(!r.text.includes(KEY.api_key), 'the secret is not in the list');
        assert.strictEqual(r.body.keys[0].hint, KEY.hint);
        assert.strictEqual(r.body.keys[0].status, 'active');

        // ── The scope is enforced and the token carries the capability (D8: ai.inference.create) ──
        const aiToken = await serviceToken('ai', 'ai-secret');
        assert.ok(aiToken, 'AI holds a service token for openvibe.network');
        let x = await exchange(KEY.api_key, 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 200, x.text);
        assert.strictEqual(x.body.project_id, P);
        assert.strictEqual(x.body.app_id, TEST_APP);
        assert.strictEqual(x.body.subject, `app:${TEST_APP}`);
        assert.strictEqual(x.body.environment, 'test');
        assert.strictEqual(x.body.token_env, 'sandbox', 'a test key is a sandbox token');
        assert.deepStrictEqual(x.body.scopes, ['ai.inference']);
        assert.deepStrictEqual(x.body.capability, ['ai.inference.create'], 'the scope maps to the D8 capability');
        assert.strictEqual(x.body.expires_in, 300);
        const claims = serviceAuth.verifyServiceToken(x.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.ai', acceptSandbox: true });
        assert.ok(claims.ok, 'the exchanged token verifies like an app token');
        assert.strictEqual(claims.claims.sub, `app:${TEST_APP}`);
        assert.deepStrictEqual(claims.claims.cap, ['ai.inference.create']);
        assert.strictEqual(claims.claims.project_id, P);
        assert.strictEqual(claims.claims.env, 'sandbox');

        // A scope the key does not hold: the audience is refused, by Network.
        x = await exchange(KEY.api_key, 'openvibe.media', aiToken);
        assert.strictEqual(x.status, 403, x.text);
        assert.strictEqual(x.body.code, 'api_key.scope_denied');

        // The exchange needs a service token: no token, no key.
        x = await exchange(KEY.api_key, 'openvibe.ai', null);
        assert.strictEqual(x.status, 401, x.text);
        assert.strictEqual(x.body.code, 'token.missing');

        // ── The budget: an integer number of nano-USD (D1), read and written ──
        r = await api('owner', 'GET', `/${P}/budget`);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.monthly_budget_nano_usd, null, 'no budget yet');
        assert.strictEqual(r.body.currency, 'nano_usd');
        r = await api('owner', 'PUT', `/${P}/budget`, { monthly_budget_nano_usd: '5000000000' });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.monthly_budget_nano_usd, '5000000000', 'the budget is a nano-USD string');
        r = await api('owner', 'GET', `/${P}/budget`);
        assert.strictEqual(r.body.monthly_budget_nano_usd, '5000000000');
        // A float or a fraction is refused: money is an integer number of nano-USD.
        r = await api('owner', 'PUT', `/${P}/budget`, { monthly_budget_nano_usd: '1.5' });
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.body.code, 'budget.invalid');
        r = await api('owner', 'PUT', `/${P}/budget`, { monthly_budget_nano_usd: '-1' });
        assert.strictEqual(r.status, 422);
        // A viewer does not read or write the budget; a developer neither.
        r = await api('viewer', 'GET', `/${P}/budget`);
        assert.strictEqual(r.status, 403, r.text);
        r = await api('dev', 'PUT', `/${P}/budget`, { monthly_budget_nano_usd: '1' });
        assert.strictEqual(r.status, 403);
        // AI reads it with its service token.
        let b = await readBudget(P, aiToken);
        assert.strictEqual(b.status, 200, b.text);
        assert.strictEqual(b.body.monthly_budget_nano_usd, '5000000000');
        assert.strictEqual(b.body.currency, 'nano_usd');
        assert.strictEqual(b.cache, 'no-store', 'the budget is never cached');
        b = await readBudget(P, null);
        assert.strictEqual(b.status, 401);
        b = await readBudget('prj_00000000000000000000000000', aiToken);
        assert.strictEqual(b.status, 404);

        // ── Rotate: the same key id, a new secret, shown once; the old one stops working ──
        r = await api('owner', 'POST', `/${P}/api-keys/${KEY.id}/rotate`, {});
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.id, KEY.id, 'the key keeps its id');
        assert.strictEqual(r.body.shown_once, true);
        const ROTATED = r.body.api_key;
        secretsSeen.push(ROTATED);
        assert.notStrictEqual(ROTATED, KEY.api_key);
        x = await exchange(ROTATED, 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 200, x.text);
        x = await exchange(KEY.api_key, 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 401, 'the old secret fails at once');
        assert.strictEqual(x.body.code, 'api_key.invalid');

        // ── Revoke: refused at once ──
        r = await api('owner', 'POST', `/${P}/api-keys/${KEY.id}/revoke`, {});
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.status, 'revoked');
        x = await exchange(ROTATED, 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 401, 'a revoked key is refused at once');
        assert.strictEqual(x.body.code, 'api_key.invalid');
        r = await api('owner', 'GET', `/${P}/api-keys`);
        assert.strictEqual(r.body.keys[0].status, 'revoked');

        // ── The audit: ids and scopes, never a secret ──
        const audit = await db.prepare('SELECT * FROM dev_audit WHERE project_id = ? ORDER BY id').all(P);
        const actions = audit.map(a => a.action);
        assert.ok(actions.includes('api_key.created'), 'the creation is audited');
        assert.ok(actions.includes('api_key.rotated'), 'the rotation is audited');
        assert.ok(actions.includes('api_key.revoked'), 'the revocation is audited');
        assert.ok(actions.includes('api_key.exchanged'), 'the exchange is audited');
        assert.ok(actions.includes('project.budget_set'), 'the budget is audited');
        for (const a of audit) {
            assert.ok(!a.detail.includes('ovk_'), 'no audit row carries a key');
            for (const s of secretsSeen) assert.ok(!a.detail.includes(s), 'no audit row carries the secret');
        }

        // ── The key is never logged ──
        for (const s of secretsSeen) {
            assert.ok(!logged.join('\n').includes(s), 'the key is not in any log line');
            assert.ok(!logged.join('\n').includes('ovk_'), 'no log line carries an ovk_ key');
        }
        // And not in an error message either.
        x = await exchange('ovk_' + 'A'.repeat(43), 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 401);
        assert.ok(!x.text.includes('ovk_'), 'the error answer carries no key');

        // ── Roles: a developer mints a test key, an admin a live one ──
        r = await api('dev', 'POST', `/${P}/api-keys`, { name: 'Dev key', app_id: TEST_APP, scopes: ['ai.inference'], environment: 'test' });
        assert.strictEqual(r.status, 201, r.text);
        const DEV_KEY = r.body.api_key;
        secretsSeen.push(DEV_KEY);
        r = await api('dev', 'POST', `/${P}/api-keys`, { name: 'Live key', app_id: LIVE_APP, scopes: ['ai.inference'], environment: 'live' });
        assert.strictEqual(r.status, 403, 'a developer may not mint a live key');
        r = await api('owner', 'POST', `/${P}/api-keys`, { name: 'Live key', app_id: LIVE_APP, scopes: ['ai.inference'], environment: 'live' });
        assert.strictEqual(r.status, 201, r.text);
        const LIVE_KEY = r.body.api_key;
        secretsSeen.push(LIVE_KEY);
        x = await exchange(LIVE_KEY, 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 200, x.text);
        assert.strictEqual(x.body.token_env, 'production', 'a live key is a production token');
        const liveClaims = serviceAuth.verifyServiceToken(x.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.ai' });
        assert.ok(liveClaims.ok, 'a production token needs no sandbox opt-in');
        assert.strictEqual(liveClaims.claims.env, 'production');
        // A test key belongs to a sandbox app and a live key to a production one.
        r = await api('owner', 'POST', `/${P}/api-keys`, { name: 'Mismatch', app_id: LIVE_APP, scopes: ['ai.inference'], environment: 'test' });
        assert.strictEqual(r.status, 422, r.text);
        // A stranger sees nothing.
        r = await api('stranger', 'GET', `/${P}/api-keys`);
        assert.strictEqual(r.status, 404, r.text);
        // An unknown scope is refused.
        r = await api('owner', 'POST', `/${P}/api-keys`, { name: 'Bad scope', app_id: TEST_APP, scopes: ['ai.everything'], environment: 'test' });
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.body.code, 'api_key.unknown_scope');

        // ── Revoking the app revokes its keys ──
        r = await api('owner', 'DELETE', `/${P}/apps/${TEST_APP}`);
        assert.strictEqual(r.status, 200, r.text);
        x = await exchange(DEV_KEY, 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 401, 'a revoked app takes its keys with it');

        // ── The scope is narrowed by the app's grants ──
        // The installed release knows ai.inference.create, so the app must hold it as an approved grant.
        r = await api('owner', 'POST', `/${P}/api-keys`, { name: 'Narrowed', app_id: LIVE_APP, scopes: ['ai.inference'], environment: 'live' });
        assert.strictEqual(r.status, 201, r.text);
        const NARROWED = r.body.api_key;
        secretsSeen.push(NARROWED);
        x = await exchange(NARROWED, 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 200, x.text);
        assert.deepStrictEqual(x.body.capability, ['ai.inference.create']);
        // Revoking the grant takes the scope with it: the key may not be used any more.
        r = await api('owner', 'DELETE', `/${P}/apps/${LIVE_APP}/grants/ai.inference.create`);
        assert.strictEqual(r.status, 200, r.text);
        x = await exchange(NARROWED, 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 403, 'a key whose app lost the grant may not be used');
        assert.strictEqual(x.body.code, 'api_key.scope_denied');
        // With the grant approved again, the same key works.
        r = await api('owner', 'POST', `/${P}/apps/${LIVE_APP}/grants`, { capability: 'ai.inference.create' });
        assert.strictEqual(r.status, 201, r.text);
        r = await api('owner', 'POST', `/${P}/apps/${LIVE_APP}/grants/ai.inference.create/approve`);
        assert.strictEqual(r.status, 200, r.text);
        x = await exchange(NARROWED, 'openvibe.ai', aiToken);
        assert.strictEqual(x.status, 200, x.text);
        assert.deepStrictEqual(x.body.capability, ['ai.inference.create']);

        // ── The flag: off by default ──
        // A second app with the feature off answers 503 on every new route.
        const offApp = express();
        offApp.use(express.json());
        offApp.locals.db = db;
        offApp.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { apiKeys: false } };
        offApp.locals.privateKey = keys.privateKey;
        offApp.locals.publicKey = keys.publicKey;
        offApp.use('/api/v1/projects', require('../server/developer/routes').router());
        const offServer = http.createServer(offApp);
        await new Promise(r => offServer.listen(0, '127.0.0.1', r));
        const offBase = `http://127.0.0.1:${offServer.address().port}`;
        let off = await fetch(`${offBase}/api/v1/projects/${P}/api-keys`, { headers: { authorization: `Bearer ${T.owner}` } });
        assert.strictEqual(off.status, 503, 'the key routes are off unless NETWORK_DEV_API_KEYS=1');
        const offBody = await off.json();
        assert.strictEqual(offBody.code, 'api_keys.disabled');
        off = await fetch(`${offBase}/api/v1/projects/${P}/budget`, { headers: { authorization: `Bearer ${T.owner}` } });
        assert.strictEqual(off.status, 503, 'the budget routes are off too');
        await new Promise(r => offServer.close(r));
        assert.throws(() => apiKeys.requireEnabled({ developer: { apiKeys: false } }), (e) => e.code === 'api_keys.disabled');
        assert.throws(() => apiKeys.requireEnabled({}), (e) => e.code === 'api_keys.disabled');
    } catch (err) {
        out('FAIL', err && err.stack ? err.stack : err);
        out(logged.slice(-40).join('\n'));
        process.exitCode = 1;
    } finally {
        server.close();
        for (const k of ['log', 'warn', 'error']) console[k] = orig[k];
    }
})();
})();
