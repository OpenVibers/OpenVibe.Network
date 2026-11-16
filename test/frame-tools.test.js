'use strict';
// The composer's Tools through the Frame (server/frame/tools.js; 11-16: the Tools row said "Failed to fetch" on
// openvibe.live, whose CSP does not allow openvibe.tools): search, popular, one tool, its schema and an anonymous run are
// passed to the Tools gateway on loopback with the caller's address and nothing of theirs (no cookie, no token); reads
// are kept a minute; any origin may ask; a bad id is a 404 and a gateway that does not answer a 502 in words.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createFrameTools } = require('../server/frame/tools');

(async () => {
    const calls = [];
    let down = false;
    const fetchImpl = async (url, init) => {
        calls.push({ url, method: init.method, xff: init.headers['X-Forwarded-For'], cookie: init.headers.Cookie || init.headers.cookie || null, auth: init.headers.Authorization || null, body: init.body || null });
        if (down) throw new TypeError('fetch failed');
        const u = new URL(url);
        const body = u.pathname.endsWith('/run') ? { result: { echoed: JSON.parse(init.body) } } : u.pathname.endsWith('/popular') ? { tools: [{ id: 'dns-lookup' }] } : { tools: [{ id: 'dns-lookup', q: u.searchParams.get('q') }] };
        return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => JSON.stringify(body) };
    };
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', createFrameTools({ toolsUrl: 'http://127.0.0.1:4001', fetchImpl }));
    const server = await new Promise((ok) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/frame`;
    try {
        let r = await fetch(`${base}/tools?api=true&q=dns`, { headers: { Origin: 'https://openvibe.live', Cookie: 'ov_session=secret', Authorization: 'Bearer tok_secret', 'X-Forwarded-For': '203.0.113.9' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
        assert.deepStrictEqual((await r.json()).tools[0], { id: 'dns-lookup', q: 'dns' });
        assert.strictEqual(calls[0].url, 'http://127.0.0.1:4001/api/v1/tools?api=true&q=dns');
        assert.strictEqual(calls[0].xff, '203.0.113.9', 'the caller\'s address goes along');
        assert.deepStrictEqual([calls[0].cookie, calls[0].auth], [null, null], 'nothing of theirs goes along');
        // Kept a minute.
        await fetch(`${base}/tools?api=true&q=dns`);
        assert.strictEqual(calls.length, 1, 'the second read came from the minute\'s copy');
        await fetch(`${base}/tools/popular`);
        await fetch(`${base}/tools/dns-lookup`);
        await fetch(`${base}/tools/dns-lookup/schema`);
        assert.deepStrictEqual(calls.slice(1).map((c) => new URL(c.url).pathname), ['/api/v1/tools/popular', '/api/v1/tools/dns-lookup', '/api/v1/tools/dns-lookup/schema']);
        // A run: the JSON body, a POST, never kept.
        r = await fetch(`${base}/tools/dns-lookup/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { name: 'openvibe.live' } }) });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual((await r.json()).result.echoed, { input: { name: 'openvibe.live' } });
        assert.strictEqual(calls[calls.length - 1].method, 'POST');
        // A preflight, a bad id, a gateway that does not answer.
        r = await fetch(`${base}/tools/dns-lookup/run`, { method: 'OPTIONS', headers: { Origin: 'https://openvibe.live', 'Access-Control-Request-Method': 'POST' } });
        assert.deepStrictEqual([r.status, r.headers.get('access-control-allow-methods')], [204, 'GET, POST, OPTIONS']);
        assert.strictEqual((await fetch(`${base}/tools/..%2Fadmin`)).status, 404);
        down = true;
        r = await fetch(`${base}/tools/other-tool`);
        assert.strictEqual(r.status, 502);
        assert.match((await r.json()).detail, /did not answer/);
        console.log('frame-tools: search, popular, a tool, its schema and a run through the Frame; the caller\'s address only; kept a minute; CORS; 404 and 502 in words');
    } finally {
        server.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
