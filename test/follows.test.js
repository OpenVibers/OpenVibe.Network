'use strict';
// The follow graph (roadmap WS-E task 4, ADR-030; Contracts 0.65.0): follow and unfollow through
// /api/v1/me/follows (idempotent, never oneself, never a guest), each change writes network.follow.created /
// .deleted with a growing per-pair revision, counts are public and lists are not (the target's owner, or a
// service with network.follows.read). The one-time scripts/follows-backfill.js was retired in plan T2.
//   node test/follows.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-follows-'));
const dbFile = path.join(dir, 'network.db');
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await require('../server/identity/principals').ensureSchema(db);
for (const c of ['live', 'tools']) await db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(`${c}-secret`, c);

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const CAT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC';
await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id, role) VALUES
    (1, 'ann', 'Ann', 'x', ?, 'user'), (2, 'bob', 'Bob', 'x', ?, 'streamer'), (3, 'cat', NULL, 'x', ?, 'user')`).run(ANN, BOB, CAT);
await db.prepare("INSERT INTO users (id, username, password_hash, is_anon) VALUES (5, 'anon1234', 'x', 1)").run();

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

const events = async () => (await db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all()).map((r) => r.envelope).filter((e) => e.event_type.startsWith('network.follow.'));
const valid = (e) => {
    assert.ok(validate('events.event-envelope@1', e).valid);
    const pv = validate(`${e.event_type}@1`, e.payload);
    assert.ok(pv.valid, JSON.stringify(pv.errors));
    assert.deepStrictEqual([e.source, e.visibility, e.subject], ['network', 'subject', { type: 'user', id: e.payload.follower }]);
};

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tok = async (id) => signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);
    const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) }));
    const as = async (id) => ({ authorization: `Bearer ${await tok(id)}` });
    const svc = async (client) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: `${client}-secret`, audience: 'openvibe.network' }) })).json()).access_token;
    try {
        // ── Follow, idempotently; events ──
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/bob')).status, 401, 'signed in only');
        let r = await call('PUT', '/api/v1/me/follows/channel/bob', { headers: await as(1) });
        assert.strictEqual(r.status, 201);
        assert.ok(validate('network.follow-status-result@1', r.body).valid, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.target_id, r.body.followers, r.body.following, r.body.notify_email, r.body.notify_push], [BOB, 1, true, true, true]);
        r = await call('PUT', '/api/v1/me/follows/channel/Bob', { headers: await as(1) });
        assert.deepStrictEqual([r.status, r.body.followers], [200, 1], 'following again changes nothing (and names are case-insensitive)');
        assert.strictEqual((await events()).length, 1, 'and announces nothing');
        r = await call('PUT', `/api/v1/me/follows/channel/${BOB}`, { headers: await as(1), body: { notify_email: false } });
        assert.deepStrictEqual([r.status, r.body.notify_email, r.body.notify_push], [200, false, true], 'new flags: a change');
        let ev = await events();
        assert.deepStrictEqual(ev.map((e) => [e.event_type, e.payload.revision, e.payload.notify_email]), [['network.follow.created', 1, true], ['network.follow.created', 2, false]]);
        ev.forEach(valid);
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/ann', { headers: await as(1) })).status, 400, 'never oneself');
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/anon1234', { headers: await as(1) })).status, 404, 'a guest is not a channel');
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/nobody', { headers: await as(1) })).status, 404);
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/space/bob', { headers: await as(1) })).status, 404, 'unknown target type');
        assert.strictEqual((await call('PUT', '/api/v1/me/follows/channel/bob', { headers: await as(5) })).status, 403, 'guests do not follow');
        await call('PUT', '/api/v1/me/follows/channel/bob', { headers: await as(3) });

        // ── Public count; the viewer's own state; lists are not public ──
        r = await call('GET', '/api/v1/follows/channel/bob');
        assert.deepStrictEqual([r.status, r.body], [200, { target_type: 'channel', target_id: BOB, followers: 2 }]);
        assert.match(r.cache, /public/);
        r = await call('GET', '/api/v1/follows/channel/bob', { headers: await as(1) });
        assert.deepStrictEqual([r.body.following, r.body.notify_email], [true, false]);
        assert.match(r.cache, /private/);
        r = await call('GET', '/api/v1/me/follows', { headers: await as(1) });
        assert.ok(validate('network.follow-list-result@1', r.body).valid);
        assert.deepStrictEqual(r.body.items.map((i) => i.target_id), [BOB]);
        assert.ok([401, 403].includes((await call('GET', '/api/v1/follows/channel/bob/followers')).status), 'no token: not the owner, not a service');
        assert.strictEqual((await call('GET', '/api/v1/follows/channel/bob/followers', { headers: await as(1) })).status, 403, 'a follower is not the owner');
        r = await call('GET', '/api/v1/follows/channel/bob/followers', { headers: await as(2) });
        assert.deepStrictEqual([r.status, r.body.items.map((i) => i.follower).sort()], [200, [ANN, CAT].sort()], 'the owner sees who follows');
        r = await call('GET', '/api/v1/follows/channel/bob/followers?limit=1', { headers: { authorization: `Bearer ${await svc('live')}` } });
        assert.deepStrictEqual([r.status, r.body.items.length, typeof r.body.next_cursor], [200, 1, 'string'], 'a service with network.follows.read, paged');
        const page2 = await call('GET', `/api/v1/follows/channel/bob/followers?limit=1&cursor=${r.body.next_cursor}`, { headers: { authorization: `Bearer ${await svc('live')}` } });
        assert.strictEqual(page2.body.items.length, 1);
        assert.notStrictEqual(page2.body.items[0].follower, r.body.items[0].follower, 'the cursor moves on');
        assert.strictEqual(page2.body.next_cursor, null);
        assert.strictEqual((await call('GET', '/api/v1/follows/channel/bob/followers', { headers: { authorization: `Bearer ${await svc('tools')}` } })).status, 403, 'a service without the capability');

        // ── Unfollow, idempotently ──
        r = await call('DELETE', '/api/v1/me/follows/channel/bob', { headers: await as(1) });
        assert.deepStrictEqual([r.status, r.body.following, r.body.followers], [200, false, 1]);
        r = await call('DELETE', '/api/v1/me/follows/channel/bob', { headers: await as(1) });
        assert.strictEqual(r.status, 200);
        ev = (await events()).filter((e) => e.event_type === 'network.follow.deleted');
        assert.deepStrictEqual(ev.map((e) => [e.payload.revision, e.payload.reason]), [[3, 'unfollowed']], 'one delete, revision 3');
        ev.forEach(valid);
        r = await call('PUT', '/api/v1/me/follows/channel/bob', { headers: await as(1) });
        assert.strictEqual(r.status, 200, 'a follow again (the row exists; revision 4)');
        assert.strictEqual((await events()).pop().payload.revision, 4);

        // ── Account removal ──
        assert.strictEqual(await db.tx(async () => await follows.onSubjectRemoved(db, CAT)), 1);
        assert.deepStrictEqual((await events()).pop().payload.reason, 'account_removed');

        // The Live backfill and its reconciliation used to be exercised here through the one-time
        // scripts/follows-backfill.js (retired in plan T2); importFollows() itself is covered by
        // test/follow-notify.test.js.
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('follows: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
