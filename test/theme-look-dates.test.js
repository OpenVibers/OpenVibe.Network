'use strict';
// One look everywhere (plan L42, openvibe-shared 4.64.0): the account's copy of a person's look is dated, and the
// newest wins. A write older than the account's copy (a stale tab, a slow request) is refused and answered with the
// newer copy; /me/active hands out both dates so a site can tell its own copy is out of date.
//   node --import ./test/helpers/pg-preload.mjs test/theme-look-dates.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (61, 'priya', 'x', 'user') ON CONFLICT DO NOTHING").run();
    for (const [id, name] of [['vibe', 'Vibe'], ['nord', 'Nord'], ['ember', 'Ember']]) {
        await db.prepare("INSERT INTO themes (id, name, slug, mode, variables, is_builtin, is_public, review_status) VALUES (?, ?, ?, 'dark', '{}', 1, 1, 'approved') ON CONFLICT DO NOTHING").run(id, name, id);
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
    const bearer = `Bearer ${await signToken(await db.prepare('SELECT * FROM users WHERE id = 61').get(), keys.privateKey, config)}`;
    const call = (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: bearer }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    const now = Date.now();

    // ── Before any dated choice, nothing is dated ──
    let r = await call('GET', '/api/themes/me/active');
    assert.ok(!('display_at' in r.body) && !('theme_at' in r.body), 'no dates before a dated choice');

    // ── Display settings: the browser's date is kept and handed out ──
    r = await call('PUT', '/api/themes/me/display', { seasonal: 'off', motion: 'reduced', at: now - 1000 });
    assert.deepStrictEqual([r.status, r.body.display.seasonal, r.body.display_at], [200, 'off', now - 1000]);
    r = await call('GET', '/api/themes/me/active');
    assert.deepStrictEqual([r.body.display.seasonal, r.body.display_at], ['off', now - 1000], 'the account says when');

    // A stale tab still showing "on" writes later with its older date: the newer "off" stays, and the answer carries it.
    r = await call('PUT', '/api/themes/me/display', { seasonal: 'on', at: now - 60000 });
    assert.deepStrictEqual([r.status, r.body.stale, r.body.display.seasonal, r.body.display_at], [200, true, 'off', now - 1000], 'an older write is refused');
    r = await call('GET', '/api/themes/me/active');
    assert.strictEqual(r.body.display.seasonal, 'off', 'seasonal stays off');

    // A newer one wins; an undated one (an older release) counts as now; one far in the future counts as now.
    r = await call('PUT', '/api/themes/me/display', { seasonal: 'on', at: now });
    assert.deepStrictEqual([r.body.stale, r.body.display.seasonal], [undefined, 'on']);
    r = await call('PUT', '/api/themes/me/display', { seasonal: 'off' });
    assert.ok(!r.body.stale && r.body.display_at >= now, 'undated: now');
    r = await call('PUT', '/api/themes/me/display', { seasonal: 'on', at: 'soon' });
    assert.ok(!r.body.stale && r.body.display_at >= now, 'nonsense dates count as now');
    r = await call('PUT', '/api/themes/me/display', { seasonal: 'off', at: now + 86400000 * 365 });
    assert.ok(r.body.display_at <= Date.now() + 60000, 'a date from a wrong clock cannot lock the account for a year');

    // ── The theme: dated by the server unless the browser says when ──
    r = await call('PUT', '/api/themes/me', { theme_id: 'nord' });
    const nordAt = r.body.theme_at;
    assert.ok(r.body.success && nordAt >= now, 'dated');
    r = await call('GET', '/api/themes/me/active');
    assert.deepStrictEqual([r.body.theme_id, r.body.theme_at], ['nord', nordAt]);
    r = await call('PUT', '/api/themes/me', { theme_id: 'ember', at: nordAt - 5000 });
    assert.deepStrictEqual([r.body.stale, r.body.theme_id], [true, 'nord'], 'an older theme choice is refused');
    const history = await db.prepare('SELECT COUNT(*) AS n FROM user_theme_history WHERE user_id = 61').get().catch(() => ({ n: null }));
    r = await call('PUT', '/api/themes/me', { theme_id: 'ember' });
    assert.deepStrictEqual([r.body.stale, r.body.theme_id], [undefined, 'ember']);
    if (history.n != null) {
        const after = await db.prepare('SELECT COUNT(*) AS n FROM user_theme_history WHERE user_id = 61').get();
        assert.strictEqual(Number(after.n), Number(history.n) + 1, 'only the accepted change is kept in the history');
    }

    server.close();
    console.log('theme look dates: dated copies, an older write refused with the newer copy, wrong clocks clamped');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
