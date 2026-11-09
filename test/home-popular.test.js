'use strict';

// The front door's popularity read and Try next without the app: the five-minute hold, the fixed floor when Report
// does not answer, a stale answer kept rather than replaced by the floor, and the Try next fallbacks.
//   node test/home-popular.test.js
const assert = require('assert');
const { createHomePopularity, validItems, FALLBACK, TTL_MS } = require('../server/home/popular');
const { createTryNext } = require('../server/home/try-next');

const REPORT = {
    generated_at: '2026-11-09T12:00:00.000Z',
    items: [
        { id: 'live', kind: 'site', name: 'OpenVibe.Live', url: 'https://openvibe.live/', icon: 'live', reason: 'Most used today', opens_24h: 9, opens_7d: 90, uses_7d: 4 },
        { id: 'yt', kind: 'tool', name: 'YouTube downloader', url: 'https://yt.openvibe.tools/', icon: 'yt', reason: 'Rising this week', opens_7d: 40 },
    ],
};

(async () => {
    // The Report answer is used as it came; the five-minute hold means the second read does not call Report.
    let at = Date.parse('2026-11-09T12:00:00Z');
    let calls = 0;
    let fail = false;
    const popular = createHomePopularity({
        reportUrl: 'http://report.test', now: () => at,
        fetchImpl: async (url) => {
            calls++;
            if (fail) throw new Error('down');
            if (String(url).endsWith('/api/v1/popular/co-usage')) return { ok: true, json: async () => ({ pairs: [{ a: 'live', b: 'chat', people: 4 }] }) };
            return { ok: true, json: async () => REPORT };
        },
    });
    await popular.refresh();
    assert.strictEqual(popular.peek().source, 'report');
    assert.deepStrictEqual(popular.peek().items.map((i) => i.id), ['live', 'yt']);
    const before = calls;
    popular.peek();
    assert.strictEqual(calls, before, 'a read inside five minutes is the hold');
    at += TTL_MS;
    fail = true;
    await popular.refresh();
    const stale = popular.peek();
    assert.strictEqual(stale.source, 'report', 'the last good Report answer is still Report\'s');
    assert.strictEqual(stale.stale, true);
    assert.deepStrictEqual(stale.items.map((i) => i.id), ['live', 'yt']);

    // A cold failure is the fixed floor, marked as such.
    const cold = createHomePopularity({ reportUrl: 'http://report.test', now: () => at, fetchImpl: async () => { throw new Error('down'); } });
    await cold.refresh();
    const floor = cold.peek();
    assert.strictEqual(floor.source, 'fallback');
    assert.strictEqual(floor.reason, 'report_error');
    assert.deepStrictEqual(floor.items.map((i) => i.id), FALLBACK.slice(0, 5).map((i) => i.id));

    // An item without a real https URL or any confidence is left out, never guessed.
    assert.deepStrictEqual(validItems([{ id: 'x', kind: 'site', name: 'X', url: 'javascript:alert(1)', icon: 'x', reason: 'r' }, ...REPORT.items]).map((i) => i.id), ['live', 'yt']);

    const co = { coUsage: async () => ({ pairs: [{ a: 'live', b: 'chat', people: 7 }, { a: 'live', b: 'tools', people: 5 }] }), peek: () => ({ source: 'report', items: [] }), fallback: FALLBACK };
    const dbWith = (top, used) => ({ prepare: (sql) => ({ all: async () => (sql.includes('GROUP BY service') ? top : used) }) });
    const tries = createTryNext({ db: dbWith([{ service: 'live', n: 3 }], [{ service: 'live' }, { service: 'tools' }]), popularity: co, now: () => at });
    let body = await tries.forPerson({ userId: 1, limit: 3 });
    assert.deepStrictEqual(body.items.map((i) => i.id), ['chat'], 'a co-used site, not one the person already uses');
    assert.strictEqual(body.basis, 'co-usage');
    assert.strictEqual(body.source, 'report');
    assert.match(body.items[0].reason, /OpenVibe\.Live/);

    // Co-usage too thin: Report's public popular sites, still excluding the person's own.
    const publicPopular = { coUsage: async () => ({ pairs: [] }), peek: () => ({ source: 'report', items: [{ id: 'live', kind: 'site', name: 'Live', url: 'https://openvibe.live/', icon: 'live', reason: 'x' }, { id: 'chat', kind: 'site', name: 'Chat', url: 'https://openvibe.chat/', icon: 'chat', reason: 'x' }] }), fallback: FALLBACK };
    body = await createTryNext({ db: dbWith([{ service: 'live', n: 3 }], [{ service: 'live' }]), popularity: publicPopular, now: () => at }).forPerson({ userId: 1 });
    assert.deepStrictEqual(body.items.map((i) => i.id), ['chat']);
    assert.strictEqual(body.basis, 'popular');

    // Report never answered: the fixed floor, still without what the person uses.
    body = await createTryNext({ db: dbWith([], [{ service: 'games' }]), popularity: { coUsage: async () => null, peek: () => ({ source: 'fallback', items: FALLBACK }), fallback: FALLBACK }, now: () => at }).forPerson({ userId: 1 });
    assert.strictEqual(body.source, 'fallback');
    assert.strictEqual(body.basis, 'starter');
    assert.ok(!body.items.some((i) => i.id === 'games'), 'a used site is never suggested');

    console.log('home-popular: the hold, the floor, the stale answer and Try next fallbacks pass');
})().catch((e) => { console.error(e); process.exit(1); });
