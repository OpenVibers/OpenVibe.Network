'use strict';
// ADR-021 analytics bounds on OpenVibe.Network (openvibe-shared/analytics/pg wired by
// server/analytics/network.js; ADR-035): the tracker runs on the service's PostgreSQL handle.
//  - Network's path options (paramPrefixes, pathRules) template its usernames, anon tokens and slugs;
//  - real requests through Network's own routers (auth, OAuth, avatars, admin analytics) leave no IP,
//    user id, city, raw user agent, full referer, query value or username in any analytics table;
//    the session id is a rotating id, paths are route templates, every row is a valid analytics/event.v1;
//  - a request with Sec-GPC: 1 or DNT: 1 is not recorded at all;
//  - the admin dashboards keep their shapes (bot rows carry ua_class / session_id, never an IP);
//  - pruneRawEventsPg deletes raw rows older than 30 days and leaves rollups alone.
//
// The SQLite-only checks (the tracker's own connection with busy_timeout/secure_delete, and the
// analytics-prune CLI that backed up and VACUUMed network.db) no longer exist: on PostgreSQL the
// tracker shares the service handle and retention is pruneRawEventsPg (plan T2, ADR-035).
//   node test/analytics-privacy.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const { privacy, event } = require('openvibe-shared/analytics');
const { sqlTime } = require('openvibe-shared/analytics/tracker');
const networkAnalytics = require('../server/analytics/network');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.stack); }
}

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const USERNAME = 'alexsecretname';

/** Every value in every analytics table (the database also holds accounts, which are not analytics). */
async function dumpAnalytics(db) {
    const tables = await db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'analytics_%'").pluck().all();
    assert.ok(tables.includes('analytics_events'));
    return (await Promise.all(tables.map(async (t) => JSON.stringify(await db.prepare(`SELECT * FROM ${t}`).all())))).join('\n');
}

