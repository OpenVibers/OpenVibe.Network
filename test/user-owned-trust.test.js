'use strict';
// The user-owned trust class (ADR-046, migrations/0020_user_owned_trust.sql) on a database that production already
// migrated: a database at 0019 holding offers and node principals gains the class from the normal runner, once, with
// every existing row untouched. A person's own Node then holds a user-owned principal, reports a user-owned offer and
// is listed with it; a project's machine is never user-owned, and a trust value outside the five is still refused.
//   node test/user-owned-trust.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTestDb } = require('openvibe-sdk/testing');
const { createDb } = require('openvibe-sdk/db');
const offers = require('../server/registry/offers');
const cells = require('../server/registry/cells');
const nodePrincipals = require('../server/registry/node-principals');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const quiet = { log() {}, warn() {}, error() {} };

(async () => {
    // What production ran before this release: the migrations up to 0019.
    const before = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-user-owned-'));
    for (const f of fs.readdirSync(MIGRATIONS)) if (/^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) <= '0019') fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    const t = await createTestDb({ migrations: before, store: process.env.NETWORK_TEST_STORE || 'pglite', service: 'network', log: quiet });
    const asOwner = async (fn) => {
        if (!t.directUrl) return fn(t.db);
        const owner = createDb({ url: t.directUrl, service: 'network-test-owner', max: 1, log: quiet });
        try { return await fn(owner); } finally { await owner.close(); }
    };
    const db = t.db;
    // The rows of the cutover rehearsal's seed (docs/cutover-t14-user-owned-trust.md): its project and person.
    const prj = 'prj_0000000000000000000000RH01', usr = 'usr_0000000000000000000000RH01', hash = (c) => c.repeat(64);
    const principal = (p) => db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, project_id, owner_subject, trust, created_by, credential_hash)
        VALUES (?, ?, 'wnam-1', ?, ?, ?, ?, 'test', ?)`).run(p.id, p.node_id, p.owner_kind, p.project_id ?? null, p.owner_subject ?? null, p.trust, p.credential_hash ?? null);
    const offer = (id, extra = {}) => ({ offer_id: id, kind: 'node', node_id: id, provider: 'self', region: 'us-west', cell: 'wnam-1', trust: 'user-owned',
        capabilities: ['node:http', 'worker:function'], capacity: { cpu: { utilization: 0.1, available_cores: 8 } }, health: { status: 'up' },
        pricing: { model: 'free-allowance' }, updated_at: '2026-10-04T00:00:00Z', ...extra });
    const trustCheck = async (table) => (await db.prepare(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = ?::regclass AND conname = ?`).get(table, `${table}_trust_check`))?.def || '';
    try {
        // ── Before: the rows production may hold, and user-owned refused by both tables.
        await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'rehearsal', 'user-owned-trust.sql'), 'utf8'));
        await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'rehearsal', 'user-owned-trust.sql'), 'utf8')); // repeatable
        await offers.report(db, { source: 'host', offers: [offer('rh-user-2', { node_id: 'rh-user', trust: 'community' })] });
        assert.ok(!(await trustCheck('platform_resource_offers')).includes('user-owned') && !(await trustCheck('platform_node_principals')).includes('user-owned'));
        await assert.rejects(principal({ id: `nod_${'C'.repeat(26)}`, node_id: 'early', owner_kind: 'user', owner_subject: usr, trust: 'user-owned', credential_hash: hash('c') }), 'refused before 0020');
        const rows = async () => ({
            principals: await db.prepare('SELECT * FROM platform_node_principals ORDER BY id').all(),
            offers: await db.prepare('SELECT * FROM platform_resource_offers ORDER BY id').all(),
        });
        const seeded = await rows();

        // ── 0020 applies on top of 0019, once, and rewrites nothing.
        const first = await asOwner((o) => o.migrate({ dir: MIGRATIONS, log: quiet }));
        assert.deepStrictEqual(first.applied.map((m) => [m.id, m.name, m.phase]), [['0020', 'user_owned_trust', 'expand']]);
        assert.deepStrictEqual((await asOwner((o) => o.migrate({ dir: MIGRATIONS, log: quiet }))).applied, [], 'already applied');
        await asOwner((o) => o.exec(fs.readFileSync(path.join(MIGRATIONS, '0020_user_owned_trust.sql'), 'utf8'))); // safe to run twice
        assert.deepStrictEqual(await rows(), seeded, 'no existing row changes');
        for (const table of ['platform_resource_offers', 'platform_node_principals']) {
            assert.match(await trustCheck(table), /'user-owned'/, `${table}_trust_check names user-owned`);
            const n = await db.prepare("SELECT count(*) AS n FROM pg_constraint WHERE conrelid = ?::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%trust%first-party%partner%'").get(table);
            assert.strictEqual(Number(n.n), 1, `${table}: the old trust CHECK is gone, not kept beside the new one`);
        }

        // ── A person's own Node: a user-owned principal, listed with its trust class.
        await principal({ id: `nod_${'D'.repeat(26)}`, node_id: 'my-node', owner_kind: 'user', owner_subject: usr, trust: 'user-owned', credential_hash: hash('d') });
        const mine = (await nodePrincipals.listPrincipals(db, { owner_kind: 'user' })).find((p) => p.node_id === 'my-node');
        assert.deepStrictEqual([mine.owner, mine.trust], [{ kind: 'user', subject: usr }, 'user-owned']);

        // Its user-owned offer passes the contract and the placement check, is stored with the class, and is listed.
        const report = { source: 'my-node', offers: [offer('my-node')] };
        assert.strictEqual(offers.check(report), null);
        assert.strictEqual(await cells.checkPlacement(db, [{ cell: 'wnam-1', node_id: 'my-node', trust: 'user-owned' }]), null);
        await offers.report(db, report);
        assert.strictEqual((await db.prepare('SELECT trust FROM platform_resource_offers WHERE id = ?').get('my-node')).trust, 'user-owned');
        assert.deepStrictEqual((await offers.list(db, { trust: 'user-owned' })).map((o) => [o.offer_id, o.trust]), [['my-node', 'user-owned']]);
        // The principal's class still binds the offer: a community machine cannot report itself user-owned.
        assert.strictEqual((await cells.checkPlacement(db, [{ cell: 'wnam-1', node_id: 'rh-user', trust: 'user-owned' }])).code, 'registry.trust_mismatch');

        // ── Still refused: a project's machine as user-owned, a user's machine as partner, and any unknown class.
        await assert.rejects(principal({ id: `nod_${'E'.repeat(26)}`, node_id: 'prj-node', owner_kind: 'project', project_id: prj, trust: 'user-owned', credential_hash: hash('e') }), 'a project machine is never user-owned');
        await assert.rejects(principal({ id: `nod_${'F'.repeat(26)}`, node_id: 'usr-partner', owner_kind: 'user', owner_subject: usr, trust: 'partner', credential_hash: hash('f') }), 'a user machine is community or user-owned');
        await assert.rejects(principal({ id: `nod_${'G'.repeat(26)}`, node_id: 'stranger', owner_kind: 'user', owner_subject: usr, trust: 'stranger', credential_hash: hash('9') }), 'an unknown class is refused by the principals table');
        await assert.rejects(db.prepare(`INSERT INTO platform_resource_offers (id, source, kind, region, cell, trust, status, doc, reported_at)
            VALUES ('odd', 'test', 'node', 'us-west', 'wnam-1', 'stranger', 'up', '{}', '2026-10-04T00:00:00Z')`).run(), 'an unknown class is refused by the offers table');
        assert.ok(offers.check({ source: 'my-node', offers: [offer('my-node', { trust: 'stranger' })] }), 'and by the contract before anything is written');

        console.log('user-owned trust: all tests passed');
    } finally {
        await t.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
