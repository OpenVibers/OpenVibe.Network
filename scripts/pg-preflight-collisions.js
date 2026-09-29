#!/usr/bin/env node
'use strict';
/**
 * Before the PostgreSQL cutover (plan T2, ADR-035): SQLite's `COLLATE NOCASE` made some columns compare
 * case-insensitively, and username uniqueness inherited it, so `Alex` and `alex` cannot both exist here.
 * PostgreSQL compares text case-sensitively; the port keeps the behaviour with a unique index on
 * lower(username) and every lookup rewritten to lower(). That only works if the existing data has no two
 * rows that fold together — this lists them, so they are fixed on the SQLite side before the import.
 *
 *   node scripts/pg-preflight-collisions.js [--sqlite path/to/network.db] [--json]
 *
 * Exit 0 = no collisions; 1 = at least one (the cutover must wait); 2 = unusable input. Read-only: the
 * SQLite file is opened in read-only mode and never written. Reports, for each case-insensitive column that
 * must stay unique, the folding keys with more than one distinct spelling.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
// The retired SQLite file: --sqlite, else DB_PATH, else data/network.db (relative to the repo root).
const file = opt('--sqlite', path.resolve(__dirname, '..', process.env.DB_PATH || path.join('data', 'network.db')));
const asJson = args.includes('--json');

/** [table, column, the WHERE the uniqueness applies under, why it must not fold]. */
const CHECKS = [
    ['users', 'username', '1 = 1', 'users.username is UNIQUE: two spellings folding together would make the column ambiguous'],
    ['verification_keys', 'target_username', "status = 'active'", 'an active reserved-username claim would match two people'],
    ['username_history', 'old_username', '1 = 1', 'a former name would resolve to two accounts'],
];

function main() {
    if (!fs.existsSync(file)) { console.error(`no such SQLite database: ${file}`); return 2; }
    let Database;
    try { Database = require('better-sqlite3'); } catch { console.error('better-sqlite3 is not installed; run npm install'); return 2; }
    let db;
    try { db = new Database(file, { readonly: true, fileMustExist: true }); } catch (e) { console.error(`cannot open ${file}: ${e.message}`); return 2; }

    const report = { sqlite: file, checked: [], collisions: [] };
    for (const [table, column, where, why] of CHECKS) {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (!exists) { report.checked.push({ table, column, rows: 0, note: 'table absent' }); continue; }
        const rows = db.prepare(`SELECT lower(${column}) AS folded, COUNT(DISTINCT ${column}) AS spellings,
                                        group_concat(DISTINCT ${column}) AS names, COUNT(*) AS rows
                                   FROM ${table} WHERE ${where} GROUP BY folded HAVING COUNT(DISTINCT ${column}) > 1
                                   ORDER BY folded`).all();
        report.checked.push({ table, column, rows: db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n });
        for (const r of rows) report.collisions.push({ table, column, folded: r.folded, spellings: r.spellings, names: r.names, rows: r.rows, why });
    }
    db.close();

    if (asJson) { console.log(JSON.stringify(report, null, 2)); return report.collisions.length ? 1 : 0; }

    console.log(`pg-preflight-collisions: ${file}`);
    for (const c of report.checked) console.log(`  ${c.table}.${c.column}: ${c.rows} row(s)${c.note ? ` (${c.note})` : ''}`);
    if (!report.collisions.length) { console.log('no case-fold collisions: safe to import'); return 0; }
    console.log(`\n${report.collisions.length} case-fold collision(s) — resolve these on the SQLite side first:`);
    for (const c of report.collisions) {
        console.log(`  ${c.table}.${c.column}: ${c.names}  (fold "${c.folded}", ${c.rows} rows)`);
        console.log(`      ${c.why}`);
    }
    return 1;
}

if (require.main === module) process.exit(main());
module.exports = { CHECKS };
