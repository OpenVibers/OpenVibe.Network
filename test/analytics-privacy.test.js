'use strict';
// ADR-021 analytics bounds on OpenVibe.Network (server/analytics/, scripts/analytics-prune.js):
//  - real requests through Network's own routers (auth, OAuth, avatars, admin analytics) leave no IP,
//    user id, city, raw user agent, full referer, query value or username in any analytics table;
//    the session id is a rotating id, paths are route templates;
//  - the tracker runs on its own connection to network.db: the identity connection keeps busy_timeout 5000;
//  - the admin dashboards keep their shapes (bot rows carry ua_class / session_id, never an IP);
//  - the analytics-prune job deletes raw rows older than 30 days and leaves rollups alone;
//  - the CLI's dry run changes nothing, --apply needs --backup <new file> or --no-backup, the backup is
//    owner-only, and a scrub touches analytics rows only.
//   node test/analytics-privacy.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { initDb } = require('../server/db/database');
const { privacy, retention } = require('../server/analytics');
const { sqlTime } = require('../server/analytics/tracker');
const networkAnalytics = require('../server/analytics/network');
const cli = require('../scripts/analytics-prune');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.stack); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-net-analytics-'));
const quietInit = (file) => { const log = console.log; console.log = () => {}; try { return initDb(file); } finally { console.log = log; } };
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const USERNAME = 'alexsecretname';

/** Every value in every analytics table (network.db also holds accounts, which are not analytics). */
function dumpAnalytics(db) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'analytics_%'").pluck().all();
    assert.ok(tables.includes('analytics_events'));
    return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n');
}

