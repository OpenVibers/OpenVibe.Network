'use strict';
// The menu's network cards (frame.menu-card@1): Network fetches every open site's /.well-known/openvibe-menu.json
// every five minutes (5 s, 64 KB, no redirects), drops unknown fields and markup, validates against the contract,
// keeps a failed site's last good cards for 30 minutes, sends at most four with Live first while anyone is live,
// then in Frame rank order, and carries them in GET /api/frame, images included. One migrated test database, stubbed fetches.
//   node test/frame-cards.test.js
const assert = require('assert');
const express = require('express');
const http = require('http');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');
const { createMenuCards, cardOf, cardsOf, imageOf } = require('../server/frame/menu-cards');

const SITES = [
    { id: 'live', host: 'openvibe.live' },
    { id: 'games', host: 'openvibe.games' },
    { id: 'media-hub', host: 'openvibe.video' },
];
const NOW = Date.parse('2026-11-07T08:00:00Z');
const card = (site, over = {}) => ({
    id: `${site}-card`,
    site,
    title: 'The card',
    kind: 'rows',
    items: [{ title: 'One', meta: '1 watching', url: `https://${SITES.find((s) => s.id === site).host}/one`, image: { src: `https://${SITES.find((s) => s.id === site).host}/t/one.jpg`, w: 640, h: 360 } }],
    updated_at: '2026-11-07T08:00:00Z',
    ttl_s: 30,
    ...over,
});

// ── The sanitizer: unknown fields dropped, markup stripped, URLs checked ──
const dirty = card('live', {
    extra: 'dropped',
    title: ' Live <b>now</b> ',
    items: [
        { title: '<i>Nova</i>', meta: '<b>12</b> watching', url: 'https://openvibe.live/@nova', extra: 1, image: { src: 'https://openvibe.live/t/nova.jpg?w=640', w: 640, h: 360, alt: '<b>Nova</b> at the desk', credit: 'dropped' } },
        { title: 'Elsewhere', url: 'https://example.com/x' },
        { title: 'Video host', url: 'https://openvibe.video/v/2', image: { src: 'https://openvibe.media/t/2.jpg', w: 8, h: 1440, alt: 'x'.repeat(200) } },
        { title: 'Elsewhere image', url: 'https://openvibe.live/elsewhere', image: { src: 'https://example.com/x.jpg' } },
        { title: 'Http image', url: 'https://openvibe.live/plain', image: { src: 'http://openvibe.live/x.jpg' } },
        { title: 'Plain http', url: 'http://openvibe.live/x' },
        { url: 'https://openvibe.live/x' },
    ],
});
const clean = cardOf(dirty, SITES[0]);
assert.deepStrictEqual(Object.keys(clean).sort(), ['id', 'items', 'kind', 'site', 'title', 'ttl_s', 'updated_at']);
assert.strictEqual(clean.title, 'Live now');
assert.deepStrictEqual(clean.items, [
    { title: 'Nova', meta: '12 watching', url: 'https://openvibe.live/@nova', image: { src: 'https://openvibe.live/t/nova.jpg?w=640', w: 640, h: 360, alt: 'Nova at the desk' } },
    { title: 'Video host', url: 'https://openvibe.video/v/2', image: { src: 'https://openvibe.media/t/2.jpg', h: 1440, alt: 'x'.repeat(120) } },
    { title: 'Elsewhere image', url: 'https://openvibe.live/elsewhere' },
    { title: 'Http image', url: 'https://openvibe.live/plain' },
], 'an image on an allowed host is kept and sanitized; one from anywhere else is dropped and the item stays');
assert.deepStrictEqual(Object.keys(clean.items[0].image).sort(), ['alt', 'h', 'src', 'w'], 'unknown image fields never reach the output');
assert.strictEqual(imageOf({ src: 'https://openvibe.live/x.jpg', w: 16, h: 1920 }, SITES[0]).w, 16, 'the smallest width is kept');
assert.strictEqual(imageOf({ src: 'https://openvibe.live/x.jpg', w: 1921 }, SITES[0]).w, undefined, 'a width over 1920 is dropped');
assert.strictEqual(imageOf({ src: 'https://openvibe.live/x.jpg', w: 15.5 }, SITES[0]).w, undefined, 'a fractional width is dropped');
assert.strictEqual(cardOf(card('games'), SITES[0]), null, 'a card is refused by a host other than its site');
assert.strictEqual(cardOf(card('live', { title: 'x'.repeat(200) }), SITES[0]).title.length, 60, 'text is cut to the schema');
assert.strictEqual(cardOf(card('live', { ttl_s: 5 }), SITES[0]), null, 'a ttl under 30 is refused');
assert.strictEqual(cardOf(card('live', { updated_at: 'yesterday' }), SITES[0]), null, 'an unreadable time is refused');
assert.strictEqual(cardsOf([card('live'), card('live', { id: 'other' }), card('live', { id: 'third' }), card('live', { id: 'fourth' })], SITES[0]).length, 3, 'at most three cards per site');
assert.deepStrictEqual(cardsOf([], SITES[0]), [], 'an empty file is a valid, empty set');

