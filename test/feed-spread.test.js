'use strict';
// One site at a time in the feed (server/feed/card.js spreadCards; the owner, 11-16, the menu's feed: "a lot of these
// aren't organized right … wrong order": three Report cards, then three Deals cards from three hours, in a row):
// a card from the same site as the one before waits for the next card from another site among the next six; a live
// stream keeps its place; a one-site list is left alone; nothing is lost or duplicated.
const assert = require('assert');
const { spreadCards } = require('../server/feed/card');

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
console.log('feed-spread: one site at a time within six cards, live keeps its place, one-site lists untouched, nothing lost');
