'use strict';
// Creator analytics (roadmap WS-E task 6; Contracts 0.68.0): live.stream.ended events become per-stream rows
// (counts only; a redelivery replaces), the public sees streams, minutes and peak viewers, the creator and
// services with network.analytics.creator.read see the rest, and nothing stored names a viewer, chatter or IP.
//   node test/creator-analytics.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { ids, validate } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { initDb } = require('../server/db/database');
const { NotificationService } = require('../server/notifications/notification-service');
const { createEventsConsumer } = require('../server/notifications/events-consumer');
const creators = require('../server/analytics/creators');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-creator-analytics-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
require('../server/identity/principals').ensureSchema(db);
for (const c of ['live', 'tools']) db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(`${c}-secret`, c);
const CAROL = ids.newId('user'), DAVE = ids.newId('user');
db.prepare('INSERT INTO users (id, username, password_hash, subject_id, role) VALUES (20, ?, ?, ?, ?), (21, ?, ?, ?, ?)').run('carol', 'x', CAROL, 'streamer', 'dave', 'x', DAVE, 'user');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const SECRET = 's'.repeat(40);
const consumer = createEventsConsumer({ db, notifications: new NotificationService(db), secrets: SECRET, log: { log() {}, warn() {}, error() {} } });
const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use(require('cookie-parser')());
app.use(express.urlencoded({ extended: true }));
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal/events', consumer.router);
app.use('/api/v1/creators', creators.router({ fullGuard: require('../server/identity/principals').guard('network.analytics.creator.read', { legacy: false }) }));
const server = http.createServer(app);

