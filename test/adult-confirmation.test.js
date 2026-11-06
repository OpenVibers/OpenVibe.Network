'use strict';
// The Exchange remake's uncensored tier, Network side: the account's own 18+ confirmation
// (server/identity/adult.js). The flag is a timestamp, anonymous accounts cannot set it, withdrawing clears it, and
// a first-party service reads it by the person's usr_ subject. The schema comes from migrations/0028.
//   node --import ./test/helpers/pg-preload.mjs test/adult-confirmation.test.js
const assert = require('assert');
const express = require('express');
const { getDb } = require('../server/db/database');
const adult = require('../server/identity/adult');

(async () => {
    const db = getDb();
    const quiet = console.log;
    console.log = () => {};
    await db.prepare("INSERT INTO users (id, username, password_hash, email_verified, subject_id) VALUES (71, 'grown', 'x', 1, 'usr_01JADVNT000000000000000000'), (72, 'anon', 'x', 1, 'usr_01JAN0N0000000000000000000')").run();
    console.log = quiet;

    let user = 71;
    const app = express();
    app.locals.db = db;
    app.use(express.json());
    app.use('/api/v1/me/adult', adult.userRouter({
        requireAuth: (req, _res, next) => { req.user = { id: user, is_anon: user === 72 ? 1 : 0 }; next(); },
    }));
    app.get('/internal/identity/adult', adult.internalAdult);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
        const res = await fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };
    try {
        assert.deepStrictEqual((await call('GET', '/api/v1/me/adult')).body, { adult: false, confirmed_at: null });
        assert.strictEqual((await call('PUT', '/api/v1/me/adult', {})).status, 400);
        const confirmed = await call('PUT', '/api/v1/me/adult', { confirm: true });
        assert.strictEqual(confirmed.status, 200);
        assert.strictEqual(confirmed.body.adult, true);
        assert.ok(confirmed.body.confirmed_at);
        assert.strictEqual((await call('GET', '/api/v1/me/adult')).body.adult, true);
        const audit = await db.prepare("SELECT action FROM audit_log WHERE user_id = 71 AND action = 'adult.confirmed'").get();
        assert.ok(audit, 'the confirmation is audited');

        // What OpenVibe.AI reads: by subject, and only for a usr_ subject.
        const internal = await call('GET', '/internal/identity/adult?subject_id=usr_01JADVNT000000000000000000');
        assert.strictEqual(internal.status, 200);
        assert.deepStrictEqual(internal.body, { subject_id: 'usr_01JADVNT000000000000000000', adult: true, confirmed_at: confirmed.body.confirmed_at });
        assert.strictEqual((await call('GET', '/internal/identity/adult?subject_id=usr_01JN0B0DY00000000000000000')).status, 404);
        assert.strictEqual((await call('GET', '/internal/identity/adult?subject_id=nope')).status, 400);

        // Withdrawing takes effect at once, and an anonymous account cannot confirm.
        assert.strictEqual((await call('DELETE', '/api/v1/me/adult')).body.adult, false);
        assert.strictEqual((await call('GET', '/internal/identity/adult?subject_id=usr_01JADVNT000000000000000000')).body.adult, false);
        user = 72;
        assert.strictEqual((await call('PUT', '/api/v1/me/adult', { confirm: true })).status, 403);
    } finally {
        await new Promise((r) => server.close(r));
    }
    console.log('adult-confirmation: 1/1 passed');
})().catch((err) => { console.error(err); process.exit(1); });
