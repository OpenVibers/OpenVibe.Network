'use strict';
// Label preferences (L1, 2026-10-31; contracts 0.257.0 network.label-prefs@1): show, blur or hide for each of the six
// labels, one setting per person that follows the account across every site. Only the person reads or writes their
// own; an unset label is show; the choice shares `user_preferences.site_prefs` with the site switcher without either
// route dropping the other's keys.
//   node test/label-prefs.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');

const LABELS = ['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers'];
const SHOW = Object.fromEntries(LABELS.map((l) => [l, 'show']));

(async () => {
    const db = getDb();
    const log = console.log; console.log = () => {};
    await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'ann', 'x', 'user'), (2, 'bob', 'x', 'user')").run();
    console.log = log;

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    const { signToken } = require('../server/auth/routes');
    const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
    const labels = require('../server/labels');
    const themes = require('../server/themes/routes');

    const app = express();
    app.use(express.json());
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/api/v1/me/label-prefs', labels.router({ labelPrefs: labels.createLabelPrefs({ db }), requireAuth }));
    app.use('/api/themes', themes);
    const server = http.createServer(app);
    const token = async (id) => signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);

    try {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = async (method, p, { body, as } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${await token(as)}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
            .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

        // Only the person's own: no session, no prefs.
        assert.strictEqual((await call('GET', '/api/v1/me/label-prefs')).status, 401, 'label prefs need a session');
        assert.strictEqual((await call('PUT', '/api/v1/me/label-prefs', { body: { prefs: SHOW } })).status, 401, 'and a session writes them');

        // The web default is show for every label; a person who never chose is not asked to.
        let r = await call('GET', '/api/v1/me/label-prefs', { as: 1 });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.prefs, SHOW, 'an unset label is show');

        // The person sets a mix; it reads back for them and never for anyone else.
        const mixed = { ...SHOW, nudity: 'hide', graphic: 'blur', '18+': 'hide', spoilers: 'blur' };
        r = await call('PUT', '/api/v1/me/label-prefs', { as: 1, body: { prefs: mixed } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.prefs, mixed, 'the PUT answers the stored choices');
        assert.deepStrictEqual((await call('GET', '/api/v1/me/label-prefs', { as: 1 })).body.prefs, mixed, 'the choice follows the person');
        assert.deepStrictEqual((await call('GET', '/api/v1/me/label-prefs', { as: 2 })).body.prefs, SHOW, "another person's prefs are their own");
        assert.strictEqual((await call('GET', '/api/v1/me/label-prefs', { as: 2 })).body.prefs.nudity, 'show', 'the default is not copied from anyone');

        // A contract's shape is enforced: six labels, three choices, no invented ones.
        for (const [body, why] of [
            [{ prefs: { ...SHOW, nudity: 'sometimes' } }, 'an unknown choice'],
            [{ prefs: { ...SHOW, gore: 'hide' } }, 'an unknown label'],
            [{ prefs: Object.fromEntries(LABELS.slice(1).map((l) => [l, 'show'])) }, 'a missing label'],
            [{ prefs: null }, 'no prefs object'],
        ]) {
            const bad = await call('PUT', '/api/v1/me/label-prefs', { as: 1, body });
            assert.strictEqual(bad.status, 422, `${why} is refused`);
            assert.strictEqual(bad.body.code, 'label-prefs.invalid', `${why} says why`);
        }
        assert.deepStrictEqual((await call('GET', '/api/v1/me/label-prefs', { as: 1 })).body.prefs, mixed, 'a refused write changed nothing');

        // One row, two features: the site switcher and the label choices keep each other's keys.
        r = await call('PUT', '/api/themes/me/sites', { as: 1, body: { pinned: ['live', 'tools'] } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual((await call('GET', '/api/v1/me/label-prefs', { as: 1 })).body.prefs, mixed, 'pinning a site keeps the label choices');
        await call('PUT', '/api/v1/me/label-prefs', { as: 1, body: { prefs: { ...SHOW, language: 'blur' } } });
        r = await call('GET', '/api/themes/me/sites', { as: 1 });
        assert.deepStrictEqual(r.body.pinned, ['live', 'tools'], 'saving label choices keeps the pinned sites');
        const row = await db.prepare('SELECT site_prefs FROM user_preferences WHERE user_id = 1').get();
        const stored = JSON.parse(row.site_prefs);
        assert.deepStrictEqual(Object.keys(stored).sort(), ['labels', 'pinned', 'recent'], 'site_prefs holds the switcher and the labels');
        assert.strictEqual(stored.labels.language, 'blur', 'the label choices are in the existing site prefs (migration 0029)');

        // The list itself: six labels and three choices, the same as common.content-labels@1 and the plan.
        assert.deepStrictEqual(labels.LABELS, LABELS);
        assert.deepStrictEqual(labels.CHOICES, ['show', 'blur', 'hide']);
        assert.deepStrictEqual(labels.INFO.map((x) => x.id), LABELS);
        assert.deepStrictEqual(labels.defaults(), SHOW);
        assert.strictEqual(labels.parsePrefs({ prefs: SHOW }).ok, true);
    } finally {
        await new Promise((r) => server.close(r));
    }
    console.log('label prefs: six labels, show/blur/hide, only your own, stored in site_prefs');
})().catch((err) => { console.error(err); process.exit(1); });
