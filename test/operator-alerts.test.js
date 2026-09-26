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
const { initDb } = require('../server/db/database');
const alerts = require('../server/operator/alerts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-opalerts-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
process.env.OWNER_USERNAME = 'Boss';
process.env.OPERATOR_ALERT_USERNAMES = 'deputy, nobody-here';
db.prepare("UPDATE oauth_clients SET client_secret = 'host-secret' WHERE client_id = 'host'").run();
db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'boss', 'x'), (2, 'deputy', 'x'), (3, 'someone', 'x')").run();

const sent = [];
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.locals.notificationService = { create: (n) => { sent.push(n); return { id: `n${sent.length}` }; } };
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

        // Who may call it: Host's token; not the shared key, not another service, not nobody.
        assert.strictEqual((await post({ source: 'prometheus', alerts: [] })).status, 403);
        assert.ok([401, 403].includes((await post({ source: 'prometheus', alerts: [] }, { 'x-internal-key': 'legacy-key' })).status), 'the shared key is refused (legacy: false)');
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

        // The same set again: nothing new.
        sent.length = 0;
        r = await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed'), alert('OpenVibeBrowserCheckFailed', { severity: 'warning' })] }, auth);
        assert.deepStrictEqual(r.body, { ok: true, firing: 2, opened: 0, reminded: 0, resolved: 0, notified: 0 });
        assert.strictEqual(sent.length, 0);

        // One drops out: resolved notice.
        r = await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, auth);
        assert.deepStrictEqual(r.body, { ok: true, firing: 1, opened: 0, reminded: 0, resolved: 1, notified: 2 });
        assert.deepStrictEqual([...new Set(sent.map((n) => `${n.title}|${n.priority}`))], ['Resolved: OpenVibeBrowserCheckFailed|normal']);

        // A day later, still firing: one reminder; then quiet again.
        sent.length = 0;
        const later = Date.now() + alerts.REMIND_MS + 1000;
        let out = alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, { notify: (u, n) => { sent.push({ user_id: u, ...n }); return true; }, now: later });
        assert.deepStrictEqual(out, { ok: true, firing: 1, opened: 0, reminded: 1, resolved: 0, notified: 2 });
        assert.strictEqual(sent[0].title, 'Still firing: OpenVibeBackupMissed');
        out = alerts.receive(db, { source: 'prometheus', alerts: [alert('OpenVibeBackupMissed')] }, { notify: () => true, now: later + 60000 });
        assert.strictEqual(out.reminded, 0);

        // An alert that resolved and fires again opens again.
        sent.length = 0;
        r = await post({ source: 'prometheus', alerts: [alert('OpenVibeBackupMissed'), alert('OpenVibeBrowserCheckFailed', { severity: 'warning' })] }, auth);
        assert.strictEqual(r.body.opened, 1);
        assert.ok(sent.some((n) => n.title === 'Alert: OpenVibeBrowserCheckFailed'));

        // An empty set resolves everything from that source; the list keeps them.
        r = await post({ source: 'prometheus', alerts: [] }, auth);
        assert.deepStrictEqual([r.body.firing, r.body.resolved], [0, 2]);
        const rows = alerts.list(db);
        assert.deepStrictEqual(rows.map((x) => x.state), ['resolved', 'resolved']);
        assert.ok(rows.every((x) => !('description' in x) || x.description === undefined));

        // No operator account: nothing is sent, nothing breaks.
        process.env.OWNER_USERNAME = 'ghost'; process.env.OPERATOR_ALERT_USERNAMES = '';
        r = await post({ source: 'prometheus', alerts: [alert('Lonely')] }, auth);
        assert.deepStrictEqual([r.status, r.body.opened, r.body.notified], [200, 1, 0]);
    } finally {
        server.close();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('operator alerts: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
