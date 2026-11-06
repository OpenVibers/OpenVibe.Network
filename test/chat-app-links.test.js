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
    let now = Date.now();
    const s = store(db, () => now);
    const make = async (app, external) => {
        const token = crypto.randomBytes(32).toString('base64url');
        await s.register({ token, app, service_user_id: external, service_username: '<script>', expires_at: new Date(now + 60000).toISOString() });
        return token;
    };
    for (const [app, external] of [['telegram', '123'], ['discord', '456'], ['slack', 'T123:U123']]) {
        const token = await make(app, external);
        assert.equal((await s.pending(token)).app, app);
        const results = await Promise.allSettled([s.confirm(token, alice), s.confirm(token, bob)]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        const owner = (await db.prepare('SELECT user_id FROM linked_accounts WHERE service = ? AND service_user_id = ?').get(app === 'slack' ? 'chat:slack:T123' : `chat:${app}`, external)).user_id;
        const other = owner === alice ? bob : alice;
        await assert.rejects(s.confirm(await make(app, external), other), /already linked/);
        await s.unlink(app, external);
        assert.equal(await s.resolve(app, external), undefined);
    }
    const expired = await make('telegram', '987'); now += 61000;
    await assert.rejects(s.confirm(expired, alice), /expired/);

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
        // svc:chat registers a link, reads it pending, then the signed-in person confirms and Chat resolves it.
        const chat = token('svc:chat', ['identity.subject.resolve']);
        const tg = crypto.randomBytes(32).toString('base64url');
        assert.equal((await call('/internal/chat-app-links', { method: 'POST', bearer: chat, body: { token: tg, app: 'telegram', service_user_id: '555', service_username: 'dana', expires_at: new Date(now + 300000).toISOString() } })).status, 200);
        assert.equal((await call(`/internal/chat-app-links?t=${tg}`, { bearer: chat })).body.state, 'pending');
        await s.confirm(tg, alice);
        assert.equal((await call(`/internal/chat-app-links?t=${tg}`, { bearer: chat })).body.state, 'confirmed');
        assert.equal((await call('/internal/chat-app-links/resolve?app=telegram&id=555', { bearer: chat })).body.subject_id, (await db.prepare('SELECT subject_id FROM users WHERE id = ?').get(alice)).subject_id);
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
        assert.equal((await call('/internal/chat-app-links/unlink', { method: 'POST', bearer: chat, body: { app: 'telegram', service_user_id: '555' } })).status, 200);
        assert.deepEqual((await call('/internal/chat-app-links/resolve?app=telegram&id=555', { bearer: chat })).body, { subject_id: null });
        // The confirm page: signed out redirects, a cross-origin POST is refused.
        assert.equal((await fetch(base + '/chat-apps/link', { redirect: 'manual' })).status, 302);
        assert.equal((await fetch(base + '/chat-apps/link', { method: 'POST', headers: { 'x-test-user': 'yes', origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    } finally { await new Promise(r => server.close(r)); }
    console.log('chat-app links: real service-token gate, races, identity ownership, expiry, revocation, authentication and CSRF passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
