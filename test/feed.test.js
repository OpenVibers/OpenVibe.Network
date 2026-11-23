'use strict';
// One feed for all of OpenVibe (feed.item@1): each source mapping, the folding of a run, the Followers
// privacy rule, the For you / Following ranking, and the menu and the feed returning the same ids.
const assert = require('assert');
const express = require('express');
const contracts = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const store = require('../server/feed/store');
const { eventToItems } = require('../server/feed/events');
const { foldWatched, foldEpisodes, cardOf, oneCardPerThing, foldCards, rankCards, searchMatches } = require('../server/feed/card');
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
    // A site going live, as Space sends it (no url in the payload): the card carries the site's address, one card a
    // site, and a rollback is not news (plan §AD.10 step 6).
    const launched = eventToItems(envelope('space.deploy.activated', { project_id: 'prj_1', site_id: 'sit_01ARZ3NDEKTSV4RRFFQ69G5FAV', site: 'band-page', deploy_id: 'dpl_1', previous_deploy_id: null, rollback: false })).items[0];
    assert.deepStrictEqual([launched.kind, launched.url, launched.title, launched.source_id], ['space', 'https://band-page.openvibe.website/', 'band-page.openvibe.website', 'sit_01ARZ3NDEKTSV4RRFFQ69G5FAV']);
    assert.deepStrictEqual(eventToItems(envelope('space.deploy.activated', { site_id: 'sit_1', site: 'band-page', deploy_id: 'dpl_2', previous_deploy_id: 'dpl_1', rollback: true })).items, [], 'a rollback is not news');
    assert.deepStrictEqual(eventToItems(envelope('space.deploy.activated', { site_id: 'sit_1', site: 'Bad Name!', deploy_id: 'dpl_3', rollback: false })).items, [], 'no address, no card');
    assert.deepStrictEqual(eventToItems(envelope('live.stream.started', { channel: { username: 'alex', url: 'https://openvibe.live/@alex' } }, { visibility: 'internal' })).items, [], 'a non-public event never enters the feed');
    assert.deepStrictEqual(eventToItems(envelope('wiki.page.deleted', { page_id: 'w1' })).remove[0], { service: 'wiki', type: 'post', id: 'w1' });

    // ── grouping: a run becomes one card, work per hour ──────
    const card = (over) => cardOf({ source_service: 'live', source_type: 'recording', source_id: over.id || 'r', kind: 'video', title: over.title || 'Recording', text: '', url: over.url || 'https://openvibe.video/watch?v=1', site: 'live', site_name: 'Live', actor_subject: over.subject || A, counts: {}, occurred_at: over.at || iso(now), media_ratio: null }, { name: 'Alex', avatar: null });
    const run = foldCards([card({ at: iso(now - 3 * 60000) }), card({ at: iso(now - 2 * 60000) }), card({ at: iso(now - 60000) })]);
    assert.strictEqual(run.length, 1);
    assert.strictEqual(run[0].group.count, 3);
    assert.strictEqual(run[0].title, 'Alex posted 3 videos');
    // Said the way the single card says it (11-14, the owner: "added 2 quests" under "finished a quest" is weird).
    const quest = (id, at) => cardOf({ source_service: 'quest', source_type: 'badge', source_id: id, kind: 'quest', title: 'Finished a quest: X', url: 'https://openvibe.quest/', site: 'quest', site_name: 'Quest', actor_subject: A, counts: {}, occurred_at: at }, { name: 'krissy', avatar: null });
    assert.strictEqual(foldCards([quest('q1', iso(now - 60000)), quest('q2', iso(now))])[0].title, 'krissy finished 2 quests');
    const one = foldCards([card({ at: iso(now - 3600000) }), card({ at: iso(now) })]);
    assert.strictEqual(one.length, 2, 'an hour apart is not a run');
    const jobs = foldCards([1, 2, 3].map((n) => cardOf({ source_service: 'work', source_type: 'job', source_id: `j${n}`, kind: 'work', title: `Job ${n}`, url: 'https://openvibe.work/jobs', site: 'work', site_name: 'Work', counts: {}, occurred_at: '2026-11-12T09:00:00.000Z' })));
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].title, '3 new jobs this hour');
    assert.strictEqual(jobs[0].group.count, 3);
    // A stream's watched card folds into its recording (11-20, register #908 "why are these duplicated?").
    {
        const A = 'usr_01KZK5GRQ088Y3CW1TMEF4Z4RM', B = 'usr_01KZK5GRQ088Y3CW1TMEF4Z4RN';
        const c = (o) => cardOf({ source_service: 'live', kind: o.kind, title: o.title || 'x', url: 'https://openvibe.live/x', site: 'live', site_name: 'Live', actor_subject: o.who, counts: o.counts || {}, ...o });
        const rec1 = c({ source_type: 'recording', source_id: '6628', kind: 'video', who: A, occurred_at: '2026-11-19T16:58:18Z', counts: { views: 4 } });
        const rec0 = c({ source_type: 'recording', source_id: '6619', kind: 'video', who: A, occurred_at: '2026-11-18T19:32:16Z' });
        const w1 = c({ source_type: 'watched', source_id: '3059', kind: 'stream', who: A, occurred_at: '2026-11-19T18:51:16Z', counts: { watchers: 2 } });
        const wB = c({ source_type: 'watched', source_id: '3056', kind: 'stream', who: B, occurred_at: '2026-11-19T18:00:00Z', counts: { watchers: 1 } });
        const wEarly = c({ source_type: 'watched', source_id: '3000', kind: 'stream', who: A, occurred_at: '2026-11-17T10:00:00Z', counts: { watchers: 9 } });
        const folded = new Map();
        const out = foldWatched([w1, rec1, rec0, wB, wEarly], folded);
        assert.deepStrictEqual(out.map((x) => x.id), ['f:live:recording:6628', 'f:live:recording:6619', 'f:live:watched:3056', 'f:live:watched:3000'],
            'the watched card goes into the recording that started last before the stream ended; another person\'s and one with no recording before it stay');
        assert.deepStrictEqual(out[0].counts, { views: 4, watchers: 2 }, 'the recording takes the watchers');
        assert.deepStrictEqual([...folded], [['f:live:watched:3059', 'f:live:recording:6628']]);
    }
    // A stream's Rundown card folds into its recording, which takes the episode's logline (11-20, register #908).
    {
        const A = 'usr_01KZK5GRQ088Y3CW1TMEF4Z4RM', B = 'usr_01KZK5GRQ088Y3CW1TMEF4Z4RN';
        const c = (o) => cardOf({ source_service: 'live', title: o.title || 'x', url: 'https://openvibe.live/x', site: 'live', site_name: 'Live', actor_subject: o.who, counts: {}, ...o });
        const rec = c({ source_type: 'recording', source_id: '6628', kind: 'video', who: A, title: 'Recording: Loud Mic', occurred_at: '2026-11-19T16:58:18Z' });
        const named = c({ source_type: 'recording', source_id: '6591', kind: 'video', who: A, title: 'Recording: TW: scary!', text: 'Their own words', occurred_at: '2026-11-17T18:42:03Z' });
        const ep = c({ source_type: 'episode', source_id: '3059', kind: 'rundown', who: A, title: 'Rundown: Loud Mic', text: 'A loud mic and bait boxes.', occurred_at: '2026-11-19T16:58:16Z' });
        const ep2 = c({ source_type: 'episode', source_id: '3048', kind: 'rundown', who: A, title: 'Rundown: Barn Twin', text: 'Barn twins.', occurred_at: '2026-11-17T18:41:20Z' });
        const other = c({ source_type: 'episode', source_id: '3056', kind: 'rundown', who: B, title: 'Rundown: Someone else', occurred_at: '2026-11-19T16:58:00Z' });
        const lonely = c({ source_type: 'episode', source_id: '3000', kind: 'rundown', who: A, title: 'Rundown: No recording', occurred_at: '2026-11-15T10:00:00Z' });
        const folded = new Map();
        const out = foldEpisodes([ep, rec, named, ep2, other, lonely], folded);
        assert.deepStrictEqual(out.map((x) => x.id), ['f:live:recording:6628', 'f:live:recording:6591', 'f:live:episode:3056', 'f:live:episode:3000'],
            'an episode goes into its recording; another person\'s, and one with no recording near it, stay');
        assert.strictEqual(out[0].text, 'A loud mic and bait boxes.', 'the recording takes the logline');
        assert.strictEqual(out[1].text, 'Their own words', 'a recording with words of its own keeps them');
        assert.deepStrictEqual([...folded], [['f:live:episode:3059', 'f:live:recording:6628'], ['f:live:episode:3048', 'f:live:recording:6591']]);
    }
    const deals = foldCards([1, 2, 3].map((n) => cardOf({ source_service: 'deals', source_type: 'offer', source_id: `d${n}`, kind: 'deal', title: `Deal ${n}`, url: 'https://openvibe.deals/d/x', site: 'deals', site_name: 'Deals', counts: {}, occurred_at: '2026-11-12T09:00:00.000Z' })));
    assert.strictEqual(deals.length, 1, 'a poll of deals is one card');
    assert.strictEqual(deals[0].title, '3 new deals');
    const pictured = foldCards([1, 2].map((n) => cardOf({ source_service: 'deals', source_type: 'offer', source_id: `p${n}`, kind: 'deal', title: `Deal ${n}`, url: 'https://openvibe.deals/d/x', site: 'deals', site_name: 'Deals', picture_url: 'https://m.media-amazon.com/images/I/x.jpg', counts: {}, occurred_at: '2026-11-12T09:00:00.000Z' })));
    assert.strictEqual(pictured[0].media, null, 'a run of deals has no one picture over it (11-14: an empty frame over "321 new deals")');
    assert.ok(pictured[0].group.items[0].media.thumb, 'each row keeps its own');
    assert.strictEqual(deals[0].group.count, 3);
    assert.match(deals[0].id, /^g:deal:deals:\d{4}-\d\d-\d\dT\d\d$/, 'a burst has one id per site and hour, the same on every page (11-12: three "112 new deals")');
    assert.strictEqual(deals[0].label, undefined, 'named by its site, never "System"');
    // feed.item@1 1.3.0 (11-15, the owner: "views … total views"): each folded item keeps its own views (counted on its
    // card before the fold) and the run carries their sum; a run with no counts says nothing.
    const counted = foldCards([5, 12, 30].map((v, n) => Object.assign(cardOf({ source_service: 'deals', source_type: 'offer', source_id: `v${n}`, kind: 'deal', title: `Deal ${n}`, url: 'https://openvibe.deals/d/x', site: 'deals', site_name: 'Deals', counts: {}, occurred_at: iso(now - n * 1000) }), { counts: { views: v } })));
    assert.deepStrictEqual(counted[0].group.items.map((x) => x.views).sort((a, b) => a - b), [5, 12, 30], 'each item its own views');
    assert.strictEqual(counted[0].group.views, 47, 'the run, all of them');
    assert.strictEqual(deals[0].group.views, undefined, 'no counts, no total');
    { // The group as feed.item@1 1.3.0 says it (a minimal card around it; the folded card still has fields the API strips).
        const c = require('openvibe-contracts');
        const v = c.validate('feed.item@1', { id: 'g:deal:deals:2026-11-15T04', kind: 'deal', url: 'https://openvibe.deals/new', title: '3 new deals', text: '', site: 'deals', site_name: 'Deals', subject: null, at: iso(now), actor: null, media: null, counts: { views: 47, people: 3 },
            group: { ...counted[0].group, items: counted[0].group.items.map((x) => ({ ...x, url: 'https://openvibe.deals/d/x' })) } });
        assert.ok(v.valid, JSON.stringify(v.errors));
    }

    // ── one card per thing (11-13: a picture showed twice, once as itself and once as its Community thread) ──
    {
        const thumb = 'https://openvibe.community/p/lone-path-83/screenshot?w=640';
        const pic = { id: 'f:community:paste:lone-path-83', kind: 'pic', site: 'community', url: 'https://openvibe.community/p/lone-path-83', title: 'Current read', actor: null, subject: null, media: { thumb, ratio: 1.7 }, counts: { comments: 0 } };
        const thread = { id: 'f:community:thread:95', kind: 'post', site: 'community', url: 'https://openvibe.community/forum/pastes/item-55847', title: '1000012166', actor: { name: 'moosely', avatar: null }, subject: 'usr_01KKCXTAF00CY25BW615CSPHME', media: { thumb: 'https://openvibe.community/p/lone-path-83/screenshot?w=320' }, counts: { comments: 2 } };
        const reply = { id: 'f:community:post:165', kind: 'post', site: 'community', url: 'https://openvibe.community/forum/pastes/item-55847#post-165', title: 'Re: 1000012166', actor: { name: 'moosely', avatar: null }, media: null, counts: {} };
        const other = { id: 'f:community:thread:99', kind: 'post', site: 'community', url: 'https://openvibe.community/forum/general/item-9', title: 'A question', actor: { name: 'Ana', avatar: null }, media: null, counts: {} };
        const out = oneCardPerThing([thread, reply, pic, other]);
        assert.deepStrictEqual(out.map((c) => c.id), ['f:community:paste:lone-path-83', 'f:community:thread:99'], 'the thing once; its thread and the reply in it fold in; another thread stays');
        assert.strictEqual(out[0].actor.name, 'moosely', 'the thread names who posted the picture');
        assert.strictEqual(out[0].subject, 'usr_01KKCXTAF00CY25BW615CSPHME');
        assert.strictEqual(out[0].counts.comments, 2, 'its comments are counted on the thing');
        const alone = oneCardPerThing([thread]);
        assert.deepStrictEqual(alone.map((c) => c.id), ['f:community:thread:95'], 'a thread whose thing is not in the page stays');
    }

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
    // Once more on a reset: a keep-alive socket the server closed while a test was writing rows (5 s idle).
    const get = async (p, headers) => {
        let r;
        try { r = await fetch(`${base}${p}`, { headers }); } catch (e) {
            if (!(e && e.cause && e.cause.code === 'ECONNRESET')) throw e;
            r = await fetch(`${base}${p}`, { headers });
        }
        return { r, d: await r.json() };
    };

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
        // The general feed (2026-11-20) reads people's things apart from the runs and shows the newest runs in each page's
        // time: a run is never shown twice, and may not be shown at all past the last person's thing.
        assert.ok(seen.filter((id) => id === burst).length <= 1, `the burst is at most one card across the pages (${seen.join(', ')})`);
        assert.ok(seen.includes('f:community:thread:mid'), 'the post in the middle of the burst is still met');
        // Deals' own view keeps every run: the burst is one card across its pages.
        const deals = [];
        cursor = '';
        for (let page = 0; page < 8; page++) {
            const r = await get(`/api/v1/feed?site=deals&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            deals.push(...r.d.items.map((x) => x.id));
            if (!r.d.next_cursor) break;
            cursor = r.d.next_cursor;
        }
        assert.strictEqual(deals.filter((id) => id === burst).length, 1, `on Deals, the burst is one card across the pages (${deals.join(', ')})`);
    }
    // A page past the bursts (production, 11-20: 397 of the newest 401 public rows were Deals polls, so the feed, signed
    // in or not, showed five cards): the burst is still one card, and the posts under it fill the page.
    {
        const hourAt = new Date(Date.now() - 20 * 60000);
        for (let i = 0; i < 400; i++) {
            await store.upsertItem(db, { source_service: 'deals', source_type: 'offer', source_id: `flood${i}`, kind: 'deal', title: `Flood ${i}`, text: '', url: 'https://openvibe.deals/d/f', site: 'deals', site_name: 'Deals', counts: {}, occurred_at: new Date(hourAt.getTime() - i * 1000).toISOString(), visibility: 'public' });
        }
        for (let i = 0; i < 12; i++) {
            await store.upsertItem(db, { source_service: 'community', source_type: 'thread', source_id: `under${i}`, kind: 'post', title: `Under the flood ${i}`, text: 'hello', url: `https://openvibe.community/forum/status/under${i}`, site: 'community', site_name: 'Community', counts: {}, occurred_at: new Date(Date.now() - (2 + i) * 3600000).toISOString(), visibility: 'public' });
        }
        const r = await get('/api/v1/feed?limit=20');
        const titles = r.d.items.map((x) => x.title);
        const posts = titles.filter((t) => /^Under the flood/.test(t));
        assert.ok(posts.length >= 10, `the posts under the burst fill the page (${titles.join(' | ')})`);
        const floods = r.d.items.filter((x) => x.kind === 'deal' && /^g:deal:deals:/.test(x.id));
        assert.ok(floods.length >= 1 && floods.every((x) => /new deals$/.test(x.title)), 'the burst is still there, one card for its hour');
        assert.strictEqual(new Set(r.d.items.map((x) => x.id)).size, r.d.items.length, 'no card twice');
        if (r.d.next_cursor) {
            const n = await get(`/api/v1/feed?limit=20&cursor=${encodeURIComponent(r.d.next_cursor)}`);
            const again = n.d.items.filter((x) => floods.some((f) => f.id === x.id));
            assert.strictEqual(again.length, 0, 'the next page does not show the burst again');
        }
    }
    // An item's discussion thread is the item's comments, not a card (11-20: the paste and its thread "1000012166").
    {
        const at = (m) => new Date(Date.now() - m * 60000).toISOString();
        await store.upsertItem(db, { source_service: 'community', source_type: 'paste', source_id: 'lone-path', kind: 'pic', title: 'Current read, it is so thin', text: '', url: 'https://openvibe.community/p/lone-path', site: 'itemdemo', site_name: 'Community', actor_subject: A, counts: {}, occurred_at: at(30), visibility: 'public' });
        await store.upsertItem(db, { source_service: 'community', source_type: 'thread', source_id: 'itd1', kind: 'post', title: '1000012166', text: '', url: 'https://openvibe.community/forum/pastes/item-55847', site: 'itemdemo', site_name: 'Community', actor_subject: A, counts: {}, occurred_at: at(25), visibility: 'public' });
        await store.upsertItem(db, { source_service: 'community', source_type: 'post', source_id: 'itd2', kind: 'post', title: 'Re: 1000012166', text: '.', url: 'https://openvibe.community/forum/pastes/item-55847#post-165', site: 'itemdemo', site_name: 'Community', actor_subject: A, counts: {}, occurred_at: at(20), visibility: 'public' });
        await store.upsertItem(db, { source_service: 'community', source_type: 'thread', source_id: 'itd3', kind: 'post', title: 'A forum thread', text: 'hi', url: 'https://openvibe.community/forum/status/t9', site: 'itemdemo', site_name: 'Community', actor_subject: A, counts: {}, occurred_at: at(15), visibility: 'public' });
        const r = await get('/api/v1/feed?site=itemdemo&limit=10');
        assert.deepStrictEqual(r.d.items.map((x) => x.title).sort(), ['A forum thread', 'Current read, it is so thin'], JSON.stringify(r.d.items.map((x) => x.title)));
        assert.strictEqual(store.isItemDiscussionUrl('https://openvibe.community/forum/clips/item-23'), true);
        assert.strictEqual(store.isItemDiscussionUrl('https://openvibe.community/forum/status/t9'), false);
    }
    // Pages are stretches of time, newest first (11-23, the owner: "Timestamps are still screwed up all over in the feed";
    // a ranked page led with an older liked card and the next page went back up to minutes ago under older day lines):
    // across pages every card is older than the one before, each shows once, and a site's own page skips nothing.
    {
        for (let i = 1; i <= 6; i++) {
            await store.upsertItem(db, { source_service: 'community', source_type: 'thread', source_id: `ranked${i}`, kind: 'post', title: `Ranked ${i}`, text: 'hello',
                url: `https://openvibe.community/forum/status/ranked${i}`, site: 'rankdemo', site_name: 'Community', counts: i === 5 ? { likes: 500 } : {},
                occurred_at: new Date(Date.now() - i * 3600000).toISOString(), visibility: 'public' });
        }
        const ids = [];
        let cursor = '';
        for (let page = 0; page < 6; page++) {
            const r = await get(`/api/v1/feed?site=rankdemo&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            ids.push(...r.d.items.map((x) => x.id));
            if (!r.d.next_cursor) break;
            cursor = r.d.next_cursor;
        }
        assert.deepStrictEqual(ids, [1, 2, 3, 4, 5, 6].map((i) => `f:community:thread:ranked${i}`), `newest first across pages, each once, none skipped (${ids.join(', ')})`);
    }
    // The general feed, page after page, never goes back up in time (the caps leave cards out; they never come back
    // under older ones): every card, page by page, is no newer than the one before it.
    {
        const stamps = [];
        let cursor = '';
        for (let page = 0; page < 40; page++) {
            const r = await get(`/api/v1/feed?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            for (const x of r.d.items) if (!(x.kind === 'live' && x.live_now === true)) stamps.push([x.at, x.id]);
            if (!r.d.next_cursor) break;
            cursor = r.d.next_cursor;
        }
        assert.ok(stamps.length > 5, `the general feed has pages (${stamps.length} cards)`);
        for (let i = 1; i < stamps.length; i++) {
            assert.ok(Date.parse(stamps[i][0]) <= Date.parse(stamps[i - 1][0]), `card ${i} (${stamps[i][1]} at ${stamps[i][0]}) is newer than the one before it (${stamps[i - 1][1]} at ${stamps[i - 1][0]})`);
        }
        assert.strictEqual(new Set(stamps.map((s) => s[1])).size, stamps.length, 'no card twice across pages');
    }
    // The general feed reads people's things apart from the runs (production, 11-20: 11,389 of 11,500 public rows in
    // three days were Deals rows; the newest stream sat 3,600 rows down): a stream under 600 deal and 60 job rows is on
    // the first page; a run of jobs is counted whole (not the 20 rows drawn); an older Report line of the same kind is
    // gone (a stale number under the new one), another kind stays.
    {
        const t0 = Date.now();
        const at = (msAgo) => new Date(t0 - msAgo).toISOString();
        const row = (o) => store.upsertItem(db, { text: '', site_name: o.site, counts: {}, visibility: 'public', ...o });
        for (let i = 0; i < 600; i++) await row({ source_service: 'deals', source_type: 'offer', source_id: `deep${i}`, kind: 'deal', title: `Deep ${i}`, url: 'https://openvibe.deals/d/q', site: 'deals', occurred_at: at(60000 + i * 1000) });
        const jobHour = new Date(t0 - 90 * 60000); jobHour.setUTCMinutes(10, 0, 0);
        for (let i = 0; i < 60; i++) await row({ source_service: 'work', source_type: 'job', source_id: `job${i}`, kind: 'work', title: `Job ${i}`, url: `https://openvibe.work/jobs/${i}`, site: 'work', occurred_at: new Date(jobHour.getTime() + i * 1000).toISOString() });
        await row({ source_service: 'live', source_type: 'stream', source_id: 'deepstream', kind: 'stream', title: 'A stream under the runs', url: 'https://openvibe.live/@deep', site: 'live', occurred_at: at(3 * 3600000) });
        await row({ source_service: 'report', source_type: 'peak', source_id: 'peak-old', kind: 'report', title: 'Peak today: 1,768 people online at once', url: 'https://openvibe.report/stats', site: 'report', occurred_at: at(40 * 60000) });
        await row({ source_service: 'report', source_type: 'peak', source_id: 'peak-new', kind: 'report', title: 'Peak today: 5 people online at once', url: 'https://openvibe.report/stats', site: 'report', occurred_at: at(10 * 60000) });
        await row({ source_service: 'report', source_type: 'views', source_id: 'views-old', kind: 'report', title: '688,822 page views in the last 30 days', url: 'https://openvibe.report/stats', site: 'report', occurred_at: at(40 * 60000) });
        const r = await get('/api/v1/feed?limit=20');
        const titles = r.d.items.map((x) => x.title);
        assert.ok(titles.includes('A stream under the runs'), `a stream under 600 deals is on the first page (${titles.join(' | ')})`);
        assert.ok(titles.includes('Peak today: 5 people online at once') && !titles.includes('Peak today: 1,768 people online at once'), 'only the newest peak');
        assert.ok(titles.includes('688,822 page views in the last 30 days'), 'the newest of another kind stays');
        const runs = r.d.items.filter((x) => /^g:/.test(String(x.id)));
        assert.ok(runs.length >= 1 && runs.length <= 2, `one or two runs on a page of 20 (${runs.map((x) => x.title).join(' | ')})`);
        assert.strictEqual(new Set(r.d.items.map((x) => x.id)).size, r.d.items.length, 'no card twice');
        // A page of 40 has room for four runs: the jobs run is one of them and says the whole hour (60, not the 20 drawn).
        const big = await get('/api/v1/feed?limit=40');
        const jobs = big.d.items.find((x) => /^g:work:/.test(String(x.id)));
        assert.ok(jobs, `the jobs run is on a page of 40 (${big.d.items.filter((x) => /^g:/.test(String(x.id))).map((x) => x.title).join(' | ')})`);
        assert.deepStrictEqual([jobs.title, jobs.group.count], ['60 new jobs this hour', 60], 'a run of jobs is counted whole');
        const { listRuns } = store;
        const all = await listRuns(db, { from: t0 - 6 * 3600000, limit: 10 });
        const work = all.find((x) => x.kind === 'work');
        assert.deepStrictEqual([work.n, work.hour], [60, jobHour.toISOString().slice(0, 13)], 'listRuns: one row per kind, site and hour, counted');
        const left = await listRuns(db, { from: t0 - 6 * 3600000, limit: 10, skip: [{ kind: 'work', site: 'work', hour: work.hour }] });
        assert.ok(!left.some((x) => x.kind === 'work'), 'a run an earlier page showed is skipped');
    }
    server.close();
    console.log('feed: mappings, grouping, privacy, ranking and the menu/feed ids pass');
})().catch((err) => { console.error(err); process.exit(1); });
