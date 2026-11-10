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
const { EmailService } = require('../server/notifications/email-service');

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
const browserAlert = {
    fingerprint: 'f'.repeat(16), name: 'OpenVibeBrowserCheckFailed', severity: 'critical',
    summary: 'domains: the browser check of release 74bdff4 failed (1 failing check(s)); run: sudo ovhost browser-watch --sites domains --force',
    description: 'The automatic check of openvibe.domains found a problem after release 74bdff4.',
    service: 'domains', started_at: '2026-11-10T09:12:30Z', failing_since: '2026-11-10T09:12:30Z',
    release: '74bdff4c0a1e9d2b7f3c5a8e6b4d2f1a0c9e8d7b',
    release_url: 'https://git.openvibe.codes/OpenVibers/OpenVibe.Domains/commit/74bdff4c0a1e9d2b7f3c5a8e6b4d2f1a0c9e8d7b',
    checked_at: '2026-11-10T09:12:00Z',
    details: [{ route: '/', check: 'axe', rule: 'summary-name', impact: 'serious', targets: ['#dev-fold', '#faq-fold'],
        help: 'Ensures the summary element has a non-empty accessible name',
        help_url: 'https://dequeuniversity.com/rules/axe/4.13/summary-name', page_url: 'https://openvibe.domains/' }],
};

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
        assert.ok(validate('network.operator-alerts-request@1', { source: 'prometheus', alerts: [browserAlert] }).valid, 'the browser-check details are part of the contract now');
        assert.ok(!validate('network.operator-alerts-request@1', { source: 'prometheus', alerts: [{ ...browserAlert, details: [{ route: '/' }] }] }).valid, 'a detail must say which check it is');
        assert.ok(!validate('network.operator-alerts-request@1', { source: 'prometheus', alerts: [{ ...browserAlert, details: [{ check: 'axe', page_url: 'not a url' }] }] }).valid, 'a link is a URI');

        // Opens: both operators (owner by OWNER_USERNAME, case-insensitive; the extra username) are paged.
        r = await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed', { service: 'host', description: 'No successful backup in 26 hours.' }), alert('OpenVibeBrowserCheckFailed', { severity: 'warning' })] }, auth);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.ok(validate('network.operator-alerts-result@1', r.body).valid);
        assert.deepStrictEqual(r.body, { ok: true, firing: 2, opened: 2, reminded: 0, resolved: 0, notified: 4 });
        assert.deepStrictEqual(sent.map((n) => n.user_id).sort(), [1, 1, 2, 2]);
        const backup = sent.find((n) => n.title === 'Backup missed' && n.user_id === 1);
        assert.deepStrictEqual([backup.type, backup.category, backup.priority, backup.url], ['OPERATOR_ALERT', 'admin', 'critical', 'https://openvibe.network/status']);
        assert.strictEqual(backup.message, 'host · OpenVibeBackupMissed summary · No successful backup in 26 hours.');
        assert.strictEqual(backup.rich_content.kind, 'ops_alert');
        assert.strictEqual(backup.rich_content.state, 'firing');
        assert.strictEqual(sent.find((n) => n.title === 'Browser check failed').priority, 'high', 'a warning pages at high');
        assert.deepStrictEqual([backup.silent, sent.find((n) => n.title === 'Browser check failed').silent], [false, true], 'only a critical alert is pushed');
        const warnIds = sent.filter((n) => n.title === 'Browser check failed').map((n, i) => n).length;
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
        assert.ok(revised.every((x) => x.title === 'Resolved: Browser check failed' && x.icon === '✅' && x.is_read === 1), JSON.stringify(revised));
        assert.match(revised[0].message, /\(resolved after \d+ min\)\./);
        const warnNotices = revised.map((x) => x.id).sort();

        // A day later, a critical still firing: one reminder; then quiet again.
        sent.length = 0;
        const later = Date.now() + alerts.REMIND_MS + 1000;
        let out = await alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, { notify: (u, n) => { sent.push({ user_id: u, ...n }); return { id: `r${sent.length}` }; }, now: later });
        assert.deepStrictEqual(out, { ok: true, firing: 1, opened: 0, reminded: 1, resolved: 0, notified: 2 });
        assert.strictEqual(sent[0].title, 'Still failing: Backup missed');
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
        assert.ok(revised.every((x) => x.title === 'Browser check failed' && /Fired again 1 time\(s\) within 12 h/.test(x.message)));
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
        assert.ok(sent.every((n) => n.title === 'Browser check failed'));
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

        // ── A browser-check alert says it in words (network.operator-alerts-request@1 details) ─────────
        process.env.OWNER_USERNAME = 'Boss'; process.env.OPERATOR_ALERT_USERNAMES = '';
        const bc = alerts.browserCheck(browserAlert);
        assert.strictEqual(bc.title, 'openvibe.domains: 1 problem found by the browser check');
        assert.strictEqual(bc.message, 'After release 74bdff4, the automatic check of openvibe.domains found a problem on the page /. Two fold headings have no name a screen reader can say (#dev-fold, #faq-fold).');
        assert.deepStrictEqual(bc.facts.map((f) => f.label), ['Site', 'Page', 'What', 'Where', 'Release', 'Checked', 'Failing since']);
        assert.deepStrictEqual(bc.facts.find((f) => f.label === 'Page'), { label: 'Page', value: '/', href: 'https://openvibe.domains/' });
        assert.deepStrictEqual(bc.facts.find((f) => f.label === 'Release'), { label: 'Release', value: '74bdff4', href: browserAlert.release_url });
        assert.deepStrictEqual(bc.actions.map((a) => a.label), ['Open the page', 'See the release', 'What this rule means']);
        assert.match(bc.next, /runs again after every release and once a day.*closes itself when the check passes/);

        // The notification itself carries the words and the stored facts/actions/next.
        sent.length = 0;
        out = await alerts.receive(db, { source: 'prometheus', alerts: [browserAlert] }, { notify: (u, n) => { sent.push({ user_id: u, ...n }); return { id: 'browser-1' }; } });
        assert.deepStrictEqual([out.opened, out.notified], [1, 1]);
        assert.strictEqual(sent[0].title, bc.title);
        assert.strictEqual(sent[0].message, bc.message);
        assert.deepStrictEqual(sent[0].rich_content.facts, bc.facts);
        assert.deepStrictEqual(sent[0].rich_content.actions, bc.actions);
        assert.strictEqual(sent[0].rich_content.next, bc.next);

        // A reminder says "Still failing" in front, and keeps the details.
        sent.length = 0;
        out = await alerts.receive(db, { source: 'prometheus', alerts: [browserAlert] }, { notify: (u, n) => { sent.push(n); return { id: 'browser-2' }; }, now: Date.now() + alerts.REMIND_MS + 1000 });
        assert.strictEqual(out.reminded, 1);
        assert.strictEqual(sent[0].title, 'Still failing: openvibe.domains: 1 problem found by the browser check');

        // An unknown axe rule falls back to its id and axe's help text.
        const unknown = alerts.browserCheck({ ...browserAlert, details: [{ route: '/x', check: 'axe', rule: 'mystery-rule', help: 'Makes sure the widget has a name', targets: ['#widget'], page_url: 'https://openvibe.domains/x' }] });
        assert.match(unknown.message, /The page breaks the accessibility rule mystery-rule \(Makes sure the widget has a name\) \(#widget\)\./);
        const consoleError = alerts.browserCheck({ ...browserAlert, details: [{ route: '/', check: 'errors', message: 'WebSocket closed', width: 390, page_url: 'https://openvibe.domains/' }, { route: '/', check: 'overflow', width: 390, offenders: ['.wide'], page_url: 'https://openvibe.domains/' }] });
        assert.match(consoleError.message, /found 2 problems on the page \/.*console error: WebSocket closed.*At 390 px, the page scrolls sideways \(\.wide\)/);

        // Links that are not https or not on an allowed host are dropped; text is kept as text.
        const unsafe = alerts.browserCheck({ ...browserAlert,
            release_url: 'http://github.com/OpenVibers/OpenVibe.Domains/commit/74bdff4',
            details: [{ route: '/', check: 'axe', rule: 'summary-name', targets: ['<img onerror=alert(1)>'], help: 'x', help_url: 'javascript:alert(1)', page_url: 'https://evil.example/' }] });
        assert.deepStrictEqual(unsafe.actions, [], 'no http, javascript: or off-network link becomes an action');
        assert.strictEqual(unsafe.facts.find((f) => f.label === 'Page').href, undefined);
        assert.strictEqual(unsafe.facts.find((f) => f.label === 'Site').value, 'domains', 'an off-network page does not rename the site');
        assert.ok(unsafe.message.includes('<img onerror=alert(1)>'), 'the target stays text (the UI escapes it)');

        // A plain Prometheus alert with no details still reads as before.
        sent.length = 0;
        out = await alerts.receive(db, { source: 'prometheus', alerts: [{ fingerprint: '0'.repeat(16), name: 'OpenVibeDiskFull', severity: 'warning', summary: 'The host disk is 95% full', description: 'over 90% for an hour', service: 'host', started_at: '2026-11-10T09:00:00Z' }] }, { notify: (u, n) => { sent.push(n); return { id: 'plain-1' }; } });
        assert.deepStrictEqual([out.opened, out.notified], [1, 1]);
        assert.strictEqual(sent[0].title, 'Disk full');
        assert.strictEqual(sent[0].message, 'host · The host disk is 95% full · over 90% for an hour');
        assert.strictEqual(sent[0].rich_content.facts, undefined);
        assert.strictEqual(sent[0].rich_content.actions, undefined);
        assert.strictEqual(sent[0].rich_content.next, undefined);

        // The email's plain-text part shows the facts, the actions' links and the next step.
        const text = EmailService.prototype._buildEmailText({ username: 'Ada', notification: { title: bc.title, message: bc.message, rich_content: bc } });
        assert.match(text, /Site: openvibe\.domains/);
        assert.match(text, /Open the page: https:\/\/openvibe\.domains\//);
        assert.match(text, /See the release: https:\/\/git\.openvibe\.codes\//);
        assert.match(text, /What this rule means: https:\/\/dequeuniversity\.com\//);
        assert.match(text, /The browser check runs again after every release/);
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('operator alerts: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
