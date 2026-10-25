'use strict';
// The admin panel's Insights (server/admin/analytics-routes.js GET /api/admin/analytics/insights): sign-ups from this
// database, and per service requests, 4xx, 5xx and p95 latency plus the most used and failing routes from Prometheus;
// plumbing routes stay out of "most used"; Prometheus down is said plainly while sign-ups still show; admins only.
// The panel draws it and can send the day's numbers to the staff room's queue for Vibe.
//   node test/admin-insights.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const createAnalyticsRoutes = require('../server/admin/analytics-routes');

const vec = (rows) => JSON.stringify({ status: 'success', data: { resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [1, String(v)] })) } });
const ANSWERS = [
    [/status_class="4xx"/, vec([[{ job: 'live' }, 120], [{ job: 'wiki' }, 3]])],
    [/status_class="5xx"\}\[24h\]\)\) > 0/, vec([[{ job: 'live', route: '/api/streams' }, 7]])],
    [/status_class="5xx"/, vec([[{ job: 'live' }, 7]])],
    [/histogram_quantile/, vec([[{ job: 'live' }, 0.42], [{ job: 'wiki' }, 'NaN']])],
    [/topk\(80/, vec([[{ job: 'media', route: '/v/:id' }, 30000], [{ job: 'tools', route: '/metrics' }, 24000], [{ job: 'chat', route: '/internal/chat/presence' }, 28000], [{ job: 'live', route: '/api/streams' }, 13000], [{ job: 'network', route: '/api/frame/hit' }, 8000]])],
    [/increase\(http_requests_total\[24h\]\)/, vec([[{ job: 'media' }, 50000], [{ job: 'live' }, 30000], [{ job: 'wiki' }, 900], [{ job: 'idle' }, 0]])],
];

(async () => {
    let up = true;
    const asked = [];
    const prom = http.createServer((req, res) => {
        const q = new URL(req.url, 'http://x').searchParams.get('query');
        asked.push(q);
        if (!up) return res.writeHead(503).end('down');
        const hit = ANSWERS.find(([re]) => re.test(q));
        res.writeHead(200, { 'content-type': 'application/json' }).end(hit ? hit[1] : vec([]));
    });
    await new Promise((r) => prom.listen(0, '127.0.0.1', r));
    const users = { total: 1600, d1: 4, d7: 31, d30: 120 };
    const fakeDb = {
        prepare(sql) {
            return {
                get: async () => ({ n: /1 day/.test(sql) ? users.d1 : /7 days/.test(sql) ? users.d7 : /30 days/.test(sql) ? users.d30 : users.total }),
                all: async () => [{ day: '2026-10-24', n: 3 }, { day: '2026-10-25', n: 4 }],
            };
        },
    };
    const requireAuth = (req, res, next) => { const u = req.headers['x-test-user']; if (!u) return res.status(401).json({ error: 'Authentication required' }); req.user = JSON.parse(u); next(); };
    const app = express();
    app.use('/api/admin/analytics', createAnalyticsRoutes({ db: fakeDb, getStats: async () => ({}) }, requireAuth, { prometheusUrl: `http://127.0.0.1:${prom.address().port}`, services: {} }));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/api/admin/analytics/insights`;
    const get = async (user) => { const r = await fetch(base, { headers: user ? { 'x-test-user': JSON.stringify(user) } : {} }); return { status: r.status, body: await r.json().catch(() => null), cache: r.headers.get('cache-control') }; };
    try {
        assert.strictEqual((await get(null)).status, 401);
        assert.strictEqual((await get({ id: 2, role: 'global_mod' })).status, 403, 'admins only');
        const r = await get({ id: 1, role: 'admin' });
        assert.strictEqual(r.status, 200);
        assert.match(r.cache, /no-store/);
        const ins = r.body.insights;
        assert.deepStrictEqual([ins.users.total, ins.users.new_1d, ins.users.new_7d, ins.users.new_30d], [1600, 4, 31, 120]);
        assert.deepStrictEqual(ins.users.daily, [{ day: '2026-10-24', n: 3 }, { day: '2026-10-25', n: 4 }]);
        assert.deepStrictEqual(ins.services.map((s) => s.service), ['media', 'live', 'wiki'], 'busiest first; a service with no traffic is left out');
        assert.deepStrictEqual(ins.services.find((s) => s.service === 'live'), { service: 'live', requests: 30000, client_errors: 120, server_errors: 7, p95_ms: 420 });
        assert.strictEqual(ins.services.find((s) => s.service === 'wiki').p95_ms, null, 'no latency yet is not zero');
        assert.deepStrictEqual(ins.top_routes.map((x) => `${x.service} ${x.route}`), ['media /v/:id', 'live /api/streams'], '/metrics, internal and frame hits are plumbing');
        assert.deepStrictEqual(ins.error_routes, [{ service: 'live', route: '/api/streams', errors: 7 }]);
        assert.deepStrictEqual(ins.totals, { requests: 80900, server_errors: 7 });
        assert.ok(asked.every((q) => !/[;]/.test(q)), 'fixed queries');
        up = false;
        const down = (await get({ id: 1, role: 'admin' })).body.insights;
        assert.match(down.metrics_error, /Metrics are unavailable/);
        assert.strictEqual(down.users.new_7d, 31, 'sign-ups still show');
        // The panel: drawn on the overview, asks the staff room with the admin's own token.
        const js = fs.readFileSync(path.join(__dirname, '../public/js/admin/analytics.js'), 'utf8');
        assert.match(js, /\/api\/admin\/analytics\/insights/);
        assert.match(js, /\/api\/chat\/rooms\/staff\/tasks/);
        assert.match(fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8'), /id="analytics-insights"/);
        console.log('admin insights: all checks passed');
    } finally {
        srv.close(); prom.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
