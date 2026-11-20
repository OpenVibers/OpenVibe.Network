'use strict';
// One site at a time in the feed (server/feed/card.js spreadCards; the owner, 11-16, the menu's feed: "a lot of these
// aren't organized right … wrong order": three Report cards, then three Deals cards from three hours, in a row):
// a card from the same site as the one before waits for the next card from another site among the next six; a live
// stream keeps its place; a one-site list is left alone; nothing is lost or duplicated.
const assert = require('assert');
const { spreadCards, capCards } = require('../server/feed/card');

const c = (id, site, extra = {}) => ({ id, site, kind: 'post', ...extra });
const ids = (list) => list.map((x) => x.id).join(' ');

// The screenshot's order: report ×3, deals ×3, then a post from Community.
let out = spreadCards([c('r1', 'report'), c('r2', 'report'), c('r3', 'report'), c('d1', 'deals'), c('d2', 'deals'), c('d3', 'deals'), c('p1', 'community')]);
assert.strictEqual(ids(out), 'r1 d1 r2 d2 r3 d3 p1', ids(out));
assert.strictEqual(out.length, 7);
assert.strictEqual(new Set(out.map((x) => x.id)).size, 7, 'nothing lost or doubled');
// Another site within six comes forward; until then the run stays (nothing better to show).
out = spreadCards([c('a', 'x'), c('b', 'y'), c('b2', 'y'), c('b3', 'y'), c('b4', 'y'), c('b5', 'y'), c('b6', 'y'), c('b7', 'y'), c('b8', 'y'), c('z', 'z')]);
assert.strictEqual(ids(out), 'a b b2 z b3 b4 b5 b6 b7 b8', ids(out));
// A live stream keeps its place even after one from the same site.
out = spreadCards([c('l1', 'live', { kind: 'live', live_now: true }), c('l2', 'live', { kind: 'live', live_now: true }), c('t', 'tools')]);
assert.strictEqual(ids(out), 'l1 l2 t');
// One site's own list: as it was.
out = spreadCards([c('d1', 'deals'), c('d2', 'deals'), c('d3', 'deals')]);
assert.strictEqual(ids(out), 'd1 d2 d3');
assert.deepStrictEqual(spreadCards([]), []);

// No one person's or site's page (capCards; production 11-20, signed out: three cards of one streamer's videos, four
// Report cards): at most 2 of a person and 3 of a site in a page; the rest wait, in order; a live stream is not counted
// against its site; a page that would be short takes the waiting ones back.
const p = (id, site, subject, extra) => c(id, site, { subject, ...extra });
let capped = capCards([p('v1', 'live', 'izor'), p('v2', 'live', 'izor'), p('v3', 'live', 'izor'), p('r1', 'report'), p('r2', 'report'), p('r3', 'report'), p('r4', 'report'),
    p('q1', 'quest', 'mr'), p('n1', 'network')], 7);
assert.strictEqual(ids(capped.slice(0, 7)), 'v1 v2 r1 r2 r3 q1 n1', ids(capped));
assert.strictEqual(ids(capped.slice(7)), 'v3 r4', 'the rest wait, in rank order');
capped = capCards([p('l1', 'live', 'a', { kind: 'live', live_now: true }), p('l2', 'live', 'b', { kind: 'live', live_now: true }), p('l3', 'live', 'c', { kind: 'live', live_now: true }),
    p('l4', 'live', 'd', { kind: 'live', live_now: true }), p('x', 'live', 'e')], 5);
assert.strictEqual(ids(capped), 'l1 l2 l3 l4 x', 'live streams do not fill their site\'s three');
capped = capCards([p('r1', 'report'), p('r2', 'report'), p('r3', 'report'), p('r4', 'report'), p('r5', 'report')], 5);
assert.strictEqual(ids(capped), 'r1 r2 r3 r4 r5', 'a page that would be short takes them back');
assert.deepStrictEqual(capCards([], 5), []);
console.log('feed-spread: one site at a time within six cards, live keeps its place, one-site lists untouched, nothing lost');
