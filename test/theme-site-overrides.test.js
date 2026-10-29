'use strict';
// Per-site theme overrides (the design overhaul, pillar A): one theme follows a person to every site, and an override
// is their exception for one service ("Games in Neon Tokyo", "Live in Daylight"). The routes answer per service, fall
// back to the global theme, keep the history, and travel with the account (ADR-033: the export and the deletion).
//   node --import ./test/helpers/pg-preload.mjs test/theme-site-overrides.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const accountData = require('../server/identity/account-data');

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (41, 'nadia', 'x', 'user'), (42, 'omar', 'x', 'user') ON CONFLICT DO NOTHING").run();
    for (const [id, name] of [['vibe', 'Vibe'], ['cloud', 'Cloud'], ['ember', 'Ember']]) {
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
    const token = async (id) => signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);
    const call = async (method, p, { body, as } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${await token(as)}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    // ── The person's own routes are theirs alone.
    assert.strictEqual((await call('GET', '/api/themes/me/overrides')).status, 401, 'the list is a person\'s own');
    assert.strictEqual((await call('PUT', '/api/themes/me/overrides/games', { body: { theme_id: 'ember' } })).status, 401, 'setting one is a person\'s own');
    assert.strictEqual((await call('DELETE', '/api/themes/me/overrides/games')).status, 401, 'removing one is a person\'s own');

    // ── The global theme, as it is today.
    await call('PUT', '/api/themes/me', { as: 41, body: { theme_id: 'cloud' } });
    let r = await call('GET', '/api/themes/me/active', { as: 41 });
    assert.deepStrictEqual([r.status, r.body.theme_id, r.body.override], [200, 'cloud', false], 'without a service the answer is the global theme');
    assert.ok(!('service' in r.body), 'no service is named when none was asked for');

    // ── One site asks for its own look; it gets the global theme until the person says otherwise.
    r = await call('GET', '/api/themes/me/active?service=games', { as: 41 });
    assert.deepStrictEqual([r.status, r.body.theme_id, r.body.override], [200, 'cloud', false], 'no override yet: the global theme');
    r = await call('GET', '/api/themes/me/active?service=live', { as: 42 });
    assert.deepStrictEqual([r.body.theme_id, r.body.override], ['vibe', false], 'another person has none either');

    // ── Set one.
    r = await call('PUT', '/api/themes/me/overrides/games', { as: 41, body: { theme_id: 'ember', custom_variables: { '--accent': '#ff6a3d' } } });
    assert.deepStrictEqual([r.status, r.body.service, r.body.theme_id, r.body.custom_variables], [200, 'games', 'ember', { '--accent': '#ff6a3d' }], 'the override is set');
    r = await call('GET', '/api/themes/me/active?service=games', { as: 41 });
    assert.deepStrictEqual([r.status, r.body.theme_id, r.body.override, r.body.service], [200, 'ember', true, 'games'], 'the site sees its own theme');
    assert.deepStrictEqual(r.body.custom_variables, { '--accent': '#ff6a3d' }, 'with the custom colours it was set with');
    r = await call('GET', '/api/themes/me/active', { as: 41 });
    assert.deepStrictEqual([r.body.theme_id, r.body.override], ['cloud', false], 'every other site keeps the global theme');
    r = await call('GET', '/api/themes/me/active?service=live', { as: 41 });
    assert.deepStrictEqual([r.body.theme_id, r.body.override], ['cloud', false], 'a service without an override keeps the global theme');
    r = await call('GET', '/api/themes/me/active?service=games', { as: 42 });
    assert.deepStrictEqual([r.body.theme_id, r.body.override], ['vibe', false], "another person's override is not reachable");

    // A missing or invalid service answers exactly as today.
    for (const q of ['', '?service=', '?service=Games', '?service=1', '?service=a']) {
        r = await call('GET', `/api/themes/me/active${q}`, { as: 41 });
        assert.deepStrictEqual([r.status, r.body.theme_id, r.body.override], [200, 'cloud', false], `service ${JSON.stringify(q)} is not a service id: the answer is as it was`);
    }

    // ── The list.
    r = await call('GET', '/api/themes/me/overrides', { as: 41 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.overrides.length, 1);
    assert.deepStrictEqual([r.body.overrides[0].service, r.body.overrides[0].theme_id, r.body.overrides[0].theme_name], ['games', 'ember', 'Ember'], 'the list names the service, the theme and its name');
    assert.deepStrictEqual(r.body.overrides[0].custom_variables, { '--accent': '#ff6a3d' });
    assert.deepStrictEqual((await call('GET', '/api/themes/me/overrides', { as: 42 })).body.overrides, [], "another person's list is empty");

    // ── Validation, as PUT /me does it.
    r = await call('PUT', '/api/themes/me/overrides/Games', { as: 41, body: { theme_id: 'ember' } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'theme.bad_service'], 'a service id is lower case');
    r = await call('PUT', '/api/themes/me/overrides/x', { as: 41, body: { theme_id: 'ember' } });
    assert.strictEqual(r.status, 400, 'a service id is at least two characters');
    r = await call('PUT', '/api/themes/me/overrides/games', { as: 41, body: { theme_id: 'no-such-theme' } });
    assert.deepStrictEqual([r.status, r.body.error], [404, 'Theme not found'], 'a theme that does not exist');
    r = await call('PUT', '/api/themes/me/overrides/games', { as: 41, body: { theme_id: 'ember', custom_variables: { '--not-a-token': '#fff' } } });
    assert.deepStrictEqual([r.status, r.body.code], [422, 'theme.invalid_variables'], 'the same custom-variable rule as PUT /me');
    r = await call('PUT', '/api/themes/me/overrides/games', { as: 41, body: { theme_id: 'ember', custom_variables: { '--accent': 'url(https://example.com/x)' } } });
    assert.strictEqual(r.status, 422, 'a value cannot fetch anything');
    r = await call('PUT', '/api/themes/me/overrides/games', { as: 41, body: {} });
    assert.strictEqual(r.status, 400, 'a theme is required');
    r = await call('DELETE', '/api/themes/me/overrides/live', { as: 41 });
    assert.deepStrictEqual([r.status, r.body.code], [404, 'theme.override_not_found'], 'there is no override to remove');

    // ── The history keeps what each change replaced, with the service recorded.
    let h = (await call('GET', '/api/themes/me/history', { as: 41 })).body.history;
    const forGames = h.filter((x) => x.source === 'games');
    assert.strictEqual(forGames.length, 1, 'the change is in the history');
    assert.strictEqual(forGames[0].theme_id, 'cloud', 'the global theme it replaced');
    await call('PUT', '/api/themes/me/overrides/games', { as: 41, body: { theme_id: 'cloud' } });
    h = (await call('GET', '/api/themes/me/history', { as: 41 })).body.history;
    assert.strictEqual(h.filter((x) => x.source === 'games').length, 2, 'a second change is kept too');
    assert.strictEqual(h.find((x) => x.source === 'games').theme_id, 'ember', 'the newest first: the theme it replaced');

    // ── Remove one: that site falls back to the global theme again.
    r = await call('DELETE', '/api/themes/me/overrides/games', { as: 41 });
    assert.deepStrictEqual([r.status, r.body.service, r.body.deleted], [200, 'games', true], 'the override is gone');
    r = await call('GET', '/api/themes/me/active?service=games', { as: 41 });
    assert.deepStrictEqual([r.body.theme_id, r.body.override], ['cloud', false], 'the global theme again');
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM user_theme_site_overrides WHERE user_id = 41').get()).n, 0, 'the row is gone');
    h = (await call('GET', '/api/themes/me/history', { as: 41 })).body.history;
    assert.ok(h.some((x) => x.source === 'games'), 'the removal is in the history too');

    // ── At most 50 per person.
    for (let i = 1; i <= 50; i++) {
        const res = await call('PUT', `/api/themes/me/overrides/s${i}`, { as: 42, body: { theme_id: 'vibe' } });
        assert.strictEqual(res.status, 200, `override ${i} is set`);
    }
    r = await call('PUT', '/api/themes/me/overrides/s51', { as: 42, body: { theme_id: 'vibe' } });
    assert.deepStrictEqual([r.status, r.body.code], [429, 'theme.too_many_overrides'], 'the 51st is refused');
    r = await call('PUT', '/api/themes/me/overrides/s1', { as: 42, body: { theme_id: 'cloud' } });
    assert.strictEqual(r.status, 200, 'changing one that is already there is not a new one');
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM user_theme_site_overrides WHERE user_id = 42').get()).n, 50);

    // ── ADR-033: the overrides travel with the account (the export) and go with it (the deletion).
    await accountData.ensureSchema(db);
    await call('PUT', '/api/themes/me/overrides/games', { as: 41, body: { theme_id: 'ember' } });
    const nadia = await db.prepare('SELECT * FROM users WHERE id = 41').get();
    await subjects.ensureUserSubject(db, nadia);
    const part = await accountData.networkPart(db, nadia.id);
    const prefs = part.files.find((f) => f.name === 'preferences.json').content;
    assert.strictEqual(prefs.theme_site_overrides.length, 1, 'the export holds the override');
    assert.deepStrictEqual([prefs.theme_site_overrides[0].service, prefs.theme_site_overrides[0].theme_id], ['games', 'ember']);

    const { ids } = require('openvibe-contracts');
    const deletionId = `del_${ids.ulid()}`;
    await db.prepare('INSERT INTO account_deletions (id, user_id, subject, requested_at, delete_after) VALUES (?, ?, ?, ?, ?)')
        .run(deletionId, nadia.id, nadia.subject_id, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());
    const deletion = await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(deletionId);
    const erased = await accountData.erase(db, deletion, { now: Date.now() });
    assert.strictEqual(erased.user_theme_site_overrides, 1, 'the deletion erases the override');
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM user_theme_site_overrides WHERE user_id = 41').get()).n, 0);

    server.close();
    console.log('theme site overrides: per service, private, capped, exported and erased ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
