'use strict';
// Plan §Z.2 (11-13), the owner: navigation "user aware and session aware and … aware of rank … user can through API and
// SDK read it". GET /api/v1/viewer (and /api/auth/viewer) gives apps the shared navbar's OV.viewer() model:
//   - no session token: a guest, 200 (never 401);
//   - a member, a streamer, a mod, an admin and the owner each read as themselves (rank, staff, owner);
//   - the id is the person's usr_ subject, and an answer is private (no-store, varies on Authorization and Cookie);
//   - a bad token is a 401, so the caller knows its session is gone.
//   node --import ./test/helpers/pg-preload.mjs test/viewer-api.test.js
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { getDb } = require('../server/db/database');
const authRoutes = require('../server/auth/routes');
const { signToken } = authRoutes;

(async () => {
    process.env.OWNER_USERNAME = 'viewerowner';
    const db = getDb();
    const people = [
        [9301, 'viewermember', 'user'],
        [9302, 'viewerstreamer', 'streamer'],
        [9303, 'viewermod', 'global_mod'],
        [9304, 'vieweradmin', 'admin'],
        [9305, 'viewerowner', 'admin'],
    ];
    for (const [id, username, role] of people) {
        await db.prepare('INSERT INTO users (id, username, email, password_hash, email_verified, role) VALUES (?, ?, ?, ?, 1, ?)').run(id, username, `${username}@example.test`, 'x', role);
    }
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/api/auth', authRoutes);
    app.get('/api/v1/viewer', authRoutes.viewerHandler);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, headers = {}) => {
        const res = await fetch(base + path, { headers });
        return { status: res.status, headers: res.headers, body: res.status === 200 ? await res.json() : await res.text() };
    };

    try {
        // A guest: no token at all.
        const guest = await get('/api/v1/viewer');
        assert.strictEqual(guest.status, 200, 'a guest is answered, never refused');
        assert.deepStrictEqual(guest.body.viewer, { signedIn: false, rank: 'guest', staff: false, owner: false, id: null, username: null });
        assert.match(guest.headers.get('cache-control') || '', /no-store/);
        assert.match(guest.headers.get('vary') || '', /Authorization/i);
        assert.match(guest.headers.get('vary') || '', /Cookie/i);

        // Each rank, through the Bearer header and through the page cookie.
        const expect = {
            viewermember: ['member', false, false],
            viewerstreamer: ['streamer', false, false],
            viewermod: ['mod', true, false],
            vieweradmin: ['admin', true, false],
            viewerowner: ['admin', true, true],
        };
        for (const [id, username] of people) {
            const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
            const token = signToken(user, keys.privateKey, config);
            await get('/api/auth/me', { authorization: `Bearer ${token}` }); // gives the person their usr_ subject
            const r = await get('/api/v1/viewer', { authorization: `Bearer ${token}` });
            assert.strictEqual(r.status, 200, username);
            const v = r.body.viewer;
            const [rank, staff, owner] = expect[username];
            assert.deepStrictEqual([v.signedIn, v.rank, v.staff, v.owner, v.username], [true, rank, staff, owner, username], username);
            assert.match(String(v.id), /^usr_/, `${username}: the id is the usr_ subject`);
            assert.ok(!JSON.stringify(r.body).includes('@example.test'), `${username}: no email in the answer`);
            const viaCookie = await get('/api/auth/viewer', { cookie: `ov_token=${token}` });
            assert.strictEqual(viaCookie.status, 200);
            assert.strictEqual(viaCookie.body.viewer.username, username, `${username}: the page cookie works too`);
        }

        // A token that does not verify is a 401: the caller's session is gone, and it must not read as a guest.
        const bad = await get('/api/v1/viewer', { authorization: 'Bearer not-a-token' });
        assert.strictEqual(bad.status, 401);
        console.log('viewer-api: ok');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
