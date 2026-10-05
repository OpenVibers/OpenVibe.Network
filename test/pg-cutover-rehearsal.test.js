'use strict';
// The T2 cutover rehearsal (scripts/rehearse-pg-cutover.js, docs/cutover-t2-postgres.md) on its seeded fixture:
// commit 20dd7ff's SQLite schema with representative rows → pg-preflight → migrate-to-postgres → row-count
// parity → the server booted on the result with /api/ready green. On PGlite by default, on a scratch database
// in the containers under npm run test:pg. A case-fold collision stops it at the preflight, and the parity
// check reports a target that lacks the rows or whose users_profile_created trigger the import left off.
//   node test/pg-cutover-rehearsal.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { rowParity } = require('../scripts/pg-row-parity');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rehearse-pg-cutover.js');
// Never a real target: the default store ignores DATABASE_URL, and the child runs without it anyway.
const env = { ...process.env };
delete env.DATABASE_URL;
delete env.DATABASE_DIRECT_URL;
delete env.NODE_OPTIONS;

function rehearse(args, extraEnv = {}) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        p.stdout.on('data', (d) => { stdout += d; });
        p.stderr.on('data', (d) => { stderr += d; });
        p.on('close', (code) => {
            const lines = stdout.trim().split('\n');
            let json = null;
            try { json = JSON.parse(lines[lines.length - 1]); } catch { /* asserted below */ }
            resolve({ code, json, lines, stderr });
        });
    });
}

