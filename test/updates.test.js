'use strict';
// What shipped network-wide: /api/v1/changelog proxies OpenVibe.Blog's changelog (cached, stale on
// failure, public CORS), and /updates server-renders the log before shipped.js takes over.
//   node test/updates.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createUpdatesRoutes, serviceFor } = require('../server/updates/routes');
const publicCors = require('../server/public-cors');

(async () => {
    let calls = [];
    let up = true;
    let t = 1000;
    const feed = { entries: [{ service: 'wiki', sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'Fix <script>x</script> in pages', author: 'OpenVibers', deployed_at: '2026-09-24T07:00:00.000Z', url: 'https://github.com/OpenVibers/OpenVibe.Wiki/commit/aaa' }], next: null, posts: [{ title: 'Patch notes: x', url: 'https://openvibe.blog/@openvibe/x', published_at: '2026-09-24T06:00:00.000Z' }], latest_post: null };
    const fetchImpl = async (url) => { calls.push(url); if (!up) throw new Error('down'); return { ok: true, json: async () => feed }; };
    const u = createUpdatesRoutes({ blogUrl: 'http://blog.test', fetchImpl, now: () => t, log: null });
    const app = express();
    app.use(u.router);
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    let r = await fetch(`${base}/api/v1/changelog?service=wiki&limit=500&before=../../x`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(calls[0], 'http://blog.test/api/v1/changelog?service=wiki&limit=100', 'limit clamped, a bad cursor dropped');
    await fetch(`${base}/api/v1/changelog?service=wiki&limit=500`);
    assert.strictEqual(calls.length, 1, 'cached for 60 s');
    t += 61 * 1000; up = false;
    r = await fetch(`${base}/api/v1/changelog?service=wiki&limit=500`);
    assert.strictEqual(r.status, 200, 'stale copy while Blog is down');
    r = await fetch(`${base}/api/v1/changelog?service=news`);
    assert.strictEqual(r.status, 502, 'nothing cached and Blog down: an honest error');
    up = true;

    const page = await (await fetch(`${base}/updates`)).text();
    assert.ok(page.includes('data-ov-shipped="log"') && page.includes('What shipped across OpenVibe'));
    assert.ok(page.includes('Fix &lt;script&gt;x&lt;/script&gt; in pages') && !page.includes('<script>x</script>'), 'commit text escaped in the SSR log');
    assert.ok(page.includes('https://openvibe.blog/@openvibe/x'), 'patch notes listed');
    assert.ok(page.includes('<link rel="canonical" href="https://openvibe.network/updates">'));
    const one = await fetch(`${base}/updates?site=openvibe.wiki`);
    assert.strictEqual(one.headers.get('x-robots-tag'), 'noindex, follow');
    assert.ok((await one.text()).includes('What shipped on OpenVibe.Wiki'));

    assert.strictEqual(serviceFor('pdf.openvibe.tools'), 'tools');
    assert.strictEqual(serviceFor('search.openvibe.network'), 'search');
    assert.strictEqual(serviceFor('evil.example'), null);
    assert.ok(publicCors.isPublicDiscoveryPath('/api/v1/changelog'), 'readable from any origin');
    srv.close();
    console.log('updates: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
