'use strict';
// ADR-030 step 4: products write follows through /internal/follows (network.follows.write, service token only),
// and with FOLLOWS_AUTHORITY=network the go-live notifications take the followers from Network's own graph
// (no call to Live).
//   node test/follows-authority.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { initDb } = require('../server/db/database');
const { NotificationService } = require('../server/notifications/notification-service');
const { createEventsConsumer } = require('../server/notifications/events-consumer');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-follow-auth-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
require('../server/identity/principals').ensureSchema(db);
for (const c of ['live', 'tools']) db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(`${c}-secret`, c);
const CAROL = ids.newId('user'), DAVE = ids.newId('user'), ERIN = ids.newId('user');
db.prepare('INSERT INTO users (id, username, password_hash, subject_id, role) VALUES (20, ?, ?, ?, ?), (21, ?, ?, ?, ?), (22, ?, ?, ?, ?)')
    .run('carol', 'x', CAROL, 'streamer', 'dave', 'x', DAVE, 'user', 'erin', 'x', ERIN, 'user');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const follows = require('../server/identity/follows');
const principals = require('../server/identity/principals');
const SECRET = 's'.repeat(40);
const notifications = new NotificationService(db);
const consumer = createEventsConsumer({ db, notifications, secrets: SECRET, followsAuthority: 'network', log: { log() {}, warn() {}, error() {} } });
const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use(express.urlencoded({ extended: true }));
app.use('/oauth', require('../server/auth/oauth-routes'));
const routers = follows.routers({ requireAuth, followsGuard: principals.guard('network.follows.read', { legacy: false }) });
app.use('/internal/follows', principals.guard('network.follows.write', { legacy: false }), routers.internal);
app.use('/internal/events', consumer.router);
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const svc = async (client) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: `${client}-secret`, audience: 'openvibe.network' }) })).json()).access_token;
    const call = (method, p, { body, token } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    try {
        const live = await svc('live');
        // ── Writes on a person's behalf ──
        assert.ok([401, 403].includes((await call('PUT', '/internal/follows/channel/carol', { body: { follower: DAVE } })).status), 'no token');
        assert.strictEqual((await call('PUT', '/internal/follows/channel/carol', { body: { follower: DAVE }, token: await svc('tools') })).status, 403, 'without network.follows.write');
        let r = await call('PUT', '/internal/follows/channel/carol', { body: { follower: DAVE, notify_push: false }, token: live });
        assert.deepStrictEqual([r.status, r.body.followers, r.body.following, r.body.notify_push], [201, 1, true, false]);
        r = await call('PUT', `/internal/follows/channel/${CAROL}`, { body: { follower: ERIN }, token: live });
        assert.strictEqual(r.body.followers, 2);
        assert.strictEqual(db.prepare('SELECT source FROM user_follows WHERE follower_subject = ?').get(ERIN).source, 'live', 'the writing service is recorded');
        assert.strictEqual((await call('PUT', '/internal/follows/channel/carol', { body: { follower: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPZ' }, token: live })).status, 404, 'the follower must be a Network account');
        assert.strictEqual((await call('PUT', '/internal/follows/channel/carol', { body: { follower: DAVE, extra: 1 }, token: live })).status, 400);
        r = await call('DELETE', `/internal/follows/channel/carol?follower=${ERIN}`, { token: live });
        assert.deepStrictEqual([r.status, r.body.following, r.body.followers], [200, false, 1]);
        await call('PUT', '/internal/follows/channel/carol', { body: { follower: ERIN }, token: live });
        const evs = db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all().map((x) => JSON.parse(x.envelope)).filter((e) => e.event_type.startsWith('network.follow.'));
        assert.deepStrictEqual(evs.map((e) => e.event_type), ['network.follow.created', 'network.follow.created', 'network.follow.deleted', 'network.follow.created']);

        // ── Go-live with FOLLOWS_AUTHORITY=network: Network's followers, no Live call ──
        const started = {
            event_id: ids.newId('event'), event_type: 'live.stream.started', version: 1, source: 'live',
            actor: { type: 'user', id: CAROL }, subject: { type: 'stream', id: '801', revision: 1 }, visibility: 'public', priority: 'important',
            occurred_at: new Date().toISOString(),
            payload: { stream_id: 801, channel: { username: 'carol', display_name: 'Carol', url: 'https://openvibe.live/@carol', subject: { type: 'user', id: CAROL } }, title: 'Go', category: null, protocol: 'whip', is_nsfw: false, started_at: new Date().toISOString() },
        };
        const raw = JSON.stringify({ event: started, seq: 1 });
        const res = await fetch(`${base}/internal/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...signDeliveryHeaders(raw, SECRET) }, body: raw });
        const body = await res.json();
        assert.strictEqual(res.status, 200, JSON.stringify(body));
        assert.strictEqual(body.outcome, 'notified', JSON.stringify(body));
        const told = db.prepare("SELECT user_id FROM notifications WHERE type = 'STREAM_LIVE' AND sender_id = 20 ORDER BY user_id").all().map((x) => x.user_id);
        assert.deepStrictEqual(told, [21, 22], 'both followers, from Network\'s graph');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('follows authority: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
