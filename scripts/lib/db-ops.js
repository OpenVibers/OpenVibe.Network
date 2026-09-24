'use strict';
/**
 * Shared by the operator scripts that change network.db (scripts/hash-refresh-tokens.js,
 * scripts/secrets-out-of-db.js):
 *
 *   dbPath(args)          --db, else $DB_PATH, else data/network.db (relative to the repo root)
 *   dropToOwnerOf(file)   when run as root: become the file's owner (uid/gid) so nothing the script
 *                         writes (the -wal/-shm files, a backup) ends up owned by root; a no-op otherwise
 *   backupTo(db, target)  sqlite online backup to a NEW file, owner-only (0600), verified with
 *                         quick_check; refuses an existing target
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function dbPath(args = {}, env = process.env) {
    return path.resolve(ROOT, args.db || env.DB_PATH || path.join('data', 'network.db'));
}

function dropToOwnerOf(file, log = console.log) {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
    const st = fs.statSync(file);
    if (st.uid === 0) return false;
    process.setgid(st.gid);
    process.setuid(st.uid);
    log(`running as uid ${st.uid} (owner of ${path.basename(file)})`);
    return true;
}

async function backupTo(db, target, { Database = require('better-sqlite3'), expect = null } = {}) {
    const file = path.resolve(ROOT, target);
    if (fs.existsSync(file)) throw new Error(`backup target ${file} already exists; choose a new path`);
    const umask = process.umask(0o077);
    try { await db.backup(file); } finally { process.umask(umask); }
    fs.chmodSync(file, 0o600);
    const check = new Database(file, { readonly: true });
    try {
        const ok = check.pragma('quick_check', { simple: true });
        if (ok !== 'ok') throw new Error(`backup check failed: quick_check=${ok}`);
        if (expect) {
            const n = check.prepare(`SELECT COUNT(*) AS n FROM ${expect.table}`).get().n;
            if (n < expect.rows) throw new Error(`backup check failed: ${expect.table} has ${n} rows, expected ${expect.rows}`);
        }
    } finally { check.close(); }
    return file;
}

/** --flag / --key value parsing shared by the scripts. */
function parseArgs(argv, { flags = [], values = [] } = {}) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const name = a.replace(/^--/, '');
        if (flags.includes(name)) out[name] = true;
        else if (values.includes(name)) {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
            out[name] = v;
        } else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return out;
}

module.exports = { ROOT, dbPath, dropToOwnerOf, backupTo, parseArgs };
