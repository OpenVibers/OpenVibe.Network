'use strict';
const assert = require('assert');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createAvatarService, normalizeAvatar, verifyImage } = require('../server/profile/avatar');

// What counts as an avatar: everything accepted is a *source* Media copies into the person's own avatar object.
const M = 'https://openvibe.media';
assert.equal(normalizeAvatar('teal-holly-41').url, `${M}/p/teal-holly-41/screenshot`, 'a paste slug');
assert.equal(normalizeAvatar('https://openvibe.community/p/teal-holly-41').url, `${M}/p/teal-holly-41/screenshot`, 'a Community paste link');
assert.equal(normalizeAvatar('https://openvibe.live/p/teal-holly-41/').url, `${M}/p/teal-holly-41/screenshot`, 'a Live paste link');
assert.equal(normalizeAvatar(`${M}/f/screenshots/avatar-1.png`).url, `${M}/f/screenshots/avatar-1.png`, 'a media file');
assert.equal(normalizeAvatar('').url, null, 'empty clears it');
assert.equal(normalizeAvatar('https://example.com/me.png').url, 'https://example.com/me.png', 'a link elsewhere is a source too, copied by Media');
assert.equal(normalizeAvatar('https://openvibe.media.evil.example/x.png').url, 'https://openvibe.media.evil.example/x.png', 'look-alike hosts are not openvibe.media');
for (const bad of ['http://openvibe.media/x.png', 'javascript:alert(1)', 'https://user:pw@openvibe.media/x.png', 'data:image/png;base64,AAAA', '../../etc/passwd'])
    assert.ok(normalizeAvatar(bad).error, `rejected: ${bad}`);

