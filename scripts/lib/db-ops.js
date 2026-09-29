'use strict';
/**
 * Shared by the operator scripts: `parseArgs(argv, { flags, values })`, the `--flag` / `--key value`
 * parsing they all use. On PostgreSQL (plan T2, ADR-035) the scripts open the service database through
 * DATABASE_URL themselves (scripts/secrets-out-of-db.js, scripts/import-blocks.js); the old
 * better-sqlite3 helpers (dbPath, dropToOwnerOf, the sqlite online backup) are gone with the file.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

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

module.exports = { ROOT, parseArgs };
