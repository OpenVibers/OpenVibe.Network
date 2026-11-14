'use strict';
// The shared person card asks GET /api/users/:id/card (openvibe-shared user-card.js, on every site); the card lives on the
// auth router (/api/auth/users/:id/card). Both answer (11-14, the owner: "the user context menu cross-site shared system
// doesn't work": every press on a name was a 404). A name, @name, a subject or Network's id finds the person; anything
// else is a plain 404.
const assert = require('assert');
const express = require('express');
const { getDb } = require('../server/db/database');
const authRoutes = require('../server/auth/routes');

(async () => {
    const db = getDb();
    const subject = 'usr_01JZ0000000000000000000CPA';
    await db.prepare("INSERT INTO users(username,password_hash,display_name,subject_id) VALUES ('CardPath','x','Card Path',?)").run(subject);
    const id = (await db.prepare("SELECT id FROM users WHERE username = 'CardPath'").get()).id;
    const app = express();
    app.locals.db = db; app.locals.config = {};
    app.use('/api/auth', authRoutes);
    app.get('/api/users/:id/card', authRoutes.cardAlias);
    const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };
    try {
        for (const key of ['CardPath', 'cardpath', '%40CardPath', subject, String(id)]) {
            const r = await get(`/api/users/${key}/card`);
            assert.strictEqual(r.status, 200, `${key}: ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.user.username, 'CardPath', `${key} finds the person`);
        }
        const same = await get('/api/auth/users/CardPath/card');
        assert.strictEqual(same.status, 200, 'the auth router\'s own address still answers');
        assert.strictEqual((await get('/api/users/nobody_here/card')).status, 404, 'nobody: a 404');
        assert.strictEqual((await get('/api/users/..%2F..%2Fetc/card')).status, 404, 'a key of another shape: a 404');
        console.log('user card path: /api/users/:id/card answers by name, @name, subject and id; /api/auth too');
    } finally { server.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
