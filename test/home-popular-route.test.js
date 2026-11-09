'use strict';

// The front door's popularity endpoint and the person's Try next, mounted in the real app. Report is a stub on a
// loopback port: its public answer is passed through, the person's own history says what they already use, and the
// co-usage pair suggests a site they do not. Signed out, Try next is a 401; the public list is aggregate only.
//   node --import ./test/helpers/pg-preload.mjs test/home-popular-route.test.js
const assert = require('assert');
const http = require('http');
const { bootServer } = require('./helpers/boot-server');
const { signToken } = require('../server/auth/routes');

(async () => {
    const popular = {
        source: 'report', generated_at: '2026-11-09T12:00:00.000Z',
        items: [
            { id: 'live', kind: 'site', name: 'OpenVibe.Live', url: 'https://openvibe.live/', icon: 'live', reason: 'Most used today', opens_24h: 120, opens_7d: 900, growth_7d_pct: 12, uses_7d: 30 },
            { id: 'yt', kind: 'tool', name: 'YouTube downloader', url: 'https://yt.openvibe.tools/', icon: 'yt', reason: 'Rising this week', opens_24h: 30, opens_7d: 200, growth_7d_pct: 40 },
        ],
    };
    const co = { source: 'report', generated_at: '2026-11-09T12:00:00.000Z', sample_people: 8, min_people: 3, pairs: [{ a: 'live', b: 'chat', people: 7 }, { a: 'live', b: 'tools', people: 5 }] };
    let asked = 0;
    const report = http.createServer((req, res) => {
        asked++;
        res.setHeader('content-type', 'application/json');
        if (req.url.startsWith('/api/v1/popular/co-usage')) return res.end(JSON.stringify(co));
        if (req.url.startsWith('/api/v1/popular')) return res.end(JSON.stringify(popular));
        res.statusCode = 404; return res.end('{}');
    });
    await new Promise((r) => report.listen(0, '127.0.0.1', r));
    const srv = await bootServer({ env: { OV_REPORT_INTERNAL_URL: `http://127.0.0.1:${report.address().port}` } });
    try {
        const db = srv.app.locals.db;
        const config = srv.app.locals.config;
        await db.prepare("INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (94, 'tries', 'tries@example.test', 'x', 1)").run();
        const user = await db.prepare('SELECT * FROM users WHERE id = 94').get();
        const token = signToken(user, srv.app.locals.privateKey, config);
        const history = db.prepare('INSERT INTO user_history (user_id, service, sub, type, title, url) VALUES (?, ?, ?, ?, ?, ?)');
        await history.run(94, 'live', null, 'stream', 'A stream', 'https://openvibe.live/@alice');
        await history.run(94, 'live', null, 'stream', 'Another stream', 'https://openvibe.live/@bob');
        await history.run(94, 'tools', 'yt', 'tool', 'YouTube downloader', 'https://yt.openvibe.tools/');
        await history.run(94, 'games', null, 'game', 'A game', 'https://openvibe.games/');

        // The boot warm-up reads Report before the first reader; give it a moment if this process was slow to listen.
        let pub;
        for (let i = 0; i < 30; i++) {
            pub = await fetch(`${srv.base}/api/v1/home/popular`);
            const body = await pub.clone().json();
            if (body.source === 'report') break;
            await new Promise((r) => setTimeout(r, 50));
        }
        const pubBody = await pub.json();
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.headers.get('cache-control'), 'public, max-age=300');
        assert.strictEqual(pub.headers.get('access-control-allow-origin'), '*');
        assert.strictEqual(pubBody.source, 'report', 'Report answered, so the list is Report\'s');
        assert.strictEqual(pubBody.items[0].id, 'live');
        assert.strictEqual(pubBody.items[0].reason, 'Most used today');
        assert.ok(pubBody.items.every((i) => i.url.startsWith('https://') && i.icon && i.kind), 'every item is a destination');

        const anon = await fetch(`${srv.base}/api/v1/me/try-next`);
        assert.strictEqual(anon.status, 401, 'Try next is the person\'s own');

        const mine = await fetch(`${srv.base}/api/v1/me/try-next?limit=3`, { headers: { authorization: `Bearer ${token}` } });
        const body = await mine.json();
        assert.strictEqual(mine.status, 200);
        assert.strictEqual(mine.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual(body.source, 'report');
        assert.strictEqual(body.basis, 'co-usage');
        assert.deepStrictEqual(body.items.map((i) => i.id), ['chat'], 'a site they do not use, through the sites they do');
        assert.strictEqual(body.items[0].reason, 'People who use OpenVibe.Live also use this');
        assert.ok(!JSON.stringify(body).includes('tries'), 'nothing about the person leaves the answer');
        assert.ok(!body.items.some((i) => ['live', 'tools', 'games'].includes(i.id)), 'nothing they already use');
        assert.ok(asked >= 2, 'the app read Report (popular and co-usage)');
    } finally {
        await srv.stop();
        report.close();
        console.log('home-popular-route: the public list and the person\'s Try next answer from Report ok');
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
