'use strict';
// Registry operators (plan T2 step 1, server/registry/registry-admin.js): a staff session sets a cell's route weight
// and status, an instance's route weight and state, and drains a node principal or makes it active again. No session
// is 401, a non-admin session and a service token are refused; weights are integers 0-1000 and states are the 0008
// CHECK's; unknown ids are 404 and a revoked principal stays revoked. Every change persists and lands in audit_log,
// and Host's next instance report keeps the operator's weight.
//   node test/registry-admin.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const { signToken } = require('../server/auth/routes');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare("UPDATE oauth_clients SET client_secret = 'host-secret' WHERE client_id = 'host'").run();
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (9301, 'regadmin', 'x', 'admin'), (9302, 'reguser', 'x', 'user')`).run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
// The same guard as server/index.js requireAdmin.
const requireAdmin = (req, res, next) => (!req.user || req.user.role !== 'admin' ? res.status(403).json({ error: 'Admin access required' }) : next());

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal/registry/instances', require('../server/registry/instances').routers({ guard: principals.guard('network.node.report') }).internal);
app.use('/api/v1/cells', require('../server/registry/cells').routers({ readGuard: principals.guard('network.registry.read') }).pub);
app.use('/api/admin/registry', require('../server/registry/registry-admin').createRegistryAdmin(db, requireAuth, requireAdmin));
const server = http.createServer(app);

const nod = () => `nod_${ids.ulid()}`;
const platformId = nod(); const pairedId = nod(); const revokedId = nod();
await db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, owner_subject, trust, status, created_by, revoked_at, credential_hash) VALUES
    (?, 'ovh-1', 'wnam-1', 'platform', NULL, 'first-party', 'active', 'test', NULL, NULL),
    (?, 'pi-1', 'wnam-1', 'user', ?, 'community', 'active', 'test', NULL, ?),
    (?, 'old-1', 'wnam-1', 'platform', NULL, 'first-party', 'revoked', 'test', '2026-10-01T00:00:00Z', NULL)`)
    .run(platformId, pairedId, `usr_${ids.ulid()}`, '1'.repeat(64), revokedId);
