'use strict';
// POST /api/v1/feed/views (11-14): feed card ids become `preview` views in Media's one view store; anything else is refused.
//   node test/feed-views-beacon.test.js
const assert = require('assert');
const { viewsOf, handler } = require('../server/feed/views-beacon');

const ev = viewsOf({ ids: ['f:live:vod:123', 'f:deals:deal:abc_1', 'f:live:vod:123', 'nope', 'f:Bad:x:1'], session: 'sess_ABCDEFGH' });
assert.deepStrictEqual(ev.map((e) => `${e.ref.service}:${e.ref.kind}:${e.ref.id}`), ['live:vod:123', 'deals:deal:abc_1'], 'well-formed card ids, once each');
assert.ok(ev.every((e) => e.how === 'preview' && e.session === 'sess_ABCDEFGH'));
assert.strictEqual(viewsOf({ ids: [] }), null);
assert.strictEqual(viewsOf('not json'), null);
assert.strictEqual(viewsOf(JSON.stringify({ ids: ['f:news:story:9'] })).length, 1, 'a beacon text/plain body is read');
assert.strictEqual(viewsOf({ ids: Array.from({ length: 50 }, (_, i) => `f:live:vod:${i}`) }).length, 20, 'at most 20 a beacon');

(async () => {
    const sent = [];
    const h = handler({ fetchImpl: async (url, init) => { sent.push([url, JSON.parse(init.body)]); return { ok: true }; } });
    const mk = () => ({ headers: {}, code: 0, body: null, set(o) { Object.assign(this.headers, o); return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
    const res = mk();
    await h({ body: { ids: ['f:live:clip:7'] } }, res);
    assert.strictEqual(res.code, 202);
    assert.strictEqual(res.headers['Access-Control-Allow-Origin'], '*');
    assert.ok(sent[0][0].endsWith('/api/v1/views') && sent[0][1].events[0].ref.id === '7');
    const bad = mk();
    await h({ body: { ids: ['x'] } }, bad);
    assert.strictEqual(bad.code, 400);
    console.log('feed-views-beacon: card ids become preview views in Media; bad input refused; a beacon body is read');
})().catch((e) => { console.error(e); process.exit(1); });
