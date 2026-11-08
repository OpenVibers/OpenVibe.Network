'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { getDb } = require('../server/db/database');

(async () => {
    const db = getDb();
    const id = Date.now() % 1000000000;
    await db.prepare('INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (?, ?, ?, ?, 1)')
        .run(id, `email-test-${id}`, `primary-${id}@example.test`, 'x');
    await db.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)')
        .run(id + 1, `email-other-${id}`, `owned-${id}@example.test`, 'x');
    const sent = [];
    const app = express();
    app.use(express.json());
    app.locals.db = db;
    app.locals.emailService = { isEnabled: true, async sendVerificationEmail(message) { sent.push(message); return true; } };
    app.use('/api/v1/me/emails', require('../server/identity/emails').meRouter({ requireAuth(req, res, next) {
        req.user = { id };
        req.tokenClaims = req.headers.authorization === 'Bearer email-reader' ? { client_id: 'sample-app', scope: 'identity.emails.read' }
            : req.headers.authorization === 'Bearer ungranted-app' ? { client_id: 'sample-app', scope: 'profile' } : {};
        next();
    } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const port = server.address().port;
    const request = (path = '', method = 'GET', body, authorization = '') => new Promise((resolve, reject) => {
        const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(authorization ? { authorization } : {}) };
        const req = http.request({ hostname: '127.0.0.1', port, path: `/api/v1/me/emails${path}`, method, headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
    try {
        let response = await request();
        let body = response.body;
        assert.equal(body.emails.length, 1);
        assert.equal(body.emails[0].primary, true);
        response = await request('', 'POST', { email: `extra-${id}@example.test` });
        assert.equal(response.status, 202);
        assert.equal(sent.length, 1);
        const rows = (await request()).body.emails;
        const added = rows.find((row) => row.email === `extra-${id}@example.test`);
        assert.ok(added && !added.verified);
        response = await request(`/${added.id}/verify`, 'POST');
        assert.equal(response.status, 202);
        assert.equal(sent.length, 1, 'the per-account cooldown suppresses another verification email');
        response = await request('', 'POST', { email: `owned-${id}@example.test` });
        assert.equal(response.status, 202, 'an address owned by another account gets the same generic response');
        assert.equal(sent.length, 1, 'a duplicate address is never sent a verification email');
        const token = new URL(sent[0].verifyUrl).searchParams.get('token');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await db.prepare("UPDATE email_verification_tokens SET expires_at = datetime('now', '-1 minute') WHERE token_hash = ?").run(tokenHash);
        const verify = require('../server/auth/email-verify').consumeToken;
        const expired = await verify(db, token);
        assert.equal(expired.ok, false);
        assert.match(expired.error, /expired/);
        await db.prepare("UPDATE email_verification_tokens SET created_at = datetime('now', '-4 minutes'), expires_at = datetime('now', '+60 minutes') WHERE token_hash = ?").run(tokenHash);
        response = await request('', 'POST', { email: `second-${id}@example.test` });
        assert.equal(response.status, 202);
        assert.equal(sent.length, 2);
        const token2 = new URL(sent[1].verifyUrl).searchParams.get('token');
        const added2 = (await request()).body.emails.find((row) => row.email === `second-${id}@example.test`);
        assert.ok(added2);
        const first = await verify(db, token2);
        assert.equal(first.ok, true);
        assert.equal(first.email, added2.email);
        assert.equal((await verify(db, token2)).ok, false, 'verification link is single use');
        response = await request(`/${added2.id}/primary`, 'POST');
        assert.equal(response.status, 200);
        body = response.body;
        assert.equal(body.emails.find((row) => row.id === added2.id).primary, true);
        assert.equal((await db.prepare('SELECT email FROM users WHERE id = ?').get(id)).email, added2.email);
        response = await request('', 'GET', undefined, 'Bearer email-reader');
        assert.deepEqual(response.body.emails.map((row) => row.email), [added2.email], 'an app with the email-read scope receives only the chosen primary address');
        response = await request('', 'GET', undefined, 'Bearer ungranted-app');
        assert.equal(response.status, 403);
        response = await request(`/${added2.id}`, 'DELETE');
        assert.equal(response.status, 409, 'primary must be changed before removal');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await db.prepare('DELETE FROM users WHERE id = ?').run(id);
        await db.prepare('DELETE FROM users WHERE id = ?').run(id + 1);
    }
    console.log('account email management: verified address, single-use link, primary change and protected removal passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
