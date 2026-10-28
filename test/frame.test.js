'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { getDb } = require('../server/db/database');
const { createFrameService, BANNED } = require('../server/frame/service');
const { siteForHost } = require('../server/frame/sites');

(async () => {
const db = getDb();
const svc = await createFrameService(db, { services: {} }, null);

assert.equal(siteForHost('yt.openvibe.tools').id, 'tools');
assert.equal(siteForHost('evil.example'), null);
assert.strictEqual(svc.ranking().at, null, 'cold start: no use counted yet (the registry\'s featured list says so)');
let p = svc.payloadFor('openvibe.media');
assert.deepEqual(p.nav.filter(n => !n.of).map(n => n.id), ['live', 'tools', 'space', 'community', 'games', 'media', 'network', 'chat', 'services', 'blog', 'wiki', 'news', 'reviews', 'tips', 'vip', 'trade', 'host', 'deals', 'coupons', 'stream', 'media-hub', 'bot', 'codes', 'actor', 'food', 'help', 'work', 'quest', 'rent', 'watch', 'inventory', 'events', 'ai', 'search', 'run', 'play', 'zone', 'domains', 'report', 'design', 'today', 'surf', 'meme', 'vision', 'exchange'], 'cold start follows the base order');
// The launcher: every open site in one of the groups, and the products other services serve on their own domains
// right after their site (Pics and Download after Video, Homes after Rent).
assert.deepStrictEqual(p.groups.map(g => g.name), ['Streams & places', 'Games & laughs', 'News & answers', 'Make & build', 'Shop & swap', 'People & you', 'For developers'], 'the six neighbourhoods (plan 2026-10-28 §3.1), the building blocks last');
assert.strictEqual(p.groups.find(g => g.id === 'build').name, 'For developers');
assert.ok(p.nav.every(n => p.groups.some(g => g.id === n.group)), 'every entry has a group');
assert.deepStrictEqual(p.nav.filter(n => n.of).map(n => [n.id, n.of, n.url]), [['pics', 'media-hub', 'https://openvibe.pics/'], ['download', 'media-hub', 'https://openvibe.download/'], ['homes', 'rent', 'https://openvibe.homes/']]);
const at = (id) => p.nav.findIndex(n => n.id === id);
assert.ok(at('pics') === at('media-hub') + 1 && at('homes') === at('rent') + 1, 'a product follows its site');
assert.deepStrictEqual([p.nav[at('media-hub')].icon, p.nav[at('media-hub')].group, p.nav[at('homes')].group, p.nav[at('tools')].group], ['video', 'streams', 'shop', 'make'], 'Video draws the video icon (there is no media-hub icon)');
assert.deepStrictEqual(['actor', 'bot', 'run', 'zone'].map((id) => p.nav[at(id)].group), ['make', 'make', 'build', 'build'], 'agents and robots for people, compute and storage for developers');
// Games together, items with the account, Alerts with the building blocks, files beside Video (each when its site is open).
[['games', 'games'], ['quest', 'games'], ['inventory', 'people'], ['watch', 'build'], ['download', 'streams'], ['search', 'answers'], ['chat', 'people'], ['domains', 'make'], ['report', 'answers'], ['design', 'make'], ['today', 'answers'], ['surf', 'games'], ['meme', 'games'], ['vision', 'answers'], ['exchange', 'shop']]
    .filter(([id]) => at(id) >= 0).forEach(([id, group]) => assert.strictEqual(p.nav[at(id)].group, group, `${id} is in ${group}`));
assert.strictEqual(p.nav.length, 48);   // Domains since contracts 0.226.0, Report since 0.227.0, Design since 0.228.0, Today since 0.230.0, Surf since 0.231.0, Meme since 0.234.0, Vision and Exchange since 0.235.0
assert.deepStrictEqual([p.nav[at('stream')].name, p.nav[at('pics')].name], ['Restream', 'Pics'], 'OpenRestream is "Restream" among the menu\'s short names (owner, 2026-10-28)');
assert.strictEqual(p.nav.find(n => n.id === 'space').url, 'https://openvibe.space/', 'Space keeps its own home (the forum returned to Community, 0.118.0)');
assert.strictEqual(p.nav.find(n => n.id === 'community').url, 'https://openvibe.community/', 'Community: the forum, pastes and Pulse');
assert.equal(p.footer.legal.dmca, 'https://openvibe.media/dmca', 'legal links stay on the site\'s own domain');
assert.ok(!p.footer.discover.some(l => l.url === 'https://openvibe.media/'), 'a site never recommends itself');
assert.deepStrictEqual(p.soon.map(n => n.id || n), [], 'no planned site left: Tips and VIP opened 2026-10-17 (contracts 0.200.0; news, reviews, trade, coupons and stream 2026-10-09)');

// Real use reorders: community gets the history, so it rises above the cold-start order.
// user_history's foreign key needs its users (PostgreSQL enforces the constraint SQLite only declared).
for (let i = 0; i < 9; i++) await db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(i, `h${i}`, 'x');
const ins = db.prepare("INSERT INTO user_history (user_id, service, sub, type, title, url) VALUES (?, ?, ?, 'page', 't', 'u')");
for (let i = 0; i < 40; i++) await ins.run(i % 9, 'community', null);
for (let i = 0; i < 6; i++) await ins.run(1, 'tools', 'dns');
(async () => {
    await db.prepare("INSERT INTO frame_hits (day, host, hits) VALUES (substring(ov_now(), 1, 10), 'openvibe.games', 900), (substring(ov_now(), 1, 10), 'dns.openvibe.tools', 50), (substring(ov_now(), 1, 10), 'openvibe.network', 1000)").run();
    const realFetch = global.fetch; global.fetch = async () => ({ ok: false });
    await svc.refreshRank(); global.fetch = realFetch;
    p = svc.payloadFor('openvibe.network');
    assert.equal(p.nav[0].id, 'games', 'most viewed site comes first');
    assert.deepEqual(svc.ranking().order, p.nav.filter(n => !n.of).map(n => n.id), 'ranking() is the navigation order (the registry features by it)');
    assert.ok(Date.now() - svc.ranking().at < 5000, 'and says when it was counted');
    assert.ok(p.nav.findIndex(n => n.id === 'network') > 0, 'the Network is never first on shared-service traffic alone');
    assert.ok(BANNED.test('Totally free tools') && BANNED.test('see https://x.y') && BANNED.test('<b>hi</b>') && !BANNED.test('Go live from a browser in seconds.'), 'AI copy screen');
    assert.equal(p.footer.ai, false);

    // Footer copy comes from OpenVibe.AI only. Live's /internal/ai/site-copy is never called, and an
    // AI failure keeps the last good copy (or the hand-written one when there has never been one).
    let liveHits = 0; let aiMode = 'ok'; let aiAuth = null;
    const live = http.createServer((req, res) => { liveHits++; res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, sites: [{ id: 'games', blurb: 'Copy from Live that must never be used here.', picks: [] }] })); });
    const ai = http.createServer((req, res) => {
        aiAuth = req.headers.authorization;
        if (aiMode === 'down') { res.statusCode = 503; return res.end('{}'); }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ run: { status: 'succeeded', route: { key: 'site-copy', version: 1 }, provenance: { origin: 'ai', workflow: 'network.site_copy', model: 'test-model', route: 'site-copy' }, output: { sites: [{ id: 'games', blurb: 'Play Scraplandia and the shared pixel canvas in a tab.', picks: ['site:live'] }] } } }));
    });
    await Promise.all([live, ai].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const cfg = { services: { live: { internalUrl: `http://127.0.0.1:${live.address().port}` } } };
    const aiUrl = `http://127.0.0.1:${ai.address().port}`;
    const db2 = db;   // the process's database (test/helpers/pg-preload.mjs); the copy cache lives here
    const copySvc = async (d) => await createFrameService(d, cfg, null, { privateKey, issuer: 'https://openvibe.network', aiUrl });

    let s2 = await copySvc(db2);
    aiMode = 'down';
    await s2.refreshCopy();
    p = s2.payloadFor('openvibe.games');
    assert.equal(p.footer.ai, false, 'AI down and no earlier copy: the hand-written blurb');
    assert.equal(p.footer.blurb, siteForHost('openvibe.games').what);
    assert.equal(liveHits, 0, 'no fallback to Live when AI fails');

    aiMode = 'ok';
    await s2.refreshCopy();
    assert.match(aiAuth, /^Bearer ey/, 'AI is called with the self-signed service token');
    p = s2.payloadFor('openvibe.games');
    assert.equal(p.footer.ai, true);
    assert.equal(p.footer.blurb, 'Play Scraplandia and the shared pixel canvas in a tab.');
    assert.equal(JSON.parse((await db2.prepare("SELECT value FROM frame_cache WHERE key = 'copy'").get()).value).model, 'test-model', 'the model is read from run.provenance.model (ai.run@1)');

    aiMode = 'down';
    await s2.refreshCopy();
    p = s2.payloadFor('openvibe.games');
    assert.equal(p.footer.blurb, 'Play Scraplandia and the shared pixel canvas in a tab.', 'AI failure keeps the last good copy');
    s2 = await copySvc(db2);
    assert.equal(s2.payloadFor('openvibe.games').footer.blurb, 'Play Scraplandia and the shared pixel canvas in a tab.', 'and it survives a restart');

    // Without a signing key there is no AI client, and still no Live call.
    await (await createFrameService(db, cfg, null)).refreshCopy();
    assert.equal(liveHits, 0, 'Live is never asked for copy');
    // The page-view beacon (navigator.sendBeacon, a no-cors request) is readable cross-origin, so no
    // site's console reports it as blocked.
    {
        const express = require('express');
        const app = express(); app.use('/api/frame', svc.router);
        const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
        const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/frame/hit`, { method: 'POST', headers: { origin: 'https://case.openvibe.tools', 'content-type': 'text/plain' }, body: '' });
        assert.equal(r.status, 204);
        assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
        assert.equal(r.headers.get('access-control-allow-origin'), '*');
        srv.close();
    }
    // The footer's live line: streams live and people watching (Live's public list), open sites, last week's views.
    {
        const liveList = http.createServer((req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(req.url === '/api/streams' ? { streams: [{ id: 1, viewer_count: 3, total_viewer_count: 5 }, { id: 2, viewer_count: 2 }] } : {}));
        });
        await new Promise(r => liveList.listen(0, '127.0.0.1', r));
        const pulseSvc = await createFrameService(db, { services: { live: { internalUrl: `http://127.0.0.1:${liveList.address().port}` } } }, null);
        const express = require('express');
        const app = express(); app.use('/api/frame', pulseSvc.router);
        const srv = await new Promise(r => { const s2 = app.listen(0, '127.0.0.1', () => r(s2)); });
        const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/frame/pulse`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('access-control-allow-origin'), '*');
        assert.match(r.headers.get('cache-control'), /max-age=30/);
        const j = await r.json();
        assert.deepStrictEqual([j.live_now, j.watching, j.sites], [2, 7, pulseSvc.ranking().order.length]);
        assert.ok(j.views_7d > 0 && j.updated, 'last week\'s views from the ranking');
        liveList.close();
        const down = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/frame/pulse`)).json();
        assert.equal(down.live_now, 2, 'answered from the last read for 30 s');
        srv.close();
    }
    live.close(); ai.close();
    console.log('frame service: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
