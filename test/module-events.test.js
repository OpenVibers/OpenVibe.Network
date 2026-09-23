'use strict';
// User modules, Wave 1 item 24 (server/identity/modules.js, module-events.js):
//   - every change emits network.module.updated in the same transaction (network_event_outbox), with the
//     owner, namespace, changed keys and revision, never a private value; revisions survive deletes
//   - chat.preferences is owned by Chat (the contracts' owner since 0.32.0); Live's old write grant narrows
//   - owner-service DELETE; account removal and merge (onSubjectRemoved/onSubjectMerged) with events, and
//     triggers that refuse deleting or re-keying an account while module rows remain; guest -> account link
//   - onOwnerRemoved: a retired owner makes its namespace read-only; delete-after-retention sweeps
//   - the relay publishes rows written while it was off
//   node test/module-events.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-module-events-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
for (const [c, s] of [['live', 'live-secret'], ['tools', 'tools-secret']]) db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(s, c);
// Chat's principal is provisioned by hand in production (no seeded client); the grants follow at boot.
db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('chat', 'chat-secret', 'OpenVibe.Chat', '[]', 1)").run();
// A Live write grant as an older boot seeded it (with chat.preferences), to see it narrow.
db.prepare("UPDATE principal_grants SET namespaces = ? WHERE client_id = 'live' AND capability = 'network.modules.write'").run(JSON.stringify(['chat.preferences', 'chat.tts_defaults', 'live.profile']));
require('../server/identity/principals').ensureSchema(db);

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const CAT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC';
const GUEST = 'gst_01JAB2C3D4E5F6G7H8J9K0MNPG';
db.prepare(`INSERT INTO users (id, username, password_hash, subject_id) VALUES (1, 'ann', 'x', '${ANN}'), (2, 'bob', 'x', '${BOB}'), (3, 'cat', 'x', '${CAT}')`).run();
db.prepare(`INSERT INTO anon_users (id, anon_number, session_token, subject_id) VALUES (50, 7, 'anon-token-7', '${GUEST}')`).run();

const modulesLib = require('../server/identity/modules');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/auth', require('../server/auth/routes'));
app.use('/api/modules', modulesLib.userRouter(requireAuth));
app.use('/internal', require('../server/internal/routes'));
const server = http.createServer(app);

/** Module events in the outbox, oldest first (after `afterId`). */
const events = (afterId = 0) => db.prepare("SELECT id, envelope FROM network_event_outbox WHERE id > ? ORDER BY id").all(afterId)
    .map(r => ({ id: r.id, ...JSON.parse(r.envelope) })).filter(e => e.event_type === 'network.module.updated');
