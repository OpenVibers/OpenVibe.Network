'use strict';
// GET /api/frame/suggest: the navbar's magnifier asks OpenVibe.Search through Network, because every site's
// connect-src lets the navbar reach openvibe.network and most refuse search.openvibe.network (2026-10-28).
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

(async () => {
    const asked = [];
    let down = false;
    const search = http.createServer((req, res) => {
        asked.push({ url: req.url, xff: req.headers['x-forwarded-for'] });
        if (down) { res.statusCode = 503; return res.end('{}'); }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ suggestions: [{ owner: 'live', type: 'channel', id: '1', title: 'JapaneseOldGuy', canonical_url: 'https://openvibe.live/@JapaneseOldGuy' }] }));
    });
    await new Promise((r) => search.listen(0, '127.0.0.1', r));
    const svc = await createFrameService(getDb(), { services: { search: { internalUrl: `http://127.0.0.1:${search.address().port}` } } }, null);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame/suggest`;
    const get = async (qs, headers) => { const r = await fetch(`${base}${qs}`, { headers }); return { r, d: await r.json() }; };

    let { r, d } = await get('?q=japan&owner=live&limit=5', { 'X-Forwarded-For': '203.0.113.9' });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'any site may ask');
    assert.deepStrictEqual(d.suggestions.map((s) => s.title), ['JapaneseOldGuy']);
    const first = new URL(asked[0].url, 'http://x');
    assert.deepStrictEqual([first.pathname, first.searchParams.get('q'), first.searchParams.get('owner'), first.searchParams.get('limit')], ['/api/v1/suggest', 'japan', 'live', '5']);
    assert.strictEqual(asked[0].xff, '203.0.113.9', "the person's address goes along (Search's limit is per person)");

    ({ d } = await get('?q=Japan&owner=live&limit=5'));
    assert.strictEqual(asked.length, 1, 'the same question within 30 s is answered from memory');
    assert.strictEqual(d.suggestions.length, 1);

    ({ d } = await get('?q=&owner=live'));
    assert.deepStrictEqual(d, { suggestions: [] }, 'nothing typed: nothing asked');
    ({ d } = await get('?q=x&owner=../admin&limit=999'));
    const odd = new URL(asked[asked.length - 1].url, 'http://x');
    assert.ok(!odd.searchParams.has('owner') && odd.searchParams.get('limit') === '20', 'an odd owner is dropped and the limit capped');

    down = true;
    ({ r, d } = await get('?q=down'));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(d, { suggestions: [] }, 'Search not answering is an empty list');

    server.close(); search.close();
    console.log('frame suggest: Search through Network for the navbar, per person, kept 30 s ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
