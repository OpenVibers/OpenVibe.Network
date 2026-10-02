'use strict';
// Node tokens and self routes (plan T2, docs/t2-cells-and-node-principal.md sections 4.3 and 7, slice N4c): a paired
// machine's credential buys a node token; with it the machine changes its own capabilities and credential and nobody
// else's; rotation keeps the old credential 60 s; revoke kills both; topology shows when the machine was last seen.
//   node test/node-tokens.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { ids, validate, serviceAuth } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const nodePrincipals = require('../server/registry/node-principals');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare("UPDATE oauth_clients SET client_secret = 'bot-secret' WHERE client_id = 'bot'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'host-secret' WHERE client_id = 'host'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
// A service that holds network.node.self.manage anyway: it still manages no machine (403 capability.owner_denied).
await db.prepare("INSERT INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES ('host', 'network.node.self.manage', 'openvibe.network', '[]', 'test') ON CONFLICT DO NOTHING").run();

const alex = `usr_${ids.ulid()}`;
await db.prepare("INSERT INTO users (id, username, display_name, password_hash, subject_id) VALUES (9201, 'tokalex', 'Alex', 'x', ?)").run(alex);

const ISSUER = 'https://openvibe.network';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const app = express();
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
const pr = nodePrincipals.routers({ guard: principals.guard('network.node.manage') });
app.use('/api/v1/node-pairing', pr.pairing);
app.use('/internal', pr.internal);
app.use('/api/v1/node/self', principals.guard('network.node.self.manage'), nodePrincipals.selfRouter());
const cellRouters = require('../server/registry/cells').routers({ readGuard: principals.guard('network.registry.read') });
app.use('/internal/registry', cellRouters.internal);
const server = http.createServer(app);

// Everything written to stdout or stderr while the routes run, to prove no secret reaches a log line.
const logs = [];
const out = process.stdout.write.bind(process.stdout);
const err = process.stderr.write.bind(process.stderr);
process.stdout.write = (c, ...a) => { logs.push(String(c)); return out(c, ...a); };
process.stderr.write = (c, ...a) => { logs.push(String(c)); return err(c, ...a); };

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
// Every answer except the two that hand out a credential (redeem, rotation), to prove none of them carries one.
const answers = [];
const tokenCall = (id, secret, audience) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, ...(audience === undefined ? {} : { audience }) }) })
    .then(async (x) => { const text = await x.text(); answers.push(text); return { status: x.status, text, body: JSON.parse(text) }; });
const call = (method, p, body, headers = {}, { secret = false } = {}) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
    .then(async (x) => { const text = await x.text(); if (!secret) answers.push(text); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: x.status, headers: x.headers, text, body: json }; });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const row = (id) => db.prepare('SELECT * FROM platform_node_principals WHERE id = ?').get(id);
