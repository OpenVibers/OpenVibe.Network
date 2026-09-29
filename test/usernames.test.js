'use strict';
// Username history (WS-B task 6): staff renames are recorded, an old name redirects to the current one
// (through several renames), stays reserved for everyone else, and never shadows someone's current name.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDb } = require('../server/db/database');
const u = require('../server/identity/usernames');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-usernames-'));
const log = console.log; console.log = () => {};
const db = await getDb();
console.log = log;
const add = async (name, display = null) => (await db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?) RETURNING id').run(name, display, 'x')).lastInsertRowid;

try {
    const ann = await add('ann_old', 'Ann_Old');
    const bob = await add('bob', 'Bob the Builder');
    assert.deepStrictEqual(await u.rename(db, ann, 'ann_new', { actorId: bob }), { from: 'ann_old', to: 'ann_new' });
    let row = await db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(ann);
    assert.deepStrictEqual([row.username, row.display_name], ['ann_new', 'ann_new'], 'a display name that was the username follows it');
    assert.strictEqual(await u.renamedTo(db, 'ANN_OLD'), 'ann_new', 'case-insensitive');
    assert.strictEqual(await u.renamedTo(db, 'ann_new'), null, 'a current name is never "renamed"');
    assert.strictEqual(await u.renamedTo(db, 'nobody_here'), null);
    assert.strictEqual(await u.renamedTo(db, '../etc'), null);

    // Reserved for everyone else, not for the person who held it.
    assert.strictEqual(await u.isReserved(db, 'ann_old'), true);
    assert.match(await u.problemWith(db, 'ann_old', bob), /belonged to someone else/);
    await assert.rejects(async () => await u.rename(db, bob, 'ann_old'), /belonged to someone else/);
    assert.strictEqual(await u.problemWith(db, 'ann_old', ann), null, 'Ann may take her old name back');

    // Several renames: every old name points at the current one.
    await u.rename(db, ann, 'ann_third');
    assert.strictEqual(await u.renamedTo(db, 'ann_old'), 'ann_third');
    assert.strictEqual(await u.renamedTo(db, 'ann_new'), 'ann_third');
    assert.deepStrictEqual((await u.historyOf(db, ann)).map(h => [h.old_username, h.new_username]), [['ann_new', 'ann_third'], ['ann_old', 'ann_new']]);

    // A display name that is not the username stays; bad and taken names are refused.
    await u.rename(db, bob, 'bobby');
    assert.strictEqual((await db.prepare('SELECT display_name FROM users WHERE id = ?').get(bob)).display_name, 'Bob the Builder');
    await assert.rejects(async () => await u.rename(db, bob, 'ann_third'), /taken/);
    await assert.rejects(async () => await u.rename(db, bob, 'no spaces'), /3-24 letters/);
    await assert.rejects(async () => await u.rename(db, bob, 'anon123'), /anon/);
    await assert.rejects(async () => await u.rename(db, bob, 'System'), /reserved by the system/);
    await assert.rejects(async () => await u.rename(db, 9999, 'whoever'), /No such user/);

    // Wiring: registration refuses reserved names, admins rename (owner-protected), the lookup is public.
    const auth = fs.readFileSync(path.join(__dirname, '../server/auth/routes.js'), 'utf8');
    assert.ok(/usernames'\)\.isReserved\(db, username\)/.test(auth));
    const admin = fs.readFileSync(path.join(__dirname, '../server/admin/routes.js'), 'utf8');
    assert.ok(/router\.put\('\/users\/:id\/username'/.test(admin) && /Only the owner renames the owner/.test(admin));
    assert.ok(/app\.get\('\/api\/v1\/users\/names\/:name'/.test(fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8')));
    // The public record: an old name and the current one both lead to the same person.
    assert.deepStrictEqual(await u.lookup(db, 'ann_old'), { current: 'ann_third', network_id: ann, renamed: true, previous_names: ['ann_new', 'ann_old'] });
    assert.deepStrictEqual(await u.lookup(db, 'ANN_THIRD'), { current: 'ann_third', network_id: ann, renamed: false, previous_names: ['ann_new', 'ann_old'] });
    assert.strictEqual(await u.lookup(db, 'nobody_here'), null);
    await db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(ann);
    assert.strictEqual(await u.lookup(db, 'ann_old'), null, 'banned accounts are not looked up');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('usernames: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
