'use strict';
// Distinct visitors per site and day (server/frame/visitors.js; 11-16, the owner on openvibe.report/stats: "a lot of these
// stats and metrics aren't working", every site but Live showed Visitors —):
//   the same address and browser on one site is one visitor however many pages it opens; another browser, another host
//   or another day is another; Do Not Track and Global Privacy Control leave the visitor uncounted;
//   the day's salt is kept for its day only (a restart keeps the count, the next day gets a new one) and the next day
//   rolls the hashes into frame_visitor_days and deletes them; a late row for a finished day adds to its count;
//   open stats carry unique_visitors for a site from them (summed over the window), and Live keeps its own.
const assert = require('assert');
const { getDb, initDb } = require('../server/db/database');
const { createVisitors, declined } = require('../server/frame/visitors');
const { createOpenStats } = require('../server/stats/open');

(async () => {
    const db = await getDb();
    await initDb();
    let t = Date.parse('2026-11-16T09:00:00Z');
    const cache = new Map();
    const load = async (k) => (cache.has(k) ? { value: cache.get(k), at: t } : null);
    const save = async (k, v) => { cache.set(k, JSON.parse(JSON.stringify(v))); };
    const vis = createVisitors({ db, now: () => t, load, save });
    const count = async (day) => (await db.prepare('SELECT COUNT(*)::int AS n FROM frame_visitors WHERE day = ?').get(day)).n;

    // One person reading three pages on Tools: one visitor. Another browser: two. Chat: its own count.
    for (let i = 0; i < 3; i++) await vis.seen({ ip: '203.0.113.7', ua: 'Firefox', host: 'openvibe.tools' });
    await vis.seen({ ip: '203.0.113.7', ua: 'Chrome', host: 'openvibe.tools' });
    await vis.seen({ ip: '203.0.113.7', ua: 'Firefox', host: 'openvibe.chat' });
    assert.strictEqual(await count('2026-11-16'), 3, 'one visitor per address, browser and site');
    // Do Not Track or GPC: not counted.
    assert.strictEqual(await vis.seen({ ip: '198.51.100.1', ua: 'Safari', host: 'openvibe.tools', dnt: true }), false);
    assert.deepStrictEqual([declined({ headers: { dnt: '1' } }), declined({ headers: { 'sec-gpc': '1' } }), declined({ headers: {} })], [true, true, false]);
    // No address or browser is stored: a hash only, never the inputs.
    const rows = await db.prepare('SELECT v FROM frame_visitors').all();
    assert.ok(rows.every((r) => /^[A-Za-z0-9_-]{22}$/.test(r.v) && !r.v.includes('203')), 'hashes only');

    // A restart the same day keeps the salt (the same person is still one visitor).
    const again = createVisitors({ db, now: () => t, load, save });
    await again.seen({ ip: '203.0.113.7', ua: 'Firefox', host: 'openvibe.tools' });
    assert.strictEqual(await count('2026-11-16'), 3, 'a restart keeps the day\'s salt');
    const daySalt = cache.get('visitor-salt').key;

    // The next day: a new salt, yesterday rolled into a count and its hashes deleted.
    t = Date.parse('2026-11-17T08:00:00Z');
    await again.seen({ ip: '203.0.113.7', ua: 'Firefox', host: 'openvibe.tools' });
    await new Promise((ok) => setTimeout(ok, 50));
    assert.notStrictEqual(cache.get('visitor-salt').key, daySalt, 'a new salt every day');
    assert.strictEqual(await count('2026-11-16'), 0, 'yesterday\'s hashes are gone');
    const rolled = await db.prepare("SELECT host, visitors::int AS n FROM frame_visitor_days WHERE day = '2026-11-16' ORDER BY host").all();
    assert.deepStrictEqual(rolled.map((r) => [r.host, r.n]), [['openvibe.chat', 1], ['openvibe.tools', 2]]);
    // A late row for a finished day adds to it.
    await db.prepare("INSERT INTO frame_visitors (day, host, v) VALUES ('2026-11-16', 'openvibe.tools', 'latexxxxxxxxxxxxxxxxxx')").run();
    await again.rollup('2026-11-17');
    assert.strictEqual((await db.prepare("SELECT visitors::int AS n FROM frame_visitor_days WHERE day = '2026-11-16' AND host = 'openvibe.tools'").get()).n, 3, 'a late row adds');

    // byDay: the rolled days and today's live count.
    const by = await again.byDay('2026-11-16');
    assert.deepStrictEqual(by.map((r) => `${r.day} ${r.host} ${Number(r.n)}`).sort(), ['2026-11-16 openvibe.chat 1', '2026-11-16 openvibe.tools 3', '2026-11-17 openvibe.tools 1']);

    // Open stats: a site's unique_visitors over the window.
    const stats = createOpenStats({ db, now: () => t, fetchImpl: async () => ({ ok: false }) });
    const out = await stats.collect(7);
    const tools = out.sites.find((s) => s.id === 'tools');
    const chat = out.sites.find((s) => s.id === 'chat');
    assert.deepStrictEqual([tools && tools.unique_visitors, chat && chat.unique_visitors], [4, 1], `visitors per site over the window (${JSON.stringify([tools, chat].map((s) => s && s.unique_visitors))})`);
    console.log('frame-visitors: one visitor per address, browser, site and day; DNT/GPC uncounted; hashes only; the salt kept for its day; rolled up and deleted; open stats carry them');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
