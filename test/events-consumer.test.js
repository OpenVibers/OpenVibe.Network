'use strict';
// Events → notifications (server/notifications/events-consumer.js): POST /internal/events turns
// deals.watch.matched and trade.alert.triggered into inbox notifications for the subscribed person,
// exactly once, v2 signatures only, respecting their preferences.
//   node test/events-consumer.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { initDb } = require('../server/db/database');
const { NotificationService } = require('../server/notifications/notification-service');
const { createEventsConsumer, TOPICS } = require('../server/notifications/events-consumer');

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
    assert.deepStrictEqual(TOPICS, ['deals.watch.matched', 'trade.alert.triggered']);

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

    srv.close();
    console.log('events consumer: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
