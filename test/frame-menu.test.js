'use strict';
// The Frame's menu data (plan 2026-10-22 track W): next from signed-in cross-site moves, the Discover order from menu
// clicks, the anonymous menu-click beacon (validation, 512-byte limit, per-IP rate limit, daily counters) and the
// pulse's public live channels. One migrated test database, no service calls except the stubs below.
//   node test/frame-menu.test.js
const assert = require('assert');
const express = require('express');
const http = require('http');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');
const { LISTED_SITES, siteForHost } = require('../server/frame/sites');

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const url = (srv, path) => `http://127.0.0.1:${srv.address().port}${path}`;

(async () => {
    const db = getDb();
    const openIds = LISTED_SITES.filter((s) => s.status === 'open').map((s) => s.id);
    for (let i = 1; i <= 5; i++) await db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(i, `menu${i}`, 'x');
    const ins = db.prepare("INSERT INTO user_history (user_id, service, type, title, url) VALUES (?, ?, 'page', 't', ?)");
    const insOld = db.prepare("INSERT INTO user_history (user_id, service, type, title, url, created_at) VALUES (?, ?, 'page', 't', ?, datetime('now', '-31 days'))");

    // A few real moves: two people came to Live from Video, one stayed into Community, one went to Tools and one to
    // Games. A month-old move (Live → Deals) must not count: the window is the last 30 days.
    await ins.run(1, 'media', 'https://openvibe.media/a');
    await ins.run(1, 'live', 'https://openvibe.live/');
    await ins.run(1, 'community', 'https://openvibe.community/');
    await ins.run(2, 'media', 'https://openvibe.media/b');
    await ins.run(2, 'live', 'https://openvibe.live/');
    await ins.run(3, 'live', 'https://openvibe.live/');
    await ins.run(3, 'tools', 'https://dns.openvibe.tools/');
    await ins.run(4, 'live', 'https://openvibe.live/');
    await ins.run(4, 'games', 'https://openvibe.games/');
    await insOld.run(5, 'live', 'https://openvibe.live/');
    await insOld.run(5, 'deals', 'https://openvibe.deals/');

    const svc = await createFrameService(db, { services: {} }, null);
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false });
    await svc.refreshRank();
    global.fetch = realFetch;

    let p = svc.payloadFor('openvibe.live');
    assert.ok(p.next && typeof p.next === 'object', 'the Frame sends next');
    assert.ok(Array.isArray(p.next.live), 'next.live exists for the live site');
    assert.ok(p.next.live.length <= 6, 'at most six places');
    assert.ok(['community', 'games', 'tools'].includes(p.next.live[0]), 'the people who moved on from Live lead its list');
    assert.ok(p.next.live.includes('community') && p.next.live.includes('tools') && p.next.live.includes('games'), 'every one-person move from Live is there');
    assert.strictEqual(p.next['media-hub'][0], 'live', 'Video → Live, the move two people made, leads Video\'s list');
    assert.ok(!p.next.live.includes('deals'), 'a move older than 30 days is not counted');
    assert.ok(!p.next.live.includes('live'), 'a site never recommends itself');
    assert.ok(p.next.live.every((id) => openIds.includes(id)), 'only open site ids');
    for (const [from, list] of Object.entries(p.next)) {
        assert.ok(openIds.includes(from), `${from} is open`);
        assert.ok(list.length <= 6 && !list.includes(from) && list.every((id) => openIds.includes(id)), `${from}'s list is open ids, at most six, never itself`);
    }
    assert.ok(p.next.deals && p.next.deals.length > 0, 'a cold site still has its hand-picked/neighbourhood places');
    assert.strictEqual(p.menu && p.menu.beacon, 'https://openvibe.network/api/frame/menu-click', 'the click beacon is advertised');
    assert.deepStrictEqual(p.discover_ids, svc.ranking().order, 'with no click data the Discover order is the frame order');

    // A click on Games (50 of them) puts it first; every open site stays in the list exactly once.
    await db.prepare("INSERT INTO menu_clicks (day, section, to_site, pos_bucket, n) VALUES (substring(ov_now(), 1, 10), 'discover', 'games', '1-2', 50), (substring(ov_now(), 1, 10), 'discover', 'live', '1-2', 1)").run();
    global.fetch = async () => ({ ok: false });
    await svc.refreshRank();
    global.fetch = realFetch;
    p = svc.payloadFor('openvibe.live');
    assert.strictEqual(p.discover_ids[0], 'games', 'a place clicked when shown comes up first');
    assert.strictEqual(p.discover_ids.length, openIds.length, 'every site keeps its chance: the list still has all of them');
    assert.strictEqual(new Set(p.discover_ids).size, openIds.length, 'no duplicates');

    // ── The click beacon ─────────────────────────────────────────────────────────────────────────────────────────
    const app = express(); app.use('/api/frame', svc.router);
    const srv = await listen(app);
    const post = async (body, headers = {}) => {
        const r = await fetch(url(srv, '/api/frame/menu-click'), { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
        return { status: r.status, cors: r.headers.get('access-control-allow-origin'), body: await r.text() };
    };
    const good = { host: 'openvibe.live', section: 'next', pos: 1, to: 'openvibe.community', kind: 'site' };
    let r = await post(good);
    assert.strictEqual(r.status, 204, 'a valid beacon answers 204');
    assert.strictEqual(r.cors, '*', 'any origin may send it');
    let row = await db.prepare("SELECT section, to_site, pos_bucket, n FROM menu_clicks WHERE day = substring(ov_now(), 1, 10) AND section = 'next' AND to_site = 'community'").get();
    assert.deepStrictEqual([row.section, row.to_site, row.pos_bucket, Number(row.n)], ['next', 'community', '1-2', 1]);
    r = await post({ ...good, section: 'not-a-section' }); assert.strictEqual(r.status, 400, 'unknown sections are refused');
    r = await post({ ...good, to: 'evil.example' }); assert.strictEqual(r.status, 400, 'only an OpenVibe host the Frame knows');
    r = await post({ ...good, kind: 'wat' }); assert.strictEqual(r.status, 400, 'unknown kinds are refused');
    r = await post({ ...good, pos: 'second' }); assert.strictEqual(r.status, 400, 'position is an integer');
    r = await post(JSON.stringify({ ...good, pad: 'x'.repeat(600) })); assert.strictEqual(r.status, 413, 'a body over 512 bytes is refused');
    r = await post({ host: 'openvibe.live', section: 'places', pos: 0, kind: 'open' }); assert.strictEqual(r.status, 204, 'the future open beacon is accepted');
    assert.strictEqual(Number((await db.prepare("SELECT n FROM menu_clicks WHERE section = 'places'").get() || {}).n || 0), 0, 'an open beacon is not a click');
    // Product domains count as the site that serves them.
    r = await post({ host: 'openvibe.pics', section: 'all', pos: 4, to: 'openvibe.homes', kind: 'site' });
    assert.strictEqual(r.status, 204);
    row = await db.prepare("SELECT to_site FROM menu_clicks WHERE section = 'all' AND to_site = 'rent'").get();
    assert.ok(row, 'openvibe.homes counts for Rent');
    srv.close();

    // Rate limit: a fresh service gets its own in-memory window. 60 valid beacons are counted, the 61st in a minute
    // is refused.
    const limited = await createFrameService(db, { services: {} }, null);
    const app2 = express(); app2.use('/api/frame', limited.router);
    const srv2 = await listen(app2);
    let ok = 0, throttled = 0;
    for (let i = 0; i < 61; i++) {
        const rr = await fetch(url(srv2, '/api/frame/menu-click'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ...good, pos: i }) });
        if (rr.status === 204) ok++; else if (rr.status === 429) throttled++;
    }
    assert.deepStrictEqual([ok, throttled], [60, 1], '60 a minute per IP, then 429');
    srv2.close();

    // ── Pulse's live channels ────────────────────────────────────────────────────────────────────────────────────
    const streams = [];
    for (let i = 0; i < 9; i++) streams.push({ id: i + 1, username: `star${i}`, display_name: `Star ${i}`, viewer_count: i, total_viewer_count: i + 1, avatar_url: i === 0 ? 'https://openvibe.media/a.png' : null });
    streams.push({ id: 20, username: 'hidden', total_viewer_count: 99, visibility: 'unlisted' });
    streams.push({ id: 21, username: 'private', total_viewer_count: 99, is_unlisted: true });
    const liveList = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.url === '/api/streams' ? { streams } : {}));
    });
    await new Promise((resolve) => liveList.listen(0, '127.0.0.1', resolve));
    const pulseSvc = await createFrameService(db, { services: { live: { internalUrl: `http://127.0.0.1:${liveList.address().port}` } } }, null);
    const app3 = express(); app3.use('/api/frame', pulseSvc.router);
    const srv3 = await listen(app3);
    const pulse = await (await fetch(url(srv3, '/api/frame/pulse'))).json();
    assert.strictEqual(pulse.live_now, 9, 'public streams only (unlisted and private are left out)');
    assert.strictEqual(pulse.live.length, 8, 'up to eight channels');
    assert.deepStrictEqual(pulse.live[0], { name: 'Star 0', url: 'https://openvibe.live/@star0', viewers: 1, avatar: 'https://openvibe.media/a.png' });
    assert.ok(!pulse.live.some((c) => c.url.endsWith('/@hidden') || c.url.endsWith('/@private')), 'never unlisted or private');
    assert.ok(pulse.live.every((c) => /^https:\/\/openvibe\.live\/@/.test(c.url) && Number.isInteger(c.viewers)), 'every channel has its Live URL and viewer count');
    srv3.close(); liveList.close();

    assert.equal(siteForHost('openvibe.video').id, 'media-hub');
    console.log('frame menu: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
