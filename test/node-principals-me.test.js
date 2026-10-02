'use strict';
// The owner API for a person's own machines (plan T2, docs/t2-cells-and-node-principal.md sections 4.2 and 7, slice
// N5): GET /api/v1/me/nodes lists only the principals the signed-in person owns (owner_kind user, owner_subject me),
// newest first, in the same view the service read returns; POST /api/v1/me/nodes/:principal/revoke revokes one of
// them (404 registry.unknown_node for anyone else's, idempotent), and no answer ever carries a hash, credential or
// secret. A service token and no token are both refused.
//   node test/node-principals-me.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const nodePrincipals = require('../server/registry/node-principals');
const { signToken } = require('../server/auth/routes');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare("UPDATE oauth_clients SET client_secret = 'bot-secret' WHERE client_id = 'bot'").run();

const alex = `usr_${ids.ulid()}`; const bella = `usr_${ids.ulid()}`;
await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id) VALUES
    (9201, 'mealex', 'Alex', 'x', ?), (9202, 'meebella', 'Bella', 'x', ?)`).run(alex, bella);
await db.prepare("INSERT INTO users (id, username, password_hash, is_anon) VALUES (9203, 'meeguest', 'x', 1)").run();

const clock = { offset: 0 };
const now = () => Date.now() + clock.offset;
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/oauth', require('../server/auth/oauth-routes'));
const pr = nodePrincipals.routers({ guard: principals.guard('network.node.manage'), now });
app.use('/api/v1/node-pairing', pr.pairing);
app.use('/internal', pr.internal);
app.use('/api/v1/me/nodes', nodePrincipals.userRouter(requireAuth, now));
const server = http.createServer(app);

const logs = [];
const out = process.stdout.write.bind(process.stdout);
const err = process.stderr.write.bind(process.stderr);
process.stdout.write = (c, ...a) => { logs.push(String(c)); return out(c, ...a); };
process.stderr.write = (c, ...a) => { logs.push(String(c)); return err(c, ...a); };

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
    .then(async (x) => { const text = await x.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: x.status, headers: x.headers, text, body: json }; });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const serviceToken = async (id, secret) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network' }) })).json()).access_token;
const session = async (id) => bearer(signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config));
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; log(`  ok ${name}`); };
const VIEW_KEYS = ['created_at', 'home_cell', 'last_seen_at', 'name', 'node_id', 'owner', 'paired_for', 'principal', 'revoked_at', 'status'];
try {
    const bot = bearer(await serviceToken('bot', 'bot-secret'));
    const asAlex = await session(9201); const asBella = await session(9202); const asGuest = await session(9203);
    const mint = (owner, ref) => call('POST', '/internal/node-pairings', { owner: { kind: 'user', subject: owner }, ref }, bot);
    const pair = async (owner, name) => {
        const { body: pairing } = await mint(owner, `me-${ids.ulid()}`);
        const r = await call('POST', '/api/v1/node-pairing', { pairing: pairing.pairing_id, code: pairing.code, name });
        assert.strictEqual(r.status, 201, r.text);
        return r.body;
    };

    await check('only a person\'s session is accepted; no token and a service token are 401', async () => {
        assert.strictEqual((await call('GET', '/api/v1/me/nodes')).status, 401);
        assert.strictEqual((await call('POST', '/api/v1/me/nodes/nod_x/revoke')).status, 401);
        assert.strictEqual((await call('GET', '/api/v1/me/nodes', null, bot)).status, 401, 'a service token is not a session');
        const guest = await call('GET', '/api/v1/me/nodes', null, asGuest);
        assert.deepStrictEqual([guest.status, guest.body.code], [403, 'registry.guest']);
    });

    // A pairs two machines, B one; the clock steps so "newest first" is unambiguous.
    const a1 = await pair(alex, 'Workstation');
    clock.offset += 1000;
    const a2 = await pair(alex, 'Laptop');
    clock.offset += 1000;
    const b1 = await pair(bella, 'Bella\'s tower');
    clock.offset += 1000;

    await check('a person lists exactly their own machines, newest first, in the service view', async () => {
        const a = await call('GET', '/api/v1/me/nodes', null, asAlex);
        assert.strictEqual(a.status, 200, a.text);
        assert.strictEqual(a.headers.get('cache-control'), 'private, no-store');
        assert.deepStrictEqual(a.body.nodes.map(n => n.principal), [a2.principal, a1.principal], 'newest first, only Alex\'s');
        for (const [i, paired] of [a2, a1].entries()) {
            const view = a.body.nodes[i];
            assert.deepStrictEqual(Object.keys(view).sort(), VIEW_KEYS);
            assert.deepStrictEqual([view.owner, view.status, view.name, view.paired_for], [{ kind: 'user', subject: alex }, 'active', paired === a2 ? 'Laptop' : 'Workstation', { service: 'bot', ref: (await db.prepare('SELECT pairing_ref FROM platform_node_principals WHERE id = ?').get(paired.principal)).pairing_ref }]);
            const internal = await call('GET', `/internal/node-principals/${paired.principal}`, null, bot);
            assert.deepStrictEqual(view, internal.body, 'the owner sees exactly the service view');
        }
        const b = await call('GET', '/api/v1/me/nodes', null, asBella);
        assert.deepStrictEqual(b.body.nodes.map(n => n.principal), [b1.principal], 'Bella sees only her machine');
    });

    await check('revoking someone else\'s machine is a 404 and changes nothing', async () => {
        const r = await call('POST', `/api/v1/me/nodes/${b1.principal}/revoke`, null, asAlex);
        assert.deepStrictEqual([r.status, r.body.code], [404, 'registry.unknown_node']);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        const row = await db.prepare('SELECT status, revoked_at, revoked_by FROM platform_node_principals WHERE id = ?').get(b1.principal);
        assert.deepStrictEqual([row.status, row.revoked_at, row.revoked_by], ['active', null, null], 'Bella\'s machine is untouched');
        assert.deepStrictEqual((await call('POST', `/api/v1/me/nodes/nod_${ids.ulid()}/revoke`, null, asAlex)).status, 404);
        assert.deepStrictEqual((await call('POST', '/api/v1/me/nodes/not-a-node/revoke', null, asAlex)).status, 404);
    });

    await check('revoking your own machine clears the previous credential and is idempotent', async () => {
        await db.prepare("UPDATE platform_node_principals SET credential_prev_hash = ?, prev_valid_until = ? WHERE id = ?").run('c'.repeat(64), '2026-10-02T00:01:00Z', a1.principal);
        const r = await call('POST', `/api/v1/me/nodes/${a1.principal}/revoke`, null, asAlex);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.deepStrictEqual([r.body.principal, r.body.status], [a1.principal, 'revoked']);
        assert.ok(r.body.revoked_at);
        const row = await db.prepare('SELECT * FROM platform_node_principals WHERE id = ?').get(a1.principal);
        assert.deepStrictEqual([row.revoked_at, row.revoked_by, row.credential_prev_hash, row.prev_valid_until, row.updated_at], [r.body.revoked_at, alex, null, null, r.body.revoked_at]);
        assert.strictEqual(row.credential_hash, crypto.createHash('sha256').update(a1.credential).digest('hex'), 'the row still holds its credential: migrations/0014 requires one for a user-owned principal');
        clock.offset += 5000;
        const again = await call('POST', `/api/v1/me/nodes/${a1.principal}/revoke`, null, asAlex);
        clock.offset -= 5000;
        assert.deepStrictEqual([again.status, again.body], [200, r.body], 'a second revoke answers the same view');
    });

    await check('no answer ever carries a hash, credential or secret', async () => {
        const answers = [
            await call('GET', '/api/v1/me/nodes', null, asAlex),
            await call('POST', `/api/v1/me/nodes/${a2.principal}/revoke`, null, asAlex),
            await call('POST', `/api/v1/me/nodes/${b1.principal}/revoke`, null, asBella),
        ];
        for (const answer of answers) {
            assert.ok(!/hash|credential|secret/i.test(answer.text), `an answer leaked a secret field: ${answer.text}`);
            assert.ok(!answer.text.includes(a1.credential) && !answer.text.includes(a2.credential), 'an answer leaked a credential');
        }
        const listed = (await call('GET', '/api/v1/me/nodes', null, asAlex)).body.nodes;
        assert.deepStrictEqual(listed.map(n => [n.principal, n.status]), [[a2.principal, 'revoked'], [a1.principal, 'revoked']], 'revoked machines stay in the owner\'s list with their status');
        assert.ok(!logs.join('\n').includes(a1.credential), 'a credential was logged');
    });
    log(`node-principals-me: ${passed} checks passed`);
} finally {
    process.stdout.write = out;
    process.stderr.write = err;
    server.close();
    await db.close?.();
}
})().catch((e) => { console.error(e); process.exit(1); });
