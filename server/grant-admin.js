'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');

function loadEnv() {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const parsed = dotenv.config({ path: envPath });
        if (parsed.error) {
            throw parsed.error;
        }
        return parsed.parsed || {};
    }
    return {};
}

function resolveDatabasePath(env) {
    if (env.DB_PATH) {
        return path.resolve(process.cwd(), env.DB_PATH);
    }
    return path.resolve(__dirname, '..', 'data', 'network.db');
}

function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = {};
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--username' && args[i + 1]) {
            parsed.username = args[++i];
        } else if (arg === '--email' && args[i + 1]) {
            parsed.email = args[++i];
        } else if (arg === '--id' && args[i + 1]) {
            parsed.id = args[++i];
        } else if (arg === '--help') {
            parsed.help = true;
        }
    }
    return parsed;
}

function showUsage() {
    console.log('Usage: node server/grant-admin.js --username <username> | --email <email> | --id <userId>');
    process.exit(1);
}

function main() {
    const args = parseArgs();
    if (args.help || (!args.username && !args.email && !args.id)) {
        showUsage();
    }

    const env = loadEnv();
    const dbPath = resolveDatabasePath(env);
    if (!fs.existsSync(dbPath)) {
        console.error(`Database file not found at ${dbPath}`);
        process.exit(2);
    }

    const db = new Database(dbPath);
    const query = [];
    let row;

    if (args.id) {
        row = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(args.id);
    } else if (args.username) {
        row = db.prepare('SELECT id, username, email, role FROM users WHERE LOWER(username) = LOWER(?)').get(args.username);
    } else if (args.email) {
        row = db.prepare('SELECT id, username, email, role FROM users WHERE LOWER(email) = LOWER(?)').get(args.email);
    }

    if (!row) {
        console.error('User not found. Please verify username, email, or id.');
        process.exit(3);
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', row.id);
    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
        .run(null, 'grant_admin', JSON.stringify({ targetId: row.id, targetUsername: row.username, method: args.id ? 'id' : args.email ? 'email' : 'username' }));

    console.log(`User ${row.username} (id=${row.id}) has been granted admin privileges.`);
    db.close();
    process.exit(0);
}

main();
