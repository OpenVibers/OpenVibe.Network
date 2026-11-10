'use strict';
// The footer strip's one read (owner, 2026-11-10): GET /api/frame/online answers who was on the network in the
// last thirty minutes and a few counts, and nothing that could identify a guest.
//   - members are signed-in people whose presence heartbeat arrived on any site; a member who hides their
//     status (the switch off, or Invisible) is counted among members and never named;
//   - guests are distinct address + user agent pairs from the page-view beacon, counted in memory only;
//   - a member and a guest are numbers only when the service holds no identifying field, and the answer
//     contains no address, no hash, and no way to tell one guest from another;
//   - Live is the first three public channels, empty when none; a site's own items come only for ?site=.
//   node test/frame-online.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const seen = require('../server/frame/seen');
const { createFrameService, stripOf } = require('../server/frame/service');
const { SITES } = require('../server/frame/sites');

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const CAT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC';
const DAN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPD';
const MIN = 60_000;

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await require('../server/identity/principals').ensureSchema(db);
const ago = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
let NOW = Date.parse('2026-11-10T10:00:00Z');
await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id, role, created_at) VALUES
    (1, 'ann', 'Ann', 'x', ?, 'user', ?), (2, 'bob', 'Bob', 'x', ?, 'streamer', ?),
    (3, 'cat', 'Cat', 'x', ?, 'user', ?), (4, 'dan', 'Dan', 'x', ?, 'user', ?)`)
    .run(ANN, ago(NOW - 2 * 86_400_000), BOB, ago(NOW - 3 * 86_400_000), CAT, ago(NOW - 4 * 86_400_000), DAN, ago(NOW - 40 * 86_400_000));
// Ann shows her status; Bob turned it off; Cat is invisible. Dan has never beaten (no presence row).
const ins = db.prepare(`INSERT INTO person_presence (subject_id, state, show_status, last_active_at, last_heartbeat_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
await ins.run(ANN, 'auto', 1, ago(NOW), ago(NOW), ago(NOW));
await ins.run(BOB, 'auto', 0, ago(NOW), ago(NOW), ago(NOW));
await ins.run(CAT, 'invisible', 1, ago(NOW), ago(NOW), ago(NOW));

// A Live edge whose list the test controls; Live is the only service /online reads over the network.
let liveRows = [{ username: 'eve', display_name: 'Eve', is_live: 1, total_viewer_count: 7 },
    { username: 'fay', display_name: 'Fay', is_live: 1, viewer_count: 3 },
    { username: 'gus', display_name: 'Gus', is_live: 1, visibility: 'unlisted' },
    { username: 'hal', display_name: 'Hal', is_live: 1, total_viewer_count: 12 }];
const edge = express();
edge.get('/api/streams', (_req, res) => res.json({ streams: liveRows }));
const edgeServer = http.createServer(edge);
await new Promise((r) => edgeServer.listen(0, '127.0.0.1', r));
const liveUrl = `http://127.0.0.1:${edgeServer.address().port}`;

const svc = await createFrameService(db, { services: { live: { internalUrl: liveUrl }, report: { internalUrl: 'http://127.0.0.1:1' } } }, null, {
    today: () => ({ new_videos_today: 4, posts_today: 3 }), now: () => NOW,
});
const app = express();
app.set('trust proxy', true);
app.use('/api/frame', svc.router);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { headers }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* */ } resolve({ status: res.statusCode, headers: res.headers, body, json }); });
    });
    req.on('error', reject); req.end();
});
const beacon = (ip, ua, query = '') => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/frame/hit${query}`, {
        method: 'POST', headers: { Origin: 'https://openvibe.live', 'User-Agent': ua, 'X-Forwarded-For': ip },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject); req.end();
});

seen.reset();
seen.seenMember(ANN, 'live', NOW - MIN);
seen.seenMember(BOB, 'games', NOW - 2 * MIN);
seen.seenMember(CAT, 'live', NOW - 3 * MIN);
seen.seenMember(DAN, 'community', NOW - 4 * MIN);   // seen, but no presence row: counted, not named

let o = await svc.online('live');
assert.strictEqual(o.members, 4, 'four signed-in people were seen, including the two who hide');
assert.strictEqual(o.guests, 0);
assert.deepStrictEqual(o.people.map((p) => p.username), ['ann'], 'only Ann may be named');
assert.deepStrictEqual(o.people[0], { name: 'Ann', username: 'ann', avatar: 'https://openvibe.network/avatar/ann?s=64', site: 'Live' });
assert.ok(!JSON.stringify(o).includes('bob') && !JSON.stringify(o).includes('cat'), 'a hidden member is never named');
assert.strictEqual(o.more, 0);
assert.deepStrictEqual(o.live, { channels: 3, watching: 22, first: [{ name: 'Eve', url: 'https://openvibe.live/@eve' }, { name: 'Fay', url: 'https://openvibe.live/@fay' }, { name: 'Hal', url: 'https://openvibe.live/@hal' }] },
    'an unlisted stream is left out; the first three public channels, by Live\'s own order');
const joined = o.counts.find((c) => c.id === 'joined');
assert.ok(joined && joined.value === 3 && joined.icon === 'members' && joined.url === 'https://openvibe.network/stats', 'people who joined this week, from Network\'s own accounts');
assert.deepStrictEqual(o.counts.filter((c) => c.id !== 'joined').map((c) => [c.id, c.value]), [['videos', 4], ['posts', 3]], 'today\'s counts come from the service that publishes them');

// Guests: the same address and user agent twice is one visitor; another browser is another; bots are not counted.
NOW += 31_000;
await beacon('203.0.113.9', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130');
await beacon('203.0.113.9', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130');
await beacon('203.0.113.10', 'Mozilla/5.0 (Macintosh) Safari/605');
await beacon('203.0.113.11', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
await beacon('203.0.113.12', 'curl/8.5.0');
o = await svc.online('live');
assert.strictEqual(o.guests, 2, 'two distinct visitors; the bot and the monitor are left out');
assert.strictEqual(o.total, 6, 'members plus guests');
assert.ok(!JSON.stringify(o).includes('203.0.113') && !JSON.stringify(o).includes('Chrome') && !/"(ip|hash|guest_id|address)"/.test(JSON.stringify(o)),
    'no address, no hash and no field that could identify a guest');
assert.deepStrictEqual(Object.keys(o).sort(), ['counts', 'guests', 'items', 'live', 'members', 'more', 'people', 'sites', 'total', 'updated', 'views_7d'], 'the read\'s whole shape');

// A signed-in beacon is a member, not a guest, and it clears the guest entry the same browser left.
NOW += 31_000;
await beacon('203.0.113.10', 'Mozilla/5.0 (Macintosh) Safari/605', '?in=1');
o = await svc.online('live');
assert.strictEqual(o.guests, 1, 'the signed-in browser is not a guest any more');

// The window: after thirty minutes a guest is gone, and so is a member.
NOW += 31 * MIN;
o = await svc.online('live');
assert.strictEqual(o.guests, 0, 'guests last thirty minutes');
assert.strictEqual(o.members, 0, 'members last thirty minutes');
assert.deepStrictEqual(o.people, []);
assert.strictEqual(o.total, 0);

// A new UTC day is a new key: yesterday's guests are not carried into it.
NOW = Date.parse('2026-11-11T00:01:00Z');
await beacon('203.0.113.20', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130');
o = await svc.online('live');
assert.strictEqual(o.guests, 1, 'each UTC day starts its own guest count');

// Live empty: no channels, no names, and the strip shows nothing for it.
liveRows = [];
NOW += 31_000;
o = await svc.online('live');
assert.deepStrictEqual(o.live, { channels: 0, watching: 0, first: [] }, 'empty when nobody is live');

// Site items: declared on a site's manifest entry, returned only for that site, and validated hard.
// The released Contracts manifest carries Live's own item first.
const shipped = await svc.online('live');
assert.deepStrictEqual(shipped.items, [{ label: 'The Rundown', icon: 'news', link: 'https://openvibe.live/rundown', line: 'What streamers talked about' }], 'the released manifest declares it');
const live = SITES.find((s) => s.id === 'live');
live.strip = [
    { label: 'The Rundown', icon: 'news', link: 'https://openvibe.live/rundown', line: 'Today\'s topics' },
    { label: 'Clips', icon: 'clapper', link: 'https://openvibe.live/clips?sort=new', count: 1284 },
    { label: 'Network page', icon: 'chart', link: 'https://openvibe.network/stats', count: 9 },
    { label: 'Bad', icon: 'news', link: 'http://openvibe.live/unsafe', count: 1 },
    { label: 'Off network', icon: 'news', link: 'https://evil.example/', count: 1 },
    { label: 'Lookalike', icon: 'news', link: 'https://openvibe.live.example.com/x', count: 1 },
    { label: 'Spoof', icon: 'news', link: 'https://openvibe.live@evil.example/x', count: 1 },
    { label: 'No number', icon: 'news', link: 'https://openvibe.live/x' },
];
NOW += 31_000;
o = await svc.online('live');
assert.deepStrictEqual(o.items.map((i) => i.label), ['The Rundown', 'Clips', 'Network page'], 'at most the valid ones, and never a fourth');
assert.deepStrictEqual(o.items[0], { label: 'The Rundown', icon: 'news', link: 'https://openvibe.live/rundown', line: 'Today\'s topics' });
assert.deepStrictEqual(o.items[1], { label: 'Clips', icon: 'clapper', link: 'https://openvibe.live/clips?sort=new', value: 1284 });
assert.deepStrictEqual(o.items[2], { label: 'Network page', icon: 'chart', link: 'https://openvibe.network/stats', value: 9 }, 'openvibe.network itself is an OpenVibe domain');
assert.deepStrictEqual((await svc.online('games')).items.map((i) => i.label), ['Play now'], 'another site gets its own items, never these');
assert.deepStrictEqual(stripOf([{ label: 'a', icon: 'news', link: 'https://openvibe.live.evil.example/x', count: 1 }]), [], 'a lookalike host is not an OpenVibe domain');
assert.deepStrictEqual((await svc.online('')).items, [], 'no site asked, no items');
const stream = SITES.find((s) => s.id === 'stream');
assert.ok(stream, 'OpenRestream is a site whose service id is openre');
stream.strip = [{ label: 'Restream', icon: 'live', link: 'https://openre.stream/', line: 'One broadcast, every platform' }];
assert.deepStrictEqual((await svc.online('openre')).items.map((i) => i.label), ['Restream'], 'a footer may ask by its service id');
delete stream.strip;
delete live.strip;
assert.deepStrictEqual(stripOf([{ label: '<b>Hi</b>', icon: 'news', link: 'https://openvibe.live/', line: 'x'.repeat(200) }]),
    [{ label: 'Hi', icon: 'news', link: 'https://openvibe.live/', line: 'x'.repeat(40) }], 'markup gone, text capped');
assert.deepStrictEqual(stripOf([{ label: 'a', icon: 'news', link: 'https://openvibe.live/', count: -1, line: '' }]), [], 'a negative number is not a count');
assert.deepStrictEqual(stripOf([{ label: 'a', icon: 'news', link: 'https://openvibe.live/', count: 1.5 }]), [], 'a count is a whole number');

// The route itself: public, CORS *, cached 30 s here and at the edge.
NOW += 31_000;
const r = await get('/api/frame/online?site=live');
assert.strictEqual(r.status, 200);
assert.strictEqual(r.headers['access-control-allow-origin'], '*');
assert.strictEqual(r.headers['cache-control'], 'public, max-age=30, stale-while-revalidate=120');
assert.strictEqual(r.json.members, 0);
assert.strictEqual(r.json.sites > 0, true);
assert.strictEqual(r.status === 200 && typeof r.json.updated === 'string', true);
const r2 = await get('/api/frame/online?site=live');
assert.strictEqual(r2.json.updated, r.json.updated, 'held 30 s in the service');
NOW += 31_000;
const r3 = await get('/api/frame/online?site=%3Cscript%3E');
assert.strictEqual(r3.status, 200);
assert.deepStrictEqual(r3.json.items, [], 'a junk site id is no site');

await new Promise((r) => server.close(r));
await new Promise((r) => edgeServer.close(r));
console.log('frame-online: members and guests in the last thirty minutes, hidden members counted and never named, no address or hash in the answer, live and counts and a site\'s own items');
})().catch((err) => { console.error(err); process.exit(1); });
