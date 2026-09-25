'use strict';
// Platform blocks (roadmap WS-E task 5; Contracts 0.49.0): a person blocks and unblocks through
// /api/v1/me/blocks (never themselves, never a guest), each change writes network.block.changed into the
// outbox with a growing per-pair revision, GET /internal/blocks answers services holding network.blocks.read
// (service token only), Network creates no notification from a person the recipient blocked (staff and
// system notices still arrive), and scripts/import-blocks.js imports Chat's exported dm_blocks once.
//   node test/blocks.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-blocks-'));
const dbFile = path.join(dir, 'network.db');
const log = console.log; console.log = () => {};
const db = initDb(dbFile);
console.log = log;
// chat and community are registered on the host, not seeded: copies of tools, then their grants seeded again.
for (const c of ['chat', 'community']) {
    const cols = db.prepare('PRAGMA table_info(oauth_clients)').all().map(x => x.name).filter(n => n !== 'client_id' && n !== 'id');
    db.prepare(`INSERT OR IGNORE INTO oauth_clients (client_id, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM oauth_clients WHERE client_id = 'tools'`).run(c);
}
require('../server/identity/principals').ensureSchema(db);
for (const c of ['chat', 'community', 'tools']) db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(`${c}-secret`, c);

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const CAT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC';
const MOD = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPD';
db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id, role) VALUES
    (1, 'ann', 'Ann', 'x', ?, 'user'), (2, 'bob', 'Bob <b>', 'x', ?, 'user'), (3, 'cat', NULL, 'x', ?, 'user'), (4, 'mod', 'Mod', 'x', ?, 'global_mod')`).run(ANN, BOB, CAT, MOD);
db.prepare("INSERT INTO users (id, username, password_hash, is_anon) VALUES (5, 'anon1234', 'x', 1)").run();
const GUEST_SUBJECT = db.prepare('SELECT subject_id FROM users WHERE id = 5').get().subject_id;

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const blocks = require('../server/identity/blocks');
const principals = require('../server/identity/principals');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/v1/me/blocks', blocks.userRouter(requireAuth));
app.get('/internal/blocks', principals.guard('network.blocks.read', { legacy: false }), blocks.internalHandler(db));
app.use('/internal', require('../server/internal/routes'));
const server = http.createServer(app);

const events = () => db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all().map(r => JSON.parse(r.envelope)).filter(e => e.event_type === 'network.block.changed');
const valid = (e) => {
    const v = validate('events.event-envelope@1', e);
    assert.ok(v.valid, JSON.stringify(v.errors));
    const pv = validate('network.block.changed@1', e.payload);
    assert.ok(pv.valid, JSON.stringify(pv.errors));
    assert.deepStrictEqual([e.source, e.visibility, e.subject, e.actor], ['network', 'internal', { type: 'user', id: e.payload.blocker }, { type: 'user', id: e.payload.blocker }]);
};

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tok = (id) => signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);
    const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async r => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) }));
    const as = (id) => ({ authorization: `Bearer ${tok(id)}` });
    const svc = async (client) => (await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: `${client}-secret`, audience: 'openvibe.network' }) }).then(r => r.json())).access_token;

    // ── A person blocks and unblocks ──
    let r = await call('GET', '/api/v1/me/blocks');
    assert.strictEqual(r.status, 401, 'signed in only');
    r = await call('GET', '/api/v1/me/blocks', { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.subject, r.body.blocks], [200, ANN, []]);
    assert.ok(r.cache.includes('no-store'));

    r = await call('PUT', '/api/v1/me/blocks/BOB', { headers: as(1) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.changed, r.body.block.subject, r.body.block.username, r.body.block.active, r.body.block.revision], [true, BOB, 'bob', true, 1]);
    r = await call('PUT', `/api/v1/me/blocks/${BOB}`, { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.changed, r.body.block.revision], [200, false, 1], 'blocking again changes nothing');
    assert.strictEqual(events().length, 1, 'and announces nothing');
    r = await call('PUT', '/api/v1/me/blocks/mod', { headers: as(1) });
    assert.strictEqual(r.status, 201, 'staff can be blocked');

    r = await call('GET', '/api/v1/me/blocks', { headers: as(1) });
    assert.deepStrictEqual(r.body.blocks.map(b => b.username).sort(), ['bob', 'mod']);
    const bob = r.body.blocks.find(b => b.username === 'bob');
    assert.deepStrictEqual([bob.subject, bob.display_name], [BOB, 'Bob <b>'], 'names are data; the page renders them as text');
    assert.ok(bob.blocked_at);

    // Refusals: yourself, a guest (by subject or name), nobody, not signed in as a person.
    r = await call('PUT', '/api/v1/me/blocks/ann', { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'blocks.self']);
    r = await call('PUT', `/api/v1/me/blocks/${ANN}`, { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'blocks.self']);
    r = await call('PUT', '/api/v1/me/blocks/anon1234', { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'blocks.guest']);
    r = await call('PUT', '/api/v1/me/blocks/gst_01JAB2C3D4E5F6G7H8J9K0MNPQ', { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'blocks.guest']);
    if (/^usr_/.test(GUEST_SUBJECT || '')) {
        r = await call('PUT', `/api/v1/me/blocks/${GUEST_SUBJECT}`, { headers: as(1) });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'blocks.guest'], 'a guest users row, by its subject');
    }
    r = await call('PUT', '/api/v1/me/blocks/nobody_here', { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.code], [404, 'blocks.unknown_person']);
    r = await call('PUT', '/api/v1/me/blocks/bob', { headers: as(5) });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'blocks.guest'], 'a guest cannot block');
    assert.throws(() => blocks.setBlock(db, ANN, ANN, true), /yourself/);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM user_blocks').get().n, 2, 'refusals wrote nothing');

    // Unblock, block again: the pair's revision grows every time.
    r = await call('DELETE', '/api/v1/me/blocks/bob', { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.changed, r.body.block.active, r.body.block.revision], [200, true, false, 2]);
    r = await call('DELETE', '/api/v1/me/blocks/bob', { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.code], [404, 'blocks.not_blocked']);
    r = await call('PUT', '/api/v1/me/blocks/bob', { headers: as(1) });
    assert.deepStrictEqual([r.status, r.body.block.revision], [201, 3]);
    r = await call('PUT', '/api/v1/me/blocks/ann', { headers: as(3) });
    assert.strictEqual(r.status, 201, 'cat blocks ann');

    // ── Events: one per change, valid, in order, revisions growing per pair ──
    const evs = events();
    evs.forEach(valid);
    const annBob = evs.filter(e => e.payload.blocker === ANN && e.payload.blocked === BOB).map(e => [e.payload.active, e.payload.revision]);
    assert.deepStrictEqual(annBob, [[true, 1], [false, 2], [true, 3]]);
    assert.deepStrictEqual(evs.map(e => e.payload.blocked), [BOB, MOD, BOB, BOB, ANN]);
    assert.strictEqual(new Set(evs.map(e => e.event_id)).size, evs.length);

    // In the same transaction: a change that fails after the row is written leaves neither row nor event.
    const before = events().length;
    const enqueue = require('../server/developer/event-relay').writerFor(db);
    const real = enqueue.enqueue;
    enqueue.enqueue = () => { throw new Error('outbox down'); };
    assert.throws(() => blocks.setBlock(db, CAT, BOB, true), /outbox down/);
    enqueue.enqueue = real;
    assert.strictEqual(blocks.isBlocked(db, CAT, BOB), false, 'rolled back with its event');
    assert.strictEqual(events().length, before);

    // ── /internal/blocks for services ──
    const chat = await svc('chat');
    const community = await svc('community');
    r = await call('GET', `/internal/blocks?subject=${ANN}`, { headers: { authorization: `Bearer ${chat}` } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body, { subject: ANN, blocks: [BOB, MOD].sort(), blocked_by: [CAT] });
    r = await call('GET', `/internal/blocks?subject=${BOB}`, { headers: { authorization: `Bearer ${community}` } });
    assert.deepStrictEqual(r.body, { subject: BOB, blocks: [], blocked_by: [ANN] });
    r = await call('GET', '/internal/blocks?subject=bob', { headers: { authorization: `Bearer ${chat}` } });
    assert.strictEqual(r.status, 400, 'subjects only');
    const tools = await svc('tools');
    r = await call('GET', `/internal/blocks?subject=${ANN}`, { headers: { authorization: `Bearer ${tools}` } });
    assert.strictEqual(r.status, 403, 'tools does not hold network.blocks.read');
    r = await call('GET', `/internal/blocks?subject=${ANN}`, { headers: { 'x-internal-key': 'legacy-key' } });
    assert.ok([401, 403].includes(r.status), 'never the shared key');
    r = await call('GET', `/internal/blocks?subject=${ANN}`);
    assert.ok([401, 403].includes(r.status), 'no credential');
    for (const c of ['chat', 'community']) assert.ok(principals.grantsFor(db, c, 'openvibe.network').some(g => g.capability === 'network.blocks.read'), `${c} holds network.blocks.read`);

    // ── Network's own notifications ──
    const { NotificationService } = require('../server/notifications/notification-service');
    const notes = new NotificationService(db);
    const count = (uid) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(uid).n;
    assert.strictEqual(notes.create({ user_id: 1, type: 'FOLLOW', sender_id: 2, sender_name: 'bob', message: 'bob followed you' }), null, 'ann blocked bob: nothing from him');
    assert.strictEqual(notes.create({ user_id: 1, type: 'MENTION', actor_subject: BOB, message: 'bob mentioned you' }), null, 'nor when the actor is named by subject');
    assert.strictEqual(count(1), 0);
    assert.ok(notes.create({ user_id: 1, type: 'FOLLOW', sender_id: 3, sender_name: 'cat' }), 'cat is not blocked by ann (only the other way round)');
    assert.ok(notes.create({ user_id: 3, type: 'FOLLOW', sender_id: 2, sender_name: 'bob' }), 'cat did not block bob');
    assert.ok(notes.create({ user_id: 1, type: 'WARNING', sender_id: 4, sender_name: 'mod', message: 'a warning' }), 'a staff action reaches ann although she blocked mod');
    assert.strictEqual(notes.create({ user_id: 1, type: 'FOLLOW', sender_id: 4 }), null, 'but mod following her does not');
    assert.ok(notes.create({ user_id: 1, type: 'FOLLOW', sender_id: 2, actor_subject: null }), 'actor_subject null: no known person (a Live id in sender_id)');
    assert.ok(notes.create({ user_id: 1, type: 'SERVICE_ANNOUNCEMENT', title: 'hello' }), 'no actor: unchanged');
    assert.strictEqual(notes.createBulk([1, 3], { type: 'STREAM_LIVE', sender_id: 2, title: 'bob is live' }).length, 1, 'bulk: only cat hears bob went live');
    await call('DELETE', '/api/v1/me/blocks/bob', { headers: as(1) });
    assert.ok(notes.create({ user_id: 1, type: 'FOLLOW', sender_id: 2 }), 'unblocked: notifications again');

    // ── Import of Chat's exported dm_blocks ──
    const importer = require('../scripts/import-blocks');
    const file = path.join(dir, 'pairs.json');
    fs.writeFileSync(file, JSON.stringify({ pairs: [
        { blocker_subject: BOB, blocked_subject: CAT },
        { blocker_subject: BOB, blocked_subject: CAT },          // duplicate
        { blocker_subject: ANN, blocked_subject: BOB },          // ann unblocked bob on Network since: left alone
        { blocker_subject: CAT, blocked_subject: CAT },          // self
        { blocker_subject: CAT, blocked_subject: 'usr_01JAB2C3D4E5F6G7H8J9K0ZZZZ' },   // unknown account
        { blocker_subject: '42', blocked_subject: BOB },         // not a subject
    ] }));
    const out = [];
    let code = await importer.main(['--db', dbFile, '--file', file], (l) => out.push(l));
    assert.strictEqual(code, 0);
    assert.match(out.join('\n'), /pairs {6}6; to import 1; skipped: duplicate-in-file 1, already-on-network 1, self 1, unknown-account 1, not-a-subject 1/);
    assert.ok(!blocks.isBlocked(db, BOB, CAT), 'dry run changed nothing');
    const n = events().length;
    code = await importer.main(['--db', dbFile, '--file', file, '--apply'], () => {});
    assert.strictEqual(code, 0);
    assert.ok(blocks.isBlocked(db, BOB, CAT), 'imported');
    assert.ok(!blocks.isBlocked(db, ANN, BOB), 'an unblock on Network wins over the old Chat block');
    assert.strictEqual(events().length, n + 1);
    const imported = events().at(-1); valid(imported);
    assert.deepStrictEqual([imported.payload.blocker, imported.payload.blocked, imported.payload.active, imported.payload.revision], [BOB, CAT, true, 1]);
    out.length = 0;
    await importer.main(['--db', dbFile, '--file', file], (l) => out.push(l));
    assert.match(out.join('\n'), /to import 0/, 'a second run imports nothing');

    // The account page lists blocks as text (DOM nodes), with unblock buttons.
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'my.html'), 'utf8');
    assert.ok(page.includes('id="blocks-list"') && page.includes('async function loadBlocks()') && page.includes("'/api/v1/me/blocks/' + encodeURIComponent(b.subject), { method: 'DELETE' }"));
    const fn = page.slice(page.indexOf('async function loadBlocks()'), page.indexOf('async function revokeSession('));
    assert.ok(!fn.includes('innerHTML'), 'no innerHTML in the blocks list');

    server.close(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('blocks: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
