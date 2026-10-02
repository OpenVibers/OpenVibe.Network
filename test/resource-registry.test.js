'use strict';
// The resource registry, slice 1 (plan T2, docs/t2-resource-registry.md; Contracts platform.resource-offer@1):
// POST /internal/resources/report takes Host's token only; the whole batch is validated before anything is written;
// an offer missing from the same source's next report is marked down, not deleted; the filter columns always equal
// the stored doc through the one mapping offers.columns().
//   node test/resource-registry.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const offers = require('../server/registry/offers');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-offers-'));
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare("UPDATE oauth_clients SET client_secret = 'host-secret' WHERE client_id = 'host'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const app = express();
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
const r = offers.routers({ guard: principals.guard('network.node.report', { legacy: false }) });
app.use('/internal/resources', r.internal);
const server = http.createServer(app);

const offer = (id, extra = {}) => ({ offer_id: id, kind: 'node', node_id: id, provider: 'ovh', region: 'us-west', cell: 'wnam-1', trust: 'first-party', capabilities: ['node:http', 'events:gateway'], capacity: { cpu: { utilization: 0.2, available_cores: 6 } }, health: { status: 'up', checked_at: '2026-10-01T12:00:00Z' }, pricing: { model: 'prepaid', marginal_usd_per_unit: 0.01, unit: 'request' }, updated_at: '2026-10-01T12:00:00Z', ...extra });
const rows = async () => db.prepare('SELECT * FROM platform_resource_offers ORDER BY id').all();
// Design §2, invariants 1-2: every column equals the mapping of the stored doc, which is itself a contract document.
const assertLockstep = async () => {
    for (const row of await rows()) {
        const doc = JSON.parse(row.doc);
        assert.ok(validate(offers.CONTRACT, doc).valid, `${row.id}: the stored doc matches the contract`);
        const want = offers.columns(doc);
        for (const k of Object.keys(want)) assert.strictEqual(k === 'price_usd' ? Number(row[k]) : row[k], want[k], `${row.id}.${k} is in lockstep with doc`);
    }
};

(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = async (id, secret) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network' }) })).json()).access_token;
    const post = (body, headers) => fetch(`${base}/internal/resources/report`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
        .then(async (x) => ({ status: x.status, headers: x.headers, body: await x.json().catch(() => null) }));
    try {
        // The migration: the table exists, kind is exactly the pinned contract's enum, status the planner's.
        const insert = (kind, status) => db.prepare("INSERT INTO platform_resource_offers (id, source, kind, region, trust, status, doc, reported_at) VALUES ('x', 'x', ?, 'us-west', 'partner', ?, '{}', 'now')").run(kind, status);
        await assert.rejects(insert('storage', 'up'), 'kind storage has no contract at 0.83.0');
        await assert.rejects(insert('node', 'gone'), 'status outside up|degraded|down|draining');
        assert.deepStrictEqual(await rows(), []);

        // 1. Auth matrix.
        const auth = { authorization: `Bearer ${await token('host', 'host-secret')}` };
        assert.strictEqual((await post({ source: 'oregon', offers: [] })).status, 403, 'nobody');
        assert.ok([401, 403].includes((await post({ source: 'oregon', offers: [] }, { 'x-internal-key': 'legacy-key' })).status), 'not the retired shared key');
        assert.strictEqual((await post({ source: 'oregon', offers: [] }, { authorization: `Bearer ${await token('live', 'live-secret')}` })).status, 403, 'Live lacks network.node.report');

        // 2. Validation writes nothing: bad offers, a bad envelope, and a bad offer last in an otherwise good batch.
        for (const [why, body] of [
            ['trust outside the enum', { source: 'oregon', offers: [offer('o-1', { trust: 'random' })] }],
            ['region missing', { source: 'oregon', offers: [(({ region, ...o }) => o)(offer('o-1'))] }],
            ['additionalProperties: false', { source: 'oregon', offers: [offer('o-1', { address: '10.0.0.1' })] }],
            ['kind without a contract', { source: 'oregon', offers: [offer('o-1', { kind: 'storage' })] }],
            ['source pattern', { source: 'Oregon!', offers: [offer('o-1')] }],
            ['extra envelope key', { source: 'oregon', offers: [offer('o-1')], cell: 'wnam-1' }],
            ['offers not an array', { source: 'oregon', offers: offer('o-1') }],
            ['over 500 offers', { source: 'oregon', offers: Array.from({ length: 501 }, (_, i) => ({ offer_id: `n${i}` })) }],
        ]) {
            const x = await post(body, auth);
            assert.strictEqual(x.status, 400, why);
            assert.ok(typeof x.body.error === 'string', why);
        }
        assert.deepStrictEqual(await rows(), [], 'no bad report wrote anything');

        let x = await post({ source: 'oregon', offers: [offer('o-1')] }, auth);
        assert.strictEqual(x.status, 200, JSON.stringify(x.body));
        assert.deepStrictEqual([x.body.source, x.body.offers, x.body.marked_down], ['oregon', 1, 0]);
        assert.strictEqual(x.headers.get('x-offers-marked-down'), '0');
        const before = await rows();
        x = await post({ source: 'oregon', offers: [offer('o-2'), offer('o-3'), offer('o-4', { pricing: { model: 'free', marginal_usd_per_unit: 0 } })] }, auth);
        assert.strictEqual(x.status, 400);
        assert.strictEqual(x.body.error, 'offer 2 does not match platform.resource-offer@1');
        assert.ok(Array.isArray(x.body.details) && x.body.details.length > 0);
        assert.deepStrictEqual(await rows(), before, 'a bad offer last: no upsert of the good ones, o-1 not marked down');

        // 3. Upsert. One offer without cell and one without a marginal price, so both defaulted columns are covered.
        x = await post({ source: 'oregon', offers: [
            offer('o-1'),
            offer('o-2', { kind: 'provider', node_id: undefined, adapter: 'nats-v1', trust: 'partner', region: 'us-east', cell: undefined }),
            offer('o-3', { trust: 'community', pricing: { model: 'free-allowance' }, health: { status: 'draining' } }),
        ] }, auth);
        assert.strictEqual(x.status, 200, JSON.stringify(x.body));
        assert.strictEqual(x.body.offers, 3);
        let all = await rows();
        assert.deepStrictEqual(all.map((o) => [o.id, o.source, o.kind, o.cell, o.status, Number(o.price_usd)]),
            [['o-1', 'oregon', 'node', 'wnam-1', 'up', 0.01], ['o-2', 'oregon', 'provider', 'wnam-1', 'up', 0.01], ['o-3', 'oregon', 'node', 'wnam-1', 'draining', 0]]);
        assert.strictEqual(JSON.parse(all[1].doc).cell, undefined, 'the doc is stored as reported: the default lives in the column only');
        await assertLockstep();

        x = await post({ source: 'oregon', offers: [offer('o-1', { pricing: { model: 'per-request', marginal_usd_per_unit: 0.2, unit: 'request' } }), offer('o-2', { kind: 'provider', node_id: undefined, trust: 'partner', region: 'us-east', cell: undefined }), offer('o-3', { pricing: { model: 'free-allowance' }, health: { status: 'draining' } })] }, auth);
        assert.strictEqual(x.body.marked_down, 0);
        const o1 = (await rows()).find((o) => o.id === 'o-1');
        assert.strictEqual(Number(o1.price_usd), 0.2, 'the column follows a re-report');
        assert.strictEqual(JSON.parse(o1.doc).pricing.marginal_usd_per_unit, 0.2, 'and so does the doc');
        await assertLockstep();

        // 4. Mark-down: o-2 leaves oregon's report; frankfurt's offers are untouched; nothing is deleted.
        // An offer names a cell Network knows (migrations/0008), so frankfurt's cell is registered first.
        await db.prepare("INSERT INTO platform_regions (id, country) VALUES ('eu-central', 'DE')").run();
        await db.prepare("INSERT INTO platform_cells (id, region, residency, status) VALUES ('weur-1', 'eu-central', 'DE', 'planned')").run();
        x = await post({ source: 'frankfurt', offers: [offer('f-1', { region: 'eu-central', cell: 'weur-1' })] }, auth);
        assert.strictEqual(x.headers.get('x-offers-marked-down'), '0', 'a new source marks nothing of another source down');
        const now = Date.now();
        x = await post({ source: 'oregon', offers: [offer('o-1'), offer('o-3', { health: { status: 'draining' } })] }, auth);
        assert.strictEqual(x.status, 200);
        assert.strictEqual(x.headers.get('x-offers-marked-down'), '1');
        all = await rows();
        assert.deepStrictEqual(all.map((o) => [o.id, o.source, o.status]), [['f-1', 'frankfurt', 'up'], ['o-1', 'oregon', 'up'], ['o-2', 'oregon', 'down'], ['o-3', 'oregon', 'draining']]);
        const o2 = JSON.parse(all.find((o) => o.id === 'o-2').doc);
        assert.strictEqual(o2.health.status, 'down');
        assert.ok(Date.parse(o2.health.checked_at) >= now - 1000, 'checked_at is the mark-down time');
        await assertLockstep();
        x = await post({ source: 'oregon', offers: [offer('o-1'), offer('o-3', { health: { status: 'draining' } })] }, auth);
        assert.strictEqual(x.headers.get('x-offers-marked-down'), '0', 'a down offer is not marked down again');

        // An empty report from a source marks all of its remaining offers down (draining included).
        x = await post({ source: 'oregon', offers: [] }, auth);
        assert.strictEqual(x.headers.get('x-offers-marked-down'), '2');
        assert.deepStrictEqual((await rows()).map((o) => o.status), ['up', 'down', 'down', 'down']);
        await assertLockstep();

        // A down offer comes back up when its source reports it again.
        await post({ source: 'oregon', offers: [offer('o-2', { kind: 'provider', node_id: 'o-2' })] }, auth);
        assert.strictEqual((await rows()).find((o) => o.id === 'o-2').status, 'up');
        await assertLockstep();
        console.log('resource-registry: all tests passed');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
