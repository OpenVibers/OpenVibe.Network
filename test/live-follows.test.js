'use strict';
// Your account home's "Now" (plan L43): the people you follow who are live, from Live's public list held ten seconds.
// Only your own follows, only who is live, Live's secrets never pass, and a Live that does not answer means nobody.
//   node --import ./test/helpers/pg-preload.mjs test/live-follows.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const liveFollows = require('../server/today/live-follows');

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    const PEOPLE = [[71, 'wren'], [72, 'Goosely'], [73, 'maticus'], [74, 'quietone']];
    for (const [id, name] of PEOPLE) await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user') ON CONFLICT DO NOTHING").run(id, name);
    const S = {};
    for (const [id, name] of PEOPLE) S[name] = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    // wren follows Goosely (live), maticus (live) and quietone (not live); one follow ended.
    for (const [who, whom, active] of [['wren', 'Goosely', 1], ['wren', 'maticus', 1], ['wren', 'quietone', 1], ['quietone', 'maticus', 0]]) {
        await db.prepare("INSERT INTO user_follows (follower_subject, target_type, target_id, active) VALUES (?, 'channel', ?, ?) ON CONFLICT DO NOTHING").run(S[who], S[whom], active);
    }

    let asked = 0; let answer = null;
    const fetchImpl = async (url) => {
        asked++;
        assert.strictEqual(url, 'http://live.internal/api/streams', 'Live\'s internal address');
        if (!answer) throw new Error('down');
        return { ok: true, json: async () => answer };
    };
    answer = { streams: [
        { username: 'goosely', display_name: 'Goosely', title: 'Geese at dawn', ai_title: '', viewer_count: 3, total_viewer_count: 9, thumbnail_url: '/thumbs/g.jpg', avatar_url: 'https://openvibe.media/a/g.png', started_at: '2026-10-31T18:00:00Z', stream_key: 'sk_secret', managed_stream_key: 'mk_secret' },
        { username: 'maticus', display_name: 'Maticus', title: 'LOOI', viewer_count: 12, thumbnail_url: 'javascript:alert(1)', avatar_url: 'http://insecure.example/a.png' },
        { username: 'maticus', display_name: 'Maticus', title: 'LOOI, second slot', viewer_count: 2 },
        { username: 'stranger', display_name: 'Stranger', title: 'Not followed', viewer_count: 40 },
    ] };

    // The session itself is Network's requireAuth (tested on its own); here a request names its person.
    const requireAuth = (req, res, next) => { const id = Number(String(req.headers.authorization || '').replace(/^User /, '')); if (!id) return res.status(401).json({ error: 'sign in' }); req.user = { id }; next(); };
    const app = express();
    app.locals.db = db;
    app.use('/api/v1/me/live-follows', liveFollows.router({ requireAuth, liveUrl: 'http://live.internal', fetchImpl }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (as) => fetch(`${base}/api/v1/me/live-follows`, { headers: as ? { authorization: `User ${as}` } : {} })
        .then(async (r) => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) }));

    assert.strictEqual((await get()).status, 401, 'a person\'s own');

    let r = await get(71);
    assert.strictEqual(r.cache, 'private, no-store');
    assert.deepStrictEqual(r.body.live.map((x) => x.username), ['goosely', 'maticus'], 'the people wren follows who are live, once each, in Live\'s order');
    assert.deepStrictEqual([r.body.following, r.body.anyone_live], [3, 3]);
    const g = r.body.live[0];
    assert.deepStrictEqual([g.name, g.title, g.viewers, g.thumbnail, g.avatar, g.url], ['Goosely', 'Geese at dawn', 9, 'https://openvibe.live/thumbs/g.jpg', 'https://openvibe.media/a/g.png', 'https://openvibe.live/@goosely']);
    assert.ok(!JSON.stringify(r.body).includes('secret'), 'no ingest key passes');
    const m = r.body.live[1];
    assert.deepStrictEqual([m.thumbnail, m.avatar], [null, null], 'only https pictures, and Live\'s own paths');

    r = await get(73);
    assert.deepStrictEqual([r.body.live, r.body.following], [[], 0], 'nobody followed: nobody live');
    r = await get(74);
    assert.deepStrictEqual(r.body.live, [], 'an ended follow does not count');
    assert.strictEqual(asked, 1, 'Live was asked once for all of them');

    // Live away: nobody is live, and the page still answers.
    liveFollows.forget(); answer = null;
    r = await get(71);
    assert.deepStrictEqual([r.status, r.body.live, r.body.anyone_live], [200, [], 0]);

    server.close();
    console.log('live follows: your follows who are live, once each, no secrets, Live asked once per 10 s, Live away means nobody');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
