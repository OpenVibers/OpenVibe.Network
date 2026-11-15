'use strict';
// GET /api/frame/trending and POST /api/frame/searched (plan 2026-11-13 §AD.13 (1)): every site's search box shows what
// is trending (openvibe-shared ov-trending.js) and counts its searches, through Network for the same connect-src reason
// as /suggest. The list is kept 60 s; the beacon goes on with the browser's Origin, address, user agent, DNT and GPC,
// and is always 204, Search answering or not.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

(async () => {
    const asked = [];
    let down = false;
    const search = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            asked.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
            if (down) { res.statusCode = 503; return res.end('{}'); }
            if (req.method === 'POST') { res.statusCode = 204; return res.end(); }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ site: 'openvibe.exchange', trending: [{ query: 'synthesizers', searches: 12, rising: true }, { query: 'go live', searches: 7, rising: false }] }));
        });
    });
    await new Promise((r) => search.listen(0, '127.0.0.1', r));
    const svc = await createFrameService(getDb(), { services: { search: { internalUrl: `http://127.0.0.1:${search.address().port}` } } }, null);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame`;

    let r = await fetch(`${base}/trending?site=openvibe.exchange&limit=5`);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'any site may ask');
    assert.deepStrictEqual((await r.json()).trending.map((x) => x.query), ['synthesizers', 'go live']);
    const first = new URL(asked[0].url, 'http://x');
    assert.deepStrictEqual([first.pathname, first.searchParams.get('site'), first.searchParams.get('limit')], ['/api/v1/trending', 'openvibe.exchange', '5']);
    await fetch(`${base}/trending?site=openvibe.exchange&limit=5`);
    assert.strictEqual(asked.length, 1, 'kept 60 s');
    await fetch(`${base}/trending?site=../../etc&limit=999`);
    const odd = new URL(asked[asked.length - 1].url, 'http://x');
    assert.ok(!odd.searchParams.has('site') && odd.searchParams.get('limit') === '20', 'an odd site is dropped and the limit capped');

    // The beacon, as navigator.sendBeacon sends it (text/plain JSON).
    r = await fetch(`${base}/searched`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://openvibe.exchange', 'User-Agent': 'Phone', 'X-Forwarded-For': '203.0.113.9', 'Sec-GPC': '1' }, body: JSON.stringify({ q: 'synthesizers', site: 'openvibe.exchange' }) });
    assert.strictEqual(r.status, 204);
    for (let i = 0; i < 20 && !asked.some((a) => a.method === 'POST'); i++) await new Promise((ok) => setTimeout(ok, 25));
    const sent = asked.find((a) => a.method === 'POST');
    assert.deepStrictEqual([sent.url, sent.body.q, sent.body.site, sent.headers.origin, sent.headers['user-agent'], sent.headers['x-forwarded-for'], sent.headers['sec-gpc']],
        ['/api/v1/searched', 'synthesizers', 'openvibe.exchange', 'https://openvibe.exchange', 'Phone', '203.0.113.9', '1'], 'the browser\'s Origin, address, agent and GPC go along');
    r = await fetch(`${base}/searched`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'not json' });
    assert.strictEqual(r.status, 204, 'nonsense is 204 too');

    down = true;
    r = await fetch(`${base}/trending?site=openvibe.live`);
    assert.deepStrictEqual((await r.json()).trending, [], 'Search not answering is an empty list');

    server.close(); search.close();
    console.log('frame trending: the list through Network (kept 60 s), the beacon on with Origin, address, agent and GPC ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
