'use strict';
// What shipped network-wide: /api/v1/changelog proxies OpenVibe.Blog's changelog (cached, stale on
// failure, public CORS) plus the newest devblog for the card's lead, and /updates server-renders the
// log before shipped.js takes over.
//   node test/updates.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createUpdatesRoutes, serviceFor, renderPage } = require('../server/updates/routes');
const publicCors = require('../server/public-cors');

(async () => {
    let calls = [];
    let up = true;
    let devblogsUp = true;
    let t = 1000;
    const feed = { entries: [{ service: 'wiki', sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'Fix <script>x</script> in pages', author: 'OpenVibers', deployed_at: '2026-09-24T07:00:00.000Z', url: 'https://github.com/OpenVibers/OpenVibe.Wiki/commit/aaa' }], next: null, posts: [{ title: 'Patch notes: x', url: 'https://openvibe.blog/@openvibe/x', published_at: '2026-09-24T06:00:00.000Z' }], latest_post: null };
    let devblogs = { total: 1, posts: [{ id: 'p1', title: 'What shipped on OpenVibe.Wiki', summary: 'A week of pages.', figure: { mediaId: 'm1', url: 'https://openvibe.media/o/m1' }, url: 'https://openvibe.blog/@openvibe/what-shipped-wiki', blog: 'openvibe', published_at: '2026-09-24T06:00:00.000Z' }] };
    const fetchImpl = async (url) => {
        calls.push(url);
        if (!up) throw new Error('down');
        if (url.includes('/api/v1/devblogs')) return devblogsUp ? { ok: true, json: async () => devblogs } : { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, json: async () => feed };
    };
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
    assert.strictEqual(calls[1], 'http://blog.test/api/v1/devblogs?service=wiki&limit=1', 'the lead is the newest devblog for the requested service');
    let body = await r.json();
    assert.deepStrictEqual(body.latest_devblog, {
        title: 'What shipped on OpenVibe.Wiki', summary: 'A week of pages.',
        figure: 'https://openvibe.media/o/m1', url: 'https://openvibe.blog/@openvibe/what-shipped-wiki', published_at: '2026-09-24T06:00:00.000Z',
    }, 'the devblog as the card lead, its art as an https URL');
    await fetch(`${base}/api/v1/changelog?service=wiki&limit=500`);
    assert.strictEqual(calls.length, 2, 'changelog and devblog cached for 60 s');
    t += 61 * 1000;
    devblogs = { total: 1, posts: [{ id: 'p2', title: 'T'.repeat(260), summary: 'S'.repeat(500), figure: 'http://insecure.test/a.png', url: 'https://openvibe.blog/@openvibe/second', published_at: '2026-09-25T06:00:00.000Z' }] };
    body = await (await fetch(`${base}/api/v1/changelog?service=wiki`)).json();
    assert.strictEqual(body.latest_devblog.figure, null, 'a non-https figure is dropped');
    assert.strictEqual(body.latest_devblog.title.length, 200, 'the title is capped');
    assert.strictEqual(body.latest_devblog.summary.length, 400, 'the summary is capped');
    assert.strictEqual(body.latest_devblog.url, 'https://openvibe.blog/@openvibe/second');
    body = await (await fetch(`${base}/api/v1/changelog`)).json();
    assert.ok(calls.includes('http://blog.test/api/v1/devblogs?limit=1'), 'no service: the network-wide lead');
    assert.strictEqual(body.latest_devblog.title.length, 200);
    t += 61 * 1000; up = false;
    r = await fetch(`${base}/api/v1/changelog?service=wiki&limit=500`);
    assert.strictEqual(r.status, 200, 'stale copy while Blog is down');
    assert.strictEqual((await r.json()).latest_devblog, null, 'a devblog failure is null, never a stale card');
    r = await fetch(`${base}/api/v1/changelog?service=news`);
    assert.strictEqual(r.status, 502, 'nothing cached and Blog down: an honest error');
    up = true; devblogsUp = false; t += 61 * 1000;
    r = await fetch(`${base}/api/v1/changelog?service=wiki`);
    assert.strictEqual(r.status, 200, 'a Blog without the devblog endpoint still answers the changelog');
    assert.strictEqual((await r.json()).latest_devblog, null, 'the field is null until the endpoint ships');
    devblogsUp = true; t += 61 * 1000;
    assert.strictEqual((await (await fetch(`${base}/api/v1/changelog?service=wiki`)).json()).latest_devblog.title, 'T'.repeat(200), 'the field returns when Blog does');

    const page = await (await fetch(`${base}/updates`)).text();
    assert.ok(page.includes('data-ov-shipped="log"') && page.includes('What shipped across OpenVibe'));
    assert.ok(page.includes('Fix &lt;script&gt;x&lt;/script&gt; in pages') && !page.includes('<script>x</script>'), 'commit text escaped in the SSR log');
    assert.ok(page.includes('https://openvibe.blog/@openvibe/x'), 'patch notes listed');
    assert.ok(page.includes('<link rel="canonical" href="https://openvibe.network/updates">'));
    // One filter row: the no-JS site links sit inside the shipped mount, which shipped.js empties and refills with its own bar.
    const mount = page.indexOf('data-ov-shipped="log"'), nav = page.indexOf('<nav class="up-sites"');
    assert.ok(nav > mount && page.indexOf('</div>', mount) > nav, 'the site links are inside the shipped mount');
    assert.strictEqual(page.split('class="up-sites"').length - 1, 1, 'one site filter');
    assert.ok(page.includes('<a href="/updates?site=bot">Bot</a>'), 'Bot is a site');
    assert.strictEqual(serviceFor('bot'), 'bot');
    assert.strictEqual(serviceFor('openvibe.space'), 'space');
    assert.ok(page.includes('<a href="/updates?site=space">Space</a>'));
    const one = await fetch(`${base}/updates?site=openvibe.wiki`);
    assert.strictEqual(one.headers.get('x-robots-tag'), 'noindex, follow');
    assert.ok((await one.text()).includes('What shipped on OpenVibe.Wiki'));

    assert.strictEqual(serviceFor('pdf.openvibe.tools'), 'tools');
    assert.strictEqual(serviceFor('search.openvibe.network'), 'search');
    assert.strictEqual(serviceFor('evil.example'), null);
    assert.ok(publicCors.isPublicDiscoveryPath('/api/v1/changelog'), 'readable from any origin');

    // The first page groups the same change across sites, as openvibe-shared/shipped.js (4.47.2) does once it runs.
    const at = '2026-10-29T17:40:00.000Z';
    const pin = (svc, n) => ({ service: svc, sha: String(n).repeat(40).slice(0, 40), subject: `openvibe-shared v4.45.0 (was v4.43.0) (#${n})`, author: 'OpenVibers', deployed_at: at, url: `https://github.com/OpenVibers/x/commit/${n}` });
    const grouped = renderPage({ site: null, filtered: false, body: { entries: [pin('fun', 9), pin('chat', 252), pin('cam', 7), { service: 'trade', sha: 'c'.repeat(40), subject: 'Touch targets on phones (fleet audit) (#141)', author: 'OpenVibers', deployed_at: at, url: 'https://github.com/OpenVibers/x/commit/c' }] } });
    assert.ok(grouped.includes('<span class="ov-shipped-count">3</span><span class="ov-shipped-text">Shared 4.45.0 reached 3 sites'), 'one row for a pin round');
    assert.ok(grouped.includes('https://github.com/OpenVibers/OpenVibe.Shared/blob/v4.45.0/CHANGELOG.md'), "what's in that release");
    assert.strictEqual(grouped.split('class="ov-shipped-entry"').length - 1, 4, 'every commit still listed in its fold, plus the single one');
    assert.ok(!grouped.includes('OpenVibers · '), 'the shared account is not named on each row');
    srv.close();
    console.log('updates: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
