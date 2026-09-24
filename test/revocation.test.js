'use strict';
// Revocation propagation (WS-B task 4, Contracts 0.39.0 network.user.token_valid_after): signing out
// every device, a password change, a reset and a ban move the cutoff, end Network's sessions and queue
// one validated event for the person's subject in the same transaction; older tokens stop working here.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { validate } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const revocation = require('../server/auth/revocation');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-revoke-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
const ISSUER = 'https://openvibe.network';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };

const hash = bcrypt.hashSync('oldpass1', 4);
const mk = (name, withSubject = true) => {
    const id = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(name, hash).lastInsertRowid;
    if (withSubject) subjects.ensureUserSubject(db, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    else db.prepare('UPDATE users SET subject_id = NULL WHERE id = ?').run(id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
// A session token issued 10 seconds ago (the cutoff has second precision; a token from the same second survives).
const oldToken = (u) => jwt.sign({ sub: u.id, id: u.id, subject_id: u.subject_id || undefined, username: u.username, role: u.role || 'user', iat: Math.floor(Date.now() / 1000) - 10 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const events = () => db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all().map(r => JSON.parse(r.envelope)).filter(e => e.event_type === 'network.user.token_valid_after');

const app = express();
app.locals.db = db; app.locals.config = config; app.locals.privateKey = keys.privateKey; app.locals.publicKey = keys.publicKey;
app.use(express.json()); app.use(cookieParser());
app.use('/api/auth', require('../server/auth/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    const call = (method, p, token, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
        .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    try {
        revocation.revokeTokens.length; // module loads
        assert.throws(() => revocation.revokeTokens(db, 1, { reason: 'because' }), /unknown reason/);

        // Sign out everywhere, this device too.
        const ann = mk('ann'); const annTok = oldToken(ann);
        assert.strictEqual((await call('GET', '/me', annTok)).status, 200);
        db.prepare("INSERT INTO user_sessions (user_id, session_token, is_active, expires_at) VALUES (?, 'sess-ann', 1, datetime('now', '+1 day'))").run(ann.id);
        let r = await call('POST', '/sign-out-everywhere', annTok);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual((await call('GET', '/me', annTok)).status, 401, 'the old token is refused');
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND is_active = 1').get(ann.id).n, 0);
        let ev = events();
        assert.strictEqual(ev.length, 1);
        assert.deepStrictEqual([ev[0].source, ev[0].subject, ev[0].payload.subject.id, ev[0].payload.reason, ev[0].payload.valid_after], ['network', { type: 'user', id: ann.subject_id }, ann.subject_id, 'signed_out_everywhere', r.body.valid_after]);
        assert.ok(validate('events.event-envelope@1', ev[0]).valid && validate('network.user.token_valid_after@1', ev[0].payload).valid);
        assert.deepStrictEqual(ev[0].actor, { type: 'user', id: ann.subject_id }, 'the person did it');

        // Sign out other devices: the old token dies, this browser gets a fresh one.
        const bob = mk('bob'); const bobTok = oldToken(bob);
        r = await call('DELETE', '/sessions', bobTok);
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.token);
        assert.strictEqual((await call('GET', '/me', bobTok)).status, 401);
        assert.strictEqual((await call('GET', '/me', r.body.token)).status, 200, 'the fresh token works');
        assert.strictEqual(events().at(-1).payload.reason, 'signed_out_everywhere');

        // Password change: every older token ends; the reply's token works.
        const cat = mk('cat'); const catTok = oldToken(cat);
        r = await call('POST', '/change-password', catTok, { current_password: 'oldpass1', new_password: 'newpass2' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual((await call('GET', '/me', catTok)).status, 401);
        assert.strictEqual((await call('GET', '/me', r.body.token)).status, 200);
        assert.deepStrictEqual([events().at(-1).payload.reason, events().at(-1).payload.subject.id], ['password_changed', cat.subject_id]);

        // A ban (staff actor) and an account without a subject (no event, the cutoff still moves).
        const dan = mk('dan');
        revocation.revokeTokens(db, dan.id, { reason: 'banned', actor: { type: 'user', id: ann.subject_id } });
        assert.deepStrictEqual([events().at(-1).payload.reason, events().at(-1).actor.id], ['banned', ann.subject_id]);
        const eve = mk('eve', false);
        const n = events().length;
        const out = revocation.revokeTokens(db, eve.id, { reason: 'staff_revoked' });
        assert.strictEqual(out.event, null);
        assert.strictEqual(events().length, n);
        assert.ok(db.prepare('SELECT token_valid_after FROM users WHERE id = ?').get(eve.id).token_valid_after);

        // Wiring: reset and ban call revokeTokens; the admin can end someone's sessions.
        const authSrc = fs.readFileSync(path.join(__dirname, '../server/auth/routes.js'), 'utf8');
        assert.ok(/revokeTokens\(db, reset\.user_id, \{ reason: 'password_reset'/.test(authSrc));
        const adminSrc = fs.readFileSync(path.join(__dirname, '../server/admin/routes.js'), 'utf8');
        assert.ok(/reason: 'banned'/.test(adminSrc) && /router\.post\('\/users\/:id\/sign-out'/.test(adminSrc) && /reason: 'staff_revoked'/.test(adminSrc));
        assert.ok(!/token_valid_after = CURRENT_TIMESTAMP/.test(authSrc), 'every cutoff goes through revokeTokens (so it is announced)');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('revocation: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
