'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const authRoutes = require('../server/auth/routes');
const relay = require('../server/developer/event-relay');

(async () => {
    const db = getDb();
    const anaId = (await db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id').run(`feedseen${Date.now()}`, `feedseen${Date.now()}@example.test`, 'x')).lastInsertRowid;
    const bobId = (await db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id').run(`feedseenb${Date.now()}`, `feedseenb${Date.now()}@example.test`, 'x')).lastInsertRowid;
    const ana = await db.prepare('SELECT * FROM users WHERE id = ?').get(anaId);
    const bob = await db.prepare('SELECT * FROM users WHERE id = ?').get(bobId);
    await subjects.ensureUserSubject(db, ana); await subjects.ensureUserSubject(db, bob);
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
    const tokenOf = (u) => authRoutes.signToken(u, keys.privateKey, config);
    const app = express(); app.use(express.json()); Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/api/v1/me/feed-seen', require('../server/feed-seen').router({ requireAuth }));
    const server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${server.address().port}/api/v1/me/feed-seen`;
    const events = [], writerFor = relay.writerFor;
    relay.writerFor = () => ({ enqueue: async (env) => events.push(env) });
    const call = (method, user = ana) => fetch(api, { method, headers: { authorization: `Bearer ${tokenOf(user)}` } }).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));
    try {
        assert.equal((await call('GET')).body.seen_at, null, 'unseen defaults to null');
        const put = await call('PUT');
        assert.equal(put.status, 200); assert.ok(put.body.seen_at); assert.equal(put.headers.get('cache-control'), 'private, no-store');
        assert.equal((await call('GET')).body.seen_at, put.body.seen_at, "the person's own time persists");
        assert.equal((await call('GET', bob)).body.seen_at, null, 'another person cannot read it');
        assert.equal((await fetch(api)).status, 401, 'signed out is refused');
        assert.equal(events.length, 1); assert.equal(events[0].event_type, 'network.feed.seen');
        assert.deepEqual(events[0].subject, { type: 'user', id: ana.subject_id });
        assert.equal(events[0].visibility, 'subject'); assert.equal(events[0].payload.seen_at, put.body.seen_at);
        const migration = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations/0069_feed_seen.sql'), 'utf8');
        assert.match(migration, /^-- phase: expand$/m);
    } finally { relay.writerFor = writerFor; server.close(); }
    console.log('feed-seen: ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
