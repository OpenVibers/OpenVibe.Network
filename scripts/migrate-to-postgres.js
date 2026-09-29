#!/usr/bin/env node
'use strict';
/**
 * The one-time move of Network's SQLite database (DB_PATH) into its PostgreSQL schema (plan T2, ADR-035; the
 * procedure is openvibe-sdk docs/migrating-to-postgresql.md, section 6, carried out by runSqliteMigration).
 * Opus runs it at the cutover, after scripts/pg-preflight-collisions.js.
 *
 *   node scripts/migrate-to-postgres.js [--sqlite <file>] [--pglite] [--json]
 *
 *   --pglite   a dry run: an in-memory PostgreSQL, migrations applied, every table imported with truncate
 *              and verified, and the per-table count + checksum report printed. Nothing to set up, nothing
 *              left behind. Use it to prove the schema is importable before touching a real target.
 *   --sqlite   the source file (default config.db.path). It is opened read-only; nothing in it changes.
 *   --json     the report as JSON.
 *
 * Without --pglite it applies migrations/ as the owner on DATABASE_DIRECT_URL (the serving DATABASE_URL goes
 * through PgBouncer in transaction mode, which cannot hold the import's transaction) and copies into emptied
 * tables, so a rehearsal against a scratch DATABASE_URL is repeatable. Exit 0 only if every table verified.
 *
 * The legacy integer-keyed `follows` table is imported like every other: server/auth/routes.js and
 * server/internal/routes.js still read it (the subject-keyed user_follows is the forward model).
 */
require('dotenv').config();
const path = require('path');
const { runSqliteMigration } = require('openvibe-sdk/db');
const config = require('../server/config');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

// importSqlite's per-table options. Empty: every PostgreSQL column is fed by the same-named SQLite one.
const TABLES = {};

// SQLite tables the import leaves behind. Empty: even the SDK's SQLite outbox/inbox rows are carried over
// (unsent events keep their place in the PostgreSQL outbox).
const SKIP_SOURCE = [];

if (require.main === module) {
    runSqliteMigration({ service: 'network', sqlite: config.db.path, directUrl: config.db.directUrl, migrations: MIGRATIONS, tables: TABLES, skipSource: SKIP_SOURCE })
        .then((code) => process.exit(code), (err) => { console.error(`migrate-to-postgres failed: ${err.message}`); process.exit(1); });
}

module.exports = { TABLES, SKIP_SOURCE, MIGRATIONS };
