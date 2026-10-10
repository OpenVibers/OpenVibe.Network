'use strict';
// ═══════════════════════════════════════════════════════════════
// reset-db — development/owner convenience: throw away the local database and let the next boot recreate
// the schema. Under PostgreSQL there is no file to remove: in production (DATABASE_URL set) this refuses
// and tells the operator what to run instead; without it (the embedded PGlite database of a dev/test
// process) the PGlite directory is moved aside, so the next start migrates a fresh one.
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const config = require('./config');

async function main({ log = console, cfg = config } = {}) {
    if (cfg.db.url) {
        log.error('reset-db: the database is PostgreSQL (DATABASE_URL is set); there is no file to remove.');
        log.error("Drop and recreate the schema as the owner instead, e.g. psql \"$DATABASE_DIRECT_URL\" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' — or point DATABASE_URL at a scratch database.");
        return 1;
    }

    const dir = path.resolve(process.cwd(), cfg.db.pgliteDir);
    if (!fs.existsSync(dir)) {
        log.log(`No embedded database at ${dir}. Nothing to reset.`);
        return 0;
    }

    const backup = `${dir}.backup.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
        fs.renameSync(dir, backup);
        log.log(`Moved the embedded database to ${backup}`);
        log.log('Reset complete. Restart the openvibe-network service to recreate the schema (migrations run at boot).');
        return 0;
    } catch (err) {
        log.error(`Failed to reset database: ${err.message}`);
        return 1;
    }
}

if (require.main === module) main().then((code) => process.exit(code), (err) => { console.error(`Failed to reset database: ${err.message}`); process.exit(1); });

module.exports = { main };
