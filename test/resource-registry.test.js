'use strict';
// The resource registry (plan T2, docs/t2-cells-and-node-principal.md section 6):
// POST /internal/resources/report takes network.resource.report; the whole batch is validated before anything is written;
// an offer missing from the same source's next report is marked down, not deleted; the filter columns always equal
// the stored doc through the one mapping offers.columns(). GET /api/v1/resources filters in SQL, hides down offers by
// default and never shows capacity; GET /internal/resources, behind the report's guard, returns the docs whole.
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
const r = offers.routers({ guard: principals.guard('network.resource.report', { legacy: false }) });
app.use('/api/v1/resources', r.pub);
app.use('/internal/resources', r.internal);
app.use(require('../server/registry/ecosystem').createEcosystemRegistry().router());
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
    const token = async (id, secret, scope) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network', ...(scope ? { scope } : {}) }) })).json()).access_token;
    const post = (body, headers) => fetch(`${base}/internal/resources/report`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
        .then(async (x) => ({ status: x.status, headers: x.headers, body: await x.json().catch(() => null) }));
    try {
        // The kind constraint is widened, remains strict, and can be applied twice.
        const migration = fs.readFileSync(path.join(__dirname, '../migrations/0009_resource_offer_kinds.sql'), 'utf8');
        await globalThis.__ovNetworkDdl(migration);
        await globalThis.__ovNetworkDdl(migration);
        const insert = (kind, status) => db.prepare("INSERT INTO platform_resource_offers (id, source, kind, region, trust, status, doc, reported_at) VALUES ('x', 'x', ?, 'us-west', 'partner', ?, '{}', 'now')").run(kind, status);
        await insert('storage', 'up');
        await db.prepare("DELETE FROM platform_resource_offers WHERE id = 'x'").run();
        await assert.rejects(insert('unknown', 'up'), 'kind outside the seven-kind enum');
        await assert.rejects(insert('node', 'gone'), 'status outside up|degraded|down|draining');
        assert.deepStrictEqual(await rows(), []);

        // 1. Auth matrix.
        const auth = { authorization: `Bearer ${await token('host', 'host-secret')}` };
        const resourceOnly = { authorization: `Bearer ${await token('host', 'host-secret', 'network.resource.report')}` };
        const nodeOnly = { authorization: `Bearer ${await token('host', 'host-secret', 'network.node.report')}` };
        assert.strictEqual((await post({ source: 'oregon', offers: [] })).status, 403, 'nobody');
        assert.ok([401, 403].includes((await post({ source: 'oregon', offers: [] }, { 'x-internal-key': 'legacy-key' })).status), 'not the retired shared key');
        assert.strictEqual((await post({ source: 'oregon', offers: [] }, { authorization: `Bearer ${await token('live', 'live-secret')}` })).status, 403, 'Live lacks network.resource.report');
        assert.strictEqual((await post({ source: 'oregon', offers: [] }, nodeOnly)).status, 403, 'network.node.report alone cannot report resources');
        assert.strictEqual((await post({ source: 'oregon', offers: [] }, resourceOnly)).status, 200, 'network.resource.report can report resources');

        // 2. Validation writes nothing: bad offers, a bad envelope, and a bad offer last in an otherwise good batch.
        for (const [why, body] of [
            ['trust outside the enum', { source: 'oregon', offers: [offer('o-1', { trust: 'random' })] }],
            ['region missing', { source: 'oregon', offers: [(({ region, ...o }) => o)(offer('o-1'))] }],
            ['additionalProperties: false', { source: 'oregon', offers: [offer('o-1', { address: '10.0.0.1' })] }],
            ['new kind without detail', { source: 'oregon', offers: [offer('o-1', { kind: 'storage' })] }],
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

        // 5. Filters. A third source adds the trust classes, a second region, a free and a dear offer, degraded and draining.
        x = await post({ source: 'lab', offers: [
            offer('l-1', { trust: 'community' }),
            offer('l-2', { kind: 'provider', node_id: undefined, adapter: 'nats-v1', trust: 'partner', region: 'us-east', cell: undefined, pricing: { model: 'free-allowance' }, health: { status: 'degraded', checked_at: '2026-10-01T12:00:00Z' } }),
            offer('l-3', { trust: 'external', pricing: { model: 'per-request', marginal_usd_per_unit: 0.2, unit: 'request' }, health: { status: 'draining', checked_at: '2026-10-01T12:00:00Z' } }),
        ] }, auth);
        assert.strictEqual(x.status, 200, JSON.stringify(x.body));
        const get = (url, headers) => fetch(`${base}${url}`, { headers }).then(async (y) => ({ status: y.status, headers: y.headers, body: y.status === 204 ? null : await y.json() }));
        const ids = async (q, prefix = '/api/v1/resources', headers) => {
            const y = await get(`${prefix}${q}`, headers);
            assert.strictEqual(y.status, 200, `${prefix}${q}`);
            assert.strictEqual(y.body.count, y.body.offers.length, `${q}: count`);
            assert.ok(!Number.isNaN(Date.parse(y.body.generated_at)));
            return y.body.offers.map((o) => o.offer_id);
        };
        for (const [q, want] of [
            ['', ['f-1', 'l-1', 'l-2', 'l-3', 'o-2']],
            ['?status=down', ['o-1', 'o-3']],
            ['?status=draining', ['l-3']],
            ['?kind=provider', ['l-2', 'o-2']],
            ['?region=us-east', ['l-2']],
            ['?trust=community', ['l-1']],
            ['?max_price_usd=0.05', ['f-1', 'l-1', 'l-2', 'o-2']],
            ['?max_price_usd=0', ['l-2']],
            ['?cell=weur-1', ['f-1']],
            ['?cell=wnam-1', ['l-1', 'l-2', 'l-3', 'o-2']],
            ['?kind=node&cell=wnam-1&max_price_usd=0.05', ['l-1']],
            ['?kind=storage', []],
            ['?max_price_usd=cheap&colour=blue', ['f-1', 'l-1', 'l-2', 'l-3', 'o-2']],
        ]) assert.deepStrictEqual(await ids(q), want, q || 'the default hides down offers');
        x = await get('/api/v1/resources?kind=storage&max_price_usd=0.05&trust=partner&colour=blue');
        assert.deepStrictEqual(x.body, { offers: [], generated_at: x.body.generated_at, filters: { kind: 'storage', trust: 'partner', max_price_usd: 0.05 }, count: 0 }, 'an unknown kind is an empty 200');
        const stored = new Map((await rows()).map((o) => [o.id, JSON.parse(o.doc)]));
        // The public list never carries capacity; every element is still a contract document, otherwise verbatim.
        for (const q of ['', '?status=down', '?kind=provider']) {
            for (const o of (await get(`/api/v1/resources${q}`)).body.offers) {
                assert.ok(!('capacity' in o), `${o.offer_id}: no capacity in public`);
                assert.ok(validate(offers.CONTRACT, o).valid, `${o.offer_id}: public doc matches the contract`);
                assert.deepStrictEqual(o, offers.publicDoc(stored.get(o.offer_id)));
            }
        }
        // The internal list: the report's guard, the same filters, the docs whole.
        assert.strictEqual((await get('/internal/resources')).status, 403, 'nobody');
        assert.ok([401, 403].includes((await get('/internal/resources', { 'x-internal-key': 'legacy-key' })).status), 'not the retired shared key');
        assert.strictEqual((await get('/internal/resources', { authorization: `Bearer ${await token('live', 'live-secret')}` })).status, 403, 'Live lacks network.resource.report');
        assert.strictEqual((await get('/internal/resources', nodeOnly)).status, 403, 'node reporting cannot read full resources');
        assert.strictEqual((await get('/internal/resources', resourceOnly)).status, 200, 'resource reporting can read full resources');
        x = await get('/internal/resources', auth);
        assert.strictEqual(x.status, 200);
        assert.strictEqual(x.headers.get('cache-control'), 'no-store');
        assert.deepStrictEqual(x.body.offers, ['f-1', 'l-1', 'l-2', 'l-3', 'o-2'].map((id) => stored.get(id)), 'verbatim, capacity included');
        assert.ok(x.body.offers.every((o) => o.capacity), 'every internal offer has its capacity');
        assert.deepStrictEqual(await ids('?kind=provider&status=degraded', '/internal/resources', auth), ['l-2']);
        assert.deepStrictEqual(await ids('?status=down', '/internal/resources', auth), ['o-1', 'o-3']);

        // 6. Single read: internal whole, public minus capacity, both platform.resource-offer@1; a down offer is readable.
        for (const id of ['l-1', 'o-1']) {
            x = await get(`/internal/resources/${id}`, auth);
            assert.strictEqual(x.status, 200);
            assert.ok(validate(offers.CONTRACT, x.body).valid);
            assert.deepStrictEqual(x.body, stored.get(id));
            assert.ok(x.body.capacity);
            x = await get(`/api/v1/resources/${id}`);
            assert.strictEqual(x.status, 200);
            assert.ok(validate(offers.CONTRACT, x.body).valid);
            assert.deepStrictEqual(x.body, offers.publicDoc(stored.get(id)));
            assert.ok(!('capacity' in x.body));
        }
        assert.strictEqual((await get('/internal/resources/l-1')).status, 403, 'the internal single read takes the guard too');
        for (const [url, headers] of [['/api/v1/resources/nope'], ['/internal/resources/nope', auth]]) {
            x = await get(url, headers);
            assert.strictEqual(x.status, 404, url);
            assert.strictEqual(x.headers.get('content-type'), 'application/problem+json', url);
            assert.strictEqual(x.body.code, 'registry.unknown_offer', url);
        }

        // 7. Headers: list and single cacheable for a minute and open to any origin; the beacon 204 and never cached.
        for (const url of ['/api/v1/resources', '/api/v1/resources?kind=provider', '/api/v1/resources/l-1']) {
            x = await get(url);
            assert.strictEqual(x.headers.get('cache-control'), 'public, max-age=60', url);
            assert.strictEqual(x.headers.get('access-control-allow-origin'), '*', url);
            assert.strictEqual(x.headers.get('timing-allow-origin'), '*', url);
        }
        x = await get('/api/v1/resources/l-1/beacon');
        assert.strictEqual(x.status, 204);
        assert.strictEqual(x.headers.get('cache-control'), 'no-store');
        assert.strictEqual(x.headers.get('access-control-allow-origin'), '*');
        assert.strictEqual(x.headers.get('timing-allow-origin'), '*');

        // 9. Placement proof (slice 4): the public list feeds openvibe-sdk/placement unchanged. Three up offers in
        // their own region — two providers and a node, different marginal prices; `cheapest` must pick the cheapest
        // eligible one from a result that matches platform.placement-result@1.
        x = await post({ source: 'proof', offers: [
            offer('p-node', { region: 'us-central', trust: 'community', pricing: { model: 'per-request', marginal_usd_per_unit: 0.05, unit: 'request' } }),
            offer('p-provider', { kind: 'provider', node_id: undefined, adapter: 'nats-v1', region: 'us-central', trust: 'community', pricing: { model: 'per-request', marginal_usd_per_unit: 0.02, unit: 'request' } }),
            offer('p-provider-b', { kind: 'provider', node_id: undefined, adapter: 'http-v1', region: 'us-central', trust: 'community', pricing: { model: 'per-request', marginal_usd_per_unit: 0.03, unit: 'request' } }),
        ] }, auth);
        assert.strictEqual(x.status, 200, JSON.stringify(x.body));
        const idx = await get('/api/v1/registry');
        assert.strictEqual(idx.body.resources, '/api/v1/resources', 'the registry index advertises the resource list');
        const pub = await get('/api/v1/resources');
        assert.strictEqual(pub.status, 200);
        const req = { kind: 'request', mobility: 'request', latency_class: 'interactive', objective: 'cheapest', region: 'us-central', capabilities: [], units: 1 };
        const result = require('openvibe-sdk/placement').plan(req, pub.body.offers, { now });
        const check = validate('platform.placement-result@1', result);
        assert.ok(check.valid, JSON.stringify(check.errors));
        assert.strictEqual(result.selected, 'p-provider', 'the cheaper eligible offer wins');
        assert.deepStrictEqual(result.candidates.filter((c) => c.eligible).map((c) => c.id).sort(), ['p-node', 'p-provider', 'p-provider-b']);

        // 10. v0.85.0 detail contracts: all five new kinds report and filter independently.
        const kinds = ['storage', 'delivery', 'runtime', 'agent', 'harness'];
        const detailOf = (kind) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/resource-offers', `${kind}.json`), 'utf8'));
        const kindOffer = (kind, detail = detailOf(kind), extra = {}) => offer(detail.id, { kind, node_id: undefined, detail, ...extra });
        for (const kind of kinds) {
            const doc = kindOffer(kind);
            assert.ok(validate(offers.CONTRACT, doc).valid, `${kind} fixture matches the pinned envelope contract`);
            x = await post({ source: `kind-${kind}`, offers: [doc] }, resourceOnly);
            assert.strictEqual(x.status, 200, `${kind}: ${JSON.stringify(x.body)}`);
            assert.deepStrictEqual(await ids(`?kind=${kind}`), [doc.offer_id], `${kind} filter`);
        }
        await assertLockstep();

        // Contract rejection and Network-local cross-checks reject the entire report before a write.
        for (const [why, bad, error] of [
            ['storage without detail', offer('bad-storage', { kind: 'storage', node_id: undefined, detail: undefined }), 'offer 0 does not match platform.resource-offer@1'],
            ['node with detail', offer('bad-node', { detail: detailOf('storage') }), 'offer 0 does not match platform.resource-offer@1'],
            ['detail id mismatch', kindOffer('storage', detailOf('storage'), { offer_id: 'another-id' }), 'registry.detail_id_mismatch'],
            ['detail node mismatch', kindOffer('storage', detailOf('storage'), { node_id: 'another-node' }), 'registry.detail_node_mismatch'],
            ['detail region mismatch', kindOffer('storage', { ...detailOf('storage'), region: 'us-east' }), 'registry.detail_region_mismatch'],
            ['detail regions mismatch', kindOffer('delivery', { ...detailOf('delivery'), regions: ['us-east'] }), 'registry.detail_region_mismatch'],
        ]) {
            const unchanged = await rows();
            const batch = why === 'detail id mismatch' ? [kindOffer('agent'), bad] : [bad];
            x = await post({ source: `bad-${why.replaceAll(' ', '-')}`, offers: batch }, resourceOnly);
            assert.strictEqual(x.status, 400, why);
            assert.strictEqual(x.body.error, error, why);
            assert.deepStrictEqual(await rows(), unchanged, `${why}: nothing written`);
        }

        const harnessId = detailOf('harness').id;
        const harnessPublic = await get(`/api/v1/resources/${harnessId}`);
        const harnessInternal = await get(`/internal/resources/${harnessId}`, resourceOnly);
        assert.strictEqual(harnessPublic.status, 200);
        assert.strictEqual(harnessInternal.status, 200);
        assert.ok(!('address' in harnessPublic.body.detail), 'public single read omits the harness address');
        assert.deepStrictEqual(harnessInternal.body.detail.address, detailOf('harness').address, 'internal single read keeps the address');
        const publicHarnessList = await get('/api/v1/resources?kind=harness');
        const internalHarnessList = await get('/internal/resources?kind=harness', resourceOnly);
        assert.ok(!('address' in publicHarnessList.body.offers[0].detail), 'public list omits the harness address');
        assert.deepStrictEqual(internalHarnessList.body.offers[0].detail.address, detailOf('harness').address, 'internal list keeps the address');
        console.log('resource-registry: all tests passed');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
