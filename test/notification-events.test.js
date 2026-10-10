'use strict';
// The notification badge over OpenVibe.Events (roadmap WS-E task 3, WS-F task 1; ADR-005 amendment 2):
//   1. every stored notification queues network.notification.created in its own transaction (both or
//      neither): subject the recipient, visibility subject, actor system:network, no text or sender;
//      none for a muted category, a guest or an account without a usr_ subject; the relay publishes it;
//   2. POST /api/v1/realtime/ticket mints a two-minute realtime ticket for the signed-in person, refuses
//      guests and signed-out callers, obeys REALTIME_TICKETS=off, and a ticket is never a session;
//   3. a restart during a go-live (ADR-020 acceptance): a fan-out that dies mid-transaction leaves nothing,
//      the redelivery after the restart notifies every follower once, and a redelivery after the commit
//      notifies nobody again.
//   node test/notification-events.test.js
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const contracts = require('openvibe-contracts');
(async () => {
const { ids, serviceAuth } = contracts;
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { getDb } = require('../server/db/database');
const { NotificationService, NOTIFICATION_EVENT } = require('../server/notifications/notification-service');
const { createEventsConsumer } = require('../server/notifications/events-consumer');
const eventRelay = require('../server/developer/event-relay');
const ticketMod = require('../server/auth/realtime-ticket');
const session = require('../server/auth/session');
const { signToken } = require('../server/auth/routes');

const ISSUER = 'https://openvibe.network';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const quietly = (f) => { const l = console.log; console.log = () => {}; try { return f(); } finally { console.log = l; } };
let db = getDb();

const ALICE = ids.newId('user'), BOB = ids.newId('user'), CAROL = ids.newId('user'), DAVE = ids.newId('user'), ERIN = ids.newId('user');
await db.prepare(`INSERT INTO users (id, username, password_hash, subject_id, is_anon) VALUES
    (1, 'alice', 'x', ?, 0), (2, 'bob', 'x', ?, 0), (3, 'guest_1', 'x', NULL, 1), (4, 'nosubject', 'x', NULL, 0),
    (20, 'carol', 'x', ?, 0), (21, 'dave', 'x', ?, 0), (22, 'erin', 'x', ?, 0)`).run(ALICE, BOB, CAROL, DAVE, ERIN);

const outbox = async (d = db) => (await d.prepare(`SELECT envelope FROM ${eventRelay.TABLE} ORDER BY id`).all()).map((r) => r.envelope).filter((e) => e.event_type === NOTIFICATION_EVENT);
const PAYLOAD_KEYS = ['category', 'created_at', 'notification_id', 'priority', 'service', 'type', 'unread_count'];
const checkEnvelope = (env, subject) => {
    const v = contracts.validate('events.event-envelope@1', env);
    assert.ok(v.valid, JSON.stringify(v.errors));
    assert.strictEqual(env.source, 'network');
    assert.strictEqual(env.visibility, 'subject', 'Events streams it to its person only');
    assert.deepStrictEqual(env.subject, { type: 'user', id: subject });
    assert.deepStrictEqual(env.actor, { type: 'system', id: 'network' }, 'never the sender: a subject event reaches its actor too');
    assert.deepStrictEqual(Object.keys(env.payload).sort(), PAYLOAD_KEYS, 'what a badge needs, never what it shows');
    try { const pv = contracts.validate(`${NOTIFICATION_EVENT}@1`, env.payload); assert.ok(pv.valid, JSON.stringify(pv.errors)); } catch (err) { if (!/unknown contract/.test(err.message)) throw err; }
};

(async () => {
    // ── 1. network.notification.created, in the notification's transaction ────────────────────────
    let notifications = new NotificationService(db);
    const n1 = await notifications.create({ user_id: 1, type: 'CONTENT_REPLY', category: 'social', title: 'New reply to your comment', message: 'bob replied: secret words', sender_id: 2, sender_name: 'bob', url: 'https://openvibe.live/vod/5#comments', service: 'live' });
    assert.ok(n1);
    let evs = await outbox();
    assert.strictEqual(evs.length, 1);
    checkEnvelope(evs[0], ALICE);
    assert.deepStrictEqual({ ...evs[0].payload, created_at: null }, { notification_id: n1.id, type: 'CONTENT_REPLY', category: 'social', priority: 'normal', service: 'live', created_at: null, unread_count: 1 });
    assert.ok(!JSON.stringify(evs[0]).includes('secret words') && !JSON.stringify(evs[0]).includes('bob') && !JSON.stringify(evs[0]).includes(BOB), 'no text, no sender, anywhere in the envelope');
    await notifications.create({ user_id: 1, type: 'STREAM_LIVE', title: 'carol is live!', sender_id: 20, service: 'live' });
    evs = await outbox();
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[1].payload.unread_count, 2, 'the unread count after the insert');
    assert.strictEqual(evs[1].payload.category, 'stream');
    assert.notStrictEqual(evs[0].event_id, evs[1].event_id);

    // Nothing stored, nothing announced: a muted category; a blocked sender is the same rule (create() returns null).
    await notifications.setPreference(2, 'social', { enabled: false });
    assert.strictEqual(await notifications.create({ user_id: 2, type: 'FOLLOW', category: 'social', title: 'x' }), null);
    // Stored but never announced: a guest, an account without a usr_ subject.
    assert.ok(await notifications.create({ user_id: 3, type: 'WELCOME', title: 'hi' }));
    assert.ok(await notifications.create({ user_id: 4, type: 'WELCOME', title: 'hi' }));
    assert.strictEqual((await outbox()).length, 2);
    // Odd stored shapes are normalised in the event, never dropped with the notification.
    await notifications.create({ user_id: 2, type: 'arena_hot', category: 'Game Stuff', priority: 'urgent', title: 'x', service: 'Live!' });
    evs = await outbox();
    assert.strictEqual(evs.length, 3);
    checkEnvelope(evs[2], BOB);
    assert.deepStrictEqual([evs[2].payload.type, evs[2].payload.category, evs[2].payload.priority, evs[2].payload.service], ['GENERIC', 'system', 'normal', null]);

    // Both or neither: when the event cannot be queued, the notification is not stored either.
    await globalThis.__ovNetworkDdl(`CREATE OR REPLACE FUNCTION ov_test_outbox_down() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox down'; END $$;
        CREATE TRIGGER outbox_down BEFORE INSERT ON ${eventRelay.TABLE} FOR EACH ROW EXECUTE FUNCTION ov_test_outbox_down()`);
    const before = (await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = 1').get()).c;
    await assert.rejects(async () => await notifications.create({ user_id: 1, type: 'WELCOME', title: 'hi' }), /outbox down/);
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = 1').get()).c, before, 'no notification without its event');
    await globalThis.__ovNetworkDdl(`DROP TRIGGER IF EXISTS outbox_down ON ${eventRelay.TABLE}; DROP FUNCTION IF EXISTS ov_test_outbox_down()`);
    // A bulk fan-out is one transaction with one event per recipient.
    const bulk = await notifications.createBulk([1, 2, 21], { type: 'SERVICE_ANNOUNCEMENT', category: 'admin', title: 'Maintenance tonight' });
    assert.strictEqual(bulk.length, 3);
    assert.deepStrictEqual((await outbox()).slice(-3).map((e) => e.subject.id), [ALICE, BOB, DAVE]);

    // The relay publishes it to Events like every other Network event.
    const published = [];
    const relay = await eventRelay.startRelay(db, {
        eventsUrl: 'http://events.test', privateKey, issuer: ISSUER, autoStart: false, log: { log() {}, warn() {} },
        fetch: async (url, init) => {
            const body = JSON.parse(init.body);
            const list = Array.isArray(body.events) ? body.events : [body];
            published.push(...list);
            return new Response(JSON.stringify({ results: list.map((e, i) => ({ event_id: e.event_id, seq: i + 1 })) }), { status: 201, headers: { 'content-type': 'application/json' } });
        },
    });
    notifications = new NotificationService(db);
    await notifications.create({ user_id: 1, type: 'WELCOME', title: 'hi' });
    await relay.flush();
    assert.ok(published.some((e) => e.event_type === NOTIFICATION_EVENT && e.subject.id === ALICE), 'relayed to Events');
    await eventRelay.stopRelay(db);

    // ── 2. POST /api/v1/realtime/ticket ───────────────────────────────────────────────────────
    const config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
    let enabled = true;
    const app = express();
    app.locals.privateKey = privateKey;
    const requireAuth = session.makeRequireAuth(() => ({ db, publicKey, config }), signToken);
    app.use('/api/v1/realtime', ticketMod.router({ db, requireAuth, privateKey, issuer: ISSUER, streamUrl: '', isEnabled: () => enabled }));
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const mint = async (token, headers = {}) => {
        const r = await fetch(`${base}/api/v1/realtime/ticket`, { method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
        return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
    };
    const aliceSession = signToken(await db.prepare('SELECT * FROM users WHERE id = 1').get(), privateKey, config);
    let r = await mint(aliceSession);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['expires_at', 'expires_in', 'stream_url', 'subject', 'ticket', 'topics']);
    assert.deepStrictEqual([r.body.expires_in, r.body.stream_url, r.body.topics, r.body.subject], [120, 'https://openvibe.events/realtime/stream', ['network.notification.*'], ALICE]);
    try { const v = contracts.validate('network.realtime-ticket-result@1', r.body); assert.ok(v.valid, JSON.stringify(v.errors)); } catch (err) { if (!/unknown contract/.test(err.message)) throw err; }
    // What Events checks (OpenVibe.Events server/auth.js verifyRealtimeTicket).
    const claims = jwt.verify(r.body.ticket, publicKey, { algorithms: ['RS256'], issuer: `${ISSUER}/realtime`, audience: 'openvibe.events' });
    assert.deepStrictEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'purpose', 'sub', 'typ']);
    assert.deepStrictEqual([claims.sub, claims.aud, claims.typ, claims.purpose, claims.exp - claims.iat], [ALICE, ['openvibe.events'], 'realtime', 'realtime', 120]);
    assert.match(claims.jti, /^rtk_[0-9a-f]{24}$/);
    assert.strictEqual(jwt.decode(r.body.ticket, { complete: true }).header.alg, 'RS256');
    try { const v = contracts.validate('identity.realtime-ticket-claims@1', claims); assert.ok(v.valid, JSON.stringify(v.errors)); } catch (err) { if (!/unknown contract/.test(err.message)) throw err; }
    const again = await mint(aliceSession);
    assert.notStrictEqual(jwt.decode(again.body.ticket).jti, claims.jti, 'every ticket is its own');

    // A ticket is never a session: not here, not with the session issuer anyone checks.
    assert.ok((await session.verifySession(r.body.ticket, { db, publicKey, config })).error, 'Network\'s session guard refuses it');
    assert.strictEqual((await mint(r.body.ticket)).status, 401, 'no ticket for a ticket');
    assert.throws(() => jwt.verify(r.body.ticket, publicKey, { algorithms: ['RS256'], issuer: ISSUER }), /issuer/, 'services checking the session issuer refuse it');
    assert.throws(() => jwt.verify(r.body.ticket, publicKey, { algorithms: ['RS256'], issuer: `${ISSUER}/realtime`, audience: 'openvibe.live' }), /audience/);
    // Refused: signed out, a guest, a service token, and everyone while the operator has it off.
    assert.strictEqual((await mint(null)).status, 401);
    r = await mint(signToken(await db.prepare('SELECT * FROM users WHERE id = 3').get(), privateKey, config));
    assert.deepStrictEqual([r.status, r.body.code], [403, 'realtime.guest']);
    const svc = serviceAuth.signServiceToken({ iss: ISSUER, sub: 'svc:live', actor_type: 'service', aud: ['openvibe.network'], cap: [], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: 'tok_x' }, privateKey);
    assert.strictEqual((await mint(svc)).status, 401, 'services get no ticket');
    enabled = false;
    r = await mint(aliceSession);
    assert.deepStrictEqual([r.status, r.body.code], [503, 'realtime.disabled']);
    enabled = true;
    // An account that has no subject yet is given one.
    r = await mint(signToken(await db.prepare('SELECT * FROM users WHERE id = 4').get(), privateKey, config));
    assert.strictEqual(r.status, 200);
    assert.match(r.body.subject, /^usr_/);
    assert.strictEqual((await db.prepare('SELECT subject_id FROM users WHERE id = 4').get()).subject_id, r.body.subject);
    // The stream URL: the default, an operator's origin, or the default for anything odd.
    assert.strictEqual(ticketMod.streamUrlFrom(''), 'https://openvibe.events/realtime/stream');
    assert.strictEqual(ticketMod.streamUrlFrom('https://events.example.test/'), 'https://events.example.test/realtime/stream');
    assert.strictEqual(ticketMod.streamUrlFrom('https://events.example.test/realtime/stream'), 'https://events.example.test/realtime/stream');
    for (const bad of ['javascript:alert(1)', 'https://x.test/?a=1', 'not a url', 'https://u:p@x.test']) assert.strictEqual(ticketMod.streamUrlFrom(bad), ticketMod.DEFAULT_STREAM_URL, bad);
    assert.throws(() => ticketMod.mintTicket({ subject: '57', privateKey, issuer: ISSUER }), /usr_/);
    srv.close();

    // ── 3. A restart during a go-live ───────────────────────────────────────────────────────
    // Network's follow graph: Dave and Erin follow Carol.
    for (const f of [DAVE, ERIN]) await db.prepare("INSERT INTO user_follows (follower_subject, target_type, target_id) VALUES (?, 'channel', ?)").run(f, CAROL);
    const SECRET = 's'.repeat(40);
    const logged = []; const discord = [];
    async function boot() {
        // A fresh process: a new connection to the same file, new services, nothing in memory.
        const d = getDb();
        const n = new NotificationService(d);
        const c = await createEventsConsumer({
            db: d, notifications: n, secrets: SECRET, goLiveFollowersReady: true,
            discord: () => ({ sendLiveAlert: async (s) => { discord.push(s.username); return { sent: true }; } }),
            log: { log: (m) => logged.push(m), warn() {}, error() {} },
        });
        const a = express();
        a.use('/internal/events', c.router);
        const s = http.createServer(a);
        return new Promise((r2) => s.listen(0, '127.0.0.1', () => r2({ db: d, notifications: n, server: s, url: `http://127.0.0.1:${s.address().port}/internal/events` })));
    }
    const deliver = async (proc, event) => {
        const raw = JSON.stringify({ event, seq: 1 });
        const res = await fetch(proc.url, { method: 'POST', headers: { 'content-type': 'application/json', ...signDeliveryHeaders(raw, SECRET) }, body: raw });
        return { status: res.status, body: await res.json() };
    };
    // The database handle is the process's shared one (test/helpers/pg-preload.mjs): a "restart" closes the
    // server, not the database.
    const stop = (proc) => new Promise((r2) => proc.server.close(r2));
    const started = {
        event_id: ids.newId('event'), event_type: 'live.stream.started', version: 1, source: 'live',
        actor: { type: 'user', id: CAROL }, subject: { type: 'stream', id: '701', revision: 1 }, visibility: 'public', priority: 'important',
        occurred_at: new Date().toISOString(),
        payload: { stream_id: 701, channel: { username: 'carol', display_name: 'Carol', url: 'https://openvibe.live/@carol', subject: { type: 'user', id: CAROL } }, title: 'Go', category: null, protocol: 'whip', is_nsfw: false, started_at: new Date().toISOString() },
    };
    const goLives = async (d) => (await d.prepare("SELECT user_id, COUNT(*) AS c FROM notifications WHERE type = 'STREAM_LIVE' AND sender_id = 20 AND user_id IN (21, 22) GROUP BY user_id ORDER BY user_id").all()).map((x) => [x.user_id, x.c]);
    const goLiveEvents = async (d) => (await outbox(d)).filter((e) => [DAVE, ERIN].includes(e.subject.id) && e.payload.type === 'STREAM_LIVE').length;

    // The process dies in the middle of the fan-out (Dave's notification written, Erin's not): nothing
    // of it survives, not the notification, its event, the announcement window or the inbox claim.
    let proc = await boot();
    const create = proc.notifications.create.bind(proc.notifications);
    let calls = 0;
    proc.notifications.create = (data) => { if (++calls === 2) throw new Error('SIGKILL'); return create(data); };
    let r3 = await deliver(proc, started);
    assert.deepStrictEqual([r3.status, r3.body.code], [500, 'network.event_failed']);
    assert.deepStrictEqual(await goLives(proc.db), [], 'the half-done fan-out rolled back');
    assert.strictEqual(await goLiveEvents(proc.db), 0);
    assert.ok(!await proc.db.prepare('SELECT 1 FROM network_event_inbox WHERE event_id = ?').get(started.event_id));
    const claimed = await proc.db.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'stream_live_announcements'").get()
        ? (await proc.db.prepare("SELECT COUNT(*) AS c FROM stream_live_announcements WHERE stream_id = '701'").get()).c : 0;
    assert.strictEqual(claimed, 0, 'the announcement window is not spent');
    await stop(proc);

    // Restarted: Events redelivers, and every follower is told exactly once.
    proc = await boot();
    r3 = await deliver(proc, started);
    assert.strictEqual(r3.status, 200, JSON.stringify(r3.body));
    assert.deepStrictEqual([r3.body.duplicate, r3.body.outcome], [false, 'notified']);
    assert.deepStrictEqual(await goLives(proc.db), [[21, 1], [22, 1]]);
    assert.strictEqual(await goLiveEvents(proc.db), 2, 'one network.notification.created per follower');
    await new Promise((r2) => setImmediate(r2));
    assert.deepStrictEqual(discord, ['carol'], 'the Discord alert once, after the commit');
    assert.ok(logged.some((m) => m.includes(`live.stream.started ${started.event_id}: notified`)), 'the outcome is in the log (C-85 evidence)');

    // Restarted again after the commit but before Events saw the 200: the redelivery is a duplicate.
    await stop(proc);
    proc = await boot();
    r3 = await deliver(proc, started);
    assert.deepStrictEqual([r3.status, r3.body.duplicate, r3.body.outcome], [200, true, null]);
    assert.deepStrictEqual(await goLives(proc.db), [[21, 1], [22, 1]], 'nobody is told twice');
    assert.strictEqual(await goLiveEvents(proc.db), 2);
    await new Promise((r2) => setImmediate(r2));
    assert.deepStrictEqual(discord, ['carol']);
    await stop(proc);

    console.log('notification events: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