const lastId = () => (db.prepare('SELECT MAX(id) AS id FROM network_event_outbox').get() || {}).id || 0;
const valid = (e) => { const v = contracts.validate('events.event-envelope@1', e.id ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'id')) : e); assert.ok(v.valid, JSON.stringify(v.errors)); };

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
    const tokenOf = (id) => ({ authorization: `Bearer ${signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config)}` });
    const svc = async (client) => (await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: `${client}-secret`, audience: 'openvibe.network' }) }).then(r => r.json()));

    // ── Grants: Chat reads and writes chat.preferences; Live's write grant lost it ──
    const grant = (c, cap) => JSON.parse(db.prepare('SELECT namespaces FROM principal_grants WHERE client_id = ? AND capability = ?').get(c, cap).namespaces);
    assert.deepStrictEqual(grant('chat', 'network.modules.read'), ['chat.preferences']);
    assert.deepStrictEqual(grant('chat', 'network.modules.write'), ['chat.preferences']);
    assert.deepStrictEqual(grant('live', 'network.modules.write'), ['chat.tts_defaults', 'live.profile'], 'the old default narrows at boot');
    assert.ok(grant('live', 'network.modules.read').includes('chat.preferences'), 'Live keeps reading it');
    // Chat manages its own Events subscriptions (live.release.deployed, network.module.updated).
    const chatEvents = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'chat', client_secret: 'chat-secret', audience: 'openvibe.events', scope: 'events.subscription.manage' }) }).then(r => r.json());
    assert.strictEqual(chatEvents.scope, 'events.subscription.manage', JSON.stringify(chatEvents));
    const chatTok = await svc('chat');
    const claims = JSON.parse(Buffer.from(chatTok.access_token.split('.')[1], 'base64url').toString());
    assert.deepStrictEqual(claims.ns, ['chat.preferences']);
    const chat = { authorization: `Bearer ${chatTok.access_token}` };
    const live = { authorization: `Bearer ${(await svc('live')).access_token}` };

    // ── Ownership: chat.preferences belongs to Chat ──
    assert.strictEqual(modulesLib.ownerOf('chat.preferences'), 'chat');
    assert.strictEqual(modulesLib.ownerOf('chat.tts_defaults'), 'live');
    let r = await call('PUT', `/internal/modules/chat.preferences/${ANN}`, { headers: live, body: { data: { timestamps: true } } });
    assert.strictEqual(r.status, 403, 'Live no longer writes chat.preferences');

    // ── Events on write: created, then updated with the changed keys only, no values ──
    let mark = lastId();
    r = await call('PUT', `/internal/modules/chat.preferences/${ANN}`, { headers: { ...chat, 'if-match': '0' }, body: { data: { timestamps: true, compact: false } } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); assert.strictEqual(r.body.updated_by, 'svc:chat'); assert.strictEqual(r.body.revision, 1);
    let ev = events(mark);
    assert.strictEqual(ev.length, 1); valid(ev[0]);
    assert.deepStrictEqual(ev[0].actor, { type: 'service', id: 'chat' });
    assert.strictEqual(ev[0].visibility, 'internal'); assert.strictEqual(ev[0].source, 'network');
    assert.deepStrictEqual(ev[0].subject, { type: 'user_module', id: `${ANN}:chat.preferences`, revision: 1 });
    assert.deepStrictEqual(ev[0].payload, { owner: { type: 'user', id: ANN }, namespace: 'chat.preferences', namespace_owner: 'chat', schema_version: 1, revision: 1, change: 'created', reason: 'write', keys: ['compact', 'timestamps'] });
    mark = lastId();
    r = await call('PUT', '/api/modules/chat.preferences', { headers: { ...tokenOf(1), 'if-match': '1' }, body: { data: { timestamps: true, font_scale: 1.2 } } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.revision, 2);
    ev = events(mark);
    assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual(ev[0].actor, { type: 'user', id: ANN });
    assert.deepStrictEqual(ev[0].payload.keys, ['compact', 'font_scale'], 'timestamps did not change');
    assert.strictEqual(ev[0].payload.change, 'updated');
    assert.ok(!JSON.stringify(ev[0].payload).includes('1.2') && !('public' in ev[0].payload), 'a private namespace never carries a value');
    r = await call('PUT', `/internal/modules/chat.preferences/${ANN}`, { headers: { ...chat, 'if-match': '1' }, body: { data: { compact: true } } });
    assert.strictEqual(r.status, 412, 'a stale write emits nothing');
    assert.strictEqual(events(mark).length, 1);

    // ── Public fields: the changed public values travel, private ones never ──
    mark = lastId();
    r = await call('PUT', `/internal/modules/live.profile/${ANN}`, { headers: live, body: { data: { followers: 42, is_streamer: true, stream_minutes_30d: 900 } } });
    assert.strictEqual(r.status, 201);
    r = await call('PUT', `/internal/modules/live.profile/${ANN}`, { headers: live, body: { data: { followers: 43, is_streamer: true, stream_minutes_30d: 950 } } });
    ev = events(mark);
    assert.deepStrictEqual(ev[0].payload.public, { followers: 42, is_streamer: true });
    assert.deepStrictEqual(ev[1].payload.keys, ['followers', 'stream_minutes_30d']);
    assert.deepStrictEqual(ev[1].payload.public, { followers: 43 }, 'stream_minutes_30d is not public');

    // ── Deletes: user and owner service; revisions never go back ──
    mark = lastId();
    r = await call('DELETE', '/api/modules/chat.preferences', { headers: tokenOf(1) });
    assert.strictEqual(r.status, 204);
    ev = events(mark);
    assert.strictEqual(ev.length, 1); valid(ev[0]);
    assert.deepStrictEqual([ev[0].payload.change, ev[0].payload.reason, ev[0].payload.revision, ev[0].subject.revision], ['deleted', 'delete', 3, 3]);
    assert.deepStrictEqual(ev[0].payload.keys, ['font_scale', 'timestamps'], 'the keys that went');
    r = await call('PUT', '/api/modules/chat.preferences', { headers: { ...tokenOf(1), 'if-match': '0' }, body: { data: { compact: true } } });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.revision, 4, 'a new record continues after the delete');
    r = await call('DELETE', `/internal/modules/chat.preferences/${ANN}`, { headers: live });
    assert.strictEqual(r.status, 403, 'only the owner service deletes');
    r = await call('DELETE', `/internal/modules/chat.preferences/${ANN}`, { headers: { ...chat, 'if-match': '3' } });
    assert.strictEqual(r.status, 412, JSON.stringify(r.body));
    mark = lastId();
    r = await call('DELETE', `/internal/modules/chat.preferences/${ANN}`, { headers: { ...chat, 'if-match': '4' } });
    assert.strictEqual(r.status, 204);
    ev = events(mark);
    assert.deepStrictEqual([ev[0].payload.reason, ev[0].payload.revision, ev[0].actor.id], ['owner_delete', 5, 'chat']);
    r = await call('DELETE', `/internal/modules/chat.preferences/${ANN}`, { headers: chat });
    assert.strictEqual(r.status, 404);
    r = await call('DELETE', `/internal/modules/chat.preferences/${ANN}`, { headers: { 'x-internal-key': 'legacy-key' } });
    assert.strictEqual(r.status, 403, 'never the shared key');

    // ── Account removal: rows and revisions go, one event each; the trigger guards the account row ──
    modulesLib.write(db, BOB, 'chat.preferences', { timestamps: true }, { writer: { type: 'service', id: 'chat' } });
    modulesLib.write(db, BOB, 'live.profile', { followers: 3 }, { writer: { type: 'service', id: 'live' } });
    assert.throws(() => db.prepare('DELETE FROM users WHERE id = 2').run(), /onSubjectRemoved/, 'an account with modules cannot just be deleted');
    assert.throws(() => db.prepare("UPDATE users SET subject_id = 'usr_01JAB2C3D4E5F6G7H8J9K0ZZZZ' WHERE id = 2").run(), /onSubjectMerged/);
    mark = lastId();
    db.transaction(() => {
        assert.strictEqual(modulesLib.onSubjectRemoved(db, BOB), 2);
        db.prepare('DELETE FROM users WHERE id = 2').run();
    })();
    ev = events(mark);
    assert.deepStrictEqual(ev.map(e => [e.payload.namespace, e.payload.change, e.payload.reason, e.actor.type]),
        [['chat.preferences', 'deleted', 'subject_removed', 'system'], ['live.profile', 'deleted', 'subject_removed', 'system']]);
    ev.forEach(valid);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM user_modules WHERE subject_id = ?').get(BOB).n, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM user_module_revisions WHERE subject_id = ?').get(BOB).n, 0);
    assert.throws(() => modulesLib.onSubjectRemoved(db, 2), /subject id/);

    // ── Merge: CAT folds into ANN. Moved where ANN had none, dropped where ANN has one ──
    modulesLib.write(db, CAT, 'chat.preferences', { hide_emotes: true }, { writer: { type: 'service', id: 'chat' } });
    modulesLib.write(db, CAT, 'live.profile', { followers: 9 }, { writer: { type: 'service', id: 'live' } });
    mark = lastId();
    const merged = modulesLib.onSubjectMerged(db, { from: CAT, into: ANN });
    assert.deepStrictEqual(merged, { moved: 1, dropped: 1 });
    const annPrefs = modulesLib.read(db, ANN, 'chat.preferences');
    assert.deepStrictEqual(annPrefs.data, { hide_emotes: true });
    assert.strictEqual(annPrefs.revision, 6, 'continues from ANN\'s own history');
    assert.strictEqual(annPrefs.updated_by, 'svc:network');
    assert.strictEqual(modulesLib.read(db, ANN, 'live.profile').data.followers, 43, 'the survivor\'s record wins');
    ev = events(mark);
    assert.deepStrictEqual(ev.map(e => [e.payload.owner.id, e.payload.namespace, e.payload.change, (e.payload.merged_into || e.payload.merged_from || {}).id]), [
        [ANN, 'chat.preferences', 'created', CAT], [CAT, 'chat.preferences', 'deleted', ANN], [CAT, 'live.profile', 'deleted', ANN],
    ]);
    ev.forEach(valid);
    assert.ok(!('public' in ev[2].payload), 'a delete carries no values');
    db.prepare('DELETE FROM users WHERE id = 3').run();   // nothing left: the trigger lets it go
    assert.throws(() => modulesLib.onSubjectMerged(db, { from: ANN, into: ANN }), /same subject/);

    // ── Guest -> account: POST /api/auth/anon/:token/link moves the guest's modules ──
    modulesLib.write(db, GUEST, 'chat.preferences', { compact: true }, { writer: { type: 'service', id: 'chat' } });
    modulesLib.write(db, GUEST, 'chat.tts_defaults', { rate: 1.5 }, { writer: { type: 'user' }, expectedRevision: 0 });
    assert.throws(() => db.prepare('DELETE FROM anon_users WHERE id = 50').run(), /onSubjectRemoved/);
    r = await call('POST', '/api/auth/anon/anon-token-7/link', { headers: tokenOf(1) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(modulesLib.read(db, ANN, 'chat.tts_defaults').data, { rate: 1.5 }, 'moved');
    assert.deepStrictEqual(modulesLib.read(db, ANN, 'chat.preferences').data, { hide_emotes: true }, 'the account kept its own');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM user_modules WHERE subject_id = ?').get(GUEST).n, 0);

    // ── onOwnerRemoved: a retired owner freezes its namespaces; delete-after-retention sweeps ──
    modulesLib.write(db, ANN, 'tools.usage', { recent: [{ tool: 'yt' }] }, { writer: { type: 'service', id: 'tools' } });
    const realGet = contracts.services.get;
    contracts.services.get = (id) => (id === 'tools' || id === 'chat' ? { ...realGet(id), status: 'retired' } : realGet(id));
    try {
        const w = modulesLib.write(db, ANN, 'chat.preferences', { compact: true }, { writer: { type: 'user' }, expectedRevision: 6 });
        assert.strictEqual(w.status, 409); assert.strictEqual(w.code, 'modules.namespace_retired');
        r = await call('GET', '/api/modules', { headers: tokenOf(1) });
        assert.strictEqual(r.body.namespaces.find(n => n.namespace === 'chat.preferences').userWritable, false);
        const t0 = Date.now();
        assert.strictEqual(modulesLib.sweepRetired(db, { now: t0 }), 0, 'retention starts when Network first sees the retirement');
        assert.strictEqual(modulesLib.sweepRetired(db, { now: t0 + 89 * 86400000 }), 0);
        mark = lastId();
        assert.strictEqual(modulesLib.sweepRetired(db, { now: t0 + 91 * 86400000 }), 1, 'tools.usage: 90 days');
        assert.deepStrictEqual(events(mark).map(e => [e.payload.namespace, e.payload.reason]), [['tools.usage', 'owner_delete']]);
        assert.ok(modulesLib.read(db, ANN, 'chat.preferences'), 'retain-readonly keeps records');
        r = await call('DELETE', '/api/modules/chat.preferences', { headers: tokenOf(1) });
        assert.strictEqual(r.status, 204, 'people can always delete their own');
    } finally { contracts.services.get = realGet; }
    modulesLib.sweepRetired(db);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM user_module_retirements').get().n, 0, 'un-retired again');

    // ── Relay: rows written while it was off are published, envelopes valid ──
    const published = [];
    const fakeEvents = async (url, init) => {
        const body = JSON.parse(init.body);
        const list = body.events || [body];
        published.push(...list);
        const results = list.map((e, i) => ({ event_id: e.event_id, seq: published.length - list.length + i + 1, duplicate: false }));
        return new Response(JSON.stringify(body.events ? { results } : results[0]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const relay = require('../server/developer/event-relay');
    const outbox = relay.startRelay(db, { eventsUrl: 'http://events.test', privateKey: keys.privateKey, issuer: config.jwt.issuer, fetch: fakeEvents, autoStart: false, log: { log() {}, warn() {} } });
    await outbox.flush();
    const mod = published.filter(e => e.event_type === 'network.module.updated');
    assert.strictEqual(mod.length, events().length, 'every module event went out');
    mod.forEach(valid);
    assert.strictEqual(outbox.pending(), 0);
    // With the relay on, a write lands in the same outbox and goes on the next flush.
    modulesLib.write(db, ANN, 'live.profile', { followers: 44 }, { writer: { type: 'service', id: 'live' } });
    await outbox.flush();
    assert.strictEqual(published.at(-1).payload.revision, 3); assert.strictEqual(published.at(-1).subject.id, `${ANN}:live.profile`);
    await relay.stopRelay(db);

    server.close(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('module events and lifecycle: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
