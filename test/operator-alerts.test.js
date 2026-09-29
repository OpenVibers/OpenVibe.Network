'use strict';
// Operator alerts (roadmap WS-H task 11; Contracts network.operator.alert): POST /internal/operator/alerts
// takes Host's token only, validates the request contract, and pages the owner when an alert opens, once a
// day while it stays open, and when it resolves.
//   node test/operator-alerts.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const alerts = require('../server/operator/alerts');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opalerts-'));
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
process.env.OWNER_USERNAME = 'Boss';
process.env.OPERATOR_ALERT_USERNAMES = 'deputy, nobody-here';
await db.prepare("UPDATE oauth_clients SET client_secret = 'host-secret' WHERE client_id = 'host'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'boss', 'x'), (2, 'deputy', 'x'), (3, 'someone', 'x')").run();

const sent = [];
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
const revised = [];
// Async, like NotificationService.create/revise on PostgreSQL: the notification ids kept for the revisions come from the awaited result.
app.locals.notificationService = { create: async (n) => { sent.push(n); return { id: `n${sent.length}` }; }, revise: async (id, uid, f) => { revised.push({ id, uid, ...f }); return true; } };
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal', require('../server/internal/routes'));
const server = http.createServer(app);

const alert = (name, extra = {}) => ({ fingerprint: crypto.createHash('sha256').update(name).digest('hex').slice(0, 16), name, severity: 'critical', summary: `${name} summary`, started_at: '2026-09-26T05:00:00Z', ...extra });

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = async (id, secret) => {
        const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network' }) });
        return (await r.json()).access_token;
    };
    const post = (body, headers) => fetch(`${base}/internal/operator/alerts`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    try {
        const host = await token('host', 'host-secret');
        assert.ok(host, 'Host gets a token for openvibe.network');
        const auth = { authorization: `Bearer ${host}` };

        // Who may call it: Host's token; not the retired key, not another service, not nobody.
        const nobody = await post({ source: 'prometheus', alerts: [] });
        assert.strictEqual(nobody.status, 401); assert.strictEqual(nobody.body.code, 'token.missing');
        const withKey = await post({ source: 'prometheus', alerts: [] }, { 'x-internal-key': 'legacy-key' });
        assert.strictEqual(withKey.status, 401, 'the shared key is refused (retired in plan T2)');
        assert.strictEqual(withKey.body.code, 'token.missing');
        const live = await token('live', 'live-secret');
        assert.strictEqual((await post({ source: 'prometheus', alerts: [] }, { authorization: `Bearer ${live}` })).status, 403, 'Live lacks network.operator.alert');

        // The request contract.
        let r = await post({ source: 'prometheus', alerts: [alert('X', { severity: 'page' })] }, auth);
        assert.strictEqual(r.status, 400);
        r = await post({ source: 'grafana', alerts: [] }, auth);
        assert.strictEqual(r.status, 400);

        // Opens: both operators (owner by OWNER_USERNAME, case-insensitive; the extra username) are paged.
        r = await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed', { service: 'host', description: 'No successful backup in 26 hours.' }), alert('OpenVibeBrowserCheckFailed', { severity: 'warning' })] }, auth);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.ok(validate('network.operator-alerts-result@1', r.body).valid);
        assert.deepStrictEqual(r.body, { ok: true, firing: 2, opened: 2, reminded: 0, resolved: 0, notified: 4 });
        assert.deepStrictEqual(sent.map((n) => n.user_id).sort(), [1, 1, 2, 2]);
        const backup = sent.find((n) => n.title === 'Alert: OpenVibeBackupMissed' && n.user_id === 1);
        assert.deepStrictEqual([backup.type, backup.category, backup.priority, backup.url], ['OPERATOR_ALERT', 'admin', 'critical', 'https://openvibe.network/status']);
        assert.match(backup.message, /No successful backup in 26 hours\. Service: host\. Firing since 2026-09-26T05:00:00Z\./);
        assert.strictEqual(sent.find((n) => n.title === 'Alert: OpenVibeBrowserCheckFailed').priority, 'high', 'a warning pages at high');
        assert.deepStrictEqual([backup.silent, sent.find((n) => n.title === 'Alert: OpenVibeBrowserCheckFailed').silent], [false, true], 'only a critical alert is pushed');
        const warnIds = sent.filter((n) => n.title === 'Alert: OpenVibeBrowserCheckFailed').map((n, i) => n).length;
        assert.strictEqual(warnIds, 2);

        // The same set again: nothing new.
        sent.length = 0;
        r = await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed'), alert('OpenVibeBrowserCheckFailed', { severity: 'warning' })] }, auth);
        assert.deepStrictEqual(r.body, { ok: true, firing: 2, opened: 0, reminded: 0, resolved: 0, notified: 0 });
        assert.strictEqual(sent.length, 0);

        // One drops out: its notifications are revised to Resolved and marked read; nothing new is created.
        r = await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, auth);
        assert.deepStrictEqual(r.body, { ok: true, firing: 1, opened: 0, reminded: 0, resolved: 1, notified: 0 });
        assert.strictEqual(sent.length, 0, 'no Resolved entry piles up');
        assert.strictEqual(revised.length, 2, 'one revision per operator');
        assert.ok(revised.every((x) => x.title === 'Resolved: OpenVibeBrowserCheckFailed' && x.icon === '✅' && x.is_read === 1), JSON.stringify(revised));
        assert.match(revised[0].message, /\(resolved after \d+ min\)\./);
        const warnNotices = revised.map((x) => x.id).sort();

        // A day later, a critical still firing: one reminder; then quiet again.
        sent.length = 0;
        const later = Date.now() + alerts.REMIND_MS + 1000;
        let out = await alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, { notify: (u, n) => { sent.push({ user_id: u, ...n }); return { id: `r${sent.length}` }; }, now: later });
        assert.deepStrictEqual(out, { ok: true, firing: 1, opened: 0, reminded: 1, resolved: 0, notified: 2 });
        assert.strictEqual(sent[0].title, 'Still firing: OpenVibeBackupMissed');
        out = await alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, { notify: () => true, now: later + 60000 });
        assert.strictEqual(out.reminded, 0);

        // A warning is never reminded.
        out = await alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed'), alert('Warned', { severity: 'warning' })] }, { notify: () => ({ id: 'w' }), now: later + 120000 });
        out = await alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed'), alert('Warned', { severity: 'warning' })] }, { notify: () => ({ id: 'w' }), now: later + 2 * alerts.REMIND_MS });
        assert.strictEqual(out.reminded, 1, 'only the critical one');
        await alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, { notify: () => null, now: later + 2 * alerts.REMIND_MS + 1 });

        // Fires again within 12 h of resolving: the same notifications are revised; nothing is created or pushed.
        sent.length = 0; revised.length = 0;
        r = await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed'), alert('OpenVibeBrowserCheckFailed', { severity: 'warning' })] }, auth);
        assert.deepStrictEqual([r.body.opened, r.body.notified], [1, 0]);
        assert.strictEqual(sent.length, 0);
        assert.deepStrictEqual(revised.map((x) => x.id).sort(), warnNotices, 'the episode keeps its notifications');
        assert.ok(revised.every((x) => x.title === 'Alert: OpenVibeBrowserCheckFailed' && /Fired again 1 time\(s\) within 12 h/.test(x.message)));
        revised.length = 0;
        await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, auth);
        assert.match(revised[0].message, /it fired 2 times/);

        // Info alerts are listed, never notified.
        sent.length = 0;
        r = await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed'), alert('JustInfo', { severity: 'info' })] }, auth);
        assert.deepStrictEqual([r.body.opened, r.body.notified, sent.length], [1, 0, 0]);
        assert.ok((await alerts.list(db)).some((x) => x.name === 'JustInfo' && x.state === 'firing'));

        // After 12 h resolved, firing again is a new episode with new notifications.
        await alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, { notify: () => null });
        const much = Date.now() + alerts.FLAP_MS + 60000;
        sent.length = 0;
        out = await alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed'), alert('OpenVibeBrowserCheckFailed', { severity: 'warning' })] }, { notify: (u, n) => { sent.push(n); return { id: `x${sent.length}` }; }, now: much });
        assert.deepStrictEqual([out.opened, out.notified], [1, 2]);
        assert.ok(sent.every((n) => n.title === 'Alert: OpenVibeBrowserCheckFailed'));
        await alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, { notify: () => null, now: much + 1000 });

        // An empty set resolves everything from that source; the list keeps them.
        r = await post({ source: 'prometheus', alerts: [] }, auth);
        assert.deepStrictEqual([r.body.firing, r.body.resolved], [0, 1]);
        const rows = await alerts.list(db);
        assert.ok(rows.every((x) => x.state === 'resolved'), JSON.stringify(rows.map((x) => [x.name, x.state])));
        assert.ok(rows.every((x) => !('description' in x) || x.description === undefined));

        // No operator account: nothing is sent, nothing breaks.
        process.env.OWNER_USERNAME = 'ghost'; process.env.OPERATOR_ALERT_USERNAMES = '';
        r = await post({ source: 'prometheus', alerts: [alert('Lonely')] }, auth);
        assert.deepStrictEqual([r.status, r.body.opened, r.body.notified], [200, 1, 0]);
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('operator alerts: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
