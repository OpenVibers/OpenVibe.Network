'use strict';
// A store's picture on a feed card (11-14, the owner: "broken images" on the Deals card): most sites allow pictures only
// from OpenVibe's hosts, so a card's picture from anywhere else is served by Network under a signature, never as an
// open proxy; and the day's distinct people for the Report card are counted in memory, counts only.
const assert = require('assert');
const { createPictures, ours } = require('../server/feed/pictures');
const seen = require('../server/frame/seen');

const res = () => {
    const r = { code: 0, headers: {}, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.set = (h, v) => { if (typeof h === 'string') r.headers[h] = v; else Object.assign(r.headers, h); return r; };
    r.end = (b) => { r.body = b || null; return r; };
    return r;
};

(async () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const asked = [];
    const pics = createPictures({
        privateKey: 'test-key', baseUrl: 'https://openvibe.network',
        request: async (url) => {
            asked.push(url);
            if (url === 'https://shop.example/moved.jpg') return { redirect: 'https://cdn.example/final.jpg' };
            if (url === 'https://shop.example/gone.jpg') throw Object.assign(new Error('answered 404'), { status: 502 });
            return { type: 'image/jpeg', body: PNG };
        },
    });

    assert.ok(ours('https://openvibe.community/p/x/screenshot'));
    assert.ok(ours('https://cdn.openvibe.media/a/1.jpg'));
    assert.ok(!ours('https://m.media-amazon.com/images/I/x.jpg'));
    assert.ok(!ours('https://openvibe.community.evil.example/x.jpg'));

    const ext = 'https://m.media-amazon.com/images/I/71Nl13pK-4L._AC_SR768,1024_.jpg';
    const addr = pics.addressOf(ext);
    assert.match(addr, /^https:\/\/openvibe\.network\/api\/v1\/feed\/picture\?u=[^&]+&s=[A-Za-z0-9_-]{27}$/);
    assert.strictEqual(pics.addressOf('https://openvibe.media/a/x.jpg'), 'https://openvibe.media/a/x.jpg', 'our own hosts are drawn as they are');

    const card = pics.card({ id: 'c', media: { thumb: ext, ratio: 1 }, group: { count: 2, items: [{ id: 'a', media: { thumb: ext } }, { id: 'b', media: null }] } });
    assert.strictEqual(card.media.thumb, addr);
    assert.strictEqual(card.group.items[0].media.thumb, addr);
    assert.strictEqual(card.group.items[1].media, null);

    // The route: a good signature answers the picture, kept a day; anything else is a 404 and nothing is fetched.
    const q = new URL(addr).searchParams;
    let r = res();
    await pics.handle({ query: { u: q.get('u'), s: q.get('s') } }, r);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.headers['Content-Type'], 'image/jpeg');
    assert.match(r.headers['Cache-Control'], /public, max-age=86400/);
    assert.strictEqual(r.headers['X-Content-Type-Options'], 'nosniff');
    assert.deepStrictEqual(r.body, PNG);
    r = res();
    await pics.handle({ query: { u: q.get('u'), s: q.get('s') } }, r);
    assert.strictEqual(asked.length, 1, 'the second read comes from memory');

    const n = asked.length;
    for (const query of [{ u: 'https://shop.example/other.jpg', s: q.get('s') }, { u: q.get('u'), s: 'x'.repeat(27) }, { u: q.get('u') }, { u: 'http://169.254.169.254/latest', s: pics.sign('http://169.254.169.254/latest') }, { u: 'https://openvibe.media/a/x.jpg', s: pics.sign('https://openvibe.media/a/x.jpg') }]) {
        r = res();
        await pics.handle({ query }, r);
        assert.strictEqual(r.code, 404, `refused: ${JSON.stringify(query).slice(0, 80)}`);
    }
    assert.strictEqual(asked.length, n, 'a refused address is never fetched');

    // A redirect is followed (each hop through the same guarded request); a picture that is gone is a 502 the card hides.
    r = res();
    await pics.handle({ query: { u: 'https://shop.example/moved.jpg', s: pics.sign('https://shop.example/moved.jpg') } }, r);
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(asked.slice(-2), ['https://shop.example/moved.jpg', 'https://cdn.example/final.jpg']);
    r = res();
    await pics.handle({ query: { u: 'https://shop.example/gone.jpg', s: pics.sign('https://shop.example/gone.jpg') } }, r);
    assert.strictEqual(r.code, 502);

    // A different key signs differently (the signature is Network's own).
    assert.notStrictEqual(createPictures({ privateKey: 'other' }).sign(ext), pics.sign(ext));

    // The day's distinct people: members and guests once each, a guest who signs in counted as a member, bots never.
    seen.reset();
    const T = Date.parse('2026-11-14T10:00:00.000Z');
    seen.seenMember('usr_01M7BWW49KZWY8PJEK7WRVW96T', 'live', T);
    seen.seenMember('usr_01M7BWW49KZWY8PJEK7WRVW96T', 'live', T + 1000);
    seen.seenGuest('203.0.113.1', 'Mozilla/5.0', T);
    seen.seenGuest('203.0.113.1', 'Mozilla/5.0', T + 2000);
    seen.seenGuest('203.0.113.2', 'Mozilla/5.0', T);
    seen.seenGuest('203.0.113.3', 'Googlebot/2.1', T);
    assert.deepStrictEqual(seen.today(T + 3000), { day: '2026-11-14', members: 1, guests: 2 });
    seen.forgetGuest('203.0.113.2', 'Mozilla/5.0', T + 4000);
    assert.strictEqual(seen.today(T + 5000).guests, 1);
    assert.deepStrictEqual(seen.today(Date.parse('2026-11-15T00:00:01.000Z')), { day: '2026-11-15', members: 0, guests: 0 }, 'a new UTC day starts again');
    seen.reset();

    console.log('feed pictures: a store picture through Network under a signature, never an open proxy; the day\'s people counted once');
})().catch((err) => { console.error(err); process.exit(1); });
