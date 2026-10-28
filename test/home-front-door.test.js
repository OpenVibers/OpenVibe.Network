'use strict';
// The front door (plan T11, D93): the hero's intents are real links, the constellation names the open sites, and
// "Right now on OpenVibe" shows only public, safe-for-work items from each service's public API, with an honest empty
// state. Rendered in-process; the activity reads are switched off and the snapshot is set directly.
const assert = require('assert');
const activity = require('../server/home/activity');
const home = require('../server/home/render');
const sites = require('../server/frame/sites').SITES;

activity.setEnabled(false);

// Mapping from each service's public answer.
const live = activity.liveStreams({ streams: [
    { is_live: 1, is_nsfw: 0, username: 'alice', display_name: 'Alice', title: 'Morning coding', thumbnail_url: '/api/thumbnails/a.jpg', viewer_count: 3, category: 'tech', avatar_url: 'https://openvibe.media/avatar/alice' },
    { is_live: 1, is_nsfw: 1, username: 'hidden', title: 'nsfw' },
    { is_live: 0, username: 'offline', title: 'ended' },
    { is_live: 1, is_nsfw: 0, username: 'bob', title: 'Big stream', thumbnail_url: 'javascript:alert(1)', total_viewer_count: 1200 },
] });
assert.deepStrictEqual(live.map((s) => s.name), ['bob', 'Alice'], 'live and SFW only, most watched first');
assert.strictEqual(live[1].thumb, 'https://openvibe.live/api/thumbnails/a.jpg', 'a relative thumbnail becomes the public https URL');
assert.strictEqual(live[0].thumb, null, 'a non-https thumbnail is dropped');
assert.strictEqual(live[1].url, 'https://openvibe.live/@alice');
// No thumbnail is no picture (it was openvibe.live's home page, drawn as a blank box): the card falls back to the avatar.
const bare = activity.liveStreams({ streams: [{ is_live: 1, username: 'cara', title: 't', thumbnail_url: null, avatar_url: 'https://openvibe.media/o/med_1' }, { is_live: 1, username: 'dee', title: 't', thumbnail_url: '', avatar_url: '' }] });
assert.deepStrictEqual(bare.map((s) => [s.thumb, s.avatar]), [[null, 'https://openvibe.media/o/med_1'], [null, null]]);

const pastes = activity.publicPastes({ pastes: [
    { slug: 'one', title: 'Public one', visibility: 'public', type: 'code', language: 'js' },
    { slug: 'two', title: 'Unlisted', visibility: 'unlisted' },
    { slug: 'three', title: 'Burns', visibility: 'public', burn_after_read: true },
    { slug: 'four', title: 'NSFW', visibility: 'public', is_nsfw: true },
    { slug: 'five', title: 'Shot', visibility: 'public', type: 'screenshot', ai_summary: 'a desk' },
] });
assert.deepStrictEqual(pastes.map((p) => p.url), ['https://openvibe.community/p/one', 'https://openvibe.community/p/five'], 'public, lasting and SFW only');
assert.deepStrictEqual([pastes[0].kind, pastes[1].kind], ['js', 'Screenshot']);

const posts = activity.blogPosts({ items: [{ url: 'https://openvibe.blog/@a/b', title: 'Post', summary: 'x' }, { url: 'http://evil.example/', title: 'bad' }] });
assert.deepStrictEqual(posts.map((p) => p.url), ['https://openvibe.blog/@a/b'], 'only https links');

// Recordings: public, ready, ten minutes or more, one per channel, opened on OpenVibe.Video with Media's thumbnail.
const recs = activity.recordings({ vods: [
    { id: 9, username: 'gus', title: 'Long one', status: 'ready', visibility: 'public', duration_seconds: 4000, thumbnail_url: 'https://openvibe.media/t/vod-9.jpg' },
    { id: 8, username: 'gus', title: 'Same channel', status: 'ready', visibility: 'public', duration_seconds: 4000 },
    { id: 7, username: 'amy', title: 'Short', status: 'ready', visibility: 'public', duration_seconds: 120 },
    { id: 6, username: 'kim', title: 'Private', status: 'ready', visibility: 'private', duration_seconds: 4000 },
    { id: 5, username: 'lee', title: 'Elsewhere thumb', status: 'ready', visibility: 'public', duration_seconds: 700, thumbnail_url: 'https://evil.example/t.jpg' },
] });
assert.deepStrictEqual(recs.map((r) => r.url), ['https://openvibe.video/v/9', 'https://openvibe.video/v/5'], 'ten minutes or more, public, one per channel');
assert.strictEqual(recs[0].length, '1h 6m');
assert.strictEqual(recs[1].thumb, null, 'a thumbnail only from openvibe.media');
assert.strictEqual(activity.runtime(1805), '30 min');

