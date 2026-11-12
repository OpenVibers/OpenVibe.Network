'use strict';
// The public API collectors, each against a recorded input: every one writes feed.item@1 rows with the
// kind the feed draws, its own link and the source's numbers. No network: fetch is a map of URL → JSON.
const assert = require('assert');
const { getDb } = require('../server/db/database');
const { createFeedSources } = require('../server/feed/sources');

const NOW = Date.parse('2026-11-12T09:00:00.000Z');
const A = 'usr_01JQ8Z6K6M0V8Y2Q3R4S5T6V7W';

function fakeFetch(routes) {
    return async (url) => {
        const u = String(url);
        for (const [needle, body] of Object.entries(routes)) {
            if (u.includes(needle)) return { ok: true, status: 200, async json() { return typeof body === 'function' ? body(u) : body; },
                async text() { return typeof body === 'function' ? body(u) : (typeof body === 'string' ? body : JSON.stringify(body)); } };
        }
        return { ok: false, status: 404, async json() { return {}; } };
    };
}

(async () => {
    const db = getDb();
    const rows = () => db.prepare('SELECT * FROM feed_items ORDER BY id').all();
    const kinds = async () => (await rows()).map((r) => r.kind);
    const make = (routes, presence = null) => createFeedSources({
        db, now: () => NOW, log: { warn() {} },
        config: { networkUrl: 'https://openvibe.network', feed: {
            communityUrl: 'https://community.test', todayUrl: 'https://today.test', questUrl: 'https://quest.test',
            playUrl: 'https://play.test', memeUrl: 'https://meme.test', picsUrl: 'https://pics.test', liveUrl: 'https://live.test',
            spaceUrl: 'https://space.test', workUrl: 'https://work.test', dealsUrl: 'https://deals.test',
            newsUrl: 'https://news.test', reportUrl: 'https://report.test', blogUrl: 'https://blog.test', wikiUrl: 'https://wiki.test',
        } },
        fetchImpl: fakeFetch(routes), presence,
    });

    // Community's direct public activity (no Pulse store).
    let src = make({ '/api/v1/activity': { items: [
        { id: '2', type: 'thread', title: 'A public thread', text: 'hello', url: 'https://openvibe.community/forum/status/t', actor: A, at: new Date(NOW - 60_000).toISOString(), counts: { likes: 3, comments: 1 } },
        { id: 'shot', type: 'paste', title: 'A screenshot', url: 'https://openvibe.community/p/shot', picture_url: 'https://openvibe.media/t/shot.jpg', at: new Date(NOW - 120_000).toISOString() },
    ] } });
    assert.strictEqual(await src.communityActivity(), 2);
    let row = (await rows()).find((r) => r.source_id === '2');
    assert.deepStrictEqual([row.kind, row.actor_subject, row.counts.likes], ['post', A, 3]);
    assert.strictEqual((await rows()).find((r) => r.source_id === 'shot').kind, 'pic');

    // Today's calendar.
    src = make({ '/api/v1/events': { events: [{ id: 'tev_1', title: 'A stream', starts_at: new Date(NOW + 86400000).toISOString(), created_at: new Date(NOW).toISOString(), visibility: 'public', url: 'https://openvibe.today/e/tev_1', owner_subject: A }] } });
    assert.strictEqual(await src.todayEvents(), 1);
    assert.strictEqual((await rows()).find((r) => r.source_id === 'tev_1').kind, 'event');

    // Quest badges for a recent actor.
    src = make({ '/badges': { badges: [{ id: 'first-broadcast', name: 'First Broadcast', awarded_at: new Date(NOW - 3600000).toISOString() }] } });
    await src.questBadges();
    assert.strictEqual((await rows()).some((r) => r.kind === 'quest'), true);

    // Play achievements.
    src = make({ '/api/v1/achievements/feed': { items: [{ id: 'a1', player: A, title: 'scraplandia', title_name: 'Scraplandia', name: 'First landing', description: '', unlocked_at: new Date(NOW - 3600000).toISOString() }], next: null } });
    assert.strictEqual(await src.playAchievements(), 1);
    assert.strictEqual((await rows()).find((r) => r.source_id === `${A}:scraplandia:a1`).kind, 'game');

    // Meme entries.
    src = make({ '/api/v1/entries': { entries: [{ id: 'mem_1', slug: 'a-meme', title: 'A meme', summary: 'with receipts', visibility: 'public', published_at: new Date(NOW - 3600000).toISOString() }], next_cursor: null } });
    assert.strictEqual(await src.memeEntries(), 1);
    assert.strictEqual((await rows()).find((r) => r.source_id === 'a-meme').kind, 'meme');

    // Pics gallery.
    src = make({ '/api/v1/gallery': { pictures: [{ id: 'pic_01M6SV8E153FM2T70WAF14TB4W', listed: true, title: 'A picture', author: 'Alex', links: { page: 'https://openvibe.pics/p/1', thumb: 'https://openvibe.media/t/1.jpg' }, published_at: new Date(NOW - 3600000).toISOString(), width: 1200, height: 800 }], next: null } });
    assert.strictEqual(await src.publicPictures(), 1);
    assert.strictEqual((await rows()).find((r) => r.kind === 'pic' && r.source_service === 'pics').source_service, 'pics');

    // Live: on air, recordings and clips; the Rundown episodes.
    src = make({
        '/api/streams': { streams: [{ id: 9, username: 'alex', display_name: 'Alex', title: 'a stream', started_at: '2026-11-12 08:55:00' }] },
        '/api/content/feed': { sources: { vods: 'ok', clips: 'ok' }, items: [
            { kind: 'vod', id: 'r1', href: 'https://openvibe.video/watch?v=r1', title: 'A stream', created_at: '2026-11-12 07:00:00', channel: { username: 'alex', display_name: 'Alex' }, duration_seconds: 3600 },
            { kind: 'clip', id: 'c1', href: 'https://openvibe.live/clip/c1', title: 'A clip', created_at: '2026-11-12 08:00:00', channel: { username: 'alex' } },
        ], next: null },
        '/api/rundown/streams': { streams: [{ stream_id: 3005, user: { username: 'alex', display_name: 'Alex' }, title: 'An episode', started_at: '2026-11-11 20:00:00', live: false, episode: { title: 'The case for a feed', logline: 'A logline', audience: 'public', aired_at: '2026-11-11 21:00:00' }, thumbnail_url: 'https://openvibe.media/t/e.jpg' }], next: null },
    });
    assert.ok(await src.publicContent() >= 2);
    assert.ok((await rows()).some((r) => r.kind === 'live' && r.live_now === true));
    assert.ok((await rows()).some((r) => r.kind === 'video'));
    assert.ok((await rows()).some((r) => r.kind === 'clip'));
    await src.rundownEpisodes();
    assert.ok((await rows()).some((r) => r.kind === 'rundown'));

    // "312 people watched …": Network's own ended-stream analytics.
    await db.prepare(`INSERT INTO creator_streams (stream_id, creator_subject, title, started_at, ended_at, duration_seconds, peak_viewers, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(4242, A, 'The evening stream', new Date(NOW - 7200000).toISOString(), new Date(NOW - 3600000).toISOString(), 3600, 312, new Date(NOW).toISOString());
    assert.strictEqual(await src.watchedTogether(), 1);
    const watched = (await rows()).find((r) => r.source_id === '4242');
    assert.deepStrictEqual([watched.kind, watched.counts.watchers], ['stream', 312]);

    // Spaces.
    src = make({ '/api/v1/apps/gallery': { spaces: [{ id: 'spc_01M6SV8E153FM2T70WAF14TB4W', name: 'A space', url: 'https://openvibe.space/s/1', published_at: NOW - 3600000, owner_name: 'Alex' }], next_cursor: null } });
    assert.strictEqual(await src.publicSpaces(), 1);
    assert.strictEqual((await rows()).find((r) => r.source_service === 'space').kind, 'space');

    // Work jobs, Deals offers, News stories.
    src = make({ '/api/v1/jobs': { jobs: [{ id: 'job_xnsvvqkfxe1kv3hcnkb0g17wfs', title: 'GIS engineer', company: 'Esri', location: 'Cardiff', remote: false, url: 'https://openvibe.work/j/1', excerpt: 'Maps', first_seen_at: new Date(NOW).toISOString() }] } });
    assert.strictEqual(await src.workJobs(), 1);
    assert.strictEqual((await rows()).find((r) => r.kind === 'work').source_service, 'work');
    src = make({ '/api/v1/offers': { offers: [{ id: 'dof_1', title: 'A deal', description: '20% off', url: 'https://openvibe.deals/d/1', created_at: new Date(NOW).toISOString(), votes: 4 }] } });
    assert.strictEqual(await src.dealOffers(), 1);
    assert.strictEqual((await rows()).find((r) => r.kind === 'deal').counts.likes, 4);
    src = make({ '/api/v1/stories': { stories: [{ id: 'sty_1', title: 'A story', summary: 'Sourced', url: 'https://openvibe.news/s/1', status: 'published', published_at: new Date(NOW).toISOString() }] } });
    assert.strictEqual(await src.newsStories(), 1);
    assert.strictEqual((await rows()).find((r) => r.kind === 'news').source_service, 'news');

    // Blog RSS and recent Wiki pages: the sources that only have a public feed/search.
    src = make({ '/feed.xml': `<rss><channel><item><title>A blog post</title><link>https://openvibe.blog/p/a</link>`
        + `<pubDate>Wed, 12 Nov 2026 08:00:00 GMT</pubDate><description>What changed this week.</description></item></channel></rss>` });
    assert.strictEqual(await src.blogPosts(), 1);
    assert.strictEqual((await rows()).find((r) => r.kind === 'update').source_service, 'blog');
    src = make({ '/api/v1/search': { results: [{ id: 'pg_01M6SV8E153FM2T70WAF14TB4W', state: 'published', visibility: 'public', title: 'A wiki page',
        url: 'https://openvibe.wiki/w/openvibe/feed', revision_published_at: new Date(NOW - 3600000).toISOString() }] } });
    assert.strictEqual(await src.wikiPages(), 1);
    assert.strictEqual((await rows()).find((r) => r.kind === 'wiki').source_service, 'wiki');

    // Report: the online peak from presence, then the day's report card with its trend.
    src = make({ '/api/v1/stats': { totals: { pageviews: 363633, change_pct: 44, sites_open: 56, accounts: 506 } } },
        { snapshot: () => ({ members: new Map([[A, { at: NOW, site: 'live' }]]), guests: 3 }) });
    assert.strictEqual(await src.samplePeak(), 1);
    assert.ok(await src.reportCard() >= 1);
    const report = (await rows()).find((r) => r.kind === 'report');
    assert.match(report.title, /people online|page views/);
    assert.ok(report.trend || report.counts.people >= 1);

    console.log('feed sources: community, today, quest, play, meme, pics, live, rundown, watch, space, work, deals, news and report map to feed.item@1');
})().catch((err) => { console.error(err); process.exit(1); });
