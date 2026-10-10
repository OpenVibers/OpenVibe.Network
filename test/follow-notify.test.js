'use strict';
// FOLLOW notifications from Network's follow graph (roadmap WS-E task 3, ADR-020, ADR-030): a follow that
// starts tells the followed person once, in the follow's transaction with its network.notification.created
// event; following again within the hour, changing flags, importing and unfollowing notify nobody; the
// person's social preference and blocks apply; a failing notifier never fails the follow.
//   node test/follow-notify.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDb } = require('../server/db/database');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-follow-notify-'));
const log = console.log; console.log = () => {};
const db = await getDb();
console.log = log;
require('../server/identity/blocks').ensureSchema(db);

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const CAT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC';
const DAN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPD';
await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id, avatar_url) VALUES
    (1, 'ann', 'Ann', 'x', ?, 'https://openvibe.media/avatar/ann'), (2, 'bob', 'Bob', 'x', ?, NULL),
    (3, 'cat', NULL, 'x', ?, NULL), (4, 'dan', 'Dan', 'x', ?, NULL)`).run(ANN, BOB, CAT, DAN);

const { NotificationService } = require('../server/notifications/notification-service');
const notifications = new NotificationService(db);
const follows = require('../server/identity/follows');
follows.ensureSchema(db);
follows.setNotifier(require('../server/notifications/follow-notify').followNotifier(notifications));

const followsOf = async (userId) => await db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'FOLLOW' ORDER BY created_at").all(userId);
const announced = async () => (await db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all()).map((r) => r.envelope)
    .filter((e) => e.event_type === 'network.notification.created');

// A new follow: one FOLLOW for the followed person, from the follower, linking to the follower's channel.
await follows.setFollow(db, ANN, 'channel', BOB, true);
let n = await followsOf(2);
assert.strictEqual(n.length, 1);
assert.strictEqual(n[0].message, 'Ann followed you');
assert.strictEqual(n[0].title, 'New Follower');
assert.strictEqual(n[0].url, 'https://openvibe.live/@ann');
assert.strictEqual(n[0].service, 'live');
assert.strictEqual(n[0].category, 'social');
assert.strictEqual(n[0].sender_id, 1);
assert.strictEqual(n[0].sender_avatar, 'https://openvibe.media/avatar/ann');
assert.deepStrictEqual((await announced()).map((e) => [e.subject.id, e.payload.type]), [[BOB, 'FOLLOW']], 'announced to the followed person');
assert.strictEqual((await followsOf(1)).length, 0, 'the follower is not notified');

// Same follow again, a flag change, an unfollow, and following again within the hour: nothing new.
await follows.setFollow(db, ANN, 'channel', BOB, true);
await follows.setFollow(db, ANN, 'channel', BOB, true, { notifyEmail: false });
await follows.setFollow(db, ANN, 'channel', BOB, false);
await follows.setFollow(db, ANN, 'channel', BOB, true);
assert.strictEqual((await followsOf(2)).length, 1, 'one an hour per follower');
assert.strictEqual((await announced()).length, 1);

// Another follower is another notification; a name falls back to the username.
await follows.setFollow(db, CAT, 'channel', BOB, true);
n = await followsOf(2);
assert.strictEqual(n.length, 2);
assert.strictEqual(n[1].message, 'cat followed you');

// A follow written without event emission also creates no notification.
await follows.setFollow(db, DAN, 'channel', ANN, true, { emit: false });
assert.ok((await follows.status(db, 'channel', ANN, DAN)).following);
assert.strictEqual((await followsOf(1)).length, 0);

// The followed person's social preference off: the follow is made, no notification.
await notifications.setPreference(4, 'social', { enabled: false });
await follows.setFollow(db, ANN, 'channel', DAN, true);
assert.ok((await follows.status(db, 'channel', DAN, ANN)).following);
assert.strictEqual((await followsOf(4)).length, 0);

// A follower the followed person blocked: no notification.
await db.prepare('INSERT INTO user_blocks (blocker_subject, blocked_subject) VALUES (?, ?)').run(ANN, CAT);
await follows.setFollow(db, CAT, 'channel', ANN, true);
assert.strictEqual((await followsOf(1)).length, 0, 'blocked follower');
await follows.setFollow(db, BOB, 'channel', ANN, true);
assert.strictEqual((await followsOf(1)).length, 1, 'anyone else still notifies');

// A notifier that throws never fails the follow, and the follow and its event still commit.
follows.setNotifier(() => { throw new Error('boom'); });
const warn = console.warn; console.warn = () => {};
const out = await follows.setFollow(db, DAN, 'channel', CAT, true);
console.warn = warn;
assert.ok(out.changed && out.active);
assert.ok((await follows.status(db, 'channel', CAT, DAN)).following);
{
    const created = await db.prepare("SELECT envelope FROM network_event_outbox WHERE envelope->>'event_type' = 'network.follow.created'").all();
    assert.ok(created.some((r) => r.envelope.payload.follower === DAN && r.envelope.payload.target_type === 'channel' && r.envelope.payload.target_id === CAT), 'the follow and its event still commit');
}
follows.setNotifier(null);

fs.rmSync(dir, { recursive: true, force: true });
console.log('follow notifications: ok');
})().catch(err => { console.error(err); process.exit(1); });
