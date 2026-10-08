'use strict';
// The agents migrations (plan T2 WS-Z2 slices 2-5, migrations/0016_agents.sql, 0017_agent_grants.sql,
// 0018_confirmations.sql and 0019_agent_budgets.sql) reach a
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
        assert.deepStrictEqual(first.applied.map((m) => [m.id, m.name, m.phase]), [['0016', 'agents', 'expand'], ['0017', 'agent_grants', 'expand'], ['0018', 'confirmations', 'expand'], ['0019', 'agent_budgets', 'expand'], ['0020', 'user_owned_trust', 'expand'], ['0021', 'services_portal', 'migrate']]);
        assert.ok(await hasAgents());
        assert.deepStrictEqual((await asOwner((db) => db.migrate({ dir: MIGRATIONS, log: quiet }))).applied, [], 'already applied');
        // Expand only, IF NOT EXISTS throughout: running the file again changes nothing and fails nothing.
        for (const f of ['0016_agents.sql', '0017_agent_grants.sql', '0018_confirmations.sql', '0019_agent_budgets.sql']) await asOwner((db) => db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')));

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
        const idx = (await t.db.prepare("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'dev_agent_grants' ORDER BY indexname").all());
        assert.deepStrictEqual(idx.map((i) => i.indexname), ['dev_agent_grants_active_idx', 'dev_agent_grants_cap_idx', 'dev_agent_grants_pkey']);
        assert.match(idx[0].indexdef, /WHERE \(?status = 'active'/);

        // Confirmations (0018): an id, owner and digest of the right shape, a known state, the decision columns
        // consistent with it, used only once approved; standing rules whose session/until columns match their kind.
        const cnf = (c) => `cnf_${c.repeat(26)}`;
        const ins = (c) => t.db.prepare(`INSERT INTO dev_confirmations (id, project_id, agent_id, owner_subject, capability, audience, summary, state, request_digest,
                    expires_at, created_at, decided_at, used_at, rule_id) VALUES (?, ?, ?, ?, 'media.object.delete', 'openvibe.media', ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(c.id || cnf('A'), prj, c.agent || `agt_${'5'.repeat(26)}`, c.owner || usr, c.summary === undefined ? 'Delete a photo' : c.summary, c.state || 'pending',
                c.digest || 'f'.repeat(64), now, now, c.decided_at === undefined ? null : c.decided_at, c.used_at === undefined ? null : c.used_at, c.rule_id === undefined ? null : c.rule_id);
        await ins({});
        const d = await t.db.prepare('SELECT details, resources, standing_rule FROM dev_confirmations').get();
        assert.deepStrictEqual([d.details, d.resources, d.standing_rule], ['{}', '[]', null]);
        await assert.rejects(ins({}), /duplicate key|unique/i, 'one row per id');
        await assert.rejects(ins({ id: 'cnf_short' }), /check constraint/i, 'a malformed id');
        await assert.rejects(ins({ id: cnf('B'), owner: 'agt_x' }), /check constraint/i, 'an owner that is not a user');
        await assert.rejects(ins({ id: cnf('B'), summary: '' }), /check constraint/i, 'an empty summary');
        await assert.rejects(ins({ id: cnf('B'), summary: 'x'.repeat(501) }), /check constraint/i, 'a summary over 500');
        await assert.rejects(ins({ id: cnf('B'), digest: 'F'.repeat(64) }), /check constraint/i, 'a digest that is not lowercase hex');
        await assert.rejects(ins({ id: cnf('B'), state: 'used' }), /check constraint/i, 'an unknown state');
        await assert.rejects(ins({ id: cnf('B'), decided_at: now }), /check constraint/i, 'pending with decided_at');
        await assert.rejects(ins({ id: cnf('B'), state: 'approved' }), /check constraint/i, 'approved without decided_at');
        await assert.rejects(ins({ id: cnf('B'), state: 'denied' }), /check constraint/i, 'denied without decided_at');
        await assert.rejects(ins({ id: cnf('B'), state: 'cancelled', used_at: now }), /check constraint/i, 'used but not approved');
        await assert.rejects(ins({ id: cnf('B'), agent: `agt_${'8'.repeat(26)}` }), /foreign key/i, 'an unknown agent');
        await assert.rejects(ins({ id: cnf('B'), rule_id: 999 }), /foreign key/i, 'an unknown rule');
        await ins({ id: cnf('C'), state: 'approved', decided_at: now, used_at: now });
        await ins({ id: cnf('D'), state: 'cancelled' });
        const rule = (r) => t.db.prepare('INSERT INTO dev_standing_rules (agent_id, capability, rule, session_id, until_at, source, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
            .get(`agt_${'5'.repeat(26)}`, 'media.object.delete', r.rule, r.session_id === undefined ? null : r.session_id, r.until_at === undefined ? null : r.until_at, r.source || cnf('A'), now, 'test');
        const ids = [];
        ids.push((await rule({ rule: 'always' })).id, (await rule({ rule: 'until', until_at: now })).id, (await rule({ rule: 'session', session_id: 'session-1', until_at: now })).id);
        assert.deepStrictEqual(ids.map(Number), [1, 2, 3], 'identity ids');
        await assert.rejects(rule({ rule: 'once' }), /check constraint/i, 'once is never a standing rule');
        await assert.rejects(rule({ rule: 'session', until_at: now }), /check constraint/i, 'session without session_id');
        await assert.rejects(rule({ rule: 'session', session_id: 'short', until_at: now }), /check constraint/i, 'a malformed session_id');
        await assert.rejects(rule({ rule: 'until', session_id: 'session-1', until_at: now }), /check constraint/i, 'session_id on another kind');
        await assert.rejects(rule({ rule: 'until' }), /check constraint/i, 'until without until_at');
        await assert.rejects(rule({ rule: 'always', until_at: now }), /check constraint/i, 'always with until_at');
        await assert.rejects(rule({ rule: 'always', source: 'cnf_x' }), /check constraint/i, 'a source that is not a confirmation id');
        await ins({ id: cnf('E'), state: 'approved', decided_at: now, rule_id: ids[0] });
        const cIdx = await t.db.prepare("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'dev_confirmations' ORDER BY indexname").all();
        assert.deepStrictEqual(cIdx.map((i) => i.indexname), ['dev_confirmations_agent_idx', 'dev_confirmations_due_idx', 'dev_confirmations_inbox_idx', 'dev_confirmations_pkey', 'dev_confirmations_spendable_idx']);
        assert.match(cIdx[1].indexdef, /WHERE \(?state = 'pending'/);
        assert.match(cIdx[4].indexdef, /WHERE \(?\(?state = 'approved'.*used_at IS NULL/);
        const rIdx = await t.db.prepare("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'dev_standing_rules' ORDER BY indexname").all();
        assert.deepStrictEqual(rIdx.map((i) => i.indexname), ['dev_standing_rules_live_idx', 'dev_standing_rules_pkey']);
        assert.match(rIdx[0].indexdef, /WHERE \(?revoked_at IS NULL/);

        // Budgets (0019): one per (agent, capability), of an existing agent, a non-negative limit, a known window,
        // unit requests by default.
        const budget = (b) => t.db.prepare('INSERT INTO dev_agent_budgets (agent_id, capability, limit_value, budget_window, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)')
            .run(b.agent || `agt_${'5'.repeat(26)}`, b.capability || 'media.object.upload', b.limit === undefined ? 10 : b.limit, b.window || 'day', now, 'test');
        await budget({});
        assert.strictEqual((await t.db.prepare('SELECT unit FROM dev_agent_budgets').get()).unit, 'requests');
        await assert.rejects(budget({}), /duplicate key|unique/i, 'one budget per agent and capability');
        await budget({ capability: 'media.object.delete', limit: 0 });
        await assert.rejects(budget({ capability: 'media.object.list', limit: -1 }), /check constraint/i, 'a negative limit');
        await assert.rejects(budget({ capability: 'media.object.list', window: 'week' }), /check constraint/i, 'an unknown window');
        await assert.rejects(budget({ agent: `agt_${'8'.repeat(26)}`, capability: 'media.object.list' }), /foreign key/i, 'an unknown agent');
        console.log('agent schema: all tests passed');
    } finally {
        await t.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
