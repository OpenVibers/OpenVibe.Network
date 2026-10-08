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
assert.deepEqual(p.nav.map(n => n.id), ['live', 'tools', 'space', 'community', 'games', 'media', 'network', 'chat', 'services', 'blog', 'wiki', 'host', 'deals', 'bot', 'codes', 'actor', 'food', 'help', 'work', 'quest', 'rent', 'watch'], 'cold start follows the base order');
assert.strictEqual(p.nav.find(n => n.id === 'space').url, 'https://openvibe.space/', 'Space keeps its own home (the forum returned to Community, 0.118.0)');
assert.strictEqual(p.nav.find(n => n.id === 'community').url, 'https://openvibe.community/', 'Community: the forum, pastes and Pulse');
assert.equal(p.footer.legal.dmca, 'https://openvibe.media/dmca', 'legal links stay on the site\'s own domain');
assert.ok(!p.footer.discover.some(l => l.url === 'https://openvibe.media/'), 'a site never recommends itself');
assert.ok(p.soon.length >= 8, 'every planned site still listed as soon (deals launched 2026-10-08: news, reviews, tips, vip, trade, coupons, stream, media-hub)');

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
    assert.deepEqual(svc.ranking().order, p.nav.map(n => n.id), 'ranking() is the navigation order (the registry features by it)');
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
    live.close(); ai.close();
    console.log('frame service: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
