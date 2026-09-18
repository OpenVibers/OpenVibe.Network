'use strict';
const assert = require('assert');
const express = require('express'); const Database = require('better-sqlite3');
const { createAvatarService, normalizeAvatar, verifyImage } = require('../server/profile/avatar');

// What counts as an avatar
const M = 'https://openvibe.media';
assert.equal(normalizeAvatar('teal-holly-41').url, `${M}/p/teal-holly-41/screenshot`, 'a paste slug');
assert.equal(normalizeAvatar('https://openvibe.community/p/teal-holly-41').url, `${M}/p/teal-holly-41/screenshot`, 'a Community paste link');
assert.equal(normalizeAvatar('https://openvibe.live/p/teal-holly-41/').url, `${M}/p/teal-holly-41/screenshot`, 'a Live paste link');
assert.equal(normalizeAvatar(`${M}/f/screenshots/avatar-1.png`).url, `${M}/f/screenshots/avatar-1.png`, 'a media file');
assert.equal(normalizeAvatar('').url, null, 'empty clears it');
assert.deepEqual(normalizeAvatar('https://example.com/me.png'), { ingest: 'https://example.com/me.png' }, 'a link elsewhere is imported, never stored');
assert.ok(!normalizeAvatar('https://openvibe.media.evil.example/x.png').url, 'look-alike hosts are not openvibe.media');
for (const bad of ['http://openvibe.media/x.png', 'javascript:alert(1)', 'https://user:pw@openvibe.media/x.png', 'data:image/png;base64,AAAA', '../../etc/passwd'])
    assert.ok(normalizeAvatar(bad).error, `rejected: ${bad}`);

(async () => {
    const img = async () => ({ ok: true, status: 200, headers: { get: () => 'image/png' }, body: { cancel: async () => {} } });
    const html = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, body: null });
    assert.equal((await verifyImage(`${M}/x.png`, img)).ok, true);
    assert.equal((await verifyImage(`${M}/x.png`, html)).ok, false, 'a page is not a picture');

    const db = new Database(':memory:');
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, avatar_url TEXT); CREATE TABLE audit_log(id INTEGER PRIMARY KEY, user_id INT, action TEXT, details TEXT, ip TEXT); INSERT INTO users VALUES (1,'Goosely',NULL),(2,'legacy','https://evil.example/old.png')");
    const pushes = []; const realFetch = global.fetch; global.fetch = async (u, o) => { pushes.push(JSON.parse(o.body)); return { ok: true }; };
    const svc = createAvatarService({ db, config: { internalKey: 'k'.repeat(24), services: {} }, requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'Goosely' }; next(); } });
    assert.equal(svc.fromSite({ user_id: 1, avatar_url: `${M}/f/a.png`, origin: 'live' }).changed, true);
    assert.equal(pushes.length, 0, 'a change that came from Live is not echoed back to Live');
    svc.apply(1, 'Goosely', `${M}/f/b.png`, 'network'); assert.equal(pushes.length, 1); assert.equal(pushes[0].avatar_url, `${M}/f/b.png`, 'a change made here is pushed to the sites');
    assert.equal(svc.fromSite({ user_id: 1, avatar_url: 'https://evil.example/x.png' }).status, 422);
    global.fetch = realFetch;

    const app = express(); app.use('/avatar', svc.pub);
    const srv = app.listen(0, async () => {
        const b = 'http://127.0.0.1:' + srv.address().port;
        let r = await fetch(b + '/avatar/goosely', { redirect: 'manual' }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), `${M}/f/b.png`, 'case-insensitive lookup redirects to the picture');
        assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin', 'usable in an <img> on any site');
        r = await fetch(b + '/avatar/nobody'); assert.equal(r.status, 200); assert.ok(/svg/.test(r.headers.get('content-type')) && /<text/.test(await r.text()), 'unknown names get an initial');
        r = await fetch(b + '/avatar/legacy', { redirect: 'manual' }); assert.equal(r.status, 200, 'a stored off-network picture is never redirected to');
        console.log('avatar: all checks passed'); srv.close();
    });
})().catch(e => { console.error(e); process.exit(1); });
