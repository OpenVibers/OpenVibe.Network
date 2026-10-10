'use strict';
// Provider secrets (roadmap §18.2(12), server/secrets.js): read from the environment only. A site_settings row of
// the same key is never used, the source is reported by name ('env' or 'unset'), and no admin path stores a secret
// in the database. The companions (VAPID public key) stay environment-first with a database fallback.
//   node test/provider-secrets.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const secrets = require('../server/secrets');

const ENV_NAMES = ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_OAUTH_CLIENT_SECRET', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY'];
for (const n of ENV_NAMES) delete process.env[n];
process.env.OWNER_USERNAME = 'owner';

const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-secrets-'));
    const dbPath = path.join(dir, 'network.db');
    const db = await getDb();
    const set = db.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, type = excluded.type');
    const dbVal = async (k) => (await db.prepare('SELECT value FROM site_settings WHERE key = ?').get(k) || {}).value;
    await set.run('resend_api_key', 're_db_key_111', 'string');
    await set.run('resend_webhook_secret', 'whsec_db_222', 'string');
    await set.run('discord_bot_token', 'db.bot.token.333', 'secret');
    await set.run('discord_oauth_client_secret', 'db-oauth-secret-444', 'secret');
    await set.run('net.ipinfo_token', 'ipinfo-555', 'secret');
    await set.run('ses_secret_access_key', 'ses-666', 'string');
    await set.run('some_new_api_key', 'unknown-777', 'string');

    // ── Environment only ──
    assert.strictEqual(await db.getSetting('resend_api_key'), null, 'a database copy is never used');
    assert.strictEqual(await secrets.source(db, 'resend_api_key'), 'unset');
    process.env.RESEND_API_KEY = 're_env_key_999';
    assert.strictEqual(await db.getSetting('resend_api_key'), 're_env_key_999', 'the variable is the source');
    assert.strictEqual(await secrets.source(db, 'resend_api_key'), 'env');
    process.env.RESEND_API_KEY = '   ';
    assert.strictEqual(await db.getSetting('resend_api_key'), null, 'a blank variable is unset, and the database copy still does not count');
    process.env.RESEND_API_KEY = 're_env_key_999';
    assert.strictEqual(await secrets.source(db, 'resend_webhook_secret'), 'unset');
    assert.strictEqual(await db.getSetting('email_user_daily_cap'), 30, 'other settings are untouched');
    const rep = await secrets.report(db);
    assert.deepStrictEqual(rep.filter(r => r.secret).map(r => r.key), ['resend_api_key', 'resend_webhook_secret', 'discord_bot_token', 'discord_oauth_client_secret', 'vapid_private_key', 'github_token']);
    assert.ok(!JSON.stringify(rep).includes('re_env_key_999') && !JSON.stringify(rep).includes('re_db_key_111'), 'the report carries no value');
    assert.ok(rep.find(r => r.key === 'discord_bot_token').database_copy, 'the report still says a stray database copy exists (for clean-up)');
    assert.match(await secrets.summary(db), /resend_api_key=env resend_webhook_secret=unset discord_bot_token=unset/);

    // The email service reads it through db.getSetting, and says where it came from.
    const { EmailService } = require('../server/notifications/email-service');
    const email = await quiet(() => new EmailService(db));
    assert.strictEqual((await email.getStatus()).api_key_source, 'env');
    assert.strictEqual((await email.getStatus()).api_key_env, 'RESEND_API_KEY');
    assert.ok((await email.getStatus()).api_key.startsWith('re_env'), 'the masked key shown is the one in use');

    // ── Web push: the public key follows the private key from the environment ──
    const webpush = require('web-push');
    const pair = webpush.generateVAPIDKeys();
    process.env.VAPID_PRIVATE_KEY = pair.privateKey;
    const push = require('../server/push/push-service');
    await quiet(async () => await push.initVapid(db));
    assert.strictEqual(await push.getPublicKey(), pair.publicKey, 'the public key is derived from VAPID_PRIVATE_KEY');
    assert.notStrictEqual(await dbVal('vapid_private_key'), pair.privateKey, 'the environment key is not copied into the database');

    // ── Admin API: sources shown, env-provided secrets never saved ──
    const createAdminRoutes = require('../server/admin/routes');
    const createDiscordRoutes = require('../server/discord/routes');
    const app = express();
    app.use(express.json());
    app.locals.db = db;
    const who = { id: 1, username: 'owner', role: 'admin' };
    const requireAuth = (req, _res, next) => { req.user = who; next(); };
    const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).end());
    const discordService = { getStatus: () => ({ connected: false }), reinit: async () => {} };
    await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'admin')").run();
    app.use('/api/admin/discord', createDiscordRoutes(db, discordService, requireAuth, requireAdmin));
    app.use('/api/admin', createAdminRoutes(db, { create() {} }, email, requireAuth));
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));

    let r = await call('GET', '/api/admin/secrets');
    assert.strictEqual(r.status, 200);
    const byKey = Object.fromEntries(r.body.secrets.map(s => [s.key, s]));
    assert.strictEqual(byKey.resend_api_key.source, 'env');
    assert.strictEqual(byKey.resend_api_key.env, 'RESEND_API_KEY');
    assert.strictEqual(byKey.discord_bot_token.source, 'unset');
    assert.strictEqual(byKey.vapid_private_key.source, 'env');
    assert.ok(!JSON.stringify(r.body).match(/re_env_key_999|re_db_key_111|db\.bot\.token|whsec_db/), 'names and sources only');

    // Email: a key typed in the UI is never stored.
    r = await call('PUT', '/api/admin/email', { api_key: 're_typed_in_ui', from_name: 'OpenVibe' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.skipped, ['resend_api_key']);
    assert.strictEqual(await dbVal('resend_api_key'), 're_db_key_111', 'the database row is left as it was, and unused');

    // Generic settings: a secret shows no value (env or not) and can never be saved.
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_env_888';
    r = await call('GET', '/api/admin/settings');
    assert.deepStrictEqual(r.body.settings.resend_webhook_secret, { value: '', type: 'string', source: 'env', env: 'RESEND_WEBHOOK_SECRET', redacted: true, secret: true });
    assert.deepStrictEqual(r.body.settings.discord_bot_token, { value: '', type: 'secret', source: 'unset', env: 'DISCORD_BOT_TOKEN', redacted: true, secret: true }, 'a database value is never shown');
    delete process.env.RESEND_WEBHOOK_SECRET;
    r = await call('PUT', '/api/admin/settings', { key: 'resend_webhook_secret', value: 'whsec_from_ui', type: 'string' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'settings.secret_env_only');
    assert.strictEqual(r.body.env, 'RESEND_WEBHOOK_SECRET');
    assert.strictEqual(await dbVal('resend_webhook_secret'), 'whsec_db_222', 'not saved, even with the variable unset');

    // Discord: the same rule.
    process.env.DISCORD_BOT_TOKEN = 'env.bot.token';
    r = await call('GET', '/api/admin/discord');
    assert.strictEqual(r.body.sources.discord_bot_token.source, 'env');
    assert.strictEqual(r.body.sources.discord_oauth_client_secret.source, 'unset');
    r = await call('PUT', '/api/admin/discord', { settings: { discord_bot_token: 'typed.token', discord_oauth_client_secret: 'typed-secret', discord_guild_id: '42' } });
    assert.deepStrictEqual(r.body.skipped, ['discord_bot_token', 'discord_oauth_client_secret']);
    assert.strictEqual(await dbVal('discord_bot_token'), 'db.bot.token.333');
    assert.strictEqual(await dbVal('discord_oauth_client_secret'), 'db-oauth-secret-444');
    assert.strictEqual(await dbVal('discord_guild_id'), '42', 'other Discord settings still save');
    delete process.env.DISCORD_BOT_TOKEN;
    server.close();

    for (const n of ENV_NAMES) delete process.env[n];
    console.log('provider secrets: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
