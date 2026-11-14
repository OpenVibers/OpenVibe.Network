'use strict';
// Friends across every site (plan §AB.51; Contracts 0.431.0): a person adds another through
// /api/v1/me/friends, and every change writes its event (network.friend.requested / .accepted / .removed)
// into the outbox in the same transaction that stores the change. GET /internal/friends answers a service
// holding network.friends.read with the person's mutual friends as subjects only, and a block ends a
// friendship with a removal. Adding again what is already added changes nothing and announces nothing.
//   node --import ./test/helpers/pg-preload.mjs test/friends.test.js
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-friends-'));
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
// chat is registered on the host, not seeded here: a copy of tools, then its grants seeded again.
{
    const cols = (await db.prepare("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?").all('oauth_clients')).map(x => x.name).filter(n => n !== 'client_id' && n !== 'id');
    await db.prepare(`INSERT INTO oauth_clients (client_id, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM oauth_clients WHERE client_id = 'tools' ON CONFLICT DO NOTHING`).run('chat');
}
await require('../server/identity/principals').ensureSchema(db);
for (const c of ['chat', 'tools']) await db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(`${c}-secret`, c);

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const CAT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC';
await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id, role) VALUES
    (1, 'ann', 'Ann', 'x', ?, 'user'), (2, 'bob', 'Bob <b>', 'x', ?, 'user'), (3, 'cat', NULL, 'x', ?, 'user')`).run(ANN, BOB, CAT);

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const friends = require('../server/identity/friends');
const blocks = require('../server/identity/blocks');
const principals = require('../server/identity/principals');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/v1/me/friends', friends.userRouter(requireAuth));
app.use('/api/v1/me/blocks', blocks.userRouter(requireAuth));
app.get('/internal/friends', principals.guard('network.friends.read'), friends.internalHandler(db));
const server = http.createServer(app);

const events = async () => (await db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all()).map(r => r.envelope).filter(e => /^network\.friend\./.test(e.event_type));
const valid = (e) => {
    const v = validate('events.event-envelope@1', e);
    assert.ok(v.valid, JSON.stringify(v.errors));
    const pv = validate(`${e.event_type}@1`, e.payload);
    assert.ok(pv.valid, JSON.stringify(pv.errors));
    assert.deepStrictEqual([e.source, e.visibility, e.subject, e.actor], ['network', 'subject', { type: 'user', id: e.payload.to }, { type: 'user', id: e.payload.from }]);
};

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tok = async (id) => signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);
    const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async r => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) }));
    const as = async (id) => ({ authorization: `Bearer ${await tok(id)}` });
    const svc = async (client) => (await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: `${client}-secret`, audience: 'openvibe.network' }) }).then(r => r.json())).access_token;

    // ── A person adds another: a request, and the event rides with it ──
    let r = await call('PUT', '/api/v1/me/friends/bob', { headers: await as(1) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.changed, r.body.friend.subject, r.body.friend.username, r.body.friend.state], [true, BOB, 'bob', 'pending']);
    let evs = await events();
    assert.strictEqual(evs.length, 1, 'one event for the add');
    valid(evs[0]);
    assert.strictEqual(evs[0].event_type, 'network.friend.requested');
    assert.deepStrictEqual([evs[0].payload.from, evs[0].payload.to], [ANN, BOB], 'the one who acted is the actor; the other is the subject');

    // Adding again what is already added changes nothing and announces nothing.
    r = await call('PUT', '/api/v1/me/friends/bob', { headers: await as(1) });
    assert.deepStrictEqual([r.status, r.body.changed], [200, false]);
    assert.strictEqual((await events()).length, 1, 'and announces nothing');

    // ── They add back: the two are friends now ──
    r = await call('PUT', '/api/v1/me/friends/ann', { headers: await as(2) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.friend.state, 'friends');
    evs = await events();
    assert.strictEqual(evs.length, 2);
    valid(evs[1]);
    assert.strictEqual(evs[1].event_type, 'network.friend.accepted');
    assert.deepStrictEqual([evs[1].payload.from, evs[1].payload.to], [BOB, ANN]);

    // The accept route says the same thing as adding back.
    r = await call('PUT', '/api/v1/me/friends/cat', { headers: await as(1) });
    assert.strictEqual(r.status, 201);
    r = await call('POST', '/api/v1/me/friends/ann/accept', { headers: await as(3) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.friend.state, 'friends');
    const accepted = (await events()).filter(e => e.event_type === 'network.friend.accepted');
    assert.strictEqual(accepted.length, 2);
    assert.deepStrictEqual([accepted[1].payload.from, accepted[1].payload.to], [CAT, ANN]);
    // Accepting a request that was never made is refused.
    r = await call('POST', '/api/v1/me/friends/bob/accept', { headers: await as(3) });
    assert.deepStrictEqual([r.status, r.body.code], [404, 'friends.no_request']);

    // ── Removing: the friendship ends and the pair is told ──
    r = await call('DELETE', '/api/v1/me/friends/bob', { headers: await as(1) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    evs = await events();
    const last = evs[evs.length - 1];
    valid(last);
    assert.strictEqual(last.event_type, 'network.friend.removed');
    assert.deepStrictEqual([last.payload.from, last.payload.to], [ANN, BOB]);
    r = await call('DELETE', '/api/v1/me/friends/bob', { headers: await as(1) });
    assert.deepStrictEqual([r.status, r.body.code], [404, 'friends.not_added'], 'removing again changes nothing');
    assert.strictEqual((await events()).length, evs.length, 'and announces nothing');

    // The pair's revision grows with every change of the pair, so a consumer can apply the latest.
    const pair = evs.filter(e => (e.payload.from === ANN && e.payload.to === BOB) || (e.payload.from === BOB && e.payload.to === ANN)).map(e => e.payload.revision);
    assert.deepStrictEqual(pair, [1, 2, 3], `the pair's revision grows: ${JSON.stringify(pair)}`);

    // ── A block ends the friendship: both sides close, and the pair is told ──
    await call('PUT', '/api/v1/me/friends/bob', { headers: await as(1) });
    await call('PUT', '/api/v1/me/friends/ann', { headers: await as(2) });
    assert.strictEqual(await friends.outgoing(db, ANN, BOB), true);
    const before = (await events()).length;
    r = await call('PUT', '/api/v1/me/blocks/bob', { headers: await as(1) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const blocked = (await events()).slice(before);
    assert.strictEqual(blocked.length, 1, 'the block ends the friendship with one event');
    valid(blocked[0]);
    assert.strictEqual(blocked[0].event_type, 'network.friend.removed');
    assert.deepStrictEqual([blocked[0].payload.from, blocked[0].payload.to], [ANN, BOB], 'the blocker is the actor');
    assert.strictEqual(await friends.outgoing(db, ANN, BOB), false, 'the blocker\'s side closed');
    assert.strictEqual(await friends.outgoing(db, BOB, ANN), false, 'and the other side too');
    // Blocking again changes nothing and announces nothing.
    const before2 = (await events()).length;
    await call('PUT', '/api/v1/me/blocks/bob', { headers: await as(1) });
    assert.strictEqual((await events()).length, before2, 'and announces nothing');

    // ── In the same transaction: a change that fails after the row is written leaves neither row nor event ──
    const before3 = (await events()).length;
    const enqueue = require('../server/developer/event-relay').writerFor(db);
    const real = enqueue.enqueue;
    enqueue.enqueue = () => { throw new Error('outbox down'); };
    await assert.rejects(async () => await friends.setFriend(db, ANN, CAT, false), /outbox down/);
    enqueue.enqueue = real;
    assert.strictEqual(await friends.outgoing(db, ANN, CAT), true, 'rolled back with its event');
    assert.strictEqual((await events()).length, before3);

    // ── /internal/friends for services: subjects only, for the capability ──
    const chat = await svc('chat');
    const tools = await svc('tools');
    r = await call('GET', `/internal/friends?subject=${ANN}`, { headers: { authorization: `Bearer ${chat}` } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['friends', 'subject'], 'the contract shape');
    assert.deepStrictEqual(r.body.friends, [CAT], 'mutual friends only, as subjects; bob is blocked');
    for (const s of r.body.friends) assert.ok(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(s), 'subjects only, never names');
    assert.ok(r.cache.includes('no-store'));
    r = await call('GET', `/internal/friends?subject=${CAT}`, { headers: { authorization: `Bearer ${chat}` } });
    assert.deepStrictEqual(r.body.friends, [ANN]);
    r = await call('GET', '/internal/friends?subject=bob', { headers: { authorization: `Bearer ${chat}` } });
    assert.strictEqual(r.status, 400, 'subjects only');
    r = await call('GET', `/internal/friends?subject=${ANN}`, { headers: { authorization: `Bearer ${tools}` } });
    assert.strictEqual(r.status, 403, 'tools does not hold network.friends.read');
    r = await call('GET', `/internal/friends?subject=${ANN}`);
    assert.ok([401, 403].includes(r.status), 'no credential');
    r = await call('GET', `/internal/friends?subject=${ANN}`, { headers: { 'x-internal-key': 'legacy-key' } });
    assert.ok([401, 403].includes(r.status), 'never the shared key');
    assert.ok((await principals.grantsFor(db, 'chat', 'openvibe.network')).some(g => g.capability === 'network.friends.read'), 'chat holds network.friends.read');

    server.close(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('friends: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
