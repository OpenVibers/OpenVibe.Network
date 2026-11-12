'use strict';
/**
 * Times leave with their zone (openvibe.design rule 148): Network's SQLite-era text timestamps are UTC
 * but a browser reads `YYYY-MM-DD HH:MM:SS` as local time. The JSON edge renders time fields as ISO
 * 8601 with Z; stored text, cursors and every query that compares it stay unchanged.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { isoTime, normalizeTimes, isoJsonTimes } = require('../server/iso-times');

assert.strictEqual(isoTime('2026-11-12 05:01:02'), '2026-11-12T05:01:02Z');
assert.strictEqual(isoTime('2026-11-12T05:01:02.123Z'), '2026-11-12T05:01:02.123Z', 'ISO with Z is left alone');
assert.strictEqual(isoTime('2026-11-12T05:01:02+02:00'), '2026-11-12T05:01:02+02:00', 'ISO with an offset is left alone');
assert.strictEqual(isoTime('2026-11-12'), '2026-11-12', 'a date is not a time');
assert.strictEqual(isoTime(null), null);
assert.deepStrictEqual(
    normalizeTimes({ id: 1, created_at: '2026-11-12 05:01:02', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12 05:01:02' }, tags: [{ expires_at: '2026-11-12 05:01:02' }] }),
    { id: 1, created_at: '2026-11-12T05:01:02Z', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12T05:01:02Z' }, tags: [{ expires_at: '2026-11-12T05:01:02Z' }] },
    'time-named fields are rendered; body text that looks like a time is not',
);

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (41, 'zone', 'x', 'user') ON CONFLICT DO NOTHING").run();
    for (const [id, name] of [['vibe', 'Vibe'], ['cloud', 'Cloud']]) {
        await db.prepare("INSERT INTO themes (id, name, slug, mode, variables, is_builtin, is_public) VALUES (?, ?, ?, 'dark', '{}', 1, 1) ON CONFLICT DO NOTHING").run(id, name, id);
    }
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    const { signToken } = require('../server/auth/routes');
    const app = express();
    app.use(express.json());
    app.use(isoJsonTimes);
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/api/themes', require('../server/themes/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = await signToken(await db.prepare('SELECT * FROM users WHERE id = 41').get(), keys.privateKey, config);
    const call = async (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    await call('PUT', '/api/themes/me', { theme_id: 'vibe' });
    await call('PUT', '/api/themes/me', { theme_id: 'cloud' });
    const r = await call('GET', '/api/themes/me/history');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.history.length > 0, 'the history has the replaced setting');
    for (const entry of r.body.history) assert.match(entry.created_at, /Z$/, 'theme history created_at is ISO with Z');
    const row = await db.prepare('SELECT created_at FROM user_theme_history WHERE user_id = 41 ORDER BY id DESC LIMIT 1').get();
    assert.match(row.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, 'the stored text is untouched');

    await new Promise((r2) => server.close(r2));
    console.log('iso times: helper and GET /api/themes/me/history checked');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
