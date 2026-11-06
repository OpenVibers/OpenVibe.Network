'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { getDb } = require('../server/db/database');
const { store, internalRouter, pageRouter } = require('../server/chat-apps/links');
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
    const app = express(); app.locals.db = db; app.locals.config = { baseUrl: 'https://openvibe.network' };
    app.use(express.json()); app.use(express.urlencoded({ extended: false }));
    app.use('/internal', (req, res, next) => { req.principal = { sub: req.get('x-test-service'), actor_type: 'service' }; next(); }, internalRouter());
    app.use('/chat-apps', pageRouter((req, res, next) => { if (!req.get('x-test-user')) return res.sendStatus(401); req.user = { id: alice }; next(); }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await fetch(base + '/internal')).status, 403);
        assert.equal((await fetch(base + '/chat-apps/link', { redirect: 'manual' })).status, 302);
        assert.equal((await fetch(base + '/chat-apps/link', { method: 'POST', headers: { 'x-test-user': 'yes', origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    } finally { await new Promise(r => server.close(r)); }
    console.log('chat-app links: races, identity ownership, expiry, revocation, authentication and CSRF passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
