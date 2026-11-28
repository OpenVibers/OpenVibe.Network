'use strict';
// The menu's AI plans (plan AD.39 item 9): GET /api/me/usage reads the person's coding agents' plan windows from
// OpenVibe.Codes with their own token and answers what is left and when it resets; Codes failing or slow is an empty
// list, never an error; one person's answer is kept for a minute; no token, no call.
const assert = require('assert');
const http = require('http');
const express = require('express');
const createUsageRoutes = require('../server/usage/routes');

(async () => {
    const seen = [];
    let answer = { status: 200, body: { agents: [
        { agent: 'claude-code', name: 'Claude Code', take: true, windows: [{ name: 'Week', used_pct: 16.4, resets_at: '2026-12-01T00:00:00Z' }, { name: '5 hours', used_pct: null }] },
        { agent: 'codex', name: 'Codex', windows: [] },
        { agent: 'cmd', name: 'Command Code', windows: [{ name: 'Week', used_pct: 120 }] },
    ], tasks: [{ title: 'secret task' }], settings: { enabled: true } } };
    const codes = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization });
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer.body));
    });
    await new Promise((r) => codes.listen(0, '127.0.0.1', r));
    let clock = 1_000_000;
    let user = 41;
    const requireAuth = (req, res, next) => { req.user = { id: user }; next(); };
    const app = express();
    app.use('/api/me/usage', createUsageRoutes(requireAuth, { codesUrl: `http://127.0.0.1:${codes.address().port}/`, now: () => clock }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const get = async (headers = { Authorization: 'Bearer person-token' }) => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/me/usage`, { headers });
        return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() };
    };
    try {
        const first = await get();
        assert.strictEqual(first.status, 200);
        assert.strictEqual(first.cache, 'private, no-store');
        assert.deepStrictEqual(first.body.agents, [
            { agent: 'claude-code', name: 'Claude Code', windows: [{ name: 'Week', left_pct: 84, resets_at: '2026-12-01T00:00:00Z' }] },
            { agent: 'cmd', name: 'Command Code', windows: [{ name: 'Week', left_pct: 0, resets_at: null }] },
        ], 'only known windows, left as a share, no tasks or settings');
        assert.strictEqual(first.body.more, 'https://openvibe.codes/settings/spare');
        assert.deepStrictEqual(seen, [{ url: '/api/v1/me/spare', auth: 'Bearer person-token' }], 'Codes is asked with the person\'s own token');
        console.log('  ✓ the person\'s plan windows, shaped for the menu, read with their token');

        await get();
        assert.strictEqual(seen.length, 1, 'kept a minute');
        clock += 61_000;
        answer = { status: 503, body: { title: 'down' } };
        assert.deepStrictEqual((await get()).body.agents, [], 'Codes down: an empty list');
        assert.strictEqual(seen.length, 2);
        user = 42;
        answer = { status: 200, body: { nonsense: true } };
        assert.deepStrictEqual((await get()).body.agents, [], 'not a list: an empty list');
        console.log('  ✓ kept a minute per person; Codes failing or answering nonsense is an empty list');

        user = 43;
        assert.deepStrictEqual((await get({})).body.agents, []);
        assert.strictEqual(seen.length, 3, 'no token, no call');
        console.log('  ✓ no token, no call to Codes');
    } finally {
        server.close(); codes.close();
    }
    console.log('menu-usage: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
