'use strict';
// Username history (WS-B task 6): staff renames are recorded, an old name redirects to the current one
// (through several renames), stays reserved for everyone else, and never shadows someone's current name.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db/database');
const u = require('../server/identity/usernames');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-usernames-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
const add = (name, display = null) => db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)').run(name, display, 'x').lastInsertRowid;

try {
    const ann = add('ann_old', 'Ann_Old');
    const bob = add('bob', 'Bob the Builder');
    assert.deepStrictEqual(u.rename(db, ann, 'ann_new', { actorId: bob }), { from: 'ann_old', to: 'ann_new' });
    let row = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(ann);
    assert.deepStrictEqual([row.username, row.display_name], ['ann_new', 'ann_new'], 'a display name that was the username follows it');
    assert.strictEqual(u.renamedTo(db, 'ANN_OLD'), 'ann_new', 'case-insensitive');
    assert.strictEqual(u.renamedTo(db, 'ann_new'), null, 'a current name is never "renamed"');
    assert.strictEqual(u.renamedTo(db, 'nobody_here'), null);
    assert.strictEqual(u.renamedTo(db, '../etc'), null);

    // Reserved for everyone else, not for the person who held it.
    assert.strictEqual(u.isReserved(db, 'ann_old'), true);
    assert.match(u.problemWith(db, 'ann_old', bob), /belonged to someone else/);
    assert.throws(() => u.rename(db, bob, 'ann_old'), /belonged to someone else/);
    assert.strictEqual(u.problemWith(db, 'ann_old', ann), null, 'Ann may take her old name back');

    // Several renames: every old name points at the current one.
    u.rename(db, ann, 'ann_third');
    assert.strictEqual(u.renamedTo(db, 'ann_old'), 'ann_third');
    assert.strictEqual(u.renamedTo(db, 'ann_new'), 'ann_third');
    assert.deepStrictEqual(u.historyOf(db, ann).map(h => [h.old_username, h.new_username]), [['ann_new', 'ann_third'], ['ann_old', 'ann_new']]);

    // A display name that is not the username stays; bad and taken names are refused.
    u.rename(db, bob, 'bobby');
    assert.strictEqual(db.prepare('SELECT display_name FROM users WHERE id = ?').get(bob).display_name, 'Bob the Builder');
    assert.throws(() => u.rename(db, bob, 'ann_third'), /taken/);
    assert.throws(() => u.rename(db, bob, 'no spaces'), /3-24 letters/);
    assert.throws(() => u.rename(db, bob, 'anon123'), /anon/);
    assert.throws(() => u.rename(db, bob, 'System'), /reserved by the system/);
    assert.throws(() => u.rename(db, 9999, 'whoever'), /No such user/);

    // Wiring: registration refuses reserved names, admins rename (owner-protected), the lookup is public.
    const auth = fs.readFileSync(path.join(__dirname, '../server/auth/routes.js'), 'utf8');
    assert.ok(/usernames'\)\.isReserved\(db, username\)/.test(auth));
    const admin = fs.readFileSync(path.join(__dirname, '../server/admin/routes.js'), 'utf8');
    assert.ok(/router\.put\('\/users\/:id\/username'/.test(admin) && /Only the owner renames the owner/.test(admin));
    assert.ok(/app\.get\('\/api\/v1\/users\/renamed\/:name'/.test(fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8')));
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('usernames: all checks passed');
