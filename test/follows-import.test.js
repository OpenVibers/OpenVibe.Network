'use strict';
// The follows backfill and its preflight (plan T2 "Follows"): npm run follows-import reads Live's follows from a
// read-only SQLite file and imports them into user_follows (dry run by default, no events, pairs without a
// subject held), a re-run imports nothing and never brings back an unfollow, and a hold is cleared once its pair
// maps; npm run follows-preflight prints counts only.
//   node test/follows-import.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const importer = require('../scripts/follows-import');
const preflight = require('../scripts/follows-preflight');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-follows-import-'));
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
try {
    const ANN = ids.newId('user'), BOB = ids.newId('user'), CAT = ids.newId('user'), DAN = ids.newId('user');
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id) VALUES (1, 'ann', 'x', ?), (2, 'bob', 'x', ?), (3, 'cat', 'x', ?), (4, 'dan', 'x', ?)").run(ANN, BOB, CAT, DAN);

    // Live's database: users 11..14 are ann, bob, cat and dan; 15 has no Network subject yet.
    const liveFile = path.join(dir, 'live.db');
    const live = importer.openSqlite(liveFile, { readonly: false });
    live.exec(`CREATE TABLE follows (id INTEGER PRIMARY KEY AUTOINCREMENT, follower_id INTEGER NOT NULL, streamer_id INTEGER NOT NULL,
            email_notify INTEGER DEFAULT 0, push_notify INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(follower_id, streamer_id));
        CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, service TEXT NOT NULL, service_user_id TEXT NOT NULL, subject_id TEXT);`);
    const link = live.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)");
    [[11, ANN], [12, BOB], [13, CAT], [14, DAN]].forEach(([u, s], i) => link.run(u, String(i + 1), s));
    const liveFollow = live.prepare("INSERT INTO follows (follower_id, streamer_id, email_notify, push_notify, created_at) VALUES (?, ?, ?, 1, '2026-01-02 03:04:05')");
    liveFollow.run(12, 11, 1);   // bob → ann
    liveFollow.run(13, 11, 0);   // cat → ann
    liveFollow.run(14, 11, 0);   // dan → ann: unfollowed on Network since
    liveFollow.run(15, 11, 0);   // no subject: held
    liveFollow.run(13, 12, 0);   // cat → bob: already on Network
    live.close();
    await db.prepare("INSERT INTO user_follows (follower_subject, target_type, target_id, active) VALUES (?, 'channel', ?, 0), (?, 'channel', ?, 1)").run(DAN, ANN, CAT, BOB);

    const lines = [];
    const run = async (fn, argv) => { lines.length = 0; const code = await fn.main(argv, { db, log: (m) => lines.push(m) }); return { code, out: lines.join('\n') }; };
    const active = async () => (await db.prepare("SELECT follower_subject AS f, target_id AS t, notify_email AS e, source FROM user_follows WHERE active = 1 ORDER BY follower_subject, target_id").all());

    assert.strictEqual((await run(importer, [])).code, 2, 'the Live database is required');
    assert.strictEqual((await run(importer, ['--live-db', path.join(dir, 'nope.db')])).code, 2);

    // Dry run: counts, nothing changed.
    let r = await run(importer, ['--live-db', liveFile]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /live rows {2}5; to import 2; already on Network 2; held: follower_has_no_subject 1/);
    assert.match(r.out, /dry run: nothing changed/);
    assert.strictEqual((await active()).length, 1);
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS c FROM follow_import_holds').get()).c, 0);

    // Preflight before: counts only.
    r = await run(preflight, []);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /active follows {5}1 \(1 channels, 1 followers\)\nunfollowed rows {4}1\nunresolved holds {3}0$/);

    // Applied: bob and cat now follow ann (Live's flags and time kept, source live), dan's unfollow stands.
    r = await run(importer, ['--live-db', liveFile, '--apply']);
    assert.match(r.out, /imported 2; already on Network 2; held: follower_has_no_subject 1/);
    const rows = await active();
    assert.deepStrictEqual(rows.filter((x) => x.t === ANN).map((x) => [x.f, x.e, x.source]).sort(), [[BOB, 1, 'live'], [CAT, 0, 'live']].sort());
    assert.ok(!rows.some((x) => x.f === DAN), 'an unfollow made on Network is never brought back');
    assert.strictEqual((await db.prepare('SELECT created_at FROM user_follows WHERE follower_subject = ? AND target_id = ?').get(BOB, ANN)).created_at, '2026-01-02T03:04:05.000Z');
    assert.strictEqual((await db.prepare("SELECT COUNT(*) AS c FROM network_event_outbox WHERE envelope->>'event_type' LIKE 'network.follow.%'").get()).c, 0, 'no events');
    assert.strictEqual((await db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'FOLLOW'").get()).c, 0, 'nobody is notified');

    // Preflight: the held pair is counted, never named.
    r = await run(preflight, []);
    assert.match(r.out, /active follows {5}3 \(2 channels, 2 followers\)\nunfollowed rows {4}1\nunresolved holds {3}1 \(live:follower_has_no_subject 1\)$/);
    for (const s of [ANN, BOB, CAT, DAN]) assert.ok(!r.out.includes(s), `no personal data: ${s}`);
    assert.doesNotMatch(r.out, /\b(ann|bob|cat|dan)\b|usr_/, 'no usernames or subjects');

    // Idempotent: a second run imports nothing.
    r = await run(importer, ['--live-db', liveFile, '--apply']);
    assert.match(r.out, /imported 0; already on Network 4; held: follower_has_no_subject 1/);
    assert.strictEqual((await active()).length, 3);

    // Live user 15 gets a Network account: the next run imports the pair and clears its hold.
    const EVE = ids.newId('user');
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id) VALUES (5, 'eve', 'x', ?)").run(EVE);
    const live2 = importer.openSqlite(liveFile, { readonly: false });
    live2.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (15, 'network', '5', ?)").run(EVE);
    live2.close();
    r = await run(importer, ['--live-db', liveFile, '--apply']);
    assert.match(r.out, /imported 1; already on Network 4; held: none/);
    r = await run(preflight, []);
    assert.match(r.out, /unresolved holds {3}0$/);
    assert.strictEqual((await run(preflight, ['--apply'])).code, 2, 'the preflight takes no options');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('follows import: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
