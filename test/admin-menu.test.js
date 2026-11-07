'use strict';
// Admin Analytics — "The menu" (GET /api/admin/analytics/menu): anonymous menu sends per section and destination
// site, this week over last week, admins only; the panel draws it on the overview.
//   node test/admin-menu.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getDb } = require('../server/db/database');
const createAnalyticsRoutes = require('../server/admin/analytics-routes');

(async () => {
    const db = getDb();
    const day = (n) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - n)).toISOString().slice(0, 10); };
    const put = db.prepare('INSERT INTO menu_clicks (day, section, to_site, pos_bucket, n) VALUES (?, ?, ?, ?, ?)');
    await put.run(day(0), 'next', 'community', '1-2', 4);
    await put.run(day(1), 'next', 'community', '1-2', 3);
    await put.run(day(8), 'next', 'community', '1-2', 2);
    await put.run(day(0), 'discover', 'games', '1-2', 5);
    await put.run(day(9), 'discover', 'games', '1-2', 1);
    await put.run(day(20), 'all', 'network', '7+', 100);   // outside both weeks: not counted

    const requireAuth = (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ error: 'Authentication required' }); req.user = JSON.parse(u); next(); };
    const app = express();
    app.use('/api/admin/analytics', createAnalyticsRoutes({ db, getStats: async () => ({}) }, requireAuth, { services: {} }));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/api/admin/analytics/menu`;
    const get = async (user) => { const r = await fetch(base, { headers: user ? { 'x-test-user': JSON.stringify(user) } : {} }); return { status: r.status, body: await r.json().catch(() => null), cache: r.headers.get('cache-control') }; };
    try {
        assert.strictEqual((await get(null)).status, 401);
        assert.strictEqual((await get({ id: 2, role: 'global_mod' })).status, 403, 'admins only');
        const r = await get({ id: 1, role: 'admin' });
        assert.strictEqual(r.status, 200);
        assert.match(r.cache, /no-store/);
        const m = r.body.menu;
        assert.deepStrictEqual(m.week, { current: day(6), previous: day(13) }, 'the last seven days and the seven before');
        assert.deepStrictEqual(m.sections, [
            { name: 'next', this_week: 7, last_week: 2 },
            { name: 'discover', this_week: 5, last_week: 1 },
        ], 'per section, busiest this week first; the 20-day-old row is outside both weeks');
        assert.deepStrictEqual(m.sites, [
            { name: 'community', this_week: 7, last_week: 2 },
            { name: 'games', this_week: 5, last_week: 1 },
        ], 'per destination site');
        assert.deepStrictEqual(m.totals.sections, { this_week: 12, last_week: 3 });

        // The panel: a section on the overview and the route it asks.
        const js = fs.readFileSync(path.join(__dirname, '../public/js/admin/analytics.js'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
        assert.match(js, /\/api\/admin\/analytics\/menu/);
        assert.match(js, /function loadMenu\(/);
        assert.match(js, /loadMenu\(\)/);
        assert.match(html, /id="analytics-menu"/);
        console.log('admin menu: all checks passed');
    } finally {
        srv.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
