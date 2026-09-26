'use strict';
// Project usage (WS-N task 4, server/developer/usage.js): tools.usage.recorded and events.usage.recorded
// arrive at POST /internal/events, are kept per project and day inside the consumer's inbox transaction
// (a redelivery or a re-sent hour never counts twice; an older revision never replaces a newer one), and
// GET /api/v1/projects/:project/usage answers the owner, admins and staff (not developers, viewers or
// strangers) with network.project-usage-result@1: daily rows, totals, the recorded quotas with what
// their window used, errors by code and the sampled failures with their trace ids.
//   node test/project-usage.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { ids, validate } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { initDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const { NotificationService } = require('../server/notifications/notification-service');
const { createEventsConsumer, TOPICS } = require('../server/notifications/events-consumer');
const { createProjectUsage, parseQuery } = require('../server/developer/usage');
const { topicsFrom } = require('../scripts/subscribe-events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-project-usage-'));
const quiet = { log: console.log, warn: console.warn };
console.log = () => {}; console.warn = () => {};
const db = initDb(path.join(dir, 'network.db'));
db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (10, 'owner', 'x', 'user'), (11, 'admin', 'x', 'user'), (12, 'dev', 'x', 'user'), (13, 'viewer', 'x', 'user'), (14, 'stranger', 'x', 'user'), (15, 'staff', 'x', 'admin')`).run();
const sid = (id) => subjects.ensureUserSubject(db, db.prepare('SELECT * FROM users WHERE id = ?').get(id));

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const SECRET = 'u'.repeat(40);
const app = express();
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { sandboxAllowance: '' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
const projectUsage = createProjectUsage(db, { log: { warn() {} } });
const consumer = createEventsConsumer({ db, notifications: new NotificationService(db), secrets: SECRET, projectUsage });
app.use('/internal/events', consumer.router);
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);
const token = (id) => jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const T = { owner: token(10), admin: token(11), dev: token(12), viewer: token(13), stranger: token(14), staff: token(15) };

const HOUR = 60 * 60 * 1000;
const thisHour = Math.floor(Date.now() / HOUR) * HOUR;
const yesterday = thisHour - 24 * HOUR;
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const JOB = 'job_01JAB2C3D4E5F6G7H8J9K0MNPR';

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: { authorization: `Bearer ${T[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null, text };
    };
    try {
        // ── A project with an admin, a developer and a viewer; staff record two quotas ──
        let r = await api('owner', 'POST', '', { name: 'Usage demo' });
        assert.strictEqual(r.status, 201);
        const P = r.body.id;
        for (const [who, role] of [['admin', 'admin'], ['dev', 'developer'], ['viewer', 'viewer']]) {
            assert.strictEqual((await api('owner', 'POST', `/${P}/members`, { username: who, role })).status, 201);
        }
        assert.strictEqual((await api('staff', 'PUT', `/${P}/quotas/tools.job.create`, { limit: 100, window: 'day', unit: 'jobs' })).status, 200);
        assert.strictEqual((await api('staff', 'PUT', `/${P}/quotas/events.app.publish`, { limit: 120, window: 'minute', unit: 'events' })).status, 200);
        assert.strictEqual((await api('staff', 'PUT', `/${P}/quotas/media.object.upload`, { limit: 1000000, window: 'month', unit: 'bytes' })).status, 200);

        // ── Nothing yet: an empty, valid answer ──
        r = await api('owner', 'GET', `/${P}/usage`);
        assert.strictEqual(r.status, 200);
        assert.ok(validate('network.project-usage-result@1', r.body).valid, JSON.stringify(validate('network.project-usage-result@1', r.body).errors));
        assert.deepStrictEqual([r.body.last_recorded_at, r.body.daily.length, r.body.errors.total], [null, 0, 0]);
        assert.match(r.body.freshness, /No usage/);

        // ── The consumer subscribes to both rollups, and records them ──
        assert.ok(TOPICS.includes('tools.usage.recorded') && TOPICS.includes('events.usage.recorded'));
        assert.deepStrictEqual(topicsFrom(['--topic', 'tools.usage.recorded', '--topic', 'events.usage.recorded']), ['tools.usage.recorded', 'events.usage.recorded']);
        const rollup = (svc, payload, over = {}) => ({
            event_id: ids.newId('event'), event_type: `${svc}.usage.recorded`, version: 1, source: svc, actor: { type: 'service', id: svc },
            timestamp: new Date().toISOString(), subject: { type: 'project', id: payload.project_id }, visibility: 'internal', priority: 'low', payload, ...over,
        });
        const hour = (start, extra) => ({ project_id: P, env: 'production', unit: 'jobs', window: 'hour', window_start: new Date(start).toISOString(), window_end: new Date(start + HOUR).toISOString(), ...extra });
        const jobs = rollup('tools', hour(thisHour, {
            capability: 'tools.job.create', dimension: 'img.process', quantity: 40, errors: 2, error_codes: { 'tools.job.failed': 1, 'tools.job.timeout': 1 },
            samples: [{ at: new Date(thisHour + 60000).toISOString(), code: 'tools.job.timeout', status: 504, trace_id: TRACE, ref: JOB }],
        }));
        // Over HTTP, signed: the route the Events subscription delivers to.
        const raw = JSON.stringify({ event: jobs, seq: 1 });
        const res = await fetch(`${base}/internal/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...signDeliveryHeaders(raw, SECRET) }, body: raw });
        assert.deepStrictEqual([res.status, (await res.json()).outcome], [200, 'recorded']);
        assert.strictEqual(consumer.apply(jobs).duplicate, true, 'a redelivery records nothing twice');
        // The same hour re-sent with new totals replaces it; an older revision never does.
        const resent = rollup('tools', { ...jobs.payload, quantity: 42, errors: 3, error_codes: { 'tools.job.failed': 2, 'tools.job.timeout': 1 }, revision: 2 });
        assert.strictEqual(consumer.apply(resent).outcome, 'recorded');
        assert.strictEqual(consumer.apply(rollup('tools', { ...jobs.payload, quantity: 1, revision: 1 })).outcome, 'ignored:stale');
        assert.strictEqual(consumer.apply(rollup('tools', hour(yesterday, { capability: 'tools.tool.run', dimension: 'image-resize', quantity: 5, errors: 0 }))).outcome, 'recorded');
        assert.strictEqual(consumer.apply(rollup('tools', hour(thisHour - HOUR, { capability: 'tools.job.create', dimension: 'img.process', env: 'sandbox', quantity: 7, errors: 0 }))).outcome, 'recorded');
        const published = rollup('events', hour(thisHour, {
            capability: 'events.app.publish', unit: 'events', env: 'sandbox', quantity: 1800, errors: 61, error_codes: { 'events.quota_exceeded': 60, 'events.type_not_allowed': 1 },
            samples: [{ at: new Date(thisHour + 120000).toISOString(), code: 'events.quota_exceeded', status: 429, trace_id: TRACE }],
        }));
        assert.strictEqual(consumer.apply(published).outcome, 'recorded');

        // What is not a project's rollup is ignored.
        const other = await api('stranger', 'POST', '', { name: 'Someone else' });
        const ignored = [
            [rollup('tools', { ...jobs.payload, project_id: `prj_${ids.ulid()}` }), 'ignored:project'],
            [rollup('events', jobs.payload, { source: 'tools' }), 'ignored:source'],
            [rollup('tools', { ...jobs.payload, owner: { type: 'user', id: sid(10) } }), 'ignored:payload'],
            [rollup('tools', { ...jobs.payload, window_end: new Date(thisHour + 2 * HOUR).toISOString() }), 'ignored:window'],
            [rollup('tools', jobs.payload, { subject: { type: 'project', id: other.body.id } }), 'ignored:subject'],
            [rollup('tools', { ...jobs.payload, window_start: new Date(thisHour + 3 * HOUR).toISOString(), window_end: new Date(thisHour + 4 * HOUR).toISOString() }), 'ignored:future'],
        ];
        for (const [e, outcome] of ignored) assert.strictEqual(consumer.apply(e).outcome, outcome, outcome);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0, 'usage notifies nobody');

        // ── The dashboard's answer ──
        r = await api('owner', 'GET', `/${P}/usage?days=7`);
        assert.strictEqual(r.status, 200);
        const v = validate('network.project-usage-result@1', r.body);
        assert.ok(v.valid, JSON.stringify(v.errors));
        const u = r.body;
        assert.deepStrictEqual([u.env, u.range.days, u.range.to], ['all', 7, new Date().toISOString().slice(0, 10)]);
        assert.ok(u.last_recorded_at);
        const today = new Date(thisHour).toISOString().slice(0, 10);
        const row = (cap, env) => u.daily.find((d) => d.capability === cap && d.env === env && d.day === today);
        assert.deepStrictEqual([row('tools.job.create', 'production').quantity, row('tools.job.create', 'production').errors, row('tools.job.create', 'production').dimension], [42, 3, 'img.process'], 'the re-sent hour replaced the first');
        assert.deepStrictEqual([row('events.app.publish', 'sandbox').quantity, row('events.app.publish', 'sandbox').dimension], [1800, null]);
        assert.ok(u.daily.some((d) => d.capability === 'tools.tool.run' && d.day === new Date(yesterday).toISOString().slice(0, 10)));
        const total = (cap, env) => u.totals.find((x) => x.capability === cap && x.env === env);
        assert.deepStrictEqual([total('tools.job.create', 'production').quantity, total('tools.tool.run', 'production').quantity, total('events.app.publish', 'sandbox').errors], [42, 5, 61]);
        const quota = (cap) => u.quotas.find((x) => x.capability === cap);
        const sandboxToday = new Date(thisHour - HOUR).toISOString().slice(0, 10) === today ? 7 : 0;
        assert.deepStrictEqual([quota('tools.job.create').used, quota('tools.job.create').remaining, quota('tools.job.create').enforced_by], [42 + sandboxToday, 100 - 42 - sandboxToday, 'openvibe.tools'], 'a day quota counts today, every environment');
        assert.strictEqual(quota('tools.job.create').window_start, `${today}T00:00:00.000Z`);
        assert.deepStrictEqual([quota('events.app.publish').used, quota('events.app.publish').remaining], [null, null]);
        assert.match(quota('events.app.publish').note, /minute window/);
        assert.strictEqual(quota('media.object.upload').used, null);
        assert.match(quota('media.object.upload').note, /no service reports/);
        assert.strictEqual(u.errors.total, 64);
        assert.deepStrictEqual(u.errors.by_code[0], { service: 'events', capability: 'events.app.publish', code: 'events.quota_exceeded', count: 60 });
        assert.deepStrictEqual(u.errors.recent.map((e) => [e.service, e.code, e.status, e.trace_id, e.ref]), [
            ['events', 'events.quota_exceeded', 429, TRACE, null],
            ['tools', 'tools.job.timeout', 504, TRACE, JOB],
        ], 'newest first; the re-sent hour did not duplicate its sample');
        for (const who of [10, 11, 12]) assert.ok(!r.text.includes(sid(who)), 'no subject id in the answer');

        // Filters.
        r = await api('owner', 'GET', `/${P}/usage?env=sandbox`);
        assert.ok(r.body.daily.every((d) => d.env === 'sandbox') && r.body.errors.recent.every((e) => e.env === 'sandbox'));
        for (const q of ['days=0', 'days=91', 'days=abc', 'env=staging']) {
            r = await api('owner', 'GET', `/${P}/usage?${q}`);
            assert.deepStrictEqual([r.status, r.body.code], [422, 'usage.invalid'], q);
        }
        assert.deepStrictEqual(parseQuery({}), { days: 30, env: 'all' });

        // ── Who may read it: owner, admins and staff; not developers, viewers or strangers ──
        for (const [who, status] of [['admin', 200], ['staff', 200], ['dev', 403], ['viewer', 403], ['stranger', 404]]) {
            r = await api(who, 'GET', `/${P}/usage`);
            assert.strictEqual(r.status, status, who);
        }
        r = await fetch(`${base}/api/v1/projects/${P}/usage`);
        assert.strictEqual(r.status, 401);

        // ── Retention: windows and samples of the past go; the daily numbers stay ──
        const later = createProjectUsage(db, { now: () => Date.now() + 40 * 24 * HOUR });
        later.prune();
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM dev_usage_windows').get().n, 0);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM dev_usage_errors').get().n, 0);
        assert.ok(db.prepare('SELECT COUNT(*) AS n FROM dev_usage_daily').get().n > 0);
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
        console.log = quiet.log; console.warn = quiet.warn;
    }
    console.log('project usage: all checks passed');
})().catch((e) => { console.log = quiet.log; console.error(e); process.exit(1); });
