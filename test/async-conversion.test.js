'use strict';
// What the async conversion (plan T2) must not break, where the database handle is not the point: a rejected
// async route handler answers 500 and the process lives (server/async-routes.js); the email service awaits its
// settings, from-address, preferences and guards (a promise is always truthy, and '[object Promise]' is not an
// address); the Discord status reads its settings. The database is a stub here: no query runs.
const assert = require('assert');
const express = require('express');
require('../server/async-routes');
const { EmailService } = require('../server/notifications/email-service');
const { DiscordService } = require('../server/discord/discord-service');

const quiet = async (fn) => { const l = console.log, w = console.warn, e = console.error; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; console.error = e; } };
const stubDb = (settings) => ({
    prepare: () => ({ run: async () => ({ changes: 1 }), get: async () => null, all: async () => [] }),
    getSetting: async (k) => (k in settings ? settings[k] : null),
});

(async () => {
    // ── Express 4 + async handlers ──
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    const app = express();
    app.set('env', 'test');   // the default error handler answers 500 without logging the stack
    app.get('/rejects', async () => { await null; throw new Error('the database is down'); });
    app.get('/throws', () => { throw new Error('sync'); });
    app.get('/ok', async (req, res) => { await null; res.json({ ok: true }); });
    app.get('/passes', async (req, res, next) => { await null; next(); });
    app.get('/passes', (req, res) => res.send('next route'));
    const handled = express();
    handled.set('env', 'test');
    handled.get('/x', async () => { throw new Error('to the error handler'); });
    handled.use(async (err, req, res, next) => { await null; res.status(503).json({ caught: err.message }); });
    const listen = (a) => new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
    const s1 = await listen(app); const s2 = await listen(handled);
    const get = async (s, p) => { const r = await fetch(`http://127.0.0.1:${s.address().port}${p}`); return { status: r.status, text: await r.text() }; };
    try {
        assert.strictEqual((await get(s1, '/rejects')).status, 500, 'a rejected async handler answers 500');
        assert.strictEqual((await get(s1, '/throws')).status, 500, 'a synchronous throw still answers 500');
        assert.deepStrictEqual(await get(s1, '/ok'), { status: 200, text: '{"ok":true}' });
        assert.deepStrictEqual(await get(s1, '/passes'), { status: 200, text: 'next route' }, 'next() from an async handler still reaches the next route');
        assert.deepStrictEqual(await get(s2, '/x'), { status: 503, text: '{"caught":"to the error handler"}' }, 'the rejection reaches the app error handler');
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(unhandled, null, 'no unhandled rejection');
    } finally { s1.close(); s2.close(); process.off('unhandledRejection', onUnhandled); }
    console.log('async route handlers: rejections answer 500');

    // ── Email service ──
    const email = new EmailService(stubDb({ email_enabled: true, resend_api_key: 're_test_key', email_from_address: 'noreply@example.test', email_from_live: 'live@example.test' }));
    await quiet(() => email.ready);
    assert.strictEqual(email.isEnabled, true, 'the settings are loaded once ready settles');
    assert.strictEqual(email._escapeHtml('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;', 'escaping is synchronous');
    const sent = [];
    email._sendEmail = async (o) => { sent.push(o); return true; };
    await email.sendVerificationEmail({ to: 'a@example.test', username: '<Ann>', verifyUrl: 'https://openvibe.network/verify-email?token=t' });
    assert.ok(!/\[object Promise\]/.test(sent[0].htmlBody) && /Hey &lt;Ann&gt;,/.test(sent[0].htmlBody), 'the verification email is escaped text');
    await email.sendNotificationEmail({ to: 'a@example.test', username: 'ann', notification: { title: 'T', message: 'M', service: 'live', priority: 'normal' } });
    assert.strictEqual(sent[1].fromEmail, 'live@example.test', 'the per-service from-address is a string');
    assert.ok(!/\[object Promise\]/.test(sent[1].htmlBody));
    const status = await email.getStatus();
    assert.strictEqual(status.issue, null, 'getStatus awaits diagnose()');
    assert.strictEqual(status.ready, true);

    // processQueue: an async shouldEmail() of false and an async guard skip, only the rest is sent.
    const marked = [];
    const n = (id, extra = {}) => ({ id, email: `u${id}@example.test`, username: `u${id}`, title: 'T', type: 'SYSTEM', priority: 'critical', ...extra });
    const notif = {
        getPendingEmails: async () => [n(1), n(2, { no: true }), n(3, { guard: 'stale' }), n(4, { guard: 'user-cap' })],
        shouldEmail: async (x) => !x.no,
        emailGuard: async (x) => x.guard || null,
        markEmailed: async (id) => { marked.push(id); },
    };
    sent.length = 0;
    await quiet(() => email.processQueue(notif));
    assert.deepStrictEqual(sent.map((o) => o.to), ['u1@example.test'], 'only the notification that passes both checks is sent');
    assert.deepStrictEqual(marked.sort(), [1, 2, 3], 'sent, opted out and stale are marked; a lifted cap may still send later');

    // Disabled: the failure reason recorded is diagnose()'s text, not a promise.
    const off = new EmailService(stubDb({}));
    await quiet(() => off.ready);
    const logged = [];
    off._recordDelivery = async (o) => { logged.push(o); };
    assert.strictEqual(await off._sendEmail({ to: 'a@example.test', subject: 's', htmlBody: '', textBody: '' }), false);
    assert.strictEqual(typeof logged[0].errorMessage, 'string');
    assert.match(logged[0].errorMessage, /Email is disabled/);
    console.log('email service: settings, from-address, preferences and guards are awaited');

    // ── Discord status ──
    const discord = new DiscordService(stubDb({ discord_guild_id: 'g1', discord_alerts_channel_id: 'c1' }));
    const ds = await discord.getStatus();
    assert.strictEqual(ds.guildId, 'g1');
    assert.strictEqual(ds.alertsChannelId, 'c1');
    assert.strictEqual(ds.connected, false);
    console.log('discord service: getStatus reads its settings');
    console.log('async conversion: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
