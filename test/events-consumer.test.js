'use strict';
// Events → notifications (server/notifications/events-consumer.js): POST /internal/events turns
// deals.watch.matched and trade.alert.triggered into inbox notifications for the subscribed person,
// and live.stream.started into one go-live notification per follower (Network's own user_follows; Live is
// never asked), exactly once, v2 signatures only, respecting their preferences.
//   node test/events-consumer.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { getDb } = require('../server/db/database');
const { NotificationService } = require('../server/notifications/notification-service');
const { createEventsConsumer, TOPICS } = require('../server/notifications/events-consumer');
const streamLive = require('../server/notifications/stream-live');
const { topicsFrom } = require('../scripts/subscribe-events');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-events-consumer-'));
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;

const ALICE = ids.newId('user'), BOB = ids.newId('user'), NOBODY = ids.newId('user');
await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, email, email_verified) VALUES (7, 'alice', 'x', ?, 'alice@example.test', 1), (8, 'bob', 'x', ?, NULL, 0)").run(ALICE, BOB);
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
const couponsEvent = (over = {}) => ({
    event_id: ids.newId('event'), event_type: 'coupons.watch.matched', version: 1, source: 'coupons',
    actor: { type: 'service', id: 'coupons' }, subject: { type: 'coupon', id: 'cpn_01JAB2C3D4E5F6G7H8J9K0MNPT' }, visibility: 'internal',
    occurred_at: new Date().toISOString(),
    payload: {
        recipient: ALICE, merchant_id: 'mer_01JAB2C3D4E5F6G7H8J9K0MNPS', merchant_name: 'Trail <i>Supply</i>',
        merchant_url: 'https://openvibe.coupons/m/trail-supply', coupon_id: 'cpn_01JAB2C3D4E5F6G7H8J9K0MNPT',
        coupon_url: 'https://openvibe.coupons/c/cpn_01JAB2C3D4E5F6G7H8J9K0MNPT', title: '20% off tents', expires_at: '2026-11-30',
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
const rows = async (userId) => await db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at, seq').all(userId);

(async () => {
    // The subscriptions this consumer is meant for, and nothing else.
    assert.deepStrictEqual(TOPICS, ['deals.watch.matched', 'coupons.watch.matched', 'trade.alert.triggered', 'live.stream.started', 'live.stream.ended', 'today.event.scheduled', 'today.event.cancelled', 'chat.moderation.action', 'live.moderation.action', 'community.moderation.action', 'space.moderation.action', 'tips.interaction.moderated', 'billing.staff.action',
        ...['media', 'tools', 'games', 'wiki', 'blog', 'news', 'reviews', 'deals', 'coupons', 'trade', 'services'].map((svc) => `${svc}.moderation.action`),
        'tools.usage.recorded', 'events.usage.recorded', 'media.usage.recorded']);
    assert.deepStrictEqual(topicsFrom([]), TOPICS, 'scripts/subscribe-events.js subscribes every topic');
    assert.deepStrictEqual(topicsFrom(['--topic', 'live.stream.started']), ['live.stream.started']);
    assert.throws(() => topicsFrom(['--topic', 'live.*']));

    let consumer = await createEventsConsumer({ db, notifications, secrets: '' });
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
    assert.strictEqual((await rows(7)).length, 0);

    consumer = await createEventsConsumer({ db, notifications, secrets: `${SECRET},${NEXT}` });
    assert.strictEqual(consumer.enabled, true);

    // A signed v2 Deals watch match becomes one notification for the watcher.
    const e1 = dealsEvent();
    r = await post(e1);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { event_id: e1.event_id, duplicate: false, outcome: 'notified' });
    let mine = await rows(7);
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0].type, 'DEAL_WATCH_MATCH');
    assert.strictEqual(mine[0].category, 'service');
    assert.strictEqual(mine[0].service, 'deals');
    assert.strictEqual(mine[0].title, 'Deal watch matched');
    assert.strictEqual(mine[0].message, 'Cheap b headphones /b at 199.00 USD (below your 250.00 USD)', 'no markup reaches the inbox');
    assert.strictEqual(mine[0].url, 'https://openvibe.deals/d/dof_1-cheap-headphones', 'openvibe.deals is live (contracts 0.118.0): the notification opens the deal');
    assert.strictEqual(JSON.parse(mine[0].rich_content).context.planned_url, 'https://openvibe.deals/d/dof_1-cheap-headphones');

    // The same event again (Events retries, or replays): a duplicate, nothing new.
    r = await post(e1);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.duplicate, true);
    assert.strictEqual(r.body.outcome, null);
    assert.strictEqual((await rows(7)).length, 1);

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
        assert.ok(!await db.prepare('SELECT 1 FROM network_event_inbox WHERE event_id = ?').get(e.event_id), `${label}: not even recorded`);
    }
    assert.strictEqual((await rows(7)).length, 1);

    // The rotated-in secret verifies too.
    r = await post(dealsEvent({ payload: { ...dealsEvent().payload, kind: 'keyword', query: 'headphones', offer_id: 'dof_2' } }), { secret: NEXT });
    assert.strictEqual(r.body.outcome, 'notified');
    assert.match((await rows(7))[1].message, /\(matches "headphones"\)$/);

    // Unknown types are acknowledged and ignored (and recorded, so a redelivery is a duplicate).
    const other = dealsEvent({ event_type: 'deals.offer.created' });
    r = await post(other);
    assert.deepStrictEqual([r.status, r.body.outcome], [200, 'ignored:type']);
    r = await post(other);
    assert.strictEqual(r.body.duplicate, true);
    r = await post(dealsEvent({ event_type: 'constructor' }));
    assert.strictEqual(r.body.outcome, 'ignored:type', 'no prototype lookups');
    assert.strictEqual((await rows(7)).length, 2);

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
    let bobs = await rows(8);
    assert.strictEqual(bobs.length, 1);
    assert.strictEqual(bobs[0].type, 'TRADE_ALERT');
    assert.strictEqual(bobs[0].title, 'Trade alert: AAPL');
    assert.strictEqual(bobs[0].priority, 'high');
    assert.strictEqual(bobs[0].message, 'Apple Inc. — close is 201.50 USD (above 200). Information only — not investment advice; no trading here.');
    assert.strictEqual(bobs[0].url, 'https://openvibe.trade/i/AAPL', 'Trade serves openvibe.trade since contracts 0.125.0, so the alert links the instrument');
    r = await post(tradeEvent({ payload: { ...tradeEvent().payload, trigger: { kind: 'document', id: 'doc_1', form_type: '8-K', title: 'Current report' } } }));
    assert.strictEqual(r.body.outcome, 'notified');
    assert.match((await rows(8))[1].message, /New 8-K: Current report\./);
    r = await post(tradeEvent({ subject: { type: 'watch', id: 'x' } }));
    assert.strictEqual(r.body.outcome, 'ignored:payload');

    // A link to a site whose domain serves the service is kept; a foreign host never is.
    r = await post(tradeEvent({ payload: { ...tradeEvent().payload, instrument: { symbol: 'X', url: 'https://openvibe.live/x' } } }));
    assert.strictEqual((await rows(8)).pop().url, 'https://openvibe.live/x');
    r = await post(tradeEvent({ payload: { ...tradeEvent().payload, instrument: { symbol: 'Y', url: 'https://evil.example/y' } } }));
    const last = (await rows(8)).pop();
    assert.strictEqual(last.url, null);
    assert.strictEqual(JSON.parse(last.rich_content).context.planned_url, null);

    // Preferences: with the 'service' category turned off, nothing is created (and it stays handled).
    const before = (await rows(8)).length;
    await notifications.setPreference(8, 'service', { enabled: false });
    const muted = tradeEvent();
    r = await post(muted);
    assert.strictEqual(r.body.outcome, 'suppressed:preference');
    assert.strictEqual((await rows(8)).length, before);
    assert.strictEqual((await post(muted)).body.duplicate, true);
    // Email follows the same per-category choice: none by default, yes once opted in (verified address).
    const n = { ...(await rows(7))[0], email_verified: 1, email_bounced_at: null };
    assert.strictEqual(await notifications.shouldEmail(n), false);
    await notifications.setPreference(7, 'service', { email: true });
    assert.strictEqual(await notifications.shouldEmail(n), true);

    // Malformed envelopes are refused.
    r = await post({ event_id: 'nope', event_type: 'deals.watch.matched' });
    assert.strictEqual(r.status, 400);

    // ── live.stream.started: every follower of the channel, once ──────────────────────────────
    const CAROL = ids.newId('user'), DAVE = ids.newId('user'), ERIN = ids.newId('user'), FRANK = ids.newId('user'), GINA = ids.newId('user'), HANK = ids.newId('user'), STRANGER = ids.newId('user');
    await db.prepare(`INSERT INTO users (id, username, password_hash, subject_id, avatar_url) VALUES
        (20, 'carol', 'x', ?, 'https://openvibe.media/avatar/carol'), (21, 'dave', 'x', ?, NULL), (22, 'erin', 'x', ?, NULL),
        (23, 'frank', 'x', ?, NULL), (24, 'gina', 'x', ?, NULL), (25, 'hank', 'x', ?, NULL)`).run(CAROL, DAVE, ERIN, FRANK, GINA, HANK);
    await notifications.setPreference(23, 'stream', { enabled: false });          // Frank muted go-lives
    await notifications.setPreference(24, 'stream_live_all', { enabled: true });  // Gina wants every go-live
    // Network's follow graph: Dave, Erin, Frank and a subject with no account follow Carol; Hank unfollowed her;
    // Dave follows Hank.
    const follow = (follower, target, active = 1) => db.prepare("INSERT INTO user_follows (follower_subject, target_type, target_id, active) VALUES (?, 'channel', ?, ?)").run(follower, target, active);
    for (const f of [DAVE, ERIN, FRANK, STRANGER]) await follow(f, CAROL);
    await follow(HANK, CAROL, 0);
    await follow(DAVE, HANK);
    const discordCalls = [];
    let clock = Date.now();
    consumer = await createEventsConsumer({
        db, notifications, secrets: SECRET, now: () => clock,
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
    const goLives = async (uid) => await db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'STREAM_LIVE' ORDER BY seq").all(uid);


    // One delivery: Dave, Erin and Gina (all go-lives) are notified once each; Frank muted the category, Carol
    // is the streamer, the stranger has no account, Hank unfollowed.
    const s1 = liveEvent();
    r = await post(s1);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.outcome, 'notified');
    assert.deepStrictEqual(r.body.detail, { followers: 4, unresolved: 1, targets: 4, notified: 3 });
    for (const uid of [21, 22, 24]) assert.strictEqual((await goLives(uid)).length, 1, `user ${uid} is told once`);
    assert.strictEqual((await goLives(23)).length, 0, 'the stream category is muted: preferences apply');
    assert.strictEqual((await goLives(20)).length, 0, 'the streamer is not told about themself');
    assert.strictEqual((await goLives(25)).length, 0, 'an unfollow is not a follower');
    const n1 = (await goLives(21))[0];
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
    await new Promise(r2 => setImmediate(r2));
    assert.strictEqual(discordCalls.length, 1, 'the Discord live alert, after the commit');
    assert.deepStrictEqual(discordCalls[0][1], { id: 501, title: 'Building a b robot /b', protocol: 'rtmp' });

    // The same delivery again: a duplicate. Nobody is told twice, no second Discord post.
    r = await post(s1);
    assert.deepStrictEqual([r.status, r.body.duplicate, r.body.outcome], [200, true, null]);
    for (const uid of [21, 22, 24]) assert.strictEqual((await goLives(uid)).length, 1);
    assert.strictEqual(discordCalls.length, 1);

    // A new stream row from the same channel within the hour (a reconnect): the announcement window holds.
    r = await post(liveEvent({}, { stream_id: 501 }));
    assert.strictEqual(r.body.outcome, 'skipped:cooldown');
    assert.strictEqual((await goLives(21)).length, 1);
    // ...and the window is the per-streamer claim itself (keyed by the Network id).
    assert.strictEqual((await streamLive.claimAnnouncement(db, { streamerKey: 20, streamId: 501 })).reason, 'cooldown');

    // v1-only (and any unverifiable) live delivery: refused, not recorded.
    const v1 = liveEvent({ subject: { type: 'stream', id: '502', revision: 1 }, actor: { type: 'user', id: HANK } }, { stream_id: 502, channel: { username: 'hank', subject: { type: 'user', id: HANK } } });
    r = await post(v1, { strip: ['X-OpenVibe-Signature-V2', 'X-OpenVibe-Timestamp'] });
    assert.deepStrictEqual([r.status, r.body.code], [401, 'network.bad_signature']);
    assert.ok(!await db.prepare('SELECT 1 FROM network_event_inbox WHERE event_id = ?').get(v1.event_id));
    assert.strictEqual((await goLives(21)).length, 1);
    r = await post(v1);
    assert.strictEqual(r.body.outcome, 'notified');
    assert.strictEqual((await goLives(21)).length, 2, 'Dave follows Hank too');
    assert.strictEqual((await goLives(24)).length, 2, 'Gina gets every go-live');

    // Refused or ignored without notifying anyone.
    const count = async () => (await db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'STREAM_LIVE'").get()).c;
    const total = await count();
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
    assert.strictEqual(await count(), total);
    assert.strictEqual(discordCalls.length, 2);

    // A Coupons watch match becomes one notification for the watcher, linking the coupon page; a wrong source is ignored.
    {
        const before = (await rows(7)).length;
        const c1 = couponsEvent();
        const cr = await post(c1, { now: clock });
        assert.deepStrictEqual(cr.body, { event_id: c1.event_id, duplicate: false, outcome: 'notified' });
        const theirs = (await rows(7)).slice(before);
        assert.strictEqual(theirs.length, 1);
        assert.strictEqual(theirs[0].type, 'COUPON_WATCH_MATCH');
        assert.strictEqual(theirs[0].service, 'coupons');
        assert.match(theirs[0].title, /^New code for Trail/);
        assert.ok(!/[<>]/.test(theirs[0].title), 'markup is stripped');
        assert.strictEqual(theirs[0].message, '20% off tents · until 2026-11-30');
        assert.strictEqual((await post(c1, { now: clock })).body.duplicate, true, 'a redelivery notifies nobody again');
        const spoof = await post(couponsEvent({ source: 'deals' }), { now: clock });
        assert.strictEqual(spoof.body.outcome, 'ignored:source');
        assert.strictEqual((await rows(7)).length, before + 1);
    }

    // ── today.event.scheduled: the streamer's followers, once, three schedules a day; cancelled clears them ──
    {
        let n = 0;
        const tev = () => `tev_01JTODAYTEST${String(++n).padStart(8, '0')}`;
        const todayEvent = (type, payload = {}, over = {}) => ({
            event_id: ids.newId('event'), event_type: type, version: 1, source: 'today',
            actor: { type: 'user', id: CAROL }, subject: { type: 'user', id: CAROL }, visibility: 'public', priority: 'normal',
            occurred_at: new Date(clock).toISOString(),
            payload: { event_id: tev(), kind: 'stream', channel: 'carol', title: 'Robot <b>build</b> part 2', starts_at: new Date(clock + 2 * 86400000).toISOString(),
                ends_at: null, tz: 'America/Los_Angeles', status: 'scheduled', visibility: 'public', url: null, seq: 0, ...payload },
            ...over,
        });
        const sched = async (uid) => await db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'STREAM_SCHEDULED' AND is_dismissed = 0 ORDER BY seq").all(uid);
        const e1 = todayEvent('today.event.scheduled');
        r = await post(e1, { now: clock });
        assert.strictEqual(r.body.outcome, 'notified', JSON.stringify(r.body));
        assert.deepStrictEqual(r.body.detail, { followers: 4, unresolved: 1, targets: 3, notified: 2 }, 'Dave and Erin; Frank muted streams; the stranger has no account');
        const [d1] = await sched(21);
        assert.strictEqual(d1.title, 'carol scheduled a stream');
        assert.match(d1.message, /^Robot .*build.* part 2 · \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M P[DS]T$/, 'the time in the stream\'s own zone');
        assert.ok(!/[<>]/.test(d1.message), 'no markup');
        assert.deepStrictEqual([d1.priority, d1.category, d1.service, d1.sender_id], ['low', 'stream', 'today', 20], 'the bell, no toast');
        assert.ok(d1.url === null || d1.url === `https://openvibe.today/e/${e1.payload.event_id}`, 'a link only once openvibe.today is open');
        assert.strictEqual(JSON.parse(d1.rich_content).context.today_event_id, e1.payload.event_id);
        assert.strictEqual((await sched(23)).length, 0, 'preferences apply');
        assert.strictEqual((await post(e1, { now: clock })).body.duplicate, true, 'a redelivery tells nobody again');

        // Ignored: another source, a plain event, a stream too soon or too far, a cancelled status, a private one.
        assert.strictEqual((await post(todayEvent('today.event.scheduled', {}, { source: 'live' }), { now: clock })).body.outcome, 'ignored:source');
        assert.strictEqual((await post(todayEvent('today.event.scheduled', { kind: 'event' }), { now: clock })).body.outcome, 'ignored:kind');
        assert.strictEqual((await post(todayEvent('today.event.scheduled', { starts_at: new Date(clock + 5 * 60000).toISOString() }), { now: clock })).body.outcome, 'ignored:too_soon');
        assert.strictEqual((await post(todayEvent('today.event.scheduled', { starts_at: new Date(clock + 30 * 86400000).toISOString() }), { now: clock })).body.outcome, 'ignored:too_far');
        assert.strictEqual((await post(todayEvent('today.event.scheduled', { visibility: 'private' }), { now: clock })).body.outcome, 'ignored:visibility');
        assert.strictEqual((await post(todayEvent('today.event.scheduled', { event_id: 'evt_x' }), { now: clock })).body.outcome, 'ignored:payload');

        // Three announced schedules a day per streamer; the fourth tells nobody.
        assert.strictEqual((await post(todayEvent('today.event.scheduled'), { now: clock })).body.outcome, 'notified');
        assert.strictEqual((await post(todayEvent('today.event.scheduled'), { now: clock })).body.outcome, 'notified');
        const fourth = await post(todayEvent('today.event.scheduled'), { now: clock });
        assert.deepStrictEqual([fourth.body.outcome, fourth.body.detail], ['skipped:daily_limit', { announced_today: 3 }]);
        assert.strictEqual((await sched(21)).length, 3);

        // Cancelled: the stream's notices leave every bell; the others stay.
        const c = await post(todayEvent('today.event.cancelled', { event_id: e1.payload.event_id, status: 'cancelled' }), { now: clock });
        assert.deepStrictEqual([c.body.outcome, c.body.detail], ['cleared', { notices: 2 }]);
        assert.ok(!(await sched(21)).some((x) => JSON.parse(x.rich_content).context.today_event_id === e1.payload.event_id));
        assert.strictEqual((await sched(21)).length, 2);
        assert.strictEqual((await post(todayEvent('today.event.cancelled', { event_id: e1.payload.event_id }, { source: 'tips' }), { now: clock })).body.outcome, 'ignored:source');
    }

    srv.close();
    console.log('events consumer: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
