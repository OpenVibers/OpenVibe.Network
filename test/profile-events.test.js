'use strict';
// network.user.updated (WS-B task 2, Contracts 0.43.0): triggers on users record every profile, role and ban
// change in its own transaction, whichever code made it; drain() turns them into one event per person with
// the whole current profile, a growing revision and what changed; guests are never announced; a new account
// is announced once it has its subject; the payload and envelope match the contracts.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-profile-events-'));
const log = console.log; console.log = () => {};
const db = await getDb();
console.log = log;
await db.prepare("INSERT INTO users (id, username, password_hash, subject_id) VALUES (5, 'early', 'x', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPE')").run();
const profile = require('../server/identity/profile-events');
await profile.ensureSchema(db);
assert.strictEqual(await profile.drain(db), 1, 'the first boot announces every existing account once');
await profile.ensureSchema(db);
assert.strictEqual(await profile.drain(db), 0, 'and only the first');
await db.prepare('DELETE FROM network_event_outbox').run();
const events = async () => (await db.prepare("SELECT envelope FROM network_event_outbox ORDER BY id").all()).map((r) => r.envelope).filter((e) => e.event_type === 'network.user.updated');
const ALEX = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';

await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, role, display_name) VALUES (7, 'alex', 'x', ?, 'user', 'Alex')").run(ALEX);
await db.prepare("INSERT INTO users (id, username, password_hash, is_anon, anon_number) VALUES (8, 'anon-1', 'x', 1, 1)").run();
assert.strictEqual(await profile.drain(db), 1, 'the new account; never the guest');
let ev = await events();
assert.strictEqual(ev.length, 1);
assert.ok(validate('events.event-envelope@1', ev[0]).valid);
assert.ok(validate('network.user.updated@1', ev[0].payload).valid, JSON.stringify(validate('network.user.updated@1', ev[0].payload).errors));
assert.deepStrictEqual([ev[0].payload.revision, ev[0].payload.changed, ev[0].subject], [1, ['created'], { type: 'user', id: ALEX, revision: 1 }]);

// Changes from anywhere (here plain SQL, as an admin route or an import would) are recorded.
await db.prepare("UPDATE users SET role = 'global_mod' WHERE id = 7").run();
await db.prepare("UPDATE users SET avatar_url = 'https://openvibe.media/avatar/alex', display_name = 'Alex!' WHERE id = 7").run();
await db.prepare("UPDATE users SET last_seen = ov_now() WHERE id = 7").run();
assert.strictEqual(await profile.drain(db), 1, 'several quick changes become one event');
ev = await events();
assert.strictEqual(ev[1].payload.revision, 2);
assert.deepStrictEqual(ev[1].payload.changed.sort(), ['avatar_url', 'display_name', 'role']);
assert.strictEqual(ev[1].payload.role, 'global_mod'); assert.strictEqual(ev[1].payload.display_name, 'Alex!');
assert.strictEqual(await profile.drain(db), 0, 'last_seen is not a profile change');

await db.prepare("UPDATE users SET is_banned = 1, username = 'alex2' WHERE id = 7").run();
await profile.drain(db);
ev = await events();
assert.deepStrictEqual([ev[2].payload.revision, ev[2].payload.banned, ev[2].payload.username], [3, true, 'alex2']);
assert.deepStrictEqual(ev[2].payload.changed.sort(), ['banned', 'username']);

// A new account without a subject yet waits for one.
await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (9, 'nosub', 'x')").run();
assert.strictEqual(await profile.drain(db), 0, 'no subject yet: waits');
await db.prepare("UPDATE users SET subject_id = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB' WHERE id = 9").run();
assert.strictEqual(await profile.drain(db), 1, 'announced once it has one');
fs.rmSync(dir, { recursive: true, force: true });
console.log('profile events: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
