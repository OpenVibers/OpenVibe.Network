'use strict';
// The moderation audit log (ADR-022): staff actions from Chat/Live, Community, Tips, Billing and the ten
// services on common.moderation-action@1 arrive as events, are recorded once (inside the consumer's inbox
// transaction), and staff with staff.moderation.logs can list them; nobody else can.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');
const { NotificationService } = require('../server/notifications/notification-service');
const { createEventsConsumer } = require('../server/notifications/events-consumer');
const { createModerationAudit, rowOf } = require('../server/admin/moderation-audit');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-modaudit-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
const MOD = ids.newId('user'), TARGET = ids.newId('user');
const ev = (type, payload, actor = { type: 'user', id: MOD }) => ({ event_id: ids.newId('event'), event_type: type, version: 1, source: type.split('.')[0], actor, occurred_at: new Date().toISOString(), payload });

(async () => {
    const audit = createModerationAudit(db);
    const consumer = createEventsConsumer({ db, notifications: new NotificationService(db), secrets: 'a'.repeat(40), moderationAudit: audit });

    const chat = ev('chat.moderation.action', { action_id: 5, action_type: 'ban', scope_type: 'channel', scope_id: '327', actor_user_id: 1, actor_subject: MOD, target_user_id: 44, target_subject: TARGET, details: { reason: 'spam' } });
    const community = ev('community.moderation.action', { action: 'paste.deleted', target: { type: 'paste', id: 'k3f9Qa', owner_subject: TARGET }, actor_subject: MOD, reason: 'doxxing', details: {} });
    const tips = ev('tips.interaction.moderated', { interaction_id: 'tint_01JAB3C4D5E6F7G8H9J0K1MNPQ', creator: { type: 'user', id: TARGET }, action: 'hidden', by: 'moderator', moderation_state: 'hidden', cancelled_effects: ['tts'] }, { type: 'service', id: 'tips' });
    const live = ev('live.moderation.action', { action_id: 9, action_type: 'site_ban', scope_type: 'site', scope_id: null, actor_user_id: 1, actor_subject: MOD, target_user_id: 44, target_subject: TARGET, details: { reason: '=HYPERLINK("x")' } });
    const billing = ev('billing.staff.action', { audit_id: 'sa_01JAB3C4D5E6F7G8H9J0K1MNPQ', action: 'cashout.approved', outcome: 'done', target: { type: 'cashout', id: 'co_1' }, reason: null, request_id: null, detail: { amount: 5 } });

    for (const e of [chat, community, tips, billing, live]) assert.strictEqual(consumer.apply(e).outcome, 'recorded', e.event_type);
    assert.strictEqual(consumer.apply(chat).duplicate, true, 'a redelivery records nothing twice');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0, 'audit events notify nobody');

    const all = audit.list({});
    assert.strictEqual(all.items.length, 5);
    const liveRow = all.items.find((r) => r.service === 'live');
    assert.deepStrictEqual([liveRow.action, liveRow.scope, liveRow.target_subject], ['site_ban', 'site', TARGET]);
    assert.strictEqual(audit.list({ action: 'site_ban' }).items.length, 1);
    assert.strictEqual(audit.list({ since: '2000-01-01', until: '2001-01-01' }).items.length, 0);
    assert.strictEqual(audit.list({ since: '2000-01-01' }).items.length, 5);
    const csv = require('../server/admin/moderation-audit').toCsv(all.items);
    assert.ok(csv.startsWith('id,occurred_at,service,action,'));
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'a formula-looking cell is text');
    assert.strictEqual(csv.trim().split('\r\n').length, 6);
    const byService = Object.fromEntries(all.items.map((r) => [r.service, r]));
    assert.deepStrictEqual([byService.chat.action, byService.chat.scope, byService.chat.target_subject, byService.chat.reason], ['ban', 'channel:327', TARGET, 'spam']);
    assert.deepStrictEqual([byService.community.action, byService.community.target_type, byService.community.target_id, byService.community.reason], ['paste.deleted', 'paste', 'k3f9Qa', 'doxxing']);
    assert.strictEqual(byService.tips.action, 'interaction.hidden');
    assert.strictEqual(byService.billing.actor_subject, MOD);
    assert.strictEqual(audit.list({ service: 'community' }).items.length, 1);
    assert.strictEqual(audit.list({ actor: MOD }).items.length, 4, 'tips carries no moderator identity');
    assert.strictEqual(audit.list({ target: TARGET }).items.length, 4);
    const page = audit.list({ limit: 2 });
    assert.strictEqual(page.items.length, 2);
    assert.strictEqual(audit.list({ limit: 2, before: page.next }).items.length, 2, 'paged by id');
    assert.strictEqual(rowOf(ev('chat.message.deleted', {})), null);

    // The ten services on common.moderation-action@1 (Contracts 0.53.0): subscribed, one row each, the service from the prefix.
    const contracts = require('openvibe-contracts');
    const { TOPICS } = require('../server/notifications/events-consumer');
    const COMMON = ['tools', 'games', 'wiki', 'blog', 'news', 'reviews', 'deals', 'coupons', 'trade', 'codes'];
    for (const svc of COMMON) {
        const type = `${svc}.moderation.action`;
        assert.ok(TOPICS.includes(type), `${type} is one of the consumer's subscriptions`);
        const payload = { action: 'item.hidden', target: { type: `${svc}_item`, id: `${svc}-1`, owner_subject: TARGET }, actor_subject: MOD, reason: `${svc} reason`, details: { previous: 'visible' } };
        assert.ok(contracts.validate(`${type}@1`, payload).valid, `${type}: a valid payload`);
        assert.strictEqual(consumer.apply(ev(type, payload)).outcome, 'recorded', type);
    }
    for (const svc of COMMON) {
        const rows = audit.list({ service: svc }).items;
        assert.strictEqual(rows.length, 1, svc);
        const r = rows[0];
        assert.deepStrictEqual([r.action, r.actor_subject, r.target_type, r.target_id, r.target_subject, r.scope, r.reason, r.details],
            ['item.hidden', MOD, `${svc}_item`, `${svc}-1`, TARGET, null, `${svc} reason`, { previous: 'visible' }], svc);
    }
    assert.strictEqual(audit.list({ action: 'item.hidden' }).items.length, COMMON.length);
    // A service acting without a person names no actor; an unknown owner is no target subject.
    const bySvc = rowOf(ev('coupons.moderation.action', { action: 'merchant.disabled', target: { type: 'merchant', id: 'mer_1', owner_subject: null }, actor_subject: null, details: {} }, { type: 'service', id: 'coupons' }));
    assert.deepStrictEqual([bySvc.service, bySvc.action, bySvc.actor_subject, bySvc.target_subject, bySvc.reason], ['coupons', 'merchant.disabled', null, null, null]);

    // Only staff with staff.moderation.logs read it.
    const app = express();
    app.use((req, _res, next) => { req.user = req.headers['x-role'] ? { id: 1, role: req.headers['x-role'] } : null; next(); });
    app.use('/api/v1/staff/moderation-audit', audit.router());
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}/api/v1/staff/moderation-audit`;
    try {
        assert.strictEqual((await fetch(base, { headers: { 'x-role': 'user' } })).status, 403);
        assert.strictEqual((await fetch(base, { headers: { 'x-role': 'streamer' } })).status, 403);
        const r = await fetch(`${base}?service=chat`, { headers: { 'x-role': 'global_mod' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await r.json()).items[0].action, 'ban');
        assert.strictEqual((await fetch(base, { headers: { 'x-role': 'admin' } })).status, 200);
    } finally { srv.close(); }
    console.log('moderation audit: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
