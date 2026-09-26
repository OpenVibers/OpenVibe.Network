'use strict';
// Network's site settings as revisioned configuration (WS-C task 7; server/admin/site-config.js):
// revision 1 is the configuration rows (migration flags and the push key pair stay out); PUT
// /api/admin/settings, /api/admin/email and /api/admin/discord each make one revision with who and why,
// written to the rows (types kept, a new row takes the caller's type); db.getSetting reads what it read
// before; a row written around the journal is recorded as a sync revision first and never reverted;
// history shows secret-class values only as fingerprints; the owner rolls back.
//   node test/site-config.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { initDb } = require('../server/db/database');
for (const n of ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_OAUTH_CLIENT_SECRET', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY']) delete process.env[n];
process.env.OWNER_USERNAME = 'owner';
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-netcfg-'));
    const db = await quiet(() => initDb(path.join(dir, 'network.db')));
    const set = db.prepare('INSERT OR REPLACE INTO site_settings (key, value, type) VALUES (?, ?, ?)');
    const row = (k) => db.prepare('SELECT value, type FROM site_settings WHERE key = ?').get(k);
    set.run('discord_bot_token', 'example-bot-token-not-real', 'secret');
    set.run('migr_pref_email_null', 'true', 'boolean');
    set.run('vapid_private_key', 'example-vapid-private', 'secret');

    const createAdminRoutes = require('../server/admin/routes');
    const createDiscordRoutes = require('../server/discord/routes');
    const { EmailService } = require('../server/notifications/email-service');
    const email = await quiet(() => new EmailService(db));
    const app = express();
    app.use(express.json());
    app.locals.db = db;
    let who = { id: 1, username: 'owner', role: 'admin', subject_id: 'usr_01KKT9AC60KM7CRTB3WN1Z8P56' };
    const requireAuth = (req, _res, next) => { req.user = who; next(); };
    const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).end());
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'admin'), (2, 'helper', 'x', 'admin')").run();
    app.use('/api/admin/discord', createDiscordRoutes(db, { getStatus: () => ({ connected: false }), reinit: async () => {} }, requireAuth, requireAdmin));
    app.use('/api/admin', createAdminRoutes(db, { create() {} }, email, requireAuth));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = (method, p, body) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    const cfg = require('../server/admin/site-config').forDb(db);

    // ── Revision 1: configuration only ──
    await quiet(() => cfg.sync());
    const keys = Object.keys(cfg.store.get());
    assert.ok(keys.includes('discord_bot_token') && keys.includes('email_user_daily_cap'), 'configuration is in');
    assert.ok(!keys.includes('migr_pref_email_null') && !keys.includes('vapid_private_key'), 'migration flags and the push key pair are not');
    const rev1 = cfg.store.revision();

    // ── A setting: one revision, the row written with its type, readers unchanged ──
    let r = await quiet(() => call('PUT', '/api/admin/settings', { key: 'stream_live_daily_cap', value: '9', type: 'number', reason: 'fewer alerts' }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.revision, rev1 + 1);
    assert.deepStrictEqual(row('stream_live_daily_cap'), { value: '9', type: 'number' });
    assert.strictEqual(db.getSetting('stream_live_daily_cap'), 9);
    r = await quiet(() => call('PUT', '/api/admin/settings', { key: 'brand_new_flag', value: 'true', type: 'boolean' }));
    assert.deepStrictEqual(row('brand_new_flag'), { value: 'true', type: 'boolean' }, 'a new row takes the given type');

    // ── Email and Discord changes are revisions too ──
    r = await quiet(() => call('PUT', '/api/admin/email', { from_name: 'OpenVibe Team' }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(row('email_from_name').value, 'OpenVibe Team');
    r = await quiet(() => call('PUT', '/api/admin/discord', { settings: { discord_dedupe_minutes: '15', discord_bot_token: 'example-new-bot-token' } }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(row('discord_dedupe_minutes'), { value: '15', type: 'number' });
    assert.deepStrictEqual(row('discord_bot_token'), { value: 'example-new-bot-token', type: 'secret' }, 'a secret row stays a secret row');

    // ── Written around the journal: recorded first, never reverted ──
    set.run('email_daily_cap', '777', 'number');
    const before = cfg.store.revision();
    r = await quiet(() => call('PUT', '/api/admin/settings', { key: 'stream_live_daily_cap', value: '12', type: 'number' }));
    assert.strictEqual(cfg.store.revision(), before + 2, 'a sync revision, then the change');
    assert.strictEqual(row('email_daily_cap').value, '777');

    // ── History: who, why, secrets as fingerprints ──
    r = await call('GET', '/api/admin/config/network.site_settings/history?limit=50');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('example-new-bot-token') && !text.includes('example-bot-token-not-real'), 'no secret value leaves');
    assert.strictEqual(r.body.snapshots[0].values.discord_bot_token.redacted, true);
    const change = r.body.snapshots.find((x) => x.reason === 'fewer alerts');
    assert.deepStrictEqual(change.created_by, { type: 'user', id: 'usr_01KKT9AC60KM7CRTB3WN1Z8P56' });
    assert.ok(r.body.snapshots.some((x) => /^sync: /.test(x.reason)));

    // ── Rollback undoes the last change only; the secret and the outside row stay ──
    r = await quiet(() => call('POST', '/api/admin/config/network.site_settings/rollback', { reason: 'too many' }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([row('stream_live_daily_cap').value, row('email_daily_cap').value, row('discord_bot_token').value], ['9', '777', 'example-new-bot-token']);
    assert.strictEqual((await call('POST', '/api/admin/config/other.namespace/rollback', {})).status, 404);

    // Only the owner reads or rolls back the configuration.
    who = { id: 2, username: 'helper', role: 'admin', subject_id: 'usr_01KRMBAEEGCF1Z34D5WXXAP3TA' };
    assert.strictEqual((await call('GET', '/api/admin/config')).status, 403);
    assert.strictEqual((await call('POST', '/api/admin/config/network.site_settings/rollback', {})).status, 403);

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('site config: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
