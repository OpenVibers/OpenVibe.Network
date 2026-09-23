'use strict';
// ADR-007 data ownership: Network never opens another service's database. Booting with a
// Live database on disk (and OPENVIBELIVE_DB_PATH pointing at it) must not copy roles from it
// (compatibility register C-58, removed).
//   node test/data-ownership.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-data-ownership-'));

// A Live database in which the linked account is an admin.
const livePath = path.join(dir, 'live.db');
const live = new Database(livePath);
live.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT)");
live.prepare("INSERT INTO users (id, username, role) VALUES (7, 'migrated', 'admin')").run();
live.close();
process.env.OPENVIBELIVE_DB_PATH = livePath;

const { initDb } = require('../server/db/database');
const netPath = path.join(dir, 'network.db');
const log = console.log; console.log = () => {};
let db = initDb(netPath);
db.prepare("INSERT INTO users (username, password_hash, role, legacy_source, legacy_id) VALUES ('migrated', 'x', 'user', 'live', 7)").run();
db.close();
// The removed sync ran on every boot, so a second boot is where it would have promoted the user.
db = initDb(netPath);
console.log = log;

assert.strictEqual(db.prepare("SELECT role FROM users WHERE username = 'migrated'").get().role, 'user',
    'a boot must not copy a role out of Live\'s database');
db.close();

// No server code names Live's database or the variable that pointed at it.
function walk(d, out = []) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}
const offenders = walk(path.join(__dirname, '..', 'server'))
    .filter((f) => /OPENVIBELIVE_DB_PATH|live\.db\b/.test(fs.readFileSync(f, 'utf8')));
assert.deepStrictEqual(offenders, [], 'server code must not reference Live\'s database');

fs.rmSync(dir, { recursive: true, force: true });
console.log('data-ownership: ok');
