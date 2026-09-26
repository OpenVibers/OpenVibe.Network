'use strict';
// The follow graph (roadmap WS-E task 4, ADR-030; Contracts 0.65.0): follow and unfollow through
// /api/v1/me/follows (idempotent, never oneself, never a guest), each change writes network.follow.created /
// .deleted with a growing per-pair revision, counts are public and lists are not (the target's owner, or a
// service with network.follows.read), and scripts/follows-backfill.js imports Live's follows (held when a
// side has no subject), then reconciles.
//   node test/follows.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const { validate } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-follows-'));
const dbFile = path.join(dir, 'network.db');
const log = console.log; console.log = () => {};
const db = initDb(dbFile);
console.log = log;
require('../server/identity/principals').ensureSchema(db);
for (const c of ['live', 'tools']) db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(`${c}-secret`, c);

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const CAT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC';
db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id, role) VALUES
    (1, 'ann', 'Ann', 'x', ?, 'user'), (2, 'bob', 'Bob', 'x', ?, 'streamer'), (3, 'cat', NULL, 'x', ?, 'user')`).run(ANN, BOB, CAT);
db.prepare("INSERT INTO users (id, username, password_hash, is_anon) VALUES (5, 'anon1234', 'x', 1)").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const follows = require('../server/identity/follows');
const principals = require('../server/identity/principals');
const app = express();
app.use(require('cookie-parser')());
app.use(express.urlencoded({ extended: true }));
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/oauth', require('../server/auth/oauth-routes'));
const routers = follows.routers({ requireAuth, followsGuard: principals.guard('network.follows.read', { legacy: false }) });
app.use('/api/v1/me/follows', routers.me);
app.use('/api/v1/follows', routers.pub);
const server = http.createServer(app);

const events = () => db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope)).filter((e) => e.event_type.startsWith('network.follow.'));
const valid = (e) => {
    assert.ok(validate('events.event-envelope@1', e).valid);
    const pv = validate(`${e.event_type}@1`, e.payload);
    assert.ok(pv.valid, JSON.stringify(pv.errors));
    assert.deepStrictEqual([e.source, e.visibility, e.subject], ['network', 'subject', { type: 'user', id: e.payload.follower }]);
};

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tok = (id) => signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);
    const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) }));
    const as = (id) => ({ authorization: `Bearer ${tok(id)}` });
    const svc = async (client) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: `${client}-secret`, audience: 'openvibe.network' }) })).json()).access_token;
    try {
        // ── Follow, idempotently; events ──
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/bob')).status, 401, 'signed in only');
        let r = await call('PUT', '/api/v1/me/follows/channel/bob', { headers: as(1) });
        assert.strictEqual(r.status, 201);
        assert.ok(validate('network.follow-status-result@1', r.body).valid, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.target_id, r.body.followers, r.body.following, r.body.notify_email, r.body.notify_push], [BOB, 1, true, true, true]);
        r = await call('PUT', '/api/v1/me/follows/channel/Bob', { headers: as(1) });
        assert.deepStrictEqual([r.status, r.body.followers], [200, 1], 'following again changes nothing (and names are case-insensitive)');
        assert.strictEqual(events().length, 1, 'and announces nothing');
        r = await call('PUT', `/api/v1/me/follows/channel/${BOB}`, { headers: as(1), body: { notify_email: false } });
        assert.deepStrictEqual([r.status, r.body.notify_email, r.body.notify_push], [200, false, true], 'new flags: a change');
        let ev = events();
        assert.deepStrictEqual(ev.map((e) => [e.event_type, e.payload.revision, e.payload.notify_email]), [['network.follow.created', 1, true], ['network.follow.created', 2, false]]);
        ev.forEach(valid);
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/ann', { headers: as(1) })).status, 400, 'never oneself');
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/anon1234', { headers: as(1) })).status, 404, 'a guest is not a channel');
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/nobody', { headers: as(1) })).status, 404);
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/space/bob', { headers: as(1) })).status, 404, 'unknown target type');
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/bob', { headers: as(5) })).status, 403, 'guests do not follow');
        await call('PUT', '/api/v1/me/follows/channel/bob', { headers: as(3) });

        // ── Public count; the viewer's own state; lists are not public ──
        r = await call('GET', '/api/v1/follows/channel/bob');
        assert.deepStrictEqual([r.status, r.body], [200, { target_type: 'channel', target_id: BOB, followers: 2 }]);
        assert.match(r.cache, /public/);
        r = await call('GET', '/api/v1/follows/channel/bob', { headers: as(1) });
        assert.deepStrictEqual([r.body.following, r.body.notify_email], [true, false]);
        assert.match(r.cache, /private/);
        r = await call('GET', '/api/v1/me/follows', { headers: as(1) });
        assert.ok(validate('network.follow-list-result@1', r.body).valid);
        assert.deepStrictEqual(r.body.items.map((i) => i.target_id), [BOB]);
        assert.ok([401, 403].includes((await call('GET', '/api/v1/follows/channel/bob/followers')).status), 'no token: not the owner, not a service');
        assert.strictEqual((await call('GET', '/api/v1/follows/channel/bob/followers', { headers: as(1) })).status, 403, 'a follower is not the owner');
        r = await call('GET', '/api/v1/follows/channel/bob/followers', { headers: as(2) });
        assert.deepStrictEqual([r.status, r.body.items.map((i) => i.follower).sort()], [200, [ANN, CAT].sort()], 'the owner sees who follows');
        r = await call('GET', '/api/v1/follows/channel/bob/followers?limit=1', { headers: { authorization: `Bearer ${await svc('live')}` } });
        assert.deepStrictEqual([r.status, r.body.items.length, typeof r.body.next_cursor], [200, 1, 'string'], 'a service with network.follows.read, paged');
        const page2 = await call('GET', `/api/v1/follows/channel/bob/followers?limit=1&cursor=${r.body.next_cursor}`, { headers: { authorization: `Bearer ${await svc('live')}` } });
        assert.strictEqual(page2.body.items.length, 1);
        assert.notStrictEqual(page2.body.items[0].follower, r.body.items[0].follower, 'the cursor moves on');
        assert.strictEqual(page2.body.next_cursor, null);
        assert.strictEqual((await call('GET', '/api/v1/follows/channel/bob/followers', { headers: { authorization: `Bearer ${await svc('tools')}` } })).status, 403, 'a service without the capability');

        // ── Unfollow, idempotently ──
        r = await call('DELETE', '/api/v1/me/follows/channel/bob', { headers: as(1) });
        assert.deepStrictEqual([r.status, r.body.following, r.body.followers], [200, false, 1]);
        r = await call('DELETE', '/api/v1/me/follows/channel/bob', { headers: as(1) });
        assert.strictEqual(r.status, 200);
        ev = events().filter((e) => e.event_type === 'network.follow.deleted');
        assert.deepStrictEqual(ev.map((e) => [e.payload.revision, e.payload.reason]), [[3, 'unfollowed']], 'one delete, revision 3');
        ev.forEach(valid);
        r = await call('PUT', '/api/v1/me/follows/channel/bob', { headers: as(1) });
        assert.strictEqual(r.status, 200, 'a follow again (the row exists; revision 4)');
        assert.strictEqual(events().pop().payload.revision, 4);

        // ── Account removal ──
        assert.strictEqual(db.transaction(() => follows.onSubjectRemoved(db, CAT))(), 1);
        assert.deepStrictEqual(events().pop().payload.reason, 'account_removed');

        // ── Live backfill and reconciliation (scripts/follows-backfill.js) ──
        const liveFile = path.join(dir, 'live.db');
        const live = new Database(liveFile);
        live.exec(`CREATE TABLE follows (id INTEGER PRIMARY KEY AUTOINCREMENT, follower_id INTEGER NOT NULL, streamer_id INTEGER NOT NULL, email_notify INTEGER DEFAULT 0, push_notify INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(follower_id, streamer_id));
            CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, service TEXT NOT NULL, service_user_id TEXT NOT NULL, subject_id TEXT);`);
        live.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (11, 'network', '1', ?), (12, 'network', '2', ?), (13, 'network', '3', ?)").run(ANN, BOB, CAT);
        live.prepare("INSERT INTO follows (follower_id, streamer_id, email_notify, push_notify, created_at) VALUES (11, 12, 1, 0, '2026-09-01 10:00:00'), (13, 12, 0, 1, '2026-09-02 10:00:00'), (14, 12, 0, 0, '2026-09-03 10:00:00'), (13, 11, 0, 0, '2026-09-04 10:00:00')").run();
        live.close();
        const backfill = require('../scripts/follows-backfill');
        const lines = [];
        const out = (s) => lines.push(s);
        db.close();
        let code = await backfill.main(['--live-db', liveFile, '--db', dbFile], out);
        assert.strictEqual(code, 0);
        assert.match(lines.join('\n'), /live follows 4: import 2, already on Network 1, held 1/);
        assert.match(lines.join('\n'), /held \(follower_has_no_subject\): 1/);
        code = await backfill.main(['--live-db', liveFile, '--db', dbFile, '--apply'], out);
        assert.strictEqual(code, 2, 'refuses --apply without --backup');
        code = await backfill.main(['--live-db', liveFile, '--db', dbFile, '--apply', '--backup', path.join(dir, 'pre-follows.db')], out);
        assert.strictEqual(code, 0, lines.join('\n'));
        assert.ok(fs.existsSync(path.join(dir, 'pre-follows.db')), 'backup taken first');
        assert.match(lines.join('\n'), /imported {3}2; already there 1; held 1/);
        assert.match(lines.join('\n'), /RECONCILED: counts and pairs match/);
        code = await backfill.main(['--live-db', liveFile, '--db', dbFile, '--reconcile'], out);
        assert.strictEqual(code, 0);
        const db2 = new Database(dbFile);
        assert.deepStrictEqual(db2.prepare("SELECT reason FROM follow_import_holds WHERE source = 'live'").all().map((x) => x.reason), ['follower_has_no_subject'], 'held, never dropped');
        const cat = db2.prepare('SELECT notify_email, notify_push, source, created_at FROM user_follows WHERE follower_subject = ? AND target_id = ?').get(CAT, BOB);
        assert.deepStrictEqual(cat, { notify_email: 0, notify_push: 1, source: 'live', created_at: '2026-09-02T10:00:00.000Z' }, 'flags and date carried over');
        const before = db2.prepare('SELECT COUNT(*) AS n FROM network_event_outbox').get().n;
        db2.close();
        code = await backfill.main(['--live-db', liveFile, '--db', dbFile, '--apply', '--backup', path.join(dir, 'pre-follows-2.db')], out);
        assert.strictEqual(code, 0, 'a second run is a no-op');
        const db3 = new Database(dbFile, { readonly: true });
        assert.strictEqual(db3.prepare('SELECT COUNT(*) AS n FROM network_event_outbox').get().n, before, 'the import sends no events');
        db3.close();
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('follows: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
