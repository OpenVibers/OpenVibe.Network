'use strict';

// Open stats, the tool and people parts (plan L43): a tool's own host is a destination with opens today and over
// seven days, and a site's "uses" is the distinct signed-in people Network's own history counted. The tools catalog
// is injected, so the test names exactly the hosts it seeds.
//   node --import ./test/helpers/pg-preload.mjs test/open-stats-tools.test.js
const assert = require('assert');
const { getDb, initDb } = require('../server/db/database');
const { createOpenStats } = require('../server/stats/open');

(async () => {
    const db = await getDb();
    await initDb();
    const NOW = Date.parse('2026-11-09T12:00:00Z');
    const DAY = 86400000;
    const day = (back) => new Date(NOW - back * DAY).toISOString().slice(0, 10);
    const at = (back) => new Date(NOW - back * DAY).toISOString().slice(0, 19).replace('T', ' ');
    const hit = db.prepare('INSERT INTO frame_hits (day, host, hits) VALUES (?, ?, ?)');
    await hit.run(day(0), 'yt.openvibe.tools', 30);
    await hit.run(day(3), 'yt.openvibe.tools', 20);
    await hit.run(day(10), 'yt.openvibe.tools', 10);
    await hit.run(day(0), 'dns.openvibe.tools', 5);
    await hit.run(day(0), 'openvibe.tools', 7);
    await hit.run(day(0), 'openvibe.live', 99);   // Live counts its own; the beacon's row is not its number
    const user = db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)');
    await user.run(9201, 'ost1', 'x', at(1));
    await user.run(9202, 'ost2', 'x', at(2));
    const hist = db.prepare('INSERT INTO user_history (user_id, service, sub, type, title, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    await hist.run(9201, 'tools', 'yt', 'tool', 'YouTube', 'https://yt.openvibe.tools/', at(0));
    await hist.run(9202, 'tools', 'yt', 'tool', 'YouTube', 'https://yt.openvibe.tools/', at(2));
    await hist.run(9201, 'live', null, 'stream', 'Live', 'https://openvibe.live/@a', at(1));
    await hist.run(9202, 'live', null, 'stream', 'Live', 'https://openvibe.live/@b', at(2));

    const catalog = { tools: [
        { id: 'yt', name: 'YouTube downloader', url: 'https://yt.openvibe.tools/', icon: 'yt', hosts: { canonical: 'yt.openvibe.tools', short: 'yt', aliases: [] } },
        { id: 'dns', name: 'DNS lookup', url: 'https://dns.openvibe.tools/', icon: 'dns', hosts: { canonical: 'dns.openvibe.tools', short: 'dns', aliases: [] } },
    ] };
    const stats = createOpenStats({
        db, now: () => NOW, toolsOf: () => catalog, selfToken: () => null,
        fetchImpl: async () => ({ ok: false }), statusRows: () => [],
    });
    const d = await stats.collect(7);
    const tool = (id) => d.tools.find((t) => t.id === id);
    assert.ok(tool('yt') && tool('dns'), 'the tools with a beacon row are destinations');
    assert.deepStrictEqual([tool('yt').opens_24h, tool('yt').opens_7d, tool('yt').opens_prev_7d, tool('yt').change_pct], [30, 50, 10, 400]);
    assert.deepStrictEqual([tool('yt').uses_24h, tool('yt').uses_7d], [1, 2], 'distinct signed-in people, not page views');
    assert.deepStrictEqual(tool('yt').daily.map((p) => p.n), [0, 0, 0, 20, 0, 0, 30], 'seven days, oldest first');
    assert.deepStrictEqual([tool('dns').opens_7d, tool('dns').uses_7d], [5, undefined], 'a tool nobody signed in for has no made-up people count');
    assert.strictEqual(d.tools[0].id, 'yt', 'most opened tool first');
    const toolsSite = d.sites.find((s) => s.id === 'tools');
    assert.strictEqual(toolsSite.pageviews, 62, 'the Tools site still counts every tool host');
    assert.strictEqual(toolsSite.opens_7d, 62, 'its seven-day opens are the same window');
    const live = d.sites.find((s) => s.id === 'live');
    assert.deepStrictEqual([live.uses_24h, live.uses_7d], [1, 2], 'a site counts the same distinct people');
    console.log('open stats tools: tool hosts, opens and distinct people pass');
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
