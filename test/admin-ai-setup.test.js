'use strict';
// The owner's guided AI setup (/admin/ai/setup): every route is owner only, Network signs its own
// service token for OpenVibe.AI's setup API, and a provider key travels through once and is never
// kept or echoed by Network.
//   node test/admin-ai-setup.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { createAiSetup } = require('../server/admin/ai-setup');

function upstream() {
    const seen = [];
    const srv = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null;
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
            res.writeHead(200, { 'content-type': 'application/json' });
            if (/\/key$/.test(req.url)) return res.end(JSON.stringify({ ok: true, provider: 'deepseek', hint: { last4: '1234' }, configured: true }));
            if (/\/test\//.test(req.url) || /\/test$/.test(req.url)) return res.end(JSON.stringify({ ok: true, step: 'chat', answer: { text: 'ready' }, cost_usd: 0.0001 }));
            if (/\/recommended$/.test(req.url)) return res.end(JSON.stringify({ ok: true, applied: [{ step: 'chat', ok: true }] }));
            return res.end(JSON.stringify({ ok: true, summary: { ready: 3, total: 8 }, steps: [{ id: 'chat', name: 'Chat and writing', ready: false }] }));
        });
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

(async () => {
    const ai = await upstream();
    const app = express();
    app.locals.config = { services: { ai: { internalUrl: ai.url } } };
    app.locals.selfToken = (aud, caps) => { assert.strictEqual(aud, 'openvibe.ai'); assert.deepStrictEqual(caps, ['ai.provider.manage']); return 'network-signed-token'; };
    app.use(express.json());
    // The signed-in person: X-Test-User, or none for a 401. requireOwner reads req.user.
    app.use((req, _res, next) => { const raw = req.headers['x-test-user']; if (raw) req.user = JSON.parse(raw); next(); });
    app.use('/api/admin/ai/setup', createAiSetup({ log: { warn() {}, log() {} } }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const owner = { id: 1, role: 'admin', username: 'goosely', is_owner: true };
    const admin = { id: 2, role: 'admin', username: 'someone', is_owner: false };
    async function call(who, method, p, body) {
        const headers = { 'content-type': 'application/json' };
        if (who) headers['x-test-user'] = JSON.stringify(who);
        const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, text, json };
    }
    try {
        // ── owner only ───────────────────────────────────────────────
        let r = await call(admin, 'GET', '/api/admin/ai/setup');
        assert.strictEqual(r.status, 403, 'a plain admin may not see the keys');
        r = await call(null, 'GET', '/api/admin/ai/setup');
        assert.strictEqual(r.status, 403, 'no person is not the owner');

        // ── the state ────────────────────────────────────────────────
        r = await call(owner, 'GET', '/api/admin/ai/setup');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.summary.total, 8);
        assert.strictEqual(ai.seen.at(-1).url, '/api/v1/setup', 'the state comes from AI setup API');
        assert.strictEqual(ai.seen.at(-1).auth, 'Bearer network-signed-token', 'Network signs its own service token');

        // ── a key goes through once and is never kept ────────────────
        r = await call(owner, 'PUT', '/api/admin/ai/setup/providers/deepseek/key', { key: 'forwarded-once-9999' });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(ai.seen.at(-1).body, { key: 'forwarded-once-9999' }, 'the key is forwarded, not rewritten');
        assert.strictEqual(r.json.hint.last4, '1234', 'only the last four come back');
        assert.ok(!fs.existsSync(path.join(__dirname, '..', 'data', 'ai-setup-keys.json')), 'Network kept no key file');

        // ── tests and writes ─────────────────────────────────────────
        r = await call(owner, 'POST', '/api/admin/ai/setup/test/chat', { provider: 'deepseek', model: 'deepseek-flash' });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(ai.seen.at(-1).url, '/api/v1/setup/test/chat');
        r = await call(owner, 'PUT', '/api/admin/ai/setup/routes/chat', { provider: 'deepseek', model: 'deepseek-flash' });
        assert.strictEqual(ai.seen.at(-1).url, '/api/v1/setup/routes/chat');
        r = await call(owner, 'PUT', '/api/admin/ai/setup/caps/chat', { cap_usd: 5 });
        assert.strictEqual(ai.seen.at(-1).url, '/api/v1/setup/caps/chat');
        r = await call(owner, 'POST', '/api/admin/ai/setup/recommended', {});
        assert.strictEqual(ai.seen.at(-1).url, '/api/v1/setup/recommended');

        // ── the page exists and is wired ─────────────────────────────
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
        assert.ok(html.includes('id="sec-ai-setup"'), 'the setup section is in the admin page');
        assert.ok(html.includes('/js/admin/ai-setup.js'), 'the setup script is loaded');
        const core = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'core.js'), 'utf8');
        assert.ok(core.includes("'/admin/ai/setup'"), 'the client route is /admin/ai/setup');
        const aiJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'ai.js'), 'utf8');
        assert.ok(aiJs.includes('loadAiSetupCard()'), 'the AI tab shows the setup card first');

        // ── no signer: a clear 503, not an unhandled failure ─────────
        app.locals.selfToken = () => null;
        r = await call(owner, 'GET', '/api/admin/ai/setup');
        assert.strictEqual(r.status, 503, r.text);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => ai.srv.close(resolve));
    }
    process.stdout.write('admin-ai-setup: owner proxy, key forwarding and page wiring passed\n');
})().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
