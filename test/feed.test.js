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
    {
        const g = eventToItems(envelope('network.module.updated', { namespace: 'games.progress.summary', change: 'updated', owner: { type: 'user', id: A }, public: { level: 15 } }, { source: 'network' }));
        assert.deepStrictEqual([g.items[0].kind, g.items[0].source_id, g.items[0].title], ['game', `${A}:15`, 'Reached level 15 in an OpenVibe game']);
    }
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
    const deals = foldCards([1, 2, 3].map((n) => cardOf({ source_service: 'deals', source_type: 'offer', source_id: `d${n}`, kind: 'deal', title: `Deal ${n}`, url: 'https://openvibe.deals/d/x', site: 'deals', site_name: 'Deals', counts: {}, occurred_at: '2026-11-12T09:00:00.000Z' })));
    assert.strictEqual(deals.length, 1, 'a poll of deals is one card');
    assert.strictEqual(deals[0].title, '3 new deals');
    assert.strictEqual(deals[0].group.count, 3);
    assert.match(deals[0].id, /^g:deal:deals:\d{4}-\d\d-\d\dT\d\d$/, 'a burst has one id per site and hour, the same on every page (11-12: three "112 new deals")');
    assert.strictEqual(deals[0].label, undefined, 'named by its site, never "System"');

    // ── Markdown and relative addresses (11-12: the menu printed "[title](/p/x) ![title](/p/x/screenshot)") ──
    const shared = cardOf({ source_service: 'community', source_type: 'thread', source_id: '95', kind: 'post', title: '1000012166',
        text: '[1000012166](/p/lone-path-83) ![1000012166](/p/lone-path-83/screenshot)', url: '/forum/status/x', site: 'community', counts: {}, occurred_at: '2026-11-12T16:00:00Z', origin: 'user' });
    assert.strictEqual(shared.text, '', 'a body that only repeats the title is dropped');
    assert.strictEqual(shared.media.thumb, 'https://openvibe.community/p/lone-path-83/screenshot?w=640', 'its picture, on Community, the small copy');
    assert.strictEqual(shared.url, 'https://openvibe.community/forum/status/x', 'a relative address is on its own site');
    const words = cardOf({ source_service: 'community', source_type: 'thread', source_id: '93', kind: 'post', title: 'UR',
        text: '[UR](https://openvibe.video/c/46) ![UR](https://openvibe.media/t/clip-46.jpg) Shared by **Maticus**', url: 'https://openvibe.community/t/93', site: 'community', counts: {}, occurred_at: '2026-11-12T16:00:00Z' });
    assert.strictEqual(words.text, 'UR Shared by Maticus', 'links keep their words, pictures and marks go');
    assert.strictEqual(words.media.thumb, 'https://openvibe.media/t/clip-46.jpg');
    const paste = cardOf({ source_service: 'community', source_type: 'paste', source_id: 'lone-path-83', kind: 'pic', title: 'A read', text: '# Current read',
        picture_url: 'https://openvibe.media/o/med_01M78B3X3FSAA9V8DRERBV4DTT', url: 'https://openvibe.community/p/lone-path-83', site: 'community', counts: {}, occurred_at: '2026-11-12T16:00:00Z' });
    assert.strictEqual(paste.media.thumb, 'https://openvibe.community/p/lone-path-83/screenshot?w=640', 'a paste\'s picture comes from Community (Media keeps it private), never a 404');
    assert.strictEqual(paste.text, 'Current read', 'a heading mark goes');

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
    // A Deals poll (11-12: the menu showed "112 new deals" three times, one per page): the burst is one card counted
    // whole, and the next page goes past it to the burst before.
    {
        const mid = new Date(Date.now() - 2 * 86400000); mid.setUTCMinutes(30, 0, 0);
        for (let i = 0; i < 30; i++) {
            await store.upsertItem(db, { source_service: 'deals', source_type: 'offer', source_id: `burst${i}`, kind: 'deal', title: `Deal ${i}`, text: '', url: 'https://openvibe.deals/d/x', site: 'deals', site_name: 'Deals', counts: {}, occurred_at: new Date(mid.getTime() - i * 1000).toISOString(), origin: 'system' });
        }
        await store.upsertItem(db, { source_service: 'deals', source_type: 'offer', source_id: 'older', kind: 'deal', title: 'Older deal', text: '', url: 'https://openvibe.deals/d/y', site: 'deals', site_name: 'Deals', counts: {}, occurred_at: new Date(mid.getTime() - 3 * 3600000).toISOString(), origin: 'system' });
        const p1 = await get('/api/v1/feed?site=deals&limit=1');
        assert.strictEqual(p1.d.items.length, 1);
        assert.strictEqual(p1.d.items[0].title, '30 new deals', 'the whole burst, counted once');
        assert.strictEqual(p1.d.items[0].label, undefined, 'named by its site, not "System"');
        assert.ok(p1.d.next_cursor, 'more after it');
        const p2 = await get(`/api/v1/feed?site=deals&limit=1&cursor=${encodeURIComponent(p1.d.next_cursor)}`);
        assert.ok(p2.d.items.length >= 1 && p2.d.items[0].id !== p1.d.items[0].id, 'the next page is not the same burst again');
        assert.strictEqual(p2.d.items[0].title, 'Older deal', 'the deal before it, its own title (one deal is not "1 new deal")');
    }
    // A burst bigger than a page, with a person's post in the middle of it (production, 11-12: "358 new deals" on every
    // page): the burst is one card across all pages, and the post is still met.
    {
        const hourAt = new Date(Date.now() - 4 * 86400000); hourAt.setUTCMinutes(59, 0, 0);
        for (let i = 0; i < 150; i++) {
            await store.upsertItem(db, { source_service: 'deals', source_type: 'offer', source_id: `big${i}`, kind: 'deal', title: `Big ${i}`, text: '', url: 'https://openvibe.deals/d/z', site: 'deals', site_name: 'Deals', counts: {}, occurred_at: new Date(hourAt.getTime() - i * 20000).toISOString(), origin: 'system' });
        }
        await store.upsertItem(db, { source_service: 'community', source_type: 'thread', source_id: 'mid', kind: 'post', title: 'In the middle', text: 'hello', url: 'https://openvibe.community/forum/status/mid', site: 'community', site_name: 'Community', actor_subject: A, counts: {}, occurred_at: new Date(hourAt.getTime() - 75 * 20000 - 5000).toISOString() });
        const seen = [];
        let cursor = '';
        for (let page = 0; page < 8; page++) {
            const r = await get(`/api/v1/feed?site=&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            seen.push(...r.d.items.map((x) => x.id));
            if (!r.d.next_cursor) break;
            cursor = r.d.next_cursor;
        }
        const burst = `g:deal:deals:${hourAt.toISOString().slice(0, 13)}`;
        assert.strictEqual(seen.filter((id) => id === burst).length, 1, `the burst is one card across the pages (${seen.join(', ')})`);
        assert.ok(seen.includes('f:community:thread:mid'), 'the post in the middle of the burst is still met');
    }
    server.close();
    console.log('feed: mappings, grouping, privacy, ranking and the menu/feed ids pass');
})().catch((err) => { console.error(err); process.exit(1); });
