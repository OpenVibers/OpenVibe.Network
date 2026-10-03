'use strict';
// The agents migrations (plan T2 WS-Z2 slices 2-3, migrations/0016_agents.sql and 0017_agent_grants.sql) reach a
// database that production already migrated: a database at 0015 without them gains them from the normal runner,
// once, and each file is safe to run twice. It also pins why it is 0016 and not the design's 0010: the openvibe-sdk/db runner tracks applied
// migrations by id but refuses a pending file numbered below one already applied.
//   node test/agent-schema.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTestDb } = require('openvibe-sdk/testing');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const quiet = { log() {}, warn() {}, error() {} };

(async () => {
    // A copy of the migrations up to 0015: what production ran before this release.
    const before = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-agent-schema-'));
    for (const f of fs.readdirSync(MIGRATIONS)) if (/^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) <= '0015') fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    assert.ok(fs.existsSync(path.join(MIGRATIONS, '0016_agents.sql')));
    assert.ok(!fs.readdirSync(MIGRATIONS).some((f) => /^001[0-3]_/.test(f)), '0010-0013 stay unused');

    const t = await createTestDb({ migrations: before, store: process.env.NETWORK_TEST_STORE || 'pglite', service: 'network', log: quiet });
    // Schema changes run as the owner (DATABASE_DIRECT_URL), as server/db/database.js does; PGlite has one role.
    const asOwner = async (fn) => {
        if (!t.directUrl) return fn(t.db);
        const owner = createDb({ url: t.directUrl, service: 'network-test-owner', max: 1, log: quiet });
        try { return await fn(owner); } finally { await owner.close(); }
    };
    const applied = async () => (await t.db.prepare('SELECT id FROM ov_migrations ORDER BY id').all()).map((r) => r.id);
    const hasAgents = async () => !!await t.db.prepare("SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'dev_agents'").get();
    try {
        assert.strictEqual((await applied()).pop(), '0015');
        assert.ok(!await hasAgents());

        // Step 0: a file numbered below an applied one is refused, never silently skipped.
        const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-agent-probe-'));
        for (const f of fs.readdirSync(before)) fs.copyFileSync(path.join(before, f), path.join(probe, f));
        fs.copyFileSync(path.join(MIGRATIONS, '0016_agents.sql'), path.join(probe, '0010_agents.sql'));
        await assert.rejects(asOwner((db) => db.migrate({ dir: probe, log: quiet })), /0010_agents\.sql is older than applied migration 001[45]/);
        assert.ok(!await hasAgents(), 'the refused file left nothing behind');

        // The real directory: 0016 applies on top of 0015, once.
        const first = await asOwner((db) => db.migrate({ dir: MIGRATIONS, log: quiet }));
        assert.deepStrictEqual(first.applied.map((m) => [m.id, m.name, m.phase]), [['0016', 'agents', 'expand'], ['0017', 'agent_grants', 'expand']]);
        assert.ok(await hasAgents());
        assert.deepStrictEqual((await asOwner((db) => db.migrate({ dir: MIGRATIONS, log: quiet }))).applied, [], 'already applied');
        // Expand only, IF NOT EXISTS throughout: running the file again changes nothing and fails nothing.
        for (const f of ['0016_agents.sql', '0017_agent_grants.sql']) await asOwner((db) => db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')));

        // The table works on the migrated database: ISO defaults like every other text timestamp, and the app host
        // must be an app of the agent's own project and environment.
        const prj = `prj_${'1'.repeat(26)}`, other = `prj_${'2'.repeat(26)}`, app = `app_${'3'.repeat(26)}`, usr = `usr_${'4'.repeat(26)}`;
        for (const p of [prj, other]) {
            await t.db.prepare("INSERT INTO dev_projects (id, owner_subject, name, environment_policy, allowance, created_at, created_by) VALUES (?, ?, 'p', 'sandbox', '[]', ?, 'test')").run(p, usr, new Date().toISOString());
        }
        await t.db.prepare("INSERT INTO dev_apps (id, project_id, name, environment, oauth_client_id, client_type, created_at, created_by) VALUES (?, ?, 'a', 'sandbox', ?, 'public', ?, 'test')").run(app, prj, app, new Date().toISOString());
        const agent = (id, projectId, env) => t.db.prepare("INSERT INTO dev_agents (id, project_id, owner_subject, host_kind, host_app_id, environment, name, created_by) VALUES (?, ?, ?, 'app', ?, ?, 'n', 'test')")
            .run(id, projectId, usr, app, env);
        await agent(`agt_${'5'.repeat(26)}`, prj, 'sandbox');
        const r = await t.db.prepare('SELECT created_at, updated_at, status FROM dev_agents').get();
        assert.match(r.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.deepStrictEqual([r.updated_at.length, r.status], [24, 'active']);
        await assert.rejects(agent(`agt_${'6'.repeat(26)}`, other, 'sandbox'), /foreign key/i, 'an app of another project');
        await assert.rejects(agent(`agt_${'7'.repeat(26)}`, prj, 'production'), /foreign key/i, 'an app of the other environment');

        // Delegated grants (0017): one row per (agent, capability), of an existing agent, with a known mode and status,
        // and a revoked row always says when.
        const now = new Date().toISOString();
        const grant = (g) => t.db.prepare(`INSERT INTO dev_agent_grants (agent_id, capability, audience, mode, status, granted_at, granted_by, updated_at, revoked_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'test', ?, ?)`).run(g.agent || `agt_${'5'.repeat(26)}`, g.capability || 'media.object.read', g.audience || 'openvibe.media',
            g.mode || 'confirm', g.status || 'active', now, now, g.revoked_at === undefined ? null : g.revoked_at);
        await grant({});
        await assert.rejects(grant({}), /duplicate key|unique/i, 'one row per agent and capability');
        await grant({ capability: 'media.object.upload', mode: 'auto', status: 'revoked', revoked_at: now });
        await assert.rejects(grant({ agent: `agt_${'8'.repeat(26)}`, capability: 'media.object.list' }), /foreign key/i, 'an unknown agent');
        await assert.rejects(grant({ capability: 'media.object.list', mode: 'always' }), /check constraint/i, 'an unknown mode');
        await assert.rejects(grant({ capability: 'media.object.list', status: 'paused' }), /check constraint/i, 'an unknown status');
        await assert.rejects(grant({ capability: 'media.object.list', status: 'revoked' }), /check constraint/i, 'revoked without revoked_at');
        await assert.rejects(grant({ capability: 'media.object.list', revoked_at: now }), /check constraint/i, 'active with revoked_at');
        await assert.rejects(grant({ capability: 'media.object.list', audience: 'media' }), /check constraint/i, 'an audience that is not openvibe.<service>');
        const idx = (await t.db.prepare("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'dev_agent_grants' ORDER BY indexname").all());
        assert.deepStrictEqual(idx.map((i) => i.indexname), ['dev_agent_grants_active_idx', 'dev_agent_grants_cap_idx', 'dev_agent_grants_pkey']);
        assert.match(idx[0].indexdef, /WHERE \(?status = 'active'/);
        console.log('agent schema: all tests passed');
    } finally {
        await t.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
