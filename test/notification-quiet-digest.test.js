'use strict';
// Quiet hours and notification digests (migration 0027):
//   - inQuiet: cross-midnight and same-day windows, start === end, unknown zones, and a DST-change date
//     in America/Los_Angeles (the wall clock, via Intl, not a fixed UTC offset);
//   - the API: the default window, a saved window, bad times/zones as 400, and the digest preference;
//   - email: a normal notification waits out quiet hours, a critical one breaks through, and the held
//     notification goes out on the first pass after the window;
//   - digests: a digested category is not emailed one by one, one hourly email lists and marks the items,
//     a second run inside the hour sends nothing, and a daily digest waits for 08:00 local.
//   node --import ./test/helpers/pg-preload.mjs test/notification-quiet-digest.test.js
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { getDb } = require('../server/db/database');
const { NotificationService } = require('../server/notifications/notification-service');
const { EmailService } = require('../server/notifications/email-service');
const createNotificationRoutes = require('../server/notifications/routes');
const quiet = require('../server/notifications/quiet-hours');
const { runDigests, digestDue } = require('../server/notifications/digest');
const { signToken } = require('../server/auth/routes');

const DAY = 24 * 60 * 60 * 1000;

(async () => {
const db = getDb();
const log = console.log; console.log = () => {};
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_quiet_digest';
await db.prepare("INSERT INTO site_settings (key, value, type) VALUES ('email_enabled', 'true', 'boolean') ON CONFLICT (key) DO UPDATE SET value = 'true', type = 'boolean'").run();
await db.prepare(`INSERT INTO users (id, username, email, password_hash, email_verified) VALUES
    (1, 'qa', 'qa@example.test', 'x', 1),
    (2, 'rita', 'rita@example.test', 'x', 1),
    (3, 'dora', 'dora@example.test', 'x', 1),
    (4, 'wanda', 'wanda@example.test', 'x', 1)`).run();

const notifications = new NotificationService(db);
const emailService = new EmailService(db);
await emailService.ready;
assert.strictEqual(emailService.isEnabled, true, 'the email service is enabled for the test');
const sent = [];
emailService._sendEmail = async (opts) => { sent.push(opts); return true; };

// ── 1. inQuiet ────────────────────────────────────────────────────────────────────────────────
const cross = { enabled: true, start_min: 22 * 60, end_min: 7 * 60, tz: 'UTC' };
assert.strictEqual(quiet.inQuiet(cross, Date.parse('2026-01-15T23:30:00Z')), true, '23:30 is inside 22:00–07:00');
assert.strictEqual(quiet.inQuiet(cross, Date.parse('2026-01-16T06:59:00Z')), true, '06:59 is still inside the window');
assert.strictEqual(quiet.inQuiet(cross, Date.parse('2026-01-16T07:00:00Z')), false, '07:00 ends it');
assert.strictEqual(quiet.inQuiet(cross, Date.parse('2026-01-15T12:00:00Z')), false, 'midday is outside it');

const sameDay = { enabled: true, start_min: 9 * 60, end_min: 17 * 60, tz: 'UTC' };
assert.strictEqual(quiet.inQuiet(sameDay, Date.parse('2026-01-15T09:00:00Z')), true, '09:00 starts a same-day window');
assert.strictEqual(quiet.inQuiet(sameDay, Date.parse('2026-01-15T16:59:00Z')), true, '16:59 is inside it');
assert.strictEqual(quiet.inQuiet(sameDay, Date.parse('2026-01-15T17:00:00Z')), false, '17:00 ends it');
assert.strictEqual(quiet.inQuiet(sameDay, Date.parse('2026-01-15T08:59:00Z')), false, '08:59 is before it');
assert.strictEqual(quiet.inQuiet({ ...sameDay, enabled: false }, Date.parse('2026-01-15T12:00:00Z')), false, 'disabled means no window');
assert.strictEqual(quiet.inQuiet({ ...sameDay, start_min: 600, end_min: 600 }, Date.parse('2026-01-15T10:00:00Z')), false, 'start === end is no window');
assert.strictEqual(quiet.inQuiet({ ...cross, tz: 'Not/AZone' }, Date.parse('2026-01-15T23:00:00Z')), true, 'an unknown zone is read as UTC');

// America/Los_Angeles, 2026-03-08: 02:00 PST jumps to 03:00 PDT. A 01:00–04:00 wall-clock window has
// to follow the clock, not a fixed -8 offset.
const LA = 'America/Los_Angeles';
const laWindow = { enabled: true, start_min: 60, end_min: 4 * 60, tz: LA };
assert.strictEqual(quiet.inQuiet(laWindow, Date.parse('2026-03-08T08:30:00Z')), false, '00:30 PST, before the window');
assert.strictEqual(quiet.inQuiet(laWindow, Date.parse('2026-03-08T09:30:00Z')), true, '01:30 PST, inside it');
assert.strictEqual(quiet.zoned(Date.parse('2026-03-08T10:00:00Z'), LA).hour, 3, '10:00Z is 03:00 PDT after the jump');
assert.strictEqual(quiet.inQuiet(laWindow, Date.parse('2026-03-08T10:30:00Z')), true, '03:30 PDT, still inside it');
assert.strictEqual(quiet.inQuiet(laWindow, Date.parse('2026-03-08T11:30:00Z')), false, '04:30 PDT, after it');

// Weekly morning rule (the daily and weekly share it).
assert.strictEqual(digestDue('weekly', null, Date.parse('2026-01-15T07:59:00Z'), 'UTC'), false, 'weekly waits for 08:00');
assert.strictEqual(digestDue('weekly', null, Date.parse('2026-01-15T08:00:00Z'), 'UTC'), true, 'weekly may start at 08:00');
assert.strictEqual(digestDue('weekly', '2026-01-08 20:00:00', Date.parse('2026-01-15T09:00:00Z'), 'UTC'), true, '6.5 days later');
assert.strictEqual(digestDue('weekly', '2026-01-09 08:00:00', Date.parse('2026-01-15T09:00:00Z'), 'UTC'), false, 'six days is too soon');

// ── 2. The API ────────────────────────────────────────────────────────────────────────────────
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const qa = await db.prepare('SELECT * FROM users WHERE id = 1').get();
const token = signToken(qa, keys.privateKey, config);
const app = express();
app.use(express.json());
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/api/notifications', createNotificationRoutes(db, notifications, requireAuth));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (method, path, body) => fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
    let r = await call('GET', '/api/notifications/quiet-hours');
    assert.deepStrictEqual([r.status, r.body.enabled, r.body.start, r.body.end, r.body.tz, typeof r.body.in_quiet],
        [200, false, '22:00', '07:00', 'UTC', 'boolean'], 'the unset window is 22:00–07:00 UTC, off');

    r = await call('PUT', '/api/notifications/quiet-hours', { enabled: true, start: '22:00', end: '07:00', tz: 'America/Los_Angeles' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.enabled, r.body.start, r.body.end, r.body.tz], [true, '22:00', '07:00', 'America/Los_Angeles']);
    r = await call('GET', '/api/notifications/quiet-hours');
    assert.deepStrictEqual([r.body.enabled, r.body.start, r.body.end, r.body.tz], [true, '22:00', '07:00', 'America/Los_Angeles'], 'the saved window reads back');
    assert.strictEqual(typeof r.body.in_quiet, 'boolean');

    r = await call('PUT', '/api/notifications/quiet-hours', { enabled: true, start: '25:00', end: '07:00', tz: 'UTC' });
    assert.strictEqual(r.status, 400, 'a bad time is refused');
    r = await call('PUT', '/api/notifications/quiet-hours', { enabled: true, start: '22:00', end: '07:00', tz: 'Mars/Olympus' });
    assert.strictEqual(r.status, 400, 'an unknown zone is refused');
    r = await call('GET', '/api/notifications/quiet-hours');
    assert.strictEqual(r.body.tz, 'America/Los_Angeles', 'a refused update changes nothing');

    r = await call('PUT', '/api/notifications/preferences', { category: 'social', digest: 'daily' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await call('GET', '/api/notifications/preferences');
    let social = r.body.preferences.find((p) => p.category === 'social');
    assert.strictEqual(social.digest, 'daily', 'the digest preference round-trips');

    r = await call('PUT', '/api/notifications/preferences', { category: 'social', digest: 'off' });
    assert.strictEqual(r.status, 200);
    r = await call('GET', '/api/notifications/preferences');
    social = r.body.preferences.find((p) => p.category === 'social');
    assert.strictEqual(social.digest, 'off', 'NULL reads back as off');
    const raw = await db.prepare("SELECT digest FROM notification_preferences WHERE user_id = 1 AND category = 'social'").get();
    assert.strictEqual(raw.digest, null, "'off' is stored as NULL");

    r = await call('PUT', '/api/notifications/preferences', { category: 'social', digest: 'sometimes' });
    assert.strictEqual(r.status, 400, 'an unknown digest is refused');
} finally {
    await new Promise((r) => server.close(r));
}

// ── 3. Email quiet hours ──────────────────────────────────────────────────────────────────────
const rita = await db.prepare('SELECT * FROM users WHERE id = 2').get();
await notifications.setQuietHours(rita.id, { enabled: true, start: '22:00', end: '07:00', tz: 'UTC' });
// A normal go-live alert (normally emailed because STREAM_LIVE is a default email type) and a critical
// security notice, both created during the window.
const live = await notifications.create({ user_id: rita.id, type: 'STREAM_LIVE', category: 'stream', priority: 'high', title: 'Rita is live', sender_id: 99, sender_name: 'Rita', service: 'live', url: 'https://openvibe.live/rita' });
const critical = await notifications.create({ user_id: rita.id, type: 'GENERIC', category: 'system', priority: 'critical', title: 'Security alert', message: 'A new sign-in', service: 'network' });
assert.ok(live && critical);

const realNow = Date.now;
let ritaQuiet = Date.parse('2026-01-15T23:00:00Z');
Date.now = () => ritaQuiet;
try {
    sent.length = 0;
    await emailService.processQueue(notifications);
    assert.strictEqual(sent.length, 1, 'only the critical notification is emailed during quiet hours');
    assert.match(sent[0].subject, /Security alert/);
    assert.strictEqual((await db.prepare('SELECT is_emailed FROM notifications WHERE id = ?').get(live.id)).is_emailed, 0, 'the normal one stays pending');
    assert.strictEqual((await db.prepare('SELECT is_emailed FROM notifications WHERE id = ?').get(critical.id)).is_emailed, 1, 'critical breaks through');

    // The window ends: the queue picks the held notification up on its next pass.
    ritaQuiet = Date.parse('2026-01-16T07:00:00Z');
    sent.length = 0;
    await emailService.processQueue(notifications);
    assert.strictEqual(sent.length, 1, 'the held notification is emailed after the window');
    assert.match(sent[0].subject, /Rita is live/);
    assert.strictEqual((await db.prepare('SELECT is_emailed FROM notifications WHERE id = ?').get(live.id)).is_emailed, 1, 'and is marked emailed');
} finally {
    Date.now = realNow;
}

// ── 4. Digests ────────────────────────────────────────────────────────────────────────────────
// Hourly: the category is never emailed one by one; runDigests sends one summary and marks the item.
const dora = await db.prepare('SELECT * FROM users WHERE id = 3').get();
await notifications.setPreference(dora.id, 'social', { digest: 'hourly' });
const d1 = await notifications.create({ user_id: dora.id, type: 'FOLLOW', category: 'social', priority: 'normal', title: 'New follower', message: 'someone followed you', service: 'live', url: 'https://openvibe.live/@someone' });
assert.ok(d1);
sent.length = 0;
await emailService.processQueue(notifications);
assert.strictEqual(sent.length, 0, 'an hourly-digest category is not emailed one by one');
assert.strictEqual((await db.prepare('SELECT is_emailed FROM notifications WHERE id = ?').get(d1.id)).is_emailed, 0, 'it is left for the digest');

let now = Date.parse('2026-01-15T12:00:00Z');
let result = await runDigests(now, { db, notificationService: notifications, emailService });
assert.strictEqual(result.sent, 1, 'the first hourly digest is due');
assert.strictEqual(sent.length, 1);
assert.strictEqual(sent[0].subject, 'Your OpenVibe digest: 1 new');
assert.match(sent[0].textBody, /New follower/);
assert.match(sent[0].textBody, /live/);
assert.match(sent[0].textBody, /https:\/\/openvibe\.live\/@someone/);
assert.strictEqual((await db.prepare('SELECT is_emailed FROM notifications WHERE id = ?').get(d1.id)).is_emailed, 1, 'the item is marked emailed');
let run = await db.prepare("SELECT * FROM notification_digest_runs WHERE user_id = ? AND period = 'hourly'").get(dora.id);
assert.strictEqual(run.last_sent_at, '2026-01-15 12:00:00', 'the run is recorded');

const d2 = await notifications.create({ user_id: dora.id, type: 'FOLLOW', category: 'social', priority: 'normal', title: 'Another follower', service: 'live', url: 'https://openvibe.live/@another' });
sent.length = 0;
result = await runDigests(now + 30 * 60 * 1000, { db, notificationService: notifications, emailService });
assert.strictEqual(result.sent, 0, 'a second run inside the hour sends nothing');
assert.strictEqual(sent.length, 0);
assert.strictEqual((await db.prepare('SELECT is_emailed FROM notifications WHERE id = ?').get(d2.id)).is_emailed, 0, 'the new item waits for the next hour');

sent.length = 0;
result = await runDigests(now + 61 * 60 * 1000, { db, notificationService: notifications, emailService });
assert.strictEqual(result.sent, 1, 'an hour after the last run it is due again');
assert.strictEqual(sent[0].subject, 'Your OpenVibe digest: 1 new');
assert.strictEqual((await db.prepare('SELECT is_emailed FROM notifications WHERE id = ?').get(d2.id)).is_emailed, 1);

// Daily: 08:00 in the person's quiet-hours zone (08:00 PST is 16:00Z), never before it.
const wanda = await db.prepare('SELECT * FROM users WHERE id = 4').get();
await notifications.setQuietHours(wanda.id, { enabled: false, start: '22:00', end: '07:00', tz: LA });
await notifications.setPreference(wanda.id, 'economy', { digest: 'daily' });
const daily = await notifications.create({ user_id: wanda.id, type: 'COINS_RECEIVED', category: 'economy', priority: 'normal', title: 'Coins received', service: 'network' });
assert.ok(daily);

sent.length = 0;
result = await runDigests(Date.parse('2026-01-15T15:59:00Z'), { db, notificationService: notifications, emailService });
assert.strictEqual(result.sent, 0, 'daily waits for 08:00 local');
assert.strictEqual(sent.length, 0);
assert.strictEqual((await db.prepare('SELECT is_emailed FROM notifications WHERE id = ?').get(daily.id)).is_emailed, 0);

result = await runDigests(Date.parse('2026-01-15T16:00:00Z'), { db, notificationService: notifications, emailService });
assert.strictEqual(result.sent, 1, '08:00 local makes the daily digest due');
assert.strictEqual(sent[0].subject, 'Your OpenVibe digest: 1 new');
assert.strictEqual(sent[0].emailType, 'notification_digest:daily');
assert.match(sent[0].textBody, /Coins received/);
assert.strictEqual((await db.prepare('SELECT is_emailed FROM notifications WHERE id = ?').get(daily.id)).is_emailed, 1);
run = await db.prepare("SELECT * FROM notification_digest_runs WHERE user_id = ? AND period = 'daily'").get(wanda.id);
assert.strictEqual(run.last_sent_at, '2026-01-15 16:00:00');

// The next day before 08:00 is still not due; at 08:00 it is.
await notifications.create({ user_id: wanda.id, type: 'COINS_RECEIVED', category: 'economy', priority: 'normal', title: 'More coins', service: 'network' });
sent.length = 0;
result = await runDigests(Date.parse('2026-01-16T15:59:00Z'), { db, notificationService: notifications, emailService });
assert.strictEqual(result.sent, 0, 'the next day before 08:00 local is not due');
result = await runDigests(Date.parse('2026-01-16T16:00:00Z'), { db, notificationService: notifications, emailService });
assert.strictEqual(result.sent, 1, 'the next morning at 08:00 local is due');
assert.strictEqual(sent[0].subject, 'Your OpenVibe digest: 1 new');

// A digest is never sent inside quiet hours.
await notifications.setQuietHours(wanda.id, { enabled: true, start: '07:00', end: '10:00', tz: LA });
await notifications.create({ user_id: wanda.id, type: 'COINS_RECEIVED', category: 'economy', priority: 'normal', title: 'Held coin', service: 'network' });
sent.length = 0;
result = await runDigests(Date.parse('2026-01-17T16:30:00Z'), { db, notificationService: notifications, emailService });   // 08:30 PST
assert.strictEqual(result.sent, 0, 'quiet hours hold the digest');
assert.strictEqual(sent.length, 0);

console.log = log;
console.log('quiet hours and notification digests: ok');
})().catch((err) => { console.error(err); process.exit(1); });
