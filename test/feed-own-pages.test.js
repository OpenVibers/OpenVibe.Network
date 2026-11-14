'use strict';
// The feed's cards open the right page and carry their picture (plan §AB.43 and §AB.46; the owner, 11-14: "lots of broken
// and missing icons and images"; "doesn't even bring you to the right page"):
//   - a job card opens Work's own job page, never the board it came from; an event opens Today's own event page, never
//     the source's address (holidays pointed at date.nager.at's JSON API);
//   - a fetch base that is not https (an internal address) never becomes a link;
//   - a live card on air carries Live's current picture, refreshed every poll;
//   - deals read before Deals stated their pictures get them (deal-pictures walks Deals' pages past the first);
//   - a run of new jobs or deals opens the site's list of new ones, and a run of deals shows the ones with a picture first;
//   - every link the feed builds itself is a page its site has (KNOWN, recorded from production on 2026-11-14: each answered
//     200 with its own title, and those sites answer 404 for a path they do not have).
const assert = require('assert');
const { getDb } = require('../server/db/database');
const { createFeedSources } = require('../server/feed/sources');
const { foldCards, RUN_PAGE } = require('../server/feed/card');

const NOW = Date.parse('2026-11-14T15:00:00.000Z');
const KNOWN = {
    'openvibe.work': [/^\/jobs$/, /^\/jobs\/job_[A-Za-z0-9]{8,80}$/],
    'openvibe.today': [/^\/$/, /^\/e\/[A-Za-z0-9_%-]{1,120}$/],
    'openvibe.deals': [/^\/new$/, /^\/d\/[a-z0-9-]{1,160}$/],
    'openvibe.news': [/^\/$/],
    'openvibe.live': [/^\/@[A-Za-z0-9_.%-]{1,80}$/, /^\/rundown\/e\/\d{1,12}$/, /^\/api\/thumbnails\/[A-Za-z0-9._-]{1,120}$/],
    'openvibe.report': [/^\/$/, /^\/stats$/],
    'openvibe.network': [/^\/stats$/],
};
function known(url, why) {
    const u = new URL(url);
    assert.strictEqual(u.protocol, 'https:', `${why}: ${url} is https`);
    const pages = KNOWN[u.hostname];
    assert.ok(pages, `${why}: ${u.hostname} is in the known pages`);
    assert.ok(pages.some((re) => re.test(u.pathname)), `${why}: ${u.pathname} is a page ${u.hostname} has`);
}

function fakeFetch(routes) {
    return async (url) => {
        const u = String(url);
        for (const [needle, body] of Object.entries(routes)) {
            if (u.includes(needle)) return { ok: true, status: 200, async json() { return typeof body === 'function' ? body(u) : body; } };
        }
        return { ok: false, status: 404, async json() { return {}; } };
    };
}

