'use strict';
// Cells and node principals (plan T2, docs/t2-resource-registry.md section 9; migrations/0008): the wnam-1 bootstrap,
// the ownership and identity constraints of node principals and service instances, Host's node report creating only
// platform principals, offers that must agree with their node's home cell and trust class, and the cell read API.
//   node test/cells-registry.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { getDb, MIGRATIONS } = require('../server/db/database');
const principals = require('../server/identity/principals');
const cells = require('../server/registry/cells');

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
app.use('/internal/nodes', require('../server/registry/nodes').routers({ guard: principals.guard('network.node.report') }).internal);
app.use('/internal/resources', require('../server/registry/offers').routers({ guard: principals.guard('network.node.report') }).internal);
const c = cells.routers({ readGuard: principals.guard('network.registry.read') });
app.use('/api/v1/cells', c.pub);
app.use('/internal/registry', c.internal);
const server = http.createServer(app);

const nod = () => `nod_${ids.ulid()}`;
const project = `prj_${ids.ulid()}`;
const principal = (nodeId) => db.prepare('SELECT * FROM platform_node_principals WHERE node_id = ?').get(nodeId);
const insertPrincipal = (p) => db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, project_id, trust, status, created_by, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?)`).run(p.id || nod(), p.node_id, p.home_cell || 'wnam-1', p.owner_kind, p.project_id ?? null, p.trust, p.status || 'active', p.revoked_at ?? null);
// The pairing columns of 0014, on the same insert path (never a real credential: a fake 64-hex hash).
const hash = (c) => c.repeat(64);
const insertPaired = (p) => db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, project_id, owner_subject, trust, status, created_by, revoked_at, credential_hash, credential_prev_hash, prev_valid_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?, ?, ?)`).run(p.id || nod(), p.node_id, p.home_cell || 'wnam-1', p.owner_kind, p.project_id ?? null, p.owner_subject ?? null, p.trust, p.status || 'active', p.revoked_at ?? null, p.credential_hash ?? null, p.credential_prev_hash ?? null, p.prev_valid_until ?? null);
const insertInstance = (i) => db.prepare(`INSERT INTO platform_service_instances (id, service, version, cell, node_id, endpoints, state, source, started_at, reported_at)
    VALUES (?, ?, '1.0.0', ?, ?, '["https://media.internal.example"]', ?, 'test', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run(i.id, i.service || 'media', i.cell || 'wnam-1', i.node_id, i.state || 'ready');
const node = (id, region = 'us-west') => ({ id, roles: ['web', 'app'], location: { region, country: 'US' }, health: { status: 'up', checked_at: '2026-10-01T12:00:00Z' }, updated_at: '2026-10-01T12:00:00Z' });
const offer = (id, extra = {}) => ({ offer_id: id, kind: 'node', node_id: id, provider: 'ovh', region: 'us-west', cell: 'wnam-1', trust: 'first-party', capabilities: ['node:http'], capacity: { cpu: { utilization: 0.2, available_cores: 6 } }, health: { status: 'up', checked_at: '2026-10-01T12:00:00Z' }, pricing: { model: 'prepaid' }, updated_at: '2026-10-01T12:00:00Z', ...extra });

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const token = async (id, secret) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network' }) })).json()).access_token;
const call = (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
    .then(async (x) => ({ status: x.status, headers: x.headers, body: await x.json().catch(() => null) }));
try {
    // ── The migration: wnam-1 in us-west is seeded; projects gain a home cell; offers must name a known cell.
    assert.deepStrictEqual(await cells.listCells(db), [{ id: 'wnam-1', region: 'us-west', residency: 'US', status: 'active', route_weight: 100 }]);
    await db.prepare("INSERT INTO dev_projects (id, owner_subject, name, created_at, created_by) VALUES (?, 'usr_owner', 'Home lab', '2026-10-01T00:00:00Z', 'usr_owner')").run(project);
    assert.strictEqual((await db.prepare('SELECT home_cell FROM dev_projects WHERE id = ?').get(project)).home_cell, 'wnam-1', 'a project starts in wnam-1');
    await assert.rejects(db.prepare("UPDATE dev_projects SET home_cell = 'nope-1' WHERE id = ?").run(project), 'a project home cell must exist');
    await assert.rejects(db.prepare("INSERT INTO platform_resource_offers (id, source, kind, region, cell, trust, status, doc, reported_at) VALUES ('x', 'x', 'node', 'us-west', 'nope-1', 'partner', 'up', '{}', 'now')").run(), 'an offer cell must exist');
    await assert.rejects(db.prepare("INSERT INTO platform_cells (id, region, residency, status) VALUES ('weu-1', 'eu-west', 'IE', 'planned')").run(), 'a cell region must exist');
    await db.prepare("INSERT INTO platform_regions (id, country) VALUES ('eu-west', 'IE')").run();
    await db.prepare("INSERT INTO platform_cells (id, region, residency, status) VALUES ('weu-1', 'eu-west', 'IE', 'planned')").run();
    await assert.rejects(db.prepare("INSERT INTO platform_cells (id, region, residency, status) VALUES ('wnam-2', 'us-west', 'US', 'live')").run(), 'cell status is an enum');

    // ── Ownership and identity constraints of node principals.
    const refused = [
        [{ node_id: 'p1', owner_kind: 'platform', project_id: project, trust: 'first-party' }, 'a platform node has no project'],
        [{ node_id: 'p2', owner_kind: 'platform', trust: 'partner' }, 'a platform node is first-party'],
        [{ node_id: 'p3', owner_kind: 'project', trust: 'community' }, 'a project node names its project'],
        [{ node_id: 'p4', owner_kind: 'project', project_id: project, trust: 'first-party' }, 'a project node is never first-party'],
        [{ node_id: 'p5', owner_kind: 'project', project_id: `prj_${ids.ulid()}`, trust: 'community' }, 'the project must exist'],
        [{ node_id: 'p6', owner_kind: 'platform', trust: 'first-party', home_cell: 'nope-1' }, 'the home cell must exist'],
        [{ node_id: 'p7', owner_kind: 'platform', trust: 'first-party', status: 'revoked' }, 'revoked needs revoked_at'],
        [{ node_id: 'p8', owner_kind: 'platform', trust: 'first-party', revoked_at: '2026-10-01T00:00:00Z' }, 'revoked_at needs revoked'],
        [{ node_id: 'p9', owner_kind: 'project', project_id: project, trust: 'trusted' }, 'trust is the trust-class enum'],
        [{ id: `usr_${ids.ulid()}`, node_id: 'p10', owner_kind: 'platform', trust: 'first-party' }, 'a node principal id is nod_<ULID>, never another subject'],
        [{ node_id: 'Bad_Node', owner_kind: 'platform', trust: 'first-party' }, 'node ids follow network.node@1'],
    ];
    for (const [row, why] of refused) await assert.rejects(insertPrincipal(row), why);
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM platform_node_principals').get()).n, 0, 'nothing was written by a refused insert');
    await insertPaired({ node_id: 'pi-1', owner_kind: 'project', project_id: project, trust: 'community', credential_hash: hash('1') });
    await assert.rejects(insertPaired({ node_id: 'pi-1', owner_kind: 'project', project_id: project, trust: 'community', credential_hash: hash('2') }), 'one principal per machine');
    await insertPrincipal({ node_id: 'old-1', owner_kind: 'platform', trust: 'first-party', status: 'revoked', revoked_at: '2026-10-01T00:00:00Z' });

    // ── N4a: a paired machine's owner, credential and pairing record (migrations/0014, section 3.2).
    await insertPaired({ node_id: 'pair-user', home_cell: 'weu-1', owner_kind: 'user', owner_subject: `usr_${ids.ulid()}`, trust: 'community', credential_hash: hash('a') });
    await assert.rejects(insertPaired({ node_id: 'pair-user-1p', home_cell: 'weu-1', owner_kind: 'user', owner_subject: `usr_${ids.ulid()}`, trust: 'first-party', credential_hash: hash('b') }), 'a user machine is never first-party');
    await assert.rejects(insertPaired({ node_id: 'pair-user-nocred', home_cell: 'weu-1', owner_kind: 'user', owner_subject: `usr_${ids.ulid()}`, trust: 'community' }), 'a user machine holds a credential');
    await insertPaired({ node_id: 'pair-platform', home_cell: 'weu-1', owner_kind: 'platform', trust: 'first-party' });
    await assert.rejects(insertPaired({ node_id: 'pair-prev', home_cell: 'weu-1', owner_kind: 'platform', trust: 'first-party', credential_prev_hash: hash('c') }), 'a previous credential always has a grace window');
    await insertPaired({ node_id: 'pair-cred-a', home_cell: 'weu-1', owner_kind: 'platform', trust: 'first-party', credential_hash: hash('d') });
    await assert.rejects(insertPaired({ node_id: 'pair-cred-b', home_cell: 'weu-1', owner_kind: 'platform', trust: 'first-party', credential_hash: hash('d') }), 'one live principal per credential');
    await assert.rejects(db.prepare(`INSERT INTO platform_node_pairings (id, code_hash, owner_kind, project_id, owner_subject, service, ref, created_by, expires_at)
        VALUES (?, ?, 'user', ?, ?, 'bot', 'rob-1', 'usr_owner', '2026-10-02T00:00:00Z')`).run(`pair_${ids.ulid()}`, hash('e'), project, `usr_${ids.ulid()}`), 'a pairing row has one owner');
    // The migration applied a second time is a no-op: the runner records it by number, and every statement is IF NOT EXISTS / DROP ... IF EXISTS.
    assert.deepStrictEqual((await db.migrate({ dir: MIGRATIONS })).applied, []);
    await db.exec(require('fs').readFileSync(require('path').join(MIGRATIONS, '0014_node_pairing.sql'), 'utf8'));

    // ── A node principal is not a service principal: it can hold no client-credentials token.
    const nodClient = nod();
    await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris) VALUES (?, 'node-secret', 'node', '[]')").run(nodClient);
    const t = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: nodClient, client_secret: 'node-secret', audience: 'openvibe.network' }) });
    assert.strictEqual(t.status, 400);
    assert.strictEqual((await t.json()).error, 'unauthorized_client');

    // ── Host's node report: first-named machines become platform principals; a project's or a revoked machine refuses the report.
    const host = { authorization: `Bearer ${await token('host', 'host-secret')}` };
    let x = await call('POST', '/internal/nodes/report', { source: 'primary', nodes: [node('ovh-1'), node('edge-1', 'eu-west')] }, host);
    assert.strictEqual(x.status, 200, JSON.stringify(x.body));
    const ovh = await principal('ovh-1');
    assert.match(ovh.id, /^nod_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepStrictEqual([ovh.owner_kind, ovh.project_id, ovh.trust, ovh.home_cell, ovh.status, ovh.created_by], ['platform', null, 'first-party', 'wnam-1', 'active', 'report:primary']);
    assert.strictEqual((await principal('edge-1')).home_cell, 'wnam-1', 'no active cell in eu-west yet: the bootstrap cell');
    x = await call('POST', '/internal/nodes/report', { source: 'primary', nodes: [node('ovh-1'), node('edge-1', 'eu-west')] }, host);
    assert.strictEqual(x.status, 200);
    assert.strictEqual((await principal('ovh-1')).id, ovh.id, 'a re-report keeps the principal');
    for (const [id, code] of [['pi-1', 'registry.node_not_platform'], ['old-1', 'registry.node_revoked']]) {
        x = await call('POST', '/internal/nodes/report', { source: 'primary', nodes: [node('ovh-1'), node(id)] }, host);
        assert.deepStrictEqual([x.status, x.body.code], [409, code], `${id}: ${JSON.stringify(x.body)}`);
    }
    assert.deepStrictEqual((await db.prepare("SELECT id, status FROM platform_nodes ORDER BY id").all()).map((r) => [r.id, r.status]), [['edge-1', 'up'], ['ovh-1', 'up']],
        'a refused report wrote nothing and marked nothing down');

    // The 0008 backfill: a machine already in the node registry gets its platform principal at boot.
    await db.prepare("INSERT INTO platform_nodes (id, source, doc, status, reported_at) VALUES ('legacy-1', 'primary', ?, 'up', 'now')").run(JSON.stringify(node('legacy-1')));
    await cells.ensureSchema(db);
    assert.deepStrictEqual([(await principal('legacy-1')).owner_kind, (await principal('legacy-1')).created_by], ['platform', 'bootstrap']);

    // ── Service instances run on a registered node, in that node's home cell.
    await assert.rejects(insertInstance({ id: 'media-x', node_id: 'ghost-1' }), 'an unregistered node');
    await assert.rejects(insertInstance({ id: 'media-x', node_id: 'ovh-1', cell: 'weu-1' }), 'not the node\'s home cell');
    await assert.rejects(insertInstance({ id: 'media-x', node_id: 'ovh-1', state: 'running' }), 'state is the platform.service-instance@1 enum');
    await insertInstance({ id: 'media-1', node_id: 'ovh-1' });
    await insertInstance({ id: 'run-1', service: 'run', node_id: 'pi-1', state: 'starting' });

    // ── Offers must agree with the cell and node principal Network holds.
    const offers = (list) => call('POST', '/internal/resources/report', { source: 'primary', offers: list }, host);
    for (const [o, status, code] of [
        [offer('ovh-1', { cell: 'nope-1' }), 400, 'registry.unknown_cell'],
        [offer('ovh-1', { cell: 'weu-1' }), 409, 'registry.node_cell_mismatch'],
        [offer('ovh-1', { trust: 'community' }), 409, 'registry.trust_mismatch'],
        [offer('pi-1'), 409, 'registry.trust_mismatch'],
        [offer('old-1'), 409, 'registry.node_revoked'],
    ]) {
        x = await offers([offer('edge-1'), o]);
        assert.deepStrictEqual([x.status, x.body.code], [status, code], JSON.stringify(x.body));
        assert.match(x.body.detail, /^offer 1: /);
    }
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM platform_resource_offers').get()).n, 0, 'a misplaced offer writes nothing');
    x = await offers([offer('ovh-1'), offer('pi-1', { trust: 'community' }), offer('ovh-1-gpu', { node_id: undefined, kind: 'provider', provider: 'acme', trust: 'external' })]);
    assert.strictEqual(x.status, 200, JSON.stringify(x.body));

    // ── The read API: public cells; a cell's topology for network.registry.read only.
    x = await call('GET', '/api/v1/cells');
    assert.deepStrictEqual(x.body.cells.map((cell) => [cell.id, cell.status]), [['weu-1', 'planned'], ['wnam-1', 'active']]);
    assert.strictEqual(x.headers.get('cache-control'), 'public, max-age=60');
    assert.strictEqual(x.headers.get('access-control-allow-origin'), '*');
    x = await call('GET', '/api/v1/cells/wnam-1');
    assert.deepStrictEqual(x.body, { id: 'wnam-1', region: 'us-west', residency: 'US', status: 'active', route_weight: 100 });
    x = await call('GET', '/api/v1/cells/nope-1');
    assert.deepStrictEqual([x.status, x.headers.get('content-type'), x.body.code], [404, 'application/problem+json', 'registry.unknown_cell']);

    assert.strictEqual((await call('GET', '/internal/registry/cells/wnam-1')).status, 403, 'nobody');
    assert.strictEqual((await call('GET', '/internal/registry/cells/wnam-1', null, host)).status, 403, 'Host lacks network.registry.read');
    const live = { authorization: `Bearer ${await token('live', 'live-secret')}` };
    x = await call('GET', '/internal/registry/cells/wnam-1', null, live);
    assert.strictEqual(x.status, 200, JSON.stringify(x.body));
    assert.strictEqual(x.headers.get('cache-control'), 'no-store');
    const byNode = Object.fromEntries(x.body.nodes.map((n) => [n.node_id, n]));
    assert.deepStrictEqual(Object.keys(byNode), ['edge-1', 'legacy-1', 'old-1', 'ovh-1', 'pi-1']);
    assert.deepStrictEqual([byNode['ovh-1'].owner, byNode['ovh-1'].trust, byNode['ovh-1'].health], [{ kind: 'platform', project_id: null }, 'first-party', 'up']);
    assert.deepStrictEqual([byNode['pi-1'].owner, byNode['pi-1'].trust, byNode['pi-1'].health], [{ kind: 'project', project_id: project }, 'community', 'unknown']);
    assert.deepStrictEqual(x.body.instances.map((i) => [i.id, i.node, i.state]), [['media-1', 'ovh-1', 'ready'], ['run-1', 'pi-1', 'starting']]);
    assert.deepStrictEqual(x.body.offers.map((o) => [o.offer_id, o.node_id, o.trust]), [['ovh-1', 'ovh-1', 'first-party'], ['ovh-1-gpu', null, 'external'], ['pi-1', 'pi-1', 'community']]);
    assert.deepStrictEqual(x.body.offers[0].capacity, { cpu: { utilization: 0.2, available_cores: 6 } });
    assert.strictEqual((await call('GET', '/internal/registry/cells/nope-1', null, live)).status, 404);
    console.log('cells-registry: all tests passed');
} finally {
    server.close();
}
})().catch((err) => { console.error(err); process.exit(1); });
