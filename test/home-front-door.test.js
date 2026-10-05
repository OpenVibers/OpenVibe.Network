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
assert.ok(html.includes('<svg class="constellation"'), 'the constellation is drawn');
for (const s of open) assert.ok(html.includes(`<a href="https://${s.host}/" class="cs-node"`), `the constellation links ${s.host}`);
assert.ok(!html.includes('<!--OV:'), 'no placeholder left behind');
// Below the hero every section is the shared showcase kit (plan T11), with its stylesheet, one h1 and an AI summary.
assert.ok(html.includes('<link rel="stylesheet" href="/shared/showcase.css">'), 'the kit stylesheet is linked');
for (const id of ['network', 'tools', 'account', 'soon', 'developers']) assert.ok(html.includes(`<section class="sc-sec" id="${id}"`), `the ${id} section is a kit section`);
assert.ok(!/class="home-(sec|card|grid|fams|fam|dev)\b/.test(html), 'no hand-built section markup is left');
assert.strictEqual((html.match(/<h1[\s>]/g) || []).length, 1, 'one h1: the hero');
assert.match(html, /<meta name="ai-summary" content="One account for \d+ open sites \(live, /);
assert.ok(/"@type":"WebPage"/.test(html), 'the summary has its WebPage JSON-LD');
for (const s of open) assert.ok(html.includes(`<a class="sc-card" href="https://${s.host}/">`), `the sites section links ${s.host}`);

// With activity: the items render, escaped.
activity._set({ live: [{ name: 'Al<b>ice', title: 'Hi & bye', url: 'https://openvibe.live/@alice', thumb: 'https://openvibe.live/t.jpg', avatar: 'https://openvibe.media/a', viewers: 1500, category: '' }], pastes, posts });
({ html } = home.render());
assert.ok(html.includes('LIVE · 1.5k') && html.includes('Al&lt;b&gt;ice') && html.includes('Hi &amp; bye'), 'viewers, names and titles render escaped');
assert.ok(html.includes('data-fallback="https://openvibe.media/a"'), 'a broken thumbnail falls back to the avatar');
assert.ok(html.includes('href="https://openvibe.community/p/one"') && html.includes('href="https://openvibe.blog/@a/b"'));
console.log('home front door: all checks passed');