(async () => {
    const db = getDb();
    const rows = () => db.prepare('SELECT * FROM feed_items ORDER BY id').all();
    // Production's shape: the public sites, except Live and Work read at an internal address.
    const make = (routes) => createFeedSources({
        db, now: () => NOW, log: { warn() {} },
        config: { networkUrl: 'https://openvibe.network', services: { live: { internalUrl: 'http://127.0.0.1:3000' } }, feed: {
            todayUrl: 'https://openvibe.today', workUrl: 'http://127.0.0.1:4700', dealsUrl: 'https://openvibe.deals',
            newsUrl: 'https://openvibe.news', reportUrl: 'https://openvibe.report',
        } },
        fetchImpl: fakeFetch(routes),
    });

    // ── Work and Today: their own pages ──
    let src = make({
        '/api/v1/jobs': { jobs: [{ id: 'job_yz2qr4vbs67s290keb90bgvgxx', title: 'Werkstudent', company: 'Maomao', url: 'https://www.arbeitnow.com/jobs/companies/maomao/werkstudent-1', first_seen_at: new Date(NOW - 60e3).toISOString() }] },
        '/api/v1/events': { events: [{ id: 'tev_WNZSWPBJY9RYWAGYNS0X', title: "Saint Leopold's Day", visibility: 'public', status: 'scheduled',
            starts_at: new Date(NOW + 86400e3).toISOString(), created_at: new Date(NOW - 60e3).toISOString(), url: 'https://date.nager.at/api/v3/PublicHolidays/2026/AT' }] },
    });
    await src.workJobs();
    await src.todayEvents();
    const job = (await rows()).find((r) => r.source_service === 'work');
    assert.strictEqual(job.url, 'https://openvibe.work/jobs/job_yz2qr4vbs67s290keb90bgvgxx', 'a job opens Work\'s own page (an internal fetch base is never a link)');
    const event = (await rows()).find((r) => r.source_service === 'today');
    assert.strictEqual(event.url, 'https://openvibe.today/e/tev_WNZSWPBJY9RYWAGYNS0X', 'an event opens Today\'s own page, not the source\'s API');

    // ── Live on air: its picture, refreshed each poll ──
    const live = (thumb) => make({
        '/api/streams': { streams: [{ id: 77, username: 'maticus', display_name: 'Maticus', title: 'WW3 prep', started_at: new Date(NOW - 10 * 60e3).toISOString(), thumbnail_url: thumb }] },
        '/api/content/feed': { sources: { vods: 'ok', clips: 'ok' }, items: [], next: null },
    });
    await live('/api/thumbnails/live_77_1.jpg').publicContent();
    let on = (await rows()).find((r) => r.source_service === 'live' && r.source_type === 'stream');
    assert.strictEqual(on.picture_url, 'https://openvibe.live/api/thumbnails/live_77_1.jpg', 'a live card carries Live\'s picture, on Live\'s public address');
    await live('/api/thumbnails/live_77_2.jpg').publicContent();
    on = (await rows()).find((r) => r.source_service === 'live' && r.source_type === 'stream');
    assert.strictEqual(on.picture_url, 'https://openvibe.live/api/thumbnails/live_77_2.jpg', 'the next poll moves it to the new picture');
    await live('../../etc/passwd').publicContent();
    on = (await rows()).find((r) => r.source_service === 'live' && r.source_type === 'stream');
    assert.strictEqual(on.picture_url, 'https://openvibe.live/api/thumbnails/live_77_2.jpg', 'a picture address of another shape is not taken (the last one stays)');
    known(on.url, 'a live card');
    known(on.picture_url, 'a live picture');

    // ── Deals: pictures for the offers read before Deals had them ──
    const offer = (i, pic, at) => ({ id: `dof_${String(i).padStart(26, '0')}`, url: `https://openvibe.deals/d/offer-${i}`, title: `Offer ${i}`, status: 'active',
        created_at: new Date(at).toISOString(), feed: pic ? { media: { thumb: `https://m.media-amazon.com/images/I/${i}.jpg` } } : {} });
    // Page one (the poll) as it was before Deals stated pictures: six offers, none with a picture.
    src = make({ '/api/v1/offers': { offers: [1, 2, 3, 4, 5, 6].map((i) => offer(i, false, NOW - i * 60e3)) } });
    await src.dealOffers();
    assert.strictEqual((await rows()).filter((r) => r.source_service === 'deals' && !r.picture_url).length, 6);
    // Now Deals states them; they are on pages 2 and 3, and page 4 is older than the week.
    const pages = { 2: [1, 2, 3].map((i) => offer(i, true, NOW - i * 60e3)), 3: [4, 5].map((i) => offer(i, true, NOW - i * 60e3)).concat([offer(6, false, NOW - 6 * 60e3)]),
        4: [offer(90, true, NOW - 9 * 86400e3)] };
    const asked = [];
    src = make({ '/api/v1/offers': (u) => { const p = Number(new URL(u).searchParams.get('page') || 1); asked.push(p); return { offers: pages[p] || [] }; } });
    assert.strictEqual(await src.dealPictures(), 5, 'five offers get their picture');
    assert.deepStrictEqual(asked, [2, 3, 4], 'it walks the pages past the first and stops past the week');
    const deals = (await rows()).filter((r) => r.source_service === 'deals');
    assert.strictEqual(deals.find((r) => r.source_id.endsWith('0001')).picture_url, 'https://m.media-amazon.com/images/I/1.jpg');
    assert.strictEqual(deals.find((r) => r.source_id.endsWith('0006')).picture_url, null, 'an offer Deals has no picture for keeps none');
    assert.ok(src.SOURCES.includes('deal-pictures'), 'it runs on its own schedule');
    // Nothing left to fill: no page is read.
    await db.prepare("UPDATE feed_items SET picture_url = 'https://m.media-amazon.com/images/I/6.jpg' WHERE source_service = 'deals' AND picture_url IS NULL").run();
    asked.length = 0;
    assert.strictEqual(await src.dealPictures(), 0);
    assert.deepStrictEqual(asked, [], 'nothing to fill reads nothing');

    // ── Runs: the site's list of new ones, pictures first ──
    const at = (m) => new Date(NOW - m * 60e3).toISOString();
    const jobsRun = foldCards([1, 2, 3].map((i) => ({ id: `f:work:job:${i}`, kind: 'work', site: 'work', site_name: 'Work', url: `https://openvibe.work/jobs/job_${'x'.repeat(10)}${i}`, title: `Job ${i}`, at: '2026-11-14T14:1' + i + ':00.000Z', counts: {} })), NOW);
    assert.strictEqual(jobsRun.length, 1);
    assert.strictEqual(jobsRun[0].url, 'https://openvibe.work/jobs', 'a run of jobs opens Work\'s jobs');
    const dealCard = (i, pic) => ({ id: `f:deals:offer:${i}`, kind: 'deal', site: 'deals', site_name: 'Deals', actor: null, url: `https://openvibe.deals/d/offer-${i}`, title: `Offer ${i}`,
        at: at(i), media: pic ? { thumb: `https://m.media-amazon.com/images/I/${i}.jpg` } : null, counts: {} });
    const dealsRun = foldCards([dealCard(1, false), dealCard(2, false), dealCard(3, true), dealCard(4, false), dealCard(5, true)], NOW);
    assert.strictEqual(dealsRun.length, 1);
    assert.strictEqual(dealsRun[0].url, 'https://openvibe.deals/new', 'a run of deals opens Deals\' new ones');
    assert.deepStrictEqual(dealsRun[0].group.items.map((x) => x.id), ['f:deals:offer:3', 'f:deals:offer:5', 'f:deals:offer:1', 'f:deals:offer:2', 'f:deals:offer:4'],
        'the deals with a picture come first, the rest in their order');
    for (const page of Object.values(RUN_PAGE)) known(page, 'a run\'s page');
    for (const r of await rows()) if (/^https:\/\/openvibe\.(work|today|live)\//.test(r.url)) known(r.url, `${r.source_service}/${r.source_type}`);

    console.log('feed own pages: jobs and events on their own pages, live pictures, deal pictures filled, runs open their lists, every built link is a known page');
})().catch((err) => { console.error(err); process.exit(1); });
