'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const contracts = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const { createFrameService, BANNED } = require('../server/frame/service');
const { siteForHost, GROUPS, LISTED } = require('../server/frame/sites');

(async () => {
const db = getDb();
const svc = await createFrameService(db, { services: {} }, null);

assert.equal(siteForHost('yt.openvibe.tools').id, 'tools');
assert.equal(siteForHost('bench.openvibe.services').id, 'report', 'Bench\'s host belongs to Report now');
assert.equal(siteForHost('evil.example'), null);
assert.equal(siteForHost('openvibe.computer').id, 'computer', 'Computer is listed in the Network Frame while its Contracts manifest is pending');
assert.equal(siteForHost('openvibe.directory').id, 'directory', 'the released Directory manifest belongs to the live site');
assert.equal(GROUPS.find((g) => g.sites.includes('computer')).id, 'make');
assert.strictEqual(svc.ranking().at, null, 'cold start: no use counted yet (the registry\'s featured list says so)');

// Legal links (11-02: ten open sites did not serve /privacy, so their footers' Terms, Privacy and DMCA answered 404):
// a site whose /privacy does not answer 200 gets openvibe.network's documents until it does.
{
    assert.equal(svc.payloadFor('openvibe.events').footer.legal.privacy, 'https://openvibe.events/privacy', 'not asked yet: its own, as before');
    const seen = await svc.probeLegal({ fetchImpl: async (url) => ({ status: /openvibe\.(events|report)\//.test(url) ? 404 : 200 }) });
    assert.strictEqual(seen['openvibe.events'], false);
    assert.strictEqual(seen['openvibe.live'], true);
    assert.deepStrictEqual(svc.payloadFor('openvibe.events').footer.legal, { terms: 'https://openvibe.network/terms', privacy: 'https://openvibe.network/privacy', dmca: 'https://openvibe.network/dmca' });
    assert.equal(svc.payloadFor('openvibe.live').footer.legal.privacy, 'https://openvibe.live/privacy', 'a site that serves them keeps its own');
    // A site that gains its pages gets its own links back; a site that does not answer keeps what was known.
    await svc.probeLegal({ fetchImpl: async (url) => { if (/openvibe\.report\//.test(url)) throw new Error('down'); return { status: 200 }; } });
    assert.equal(svc.payloadFor('openvibe.events').footer.legal.privacy, 'https://openvibe.events/privacy');
    assert.equal(svc.payloadFor('openvibe.report').footer.legal.privacy, 'https://openvibe.network/privacy', 'no answer: kept');
    // A redirect is not the page.
    await svc.probeLegal({ fetchImpl: async (url) => ({ status: /openvibe\.events\//.test(url) ? 302 : 200 }) });
    assert.equal(svc.payloadFor('openvibe.events').footer.legal.privacy, 'https://openvibe.network/privacy');
    await svc.probeLegal({ fetchImpl: async () => ({ status: 200 }) });
}
let p = svc.payloadFor('openvibe.media');
// Email (OpenVibe.Mail) joins the cold order after Chat once its manifest is in the pinned Contracts release; until then
// the test still follows what the installed manifests say.
const COLD_ORDER = ['live', 'tools', 'space', 'community', 'games', 'network', 'chat', 'mail', 'services', 'blog', 'wiki', 'news', 'reviews', 'tips', 'vip', 'trade', 'host', 'deals', 'coupons', 'stream', 'media-hub', 'bot', 'codes', 'actor', 'food', 'help', 'work', 'quest', 'rent', 'watch', 'inventory', 'events', 'git', 'search', 'run', 'zone', 'domains', 'report', 'design', 'today', 'surf', 'meme', 'vision', 'exchange', 'fun', 'cam', 'casino', 'tours', 'shoes', 'connect', 'computer', 'lock', 'image', 'compare', 'directory', 'expert', 'markets', 'finance'];
assert.deepEqual(p.nav.filter(n => !n.of).map(n => n.id), COLD_ORDER, 'cold start follows the base order');
assert.ok(!p.nav.some(n => n.id === 'play'), 'Play is part of Games, not a menu entry of its own');
assert.ok(!p.nav.some(n => ['media', 'homes', 'bench', 'website'].includes(n.id)), 'merged sections and the domain-only Website are not tiles');
// The launcher: every open place in one of the eight groups (owner, 2026-11-10), and the products other services
// serve on their own domains right after their site (Pics and Download after Video; Homes and Bench are sections).
assert.deepStrictEqual(p.groups.map(g => g.name), ['Watch & stream', 'Talk & belong', 'Play', 'Read & ask', 'Shop & money', 'Free tools', 'Make with AI', 'For developers'], 'the eight groups in the owner\'s order');
assert.deepStrictEqual(p.groups.map(g => g.id), ['watch', 'talk', 'play', 'read', 'shop', 'tools', 'make', 'build']);
assert.deepStrictEqual(GROUPS.find(g => g.id === 'talk').sites, ['community', 'chat', 'tips', 'vip', 'mail', 'help', 'network'], 'Email sits with Chat in the talk group');
assert.ok(p.nav.every(n => p.groups.some(g => g.id === n.group)), 'every entry has a group');
assert.deepStrictEqual(p.nav.filter(n => n.of).map(n => [n.id, n.of, n.url]), [['pics', 'media-hub', 'https://openvibe.pics/'], ['download', 'media-hub', 'https://openvibe.download/']]);
const at = (id) => p.nav.findIndex(n => n.id === id);
assert.ok(at('pics') === at('media-hub') + 1 && at('download') === at('media-hub') + 2, 'Pics and Download follow their site');
assert.deepStrictEqual([p.nav[at('media-hub')].icon, p.nav[at('media-hub')].group, p.nav[at('tools')].group], ['video', 'watch', 'tools'], 'Video draws the video icon (there is no media-hub icon)');
assert.deepStrictEqual(['actor', 'bot', 'run', 'zone', 'codes'].map((id) => p.nav[at(id)].group), ['make', 'make', 'build', 'build', 'make'], 'robots and coding agents make with AI; compute and storage are for developers');
// The three doors of 2026-11-13: Expert with the agents you make, Markets and Finance with the shops and the money.
assert.deepStrictEqual(['expert', 'markets', 'finance'].map((id) => p.nav[at(id)].group), ['make', 'shop', 'shop'], 'the doors sit with the places they belong to');
assert.deepStrictEqual(['expert', 'markets', 'finance'].map((id) => p.nav[at(id)].url), ['https://openvibe.expert/', 'https://openvibe.markets/', 'https://openvibe.finance/'], 'a door is its own domain');
// Every tile is in exactly one group, each group has at most nine tiles, and the merged sections still answer.
[['games', 'play'], ['connect', 'make'], ['image', 'tools'], ['quest', 'play'], ['inventory', 'play'], ['watch', 'build'], ['download', 'watch'], ['search', 'read'], ['chat', 'talk'], ['mail', 'talk'], ['domains', 'tools'], ['report', 'read'], ['design', 'tools'], ['today', 'read'], ['surf', 'play'], ['meme', 'play'], ['vision', 'read'], ['exchange', 'build'], ['fun', 'play'], ['cam', 'watch'], ['casino', 'play'], ['tours', 'watch'], ['shoes', 'shop']]
    .filter(([id]) => at(id) >= 0).forEach(([id, group]) => assert.strictEqual(p.nav[at(id)].group, group, `${id} is in ${group}`));
assert.strictEqual(p.nav.length, 60, '58 open sites plus Pics and Download; the three doors of 2026-11-13 joined them');
assert.deepStrictEqual([p.nav[at('stream')].name, p.nav[at('pics')].name], ['Restream', 'Pics'], 'OpenRestream is "Restream" among the menu\'s short names (owner, 2026-10-28)');
assert.strictEqual(p.nav.find(n => n.id === 'space').url, 'https://openvibe.space/', 'Space keeps its own home (the forum returned to Community, 0.118.0)');
assert.strictEqual(p.nav.find(n => n.id === 'community').url, 'https://openvibe.community/', 'Community: the forum, pastes and Pulse');
assert.equal(p.footer.legal.dmca, 'https://openvibe.media/dmca', 'legal links stay on the site\'s own domain');
assert.ok(!p.footer.discover.some(l => l.url === 'https://openvibe.media/'), 'a site never recommends itself');
assert.deepStrictEqual(p.soon.map(n => n.id || n), [], 'nothing is coming soon: Computer launched on 2026-11-08');

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
        assert.deepStrictEqual([j.live_now, j.watching, j.sites], [2, 7, LISTED.filter((s) => s.status === 'open').length], 'the one open-place count (sites plus Pics and Download)');
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
