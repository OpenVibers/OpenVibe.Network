'use strict';
// Signed-in apps on the Network account page (2026-10-30): the extension's live refresh families are
// listed per person, only public clients, and revoking one family ends it. Another person's family is
// not touched; a Dock access token cannot use the account API.
//
//   node --import ./test/helpers/pg-preload.mjs test/account-apps.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const authRoutes = require('../server/auth/routes');

(async () => {
    const db = getDb();
    const keys = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    const mk = async (name) => {
        const id = (await db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id').run(name, `${name}@example.test`, 'x', 'user')).lastInsertRowid;
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        await subjects.ensureUserSubject(db, user);
        return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    };
    const ana = await mk('appsana');
    const bob = await mk('appsbob');
    const tokenOf = (u) => authRoutes.signToken(u, keys.privateKey, config);
    const family = (n) => `fam_${crypto.randomBytes(12).toString('hex')}`;
    const anaFam = family(), bobFam = family(), liveFam = family();
    const insert = async (tok, client, user, fam) => db.prepare('INSERT INTO oauth_tokens (token, client_id, user_id, scope, expires_at, family_id, generation) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(tok, client, user.id, 'dock activity chat.read', new Date(Date.now() + 86400e3).toISOString(), fam);
    await insert(crypto.randomBytes(48).toString('hex'), 'companion', ana, anaFam);
    await insert(crypto.randomBytes(48).toString('hex'), 'companion', ana, anaFam);
    await insert(crypto.randomBytes(48).toString('hex'), 'companion', bob, bobFam);
    await insert(crypto.randomBytes(48).toString('hex'), 'live', ana, liveFam);

    const app = express();
    app.use(express.json());
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/api/auth', authRoutes);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, path, tok) => fetch(base + path, { method, headers: { authorization: `Bearer ${tok}` } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    try {
        const before = await call('GET', '/api/auth/apps', tokenOf(ana));
        assert.strictEqual(before.status, 200, JSON.stringify(before.body));
        assert.strictEqual(before.body.apps.length, 1, 'one row per family, public clients only');
        assert.deepStrictEqual([before.body.apps[0].family_id, before.body.apps[0].client_id, before.body.apps[0].name], [anaFam, 'companion', 'OpenVibe extension']);
        assert.strictEqual(before.body.apps[0].scope, 'dock activity chat.read');

        const revoked = await call('DELETE', `/api/auth/apps/${anaFam}`, tokenOf(ana));
        assert.strictEqual(revoked.status, 200);
        assert.ok(revoked.body.revoked >= 2, 'every live generation of the family is revoked');
        assert.strictEqual((await call('GET', '/api/auth/apps', tokenOf(ana))).body.apps.length, 0);
        assert.strictEqual((await call('GET', '/api/auth/apps', tokenOf(bob))).body.apps.length, 1, 'another person’s family is untouched');

        const notMine = await call('DELETE', `/api/auth/apps/${bobFam}`, tokenOf(ana));
        assert.strictEqual(notMine.body.revoked, 0, 'a family is not revocable by another person');
        assert.strictEqual((await call('GET', '/api/auth/apps', tokenOf(bob))).body.apps.length, 1);

        // A Dock access token (private issuer) is not a normal session and cannot list/revoke apps.
        const dockTok = jwt.sign({
            sub: ana.id, id: ana.id, subject_id: ana.subject_id, username: ana.username, client_id: 'companion',
            scope: 'dock activity chat.read', fam: bobFam, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
        }, keys.privateKey, { algorithm: 'RS256', issuer: 'https://openvibe.network/dock', audience: ['openvibe.network', 'openvibe.chat'] });
        assert.strictEqual((await call('GET', '/api/auth/apps', dockTok)).status, 401);
        assert.strictEqual((await call('DELETE', `/api/auth/apps/${bobFam}`, dockTok)).status, 401);
        console.log('account apps: all checks passed');
    } finally {
        await new Promise((r) => server.close(r));
    }
})().catch((err) => { console.error(err); process.exit(1); });
