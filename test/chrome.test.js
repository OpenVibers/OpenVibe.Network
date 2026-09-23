'use strict';
const assert = require('assert');
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
    console.log('chrome service: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
