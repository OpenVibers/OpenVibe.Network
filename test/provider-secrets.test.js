'use strict';
// Provider secrets (roadmap §18.2(12), server/secrets.js): read from the environment first, the database
// only as a fallback, and the source is reported by name; the admin UI never saves a secret into the
// database while the environment provides it; scripts/secrets-out-of-db.js lists names only and blanks
// the database copies (with a backup, and a rollback) once the environment and the running service
// have them.
//   node test/provider-secrets.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { initDb } = require('../server/db/database');
const secrets = require('../server/secrets');

const ENV_NAMES = ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_OAUTH_CLIENT_SECRET', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY'];
for (const n of ENV_NAMES) delete process.env[n];
process.env.OWNER_USERNAME = 'owner';

const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-secrets-'));
    const dbPath = path.join(dir, 'network.db');
    const db = await quiet(() => initDb(dbPath));
    const set = db.prepare('INSERT OR REPLACE INTO site_settings (key, value, type) VALUES (?, ?, ?)');
    const dbVal = (k) => (db.prepare('SELECT value FROM site_settings WHERE key = ?').get(k) || {}).value;
    set.run('resend_api_key', 're_db_key_111', 'string');
    set.run('resend_webhook_secret', 'whsec_db_222', 'string');
    set.run('discord_bot_token', 'db.bot.token.333', 'secret');
    set.run('discord_oauth_client_secret', 'db-oauth-secret-444', 'secret');
    set.run('net.ipinfo_token', 'ipinfo-555', 'secret');
    set.run('ses_secret_access_key', 'ses-666', 'string');
    set.run('some_new_api_key', 'unknown-777', 'string');

    // ── Environment first, database fallback ──
    assert.strictEqual(db.getSetting('resend_api_key'), 're_db_key_111', 'no variable: the database value');
    assert.strictEqual(secrets.source(db, 'resend_api_key'), 'database');
    process.env.RESEND_API_KEY = 're_env_key_999';
    assert.strictEqual(db.getSetting('resend_api_key'), 're_env_key_999', 'the variable wins');
    assert.strictEqual(secrets.source(db, 'resend_api_key'), 'env');
    process.env.RESEND_API_KEY = '   ';
    assert.strictEqual(db.getSetting('resend_api_key'), 're_db_key_111', 'a blank variable is unset');
    process.env.RESEND_API_KEY = 're_env_key_999';
    assert.strictEqual(secrets.source(db, 'resend_webhook_secret'), 'database');
    assert.strictEqual(db.getSetting('email_user_daily_cap'), 30, 'other settings are untouched');
    const rep = secrets.report(db);
    assert.deepStrictEqual(rep.filter(r => r.secret).map(r => r.key), ['resend_api_key', 'resend_webhook_secret', 'discord_bot_token', 'discord_oauth_client_secret', 'vapid_private_key']);
    assert.ok(!JSON.stringify(rep).includes('re_env_key_999') && !JSON.stringify(rep).includes('re_db_key_111'), 'the report carries no value');
    assert.match(secrets.summary(db), /resend_api_key=env resend_webhook_secret=database discord_bot_token=database/);

    // The email service reads it through db.getSetting, and says where it came from.
    const { EmailService } = require('../server/notifications/email-service');
    const email = await quiet(() => new EmailService(db));
    assert.strictEqual(email.getStatus().api_key_source, 'env');
    assert.strictEqual(email.getStatus().api_key_env, 'RESEND_API_KEY');
    assert.ok(email.getStatus().api_key.startsWith('re_env'), 'the masked key shown is the one in use');

    // ── Web push: the public key follows the private key from the environment ──
    const webpush = require('web-push');
    const pair = webpush.generateVAPIDKeys();
    process.env.VAPID_PRIVATE_KEY = pair.privateKey;
    const push = require('../server/push/push-service');
    await quiet(() => push.initVapid(db));
    assert.strictEqual(push.getPublicKey(), pair.publicKey, 'the public key is derived from VAPID_PRIVATE_KEY');
    assert.notStrictEqual(dbVal('vapid_private_key'), pair.privateKey, 'the environment key is not copied into the database');

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
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'admin')").run();
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
    assert.strictEqual(byKey.discord_bot_token.source, 'database');
    assert.strictEqual(byKey.vapid_private_key.source, 'env');
    assert.ok(!JSON.stringify(r.body).match(/re_env_key_999|re_db_key_111|db\.bot\.token|whsec_db/), 'names and sources only');

    // Email: the key from the environment is not saved over.
    r = await call('PUT', '/api/admin/email', { api_key: 're_typed_in_ui', from_name: 'OpenVibe' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.skipped, ['resend_api_key']);
    assert.strictEqual(dbVal('resend_api_key'), 're_db_key_111', 'the database copy is not overwritten');

    // Generic settings: an env-provided secret shows no value and cannot be saved; a database one can.
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_env_888';
    r = await call('GET', '/api/admin/settings');
    assert.deepStrictEqual(r.body.settings.resend_webhook_secret, { value: '', type: 'string', source: 'env', env: 'RESEND_WEBHOOK_SECRET', redacted: true });
    assert.strictEqual(r.body.settings.discord_bot_token.source, 'database');
    r = await call('PUT', '/api/admin/settings', { key: 'resend_webhook_secret', value: 'whsec_from_ui', type: 'string' });
    assert.strictEqual(r.body.skipped, true);
    assert.strictEqual(r.body.env, 'RESEND_WEBHOOK_SECRET');
    assert.strictEqual(dbVal('resend_webhook_secret'), 'whsec_db_222', 'not saved while the environment provides it');
    delete process.env.RESEND_WEBHOOK_SECRET;
    r = await call('PUT', '/api/admin/settings', { key: 'resend_webhook_secret', value: 'whsec_from_ui', type: 'string' });
    assert.ok(!r.body.skipped);
    assert.strictEqual(dbVal('resend_webhook_secret'), 'whsec_from_ui', 'saved when the environment does not provide it');
    set.run('resend_webhook_secret', 'whsec_db_222', 'string');

    // Discord: the same rule.
    process.env.DISCORD_BOT_TOKEN = 'env.bot.token';
    r = await call('GET', '/api/admin/discord');
    assert.strictEqual(r.body.sources.discord_bot_token.source, 'env');
    assert.strictEqual(r.body.sources.discord_oauth_client_secret.source, 'database');
    r = await call('PUT', '/api/admin/discord', { settings: { discord_bot_token: 'typed.token', discord_guild_id: '42' } });
    assert.deepStrictEqual(r.body.skipped, ['discord_bot_token']);
    assert.strictEqual(dbVal('discord_bot_token'), 'db.bot.token.333');
    assert.strictEqual(dbVal('discord_guild_id'), '42', 'other Discord settings still save');
    server.close();

    // ── scripts/secrets-out-of-db.js ──
    const script = require('../scripts/secrets-out-of-db');
    const envFile = path.join(dir, 'network.env');
    // The lead copied three values into the env file: two equal to the database, one different.
    fs.writeFileSync(envFile, [
        'NODE_ENV=production',
        'RESEND_API_KEY=re_db_key_111',
        'DISCORD_BOT_TOKEN=db.bot.token.333',
        'DISCORD_OAUTH_CLIENT_SECRET=rotated-secret',
        '',
    ].join('\n'), { mode: 0o600 });
    const out = [];
    const running = { vars: { RESEND_API_KEY: 're_db_key_111', DISCORD_BOT_TOKEN: 'db.bot.token.333', DISCORD_OAUTH_CLIENT_SECRET: 'rotated-secret' }, pid: 4242 };
    const run = (argv, service = running) => script.main(['--db', dbPath, '--env-file', envFile, ...argv], (m) => out.push(m), { readService: () => service });
    const values = ['re_db_key_111', 'whsec_db_222', 'db.bot.token.333', 'db-oauth-secret-444', 'ipinfo-555', 'ses-666', 'unknown-777', 'rotated-secret'];
    const noValues = () => { const text = out.join('\n'); for (const v of values) assert.ok(!text.includes(v), `the script never prints a value (${v.slice(0, 3)}…)`); };

    assert.strictEqual(await run([]), 0);
    noValues();
    let text = out.join('\n');
    for (const k of ['resend_api_key', 'resend_webhook_secret', 'discord_bot_token', 'discord_oauth_client_secret', 'vapid_private_key', 'net.ipinfo_token', 'ses_secret_access_key', 'some_new_api_key']) assert.ok(text.includes(`  ${k}\n`), `lists ${k}`);
    assert.ok(!text.includes('  discord_oauth_client_id\n') && !text.includes('  vapid_public_key\n'), 'non-secrets are not listed');
    assert.match(text, /resend_api_key\n.*env file: set, same value · service: has it\n\s+--apply: BLANK/);
    assert.match(text, /resend_webhook_secret\n.*env file: not set.*\n\s+--apply: keep: put RESEND_WEBHOOK_SECRET in the env file first/);
    assert.match(text, /discord_oauth_client_secret\n.*DIFFERENT value.*\n\s+--apply: keep: the env file value differs/);
    assert.match(text, /net\.ipinfo_token\n.*\n\s+--apply: BLANK \(Network never reads it/);
    assert.match(text, /some_new_api_key\n.*\n\s+--apply: keep: not classified/);
    assert.strictEqual(dbVal('resend_api_key'), 're_db_key_111', 'the dry run changes nothing');

    out.length = 0;
    assert.strictEqual(await run(['--apply']), 2, '--apply refuses without --backup');
    // A service that was not restarted after the env file changed keeps its database copy.
    out.length = 0;
    const backup = path.join(dir, 'pre-secrets.db');
    assert.strictEqual(await run(['--apply', '--backup', backup], { vars: { RESEND_API_KEY: 're_db_key_111' }, pid: 1 }), 0);
    assert.strictEqual(dbVal('resend_api_key'), '', 'blanked: env file and running service have it');
    assert.strictEqual(dbVal('discord_bot_token'), 'db.bot.token.333', 'kept: the running service does not have DISCORD_BOT_TOKEN yet');
    assert.strictEqual(dbVal('discord_oauth_client_secret'), 'db-oauth-secret-444', 'kept: different value');
    assert.strictEqual(dbVal('resend_webhook_secret'), 'whsec_db_222', 'kept: not in the env file');
    assert.strictEqual(dbVal('net.ipinfo_token'), '', 'unused secret blanked');
    assert.strictEqual(dbVal('ses_secret_access_key'), '', 'unused secret blanked');
    assert.strictEqual(dbVal('some_new_api_key'), 'unknown-777', 'unclassified left alone');
    assert.strictEqual(fs.statSync(backup).mode & 0o777, 0o600, 'the backup is owner-only');
    noValues();
    // After the restart, and with --allow-different for the rotated one.
    out.length = 0;
    assert.strictEqual(await run(['--apply', '--backup', path.join(dir, 'pre-secrets-2.db'), '--allow-different']), 0);
    assert.strictEqual(dbVal('discord_bot_token'), '');
    assert.strictEqual(dbVal('discord_oauth_client_secret'), '', '--allow-different blanks a differing copy');
    assert.strictEqual(dbVal('resend_webhook_secret'), 'whsec_db_222');
    noValues();
    // An unreadable env file refuses --apply.
    out.length = 0;
    assert.strictEqual(await script.main(['--db', dbPath, '--env-file', path.join(dir, 'missing.env'), '--apply', '--backup', path.join(dir, 'x.db')], (m) => out.push(m), { readService: () => running }), 2);

    // Rollback from the first backup: every blanked value comes back; nothing printed.
    out.length = 0;
    assert.strictEqual(await script.main(['--db', dbPath, '--restore-from', backup], (m) => out.push(m)), 0);
    assert.strictEqual(dbVal('discord_bot_token'), '', 'the rollback dry run changes nothing');
    assert.strictEqual(await script.main(['--db', dbPath, '--restore-from', backup, '--apply'], (m) => out.push(m)), 0);
    assert.strictEqual(dbVal('resend_api_key'), 're_db_key_111');
    assert.strictEqual(dbVal('discord_bot_token'), 'db.bot.token.333');
    assert.strictEqual(dbVal('net.ipinfo_token'), 'ipinfo-555');
    assert.strictEqual(dbVal('discord_oauth_client_secret'), 'db-oauth-secret-444', 'restored from the backup taken before it was blanked');
    noValues();

    for (const n of ENV_NAMES) delete process.env[n];
    console.log('provider secrets: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
