'use strict';
// The Feed's view counts and the account's Feed preview choice.
//   - attachCounts puts Media's counts.views/counts.engaged on a Feed card that names its source, keeps the
//     card's own likes/comments, and leaves a card without a source (or a Media outage) as it was;
//   - feed_previews is on | wifi | off, default on, stored with the account and readable from GET /api/auth/me
//     and GET /api/themes/me/active (the shared menu reads it there).
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (71, 'nadia', 'x', 'user'), (72, 'omar', 'x', 'user') ON CONFLICT DO NOTHING").run();

    // ── Feed counts ─────────────────────────────────────────────
    let asked = 0;
    const media = http.createServer((req, res) => {
        asked += 1;
        const refs = JSON.parse(new URL(req.url, 'http://x').searchParams.get('refs'));
        const counts = {};
        for (const r of refs) counts[`${r.service}:${r.kind}:${r.id}`] = { views: 7, engaged: 3, previews: 2, preview_share: 0.286, peak_concurrent: null };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ counts }));
    });
    await new Promise((r) => media.listen(0, '127.0.0.1', r));
    const config = require('../server/config');
    config.services.media = { internalUrl: `http://127.0.0.1:${media.address().port}` };
    const { attachCounts } = require('../server/views/counts');
    const items = [
        { id: 'p:1', counts: { likes: 5 }, source: { service: 'media', type: 'vod', id: '12' } },
        { id: 'p:2', ref: { service: 'live', kind: 'stream', id: '9' } },
        { id: 'p:3', counts: { views: 1 } },
    ];
    await attachCounts(items);
    assert.strictEqual(asked, 1, 'one batched read');
    assert.deepStrictEqual(items[0].counts, { likes: 5, views: 7, engaged: 3 }, 'the source wins on views and keeps likes');
    assert.deepStrictEqual(items[1].counts, { views: 7, engaged: 3 }, 'a client ref works too');
    assert.deepStrictEqual(items[2].counts, { views: 1 }, 'a card without a source is untouched');
    await new Promise((r) => media.close(r));

    // A Media outage leaves the cards as they were; the cache must not hide the failure for a new batch.
    require('../server/views/counts')._cache.clear();
    const outage = [ { source: { service: 'media', type: 'clip', id: '77' }, counts: { views: 2 } } ];
    await attachCounts(outage);
    assert.deepStrictEqual(outage[0].counts, { views: 2 });

    // ── The account's feed_previews choice ─────────────────────
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const cfg = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    const { signToken } = require('../server/auth/routes');
    const app = express();
    app.use(express.json());
    Object.assign(app.locals, { db, config: cfg, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/api/auth', require('../server/auth/routes'));
    app.use('/api/themes', require('../server/themes/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = async (id) => signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, cfg);
    const call = async (method, p, { body, as } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${await token(as)}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    let r = await call('GET', '/api/auth/me', { as: 71 });
    assert.strictEqual(r.body.preferences.feed_previews, 'on', 'the default is on');
    r = await call('PUT', '/api/auth/me/preferences', { as: 71, body: { feed_previews: 'off' } });
    assert.deepStrictEqual([r.status, r.body.feed_previews], [200, 'off']);
    r = await call('GET', '/api/auth/me', { as: 71 });
    assert.strictEqual(r.body.preferences.feed_previews, 'off', 'the menu reads it from /api/auth/me');
    r = await call('GET', '/api/themes/me/active', { as: 71 });
    assert.strictEqual(r.body.feed_previews, 'off', 'the theme answer carries it too');
    r = await call('PUT', '/api/auth/me/preferences', { as: 71, body: { feed_previews: 'sometimes' } });
    assert.strictEqual(r.status, 400, 'an unknown value is refused');
    r = await call('GET', '/api/auth/me', { as: 72 });
    assert.strictEqual(r.body.preferences.feed_previews, 'on', 'another account keeps its own default');
    assert.strictEqual((await call('PUT', '/api/auth/me/preferences', { body: { feed_previews: 'off' } })).status, 401, 'a signed-out write is refused');

    server.close();
    console.log('feed views + feed_previews: ok');
})().catch((error) => { console.error(error); process.exit(1); });
