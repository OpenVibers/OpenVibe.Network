'use strict';
// Pairing a person's machine (plan T2, docs/t2-cells-and-node-principal.md sections 4.2 and 7, slice N4b): Bot's five
// pairing checks (OpenVibe.Bot test/pairing.test.js: one use, 10 min expiry, 5 tries, never logged nor read, revoke),
// the read and revoke scoped to the service that paired, and a paired machine that never becomes a platform machine.
//   node test/node-pairing.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
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
// A second service holding network.node.manage, to prove each service sees only what it paired.
await db.prepare("INSERT INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES ('live', 'network.node.manage', 'openvibe.network', '[]', 'test') ON CONFLICT DO NOTHING").run();

const subject = () => `usr_${ids.ulid()}`;
const alex = subject(); const banned = subject(); const gone = subject();
await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id, is_banned, deleted_at) VALUES
    (9101, 'pairalex', 'Alex', 'x', ?, 0, NULL), (9102, 'pairbanned', 'Banned', 'x', ?, 1, NULL), (9103, 'pairgone', 'Gone', 'x', ?, 0, '2026-09-01T00:00:00Z')`).run(alex, banned, gone);
await db.prepare("INSERT INTO platform_regions (id, country) VALUES ('eu-west', 'IE') ON CONFLICT DO NOTHING").run();
await db.prepare("INSERT INTO platform_cells (id, region, residency, status) VALUES ('weur-1', 'eu-west', 'EU', 'active'), ('wnam-2', 'us-west', 'US', 'planned') ON CONFLICT DO NOTHING").run();

const clock = { offset: 0 };
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const app = express();
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
const nodeRouters = require('../server/registry/nodes').routers({ guard: principals.guard('network.node.report') });
app.use('/api/v1/nodes', nodeRouters.pub);
app.use('/internal/nodes', nodeRouters.internal);
const pr = nodePrincipals.routers({ guard: principals.guard('network.node.manage'), now: () => Date.now() + clock.offset });
app.use('/api/v1/node-pairing', pr.pairing);
app.use('/internal', pr.internal);
const server = http.createServer(app);

// Everything written to stdout or stderr while the routes run, to prove no secret reaches a log line.
const logs = [];
const out = process.stdout.write.bind(process.stdout);
const err = process.stderr.write.bind(process.stderr);
process.stdout.write = (c, ...a) => { logs.push(String(c)); return out(c, ...a); };
process.stderr.write = (c, ...a) => { logs.push(String(c)); return err(c, ...a); };

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const token = async (id, secret) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network' }) })).json()).access_token;
const call = (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
    .then(async (x) => { const text = await x.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: x.status, headers: x.headers, text, body: json }; });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; log(`  ok ${name}`); };
try {
    const bot = bearer(await token('bot', 'bot-secret'));
    const live = bearer(await token('live', 'live-secret'));
    const host = bearer(await token('host', 'host-secret'));
    const mint = (ref = `robot-${ids.ulid()}`, extra = {}) => call('POST', '/internal/node-pairings', { owner: { kind: 'user', subject: alex }, ref, ...extra }, bot);
    const redeem = (body) => call('POST', '/api/v1/node-pairing', body);

    await check('minting a code needs network.node.manage and a live person', async () => {
        assert.strictEqual((await call('POST', '/internal/node-pairings', { owner: { kind: 'user', subject: alex }, ref: 'r' })).status, 403, 'no token');
        assert.strictEqual((await call('POST', '/internal/node-pairings', { owner: { kind: 'user', subject: alex }, ref: 'r' }, host)).status, 403, 'host lacks network.node.manage');
        for (const s of [subject(), banned, gone]) {
            const r = await call('POST', '/internal/node-pairings', { owner: { kind: 'user', subject: s }, ref: 'r' }, bot);
            assert.deepStrictEqual([r.status, r.body.code], [404, 'registry.unknown_owner']);
        }
        const p = await call('POST', '/internal/node-pairings', { owner: { kind: 'project', project_id: 'prj_x' }, ref: 'r' }, bot);
        assert.deepStrictEqual([p.status, p.body.code], [501, 'registry.not_yet']);
        const planned = await mint(undefined, { home_cell: 'wnam-2' });
        assert.deepStrictEqual([planned.status, planned.body.code], [409, 'registry.cell_not_active']);
        assert.strictEqual((await mint(undefined, { home_cell: 'nope-9' })).status, 400);
        assert.strictEqual((await call('POST', '/internal/node-pairings', { owner: { kind: 'user', subject: alex } }, bot)).status, 400, 'ref is required');
    });

    await check('a code is shown once, stored only as its sha256, and replaces that ref\'s unused code', async () => {
        const ref = 'robot-replace';
        const first = await mint(ref);
        assert.strictEqual(first.status, 201, first.text);
        assert.match(first.body.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        assert.match(first.body.pairing_id, /^pair_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(first.headers.get('cache-control'), 'no-store');
        const row = await db.prepare('SELECT * FROM platform_node_pairings WHERE id = ?').get(first.body.pairing_id);
        assert.strictEqual(row.code_hash, crypto.createHash('sha256').update(first.body.code.replace('-', '')).digest('hex'));
        assert.ok(!JSON.stringify(row).includes(first.body.code.replace('-', '')), 'the code is not stored in the clear');
        assert.deepStrictEqual([row.service, row.ref, row.owner_subject, row.created_by], ['bot', ref, alex, 'svc:bot']);
        const second = await mint(ref);
        assert.strictEqual(await db.prepare('SELECT 1 FROM platform_node_pairings WHERE id = ?').get(first.body.pairing_id), undefined, 'the older unused code is gone');
        const old = await redeem({ code: first.body.code });
        assert.deepStrictEqual([old.status, old.body.code], [403, 'registry.pairing_code_invalid']);
        assert.strictEqual((await redeem({ code: second.body.code })).status, 201);
    });

    await check('a pairing code works exactly once', async () => {
        const { body: pairing } = await mint();
        const first = await redeem({ pairing: pairing.pairing_id, code: pairing.code, name: 'Rover' });
        assert.strictEqual(first.status, 201, first.text);
        assert.match(first.body.principal, /^nod_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(first.body.node_id, `n-${first.body.principal.slice(4).toLowerCase()}`);
        assert.strictEqual(first.body.node_id.length, 28);
        assert.ok(first.body.credential.length >= 40);
        assert.strictEqual(first.body.token_endpoint, 'https://openvibe.network/oauth/token');
        assert.deepStrictEqual(first.body.paired_for, { service: 'bot', ref: (await db.prepare('SELECT ref FROM platform_node_pairings WHERE id = ?').get(pairing.pairing_id)).ref });
        assert.strictEqual(first.headers.get('cache-control'), 'no-store');
        const p = await db.prepare('SELECT * FROM platform_node_principals WHERE id = ?').get(first.body.principal);
        assert.deepStrictEqual([p.owner_kind, p.owner_subject, p.trust, p.status, p.name, p.created_by, p.paired_by_service],
            ['user', alex, 'community', 'active', 'Rover', `pairing:${pairing.pairing_id}`, 'bot']);
        assert.strictEqual(p.credential_hash, crypto.createHash('sha256').update(first.body.credential).digest('hex'), 'only the credential\'s sha256 is stored');
        const code = await db.prepare('SELECT used_at, principal_id FROM platform_node_pairings WHERE id = ?').get(pairing.pairing_id);
        assert.ok(code.used_at);
        assert.strictEqual(code.principal_id, first.body.principal);
        for (const again of [await redeem({ pairing: pairing.pairing_id, code: pairing.code }), await redeem({ code: pairing.code })]) {
            assert.deepStrictEqual([again.status, again.body.code], [403, 'registry.pairing_code_used']);
        }
    });

    await check('a pairing code expires after 10 minutes', async () => {
        const { body: pairing } = await mint();
        assert.ok(Math.abs(Date.parse(pairing.expires_at) - Date.now() - nodePrincipals.CODE_TTL_MS) < 5000 && nodePrincipals.CODE_TTL_MS === 10 * 60 * 1000, 'the code lives 10 minutes');
        clock.offset += 10 * 60 * 1000 + 1000;
        const late = await redeem({ pairing: pairing.pairing_id, code: pairing.code });
        clock.offset -= 10 * 60 * 1000 + 1000;
        assert.deepStrictEqual([late.status, late.body.code], [403, 'registry.pairing_code_expired']);
        assert.strictEqual((await db.prepare('SELECT used_at FROM platform_node_pairings WHERE id = ?').get(pairing.pairing_id)).used_at, null);
    });

    await check('five wrong tries end the code', async () => {
        const { body: pairing } = await mint();
        const wrong = pairing.code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA';
        for (let i = 1; i <= 5; i++) {
            const bad = await redeem({ pairing: pairing.pairing_id, code: wrong });
            assert.strictEqual(bad.status, 403, `try ${i}`);
            assert.strictEqual(bad.body.code, i < 5 ? 'registry.pairing_code_invalid' : 'registry.pairing_code_locked', `try ${i}`);
        }
        assert.strictEqual(Number((await db.prepare('SELECT tries FROM platform_node_pairings WHERE id = ?').get(pairing.pairing_id)).tries), 5);
        for (const correct of [await redeem({ pairing: pairing.pairing_id, code: pairing.code }), await redeem({ code: pairing.code })]) {
            assert.deepStrictEqual([correct.status, correct.body.code], [403, 'registry.pairing_code_locked']);
        }
        const shape = await redeem({ code: 'nope' });
        assert.deepStrictEqual([shape.status, shape.body.code], [422, 'registry.invalid_pairing_code']);
        const unknown = await redeem({ code: wrong });
        assert.deepStrictEqual([unknown.status, unknown.body.code], [403, 'registry.pairing_code_invalid']);
    });

    await check('the code and credential are never logged and never in a read answer', async () => {
        const { body: pairing } = await mint('robot-secret');
        const paired = await redeem({ pairing: pairing.pairing_id, code: pairing.code });
        const { credential, principal } = paired.body;
        const reads = [await call('GET', `/internal/node-principals/${principal}`, null, bot), await call('GET', '/api/v1/nodes'), await call('GET', '/api/v1/nodes', null, bot)];
        for (const r of reads) {
            assert.ok(!r.text.includes(credential), 'a read leaked the credential');
            assert.ok(!r.text.includes(pairing.code.replace('-', '')) && !r.text.includes(pairing.code), 'a read leaked the code');
            assert.ok(!/hash/i.test(r.text), 'a read exposed a hash');
        }
        const logged = logs.join('\n');
        assert.ok(!logged.includes(credential), 'the credential was logged');
        assert.ok(!logged.includes(pairing.code) && !logged.includes(pairing.code.replace('-', '')), 'the pairing code was logged');
    });

    await check('a service reads and revokes only the principals it paired', async () => {
        const { body: pairing } = await mint('robot-scope');
        const { body: paired } = await redeem({ pairing: pairing.pairing_id, code: pairing.code, region: 'eu-west' });
        const read = await call('GET', `/internal/node-principals/${paired.principal}`, null, bot);
        assert.strictEqual(read.status, 200, read.text);
        assert.deepStrictEqual(Object.keys(read.body).sort(), ['created_at', 'home_cell', 'last_seen_at', 'name', 'node_id', 'owner', 'paired_for', 'principal', 'revoked_at', 'status']);
        assert.deepStrictEqual([read.body.owner, read.body.paired_for, read.body.status], [{ kind: 'user', subject: alex }, { service: 'bot', ref: 'robot-scope' }, 'active']);
        for (const [m, p] of [['GET', `/internal/node-principals/${paired.principal}`], ['POST', `/internal/node-principals/${paired.principal}/revoke`]]) {
            const other = await call(m, p, null, live);
            assert.deepStrictEqual([other.status, other.body.code], [404, 'registry.unknown_node'], `${m} by another service`);
            assert.strictEqual((await call(m, p, null, host)).status, 403, `${m} without network.node.manage`);
        }
        assert.strictEqual((await call('GET', `/internal/node-principals/nod_${ids.ulid()}`, null, bot)).status, 404);
        assert.strictEqual((await db.prepare('SELECT status FROM platform_node_principals WHERE id = ?').get(paired.principal)).status, 'active', 'the other service changed nothing');
    });

    await check('revoke is scoped, clears the previous hash and is idempotent', async () => {
        const { body: pairing } = await mint('robot-revoke');
        const { body: paired } = await redeem({ pairing: pairing.pairing_id, code: pairing.code });
        await db.prepare("UPDATE platform_node_principals SET credential_prev_hash = ?, prev_valid_until = '2026-10-02T00:01:00Z' WHERE id = ?").run('b'.repeat(64), paired.principal);
        const r = await call('POST', `/internal/node-principals/${paired.principal}/revoke`, null, bot);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.status, 'revoked');
        assert.ok(r.body.revoked_at);
        const row = await db.prepare('SELECT * FROM platform_node_principals WHERE id = ?').get(paired.principal);
        assert.deepStrictEqual([row.status, row.revoked_by, row.credential_prev_hash, row.prev_valid_until], ['revoked', 'svc:bot', null, null]);
        clock.offset += 5000;
        const again = await call('POST', `/internal/node-principals/${paired.principal}/revoke`, null, bot);
        clock.offset -= 5000;
        assert.deepStrictEqual([again.status, again.body.revoked_at], [200, r.body.revoked_at], 'a second revoke changes nothing');
        assert.strictEqual((await call('GET', `/internal/node-principals/${paired.principal}`, null, bot)).body.status, 'revoked');
    });

    await check('pairing creates no platform machine; Host cannot report a paired node', async () => {
        const { body: pairing } = await mint('robot-platform');
        const { body: paired } = await redeem({ pairing: pairing.pairing_id, code: pairing.code });
        assert.strictEqual(await db.prepare('SELECT 1 FROM platform_nodes WHERE id = ?').get(paired.node_id), undefined, 'no platform_nodes row');
        const list = await call('GET', '/api/v1/nodes');
        assert.strictEqual(list.status, 200);
        assert.ok(!list.text.includes(paired.node_id), 'the paired machine is absent from the public node list');
        const report = await call('POST', '/internal/nodes/report', { source: 'primary', nodes: [{ id: paired.node_id, roles: ['app'], location: { region: 'us-west', country: 'US' }, health: { status: 'up', checked_at: '2026-10-01T12:00:00Z' }, updated_at: '2026-10-01T12:00:00Z' }] }, host);
        assert.deepStrictEqual([report.status, report.body.code], [409, 'registry.node_not_platform']);
        assert.strictEqual(await db.prepare('SELECT 1 FROM platform_nodes WHERE id = ?').get(paired.node_id), undefined, 'the refused report wrote nothing');
    });

    await check('the home cell is the code\'s, else the region\'s active cell, else wnam-1', async () => {
        const home = async (mintExtra, redeemExtra) => {
            const { body: pairing } = await mint(undefined, mintExtra);
            const r = await redeem({ pairing: pairing.pairing_id, code: pairing.code, ...redeemExtra });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual((await db.prepare('SELECT home_cell FROM platform_node_principals WHERE id = ?').get(r.body.principal)).home_cell, r.body.home_cell);
            return r.body.home_cell;
        };
        assert.strictEqual(await home({}, { region: 'eu-west' }), 'weur-1');
        assert.strictEqual(await home({ home_cell: 'wnam-1' }, { region: 'eu-west' }), 'wnam-1', 'the code\'s cell wins');
        assert.strictEqual(await home({}, { region: 'ap-south' }), 'wnam-1', 'a region without a cell');
        assert.strictEqual(await home({}, {}), 'wnam-1');
    });
    log(`node-pairing: ${passed} checks passed`);
} finally {
    process.stdout.write = out;
    process.stderr.write = err;
    server.close();
    await db.close?.();
}
})().catch((e) => { console.error(e); process.exit(1); });
