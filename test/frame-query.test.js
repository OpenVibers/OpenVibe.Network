'use strict';
// GET /api/frame/query: the navbar's full results (Enter) ask OpenVibe.Search's fabric through Network, like /suggest.
// With a person's token Search answers as them and nothing is kept; without, the answer is kept 60 s.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

(async () => {
    const asked = [];
    let down = false;
    const search = http.createServer((req, res) => {
        asked.push({ url: req.url, auth: req.headers.authorization || '', xff: req.headers['x-forwarded-for'] });
        if (down) { res.statusCode = 503; return res.end('{}'); }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ results: [{ scope: 'network', kind: 'document', title: 'surf_utopia', url: 'https://openvibe.live/clips/1' }], groups: { network: 1 }, answer: null, citations: [], route: { explain: [], cost_usd: 0 }, next_cursor: null }));
    });
    await new Promise((r) => search.listen(0, '127.0.0.1', r));
    const svc = await createFrameService(getDb(), { services: { search: { internalUrl: `http://127.0.0.1:${search.address().port}` } } }, null);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame/query`;
    const get = async (qs, headers) => { const r = await fetch(`${base}${qs}`, { headers }); return { r, d: await r.json() }; };
    const token = `Bearer ${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(20)}`;

    let { r, d } = await get('?q=surf&scopes=network,web,bogus&depth=quick&limit=10', { 'X-Forwarded-For': '203.0.113.9' });
    assert.deepStrictEqual(d.results.map((x) => x.title), ['surf_utopia']);
    const first = new URL(asked[0].url, 'http://x');
    assert.deepStrictEqual([first.pathname, first.searchParams.get('q'), first.searchParams.get('scopes'), first.searchParams.get('depth'), first.searchParams.get('limit')],
        ['/api/v1/query', 'surf', 'network,web', 'quick', '10'], 'unknown scopes are dropped; the rest go along');
    assert.strictEqual(asked[0].auth, '', 'anonymous asks as anyone');
    assert.strictEqual(asked[0].xff, '203.0.113.9');
    assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null, 'not open to every origin: only our sites (restricted CORS) may send a token');

    await get('?q=surf&scopes=network,web,bogus&depth=quick&limit=10');
    assert.strictEqual(asked.length, 1, 'the same anonymous question within 60 s is answered from memory');

    ({ r } = await get('?q=surf&scopes=mine,web', { Authorization: token }));
    assert.strictEqual(asked.length, 2, 'a person is always asked fresh');
    assert.strictEqual(asked[1].auth, token, "the person's token goes along");
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    await get('?q=surf&scopes=mine,web', { Authorization: token });
    assert.strictEqual(asked.length, 3, 'nothing personal is kept');
    await get('?q=surf&scopes=mine', { Authorization: 'Bearer short' });
    assert.strictEqual(asked[3].auth, '', 'a malformed token is not passed on');

    ({ d } = await get('?q=x&owner=../admin&cursor=a%20b'));
    const odd = new URL(asked[asked.length - 1].url, 'http://x');
    assert.ok(!odd.searchParams.has('owner') && !odd.searchParams.has('cursor'), 'odd values are dropped');

    ({ d } = await get('?q='));
    assert.deepStrictEqual(d.results, [], 'nothing typed: nothing asked');
    down = true;
    ({ r, d } = await get('?q=down'));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual([d.results, d.next_cursor], [[], null], 'Search not answering is an empty answer');

    server.close(); search.close();
    console.log('frame query: the fabric through Network, as the person or kept 60 s ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
