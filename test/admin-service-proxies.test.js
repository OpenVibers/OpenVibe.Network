'use strict';
// The admin panel's service proxies (server/admin/service-proxies.js) reach the service that owns each job: TTS goes
// to OpenVibe.Chat (Live has no /api/tts since the chat cutover), cashouts answer 410 with Billing's console, the
// Live and pastes proxies still go to Live; each checks the staff role first and forwards the re-minted token.
// The panel's scripts no longer call the retired routes or show Live's old payment webhooks and secrets.
//   node test/admin-service-proxies.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { createServiceProxies } = require('../server/admin/service-proxies');

/** A fake upstream that records each request and answers JSON. */
function upstream(name) {
    const seen = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null });
            if (req.url.startsWith('/api/tts/broken')) return res.writeHead(500, { 'content-type': 'application/problem+json' }).end('{"title":"boom"}');
            if (req.url.startsWith('/api/tts/text')) return res.writeHead(200, { 'content-type': 'text/html' }).end('<b>hi</b>');
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ from: name, url: req.url }));
        });
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

(async () => {
    const live = await upstream('live');
    const chat = await upstream('chat');
    const services = { live: { internalUrl: live.url }, chat: { internalUrl: chat.url } };
    // requireAuth stand-in: X-Test-User is the signed-in person; none → 401, as Network's requireAuth answers.
    const requireAuth = (req, res, next) => {
        const u = req.headers['x-test-user'];
        if (!u) return res.status(401).json({ error: 'Authentication required' });
        req.user = JSON.parse(u);
        req.token = `client-token-${req.user.id}`;
        next();
    };
    const signToken = (user) => `minted-${user.id}-${user.role}`;
    const app = express();
    app.locals.privateKey = 'test-key';
    app.locals.config = {};
    app.use(express.json());
    app.use('/api/admin', createServiceProxies({ requireAuth, signToken, services }));
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const admin = { id: 1, role: 'admin' };
    const mod = { id: 2, role: 'global_mod' };
    const user = { id: 3, role: 'user' };
    async function call(who, method, p, body) {
        const headers = { 'content-type': 'application/json' };
        if (who) headers['x-test-user'] = JSON.stringify(who);
        const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, type: r.headers.get('content-type') || '', text, json };
    }
    const reset = () => { live.seen.length = 0; chat.seen.length = 0; };

    try {
        // ── TTS → Chat ───────────────────────────────────────────────
        let r = await call(admin, 'GET', '/api/admin/streamer-tts/admin/settings');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json, { from: 'chat', url: '/api/tts/admin/settings' }, 'TTS settings come from Chat');
        assert.match(r.type, /^application\/json/);
        assert.strictEqual(chat.seen[0].auth, 'Bearer minted-1-admin', 'Chat gets the staff member\'s re-minted token');
        r = await call(admin, 'GET', '/api/admin/streamer-tts/voices?x=1');
        assert.strictEqual(r.json.url, '/api/tts/voices?x=1', 'the path and query reach Chat as they were');
        r = await call(admin, 'PUT', '/api/admin/streamer-tts/admin/settings', { settings: { tts_enabled: false } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(chat.seen.at(-1).body, { settings: { tts_enabled: false } }, 'a save carries its body to Chat');
        assert.strictEqual(chat.seen.at(-1).method, 'PUT');
        r = await call(admin, 'POST', '/api/admin/streamer-tts/admin/test', { voiceId: 'gary' });
        assert.strictEqual(chat.seen.at(-1).url, '/api/tts/admin/test');
        assert.strictEqual(live.seen.length, 0, 'nothing about TTS goes to Live');
        r = await call(admin, 'GET', '/api/admin/streamer-tts/broken');
        assert.strictEqual(r.status, 500, 'an upstream error keeps its status');
        assert.match(r.type, /^application\/problem\+json/, 'problem+json passes through as JSON');
        r = await call(admin, 'GET', '/api/admin/streamer-tts/text');
        assert.match(r.type, /^text\/plain/, 'a non-JSON answer is sent back as plain text, never as HTML on Network\'s origin');

        // Who may: admins only; no session → 401; nothing forwarded for a refusal.
        reset();
        assert.strictEqual((await call(null, 'GET', '/api/admin/streamer-tts/admin/settings')).status, 401);
        assert.strictEqual((await call(user, 'GET', '/api/admin/streamer-tts/admin/settings')).status, 403);
        assert.strictEqual((await call(mod, 'PUT', '/api/admin/streamer-tts/admin/settings', { settings: {} })).status, 403);
        assert.strictEqual(chat.seen.length, 0, 'a refused request never reaches Chat');

        // ── Cashouts: 410 with Billing's console, nothing forwarded ──
        r = await call(admin, 'GET', '/api/admin/streamer-funds/cashouts/pending');
        assert.strictEqual(r.status, 410);
        assert.strictEqual(r.json.console, 'https://billing.openvibe.network/cashouts');
        assert.match(r.json.error, /Billing/);
        r = await call(admin, 'POST', '/api/admin/streamer-funds/cashout/7/approve');
        assert.strictEqual(r.status, 410);
        assert.strictEqual((await call(null, 'GET', '/api/admin/streamer-funds/cashouts/pending')).status, 401);
        assert.strictEqual((await call(user, 'GET', '/api/admin/streamer-funds/cashouts/pending')).status, 403);
        assert.strictEqual(live.seen.length + chat.seen.length, 0, 'cashouts reach neither Live nor Chat');

        // ── Live and pastes proxies unchanged ────────────────────────
        r = await call(admin, 'GET', '/api/admin/streamer/settings');
        assert.deepStrictEqual(r.json, { from: 'live', url: '/api/admin/settings' });
        r = await call(admin, 'GET', '/api/admin/streamer-pastes/config');
        assert.deepStrictEqual(r.json, { from: 'live', url: '/api/pastes/config' });
        r = await call(mod, 'GET', '/api/admin/streamer-mod/reports');
        assert.deepStrictEqual(r.json, { from: 'live', url: '/api/mod/reports' }, 'global mods use the mod proxy');
        assert.strictEqual((await call(mod, 'GET', '/api/admin/streamer/settings')).status, 403, 'the Live admin proxy is admins only');
        assert.strictEqual((await call(user, 'GET', '/api/admin/streamer-mod/reports')).status, 403);
        // Other /api/admin paths are not the proxies' business.
        assert.strictEqual((await call(null, 'GET', '/api/admin/streamerx')).status, 404);

        // ── A service that is down: 502 naming it ────────────────────
        await new Promise((resolve) => chat.srv.close(resolve));
        r = await call(admin, 'GET', '/api/admin/streamer-tts/admin/settings');
        assert.strictEqual(r.status, 502);
        assert.strictEqual(r.json.error, 'Could not reach OpenVibe.Chat');
    } finally {
        server.close();
        live.srv.close();
        if (chat.srv.listening) chat.srv.close();
    }

    // ── The panel's scripts ───────────────────────────────────────────
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    const panel = ['admin.html', ...fs.readdirSync(path.join(__dirname, '..', 'public', 'js', 'admin')).map((f) => `js/admin/${f}`)].map(read).join('\n');
    for (const gone of ['/api/admin/streamer-funds', '/api/admin/streamer/vpn-queue', 'openvibe.live/api/payments/webhook', "showTab('vpn'"]) {
        assert.ok(!panel.includes(gone), `the admin panel no longer uses ${gone}`);
    }
    const payments = read('js/admin/payments.js');
    for (const key of ['paypal_client_secret', 'paypal_webhook_id', 'stripe_webhook_secret', 'ccbill_salt', 'ccbill_webhook_secret', 'crypto_ipn_secret']) {
        assert.ok(!payments.includes(`'${key}'`), `the Payments form no longer saves ${key} into Live's settings (Billing reads its environment)`);
    }
    for (const hook of ['stripe', 'paypal', 'ccbill', 'nowpayments', 'powerchat']) assert.ok(payments.includes(`'/webhooks/${hook}`), `Billing's ${hook} webhook is shown`);
    assert.ok(payments.includes("'https://billing.openvibe.network'"), 'webhooks are on Billing\'s origin');
    const content = read('js/admin/content.js');
    assert.ok(!/paste_(max|cooldown|anon|image|screenshot)/.test(content), 'the Pastes tab saves no paste_* settings nobody reads');
    assert.ok(content.includes("/api/admin/streamer-pastes/config"), 'the Pastes tab shows Community\'s limits');
    assert.ok(read('admin.html').includes('https://billing.openvibe.network/cashouts'), 'the Cashouts tab points to Billing\'s console');

    console.log('admin service proxies: all checks passed');
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
