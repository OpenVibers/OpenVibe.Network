'use strict';
const assert = require('assert');
const { createHomeScreen } = require('../server/home-screen');
const { createToday } = require('../server/frame/today');

(async () => {
    const rows = new Map();
    const db = { prepare(sql) { return {
        get: async (id) => ({ home_screen: rows.get(id) || null }),
        run: async (id, json) => { rows.set(id, json); },
    }; } };
    const home = createHomeScreen({ db, now: () => Date.parse('2026-11-09T12:00:00Z') });
    assert.deepStrictEqual(await home.read(1), { home: [], folders: [], updated_at: null });
    const layout = { home: ['live', 'folder:tools'], folders: [{ id: 'tools', name: 'Tools', apps: ['tools:qr'] }] };
    assert.deepStrictEqual((await home.write(1, layout)).home, layout.home);
    assert.deepStrictEqual((await home.read(1)).folders, layout.folders);
    assert.deepStrictEqual(await home.read(2), { home: [], folders: [], updated_at: null });
    for (const invalid of [
        { home: ['folder:missing'], folders: [] },
        { home: Array(41).fill('live'), folders: [] },
        { home: ['live'], folders: [{ id: 'tools', name: 'Tools', apps: [] }, { id: 'tools', name: 'Tools', apps: [] }] },
    ]) await assert.rejects(home.write(1, invalid), (err) => err.status === 400);
    assert.deepStrictEqual((await home.read(1)).home, layout.home);

    let requests = 0;
    const today = createToday({ reportUrl: 'https://report.test', now: () => Date.parse('2026-11-09T12:00:00Z'), fetchImpl: async (url) => {
        requests++;
        return { ok: true, json: async () => ({ accounts: { daily: [{ day: '2026-11-09', n: 3 }] } }) };
    } });
    const result = await today.get();
    assert.strictEqual(result.series.length, 14);
    assert.strictEqual(result.people_today, 3);
    assert.strictEqual(result.streams_today, null);
    assert.strictEqual(result.posts_today, null);
    assert.strictEqual(result.new_videos_today, null);
    await today.get();
    assert.strictEqual(requests, 1, 'cached for five minutes');
    console.log('home and today: passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