// The front door features no adult items and repeats no AI words about a person's looks.
const flagged = activity.publicPastes({ pastes: [
    { slug: 'a', title: 'Cam creator opportunity | 18+', visibility: 'public' },
    { slug: 'b', title: 'A man on a sofa', visibility: 'public', type: 'screenshot' },
    { slug: 'c', title: 'Game lobby', visibility: 'public', type: 'screenshot', ai_summary: 'A streamer sits in front of his screen' },
    { slug: 'd', title: 'Sort helper', visibility: 'public', type: 'code', language: 'js', ai_summary: 'Sorts an array by key' },
] });
assert.deepStrictEqual(flagged.map((p) => p.url), ['https://openvibe.community/p/c', 'https://openvibe.community/p/d'], 'no adult or looks titles');
assert.strictEqual(flagged[0].summary, '', "a screenshot's AI description is never quoted");
assert.strictEqual(flagged[1].summary, 'Sorts an array by key', "a code paste's summary is");

// Jobs and coupon codes come from OpenVibe.Search, only public ones on their own site.
const job = activity.jobs({ results: [
    { visibility: 'public', title: 'Engineer at Acme', canonical_url: 'https://openvibe.work/jobs/1', facets: { location: 'Berlin', remote: true }, provenance: [{ label: 'Arbeitnow' }] },
    { visibility: 'restricted', title: 'Hidden', canonical_url: 'https://openvibe.work/jobs/2' },
    { visibility: 'public', title: 'Off site', canonical_url: 'https://example.com/jobs/3' },
] });
assert.deepStrictEqual(job, [{ title: 'Engineer at Acme', url: 'https://openvibe.work/jobs/1', where: 'Remote · Berlin', board: 'Arbeitnow' }]);
const code = activity.coupons({ results: [{ visibility: 'public', title: 'FALL10 — 10% off a watch', canonical_url: 'https://openvibe.coupons/c/1' }] });
assert.deepStrictEqual(code, [{ code: 'FALL10', title: '10% off a watch', url: 'https://openvibe.coupons/c/1' }]);

