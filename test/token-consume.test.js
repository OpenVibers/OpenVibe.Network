'use strict';
// Single-use tokens consumed twice at once (decision 1, plan T2): on SQLite the single writer hid the
// race; on PostgreSQL under READ COMMITTED two concurrent consumers can both read "unused" before either
// writes, so each claim is a conditional UPDATE inside a transaction and exactly one wins. Covers the two
// consume paths: an email-verification link (auth/email-verify.consumeToken) and a password-reset link
// (POST /api/auth/reset-password).
//   node test/token-consume.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const emailVerify = require('../server/auth/email-verify');
const resetTokens = require('../server/auth/reset-tokens');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-token-'));
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;

const hash = bcrypt.hashSync('oldpass1', 4);
const mk = async (name, email) => {
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id').run(name, email, hash)).lastInsertRowid;
    await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};

const app = express();
app.locals.db = db;
app.use(express.json()); app.use(cookieParser());
app.use('/api/auth', require('../server/auth/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    const call = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    try {
        // ── Email verification: two uses of one link, one success ──
        const user = await mk('emily', 'emily@example.com');
        const raw = crypto.randomBytes(32).toString('base64url');
        await db.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, email, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))")
            .run(crypto.createHash('sha256').update(raw).digest('hex'), user.id, user.email);
        const uses = await Promise.all([1, 2].map(() => emailVerify.consumeToken(db, raw).then((r) => r.ok).catch(() => false)));
        assert.strictEqual(uses.filter(Boolean).length, 1, 'one of two concurrent uses of a verification link wins');
        assert.ok((await db.prepare('SELECT email_verified FROM users WHERE id = ?').get(user.id)).email_verified, 'the account is verified once');
        const tokenRow = await db.prepare('SELECT used_at FROM email_verification_tokens WHERE user_id = ?').get(user.id);
        assert.ok(tokenRow.used_at, 'the link is marked used');

        // ── Password reset: two uses of one link, one success ──
        const frank = await mk('frank', 'frank@example.com');
        const rawReset = crypto.randomBytes(32).toString('hex');
        await db.prepare("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))")
            .run(frank.id, resetTokens.hashResetToken(rawReset));
        const resets = await Promise.all([1, 2].map(() => call('/reset-password', { token: rawReset, new_password: 'newpass9' })));
        assert.strictEqual(resets.filter((r) => r.status === 200).length, 1, 'one of two concurrent uses of a reset link wins');
        assert.strictEqual(resets.filter((r) => r.status === 400).length, 1, 'the other is refused (already used)');
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL').get(frank.id)).n, 0, 'the link is marked used');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('single-use token consume: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