// ── The ranking, the 64 KB cap and the 30-minute last-good window ──
function response(body, { status = 200, headers = {} } = {}) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

(async () => {
    let now = NOW;
    let saved = null;
    let failed = new Set();
    const fetchImpl = async (url) => {
        const site = SITES.find((s) => url.startsWith(`https://${s.host}/`));
        if (!site || failed.has(site.id)) return response('nope', { status: 503 });
        return response([card(site.id)]);
    };
    const load = async () => (saved ? { value: saved, at: now } : null);
    const save = async (v) => { saved = v; };
    let changed = 0;
    const menu = createMenuCards({ sites: () => SITES, rankOf: () => ['games', 'media-hub', 'live'], load, save, fetchImpl, now: () => now, onChange: () => { changed++; } });
    await menu.init();
    assert.deepStrictEqual(menu.cards(), []);
    await menu.refresh();
    assert.deepStrictEqual(menu.cards().map((c) => c.site), ['live', 'games', 'media-hub'], 'Live is first while it has anyone live; then Frame rank');
    assert.ok(changed > 0, 'a new set bumps the response version');
    assert.ok(saved && saved.sites.live, 'the set is saved in frame_cache');

    // Nobody live: Live's empty rail makes no card, and the rank decides.
    const emptyLive = async (url) => {
        const site = SITES.find((s) => url.startsWith(`https://${s.host}/`));
        if (!site) return response('nope', { status: 503 });
        return response([card(site.id, site.id === 'games' ? {} : { items: [] })]);
    };
    const quiet = createMenuCards({ sites: () => SITES, rankOf: () => ['games', 'media-hub', 'live'], load: async () => null, save: async () => {}, fetchImpl: emptyLive, now: () => now });
    await quiet.refresh();
    assert.deepStrictEqual(quiet.cards().map((c) => c.site), ['games'], 'an empty Live rail is skipped');

    // A site whose file fails keeps its last good card for 30 minutes, then contributes none.
    failed = new Set();
    const flaky = createMenuCards({ sites: () => SITES, rankOf: () => ['games', 'media-hub', 'live'], load: async () => null, save: async () => {}, fetchImpl, now: () => now });
    await flaky.refresh();
    failed = new Set(['live']);
    now += 29 * 60_000;
    await flaky.refresh();
    assert.ok(flaky.cards().some((c) => c.site === 'live'), 'the last good card is kept for 30 minutes');
    now += 2 * 60_000;
    await flaky.refresh();
    assert.ok(!flaky.cards().some((c) => c.site === 'live'), 'after 30 minutes without a good file the card is gone');

    // A file over 64 KB is a failure, not a huge card.
    const big = createMenuCards({
        sites: () => [SITES[1]],
        rankOf: () => ['games'],
        load: async () => null,
        save: async () => {},
        fetchImpl: async () => response('x'.repeat(70 * 1024)),
        now: () => now,
    });
    await big.refresh();
    assert.deepStrictEqual(big.cards(), [], 'a file over 64 KB is refused');

    // ── GET /api/frame?host=openvibe.chat carries the cards ──
    failed = new Set();
    now = NOW;
    const realFetch = global.fetch;
    global.fetch = fetchImpl;
    const db = getDb();
    const svc = await createFrameService(db, { services: {} }, null);
    await svc.refreshCards();
    global.fetch = realFetch;
    const payload = svc.payloadFor('openvibe.chat');
    assert.ok(Array.isArray(payload.cards), 'the Frame payload has cards');
    assert.deepStrictEqual(payload.cards.map((c) => c.site), ['live', 'games', 'media-hub'], 'Live first, then the rank');
    assert.ok(payload.cards.length <= 4);

    const app = express(); app.use('/api/frame', svc.router);
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/frame?host=openvibe.chat`);
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(body.cards[0].site, 'live');
    assert.deepStrictEqual(body.cards[0].items[0].image, { src: 'https://openvibe.live/t/one.jpg', w: 640, h: 360 }, 'an image reaches GET /api/frame');
    srv.close();

    console.log('frame menu cards: sanitize, 64 KB, Live first, rank, 30-minute last good, /api/frame carries them');
})().catch((err) => { console.error(err); process.exit(1); });