// The page with nothing live: the empty state invites a browser go-live.
activity._set({ live: [], pastes: [], posts: [] });
let { html } = home.render();
assert.ok(/<form class="intent-bar" action="https:\/\/openvibe.tools\/search" method="get"/.test(html), 'the search works without JavaScript (a tool search)');
for (const [id, , verb, , href] of home.INTENTS) {
    assert.ok(html.includes(`href="${href}" data-id="${id}"`), `intent ${id} links to ${href}`);
    assert.ok(html.includes(`<b>${verb}</b>`), `intent ${id} says "${verb}"`);
}
assert.ok(/Go live<\/b><small>From a browser tab\. No OBS, no follower minimum\./.test(html), 'browser go-live stays the headline promise');
assert.ok(/Nobody is live right now/.test(html) && /go live from your browser/.test(html), 'an honest empty state');
const open = sites.filter((s) => s.status === 'open' && s.id !== 'network');
// The hero's orbit (2026-10-28): the most used sites around the mark, the count of every site in its middle.
assert.ok(html.includes('<div class="orbit" role="group"'), 'the orbit is drawn');
for (const s of open.slice(0, 16)) assert.ok(html.includes(`href="https://${s.host}/" style="--i:`), `the orbit links ${s.host}`);
assert.ok(html.includes(`<b>${open.length + 1} sites</b><small>one account</small>`), 'the orbit says how many sites');
assert.ok(!/OpenVibe\.OpenRestream/.test(html), 'OpenRestream is its own name');
assert.ok(!/class="hero-badge"/.test(html), 'no pill above the headline (wasted space on a phone)');
assert.ok(!/streams live now/.test(html), 'a number that reads zero is left out');
assert.ok(!html.includes('<!--OV:'), 'no placeholder left behind');
// Below the hero every section is the shared showcase kit (plan T11), with its stylesheet, one h1 and an AI summary.
assert.ok(html.includes('<link rel="stylesheet" href="/shared/showcase.css">'), 'the kit stylesheet is linked');
for (const id of ['network', 'tools', 'account', 'developers']) assert.ok(html.includes(`<section class="sc-sec" id="${id}"`), `the ${id} section is a kit section`);
assert.strictEqual(html.includes('<section class="sc-sec" id="soon"'), sites.some((s) => s.status === 'soon'), 'an "Opening next" section only while a site is still to open (none since Tips and VIP, contracts 0.200.0)');
assert.ok(!/class="home-(sec|card|grid|fams|fam|dev)\b/.test(html), 'no hand-built section markup is left');
assert.strictEqual((html.match(/<h1[\s>]/g) || []).length, 1, 'one h1: the hero');
assert.match(html, /<meta name="ai-summary" content="One account for \d+ open sites \(live, /);
assert.ok(/"@type":"WebPage"/.test(html), 'the summary has its WebPage JSON-LD');
// A tagline that already ends a sentence ("What should we eat?") gets no second period; a family of one is "1 tool".
assert.ok(!/[.?!]\. /.test(html.replace(/<[^>]+>/g, ' ')), 'no doubled sentence end after a site tagline');
assert.ok(!/\b1 tools\b/.test(html), 'one tool is "1 tool"');
assert.ok(/<h1>Go live, chat, play<br>/.test(html) && /Stream from a browser tab, no OBS\./.test(html), 'the hero still leads with going live from a browser');
for (const s of open) assert.ok(html.includes(`<a class="sc-card" href="https://${s.host}/">`), `the sites section links ${s.host}`);
for (const href of ['https://openvibe.tools/api/catalog.json', '/llms.txt', 'https://openvibe.tools/llms.txt', 'https://github.com/OpenVibers', 'https://openvibe.codes/', 'https://yt.openvibe.tools/', 'https://dns.openvibe.tools/']) assert.ok(html.includes(`href="${href}"`), `the page still links ${href}`);
assert.strictEqual((html.match(/<section[\s>]/g) || []).length, (html.match(/<\/section>/g) || []).length, 'every section is closed once');

// The FAQ shown is the FAQPage JSON-LD, word for word, with the network's own questions from its Contracts site block.
const faqLd = JSON.parse(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema.org","@type":"FAQPage"[\s\S]*?)<\/script>/.exec(html)[1]);
assert.ok(faqLd.mainEntity.length >= 5, 'the FAQ has its questions');
faqLd.mainEntity.forEach((q) => assert.ok(html.includes(`<h3>${q.name.replace(/'/g, '&#39;')}</h3>`), `the FAQ shows "${q.name}"`));
assert.ok(faqLd.mainEntity.some((q) => /separate account/.test(q.name)), "Contracts' network FAQ is included");
// The service map groups the sites the way the launcher does; numbers say only what was read.
assert.ok(/<h3 class="home-group">Streams &amp; places<\/h3>/.test(html) && /<h3 class="home-group">For developers<\/h3>/.test(html) && /<h3 class="home-group">Make &amp; build<\/h3>/.test(html), 'the sites are grouped');
assert.ok(/<section class="net-num"/.test(html) && /sites, one account/.test(html), 'the numbers panel renders');
assert.ok(!/services up/.test(html) && !/accounts<\/span>/.test(html), 'numbers nobody read are left out');
assert.ok(!/Latest recordings|New jobs|Fresh coupon codes/.test(html), 'an empty column is left out');
assert.ok(/<meta property="og:image" content="https:\/\/openvibe\.network\/shared\/social\/network\.jpg\?v=/.test(html) && !html.includes('__OV_CARD__'), "the share card is the network's own");

// With activity: the items render, escaped.
activity._set({ live: [{ name: 'Al<b>ice', title: 'Hi & bye', url: 'https://openvibe.live/@alice', thumb: 'https://openvibe.live/t.jpg', avatar: 'https://openvibe.media/a', viewers: 1500, category: '' }], liveCount: 1, pastes, posts, recordings: recs, jobs: job, codes: code, counts: { accounts: 1234, services: { up: 37, live: 38 } } });
({ html } = home.render());
assert.ok(html.includes('LIVE · 1.5k') && html.includes('Al&lt;b&gt;ice') && html.includes('Hi &amp; bye'), 'viewers, names and titles render escaped');
assert.ok(html.includes('data-fallback="https://openvibe.media/a"'), 'a broken thumbnail falls back to the avatar');
assert.ok(html.includes('href="https://openvibe.community/p/one"') && html.includes('href="https://openvibe.blog/@a/b"'));
assert.ok(html.includes('href="https://openvibe.video/v/9"') && html.includes('<code class="now-code">FALL10</code>') && html.includes('Remote · Berlin · via Arbeitnow'), 'recordings, codes and jobs render');
assert.ok(/<b>1,234<\/b><span>accounts/.test(html) && /<b>37<\/b><span>services up <small>of 38 checked/.test(html) && /<b>1<\/b><span>stream live now/.test(html), 'the numbers read render');
console.log('home front door: all checks passed');
