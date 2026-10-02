'use strict';
// Service instances (plan T2, docs/t2-cells-and-node-principal.md section 4.1, slice N2; migration 0008): Host reports
// what runs on its machines (POST /internal/registry/instances/report, network.node.report). The whole batch is
// validated against platform.service-instance@1 and placed against the cells and node principals Network holds
// before anything is written; an instance absent from a later report of the same source is set to `stopped`, never
// deleted. The topology read gains the instance's cell region.
//   node test/registry-instances.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { ids, validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const cells = require('../server/registry/cells');
const instances = require('../server/registry/instances');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare("UPDATE oauth_clients SET client_secret = 'host-secret' WHERE client_id = 'host'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const app = express();
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
// The report route is mounted before /internal/registry, exactly as server/index.js mounts it.
app.use('/internal/registry/instances', instances.routers({ guard: principals.guard('network.node.report') }).internal);
const c = cells.routers({ readGuard: principals.guard('network.registry.read') });
app.use('/internal/registry', c.internal);
const server = http.createServer(app);

const nod = () => `nod_${ids.ulid()}`;
const insertPrincipal = (p) => db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, project_id, trust, status, created_by, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?)`).run(p.id || nod(), p.node_id, p.home_cell || 'wnam-1', p.owner_kind || 'platform', p.project_id ?? null, p.trust || 'first-party', p.status || 'active', p.revoked_at ?? null);
const inst = (id, extra = {}) => ({ id, service: 'media', version: '1.4.0', cell: 'wnam-1', node: 'ovh-1', region: 'us-west', endpoints: ['https://media.internal.example'], state: 'ready', started_at: '2026-10-01T00:00:00Z', ...extra });
const count = async () => (await db.prepare('SELECT COUNT(*) AS n FROM platform_service_instances').get()).n;
const stored = async (id) => db.prepare('SELECT * FROM platform_service_instances WHERE id = ?').get(id);

try {
    // ── Setup: two extra regions, an active cell east-1, a retired cell weu-1, and node principals on wnam-1.
    await db.prepare("INSERT INTO platform_regions (id, country) VALUES ('us-east', 'US'), ('eu-west', 'IE')").run();
    await db.prepare("INSERT INTO platform_cells (id, region, residency, status) VALUES ('east-1', 'us-east', 'US', 'active')").run();
    await db.prepare("INSERT INTO platform_cells (id, region, residency, status) VALUES ('weu-1', 'eu-west', 'IE', 'retired')").run();
    await insertPrincipal({ node_id: 'ovh-1' });
    await insertPrincipal({ node_id: 'old-1', status: 'revoked', revoked_at: '2026-10-01T00:00:00Z' });

    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = async (id, secret) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network' }) })).json()).access_token;
    const call = (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async (x) => ({ status: x.status, headers: x.headers, body: await x.json().catch(() => null) }));
    const report = (source, list, headers) => call('POST', '/internal/registry/instances/report', { source, instances: list }, headers);

    // ── Auth: nobody, and a token without network.node.report, are refused.
    assert.strictEqual((await report('primary', [] )).status, 403, 'nobody');
    const live = { authorization: `Bearer ${await token('live', 'live-secret')}` };
    assert.strictEqual((await report('primary', [], live)).status, 403, 'Live lacks network.node.report');
    assert.strictEqual(await count(), 0, 'a refused request wrote nothing');

    // ── A bad instance anywhere in the batch fails the whole batch: nothing is written.
    const host = { authorization: `Bearer ${await token('host', 'host-secret')}` };
    let x = await report('primary', [inst('media-ok'), inst('media-bad', { state: 'running' })], host);
    assert.strictEqual(x.status, 400, JSON.stringify(x.body));
    assert.strictEqual(await count(), 0, 'one bad instance wrote nothing');

    // ── Placement, each with nothing written: unknown node, wrong cell, revoked node, retired cell, wrong region.
    for (const [bad, status, code] of [
        [inst('media-unknown', { node: 'ghost-1' }), 400, 'registry.unknown_node'],
        [inst('media-cell', { cell: 'east-1', node: 'ovh-1', region: 'us-east' }), 409, 'registry.node_cell_mismatch'],
        [inst('media-revoked', { node: 'old-1' }), 409, 'registry.node_revoked'],
        [inst('media-retired', { cell: 'weu-1', region: 'eu-west' }), 409, 'registry.cell_retired'],
        [inst('media-region', { region: 'eu-west' }), 400, 'registry.region_mismatch'],
    ]) {
        x = await report('primary', [inst('media-ok'), bad], host);
        assert.deepStrictEqual([x.status, x.body.code], [status, code], JSON.stringify(x.body));
        assert.strictEqual(await count(), 0, `${code} wrote nothing`);
    }

    // ── The good report: upsert, and an update leaves a hand-set route_weight untouched (the scheduler owns it).
    x = await report('primary', [inst('media-1')], host);
    assert.strictEqual(x.status, 200, JSON.stringify(x.body));
    assert.strictEqual(x.headers.get('cache-control'), 'no-store');
    assert.strictEqual(x.headers.get('x-instances-stopped'), '0');
    await db.prepare("UPDATE platform_service_instances SET route_weight = 7 WHERE id = 'media-1'").run();
    x = await report('primary', [inst('media-1', { version: '1.5.0' })], host);
    assert.strictEqual(x.status, 200, JSON.stringify(x.body));
    assert.deepStrictEqual([(await stored('media-1')).version, Number((await stored('media-1')).route_weight)], ['1.5.0', 7], 'route_weight survives an update');

    // ── An instance absent from the same source's next report is stopped, never deleted; another source is untouched.
    x = await report('primary', [inst('media-1'), inst('media-2')], host);
    assert.strictEqual(x.status, 200, JSON.stringify(x.body));
    x = await report('secondary', [inst('media-3')], host);
    assert.strictEqual(x.status, 200, JSON.stringify(x.body));
    x = await report('primary', [inst('media-1')], host);
    assert.strictEqual(x.headers.get('x-instances-stopped'), '1');
    assert.deepStrictEqual([(await stored('media-2')).state, (await stored('media-3')).state], ['stopped', 'ready'], 'only the absent instance of the same source is stopped');
    assert.ok(await stored('media-2'), 'a stopped instance is kept, never deleted');
    x = await report('primary', [inst('media-1')], host);
    assert.strictEqual(x.headers.get('x-instances-stopped'), '0', 'an already-stopped instance is not counted again');

    // ── The topology read lists the instance with its cell and region.
    x = await call('GET', '/internal/registry/cells/wnam-1', null, live);
    assert.strictEqual(x.status, 200, JSON.stringify(x.body));
    const byId = Object.fromEntries(x.body.instances.map((i) => [i.id, i]));
    assert.deepStrictEqual([byId['media-1'].cell, byId['media-1'].region, byId['media-1'].node, byId['media-1'].state], ['wnam-1', 'us-west', 'ovh-1', 'ready']);

    // ── Every stored row still matches platform.service-instance@1.
    const regionOf = Object.fromEntries((await db.prepare('SELECT id, region FROM platform_cells').all()).map((r) => [r.id, r.region]));
    for (const r of await db.prepare('SELECT * FROM platform_service_instances ORDER BY id').all()) {
        const doc = { id: r.id, service: r.service, version: r.version, cell: r.cell, node: r.node_id, region: regionOf[r.cell], endpoints: JSON.parse(r.endpoints), state: r.state, started_at: r.started_at, route_weight: Number(r.route_weight) };
        const v = validate('platform.service-instance@1', doc);
        assert.ok(v.valid, `${r.id}: ${JSON.stringify(v.errors)}`);
    }
    console.log('registry-instances: all tests passed');
} finally {
    server.close();
}
})().catch((err) => { console.error(err); process.exit(1); });
