'use strict';
// GET /api/frame/code/search: the composer's GitHub tool reads Exchange's public code search through the Frame.
const assert = require('assert');
const express = require('express');
const { createFrameCodeSearch } = require('../server/frame/code-search');

(async () => {
    const asked = [];
    let down = false;
    const exchange = async (url) => {
        asked.push(url);
        if (down) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ items: [
            { full_name: 'ada/goal-bar', url: 'https://github.com/ada/goal-bar', description: '  A goal bar\n for streams ', language: 'JavaScript', stars: 42, license: 'MIT', owner_avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', pushed: '2026-11-10T10:00:00Z', homepage: 'https://x.example' },
            { full_name: 'evil/x', url: 'javascript:alert(1)' },
            { full_name: 'not a name', url: 'https://github.com/a/b' },
            { full_name: 'bo/tracker', url: 'https://github.com/bo/tracker', owner_avatar_url: 'https://evil.example/p.png', stars: 'many' },
        ] }) };
    };
    let t = 1000;
    const cs = createFrameCodeSearch({ exchangeUrl: 'http://exchange.local/', fetchImpl: exchange, now: () => t });
    const app = express();
    app.get('/api/frame/code/search', (req, res) => cs.handle(req, res));
    const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/frame/code/search`;
    try {
        let r = await fetch(`${base}?q=goal%20bar&limit=50`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'every site may read it');
        const body = await r.json();
        assert.deepStrictEqual(body.items, [
            { full_name: 'ada/goal-bar', url: 'https://github.com/ada/goal-bar', description: 'A goal bar for streams', language: 'JavaScript', stars: 42, license: 'MIT', owner_avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', pushed: '2026-11-10T10:00:00.000Z' },
            { full_name: 'bo/tracker', url: 'https://github.com/bo/tracker' },
        ], 'only what a card needs; a script address, a bad name and a picture from elsewhere are left out');
        assert.strictEqual(asked[0], 'http://exchange.local/api/v1/code/search?q=goal%20bar&limit=10', 'at most ten');
        await fetch(`${base}?q=Goal%20Bar&limit=50`);
        assert.strictEqual(asked.length, 1, 'the same query within a minute is answered from the cache');
        t += 61000;
        await fetch(`${base}?q=goal%20bar&limit=50`);
        assert.strictEqual(asked.length, 2, 'and asked again after it');
        r = await fetch(`${base}?q=a`);
        assert.deepStrictEqual(await r.json(), { items: [] }, 'one letter asks nothing');
        assert.strictEqual(asked.length, 2);
        down = true;
        r = await fetch(`${base}?q=something%20else`);
        assert.strictEqual(r.status, 502);
        assert.strictEqual((await r.json()).code, 'code.unavailable');
        console.log('frame code search: through the Frame, only what a card needs, cached a minute, says when Exchange is down');
    } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
