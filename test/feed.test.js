'use strict';
// One feed for all of OpenVibe (feed.item@1): each source mapping, the folding of a run, the Followers
// privacy rule, the For you / Following ranking, and the menu and the feed returning the same ids.
const assert = require('assert');
const express = require('express');
const contracts = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const store = require('../server/feed/store');
const { eventToItems } = require('../server/feed/events');
const { cardOf, foldCards, rankCards, searchMatches } = require('../server/feed/card');
const { createFeedApi } = require('../server/feed/api');
const { createFrameService } = require('../server/frame/service');

const envelope = (type, payload, over = {}) => ({
    event_id: 'evt_01JQ8Z6K6M0V8Y2Q3R4S5T6V7W', event_type: type, version: 1, source: String(type).split('.')[0],
    actor: { type: 'user', id: 'usr_01JQ8Z6K6M0V8Y2Q3R4S5T6V7W' }, timestamp: '2026-11-12T09:00:00.000Z',
    visibility: 'public', subject: { type: 'user', id: 'usr_01JQ8Z6K6M0V8Y2Q3R4S5T6V7W' }, payload, ...over,
});

(async () => {
    const db = getDb();
    const A = 'usr_01JQ8Z6K6M0V8Y2Q3R4S5T6V7W';
    const B = 'usr_01JQ8Z6K6M0V8Y2Q3R4S5T6V7X';
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();

    // ── every Events mapping ─────────────────────────────────
    const kindOf = (type, payload, over = {}) => {
        const out = eventToItems(envelope(type, payload, over));
        assert.ok(out.items.length, `${type} maps to an item`);
        return out.items[0].kind;
    };
    assert.strictEqual(kindOf('live.stream.started', { channel: { username: 'alex', display_name: 'Alex', url: 'https://openvibe.live/@alex', subject: { type: 'user', id: A } }, title: 'a stream' }), 'live');
    assert.strictEqual(kindOf('mediahub.video.published', { video_id: 'v1', title: 'A video', canonical_url: 'https://openvibe.video/watch?v=v1' }), 'video');
    assert.strictEqual(kindOf('mediahub.picture.uploaded', { picture_id: 'p1', url: 'https://openvibe.media/p/1', thumb: 'https://openvibe.media/t/1.jpg' }), 'pic');
    assert.strictEqual(kindOf('games.world.published', { world_id: 'w1', title: 'A world', url: 'https://openvibe.games/w/1' }), 'game');
    assert.strictEqual(kindOf('blog.post.published', { post_id: 'b1', url: 'https://openvibe.blog/p/1', blog: { handle: 'openvibe' } }), 'update');
    assert.strictEqual(kindOf('wiki.page.published', { page_id: 'w1', url: 'https://openvibe.wiki/space/page', title: 'A page' }), 'wiki');
    assert.strictEqual(kindOf('news.story.published', { story_id: 's1', url: 'https://openvibe.news/s/1', topic: 'feeds' }), 'news');
    assert.strictEqual(kindOf('chat.room.message.created', { room: { slug: 'feed', name: 'Feed' }, created_at: '2026-11-12T09:00:00.000Z' }), 'chat');
    assert.strictEqual(kindOf('deals.offer.created', { offer_id: 'd1', title: 'A deal', url: 'https://openvibe.deals/d/1' }), 'deal');
    assert.strictEqual(kindOf('space.deploy.activated', { deploy_id: 'd1', name: 'A space', url: 'https://openvibe.space/s/1' }), 'space');
    assert.deepStrictEqual(eventToItems(envelope('live.stream.started', { channel: { username: 'alex', url: 'https://openvibe.live/@alex' } }, { visibility: 'internal' })).items, [], 'a non-public event never enters the feed');
    assert.deepStrictEqual(eventToItems(envelope('wiki.page.deleted', { page_id: 'w1' })).remove[0], { service: 'wiki', type: 'post', id: 'w1' });

    // ── grouping: a run becomes one card, work per hour ──────
    const card = (over) => cardOf({ source_service: 'live', source_type: 'recording', source_id: over.id || 'r', kind: 'video', title: over.title || 'Recording', text: '', url: over.url || 'https://openvibe.video/watch?v=1', site: 'live', site_name: 'Live', actor_subject: over.subject || A, counts: {}, occurred_at: over.at || iso(now), media_ratio: null }, { name: 'Alex', avatar: null });
    const run = foldCards([card({ at: iso(now - 3 * 60000) }), card({ at: iso(now - 2 * 60000) }), card({ at: iso(now - 60000) })]);
    assert.strictEqual(run.length, 1);
    assert.strictEqual(run[0].group.count, 3);
    assert.match(run[0].title, /Alex added 3 videos/);
    const one = foldCards([card({ at: iso(now - 3600000) }), card({ at: iso(now) })]);
    assert.strictEqual(one.length, 2, 'an hour apart is not a run');
    const jobs = foldCards([1, 2, 3].map((n) => cardOf({ source_service: 'work', source_type: 'job', source_id: `j${n}`, kind: 'work', title: `Job ${n}`, url: 'https://openvibe.work/jobs', site: 'work', site_name: 'Work', counts: {}, occurred_at: '2026-11-12T09:00:00.000Z' })));
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].title, '3 new jobs this hour');
    assert.strictEqual(jobs[0].group.count, 3);

    // ── ranking: live, followed, fresh, then older than a week ─
    const live = cardOf({ source_service: 'live', source_type: 'stream', source_id: 'l', kind: 'live', title: 'Live', url: 'https://openvibe.live/@alex', site: 'live', site_name: 'Live', actor_subject: B, live_now: true, occurred_at: iso(now - 86400000) });
    const followed = { ...card({ at: iso(now - 3600000) }), subject: B, id: 'followed' };
    const fresh = { ...card({ at: iso(now - 60000) }), subject: A, id: 'fresh' };
    const stale = { ...card({ at: iso(now - 8 * 86400000) }), subject: A, id: 'stale' };
    const ranked = rankCards([stale, followed, fresh, live], { followed: new Set([B]), now });
    assert.strictEqual(ranked[0].id, live.id, 'on air leads');
    assert.strictEqual(ranked[1].id, followed.id, 'a followed creator comes next');
    assert.strictEqual(ranked[ranked.length - 1].id, stale.id, 'older than seven days stays below the recent ones');
    assert.ok(searchMatches({ ...fresh, kind: 'clip', title: 'A clip', text: '' }, 'new clips'));

    // ── the API: signed out is public only; the wall has the same ids ─
    await store.upsertItem(db, { source_service: 'community', source_type: 'thread', source_id: '1', kind: 'post', title: 'Public post', text: 'hello', url: 'https://openvibe.community/forum/status/public', site: 'community', site_name: 'Community', actor_subject: A, counts: { likes: 2 }, occurred_at: iso(now - 120000) });
    await store.upsertItem(db, { source_service: 'community', source_type: 'thread', source_id: '2', kind: 'post', title: 'Followers post', text: 'hello', url: 'https://openvibe.community/forum/status/followers', site: 'community', site_name: 'Community', actor_subject: A, visibility: 'followers', occurred_at: iso(now - 60000) });
    const pub = await store.listItems(db, { limit: 20 });
    assert.deepStrictEqual(pub.rows.map((r) => r.title), ['Public post'], 'a followers item never reaches a signed-out read');
    const author = await store.listItems(db, { limit: 20, viewerSubject: A, followed: [] });
    assert.deepStrictEqual(author.rows.map((r) => r.title).sort(), ['Followers post', 'Public post'], 'its author sees it');
    const other = await store.listItems(db, { limit: 20, viewerSubject: B, followed: [] });
    assert.deepStrictEqual(other.rows.map((r) => r.title), ['Public post'], 'another person does not');

    const feed = createFeedApi({ db, config: {}, publicKey: '', startCollectors: false, now: () => now });
    const app = express();
    app.use('/api/v1/feed', feed.router);
    app.use('/api/frame', (await createFrameService(db, { services: {} }, null, { feed })).router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p, headers) => { const r = await fetch(`${base}${p}`, { headers }); return { r, d: await r.json() }; };

    let { r, d } = await get('/api/v1/feed?limit=20');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(d.items.map((x) => x.title), ['Public post'], 'signed out works, public items only');
    assert.ok(d.items.every((x) => /^f:/.test(x.id)), 'ids are stable source ids');
    for (const item of d.items) assert.ok(contracts.validate('feed.item@1', item).valid, `feed.item@1: ${JSON.stringify(contracts.validate('feed.item@1', item).errors)}`);
    const menu = await get('/api/frame/feed?limit=20');
    assert.deepStrictEqual(menu.d.items.map((x) => x.id), d.items.map((x) => x.id), 'the menu and the feed return the same ids');
    const wall = await get('/api/v1/feed/wall?limit=20');
    assert.deepStrictEqual(wall.d.items.map((x) => x.id), d.items.map((x) => x.id), 'the wall shows the same rows and ids');
    ({ r } = await get('/api/v1/feed?following=1'));
    assert.strictEqual(r.status, 401, 'Following needs a session');
    ({ d } = await get('/api/v1/feed/search?q=public'));
    assert.strictEqual(d.items[0].title, 'Public post');
    server.close();
    console.log('feed: mappings, grouping, privacy, ranking and the menu/feed ids pass');
})().catch((err) => { console.error(err); process.exit(1); });