(async () => {
    // 1. The seeded fixture, end to end.
    const r = await rehearse([]);
    assert.ok(r.json, `one JSON line last on stdout:\n${r.lines.join('\n')}\n${r.stderr}`);
    assert.strictEqual(r.lines.length, 1, 'stdout is the JSON line alone');
    assert.strictEqual(r.json.ok, true, `rehearsal ok: ${JSON.stringify(r.json.problems)}\n${r.stderr}`);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.json.source, 'seeded-20dd7ff');
    assert.strictEqual(r.json.store, process.env.OV_TEST_PG_DIRECT_URL ? 'postgresql' : 'pglite');
    assert.deepStrictEqual(r.json.preflight, { ok: true, exit: 0, collisions: [] });
    const expected = { users: 6, oauth_clients: 2, oauth_codes: 2, oauth_tokens: 3, notifications: 5, notification_preferences: 3, user_sessions: 2,
        wallets: 3, coin_transactions: 6, follows: 3, user_follows: 3, user_blocks: 2, verification_keys: 2, network_event_outbox: 1, themes: 0,
        // 20dd7ff's trigger wrote one per non-anonymous account; PostgreSQL's must not add its own during the import.
        user_profile_changes: 5 };
    for (const [t, n] of Object.entries(expected)) assert.deepStrictEqual(r.json.tables[t], { sqlite: n, pg: n }, `${t}: ${n} rows on both sides`);
    for (const [t, c] of Object.entries(r.json.tables)) assert.strictEqual(c.sqlite, c.pg, `${t}: parity`);
    // 77 tables at 20dd7ff (initDb's and those its modules create at boot), less the one left behind.
    assert.strictEqual(Object.keys(r.json.tables).length, 76, 'every table of the 20dd7ff schema is compared');
    assert.ok(!('analytics_rate_tracking' in r.json.tables) && !('analytics_rate_tracking' in r.json.pg_only), 'per-IP counters are never carried over');
    assert.deepStrictEqual(r.json.import.cleaned, [{ column: 'notifications.message', values: 1 }], 'the NUL PostgreSQL refuses is dropped and reported');
    assert.strictEqual(r.json.ready.ok, true);
    assert.strictEqual(r.json.ready.http, 200);
    assert.strictEqual(r.json.ready.db, 'ok');
    assert.strictEqual(r.json.ready.signing_key, 'ok');
    assert.strictEqual(r.json.ready.node_env, process.env.OV_TEST_PG_DIRECT_URL ? 'production' : 'test');
    assert.ok(!/\$2a\$10\$|rehearsal-client-secret|rt-family/.test(r.lines[0]), 'counts only: no row value in the output');

    // 2. A case-fold collision (alex / ALEX) stops the cutover at the preflight, before any import.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-rehearsal-test-'));
    const file = path.join(dir, 'collide.db');
    const w = await rehearse(['--write-fixture', file]);
    assert.strictEqual(w.code, 0, w.stderr);
    const Database = require('better-sqlite3');
    const db = new Database(file);
    db.prepare("INSERT INTO users (id, username, password_hash, subject_id) VALUES (7, 'ALEX', 'x', 'usr_rehearsal0007')").run();
    db.close();
    const c = await rehearse(['--sqlite', file, '--store', 'pglite']);
    assert.strictEqual(c.code, 1);
    assert.strictEqual(c.json.ok, false);
    assert.strictEqual(c.json.source, 'snapshot');
    assert.strictEqual(c.json.preflight.ok, false);
    assert.deepStrictEqual(c.json.preflight.collisions, [{ table: 'users', column: 'username', spellings: 2 }]);
    assert.strictEqual(c.json.import, null, 'nothing imported');
    assert.strictEqual(c.json.ready, null, 'nothing booted');
    assert.ok(fs.existsSync(file), 'the --sqlite file is left in place');

    // 3. Parity against a database that lacks the rows (this process's migrated, empty one) is a mismatch per table.
    const src = new Database(file, { readonly: true });
    const report = await rowParity(src, globalThis.__ovNetworkTestDb);
    src.close();
    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual(report.tables.users, { sqlite: 7, pg: 0 });
    assert.ok(report.problems.some((p) => p.table === 'coin_transactions' && /SQLite 6, PostgreSQL 0/.test(p.problem)));
    assert.ok(!report.problems.some((p) => p.table === 'dev_projects'), 'equal counts (0 and 0) are not problems');
    assert.ok(!report.problems.some((p) => /trigger/.test(p.problem)), 'users_profile_created is enabled');

    // 4. An import killed between its ALTERs leaves users_profile_created off: parity refuses that database. On a
    // PGlite of its own: the test database's role (DML only under test:pg, as production's runtime) cannot ALTER.
    const { createDb } = require('openvibe-sdk/db');
    const { MIGRATIONS } = require('../scripts/migrate-to-postgres');
    const owner = createDb({ pglite: true, service: 'network-rehearsal-test', log: { log() {}, warn() {}, error: console.error } });
    let off;
    try {
        await owner.migrate({ dir: MIGRATIONS, log: { log() {}, warn() {}, error: console.error } });
        await owner.exec('ALTER TABLE users DISABLE TRIGGER users_profile_created');
        const src2 = new Database(file, { readonly: true });
        try { off = await rowParity(src2, owner); } finally { src2.close(); }
    } finally { await owner.close(); }
    assert.ok(off.problems.some((p) => p.table === 'users' && /trigger users_profile_created is disabled/.test(p.problem)), JSON.stringify(off.problems));
    fs.rmSync(dir, { recursive: true, force: true });

    // 5. --store env refuses an unset or empty DATABASE_URL before it connects anywhere; the message names no URL.
    for (const extra of [{}, { DATABASE_URL: '' }, { DATABASE_URL: '   ' }]) {
        const e = await rehearse(['--store', 'env'], { DATABASE_DIRECT_URL: 'postgres://rehearsal@127.0.0.1:9/none', ...extra });
        assert.strictEqual(e.code, 1, e.stderr);
        assert.strictEqual(e.json.ok, false);
        assert.ok(e.json.problems.some((p) => /needs DATABASE_DIRECT_URL and DATABASE_URL.*DATABASE_URL is unset or empty/.test(p)), JSON.stringify(e.json.problems));
        assert.strictEqual(e.json.import, null, 'nothing imported');
        assert.ok(!/127\.0\.0\.1:9|postgres:\/\//.test(e.lines.join('\n')), 'no URL in the output');
    }

    // 6. The same-database guard: two separate databases are refused; one empty database is accepted; rows refuse it
    // unless --truncate-target; the probe table never stays behind.
    const { checkScratchTarget, pollReady } = require('../scripts/rehearse-pg-cutover');
    const quietLog = { log() {}, warn() {}, error: console.error };
    const dbA = createDb({ pglite: true, service: 'network-rehearsal-test-a', log: quietLog });
    const dbB = createDb({ pglite: true, service: 'network-rehearsal-test-b', log: quietLog });
    try {
        await assert.rejects(checkScratchTarget(dbA, dbB), (e) => /does not reach the database/.test(e.message) && !/postgres:\/\//.test(e.message));
        await checkScratchTarget(dbA, dbA);
        const probes = `SELECT count(*)::int FROM pg_class WHERE relname LIKE 'ov_rehearsal_probe_%'`;
        assert.strictEqual(Number(await dbA.value(probes)), 0, 'the probe is dropped');
        assert.strictEqual(Number(await dbB.value(probes)), 0);
        await dbA.exec('CREATE TABLE rehearsal_rows (id int)');
        await dbA.exec('INSERT INTO rehearsal_rows VALUES (1)');
        await assert.rejects(checkScratchTarget(dbA, dbA), /not empty through DATABASE_DIRECT_URL/);
        await checkScratchTarget(dbA, dbA, { truncateTarget: true });
        assert.strictEqual(Number(await dbA.value(probes)), 0);
    } finally { await dbA.close(); await dbB.close(); }

    // 7. A server that accepts and never answers (or stalls mid-body) cannot hold the readiness poll past its deadline.
    const http = require('http');
    for (const handler of [() => {}, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ready":'); }]) {
        const stalled = http.createServer(handler);
        await new Promise((r) => stalled.listen(0, '127.0.0.1', r));
        const t = Date.now();
        try {
            const p = await pollReady(`http://127.0.0.1:${stalled.address().port}`, { timeoutMs: 3000, requestMs: 1000 });
            const took = Date.now() - t;
            assert.strictEqual(p.body, null, 'no answer read');
            // It must wait for the deadline (>= 2500), and must give up near it rather than hang. The upper bound is loose:
            // with other test files in parallel this process can be descheduled past the timer, so wall-clock can stretch
            // well beyond the 3 s deadline even though the poll itself honoured it.
            assert.ok(took >= 2500 && took < 30000, `returned in ${took} ms (deadline 3000)`);
        } finally { stalled.closeAllConnections(); await new Promise((r) => stalled.close(r)); }
    }

    console.log(`pg cutover rehearsal: all checks passed (${r.json.store}, ${Object.keys(r.json.tables).length} tables, ready ${r.json.ready.status})`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