(async () => {
    const img = async () => ({ ok: true, status: 200, headers: { get: () => 'image/png' }, body: { cancel: async () => {} } });
    const html = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, body: null });
    assert.equal((await verifyImage(`${M}/x.png`, img)).ok, true);
    assert.equal((await verifyImage(`${M}/x.png`, html)).ok, false, 'a page is not a picture');

    const A = 'med_01KZK5GRQ088Y3CW1TMEF4Z4RN';
    const B = 'med_01KZK5GRQ088Y3CW1TMEF4Z4RP';
    const C = 'med_01KZK5GRQ088Y3CW1TMEF4Z4RQ';
    const db = getDb();
    await db.prepare("INSERT INTO users (id, username, password_hash, avatar_url, subject_id) VALUES (1, 'Goosely', 'x', NULL, 'usr_01KZK5GRQ088Y3CW1TMEF4Z4RM'), (2, 'legacy', 'x', 'https://evil.example/old.png', NULL)").run();

    // Media answers the internal routes; Live's push and the test's own HTTP client go through to the real thing.
    const realFetch = global.fetch;
    const ingest = [], release = [], pushes = [], pushHeaders = [];
    global.fetch = async (u, o) => {
        const url = String(u); const body = o && o.body ? JSON.parse(o.body) : null;
        if (url.endsWith('/internal/avatar-ingest')) {
            ingest.push(body);
            const id = body.url === `${M}/p/teal-holly-41/screenshot` ? B : body.url === `${M}/p/other/screenshot` ? C : A;
            return { ok: true, json: async () => ({ ok: true, object_id: id, url: `${M}/o/${id}`, reused: body.url === `${M}/o/${id}` }) };
        }
        if (url.endsWith('/internal/avatar-release')) { release.push(body); return { ok: true, json: async () => ({ ok: true, released: 1 }) }; }
        if (url.endsWith('/internal/user-avatar')) { pushes.push(body); pushHeaders.push(o.headers); return { ok: true }; }
        return realFetch(u, o);
    };

    // Network's own service token for the push (plan T2): live.avatar.write, audience openvibe.live.
    const { privateKey, publicKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const selfToken = require('../server/identity/self-token').createSelfTokens({ privateKey, issuer: 'https://openvibe.network' });
    const svc = createAvatarService({ db, config: { services: {} }, selfToken, requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'Goosely', subject_id: 'usr_01KZK5GRQ088Y3CW1TMEF4Z4RM' }; next(); } });

    // Live's picker sent a paste screenshot: it becomes the person's own avatar object, and Live is told the new
    // address (otherwise it would keep pointing at the source).
    assert.equal((await svc.fromSite({ user_id: 1, avatar_url: `${M}/f/a.png`, origin: 'live' })).changed, true);
    assert.deepStrictEqual(ingest[0], { url: `${M}/f/a.png`, user_id: 1, username: 'Goosely', subject: 'usr_01KZK5GRQ088Y3CW1TMEF4Z4RM', product: 'network', ref: '1' },
        'the source is copied into the person\'s avatar object, and the profile reference recorded');
    assert.deepStrictEqual([pushes.length, pushes[0].avatar_url], [1, `${M}/o/${A}`], 'the site learns the avatar object it now shows');
    await svc.apply(1, 'Goosely', `${M}/f/b.png`, 'network');
    assert.deepStrictEqual([pushes.length, pushes[1].avatar_url], [2, `${M}/f/b.png`], 'a change made here is pushed to the sites');
    const bearer = String(pushHeaders[0].Authorization || '').replace(/^Bearer /, '');
    const v = require('openvibe-contracts').serviceAuth.verifyServiceToken(bearer, { publicKey, issuer: 'https://openvibe.network', audience: 'openvibe.live' });
    assert.ok(v.ok && v.claims.sub === 'svc:network' && v.claims.cap.includes('live.avatar.write'), `the push carries Network's token for live.avatar.write: ${v.reason || ''}`);
    assert.equal((await svc.fromSite({ user_id: 1, avatar_url: 'https://evil.example/x.png' })).status, 422, 'a site reports our own media only');
    assert.equal(ingest.length, 1, 'a refused source is never copied');

    const app = express(); app.use('/avatar', svc.pub);
    const apiApp = express(); apiApp.use(express.json()); apiApp.use('/api/profile/avatar', svc.api);
    const srv = app.listen(0);
    const apiSrv = apiApp.listen(0);
    try {
        const b = 'http://127.0.0.1:' + srv.address().port;
        let r = await realFetch(b + '/avatar/goosely', { redirect: 'manual' }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), `${M}/f/b.png`, 'case-insensitive lookup redirects to the picture');
        assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin', 'usable in an <img> on any site');
        r = await realFetch(b + '/avatar/nobody'); assert.equal(r.status, 200); assert.ok(/svg/.test(r.headers.get('content-type')) && /<text/.test(await r.text()), 'unknown names get an initial');
        r = await realFetch(b + '/avatar/legacy', { redirect: 'manual' }); assert.equal(r.status, 200, 'a stored off-network picture is never redirected to');
        // A size asks openvibe.media for a WebP of about that width, for a media object only.
        r = await realFetch(b + '/avatar/goosely?s=96', { redirect: 'manual' }); assert.equal(r.headers.get('location'), `${M}/f/b.png`, 'a file picture is not resized');
        await svc.apply(1, 'Goosely', `${M}/o/${A}`, 'network');
        r = await realFetch(b + '/avatar/goosely?s=96', { redirect: 'manual' }); assert.equal(r.headers.get('location'), `${M}/o/${A}?w=192&fmt=webp`, 'an object picture at twice the size it is shown');
        r = await realFetch(b + '/avatar/goosely', { redirect: 'manual' }); assert.equal(r.headers.get('location'), `${M}/o/${A}`, 'no size, the picture as stored');
        r = await realFetch(b + '/avatar/goosely?s=9000', { redirect: 'manual' }); assert.equal(r.headers.get('location'), `${M}/o/${A}`, 'a size out of range is ignored');

        // The profile form: a paste link is copied, never stored as the paste's own object.
        const apiBase = 'http://127.0.0.1:' + apiSrv.address().port + '/api/profile/avatar';
        let res = await realFetch(apiBase, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'teal-holly-41' }) });
        let out = await res.json();
        assert.deepStrictEqual([res.status, out.avatar_url, out.paste], [200, `${M}/o/${B}`, 'teal-holly-41']);
        assert.strictEqual(ingest.at(-1).url, `${M}/p/teal-holly-41/screenshot`, 'the paste screenshot is the source');
        assert.strictEqual((await db.prepare('SELECT avatar_url FROM users WHERE id = 1').get()).avatar_url, `${M}/o/${B}`, 'the stored picture is the person\'s object');
        assert.strictEqual(pushes.at(-1).avatar_url, `${M}/o/${B}`, 'and every site is told about it');

        // Clearing the picture releases the profile reference, so Media can retire the object normally.
        res = await realFetch(apiBase, { method: 'DELETE' });
        assert.deepStrictEqual([res.status, (await res.json()).avatar_url], [200, null]);
        assert.deepStrictEqual(release.at(-1), { product: 'network', ref: '1' });
        assert.strictEqual((await db.prepare('SELECT avatar_url FROM users WHERE id = 1').get()).avatar_url, null);
        console.log('avatar: all checks passed');
    } finally {
        global.fetch = realFetch;
        srv.close(); apiSrv.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
