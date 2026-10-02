#!/usr/bin/env node
'use strict';
/**
 * The T2 cutover's row-count parity check (docs/cutover-t2-postgres.md, step 6): after
 * scripts/migrate-to-postgres.js, every SQLite table must hold exactly as many rows in PostgreSQL. It is
 * independent of the import's own verification (openvibe-sdk importSqlite counts and checksums what it
 * copied): this one starts from the SQLite side, so a table the import never touched shows up as a mismatch.
 *
 *   node scripts/pg-row-parity.js --sqlite <file> [--json]           DATABASE_DIRECT_URL, else DATABASE_URL
 *   node scripts/pg-row-parity.js --sqlite <file> --pglite <dir>      a PGlite directory (the rehearsal)
 *
 * Per table: SQLite `SELECT COUNT(*) FROM "<t>"` against PostgreSQL `SELECT COUNT(*) FROM "<t>"` (both
 * sides read-only). Compared: every SQLite table except SQLite's own, FTS5 virtual tables and their shadow
 * tables, and migrate-to-postgres.js's SKIP_SOURCE. PostgreSQL-only tables (new in T2) are listed, not
 * compared. The triggers the import turns off (QUIET_TRIGGERS) must be on again. Run it before the new
 * release boots: its boot seeds rows (OAuth clients, themes, grants) that the SQLite file never had. Prints counts only, never a row. Exit 0 = parity, 1 = a mismatch, 2 = unusable input.
 */
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./lib/db-ops');
const { TABLES, SKIP_SOURCE, QUIET_TRIGGERS } = require('./migrate-to-postgres');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (t) => { if (!NAME_RE.test(t)) throw new Error(`unexpected table name ${JSON.stringify(t)}`); return `"${t}"`; };

/** The SQLite tables the import must carry over (importSqlite's own rule), each with its PostgreSQL name. */
function sourceTables(src) {
    const all = src.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const virtuals = all.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql || '')).map((t) => t.name);
    const renamed = Object.fromEntries(Object.entries(TABLES).filter(([, o]) => o && o.from).map(([to, o]) => [o.from, to]));
    return all.map((t) => t.name)
        .filter((n) => !n.startsWith('sqlite_') && !SKIP_SOURCE.includes(n) && !virtuals.some((v) => n === v || n.startsWith(`${v}_`)))
        .map((n) => ({ source: n, target: renamed[n] || n }));
}

/**
 * Compare row counts. `src` is an open better-sqlite3 Database, `db` a createDb() handle on the target.
 * → { ok, tables: { [target]: { sqlite, pg } }, pg_only: { [table]: rows }, problems: [] }
 */
async function rowParity(src, db) {
    const report = { ok: true, tables: {}, pg_only: {}, problems: [] };
    const pgTables = new Set((await db.many(`SELECT tablename FROM pg_tables
        WHERE schemaname = current_schema() AND tablename <> 'ov_migrations'`)).map((r) => r.tablename));
    const compared = new Set();
    for (const { source, target } of sourceTables(src)) {
        const sqlite = src.prepare(`SELECT COUNT(*) AS n FROM ${quote(source)}`).get().n;
        const pg = pgTables.has(target) ? Number(await db.value(`SELECT COUNT(*) FROM ${quote(target)}`)) : null;
        report.tables[target] = { sqlite, pg };
        compared.add(target);
        if (pg === null) { report.ok = false; report.problems.push({ table: target, problem: 'no PostgreSQL table' }); }
        else if (pg !== sqlite) { report.ok = false; report.problems.push({ table: target, problem: `row count differs: SQLite ${sqlite}, PostgreSQL ${pg}` }); }
    }
    for (const t of [...pgTables].sort()) if (!compared.has(t)) report.pg_only[t] = Number(await db.value(`SELECT COUNT(*) FROM ${quote(t)}`));
    // The import turns these off while it copies; an import that died half-way leaves them off.
    for (const [table, trigger] of QUIET_TRIGGERS) {
        if (!pgTables.has(table)) continue;
        const t = quote(trigger);
        // quote() validates the name and identifier-quotes it; tgname is a text column, so the
        // comparison takes that quoted value as a string literal (the name itself holds no quotes).
        const state = await db.value(
            `SELECT tgenabled::text FROM pg_trigger WHERE tgname = ${t.replace(/"/g, "'")} AND tgrelid = '${quote(table)}'::regclass`,
        );
        if (state !== 'O') { report.ok = false; report.problems.push({ table, problem: `trigger ${trigger} is ${state ? 'disabled' : 'missing'}: run migrate-to-postgres.js again` }); }
    }
    return report;
}

async function main(argv = process.argv.slice(2)) {
    let args;
    try { args = parseArgs(argv, { flags: ['json'], values: ['sqlite', 'pglite'] }); } catch (e) { console.error(e.message); return 2; }
    if (args.help || !args.sqlite) { console.error('usage: node scripts/pg-row-parity.js --sqlite <file> [--pglite <dir>] [--json]'); return 2; }
    const file = path.resolve(args.sqlite);
    if (!fs.existsSync(file)) { console.error(`no such SQLite database: ${file}`); return 2; }
    const url = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
    if (!args.pglite && !url) { console.error('DATABASE_DIRECT_URL (or DATABASE_URL) is not set, and no --pglite <dir>'); return 2; }
    const { createDb } = require('openvibe-sdk/db');
    const src = new (require('better-sqlite3'))(file, { readonly: true, fileMustExist: true });
    const quiet = { log() {}, warn: console.warn, error: console.error };
    const db = args.pglite ? createDb({ pglite: path.resolve(args.pglite), service: 'network-parity', log: quiet })
        : createDb({ url, service: 'network-parity', max: 1, log: quiet });
    try {
        const report = await rowParity(src, db);
        if (args.json) console.log(JSON.stringify({ sqlite: file, ...report }, null, 2));
        else {
            console.log(`row parity ${file} → ${db.store}: ${report.ok ? 'OK' : 'MISMATCH'}`);
            for (const [t, c] of Object.entries(report.tables)) console.log(`  ${t.padEnd(30)} ${String(c.sqlite).padStart(8)} ${String(c.pg ?? '-').padStart(8)}${c.sqlite === c.pg ? '' : '  ✗'}`);
            for (const [t, n] of Object.entries(report.pg_only)) console.log(`  ${t.padEnd(30)} ${'-'.padStart(8)} ${String(n).padStart(8)}  (PostgreSQL only)`);
            for (const p of report.problems) console.log(`  problem: ${p.table}: ${p.problem}`);
        }
        return report.ok ? 0 : 1;
    } finally {
        src.close();
        await db.close();
    }
}

if (require.main === module) main().then((code) => process.exit(code), (err) => { console.error(`pg-row-parity failed: ${err.message}`); process.exit(2); });

module.exports = { rowParity, sourceTables };
