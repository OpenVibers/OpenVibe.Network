'use strict';
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const Database = require('better-sqlite3');
const { createChromeService, BANNED } = require('../server/chrome/service');
const { siteForHost } = require('../server/chrome/sites');

const db = new Database(':memory:');
db.exec("CREATE TABLE user_history (id INTEGER PRIMARY KEY, user_id INT, service TEXT, sub TEXT, type TEXT, title TEXT, url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
const svc = createChromeService(db, { internalKey: 'change-me-in-production', services: {} }, null);

assert.equal(siteForHost('yt.openvibe.tools').id, 'tools');
assert.equal(siteForHost('evil.example'), null);
let p = svc.payloadFor('openvibe.media');
assert.deepEqual(p.nav.map(n => n.id), ['live', 'tools', 'community', 'games', 'media', 'network', 'codes', 'blog', 'wiki'], 'cold start follows the base order');
assert.equal(p.footer.legal.dmca, 'https://openvibe.media/dmca', 'legal links stay on the site\'s own domain');
assert.ok(!p.footer.discover.some(l => l.url === 'https://openvibe.media/'), 'a site never recommends itself');
assert.ok(p.soon.length >= 10);

// Real use reorders: community gets the history, so it rises above the cold-start order.
const ins = db.prepare("INSERT INTO user_history (user_id, service, sub, type, title, url) VALUES (?, ?, ?, 'page', 't', 'u')");
for (let i = 0; i < 40; i++) ins.run(i % 9, 'community', null);
for (let i = 0; i < 6; i++) ins.run(1, 'tools', 'dns');
(async () => {
    db.prepare("INSERT INTO chrome_hits (day, host, hits) VALUES (date('now'), 'openvibe.games', 900), (date('now'), 'dns.openvibe.tools', 50), (date('now'), 'openvibe.network', 1000)").run();
    const realFetch = global.fetch; global.fetch = async () => ({ ok: false });
    await svc.refreshRank(); global.fetch = realFetch;
    p = svc.payloadFor('openvibe.network');
    assert.equal(p.nav[0].id, 'games', 'most viewed site comes first');
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
        res.end(JSON.stringify({ run: { status: 'succeeded', model: { key: 'test-model' }, output: { sites: [{ id: 'games', blurb: 'Play Scraplandia and the shared pixel canvas in a tab.', picks: ['site:live'] }] } } }));
    });
    await Promise.all([live, ai].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const cfg = { internalKey: 'a-real-internal-key', services: { live: { internalUrl: `http://127.0.0.1:${live.address().port}` } } };
    const aiUrl = `http://127.0.0.1:${ai.address().port}`;
    const db2 = new Database(':memory:');
    const copySvc = (d) => createChromeService(d, cfg, null, { privateKey, issuer: 'https://openvibe.network', aiUrl });

    let s2 = copySvc(db2);
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

    aiMode = 'down';
    await s2.refreshCopy();
    p = s2.payloadFor('openvibe.games');
    assert.equal(p.footer.blurb, 'Play Scraplandia and the shared pixel canvas in a tab.', 'AI failure keeps the last good copy');
    s2 = copySvc(db2);
    assert.equal(s2.payloadFor('openvibe.games').footer.blurb, 'Play Scraplandia and the shared pixel canvas in a tab.', 'and it survives a restart');

    // Without a signing key there is no AI client, and still no Live call.
    await createChromeService(new Database(':memory:'), cfg, null).refreshCopy();
    assert.equal(liveHits, 0, 'Live is never asked for copy');
    live.close(); ai.close();
    console.log('chrome service: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
