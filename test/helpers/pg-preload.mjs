// Loaded with `node --import` into every test process (test/run.js): one migrated database for the process
// (plan T2, ADR-035) — PGlite by default, or, with NETWORK_TEST_STORE=pg (npm run test:pg), the PostgreSQL +
// PgBouncer containers with roles and a schema of its own. server/db/database.js initDb() adopts it, so test
// files open no database themselves. The process ends with the test (a container schema is dropped by
// `scripts/test-services.sh down`).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = path.join(root, 'migrations');
const store = process.env.NETWORK_TEST_STORE || 'pglite';
const { createTestDb } = require('openvibe-sdk/testing');
// On the containers createTestDb migrates through its own fixed 15 s client query timeout, and every test process's
// migrate() queues on the SDK's single global advisory lock (openvibe-sdk/src/db/migrate.js LOCK_KEY): with test files
// in parallel, a later process waits past 15 s and dies with "Query read timeout" before its test starts. So for 'pg'
// createTestDb only creates this process's schema and roles, and the migration runs here on the owner connection with
// a timeout that covers the queue. PGlite migrates in-process with no lock, so it keeps createTestDb's own path.
const t = await createTestDb({ migrations: store === 'pg' ? null : MIGRATIONS, store, service: 'network', max: 4 });
if (t.directUrl) {
    const { createDb } = require('openvibe-sdk/db');
    const owner = createDb({ url: t.directUrl, service: 'network-test-owner', max: 1, queryTimeoutMs: 120000 });
    // A failed migration drops this process's schema and roles, as createTestDb does when its own migrate fails.
    try { await owner.migrate({ dir: MIGRATIONS }); } catch (e) { await owner.close(); await t.close(); throw e; }
    await owner.close();
}
// Tests insert rows with small explicit ids. A PostgreSQL identity would continue after them, so generated ids
// are set to start at 100000 here, clear of every id a test names.
for (const r of await t.db.prepare(`SELECT pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq FROM information_schema.columns
                                    WHERE table_schema = current_schema() AND is_identity = 'YES'`).all()) {
    if (r.seq) await t.db.prepare('SELECT setval(?::regclass, 100000)').get(r.seq);
}
globalThis.__ovNetworkTestDb = t.db;
globalThis.__ovNetworkTestDbClose = t.close;
// Owner-only DDL (a CREATE TRIGGER, say) for tests that must fail a write at the database, not in a mock: on the
// containers the runtime role may not create in the schema, so this runs on the owner connection. PGlite has one role.
globalThis.__ovNetworkDdl = async (sql) => {
    if (!t.directUrl) return t.db.exec(sql);
    const { createDb } = require('openvibe-sdk/db');
    const owner = createDb({ url: t.directUrl, service: 'network-test-owner', max: 1 });
    try { return await owner.exec(sql); } finally { await owner.close(); }
};
// The migration runner, on the same owner connection (a test that re-applies the migrations to prove them idempotent).
globalThis.__ovNetworkMigrate = async (opts) => {
    if (!t.directUrl) return t.db.migrate(opts);
    const { createDb } = require('openvibe-sdk/db');
    const owner = createDb({ url: t.directUrl, service: 'network-test-owner', max: 1, queryTimeoutMs: 120000 });
    try { return await owner.migrate(opts); } finally { await owner.close(); }
};
// initDb() adopts the handle above, attaches the handle helpers and seeds the boot data (OAuth clients, site
// settings, built-in themes) once, exactly as the server does at boot. Every test file then reads it with getDb().
await require(path.join(root, 'server', 'db', 'database.js')).initDb();