const ended = (streamId, startedAt, minutes, stats) => ({
    event_id: ids.newId('event'), event_type: 'live.stream.ended', version: 1, source: 'live',
    actor: { type: 'user', id: CAROL }, subject: { type: 'stream', id: String(streamId), revision: 2 }, visibility: 'public', priority: 'important',
    occurred_at: new Date().toISOString(),
    payload: { stream_id: streamId, channel: { username: 'carol', display_name: 'Carol', url: 'https://openvibe.live/@carol', subject: { type: 'user', id: CAROL } }, title: `Stream ${streamId}`, category: null, protocol: 'rtmp', is_nsfw: false,
        started_at: startedAt, ended_at: new Date(Date.parse(startedAt) + minutes * 60000).toISOString(), duration_seconds: minutes * 60, ...(stats ? { stats } : {}) },
});

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const deliver = async (event) => { const raw = JSON.stringify({ event, seq: 1 }); const res = await fetch(`${base}/internal/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...signDeliveryHeaders(raw, SECRET) }, body: raw }); return res.json(); };
    const call = (p, headers = {}) => fetch(base + p, { headers }).then(async (r) => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }));
    const svc = async (client) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: `${client}-secret`, audience: 'openvibe.network' }) })).json()).access_token;
    try {
        const day = (h) => new Date(Date.now() - h * 3600000).toISOString();
        const e1 = ended(501, day(30), 60, { peak_viewers: 12, avg_viewers: 6.5, unique_chatters: 4, messages: 120, watch_minutes: 300 });
        assert.strictEqual((await deliver(e1)).outcome, 'analytics:recorded');
        assert.strictEqual((await deliver(ended(502, day(2), 30, { peak_viewers: 20, avg_viewers: 10, unique_chatters: 9, messages: 200, watch_minutes: 250 }))).outcome, 'analytics:recorded');
        assert.strictEqual((await deliver(ended(503, day(1), 15))).outcome, 'analytics:recorded', 'an ended stream without stats still counts');
        assert.strictEqual((await deliver({ ...ended(501, day(30), 60, { peak_viewers: 12, avg_viewers: 6.5, unique_chatters: 4, messages: 120, watch_minutes: 300 }) })).outcome, 'analytics:recorded', 'a new event for the same stream replaces it');
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM creator_streams').get().n, 3);
        assert.strictEqual((await deliver({ ...ended(504, day(1), 5), source: 'media' })).outcome, 'ignored:source');

        // Public: streams, minutes, peak. No audience figures.
        let r = await call('/api/v1/creators/carol/analytics?days=30');
        assert.strictEqual(r.status, 200);
        assert.ok(validate('network.creator-analytics-result@1', r.body).valid, JSON.stringify(validate('network.creator-analytics-result@1', r.body).errors));
        assert.deepStrictEqual([r.body.full, r.body.totals], [false, { streams: 3, stream_seconds: 6300, peak_viewers: 20 }]);
        assert.ok(!r.body.streams.some((s) => 'messages' in s || 'unique_chatters' in s));
        assert.match(r.cache, /public/);
        assert.strictEqual(r.body.daily.reduce((n, d) => n + d.streams, 0), 3);

        // The creator, and Live's service token: full figures. Another person: public only. A service without the grant: refused.
        const creatorTok = { authorization: `Bearer ${signToken(db.prepare('SELECT * FROM users WHERE id = 20').get(), keys.privateKey, config)}` };
        r = await call(`/api/v1/creators/${CAROL}/analytics`, creatorTok);
        assert.deepStrictEqual([r.body.full, r.body.totals.messages, r.body.totals.unique_chatters, r.body.totals.watch_minutes], [true, 320, 13, 550]);
        assert.strictEqual(r.body.totals.avg_viewers, Math.round(((6.5 * 3600 + 10 * 1800) / 6300) * 10) / 10, 'duration-weighted average');
        assert.match(r.cache, /private/);
        r = await call('/api/v1/creators/carol/analytics', { authorization: `Bearer ${signToken(db.prepare('SELECT * FROM users WHERE id = 21').get(), keys.privateKey, config)}` });
        assert.strictEqual(r.body.full, false);
        r = await call('/api/v1/creators/carol/analytics', { authorization: `Bearer ${await svc('live')}` });
        assert.strictEqual(r.body.full, true);
        assert.strictEqual((await call('/api/v1/creators/carol/analytics', { authorization: `Bearer ${await svc('tools')}` })).status, 403);
        assert.strictEqual((await call('/api/v1/creators/nobody/analytics')).status, 404);

        // Privacy (ADR-021): the table holds counts and the creator's subject only.
        const cols = db.prepare('PRAGMA table_info(creator_streams)').all().map((c) => c.name);
        assert.deepStrictEqual(cols, creators.COLUMNS);
        assert.ok(!cols.some((c) => /ip|viewer_id|chatter_id|user_id|follower/.test(c)), 'no viewer, chatter or IP column');

        // History from Live's tables (scripts/creator-analytics-backfill.js): dry run, --backup required, event rows kept.
        const Database = require('better-sqlite3');
        const liveFile = path.join(dir, 'live.db');
        const live = new Database(liveFile);
        live.exec(`CREATE TABLE streams (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, category TEXT, started_at TEXT, ended_at TEXT, duration_seconds INTEGER, peak_viewers INTEGER);
            CREATE TABLE stream_analytics (stream_id INTEGER PRIMARY KEY, avg_viewers REAL, unique_chatters INTEGER, total_messages INTEGER, total_watch_minutes INTEGER);
            CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY, user_id INTEGER, service TEXT, service_user_id TEXT, subject_id TEXT);`);
        live.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (70, 'network', '20', ?)").run(CAROL);
        const t = (h) => new Date(Date.now() - h * 3600000).toISOString().replace('T', ' ').slice(0, 19);
        live.prepare('INSERT INTO streams VALUES (400, 70, ?, NULL, ?, ?, 1800, 9), (501, 70, ?, NULL, ?, ?, 3600, 99), (402, 71, ?, NULL, ?, ?, 600, 1)')
            .run('Old one', t(200), t(199.5), 'From events already', t(30), t(29), 'No subject', t(10), t(9.9));
        live.prepare('INSERT INTO stream_analytics VALUES (400, 4.2, 3, 50, 90)').run();
        live.close();
        const bf = require('../scripts/creator-analytics-backfill');
        const lines = [];
        db.close();
        assert.strictEqual(await bf.main(['--live-db', liveFile, '--db', path.join(dir, 'network.db')], (x) => lines.push(x)), 0);
        assert.match(lines.join('\n'), /import 1, already on Network 1, channel without a subject 1/);
        assert.strictEqual(await bf.main(['--live-db', liveFile, '--db', path.join(dir, 'network.db'), '--apply'], (x) => lines.push(x)), 2, 'a backup is required');
        assert.strictEqual(await bf.main(['--live-db', liveFile, '--db', path.join(dir, 'network.db'), '--apply', '--backup', path.join(dir, 'pre.db')], (x) => lines.push(x)), 0);
        const db2 = new Database(path.join(dir, 'network.db'), { readonly: true });
        assert.deepStrictEqual(db2.prepare('SELECT stream_id, messages, peak_viewers FROM creator_streams ORDER BY stream_id').all().map((x) => [x.stream_id, x.messages, x.peak_viewers]),
            [[400, 50, 9], [501, 120, 12], [502, 200, 20], [503, null, null]], 'imported the old stream; the event-sourced 501 kept its numbers');
        db2.close();
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('creator analytics: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
