'use strict';
// Theme history and rollback (plan 2026-10-28 §5.2, the Design studio): every change through PUT /api/themes/me keeps
// the setting it replaced, a person reads only their own, a restore brings one back (and is itself undoable), the
// last 50 are kept, and an unchanged save adds nothing.
//   node --import ./test/helpers/pg-preload.mjs test/theme-history.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (31, 'hana', 'x', 'user'), (32, 'ivo', 'x', 'user') ON CONFLICT DO NOTHING").run();
    for (const [id, name] of [['vibe', 'Vibe'], ['cloud', 'Cloud'], ['ember', 'Ember']]) {
        await db.prepare("INSERT INTO themes (id, name, slug, mode, variables, is_builtin, is_public) VALUES (?, ?, ?, 'dark', '{}', 1, 1) ON CONFLICT DO NOTHING").run(id, name, id);
    }
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    const { signToken } = require('../server/auth/routes');
    const app = express();
    app.use(express.json());
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/api/themes', require('../server/themes/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = async (id) => signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);
    const call = async (method, p, { body, as } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${await token(as)}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    assert.strictEqual((await call('GET', '/api/themes/me/history')).status, 401, 'history is a person\'s own');
    // First choice: nothing to keep yet.
    await call('PUT', '/api/themes/me', { as: 31, body: { theme_id: 'vibe' } });
    assert.deepStrictEqual((await call('GET', '/api/themes/me/history', { as: 31 })).body.history, [], 'the first setting replaces nothing');
    await call('PUT', '/api/themes/me', { as: 31, body: { theme_id: 'cloud', source: 'studio' } });
    await call('PUT', '/api/themes/me', { as: 31, body: { theme_id: 'ember', custom_variables: { '--accent': '#ff6a3d' } } });
    let h = (await call('GET', '/api/themes/me/history', { as: 31 })).body.history;
    assert.deepStrictEqual(h.map((x) => x.theme_id), ['cloud', 'vibe'], 'newest first');
    assert.ok(h.every((x) => typeof x.theme_name === 'string' && x.theme_name), 'each with its theme\'s name');
    assert.strictEqual(h[1].source, 'studio', 'the change that replaced Vibe came from the studio');
    // The same setting saved again keeps nothing new.
    await call('PUT', '/api/themes/me', { as: 31, body: { theme_id: 'ember', custom_variables: { '--accent': '#ff6a3d' } } });
    assert.strictEqual((await call('GET', '/api/themes/me/history', { as: 31 })).body.history.length, 2, 'saving the same setting again keeps nothing');
    // Restore Vibe: the current one is kept, so the restore can be undone.
    const vibeEntry = (await call('GET', '/api/themes/me/history', { as: 31 })).body.history.find((x) => x.theme_id === 'vibe');
    const r = await call('POST', `/api/themes/me/history/${vibeEntry.id}/restore`, { as: 31 });
    assert.deepStrictEqual([r.status, r.body.theme_id], [200, 'vibe']);
    const pref = await db.prepare('SELECT theme_id, custom_theme_variables FROM user_preferences WHERE user_id = 31').get();
    assert.deepStrictEqual([pref.theme_id, pref.custom_theme_variables], ['vibe', null], 'Vibe is the active theme again, without the custom accent');
    h = (await call('GET', '/api/themes/me/history', { as: 31 })).body.history;
    assert.strictEqual(h[0].theme_id, 'ember', 'what the restore replaced is first in the history');
    assert.deepStrictEqual(h[0].custom_variables, { '--accent': '#ff6a3d' });
    assert.strictEqual(h[0].source, 'restore');
    // Someone else's history is not reachable.
    assert.strictEqual((await call('POST', `/api/themes/me/history/${vibeEntry.id}/restore`, { as: 32 })).status, 404);
    assert.strictEqual((await call('POST', '/api/themes/me/history/zero/restore', { as: 31 })).status, 400);
    // The last 50 are kept.
    for (let i = 0; i < 60; i++) await call('PUT', '/api/themes/me', { as: 32, body: { theme_id: i % 2 ? 'cloud' : 'vibe' } });
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM user_theme_history WHERE user_id = 32').get()).n, 50);

    server.close();
    console.log('theme history: kept, private, restorable, capped ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
