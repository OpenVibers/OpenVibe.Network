'use strict';
// The Frame's navigation order follows real use (11-07): openvibe.video had the most page views in frame_hits, yet
// Tools, Community and Space sat above Video because BASE_WEIGHT was added after normalising every score by Live's
// own analytics (69,516 page views), which flattened everyone else. This fixture is the production shape.
//   node test/frame-ranking.test.js
const assert = require('assert');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

(async () => {
    const db = getDb();
    const svc = await createFrameService(db, { services: {} }, null, { selfToken: () => 'test-token' });
    assert.deepStrictEqual(svc.ranking().order.slice(0, 7), ['live', 'tools', 'space', 'community', 'games', 'media', 'network'], 'cold start: the hand-set base order');

    for (let i = 1; i <= 4; i++) await db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(i, `rank${i}`, 'x');
    const day = "substring(ov_now(), 1, 10)";
    await db.prepare(`INSERT INTO frame_hits (day, host, hits) VALUES
        (${day}, 'openvibe.video', 2687), (${day}, 'openvibe.community', 1190), (${day}, 'openvibe.tools', 181),
        (${day}, 'openvibe.space', 16), (${day}, 'openvibe.games', 58), (${day}, 'openvibe.network', 143)`).run();
    const ins = db.prepare("INSERT INTO user_history (user_id, service, type, title, url) VALUES (?, ?, 'page', 't', ?)");
    for (let i = 0; i < 10; i++) await ins.run(i % 3 + 1, 'live', 'https://openvibe.live/');
    for (let i = 0; i < 5; i++) await ins.run(1, 'community', 'https://openvibe.community/');
    for (let i = 0; i < 3; i++) await ins.run(2, 'tools', 'https://openvibe.tools/');
    for (let i = 0; i < 2; i++) await ins.run(3, 'space', 'https://openvibe.space/');
    // Video's history service is 'media' (the brief's mapping): it must raise media-hub, not the Media API site.
    for (let i = 0; i < 4; i++) await ins.run(i % 2 + 1, 'media', 'https://openvibe.media/');

    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ summary: { total_pageviews: 69516 } }) });
    await svc.refreshRank();
    global.fetch = realFetch;

    const order = svc.ranking().order;
    const at = (id) => order.indexOf(id);
    assert.strictEqual(order[0], 'live', 'Live, the network\'s heart, is first');
    assert.ok(at('media-hub') >= 0, 'Video is in the order');
    assert.ok(at('media-hub') < at('community'), 'Video (2,687 hits) is above Community (1,190)');
    assert.ok(at('media-hub') < at('tools'), 'and above Tools');
    assert.ok(at('media-hub') < at('space'), 'and above Space');
    assert.ok(at('community') < at('tools') && at('community') < at('space'), 'real page views decide the rest, not the base weight');
    const state = svc._state();
    assert.strictEqual(Number(state.rank.scores['media-hub']), 2687, 'openvibe.video maps to the media-hub site id');
    assert.ok(Number(state.rank.scores['media-hub:history']) > 0, "history service 'media' counts for media-hub");
    assert.strictEqual(Number(state.rank.scores['media:history'] || 0), 0, 'not for the Media API site');
    console.log('frame ranking: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
