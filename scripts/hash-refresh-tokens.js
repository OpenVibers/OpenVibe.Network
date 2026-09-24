#!/usr/bin/env node
/**
 * Refresh tokens stored before server/auth/refresh-tokens.js held the raw token. The server already
 * reads both (a raw row is hashed on its first use); this replaces the rest by their SHA-256 in place,
 * one-way, so no usable token sits in network.db.
 *
 *   node scripts/hash-refresh-tokens.js                                # dry run: counts only
 *   node scripts/hash-refresh-tokens.js --apply --backup <new file>    # online backup (0600, verified), then hash
 *   node scripts/hash-refresh-tokens.js --restore-from <backup>        # dry run of the rollback
 *   node scripts/hash-refresh-tokens.js --restore-from <backup> --apply
 *       puts the raw values from the backup back into rows that still hold their hash. Only needed to
 *       roll Network back to a release before refresh-token hashing: that release matches raw values only.
 *   --db <path>   default $DB_PATH, else data/network.db (relative to the repo root)
 *
 * Safe while Network runs (batched transactions; busy_timeout 5 s). Run as the database's owner; run
 * as root it becomes that owner before opening the database. Prints counts, never a token.
 */
'use strict';
const Database = require('better-sqlite3');
const ops = require('./lib/db-ops');
const refreshTokens = require('../server/auth/refresh-tokens');

const USAGE = `usage: node scripts/hash-refresh-tokens.js [--db <path>] [--apply --backup <new file>]
       node scripts/hash-refresh-tokens.js [--db <path>] --restore-from <backup> [--apply]`;

async function main(argv, log = console.log) {
    let args;
    try { args = ops.parseArgs(argv, { flags: ['apply'], values: ['db', 'backup', 'restore-from'] }); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help) { log(USAGE); return 0; }
    const file = ops.dbPath(args);
    if (!require('fs').existsSync(file)) { log(`error: no database at ${file}`); return 2; }
    ops.dropToOwnerOf(file, log);
    const db = new Database(file);
    db.pragma('busy_timeout = 5000');
    try {
        refreshTokens.ensureSchema(db);
        const total = db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get().n;

        if (args['restore-from']) {
            const backup = new Database(require('path').resolve(ops.ROOT, args['restore-from']), { readonly: true, fileMustExist: true });
            const raw = backup.prepare(`SELECT id, token FROM oauth_tokens WHERE substr(token, 1, ${refreshTokens.PREFIX.length}) <> '${refreshTokens.PREFIX}'`).all();
            backup.close();
            const has = db.prepare('SELECT 1 FROM oauth_tokens WHERE id = ? AND token = ?');
            const restorable = raw.filter(r => has.get(r.id, refreshTokens.hash(r.token)));
            log(`database   ${file}\nbackup has ${raw.length} raw token(s); ${restorable.length} row(s) here still hold their hash`);
            if (!args.apply) { log('dry run: nothing changed. Re-run with --apply to put the raw values back.'); return 0; }
            const up = db.prepare('UPDATE oauth_tokens SET token = ? WHERE id = ? AND token = ?');
            let n = 0;
            db.transaction(() => { for (const r of restorable) n += up.run(r.token, r.id, refreshTokens.hash(r.token)).changes; })();
            log(`restored   ${n} raw token(s)`);
            return 0;
        }

        const legacy = refreshTokens.countLegacy(db);
        log(`database   ${file}\nrefresh tokens ${total}; still stored raw ${legacy}; hashed ${total - legacy}`);
        if (!args.apply) { log(legacy ? 'dry run: nothing changed. Re-run with --apply --backup <new file>.' : 'nothing to do.'); return 0; }
        if (!args.backup) { log('refusing --apply without --backup <new file> (sqlite online backup, 0600)'); return 2; }
        if (!legacy) { log('nothing to do; no backup taken.'); return 0; }
        const target = await ops.backupTo(db, args.backup, { expect: { table: 'oauth_tokens', rows: total } });
        log(`backup     ${target} (0600, quick_check ok). It holds the raw tokens: delete it once the rollback window is over.`);
        const n = refreshTokens.hashLegacy(db);
        const left = refreshTokens.countLegacy(db);
        log(`hashed     ${n} token(s) in place; raw left ${left}`);
        return left ? 1 : 0;
    } finally { db.close(); }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });

module.exports = { main };