(async () => {
    await check('Network paths: usernames, anon tokens and project slugs become parameters', () => {
        const opts = privacy.pathOptions(networkAnalytics.PATH_OPTS);
        const t = (p) => privacy.normalisePath(p, opts);
        const cases = {
            '/avatar/alex?s=96': '/avatar/:param',
            '/api/auth/anon/k3yF00barBaz?x=1': '/api/auth/anon/:param',
            '/internal/users/by-username/alex': '/internal/users/:param/:username',
            '/api/v1/projects/my-app/apps': '/api/v1/projects/:param/apps',
            '/oauth/authorize?client_id=live&state=abc': '/oauth/authorize',
            '/reset-password?token=abc': '/reset-password',
            '/api/admin/users/42/role': '/api/admin/users/:param/role',
        };
        for (const [raw, want] of Object.entries(cases)) assert.strictEqual(t(raw), want, raw);
        // Without Network's rule the shared normaliser would keep the name.
        assert.strictEqual(privacy.normalisePath('/internal/users/by-username/alex'), '/internal/users/:param/alex');
    });

    // ── Real requests through Network's routers ──────────────
    const db = await getDb();
    await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (42, ?, 'x', 'admin')").run(USERNAME);
    let clock = Date.parse('2026-09-23T10:15:00Z');
    const analytics = networkAnalytics.openAnalytics(db, { timers: false, now: () => clock });

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const ISSUER = 'https://openvibe.network';
    const closed = 'http://127.0.0.1:9'; // remote dashboards: refused at once, never a local dev server
    const config = {
        baseUrl: ISSUER, loginUrl: ISSUER, networkUrl: ISSUER,
        jwt: { issuer: ISSUER, accessTokenExpiry: '1h', refreshTokenExpiry: '30d' },
        services: { live: { internalUrl: closed }, tools: { internalUrl: closed }, games: { internalUrl: closed }, media: { internalUrl: closed } },
    };
    const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), require('../server/auth/routes').signToken);
    const avatarService = require('../server/profile/avatar').createAvatarService({ db, config, requireAuth, log: { log() {}, warn() {}, error() {} } });

    const app = express();
    app.set('trust proxy', 2); // as server/index.js: Cloudflare → Nginx → Node
    app.use(cookieParser());
    app.use(express.json());
    app.use(analytics.middleware());
    app.locals.db = db;
    app.locals.config = config;
    app.locals.privateKey = keys.privateKey;
    app.locals.publicKey = keys.publicKey;
    app.use('/api/auth', require('../server/auth/routes'));
    app.use('/oauth', require('../server/auth/oauth-routes'));
    // Stands in for the /avatar rate limiter: a request refused before any route matched.
    app.use('/avatar', (req, res, next) => (req.query.block ? res.status(429).end() : next()), avatarService.pub);
    app.use('/internal', (req, res) => res.status(403).json({ error: 'internal only' })); // refused before routing
    app.use('/api/admin/analytics', require('../server/admin/analytics-routes')(analytics, requireAuth, config));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign({ sub: 42, id: 42, username: USERNAME, role: 'admin' }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
    const hdr = (extra = {}) => ({
        'user-agent': CHROME, 'x-forwarded-for': '203.0.113.77', 'cf-ipcountry': 'NL', 'cf-ipcity': 'Amsterdam',
        referer: 'https://www.google.com/search?q=secret-query', ...extra,
    });
    const get = async (p, headers) => { const r = await fetch(base + p, { headers, redirect: 'manual' }); await r.arrayBuffer(); return r.status; };
    const getJson = async (p, headers) => (await fetch(base + p, { headers })).json();

    await check('real requests store no IP, user id, city, raw UA, full referer, query value or username', async () => {
        assert.strictEqual(await get('/api/auth/me?token=supersecret', hdr({ authorization: `Bearer ${token}` })), 200);
        assert.strictEqual(await get(`/avatar/${USERNAME}?s=96`, hdr()), 200);
        assert.strictEqual(await get('/avatar/bobsecretname?block=1', hdr({ 'user-agent': FIREFOX, 'x-forwarded-for': '198.51.100.9' })), 429);
        await get('/oauth/authorize?client_id=live&redirect_uri=https%3A%2F%2Fopenvibe.live%2Fcb&state=statesecret', hdr());
        assert.strictEqual(await get('/api/auth/anon/0123456789abcdefanon', hdr()), 404);
        await get('/no/such/page/424242?email=alex%40example.com', hdr());
        assert.strictEqual(await get('/internal/users/by-username/carolsecretname', hdr()), 403);
        await get('/api/auth/me', hdr({ 'user-agent': 'curl/8.5.0' }));
        // Opted out (Sec-GPC / DNT): answered as usual, recorded nowhere.
        assert.strictEqual(await get('/avatar/gpcsecretname', hdr({ 'sec-gpc': '1', 'x-forwarded-for': '198.51.100.61' })), 200);
        assert.strictEqual(await get('/internal/users/by-username/dntsecretname', hdr({ dnt: '1', 'x-forwarded-for': '198.51.100.62' })), 403);
        await new Promise((r) => setTimeout(r, 50));
        await analytics.flush();

        const rows = await db.prepare('SELECT * FROM analytics_events ORDER BY id').all();
        assert.strictEqual(rows.length, 8);
        for (const r of rows) {
            assert.strictEqual(r.service, 'openvibe-network');
            assert.strictEqual(r.ip, null);
            assert.strictEqual(r.user_id, null);
            assert.strictEqual(r.city, null);
            assert.ok(!/[?#]/.test(r.path), r.path);
            assert.strictEqual(r.referer, 'https://www.google.com');
            assert.ok(/^[0-9a-f]{16}$/.test(r.session_id), r.session_id);
            assert.strictEqual(r.country, 'NL');
            assert.ok(/^(none|bot:[a-z0-9]+|[a-z]+\/[a-z]+\/[a-z]+)$/.test(r.user_agent), r.user_agent);
            assert.deepStrictEqual(event.checkRow(r), [], JSON.stringify(r));
        }
        assert.deepStrictEqual(rows.map((r) => r.path), [
            '/api/auth/me', '/avatar/:username', '/avatar/:param', '/oauth/authorize',
            '/api/auth/anon/:token', '/no/such/page/:id', '/internal/users/:param/:username', '/api/auth/me',
        ]);
        assert.deepStrictEqual(rows.map((r) => r.authenticated), [1, 0, 0, 0, 0, 0, 0, 0]);
        assert.strictEqual(rows[7].user_agent, 'bot:curl');
        assert.strictEqual(rows[0].session_id, rows[1].session_id, 'same visitor, same session');
        assert.notStrictEqual(rows[0].session_id, rows[2].session_id);

        const everything = await dumpAnalytics(db);
        for (const needle of ['203.0.113.77', '198.51.100.9', '127.0.0.1', 'Amsterdam', 'supersecret', 'secret-query',
            '/search', 'statesecret', 'openvibe.live%2Fcb', USERNAME, 'bobsecretname', 'carolsecretname', '0123456789abcdefanon', '424242',
            'alex%40example.com', 'alex@example.com', 'Mozilla/5.0', 'curl/8.5.0', 'Bearer', token.slice(0, 20),
            'gpcsecretname', 'dntsecretname', '198.51.100.61', '198.51.100.62']) {
            assert.ok(!everything.includes(needle), `found ${needle} in the analytics tables`);
        }
    });

    await check('admin dashboards keep their shapes; bot rows carry ua_class / session_id, never an IP', async () => {
        const auth = { authorization: `Bearer ${token}`, 'user-agent': CHROME };
        await analytics.aggregate();
        const warn = console.warn;
        console.warn = () => {}; // the remote services are unreachable here on purpose
        try { await dashboards(auth); } finally { console.warn = warn; }
    });
    async function dashboards(auth) {
        const svc = await getJson('/api/admin/analytics/service/openvibe-network?days=30', auth);
        assert.ok(svc.ok, JSON.stringify(svc));
        for (const k of ['summary', 'realtime', 'daily', 'hourly', 'topPages', 'authBreakdown', 'visitorTypes', 'authTrend']) assert.ok(k in svc.analytics, k);
        assert.strictEqual(svc.analytics.visitorTypes.new_visitors, null);
        const bots = (await getJson('/api/admin/analytics/bots?days=30', auth)).bots['openvibe-network'];
        for (const k of ['topBotIPs', 'botTrend', 'botTypes', 'suspiciousIPs']) assert.ok(Array.isArray(bots[k]), k);
        const curl = bots.topBotIPs.find((b) => b.ua_class === 'bot:curl');
        assert.ok(curl, JSON.stringify(bots.topBotIPs));
        assert.strictEqual(curl.ip, null);
        assert.ok(bots.botTypes.every((t) => t.unique_ips === null && typeof t.unique_sessions === 'number'));
        // /realtime reads the wall clock (last 5 minutes): one request stamped now.
        clock = Date.now();
        await get('/api/auth/me', hdr({ authorization: `Bearer ${token}` }));
        await new Promise((r) => setTimeout(r, 50));
        await analytics.flush();
        const rt = await getJson('/api/admin/analytics/realtime', auth);
        assert.ok(rt.ok && typeof rt.realtime.visitors === 'number' && rt.realtime.visitors >= 1, JSON.stringify(rt));
        const ov = await getJson('/api/admin/analytics/overview?days=30', auth);
        assert.ok(ov.ok && ov.overview.services.some((s) => s.name === 'openvibe-network'));
        const hourly = await db.prepare("SELECT * FROM analytics_hourly WHERE hour = '2026-09-23 10:00:00'").get();
        assert.ok(hourly && hourly.unique_visitors >= 2 && hourly.unique_users === 1, JSON.stringify(hourly));
    }
    server.close();

    await check('analytics-prune: raw rows older than 30 days go, rollups stay', async () => {
        const ins = db.prepare(`INSERT INTO analytics_events (service, event_type, path, ip, user_id, created_at) VALUES ('openvibe-network', 'pageview', '/@old', '198.51.100.1', 7, ?)`);
        for (let i = 0; i < 5; i++) await ins.run(sqlTime(Date.now() - (40 + i) * 86400000));
        await ins.run(sqlTime(Date.now() - 29 * 86400000));
        await db.prepare("INSERT INTO analytics_daily (service, date, pageviews, api_calls, unique_visitors) VALUES ('openvibe-network', '2026-07-01', 9, 3, 4) ON CONFLICT (service, date) DO UPDATE SET pageviews = excluded.pageviews, api_calls = excluded.api_calls, unique_visitors = excluded.unique_visitors").run();
        const daily = JSON.stringify(await db.prepare('SELECT * FROM analytics_daily ORDER BY date').all());
        const before = await db.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get();
        const out = await networkAnalytics.schedulePrune(analytics, { days: 30 });
        assert.strictEqual(out.removed, 5);
        assert.strictEqual(await db.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get(), before - 5);
        assert.strictEqual(JSON.stringify(await db.prepare('SELECT * FROM analytics_daily ORDER BY date').all()), daily);
        assert.strictEqual(await db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 1);
    });
    analytics.destroy();

    if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
    console.log('\nanalytics privacy: all passed');
    process.exit(0);
})();
