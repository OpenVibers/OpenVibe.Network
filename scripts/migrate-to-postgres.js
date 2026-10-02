#!/usr/bin/env node
'use strict';
/**
 * The one-time move of Network's SQLite database (DB_PATH) into its PostgreSQL schema (plan T2, ADR-035; the
 * procedure is openvibe-sdk docs/migrating-to-postgresql.md, section 6, the steps of openvibe-sdk's runSqliteMigration).
 * Opus runs it at the cutover, after scripts/pg-preflight-collisions.js.
 *
 *   node scripts/migrate-to-postgres.js [--sqlite <file>] [--pglite] [--json]
 *
 *   --pglite   a dry run: an in-memory PostgreSQL, migrations applied, every table imported with truncate
 *              and verified, and the per-table count + checksum report printed. Nothing to set up, nothing
 *              left behind. Use it to prove the schema is importable before touching a real target.
 *   --sqlite   the source file (default $DB_PATH or data/network.db). It is opened read-only; nothing in it changes.
 *   --json     the report as JSON.
 *
 * Without --pglite it applies migrations/ as the owner on DATABASE_DIRECT_URL (the serving DATABASE_URL goes
 * through PgBouncer in transaction mode, which cannot hold the import's transaction) and copies into emptied
 * tables, so a rehearsal against a scratch DATABASE_URL is repeatable. Exit 0 only if every table verified.
 *
 * The legacy integer-keyed `follows` table is imported like every other: server/auth/routes.js and
 * server/internal/routes.js still read it (the subject-keyed user_follows is the forward model).
 *
 * The steps are runSqliteMigration's (migrate, cleaning options, importSqlite with truncate, report), run here
 * so QUIET_TRIGGERS can be off while the rows are copied. A run that dies between the two ALTERs leaves them
 * off: run the import again (it re-enables them at the end), never boot on such a database.
 */
require('dotenv').config();
const path = require('path');
const { createDb, importSqlite } = require('openvibe-sdk/db');
// cleaningOptions is sqlite-cli.js's export, beside openvibe-sdk/db's entry (the package exports map does not list it).
const { cleaningOptions } = require(path.join(path.dirname(require.resolve('openvibe-sdk/db')), 'sqlite-cli.js'));
const config = require('../server/config');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

// importSqlite's per-table options. Empty: every PostgreSQL column is fed by the same-named SQLite one.
const TABLES = {};

// SQLite tables the import leaves behind. The SDK's SQLite outbox/inbox rows are carried over (unsent events
// keep their place in the PostgreSQL outbox). Left behind:
//   analytics_rate_tracking  openvibe-shared's old per-IP bot-rate counters. The rate check keeps them in
//                            memory only now and PostgreSQL has no such table: IPs are never carried over.
const SKIP_SOURCE = ['analytics_rate_tracking'];

// Triggers that derive rows from an insert. The import copies those rows from SQLite as they are, so these are
// off while it runs: users_profile_created would add a 'created' change for every imported account (a key
// collision with the copied user_profile_changes rows, and one profile event per account at the first drain).
const QUIET_TRIGGERS = [['users', 'users_profile_created']];

// The retired SQLite file: --sqlite, else DB_PATH, else data/network.db (relative to the repo root).
const DEFAULT_SQLITE = path.resolve(__dirname, '..', process.env.DB_PATH || path.join('data', 'network.db'));

/** Migrate `owner` (a createDb() handle, the owner role) and copy `sqlite` into it. → importSqlite's report + cleaned */
async function importInto(owner, sqlite, { log = { log() {}, warn: console.warn, error: console.error } } = {}) {
    await owner.migrate({ dir: MIGRATIONS, log });
    const options = await cleaningOptions(owner, TABLES);
    for (const [table, trigger] of QUIET_TRIGGERS) await owner.exec(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    try {
        const report = await importSqlite({ sqlite, db: owner, truncate: true, tables: options.tables, skipSource: SKIP_SOURCE, log });
        return { ...report, cleaned: options.cleaned() };
    } finally {
        for (const [table, trigger] of QUIET_TRIGGERS) await owner.exec(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
}

async function main(argv = process.argv.slice(2), out = console.log) {
    const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
    const flag = (name) => argv.includes(`--${name}`);
    const file = path.resolve(opt('sqlite') || DEFAULT_SQLITE);
    const quiet = { log() {}, warn: console.warn, error: console.error };
    let owner;
    if (flag('pglite')) owner = createDb({ pglite: true, service: 'network-import', log: quiet });
    else {
        if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: the import runs as the owner on a direct connection');
        owner = createDb({ url: config.db.directUrl, service: 'network-import', max: 2, log: quiet });
    }
    try {
        const t0 = Date.now();
        const report = await importInto(owner, file, { log: quiet });
        if (flag('json')) out(JSON.stringify({ sqlite: file, into: owner.store, ...report }, null, 2));
        else {
            out(`import ${file} → ${owner.store} (${Date.now() - t0} ms): ${report.ok ? 'OK' : 'PROBLEMS'}`);
            for (const t of report.tables) out(`  ${t.table.padEnd(30)} ${String(t.rows).padStart(8)} rows  ${t.checksum || '-'}${t.source !== t.table ? `  (from ${t.source})` : ''}`);
            for (const c of report.cleaned) out(`  cleaned: ${c.column}: ${c.values} value(s) with a NUL or an unpaired surrogate`);
            for (const p of report.problems) out(`  problem: ${p.table}: ${p.problem}`);
        }
        return report.ok ? 0 : 1;
    } finally {
        await owner.close();
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code), (err) => { console.error(`migrate-to-postgres failed: ${err.message}`); process.exit(1); });
}

module.exports = { TABLES, SKIP_SOURCE, QUIET_TRIGGERS, MIGRATIONS, DEFAULT_SQLITE, importInto };