await db.prepare(`INSERT INTO platform_service_instances (id, service, version, cell, node_id, endpoints, state, source, started_at, reported_at)
    VALUES ('media-1', 'media', '1.4.0', 'wnam-1', 'ovh-1', '["https://media.internal.example"]', 'ready', 'oregon', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run();

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (x) => { const text = await x.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: x.status, headers: x.headers, text, body: json }; });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const session = async (id) => bearer(signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config));
const serviceToken = async (id, secret) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network' }) })).json()).access_token;
const cellRow = () => db.prepare('SELECT status, route_weight FROM platform_cells WHERE id = ?').get('wnam-1');
const instanceRow = () => db.prepare('SELECT state, route_weight FROM platform_service_instances WHERE id = ?').get('media-1');
const principalRow = (id) => db.prepare('SELECT status, revoked_at FROM platform_node_principals WHERE id = ?').get(id);
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; log(`  ok ${name}`); };
try {
    const admin = await session(9301); const user = await session(9302);
    const host = bearer(await serviceToken('host', 'host-secret'));
    const A = (method, p, body) => call(method, `/api/admin/registry${p}`, body, admin);

    await check('staff session only: no session 401, a person 403, a service token refused', async () => {
        for (const [method, p, body] of [['GET', '/node-principals'], ['PUT', '/cells/wnam-1', { route_weight: 5 }], ['PUT', '/instances/media-1', { route_weight: 5 }], ['PUT', `/node-principals/${platformId}`, { status: 'draining' }]]) {
            assert.strictEqual((await call(method, `/api/admin/registry${p}`, body)).status, 401, `${method} ${p} with no session`);
            assert.strictEqual((await call(method, `/api/admin/registry${p}`, body, user)).status, 403, `${method} ${p} as a person`);
            assert.ok([401, 403].includes((await call(method, `/api/admin/registry${p}`, body, host)).status), `${method} ${p} with a service token`);
        }
        assert.deepStrictEqual(await cellRow(), { status: 'active', route_weight: 100 }, 'nothing written');
        assert.deepStrictEqual(await instanceRow(), { state: 'ready', route_weight: 100 });
        assert.strictEqual((await principalRow(platformId)).status, 'active');
    });

    await check('a cell: weight and status persist, show in the public list, and are audited', async () => {
        let r = await A('PUT', '/cells/wnam-1', { route_weight: 250 });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body, { id: 'wnam-1', region: 'us-west', residency: 'US', status: 'active', route_weight: 250 });
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        r = await A('PUT', '/cells/wnam-1', { status: 'draining' });
        assert.deepStrictEqual([r.status, r.body.status, r.body.route_weight], [200, 'draining', 250], 'the other field is kept');
        assert.deepStrictEqual(await cellRow(), { status: 'draining', route_weight: 250 });
        assert.deepStrictEqual((await call('GET', '/api/v1/cells/wnam-1')).body, { id: 'wnam-1', region: 'us-west', residency: 'US', status: 'draining', route_weight: 250 });
        r = await A('PUT', '/cells/wnam-1', { status: 'active', route_weight: 0 });
        assert.deepStrictEqual([r.status, r.body.status, r.body.route_weight], [200, 'active', 0]);
        r = await A('PUT', '/cells/wnam-1', { route_weight: 1000 });
        assert.deepStrictEqual([r.status, r.body.route_weight], [200, 1000]);
        const audit = await db.prepare("SELECT user_id, details FROM audit_log WHERE action = 'registry_cell_update' ORDER BY id").all();
        assert.deepStrictEqual(audit.map((a) => [Number(a.user_id), JSON.parse(a.details)]), [
            [9301, { id: 'wnam-1', route_weight: 250 }], [9301, { id: 'wnam-1', status: 'draining' }],
            [9301, { id: 'wnam-1', status: 'active', route_weight: 0 }], [9301, { id: 'wnam-1', route_weight: 1000 }],
        ]);
    });

    await check('invalid values: weights outside 0-1000 or not integers, unknown statuses, bad bodies', async () => {
        for (const w of [1001, -1, 1.5, '250', null, true]) {
            const r = await A('PUT', '/cells/wnam-1', { route_weight: w });
            assert.deepStrictEqual([r.status, r.body.code], [422, 'registry.invalid_weight'], `cell weight ${JSON.stringify(w)}`);
            const i = await A('PUT', '/instances/media-1', { route_weight: w });
            assert.deepStrictEqual([i.status, i.body.code], [422, 'registry.invalid_weight'], `instance weight ${JSON.stringify(w)}`);
        }
        for (const s of ['revoked', 'DRAINING', '', 7]) {
            const r = await A('PUT', '/cells/wnam-1', { status: s });
            assert.deepStrictEqual([r.status, r.body.code], [422, 'registry.invalid_status'], `cell status ${JSON.stringify(s)}`);
        }
        for (const s of ['retired', 'up']) {
            const r = await A('PUT', '/instances/media-1', { state: s });
            assert.deepStrictEqual([r.status, r.body.code], [422, 'registry.invalid_state'], `instance state ${s}`);
        }
        for (const s of ['revoked', 'retired']) {
            const r = await A('PUT', `/node-principals/${platformId}`, { status: s });
            assert.deepStrictEqual([r.status, r.body.code], [422, 'registry.invalid_status'], `principal status ${s}`);
        }
        // A valid field next to an invalid one writes neither.
        let r = await A('PUT', '/cells/wnam-1', { route_weight: 10, status: 'gone' });
        assert.strictEqual(r.status, 422);
        for (const body of [{}, [], { weight: 5 }, { route_weight: 5, region: 'eu-west' }]) {
            r = await A('PUT', '/cells/wnam-1', body);
            assert.deepStrictEqual([r.status, r.body.code], [400, 'registry.invalid_body'], JSON.stringify(body));
        }
        r = await A('PUT', '/instances/media-1', { status: 'draining' });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'registry.invalid_body'], 'an instance has a state, not a status');
        r = await A('PUT', `/node-principals/${platformId}`, { route_weight: 5 });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'registry.invalid_body'], 'a principal has no weight');
        assert.deepStrictEqual(await cellRow(), { status: 'active', route_weight: 1000 }, 'nothing written');
        assert.deepStrictEqual(await instanceRow(), { state: 'ready', route_weight: 100 });
        assert.strictEqual((await principalRow(platformId)).status, 'active');
    });

    await check('unknown ids are 404 and write nothing', async () => {
        const before = (await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'registry_%'").get()).n;
        let r = await A('PUT', '/cells/nope-1', { route_weight: 5 });
        assert.deepStrictEqual([r.status, r.body.code], [404, 'registry.unknown_cell']);
        r = await A('PUT', '/instances/nope-1', { route_weight: 5 });
        assert.deepStrictEqual([r.status, r.body.code], [404, 'registry.unknown_instance']);
        for (const id of [nod(), 'ovh-1', 'nope']) {
            r = await A('PUT', `/node-principals/${id}`, { status: 'draining' });
            assert.deepStrictEqual([r.status, r.body.code], [404, 'registry.unknown_node'], id);
        }
        assert.strictEqual((await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'registry_%'").get()).n, before, 'no audit row for a refused write');
    });

    await check('an instance: weight and draining persist; Host\'s next report keeps the weight', async () => {
        let r = await A('PUT', '/instances/media-1', { route_weight: 40, state: 'draining' });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.body.id, r.body.service, r.body.node, r.body.state, r.body.route_weight], ['media-1', 'media', 'ovh-1', 'draining', 40]);
        assert.deepStrictEqual(await instanceRow(), { state: 'draining', route_weight: 40 });
        const doc = { id: 'media-1', service: 'media', version: '1.4.1', cell: 'wnam-1', node: 'ovh-1', region: 'us-west', endpoints: ['https://media.internal.example'], state: 'ready', started_at: '2026-10-01T00:00:00Z' };
        const rep = await call('POST', '/internal/registry/instances/report', { source: 'oregon', instances: [doc] }, host);
        assert.strictEqual(rep.status, 200, rep.text);
        assert.deepStrictEqual(await instanceRow(), { state: 'ready', route_weight: 40 }, 'a report sets the state, never the weight');
    });

    await check('a node principal: draining and back to active; revoked stays revoked', async () => {
        let r = await A('PUT', `/node-principals/${platformId}`, { status: 'draining' });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.body.principal, r.body.node_id, r.body.status, r.body.trust, r.body.owner], [platformId, 'ovh-1', 'draining', 'first-party', { kind: 'platform' }]);
        assert.strictEqual((await principalRow(platformId)).status, 'draining');
        r = await A('PUT', `/node-principals/${pairedId}`, { status: 'draining' });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(!/hash|credential/.test(r.text), 'never a hash or a credential');
        r = await A('PUT', `/node-principals/${platformId}`, { status: 'active' });
        assert.deepStrictEqual([r.status, r.body.status], [200, 'active']);
        r = await A('PUT', `/node-principals/${revokedId}`, { status: 'active' });
        assert.deepStrictEqual([r.status, r.body.code], [409, 'registry.node_revoked']);
        assert.deepStrictEqual(await principalRow(revokedId), { status: 'revoked', revoked_at: '2026-10-01T00:00:00Z' });
    });

    await check('the operator principal list: every owner, with trust, filtered', async () => {
        let r = await A('GET', '/node-principals');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        const byNode = Object.fromEntries(r.body.node_principals.map((p) => [p.node_id, p]));
        assert.deepStrictEqual(Object.keys(byNode).sort(), ['old-1', 'ovh-1', 'pi-1']);
        assert.deepStrictEqual([byNode['pi-1'].status, byNode['pi-1'].trust, byNode['pi-1'].owner.kind], ['draining', 'community', 'user']);
        assert.ok(!/hash|credential/.test(r.text));
        r = await A('GET', '/node-principals?status=draining');
        assert.deepStrictEqual(r.body.node_principals.map((p) => p.node_id), ['pi-1']);
        r = await A('GET', '/node-principals?owner_kind=platform&cell=wnam-1');
        assert.deepStrictEqual(r.body.node_principals.map((p) => p.node_id).sort(), ['old-1', 'ovh-1']);
        r = await A('GET', '/node-principals?cell=nope-1');
        assert.deepStrictEqual(r.body.node_principals, []);
    });
    log(`registry-admin: ${passed} checks passed`);
} finally {
    server.close();
}
})().catch((err) => { console.error(err); process.exit(1); });