(async () => {
    await check('Network paths: usernames, anon tokens and project slugs become parameters', () => {
        const t = (p) => privacy.normalisePath(networkAnalytics.preReducePath(p), networkAnalytics.PATH_OPTS);
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
    const dbFile = path.join(dir, 'network.db');
    const db = quietInit(dbFile);
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (42, ?, 'x', 'admin')").run(USERNAME);
    let clock = Date.parse('2026-09-23T10:15:00Z');
    const analytics = networkAnalytics.openAnalytics(dbFile, { timers: false, now: () => clock });

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const ISSUER = 'https://openvibe.network';
    const closed = 'http://127.0.0.1:9'; // remote dashboards: refused at once, never a local dev server
    const config = {
        internalKey: 'k'.repeat(32), baseUrl: ISSUER, loginUrl: ISSUER, networkUrl: ISSUER,
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
        await new Promise((r) => setTimeout(r, 50));
        analytics.flush();

        const rows = db.prepare('SELECT * FROM analytics_events ORDER BY id').all();
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
        }
        assert.deepStrictEqual(rows.map((r) => r.path), [
            '/api/auth/me', '/avatar/:username', '/avatar/:param', '/oauth/authorize',
            '/api/auth/anon/:token', '/no/such/page/:id', '/internal/users/:param/:username', '/api/auth/me',
        ]);
        assert.deepStrictEqual(rows.map((r) => r.authenticated), [1, 0, 0, 0, 0, 0, 0, 0]);
        assert.strictEqual(rows[7].user_agent, 'bot:curl');
        assert.strictEqual(rows[0].session_id, rows[1].session_id, 'same visitor, same session');
        assert.notStrictEqual(rows[0].session_id, rows[2].session_id);

        const everything = dumpAnalytics(db);
        for (const needle of ['203.0.113.77', '198.51.100.9', '127.0.0.1', 'Amsterdam', 'supersecret', 'secret-query',
            '/search', 'statesecret', 'openvibe.live%2Fcb', USERNAME, 'bobsecretname', 'carolsecretname', '0123456789abcdefanon', '424242',
            'alex%40example.com', 'alex@example.com', 'Mozilla/5.0', 'curl/8.5.0', 'Bearer', token.slice(0, 20)]) {
            assert.ok(!everything.includes(needle), `found ${needle} in the analytics tables`);
        }
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_rate_tracking').pluck().get(), 0);
    });

    await check('the tracker has its own connection: the identity connection keeps busy_timeout 5000', () => {
        assert.notStrictEqual(analytics.db, db);
        assert.strictEqual(db.pragma('busy_timeout', { simple: true }), 5000);
        assert.strictEqual(analytics.db.pragma('busy_timeout', { simple: true }), 250);
        assert.strictEqual(db.pragma('secure_delete', { simple: true }), 0);
    });

    await check('admin dashboards keep their shapes; bot rows carry ua_class / session_id, never an IP', async () => {
        const auth = { authorization: `Bearer ${token}`, 'user-agent': CHROME };
        analytics.aggregate();
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
        analytics.flush();
        const rt = await getJson('/api/admin/analytics/realtime', auth);
        assert.ok(rt.ok && typeof rt.realtime.visitors === 'number' && rt.realtime.visitors >= 1, JSON.stringify(rt));
        const ov = await getJson('/api/admin/analytics/overview?days=30', auth);
        assert.ok(ov.ok && ov.overview.services.some((s) => s.name === 'openvibe-network'));
        const hourly = db.prepare("SELECT * FROM analytics_hourly WHERE hour = '2026-09-23 10:00:00'").get();
        assert.ok(hourly && hourly.unique_visitors >= 2 && hourly.unique_users === 1, JSON.stringify(hourly));
    }
    server.close();

    await check('analytics-prune job: raw rows older than 30 days go, rollups stay', async () => {
        const ins = db.prepare(`INSERT INTO analytics_events (service, event_type, path, ip, user_id, created_at) VALUES ('openvibe-network', 'pageview', '/@old', '198.51.100.1', 7, ?)`);
        for (let i = 0; i < 5; i++) ins.run(sqlTime(Date.now() - (40 + i) * 86400000));
        ins.run(sqlTime(Date.now() - 29 * 86400000));
        db.prepare("INSERT OR REPLACE INTO analytics_daily (service, date, pageviews, api_calls, unique_visitors) VALUES ('openvibe-network', '2026-07-01', 9, 3, 4)").run();
        const totals = retention.rollupTotals(db);
        const before = db.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get();
        const logs = [];
        const job = networkAnalytics.schedulePrune(analytics, { initialDelayMs: 1e9, intervalMs: 1e9, log: (l) => logs.push(l) });
        try {
            const out = await job.run();
            assert.strictEqual(out.deleted, 5);
            assert.ok(/pruned 5 raw events/.test(logs[0]), logs.join('\n'));
        } finally { job.stop(); }
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get(), before - 5);
        assert.deepStrictEqual(retention.rollupTotals(db), totals);
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 1);
    });
    analytics.destroy();
    analytics.db.close();
    db.close();

    // ── CLI against a network.db ─────────────────────────────
    const quiet = [];
    const log = (l) => quiet.push(l);
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    function legacyNetworkDb(name) {
        const file = path.join(dir, name);
        const d = quietInit(file);
        d.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'keepme', 'x')").run();
        const t = networkAnalytics.openAnalytics(file, { timers: false });
        t.destroy();
        t.db.close();
        const ins = d.prepare(`INSERT INTO analytics_events (service, event_type, path, method, status_code, user_id, session_id, ip, city, user_agent, referer, created_at)
            VALUES ('openvibe-network', 'pageview', ?, 'GET', 200, 7, ?, ?, 'Lyon', ?, 'https://t.co/abc?x=1', ?)`);
        const nowMs = Date.now() + 120000;
        for (let i = 0; i < 4; i++) ins.run('/avatar/keepme?s=' + i, 'legacy-session-' + i, '198.51.100.' + i, CHROME, sqlTime(nowMs - (45 + i) * 86400000));
        for (let i = 0; i < 3; i++) ins.run('/api/auth/anon/tok' + i + 'X9zz99', 'abcdef012345678' + i, '198.51.100.2' + i, FIREFOX, sqlTime(nowMs - (2 + i) * 86400000));
        ins.run('/internal/users/by-username/keepme', null, '127.0.0.1', 'node', sqlTime(nowMs - 3 * 86400000));
        d.prepare(`INSERT INTO analytics_daily (service, date, pageviews, api_calls, unique_visitors, unique_users, new_users, top_paths, top_referers)
            VALUES ('openvibe-network', '2026-07-01', 100, 40, 30, 10, 2, ?, ?)`)
            .run(JSON.stringify([{ path: '/@keepme', cnt: 3 }, { path: '/internal/users/by-username/keepme', cnt: 2 }, { path: '/login', cnt: 1 }]), JSON.stringify([{ referer: 'https://www.google.com/search?q=keepme', cnt: 4 }]));
        d.pragma('wal_checkpoint(TRUNCATE)');
        d.close();
        return file;
    }
    const snapshot = (file) => { const d = new Database(file, { readonly: true }); try { return dumpAnalytics(d); } finally { d.close(); } };

    await check('CLI: default database is $DB_PATH, else data/network.db, from the repo root', () => {
        const root = path.join(__dirname, '..');
        assert.strictEqual(cli.defaultDbPath({}, {}), path.join(root, 'data', 'network.db'));
        assert.strictEqual(cli.defaultDbPath({}, { DB_PATH: './data/other.db' }), path.join(root, 'data', 'other.db'));
        assert.strictEqual(cli.defaultDbPath({ db: '/x/y.db' }, { DB_PATH: './data/other.db' }), '/x/y.db');
    });

    await check('CLI dry run (with and without --scrub) changes nothing', async () => {
        const file = legacyNetworkDb('cli-dry.db');
        const before = { hash: sha(file), dump: snapshot(file) };
        assert.strictEqual(await cli.main(['--db', file], log), 0);
        assert.strictEqual(await cli.main(['--db', file, '--scrub', '--days', '7'], log), 0);
        assert.strictEqual(sha(file), before.hash);
        assert.strictEqual(snapshot(file), before.dump);
        assert.ok(quiet.some((l) => /prune\s+4 rows/.test(l)), quiet.join('\n'));
    });

    await check('CLI --apply refuses without a backup choice, an existing target, or days > 30', async () => {
        const file = legacyNetworkDb('cli-refuse.db');
        const before = snapshot(file);
        assert.strictEqual(await cli.main(['--db', file, '--apply'], log), 2);
        const existing = path.join(dir, 'exists.bak');
        fs.writeFileSync(existing, 'x');
        assert.strictEqual(await cli.main(['--db', file, '--apply', '--backup', existing], log), 2);
        assert.strictEqual(await cli.main(['--db', file, '--apply', '--no-backup', '--days', '31'], log), 2);
        assert.strictEqual(snapshot(file), before);
    });

    await check('CLI --apply --scrub --backup: owner-only verified backup, analytics reduced, accounts untouched', async () => {
        const file = legacyNetworkDb('cli-apply.db');
        const bak = path.join(dir, 'cli-apply.backup.db');
        assert.strictEqual(await cli.main(['--db', file, '--apply', '--scrub', '--backup', bak, '--batch', '2'], log), 0);
        assert.strictEqual(fs.statSync(bak).mode & 0o777, 0o600);
        const b = new Database(bak, { readonly: true });
        assert.strictEqual(b.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get(), 8, 'backup has every row');
        b.close();
        const d = new Database(file, { readonly: true });
        assert.strictEqual(d.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get(), 4);
        assert.deepStrictEqual(d.prepare('SELECT DISTINCT path FROM analytics_events ORDER BY path').pluck().all(), ['/api/auth/anon/:param', '/internal/users/:param/:username']);
        assert.deepStrictEqual(JSON.parse(d.prepare('SELECT top_paths FROM analytics_daily').pluck().get()),
            [{ path: '/@:user', cnt: 3 }, { path: '/internal/users/:param/:username', cnt: 2 }, { path: '/login', cnt: 1 }]);
        assert.strictEqual(d.prepare("SELECT username FROM users WHERE id = 7").pluck().get(), 'keepme');
        d.close();
        const all = snapshot(file);
        for (const needle of ['198.51.100.', '127.0.0.1', 'Lyon', 'legacy-session', 'keepme', 'X9zz99', 'Mozilla/5.0']) assert.ok(!all.includes(needle), needle);
    });

    fs.rmSync(dir, { recursive: true, force: true });
    if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
    console.log('\nanalytics privacy: all passed');
    process.exit(0);
})();
