'use strict';
// ═══════════════════════════════════════════════════════════════
// grant-admin — make one person an admin from the operator's shell (roadmap §18.2(12)).
//
//   node server/grant-admin.js --username <username>
//   node server/grant-admin.js --email <email>
//   node server/grant-admin.js --id <userId>
//
// The users live in the service's own PostgreSQL (DATABASE_URL, plan T2); run this where Network runs,
// or with DATABASE_DIRECT_URL/DATABASE_URL pointing at a copy. The change is audited in audit_log.
// ═══════════════════════════════════════════════════════════════
const { initDb } = require('./db/database');

const USAGE = 'Usage: node server/grant-admin.js --username <username> | --email <email> | --id <userId>';

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--username' && argv[i + 1]) args.username = argv[++i];
        else if (a === '--email' && argv[i + 1]) args.email = argv[++i];
        else if (a === '--id' && argv[i + 1]) args.id = argv[++i];
        else if (a === '--help') args.help = true;
    }
    return args;
}

/**
 * @returns {number} process exit code: 0 granted, 1 usage, 3 no such user.
 */
async function main(argv = process.argv.slice(2), { db: injected, log = console } = {}) {
    const args = parseArgs(argv);
    if (args.help || (!args.username && !args.email && !args.id)) {
        log.error(USAGE);
        return 1;
    }

    const db = injected || await initDb();

    let row;
    if (args.id) {
        row = await db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(args.id);
    } else if (args.username) {
        row = await db.prepare('SELECT id, username, email, role FROM users WHERE lower(username) = lower(?)').get(args.username);
    } else {
        row = await db.prepare('SELECT id, username, email, role FROM users WHERE lower(email) = lower(?)').get(args.email);
    }

    if (!row) {
        log.error('User not found. Please verify username, email, or id.');
        return 3;
    }

    await db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', row.id);
    await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
        .run(null, 'grant_admin', JSON.stringify({ targetId: row.id, targetUsername: row.username, method: args.id ? 'id' : args.email ? 'email' : 'username' }));

    log.log(`User ${row.username} (id=${row.id}) has been granted admin privileges.`);
    return 0;
}

if (require.main === module) main().then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });

module.exports = { main, parseArgs, USAGE };