const capsOf = (nodeId) => db.prepare('SELECT * FROM platform_node_capabilities WHERE node_id = ?').get(nodeId);
const doc = (nodeId, cores = 4) => ({
    node_id: nodeId, cpu: { cores }, arch: 'arm64', memory_mb: 4096, storage: { capacity_gb: 64, available_gb: 32, kind: 'ssd' },
    network: { ingress_mbps: 100, egress_mbps: 20 }, regions: ['us-west'], tags: [], costs: { per_hour_usd: 0 }, capabilities: ['node:http'],
    agent_version: '0.1.0', updated_at: '2026-10-02T00:00:00Z',
});
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; log(`  ok ${name}`); };
try {
    const bot = bearer((await tokenCall('bot', 'bot-secret', 'openvibe.network')).body.access_token);
    const live = bearer((await tokenCall('live', 'live-secret', 'openvibe.network')).body.access_token);
    const credentials = [];
    const pair = async (name) => {
        const code = await call('POST', '/internal/node-pairings', { owner: { kind: 'user', subject: alex }, ref: `robot-${ids.ulid()}` }, bot);
        const r = await call('POST', '/api/v1/node-pairing', { pairing: code.body.pairing_id, code: code.body.code, name }, {}, { secret: true });
        assert.strictEqual(r.status, 201, r.text);
        credentials.push(r.body.credential);
        return r.body;
    };
    const nodeToken = async (n, audience = 'openvibe.network') => {
        const r = await tokenCall(n.principal, n.credential, audience);
        assert.strictEqual(r.status, 200, r.text);
        return r.body.access_token;
    };
    const A = await pair('Rover A');
    const B = await pair('Rover B');

    await check('a credential buys a node token whose claims are identity.service-token-claims@1', async () => {
        assert.strictEqual((await row(A.principal)).last_seen_at, null);
        const r = await tokenCall(A.principal, A.credential, 'openvibe.network');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.body.token_type, r.body.expires_in, r.body.scope], ['Bearer', 300, 'network.node.self.manage']);
        const v = serviceAuth.verifyServiceToken(r.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.network' });
        assert.ok(v.ok, v.reason);
        assert.ok(validate('identity.service-token-claims@1', v.claims).valid);
        const c = v.claims;
        assert.deepStrictEqual([c.iss, c.sub, c.actor_type, c.aud, c.cap], [ISSUER, `node:${A.principal}`, 'node', ['openvibe.network'], ['network.node.self.manage']]);
        assert.match(c.sub, /^node:nod_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(c.exp - c.iat, principals.TOKEN_TTL_S);
        assert.match(c.jti, /^tok_[0-9a-f]{24}$/);
        assert.ok(!('project_id' in c) && !('ns' in c) && !('env' in c), 'a person\'s machine carries no project');
        const seen = (await row(A.principal)).last_seen_at;
        assert.ok(seen && Math.abs(Date.parse(seen) - Date.now()) < 5000, 'issuance sets last_seen_at');
        await nodeToken(A);
        assert.strictEqual((await row(A.principal)).last_seen_at, seen, 'not rewritten within 60 s');
    });

    await check('the audience is Network or the pairing service, nothing else', async () => {
        const r = await tokenCall(A.principal, A.credential, 'openvibe.bot');
        assert.strictEqual(r.status, 200, r.text);
        const v = serviceAuth.verifyServiceToken(r.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.bot' });
        assert.ok(v.ok, v.reason);
        assert.deepStrictEqual([v.claims.aud, v.claims.cap], [['openvibe.bot'], []], 'Bot authorises the node by its own binding');
        for (const aud of ['openvibe.chat', 'openvibe.network.evil', '', undefined]) {
            const bad = await tokenCall(A.principal, A.credential, aud);
            assert.deepStrictEqual([bad.status, bad.body.error], [400, 'invalid_scope'], String(aud));
        }
        // A token for Bot is no use on Network's self routes.
        assert.strictEqual((await call('PUT', '/api/v1/node/self/capabilities', doc(A.node_id), bearer(r.body.access_token))).status, 401);
    });

    await check('unknown, revoked or wrong secret: 401 with one identical answer', async () => {
        const C = await pair('Revoked');
        assert.strictEqual((await call('POST', `/internal/node-principals/${C.principal}/revoke`, null, bot)).status, 200);
        const refusals = [
            await tokenCall(A.principal, 'not-the-credential', 'openvibe.network'),
            await tokenCall(A.principal, B.credential, 'openvibe.network'),
            await tokenCall(A.principal, '', 'openvibe.network'),
            await tokenCall(`nod_${ids.ulid()}`, A.credential, 'openvibe.network'),
            await tokenCall('nod_nope', A.credential, 'openvibe.network'),
            await tokenCall(C.principal, C.credential, 'openvibe.network'),
            await tokenCall(C.principal, C.credential, 'openvibe.chat'),
        ];
        for (const r of refusals) assert.deepStrictEqual([r.status, r.text], [401, refusals[0].text]);
        assert.strictEqual(refusals[0].body.error, 'invalid_client');
    });

    await check('rotation: the new credential works, the old one 60 s more; revoke kills both', async () => {
        const R = await pair('Rotator');
        const before = await row(R.principal);
        const rot = await call('POST', '/api/v1/node/self/credential', null, bearer(await nodeToken(R)), { secret: true });
        assert.strictEqual(rot.status, 200, rot.text);
        assert.strictEqual(rot.headers.get('cache-control'), 'no-store');
        assert.deepStrictEqual([rot.body.principal, rot.body.node_id], [R.principal, R.node_id]);
        credentials.push(rot.body.credential);
        assert.notStrictEqual(rot.body.credential, R.credential);
        const after = await row(R.principal);
        assert.deepStrictEqual([after.credential_prev_hash, after.prev_valid_until], [before.credential_hash, rot.body.prev_valid_until]);
        assert.strictEqual(after.credential_hash, crypto.createHash('sha256').update(rot.body.credential).digest('hex'));
        const at = Date.parse(after.prev_valid_until) - nodePrincipals.PREV_GRACE_MS;
        assert.ok(Math.abs(at - Date.now()) < 5000, 'the old credential lives 60 s from now');
        await nodeToken({ principal: R.principal, credential: rot.body.credential });
        await nodeToken(R);
        // The clock, injected: the old credential at 59 s still works, at 61 s it is refused like any wrong secret.
        const issue = (credential, now) => nodePrincipals.issueNodeToken(db, { clientId: R.principal, clientSecret: credential, audience: 'openvibe.network', privateKey: keys.privateKey, issuer: ISSUER, now });
        assert.strictEqual((await issue(R.credential, at + 59_000)).status, 200);
        const late = await issue(R.credential, at + 61_000);
        assert.deepStrictEqual([late.status, late.body.error], [401, 'invalid_client']);
        assert.strictEqual((await issue(rot.body.credential, at + 61_000)).status, 200, 'the new one is unaffected');
        // Revoke within the grace window: neither secret works any more.
        const D = await pair('Rotate then revoke');
        const rotD = await call('POST', '/api/v1/node/self/credential', null, bearer(await nodeToken(D)), { secret: true });
        credentials.push(rotD.body.credential);
        await nodeToken(D);
        const me = await call('POST', `/internal/node-principals/${D.principal}/revoke`, null, bot);
        assert.strictEqual(me.status, 200);
        const dead = await row(D.principal);
        assert.deepStrictEqual([dead.credential_prev_hash, dead.prev_valid_until], [null, null]);
        for (const cred of [D.credential, rotD.body.credential]) {
            const r = await tokenCall(D.principal, cred, 'openvibe.network');
            assert.deepStrictEqual([r.status, r.body.error], [401, 'invalid_client']);
        }
    });

    await check('capabilities: the machine\'s own doc is stored; another node_id is 409; a bad doc 400', async () => {
        const a = bearer(await nodeToken(A));
        const ok = await call('PUT', '/api/v1/node/self/capabilities', doc(A.node_id), a);
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.body.node_id, A.node_id);
        assert.deepStrictEqual(JSON.parse((await capsOf(A.node_id)).doc), doc(A.node_id));
        const again = await call('PUT', '/api/v1/node/self/capabilities', doc(A.node_id, 8), a);
        assert.strictEqual(again.status, 200, 'an upsert');
        assert.strictEqual(JSON.parse((await capsOf(A.node_id)).doc).cpu.cores, 8);
        const bad = await call('PUT', '/api/v1/node/self/capabilities', { node_id: A.node_id }, a);
        assert.deepStrictEqual([bad.status, bad.body.code], [400, 'registry.invalid_capabilities']);
    });

    await check('node A\'s valid token cannot change node B\'s capabilities or credential', async () => {
        const b = bearer(await nodeToken(B));
        assert.strictEqual((await call('PUT', '/api/v1/node/self/capabilities', doc(B.node_id), b)).status, 200);
        const bRow = await row(B.principal);
        const bCaps = await capsOf(B.node_id);
        const a = bearer(await nodeToken(A));
        const mismatch = await call('PUT', '/api/v1/node/self/capabilities', doc(B.node_id, 64), a);
        assert.deepStrictEqual([mismatch.status, mismatch.body.code], [409, 'registry.node_mismatch']);
        for (const p of [`/api/v1/node/self/credential?principal=${B.principal}`, `/api/v1/node/self/${B.principal}/credential`]) {
            const r = await call('POST', p, { principal: B.principal, node_id: B.node_id }, a, { secret: true });
            if (r.status === 200) {
                assert.strictEqual(r.body.principal, A.principal, 'a rotation is always the caller\'s own');
                credentials.push(r.body.credential);
                A.credential = r.body.credential;
            } else assert.strictEqual(r.status, 404);
        }
        assert.deepStrictEqual(await row(B.principal), bRow, 'B\'s principal is unchanged');
        assert.deepStrictEqual(await capsOf(B.node_id), bCaps, 'B\'s capabilities are unchanged');
        await nodeToken(B);
    });

    await check('a revoked node\'s unexpired token is 401 registry.node_revoked on both self routes', async () => {
        const E = await pair('Revoked later');
        const e = bearer(await nodeToken(E));
        assert.strictEqual((await call('PUT', '/api/v1/node/self/capabilities', doc(E.node_id), e)).status, 200);
        const before = await capsOf(E.node_id);
        assert.strictEqual((await call('POST', `/internal/node-principals/${E.principal}/revoke`, null, bot)).status, 200);
        const revokedRow = await row(E.principal);
        for (const [m, p, body] of [['PUT', '/api/v1/node/self/capabilities', doc(E.node_id, 2)], ['POST', '/api/v1/node/self/credential', null]]) {
            const r = await call(m, p, body, e);
            assert.deepStrictEqual([r.status, r.body.code], [401, 'registry.node_revoked'], `${m} ${p}`);
        }
        assert.deepStrictEqual(await row(E.principal), revokedRow);
        assert.deepStrictEqual(await capsOf(E.node_id), before);
    });

    await check('a svc: token holding network.node.self.manage is 403 capability.owner_denied', async () => {
        const host = await tokenCall('host', 'host-secret', 'openvibe.network');
        assert.ok(host.body.scope.split(' ').includes('network.node.self.manage'), host.text);
        for (const [m, p, body] of [['PUT', '/api/v1/node/self/capabilities', doc(A.node_id)], ['POST', '/api/v1/node/self/credential', null]]) {
            const r = await call(m, p, body, bearer(host.body.access_token));
            assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.owner_denied'], `${m} ${p}`);
            assert.strictEqual((await call(m, p, body)).status, 403, `${m} ${p} without a token`);
        }
        assert.strictEqual((await call('PUT', '/api/v1/node/self/capabilities', doc(A.node_id), live)).status, 403, 'without the capability');
    });

    await check('topology shows last_seen_at, health up, the name, who paired it and its capabilities', async () => {
        const F = await pair('Never signed in');
        const t = await call('GET', '/internal/registry/cells/wnam-1', null, live);
        assert.strictEqual(t.status, 200, t.text);
        const byNode = Object.fromEntries(t.body.nodes.map((n) => [n.node_id, n]));
        const a = byNode[A.node_id];
        assert.deepStrictEqual([a.health, a.last_seen_at, a.name, a.paired_for.service, a.status], ['up', (await row(A.principal)).last_seen_at, 'Rover A', 'bot', 'active']);
        assert.deepStrictEqual(a.capabilities, doc(A.node_id, 8));
        assert.deepStrictEqual([byNode[F.node_id].health, byNode[F.node_id].last_seen_at, byNode[F.node_id].capabilities], ['unknown', null, null]);
        // Seen eleven minutes ago: no longer up.
        await db.prepare('UPDATE platform_node_principals SET last_seen_at = ? WHERE id = ?').run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), B.principal);
        const later = await call('GET', '/internal/registry/cells/wnam-1', null, live);
        assert.strictEqual(later.body.nodes.find((n) => n.node_id === B.node_id).health, 'unknown');
        assert.ok(!/hash/i.test(later.text), 'the topology exposes no hash');
    });

    await check('no log line and no answer but issuance and rotation contains a credential', async () => {
        const logged = logs.join('\n');
        const said = answers.join('\n');
        assert.ok(credentials.length >= 9);
        for (const c of credentials) {
            assert.ok(!logged.includes(c), 'a credential was logged');
            assert.ok(!said.includes(c), 'a credential was in an answer');
        }
    });

    log(`node-tokens: ${passed} checks passed`);
} finally {
    process.stdout.write = out;
    process.stderr.write = err;
    server.close();
}
})().catch((e) => { console.error(e); process.exit(1); });
