'use strict';
// Open stats (server/stats/open.js; owner, 2026-10-27: "publish the stats for all of the different platforms … make it
// all public for everyone to see"): /stats, /api/v1/stats and the CSV, from the navbar beacon, Live's own analytics,
// Network's accounts and coins, Prometheus and Live's home numbers. A source that does not answer leaves its part out.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb, initDb } = require('../server/db/database');
const { createOpenStats, render } = require('../server/stats/open');

(async () => {
    const db = await getDb();
    await initDb();
    const NOW = Date.parse('2026-10-27T12:00:00Z');
    const day = (back) => new Date(NOW - back * 86400000).toISOString().slice(0, 10);
    const at = (back) => new Date(NOW - back * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    // The navbar beacon: Tools today and 3 days ago (a subdomain counts for its site), Chat 10 days ago (the window before).
    const hit = db.prepare('INSERT INTO frame_hits (day, host, hits) VALUES (?, ?, ?)');
    await hit.run(day(0), 'openvibe.tools', 40);
    await hit.run(day(3), 'yt.openvibe.tools', 20);
    await hit.run(day(2), 'openvibe.chat', 15);
    await hit.run(day(10), 'openvibe.chat', 30);
    await hit.run(day(1), 'evil.example', 999);
    // Accounts: two this week, one the week before; a guest and a banned account never count.
    const user = db.prepare('INSERT INTO users (id, username, password_hash, created_at, is_anon, is_banned) VALUES (?, ?, ?, ?, ?, ?)');
    await user.run(9001, 'osa', 'x', at(1), 0, 0);
    await user.run(9002, 'osb', 'x', at(5), 0, 0);
    await user.run(9003, 'osc', 'x', at(9), 0, 0);
    await user.run(9004, 'osguest', 'x', at(1), 1, 0);
    await user.run(9005, 'osbanned', 'x', at(1), 0, 1);

    // Live's analytics and home numbers; Prometheus down.
    const asked = [];
    const fetchImpl = async (url, opts) => {
        asked.push(String(url));
        const u = new URL(url);
        const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
        if (u.pathname === '/internal/analytics-summary') {
            assert.ok(/^Bearer /.test(opts.headers.Authorization), 'Live is asked with a service token');
            const d = Number(u.searchParams.get('days'));
            return json({ ok: true, summary: { total_pageviews: d === 7 ? 500 : 800, total_unique_visitors: 120, total_unique_users: 30 } });
        }
        if (u.pathname === '/api/home/hero') return json({ stats: { liveNow: 2, viewersNow: 9, streamers: 127, users: 437, chatMessages: 74680, vods: 829 } });
        throw new Error('down');
    };
    const stats = createOpenStats({ db, selfToken: () => 'tok', statusRows: () => [{ exposure: { state: 'live' }, status: 'up' }, { exposure: { state: 'live' }, status: 'down' }],
        prometheusUrl: 'http://prom.test', liveUrl: 'http://live.test', fetchImpl, now: () => NOW });

    const d = await stats.collect(7);
    const site = (id) => d.sites.find((s) => s.id === id);
    assert.strictEqual(site('tools').pageviews, 60, 'a subdomain counts for its site');
    assert.deepStrictEqual(site('tools').daily.map((p) => p.n), [0, 0, 0, 20, 0, 0, 40], 'one point a day, oldest first');
    assert.deepStrictEqual([site('chat').pageviews, site('chat').pageviews_prev, site('chat').change_pct], [15, 30, -50], 'against the window before');
    assert.deepStrictEqual([site('live').pageviews, site('live').pageviews_prev, site('live').unique_visitors, site('live').daily], [500, 300, 120, null], 'Live counts its own visits');
    assert.ok(!d.sites.some((s) => s.host === 'evil.example'), 'only OpenVibe sites');
    assert.strictEqual(d.sites[0].id, 'live', 'most visited first');
    assert.strictEqual(d.totals.pageviews, d.sites.reduce((a, s) => a + (s.pageviews || 0), 0));
    assert.strictEqual(d.accounts.new, 2, 'two new accounts this week (no guests, no banned)');
    assert.strictEqual(d.accounts.prev, 1);
    assert.deepStrictEqual(d.totals.services, { up: 1, checked: 2 });
    assert.strictEqual(d.live.live_now, 2);
    assert.strictEqual(d.busiest_pages_24h, null, 'Prometheus down: no traffic part, never zeros');
    assert.strictEqual(site('tools').traffic_24h, null);

    // The page and the API over HTTP.
    const app = express();
    app.use(stats.router);
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const page = await fetch(`${base}/stats?days=7`);
        assert.strictEqual(page.status, 200);
        const html = await page.text();
        assert.ok(html.includes('<h1>Every OpenVibe site\'s numbers</h1>'));
        assert.ok(html.includes('aria-current="page">7 days</a>'), 'the window is chosen in the address, without script');
        assert.ok(/class="os-site".*<span class="os-pre">OpenVibe.<\/span>Tools<\/b>/s.test(html) && html.includes('openvibe.tools'), 'a card per site');
        assert.ok(html.includes('"@type":"Dataset"'), 'described as a dataset for search engines');
        assert.ok(html.includes('<a href="/api/v1/stats?days=7">JSON</a>'));
        assert.ok(/<svg class="os-spark"/.test(html) && /<figure class="os-chart"><svg [^>]*role="img" aria-label="Page views, /.test(html) && html.includes('<div class="os-axis">'), 'charts drawn on the server, each with its numbers in words');
        const api = await fetch(`${base}/api/v1/stats?days=7`);
        assert.strictEqual(api.headers.get('access-control-allow-origin'), '*', 'open to every site and agent');
        assert.strictEqual((await api.json()).window_days, 7);
        const csv = await (await fetch(`${base}/api/v1/stats/pageviews.csv?days=7`)).text();
        assert.ok(csv.startsWith('day,site,pageviews\n') && csv.includes(`${day(0)},openvibe.tools,40`));
        assert.strictEqual((await (await fetch(`${base}/api/v1/stats?days=12`)).json()).window_days, 30, 'an unknown window is 30 days');
    } finally { server.close(); }

    // Nothing answered yet: the page still renders, saying so.
    assert.ok(render(null, 30).includes('The numbers are being gathered'));
    console.log('open stats: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
