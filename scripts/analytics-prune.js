#!/usr/bin/env node
/**
 * Raw analytics retention and one-time scrub for Network's analytics tables (ADR-021). They live in
 * network.db, Network's identity database, next to users and sessions. The command itself is
 * openvibe-shared/analytics/prune-cli; this wrapper passes Network's better-sqlite3, database and path
 * rules (/avatar/<name>, /users/by-username/<name>, /api/auth/anon/<token>; server/analytics/network.js).
 *
 *   node scripts/analytics-prune.js                          # dry run: counts only, changes nothing
 *   node scripts/analytics-prune.js --scrub                  # dry run including what the scrub would rewrite
 *   node scripts/analytics-prune.js --apply --backup <file>  # online backup to <file>, then prune
 *   node scripts/analytics-prune.js --apply --scrub --backup <file>
 *   node scripts/analytics-prune.js --apply --no-backup      # prune without a backup (explicit)
 *   node scripts/analytics-prune.js --help                   # every option
 *
 * Default database: $DB_PATH, else data/network.db. Relative --db and --backup paths are from the repo
 * root. The backup is a full copy of network.db (accounts, sessions): mode 0600.
 *
 * VACUUM (after an --apply, unless --no-vacuum) rewrites all of network.db and holds its write lock
 * meanwhile: Network's own writes (sign-ins, sessions) wait 5 s and then fail. Vacuum with the service
 * stopped, or pass --no-vacuum while it is up. Run as the service user so no file changes owner.
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const cli = require('openvibe-shared/analytics/prune-cli');
const networkAnalytics = require('../server/analytics/network');

const ROOT = path.join(__dirname, '..');

const VACUUM_WARNING = `
On Network, VACUUM rewrites all of network.db and holds its write lock meanwhile: Network's own writes
(sign-ins, sessions) wait 5 s and then fail. Vacuum with the service stopped, or pass --no-vacuum while
it is up. Default database: $DB_PATH, else data/network.db; relative paths are from the repo root. The
backup is a full copy of network.db (mode 0600). Run as the service user so no file changes owner.`;

/** The database the server uses: --db, else $DB_PATH, else data/network.db (relative to the repo root). */
function defaultDbPath(args, env = process.env) {
    return path.resolve(ROOT, args.db || env.DB_PATH || path.join('data', 'network.db'));
}

function main(argv, log) {
    return cli.main(argv, {
        Database,
        log,
        root: ROOT,
        defaultDb: defaultDbPath,
        ...networkAnalytics.PATH_OPTS,
        usage: cli.USAGE + '\n' + VACUUM_WARNING,
    });
}

if (require.main === module) cli.run(main);

module.exports = { main, defaultDbPath };
