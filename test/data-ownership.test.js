'use strict';
// ADR-007 data ownership: Network never opens another service's database. A second boot must not copy a
// role out of Live's database (compatibility register C-58, removed), and no server code names it.
//   node test/data-ownership.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getDb, initDb } = require('../server/db/database');

(async () => {
const db = await getDb();
await db.prepare("INSERT INTO users (username, password_hash, role, legacy_source, legacy_id) VALUES ('migrated', 'x', 'user', 'live', 7)").run();
// The removed sync ran on every boot, so a second boot is where it would have promoted the user.
await initDb();

assert.strictEqual((await db.prepare("SELECT role FROM users WHERE username = 'migrated'").get()).role, 'user',
    'a boot must not copy a role out of Live\'s database');

// No server code opens Live's database file.
function walk(d, out = []) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}
const offenders = walk(path.join(__dirname, '..', 'server'))
    .filter((f) => /live\.db\b/.test(fs.readFileSync(f, 'utf8')));
assert.deepStrictEqual(offenders, [], 'server code must not reference Live\'s database');

console.log('data-ownership: ok');
})().catch(err => { console.error(err); process.exit(1); });
