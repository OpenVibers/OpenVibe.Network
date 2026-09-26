'use strict';
// Events → notifications (server/notifications/events-consumer.js): POST /internal/events turns
// deals.watch.matched and trade.alert.triggered into inbox notifications for the subscribed person,
// and live.stream.started into one go-live notification per follower (read from Live with a service
// token), exactly once, v2 signatures only, respecting their preferences.
//   node test/events-consumer.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
const { ids, serviceAuth } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { initDb } = require('../server/db/database');
const { NotificationService } = require('../server/notifications/notification-service');
const { createEventsConsumer, TOPICS } = require('../server/notifications/events-consumer');
const { createLiveFollowers } = require('../server/notifications/live-followers');
const streamLive = require('../server/notifications/stream-live');
const { topicsFrom } = require('../scripts/subscribe-events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-events-consumer-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;

const ALICE = ids.newId('user'), BOB = ids.newId('user'), NOBODY = ids.newId('user');
db.prepare("INSERT INTO users (id, username, password_hash, subject_id, email, email_verified) VALUES (7, 'alice', 'x', ?, 'alice@example.test', 1), (8, 'bob', 'x', ?, NULL, 0)").run(ALICE, BOB);
const notifications = new NotificationService(db);
const SECRET = 'a'.repeat(40), NEXT = 'b'.repeat(40);

const dealsEvent = (over = {}) => ({
    event_id: ids.newId('event'), event_type: 'deals.watch.matched', version: 1, source: 'deals',
    actor: { type: 'service', id: 'deals' }, subject: { type: 'watch', id: 'dwt_1' }, visibility: 'internal',
    occurred_at: new Date().toISOString(),
    payload: {
        watch_id: 'dwt_1', recipient: ALICE, kind: 'price_below', query: null, product_id: 'prd_1', max_price: '250.00', currency: 'USD',
        offer_id: 'dof_1', offer_url: 'https://openvibe.deals/d/dof_1-cheap-headphones', title: 'Cheap <b>headphones</b>',
        observation: { id: 'dob_1', observed_at: new Date().toISOString(), price: '199.00', currency: 'USD', availability: 'in_stock' },
    },
    ...over,
});
const tradeEvent = (over = {}) => ({
    event_id: ids.newId('event'), event_type: 'trade.alert.triggered', version: 1, source: 'trade',
    actor: { type: 'service', id: 'trade' }, subject: { type: 'user', id: BOB }, visibility: 'subject', priority: 'important',
    occurred_at: new Date().toISOString(),
    payload: {
        delivery_id: 'ald_1',
        rule: { id: 'alr_1', kind: 'threshold', metric: 'close', operator: 'above', threshold: '200', unit: 'USD' },
        instrument: { id: 'ins_1', symbol: 'AAPL', name: 'Apple Inc.', url: 'https://openvibe.trade/i/AAPL' },
        trigger: { kind: 'observation', id: 'obs_1', metric: 'close', value: '201.50', unit: 'USD' },
        disclaimer: 'Information only — not investment advice; no trading here.',
    },
    ...over,
});
const rows = (userId) => db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at, rowid').all(userId);

(async () => {
    // The subscriptions this consumer is meant for, and nothing else.
    assert.deepStrictEqual(TOPICS, ['deals.watch.matched', 'trade.alert.triggered', 'live.stream.started', 'chat.moderation.action', 'live.moderation.action', 'community.moderation.action', 'tips.interaction.moderated', 'billing.staff.action',
        ...['tools', 'games', 'wiki', 'blog', 'news', 'reviews', 'deals', 'coupons', 'trade', 'codes'].map((svc) => `${svc}.moderation.action`)]);
    assert.deepStrictEqual(topicsFrom([]), TOPICS, 'scripts/subscribe-events.js subscribes every topic');
    assert.deepStrictEqual(topicsFrom(['--topic', 'live.stream.started']), ['live.stream.started']);
    assert.throws(() => topicsFrom(['--topic', 'live.*']));

    let consumer = createEventsConsumer({ db, notifications, secrets: '' });
    const app = express();
    app.use('/internal/events', (req, res, next) => consumer.router(req, res, next));
    app.use(express.json());   // as in server/index.js: the consumer runs before the JSON parser
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/internal/events`;
    const post = async (event, { secret = SECRET, headers = null, strip = [], now } = {}) => {
        const raw = JSON.stringify({ event, seq: 1 });
        const h = { 'content-type': 'application/json', ...(headers || signDeliveryHeaders(raw, secret, now ? { now } : {})) };
        for (const k of strip) delete h[k];
        const r = await fetch(url, { method: 'POST', headers: h, body: raw });
        return { status: r.status, body: await r.json() };
    };

    // Inert until the secret is set: nothing is accepted.
    let r = await post(dealsEvent());
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.code, 'network.webhook_disabled');
    assert.strictEqual(rows(7).length, 0);

    consumer = createEventsConsumer({ db, notifications, secrets: `${SECRET},${NEXT}` });
    assert.strictEqual(consumer.enabled, true);

    // A signed v2 Deals watch match becomes one notification for the watcher.
    const e1 = dealsEvent();
    r = await post(e1);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { event_id: e1.event_id, duplicate: false, outcome: 'notified' });
    let mine = rows(7);
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0].type, 'DEAL_WATCH_MATCH');
    assert.strictEqual(mine[0].category, 'service');
    assert.strictEqual(mine[0].service, 'deals');
    assert.strictEqual(mine[0].title, 'Deal watch matched');
    assert.strictEqual(mine[0].message, 'Cheap b headphones /b at 199.00 USD (below your 250.00 USD)', 'no markup reaches the inbox');
    assert.strictEqual(mine[0].url, null, 'openvibe.deals serves a placeholder: no click-through yet');
    assert.strictEqual(JSON.parse(mine[0].rich_content).context.planned_url, 'https://openvibe.deals/d/dof_1-cheap-headphones');

    // The same event again (Events retries, or replays): a duplicate, nothing new.
    r = await post(e1);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.duplicate, true);
    assert.strictEqual(r.body.outcome, null);
    assert.strictEqual(rows(7).length, 1);

    // v1-only (the v2 headers stripped), stale v2, wrong secret, unsigned: refused, nothing stored.
    for (const [label, opts] of [
        ['v1 only', { strip: ['X-OpenVibe-Signature-V2', 'X-OpenVibe-Timestamp'] }],
        ['stale v2', { now: Date.now() - 10 * 60 * 1000 }],
        ['wrong secret', { secret: 'c'.repeat(40) }],
        ['unsigned', { headers: {} }],
    ]) {
        const e = dealsEvent();
        r = await post(e, opts);
        assert.strictEqual(r.status, 401, label);
        assert.strictEqual(r.body.code, 'network.bad_signature', label);
        assert.ok(!db.prepare('SELECT 1 FROM network_event_inbox WHERE event_id = ?').get(e.event_id), `${label}: not even recorded`);
    }
    assert.strictEqual(rows(7).length, 1);

    // The rotated-in secret verifies too.
    r = await post(dealsEvent({ payload: { ...dealsEvent().payload, kind: 'keyword', query: 'headphones', offer_id: 'dof_2' } }), { secret: NEXT });
    assert.strictEqual(r.body.outcome, 'notified');
    assert.match(rows(7)[1].message, /\(matches "headphones"\)$/);

    // Unknown types are acknowledged and ignored (and recorded, so a redelivery is a duplicate).
    const other = dealsEvent({ event_type: 'deals.offer.created' });
    r = await post(other);
    assert.deepStrictEqual([r.status, r.body.outcome], [200, 'ignored:type']);
    r = await post(other);
    assert.strictEqual(r.body.duplicate, true);
    r = await post(dealsEvent({ event_type: 'constructor' }));
    assert.strictEqual(r.body.outcome, 'ignored:type', 'no prototype lookups');
    assert.strictEqual(rows(7).length, 2);

    // A publisher may not speak for another service; an unknown person gets nothing.
    r = await post(dealsEvent({ source: 'trade' }));
    assert.strictEqual(r.body.outcome, 'ignored:source');
    r = await post(dealsEvent({ payload: { ...dealsEvent().payload, recipient: NOBODY } }));
    assert.strictEqual(r.body.outcome, 'ignored:recipient');
    r = await post(dealsEvent({ payload: { ...dealsEvent().payload, recipient: '7' } }));
    assert.strictEqual(r.body.outcome, 'ignored:recipient', 'recipients are usr_ subjects, never raw ids');

    // A Trade alert reaches the rule's owner.
    r = await post(tradeEvent());
    assert.strictEqual(r.body.outcome, 'notified');
    let bobs = rows(8);
    assert.strictEqual(bobs.length, 1);
    assert.strictEqual(bobs[0].type, 'TRADE_ALERT');
    assert.strictEqual(bobs[0].title, 'Trade alert: AAPL');
    assert.strictEqual(bobs[0].priority, 'high');
    assert.strictEqual(bobs[0].message, 'Apple Inc. — close is 201.50 USD (above 200). Information only — not investment advice; no trading here.');
    assert.strictEqual(bobs[0].url, null);
    r = await post(tradeEvent({ payload: { ...tradeEvent().payload, trigger: { kind: 'document', id: 'doc_1', form_type: '8-K', title: 'Current report' } } }));
    assert.strictEqual(r.body.outcome, 'notified');
    assert.match(rows(8)[1].message, /New 8-K: Current report\./);
    r = await post(tradeEvent({ subject: { type: 'watch', id: 'x' } }));
    assert.strictEqual(r.body.outcome, 'ignored:payload');

    // A link to a site whose domain serves the service is kept; a foreign host never is.
    r = await post(tradeEvent({ payload: { ...tradeEvent().payload, instrument: { symbol: 'X', url: 'https://openvibe.live/x' } } }));
    assert.strictEqual(rows(8).pop().url, 'https://openvibe.live/x');
    r = await post(tradeEvent({ payload: { ...tradeEvent().payload, instrument: { symbol: 'Y', url: 'https://evil.example/y' } } }));
    const last = rows(8).pop();
    assert.strictEqual(last.url, null);
    assert.strictEqual(JSON.parse(last.rich_content).context.planned_url, null);

    // Preferences: with the 'service' category turned off, nothing is created (and it stays handled).
    const before = rows(8).length;
    notifications.setPreference(8, 'service', { enabled: false });
    const muted = tradeEvent();
    r = await post(muted);
    assert.strictEqual(r.body.outcome, 'suppressed:preference');
    assert.strictEqual(rows(8).length, before);
    assert.strictEqual((await post(muted)).body.duplicate, true);
    // Email follows the same per-category choice: none by default, yes once opted in (verified address).
    const n = { ...rows(7)[0], email_verified: 1, email_bounced_at: null };
    assert.strictEqual(notifications.shouldEmail(n), false);
    notifications.setPreference(7, 'service', { email: true });
    assert.strictEqual(notifications.shouldEmail(n), true);

    // Malformed envelopes are refused.
    r = await post({ event_id: 'nope', event_type: 'deals.watch.matched' });
    assert.strictEqual(r.status, 400);

    // ── live.stream.started: every follower of the channel, once ──────────────────────────────
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const CAROL = ids.newId('user'), DAVE = ids.newId('user'), FRANK = ids.newId('user'), GINA = ids.newId('user'), HANK = ids.newId('user'), STRANGER = ids.newId('user');
    db.prepare(`INSERT INTO users (id, username, password_hash, subject_id, avatar_url) VALUES
        (20, 'carol', 'x', ?, 'https://openvibe.media/avatar/carol'), (21, 'dave', 'x', ?, NULL), (22, 'erin', 'x', NULL, NULL),
        (23, 'frank', 'x', ?, NULL), (24, 'gina', 'x', ?, NULL), (25, 'hank', 'x', ?, NULL)`).run(CAROL, DAVE, FRANK, GINA, HANK);
    notifications.setPreference(23, 'stream', { enabled: false });          // Frank muted go-lives
    notifications.setPreference(24, 'stream_live_all', { enabled: true });  // Gina wants every go-live
    // Live's GET /internal/followers, as the Live-side change specifies. Streams: 501 carol, 502 hank.
    let liveMode = 'ok'; const liveCalls = []; const liveAuth = [];
    const FOLLOWERS = {
        501: { channel: CAROL, list: [{ subject: DAVE, network_user_id: 21 }, { subject: null, network_user_id: 22 }, { subject: FRANK, network_user_id: 23 }, { subject: STRANGER, network_user_id: null }, { subject: CAROL, network_user_id: 20 }] },
        502: { channel: HANK, list: [{ subject: DAVE, network_user_id: 21 }] },
    };
    const live = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        liveCalls.push(u.pathname + u.search);
        res.setHeader('content-type', 'application/json');
        if (liveMode === 'down') { res.statusCode = 502; return res.end('{}'); }
        const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey, issuer: 'https://openvibe.network', audience: 'openvibe.live' });
        liveAuth.push(v.ok ? v.claims : null);
        if (!v.ok || !v.claims.cap.includes('live.follower.read')) { res.statusCode = 401; return res.end('{"code":"token.invalid"}'); }
        if (u.pathname !== '/internal/followers') { res.statusCode = 404; return res.end('{}'); }
        const f = FOLLOWERS[u.searchParams.get('stream_id')];
        if (!f) { res.statusCode = 404; return res.end('{"code":"live.unknown_stream"}'); }
        const after = Number(u.searchParams.get('after') || 0);
        const page = f.list.slice(after, after + 2);                       // two per page: exercises the cursor
        const next = after + 2 < f.list.length ? after + 2 : null;
        res.end(JSON.stringify({ stream_id: Number(u.searchParams.get('stream_id')), channel: { subject: f.channel }, followers: page, next }));
    });
    await new Promise(r => live.listen(0, '127.0.0.1', r));
    const discordCalls = [];
    let clock = Date.now();
    consumer = createEventsConsumer({
        db, notifications, secrets: SECRET, now: () => clock,
        liveFollowers: createLiveFollowers({ privateKey, issuer: 'https://openvibe.network', liveUrl: `http://127.0.0.1:${live.address().port}` }),
        discord: () => ({ sendLiveAlert: async (streamer, stream) => { discordCalls.push([streamer, stream]); return { sent: true }; } }),
    });
    const liveEvent = (over = {}, payload = {}) => ({
        event_id: ids.newId('event'), event_type: 'live.stream.started', version: 1, source: 'live',
        actor: { type: 'user', id: CAROL }, subject: { type: 'stream', id: '501', revision: 1 }, visibility: 'public', priority: 'important',
        occurred_at: new Date(clock).toISOString(),
        payload: {
            stream_id: 501, channel: { username: 'carol', display_name: 'Carol <3', url: 'https://openvibe.live/carol', subject: { type: 'user', id: CAROL } },
            title: 'Building a <b>robot</b>', category: null, protocol: 'rtmp', is_nsfw: false, started_at: new Date(clock).toISOString(), ...payload,
        },
        ...over,
    });
    const goLives = (uid) => db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'STREAM_LIVE' ORDER BY rowid").all(uid);

    // One delivery: Dave (by subject), Erin (by network id, no subject yet) and Gina (all go-lives) are
    // notified once each; Frank muted the category, Carol is the streamer, the stranger has no account.
    const s1 = liveEvent();
    r = await post(s1);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.outcome, 'notified');
    assert.deepStrictEqual(r.body.detail, { followers: 5, unresolved: 1, targets: 4, notified: 3 });
    for (const uid of [21, 22, 24]) assert.strictEqual(goLives(uid).length, 1, `user ${uid} is told once`);
    assert.strictEqual(goLives(23).length, 0, 'the stream category is muted: preferences apply');
    assert.strictEqual(goLives(20).length, 0, 'the streamer is not told about themself');
    const n1 = goLives(21)[0];
    assert.strictEqual(n1.title, 'Carol 3 is live!');
    assert.strictEqual(n1.message, 'Building a b robot /b', 'no markup reaches the inbox');
    assert.strictEqual(n1.category, 'stream');
    assert.strictEqual(n1.url, 'https://openvibe.live/@carol', 'an old-style channel link is rewritten to the channel page');
    {
        const { channelUrl, canonicalChannelUrl } = require('../server/notifications/stream-live');
        assert.strictEqual(channelUrl('carol'), 'https://openvibe.live/@carol');
        assert.strictEqual(channelUrl('@carol'), 'https://openvibe.live/@carol');
        assert.strictEqual(canonicalChannelUrl('https://openvibe.live/@carol', 'carol'), 'https://openvibe.live/@carol', 'a channel link is kept');
        assert.strictEqual(canonicalChannelUrl('https://openvibe.live/carol/', 'carol'), 'https://openvibe.live/@carol');
        assert.strictEqual(canonicalChannelUrl('https://openvibe.live/vod/5', 'carol'), 'https://openvibe.live/vod/5', 'other Live pages are kept');
        assert.strictEqual(canonicalChannelUrl(null, 'carol'), 'https://openvibe.live/@carol', 'no link: the channel page');
    }
    assert.strictEqual(n1.sender_id, 20, 'sender is the streamer\'s Network account (dedupe key)');
    assert.strictEqual(n1.sender_avatar, 'https://openvibe.media/avatar/carol');
    assert.strictEqual(JSON.parse(n1.rich_content).context.event_id, s1.event_id);
    assert.deepStrictEqual(liveCalls.map(c => c.replace(/limit=\d+/, 'limit=N')), ['/internal/followers?stream_id=501&limit=N', '/internal/followers?stream_id=501&limit=N&after=2', '/internal/followers?stream_id=501&limit=N&after=4']);
    assert.ok(liveAuth.every(c => c && c.sub === 'svc:network' && c.aud.includes('openvibe.live') && c.cap.includes('live.follower.read')), 'a Network service token for Live');
    await new Promise(r2 => setImmediate(r2));
    assert.strictEqual(discordCalls.length, 1, 'the Discord live alert, after the commit');
    assert.deepStrictEqual(discordCalls[0][1], { id: 501, title: 'Building a b robot /b', protocol: 'rtmp' });

    // The same delivery again: a duplicate. Live is not asked again, nobody is told twice, no second Discord post.
    liveCalls.length = 0;
    r = await post(s1);
    assert.deepStrictEqual([r.status, r.body.duplicate, r.body.outcome], [200, true, null]);
    assert.strictEqual(liveCalls.length, 0);
    for (const uid of [21, 22, 24]) assert.strictEqual(goLives(uid).length, 1);
    assert.strictEqual(discordCalls.length, 1);

    // A new stream row from the same channel within the hour (a reconnect): the announcement window holds.
    r = await post(liveEvent({}, { stream_id: 501 }));
    assert.strictEqual(r.body.outcome, 'skipped:cooldown');
    assert.strictEqual(goLives(21).length, 1);
    // ...and it is the same window Live's direct POST /internal/events/stream-live claims (keyed by the Network id),
    // so during the switch the two paths never both announce.
    assert.strictEqual(streamLive.claimAnnouncement(db, { streamerKey: 20, streamId: 501 }).reason, 'cooldown');

    // v1-only (and any unverifiable) live delivery: refused, not recorded, Live never asked.
    liveCalls.length = 0;
    const v1 = liveEvent({ subject: { type: 'stream', id: '502', revision: 1 }, actor: { type: 'user', id: HANK } }, { stream_id: 502, channel: { username: 'hank', subject: { type: 'user', id: HANK } } });
    r = await post(v1, { strip: ['X-OpenVibe-Signature-V2', 'X-OpenVibe-Timestamp'] });
    assert.deepStrictEqual([r.status, r.body.code], [401, 'network.bad_signature']);
    assert.ok(!db.prepare('SELECT 1 FROM network_event_inbox WHERE event_id = ?').get(v1.event_id));
    assert.strictEqual(liveCalls.length, 0);

    // Live down: 503, nothing recorded, so Events' retry does the work once Live answers.
    liveMode = 'down';
    r = await post(v1);
    assert.deepStrictEqual([r.status, r.body.code], [503, 'network.dependency_unavailable']);
    assert.ok(!db.prepare('SELECT 1 FROM network_event_inbox WHERE event_id = ?').get(v1.event_id));
    assert.strictEqual(goLives(21).length, 1);
    liveMode = 'ok';
    r = await post(v1);
    assert.strictEqual(r.body.outcome, 'notified');
    assert.strictEqual(goLives(21).length, 2, 'Dave follows Hank too');
    assert.strictEqual(goLives(24).length, 2, 'Gina gets every go-live');

    // Refused or ignored without notifying anyone.
    liveCalls.length = 0;
    const count = () => db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'STREAM_LIVE'").get().c;
    const total = count();
    r = await post(liveEvent({ source: 'tips' }));
    assert.strictEqual(r.body.outcome, 'ignored:source', 'only Live speaks for Live channels');
    // The signatures are made at the consumer's clock (it moves forward below).
    clock += 45 * 60 * 1000;
    r = await post(liveEvent({ occurred_at: new Date(clock - 45 * 60 * 1000).toISOString() }, { started_at: new Date(clock - 45 * 60 * 1000).toISOString() }), { now: clock });
    assert.strictEqual(r.body.outcome, 'ignored:stale', 'a late or replayed start announces nothing');
    r = await post(liveEvent({}, { channel: { username: 'carol', subject: { type: 'user', id: '20' } } }), { now: clock });
    assert.strictEqual(r.body.outcome, 'ignored:channel');
    r = await post(liveEvent({}, { channel: { username: 'ghost', subject: { type: 'user', id: STRANGER } } }), { now: clock });
    assert.strictEqual(r.body.outcome, 'ignored:channel', 'a channel with no Network account');
    assert.strictEqual(liveCalls.length, 0, 'none of those asked Live');
    clock += 2 * 60 * 60 * 1000;   // past Carol's cooldown
    r = await post(liveEvent({}, { stream_id: 502 }), { now: clock });
    assert.strictEqual(r.body.outcome, 'ignored:channel-mismatch', 'stream 502 is Hank\'s, not Carol\'s');
    r = await post(liveEvent({}, { stream_id: 999 }), { now: clock });
    assert.strictEqual(r.body.outcome, 'ignored:stream');
    assert.strictEqual(count(), total);
    assert.strictEqual(discordCalls.length, 2);

    live.close();
    srv.close();
    console.log('events consumer: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
