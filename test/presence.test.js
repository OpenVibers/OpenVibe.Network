'use strict';
// Presence (plan 2026-10-22 track X item 9; Contracts 0.318.0): Network owns a person's chosen online status.
//   - who may see: themselves, people they follow, people they share a DM with; never a stranger;
//   - invisible and the "Show my status" switch are never disclosed to anyone else;
//   - online under 2 minutes after a heartbeat, away after 10 minutes without input, offline after 3
//     minutes without a heartbeat (a fake clock, and an idle heartbeat leaves last_active_at alone);
//   - a Live stream makes live true (Live's public list over loopback, cached);
//   - network.presence.changed is a real change, debounced 30 s, public view only;
//   - PUT validates state, status line, one emoji and show_status; GET /internal/presence needs
//     network.presence.read and answers for one person.
//   node test/presence.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { validate, serviceAuth } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');

const T0 = Date.parse('2026-11-07T09:00:00.000Z');
const MIN = 60 * 1000;
const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const CAT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC';
const DAN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPD';

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await require('../server/identity/principals').ensureSchema(db);
await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id, role) VALUES
    (1, 'ann', 'Ann', 'x', ?, 'user'), (2, 'bob', 'Bob', 'x', ?, 'streamer'), (3, 'cat', 'Cat', 'x', ?, 'user'), (4, 'dan', 'Dan', 'x', ?, 'user')`).run(ANN, BOB, CAT, DAN);
// Ann follows Bob (the follow rule is Network's own graph; Chat supplies the DM rule below).
await db.prepare(`INSERT INTO user_follows (follower_subject, target_type, target_id, active) VALUES (?, 'channel', ?, 1)`).run(ANN, BOB);
// Live user 2 is Bob (identity_legacy_map is what Network uses to map Live's stream rows to subjects).
await db.prepare(`INSERT INTO identity_legacy_map (source_system, source_type, source_id, subject_id, verified_at)
    VALUES ('live', 'user', '2', ?, ov_now_iso())`).run(BOB);

// A fake first-party edge for Live's public list and Chat's DM peer read.
let liveRows = [{ user_id: 2, is_live: 1, username: 'bob' }];
const edge = express();
edge.use(express.json());
const dmCalls = [];
edge.get('/api/streams', (req, res) => res.json({ streams: liveRows }));
edge.post('/internal/chat/dm/peers', (req, res) => {
    if (String(req.headers.authorization || '') !== 'Bearer svc-token') return res.status(401).json({ error: 'token.missing' });
    const b = req.body || {};
    dmCalls.push(b);
    const peers = b.subject === ANN ? (Array.isArray(b.candidates) ? b.candidates : []).filter((s) => s === CAT) : [];
    res.json({ subject: b.subject, peers });
});
const edgeServer = http.createServer(edge);

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' }, services: { live: { internalUrl: '' }, chat: { internalUrl: '' } } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const principals = require('../server/identity/principals');
const { createPresence } = require('../server/presence');
let NOW = T0;
const presence = createPresence({
    db, requireAuth, guard: principals.guard, selfToken: () => 'svc-token', config, now: () => NOW,
});
const app = express();
app.use(express.json());
Object.assign(app.locals, { db, config, publicKey: keys.publicKey, privateKey: keys.privateKey });
app.use('/api/v1/me/presence', requireAuth, presence.me);
app.use('/api/v1/presence', requireAuth, presence.pub);
app.use('/internal/presence', principals.guard('network.presence.read'), presence.internal);
const server = http.createServer(app);

const events = async (subject) => (await db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all())
    .map((r) => r.envelope).filter((e) => e.event_type === 'network.presence.changed' && (!subject || e.payload.subject === subject));
const serviceToken = (cap = 'network.presence.read') => {
    // The guard verifies against the real clock, not the fake presence clock.
    const t = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: config.jwt.issuer, sub: 'svc:chat', actor_type: 'service', aud: ['openvibe.network'], cap: [cap],
        iat: t, exp: t + 300, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    }, keys.privateKey);
};

(async () => {
    await new Promise((r) => edgeServer.listen(0, '127.0.0.1', r));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const edgeBase = `http://127.0.0.1:${edgeServer.address().port}`;
    config.services.live.internalUrl = edgeBase;
    config.services.chat.internalUrl = edgeBase;
    const base = `http://127.0.0.1:${server.address().port}`;
    const tok = async (id) => signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);
    const as = async (id) => ({ authorization: `Bearer ${await tok(id)}` });
    const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) }));
    const heartbeat = async (id, body = {}) => call('POST', '/api/v1/me/presence/heartbeat', { body, headers: await as(id) });
    const get = async (id, subjects) => call('GET', `/api/v1/presence?subjects=${subjects.map(encodeURIComponent).join(',')}`, { headers: await as(id) });
    const bySubject = (body) => Object.fromEntries((body.presence || []).map((p) => [p.subject, p]));
    const validEvent = (e) => {
        const ev = validate('events.event-envelope@1', e);
        if (!ev.valid) console.error('envelope:', JSON.stringify(e), JSON.stringify(ev.errors));
        assert.ok(ev.valid, JSON.stringify(ev.errors));
        const pv = validate('network.presence.changed@1', e.payload);
        if (!pv.valid) console.error('payload:', JSON.stringify(e.payload), JSON.stringify(pv.errors));
        assert.ok(pv.valid, JSON.stringify(pv.errors));
        assert.deepStrictEqual([e.source, e.visibility, e.subject], ['network', 'internal', { type: 'user', id: e.payload.subject }]);
        assert.ok(!('invisible' === e.payload.state));
        return true;
    };

    // ── The network's "who is online" strip is filled from this same heartbeat ──
    // The person and the site their tab runs on (the request's Origin); a bot is left out. Kept in memory only.
    {
        const seenStore = require('../server/frame/seen');
        seenStore.reset();
        const beatWith = (headers) => call('POST', '/api/v1/me/presence/heartbeat', { body: {}, headers });
        const UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130';
        const beatAnn = await beatWith({ ...(await as(1)), origin: 'https://openvibe.live', 'user-agent': UA });
        assert.strictEqual(beatAnn.status, 200);
        const first = seenStore.snapshot(NOW);
        assert.strictEqual(first.members.get(ANN).site, 'live', 'the site comes from the Origin');
        await beatWith({ ...(await as(2)), origin: 'https://openvibe.games', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
        assert.ok(!seenStore.snapshot(NOW).members.has(BOB), 'a bot heartbeat is not a person online');
        const noOrigin = await beatWith({ ...(await as(3)), 'user-agent': UA });
        assert.strictEqual(noOrigin.status, 200);
        assert.strictEqual(seenStore.snapshot(NOW).members.get(CAT).site, null, 'no Origin: counted, with no site named');
        seenStore.reset();
    }

    // ── The people who may see: self, a follow, a DM peer; a stranger never ──
    for (const id of [1, 2, 3, 4]) { const hb = await heartbeat(id); assert.strictEqual(hb.status, 200, `heartbeat ${id}: ${JSON.stringify(hb.body)}`); }
    let r = await get(1, [ANN, BOB, CAT, DAN]);
    assert.strictEqual(r.status, 200);
    let seen = bySubject(r.body);
    assert.deepStrictEqual(Object.keys(seen).sort(), [ANN, BOB, CAT].sort(), 'self, follow and DM peer; never the stranger');
    assert.strictEqual(seen[BOB].state, 'online');
    assert.strictEqual(seen[BOB].live, true, 'Live makes live true');
    assert.strictEqual(seen[CAT].state, 'online');
    assert.ok(r.cache.includes('private'), 'private cache');
    assert.ok((await events()).every(validEvent), 'every event validates');
    assert.strictEqual(dmCalls.at(-1).subject, ANN, 'the DM half is read as Ann');
    assert.ok(dmCalls.at(-1).candidates.includes(CAT), 'Chat is asked about the DM candidate');
    r = await get(4, [ANN, BOB, CAT]);
    assert.deepStrictEqual(r.body.presence, [], 'Dan follows and DMs nobody');

    // ── Away after 10 minutes without input, offline after 3 minutes without a heartbeat ──
    NOW = T0 + 10 * MIN + 1000;
    assert.strictEqual((await heartbeat(2, { idle: true })).status, 200);
    const bobRow = await db.prepare('SELECT last_active_at FROM person_presence WHERE subject_id = ?').get(BOB);
    assert.strictEqual(bobRow.last_active_at, new Date(T0).toISOString(), 'an idle heartbeat leaves last_active_at alone');
    seen = bySubject((await get(1, [BOB])).body);
    assert.strictEqual(seen[BOB].state, 'away');
    NOW = T0 + 12 * MIN + 2000;
    seen = bySubject((await get(1, [BOB])).body);
    assert.strictEqual(seen[BOB].state, 'away', 'two minutes without a heartbeat is fading, not gone');
    NOW = T0 + 13 * MIN + 2000;
    seen = bySubject((await get(1, [BOB])).body);
    assert.strictEqual(seen[BOB].state, 'offline', 'three minutes without a heartbeat');
    NOW = T0 + 14 * MIN;
    await heartbeat(2);
    seen = bySubject((await get(1, [BOB])).body);
    assert.strictEqual(seen[BOB].state, 'online', 'a fresh heartbeat comes back');

    // ── Invisible: absent for everyone else, visible as invisible to itself, event says offline ──
    NOW = T0 + 15 * MIN;
    await heartbeat(3);
    r = await call('PUT', '/api/v1/me/presence', { body: { state: 'invisible', status_text: 'Hidden', emoji: '🫥' }, headers: await as(3) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.state, 'invisible', 'the owner still sees the chosen state');
    assert.strictEqual(r.body.status_text, 'Hidden');
    seen = bySubject((await get(1, [CAT])).body);
    assert.deepStrictEqual(seen, {}, 'invisible is not disclosed to a DM peer');
    seen = bySubject((await get(3, [CAT])).body);
    assert.strictEqual(seen[CAT].state, 'invisible');
    const catEvents = await events(CAT);
    const invisible = catEvents[catEvents.length - 1];
    assert.strictEqual(invisible.payload.state, 'offline');
    assert.strictEqual(invisible.payload.status_text, null);
    assert.strictEqual(invisible.payload.emoji, null);
    validEvent(invisible);

    // ── show_status off reads as offline too, but invisible already hides the row ──
    await call('PUT', '/api/v1/me/presence', { body: { state: 'auto', show_status: false, status_text: 'Off' }, headers: await as(2) });
    seen = bySubject((await get(1, [BOB])).body);
    assert.deepStrictEqual(seen, {}, 'show_status off is not disclosed');
    await call('PUT', '/api/v1/me/presence', { body: { show_status: true }, headers: await as(2) });

    // ── The event is debounced: a change inside 30 s waits, the flusher sends the standing view ──
    NOW = T0 + 15 * MIN;
    await heartbeat(1);
    const before = (await events(ANN)).length;
    r = await call('PUT', '/api/v1/me/presence', { body: { state: 'dnd', status_text: 'Heads down', emoji: '🔕' }, headers: await as(1) });
    assert.strictEqual(r.body.state, 'dnd');
    assert.strictEqual((await events(ANN)).length, before + 1, 'the first change outside the window is announced at once');
    const changedAt = NOW + 1000;
    NOW = changedAt;
    r = await call('PUT', '/api/v1/me/presence', { body: { status_text: 'Back to it' }, headers: await as(1) });
    assert.strictEqual(r.body.status_text, 'Back to it');
    assert.strictEqual((await events(ANN)).length, before + 1, 'inside the debounce window: no event yet');
    await presence.flushDue(changedAt + 29 * 1000);
    assert.strictEqual((await events(ANN)).length, before + 1, 'the window has not opened for this change yet');
    NOW = changedAt + 31 * 1000;
    await presence.flushDue(NOW);
    const annEvents = await events(ANN);
    assert.strictEqual(annEvents.length, before + 2, 'the flusher announces the change');
    assert.deepStrictEqual([annEvents.at(-1).payload.state, annEvents.at(-1).payload.status_text, annEvents.at(-1).payload.emoji], ['dnd', 'Back to it', '🔕']);
    validEvent(annEvents.at(-1));
    const afterFlush = (await events(ANN)).length;
    await presence.flushDue(NOW + 60 * 1000);
    assert.strictEqual((await events(ANN)).length, afterFlush, 'nothing pending is sent twice');

    // ── Validation: the chosen state, one emoji, 80 characters, known fields ──
    const bad = [
        [{}, 'presence.empty'], [{ state: 'online' }, 'presence.bad_state'], [{ status_text: 'x'.repeat(81) }, 'presence.status_too_long'],
        [{ emoji: '😀😀' }, 'presence.one_emoji'], [{ show_status: 'yes' }, 'presence.bad_show_status'], [{ last_seen: 'x' }, 'presence.unknown_field'],
    ];
    for (const [body, code] of bad) {
        r = await call('PUT', '/api/v1/me/presence', { body, headers: await as(1) });
        assert.strictEqual(r.status, 400, JSON.stringify(body));
        assert.strictEqual(r.body.error, code);
    }
    r = await call('PUT', '/api/v1/me/presence', { body: { state: 'auto' } });
    assert.strictEqual(r.status, 401, 'signed in only');

    // ── The internal read needs network.presence.read and answers for one person ──
    r = await call('GET', `/internal/presence?for=${ANN}&subjects=${BOB},${CAT},${DAN}`, { headers: { authorization: `Bearer ${serviceToken()}` } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(bySubject(r.body)).sort(), [BOB].sort(), 'Chat gets only what Ann may see (Cat is invisible)');
    r = await call('GET', `/internal/presence?for=${ANN}&subjects=${BOB}`, { headers: { authorization: `Bearer ${serviceToken('network.blocks.read')}` } });
    assert.strictEqual(r.status, 403, 'another capability is refused');
    r = await call('GET', `/internal/presence?for=ann&subjects=${BOB}`, { headers: { authorization: `Bearer ${serviceToken()}` } });
    assert.strictEqual(r.status, 400);

    // ── A malformed or oversized subject list is refused ──
    r = await get(1, ['ann']);
    assert.strictEqual(r.status, 400);
    r = await call('GET', `/api/v1/presence?subjects=${Array.from({ length: 101 }, (_, i) => BOB.replace(/.$/, String.fromCharCode(65 + (i % 26)))).join(',')}`, { headers: await as(1) });
    assert.strictEqual(r.status, 400);

    console.log('presence: all checks passed');
})().finally(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => edgeServer.close(r));
}).catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
