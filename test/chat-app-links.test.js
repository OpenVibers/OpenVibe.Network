'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { getDb } = require('../server/db/database');
const { store, pageRouter, userRouter } = require('../server/chat-apps/links');
(async () => {
    const db = getDb();
    const mk = async name => (await db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id').get(name, `${name}@example.test`, 'fixture')).id;
    const alice = await mk('chat_alice'), bob = await mk('chat_bob');
    const aliceSubject = (await db.prepare('SELECT subject_id FROM users WHERE id = ?').get(alice)).subject_id;
    let now = Date.now();
    const s = store(db, () => now);
    const make = async (app, external, ttl = 60000) => {
        const token = crypto.randomBytes(32).toString('base64url');
        await s.register({ token, app, service_user_id: external, service_username: '<script>', bot_handle: 'openvibe_bot', expires_at: new Date(now + ttl).toISOString() });
        return token;
    };
    const wrong = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

    // ── Two-way linking: confirming mints a code; only the same chat account can finish it ──
    for (const [app, external] of [['telegram', '123'], ['discord', '456'], ['slack', 'T123:U123']]) {
        const token = await make(app, external);
        assert.equal((await s.pending(token)).app, app);
        const half = await s.confirm(token, alice);
        assert.match(half.code, /^[0-9]{6}$/, 'the page shows a 6-digit code');
        const row = await db.prepare('SELECT * FROM chat_app_pending_links WHERE app = ? AND external_id = ?').get(app, external);
        assert.equal(row.code_hash, crypto.createHash('sha256').update(`chat-app-code:${app}:${external}:${half.code}`).digest('hex'));
        assert.notEqual(row.code_hash, half.code, 'the code is kept only as a hash');
        assert.equal((await db.prepare("SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'chat_app_pending_links' AND column_name = 'code'").get()).n, 0, 'no plaintext code column');
        // A different chat account sending the same code finishes nothing.
        assert.deepEqual(await s.finish({ app, service_user_id: app === 'slack' ? 'T123:U999' : '999', code: half.code }), { ok: false, error: 'no_link' });
        assert.equal(await s.resolve(app, external), undefined);
        assert.equal((await s.pending(token)).finished_at, null, 'still unfinished');
        // The chat account that started /link finishes it.
        const done = await s.finish({ app, service_user_id: external, code: half.code });
        assert.deepEqual(done, { ok: true, subject: aliceSubject, app });
        assert.equal((await s.resolve(app, external)).subject_id, aliceSubject);
        assert.ok((await s.pending(token)).finished_at, 'the pending link is finished');
        // The same code twice finishes nothing more.
        assert.deepEqual(await s.finish({ app, service_user_id: external, code: half.code }), { ok: false, error: 'no_link' });
        await s.unlink(app, external);
        assert.equal(await s.resolve(app, external), undefined);
    }

    // Three wrong codes cancel the pending link; the right code after that does nothing.
    {
        const token = await make('telegram', '777');
        const { code } = await s.confirm(token, alice);
        assert.equal((await s.finish({ app: 'telegram', service_user_id: '777', code: wrong(code) })).attemptsLeft, 2);
        assert.equal((await s.finish({ app: 'telegram', service_user_id: '777', code: wrong(code) })).attemptsLeft, 1);
        assert.equal((await s.finish({ app: 'telegram', service_user_id: '777', code: wrong(code) })).attemptsLeft, 0);
        assert.equal((await s.finish({ app: 'telegram', service_user_id: '777', code })).ok, false, 'the link was cancelled');
        assert.equal(await s.resolve('telegram', '777'), undefined);
    }

    // The code (and the pending link) expire together; confirming after that is refused.
    {
        const token = await make('discord', '888', 60000);
        const { code } = await s.confirm(token, alice);
        now += 61000;
        assert.equal((await s.finish({ app: 'discord', service_user_id: '888', code })).ok, false);
        await assert.rejects(s.confirm(token, alice), /expired/);
        const expired = await make('telegram', '987'); now += 61000;
        await assert.rejects(s.confirm(expired, alice), /expired/);
    }

    // A different signed-in account cannot take an identity, even with a fresh link and its code.
    {
        const token = await make('telegram', '321');
        const { code } = await s.confirm(token, alice);
        await s.finish({ app: 'telegram', service_user_id: '321', code });
        const second = await make('telegram', '321');
        await assert.rejects(s.confirm(second, bob), /already linked/);
        await s.unlink('telegram', '321');
    }

    // The real internal gate: a signed service token with identity.subject.resolve, and only svc:chat.
    const ISSUER = 'https://openvibe.network';
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const serviceAuth = require('openvibe-contracts').serviceAuth;
    const token = (sub, cap) => serviceAuth.signServiceToken({ iss: ISSUER, sub, actor_type: 'service', aud: ['openvibe.network'], cap, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID() }, keys.privateKey);
    const app = express(); app.locals.db = db;
    app.locals.config = { baseUrl: ISSUER, jwt: { issuer: ISSUER } };
    app.locals.privateKey = keys.privateKey; app.locals.publicKey = keys.publicKey;
    app.use(express.json()); app.use(express.urlencoded({ extended: false }));
    app.use('/internal', require('../server/internal/routes'));
    const auth = (req, res, next) => { if (!req.get('x-test-user')) return res.sendStatus(401); req.user = { id: alice }; next(); };
    app.use('/chat-apps', pageRouter(auth));
    app.use('/api/v1/me/chat-apps', userRouter(auth));
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, { method = 'GET', bearer, body } = {}) => {
        const r = await fetch(base + path, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    try {
        // No token, a token without the capability, and another service with it are all refused.
        assert.equal((await call('/internal/chat-app-links', { method: 'POST', body: {} })).status, 401);
        assert.equal((await call('/internal/chat-app-links', { method: 'POST', bearer: token('svc:chat', ['actor.task.read']), body: {} })).status, 403);
        assert.equal((await call('/internal/chat-app-links', { method: 'POST', bearer: token('svc:watch', ['identity.subject.resolve']), body: {} })).status, 403);
        // svc:chat registers a link; the signed-in confirm page shows the code and the bot to send it to.
        const chat = token('svc:chat', ['identity.subject.resolve']);
        const tg = crypto.randomBytes(32).toString('base64url');
        assert.equal((await call('/internal/chat-app-links', { method: 'POST', bearer: chat, body: { token: tg, app: 'telegram', service_user_id: '555', service_username: 'dana', bot_handle: 'openvibe_bot', expires_at: new Date(now + 300000).toISOString() } })).status, 200);
        assert.equal((await call(`/internal/chat-app-links?t=${tg}`, { bearer: chat })).body.state, 'pending');
        const before = await fetch(base + `/chat-apps/link?t=${tg}`, { headers: { 'x-test-user': 'yes', authorization: 'Bearer test' } });
        const beforeText = await before.text();
        assert.equal(before.status, 200);
        assert.match(beforeText, /will talk to your OpenVibe agent and approve its steps/, 'the page says in plain words what linking does');
        assert.match(beforeText, /6-digit code/);
        const confirmed = await fetch(base + '/chat-apps/link', { method: 'POST', headers: { 'x-test-user': 'yes', authorization: 'Bearer test', origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: tg }).toString() });
        const page = await confirmed.text();
        assert.equal(confirmed.status, 200);
        const code = page.match(/<code>([0-9]{6})<\/code>/)[1];
        assert.match(page, /@openvibe_bot/, 'the code page names the bot');
        assert.match(page, /telegram @dana/, 'and the chat account to send it from');
        assert.equal((await call(`/internal/chat-app-links?t=${tg}`, { bearer: chat })).body.state, 'confirmed');
        // Another chat account sending the code finishes nothing; the same one does.
        assert.equal((await call('/internal/chat-app-links/finish', { method: 'POST', bearer: chat, body: { app: 'telegram', service_user_id: '999', code } })).status, 404);
        assert.equal((await call('/internal/chat-app-links/resolve?app=telegram&id=555', { bearer: chat })).body.subject_id, null);
        const done = await call('/internal/chat-app-links/finish', { method: 'POST', bearer: chat, body: { app: 'telegram', service_user_id: '555', code } });
        assert.deepEqual(done.body, { ok: true, subject: aliceSubject, app: 'telegram' });
        assert.equal((await call(`/internal/chat-app-links?t=${tg}`, { bearer: chat })).body.state, 'finished');
        assert.equal((await call('/internal/chat-app-links/resolve?app=telegram&id=555', { bearer: chat })).body.subject_id, aliceSubject);
        // The account page's own list and removal (signed in, their own rows only).
        const mine = async (method = 'GET', path = '/api/v1/me/chat-apps') => {
            const r = await fetch(base + path, { method, headers: { 'x-test-user': 'yes' } });
            const text = await r.text();
            return { status: r.status, body: text ? JSON.parse(text) : null };
        };
        assert.equal((await fetch(base + '/api/v1/me/chat-apps')).status, 401);
        assert.deepEqual((await mine()).body.items.map((i) => [i.app, i.service_user_id]), [['telegram', '555']]);
        assert.deepEqual(await mine('DELETE', '/api/v1/me/chat-apps/telegram'), { status: 200, body: { ok: true, removed: 1 } });
        assert.deepEqual((await mine()).body, { items: [] });
        assert.equal((await mine('DELETE', '/api/v1/me/chat-apps/telegram')).status, 404);
        // The confirm page: signed out redirects, a cross-origin POST is refused.
        assert.equal((await fetch(base + '/chat-apps/link', { redirect: 'manual' })).status, 302);
        assert.equal((await fetch(base + '/chat-apps/link', { method: 'POST', headers: { 'x-test-user': 'yes', origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    } finally { await new Promise(r => server.close(r)); }
    console.log('chat-app links: two-way codes, the wrong chat account refused, expiry, three wrong codes, real service-token gate, CSRF passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
