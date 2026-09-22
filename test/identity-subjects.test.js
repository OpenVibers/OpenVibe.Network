'use strict';
// Canonical subject ids + identity_legacy_map (server/identity/*), roadmap Wave 1.
//   node test/identity-subjects.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const contracts = require('openvibe-contracts');
const { initDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-subjects-'));
const dbPath = path.join(dir, 'network.db');
let db = initDb(dbPath);
const quiet = console.log; console.log = () => {};

// ── An existing database: rows without subject ids, a Live-migrated account ──
db.prepare("INSERT INTO users (id, username, password_hash, created_at, legacy_source, legacy_id) VALUES (1, 'alex', 'x', '2026-01-02 03:04:05', 'live', 77)").run();
db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (2, 'beth', 'x', '2026-05-01 00:00:00')").run();
db.prepare("INSERT INTO anon_users (id, anon_number, session_token) VALUES (5, 9, 'tok')").run();
db.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id) VALUES (2, 'live', '321'), (1, 'tools', 'network:1')").run();
db.exec("UPDATE users SET subject_id = NULL; UPDATE anon_users SET subject_id = NULL; DROP TABLE identity_legacy_map;");
db.close();
db = initDb(dbPath);                               // boot again: backfill + seed
console.log = quiet;

const alex = db.prepare('SELECT * FROM users WHERE id = 1').get();
const beth = db.prepare('SELECT * FROM users WHERE id = 2').get();
const guest = db.prepare('SELECT * FROM anon_users WHERE id = 5').get();
assert.ok(contracts.validate('identity.subject-ref', { type: 'user', id: alex.subject_id }).valid, 'backfilled user subject is a valid SubjectRef');
assert.ok(contracts.validate('identity.subject-ref', { type: 'guest', id: guest.subject_id }).valid, 'backfilled guest subject is gst_');
assert.ok(alex.subject_id < beth.subject_id, 'backfilled ids sort by account age');
assert.strictEqual(alex.subject_id.slice(4, 14), contracts.ids.ulid(Date.parse('2026-01-02T03:04:05Z')).slice(0, 10), 'ULID time part comes from created_at');

// Rebooting changes nothing.
const before = alex.subject_id;
console.log = () => {}; db.close(); db = initDb(dbPath); console.log = quiet;
assert.strictEqual(db.prepare('SELECT subject_id FROM users WHERE id = 1').get().subject_id, before, 'subject ids are stable across boots');

// Seeded map: network self ids and the Live legacy id.
assert.strictEqual(subjects.resolve(db, { source_system: 'network', source_type: 'user', source_id: 1 }).subject.id, before);
const viaLive = subjects.resolve(db, { source_system: 'live', source_type: 'user', source_id: '77' });
assert.strictEqual(viaLive.subject.id, before, 'Live-migrated account resolves by its Live id');
assert.strictEqual(viaLive.username, 'alex');
assert.ok(!('email' in viaLive) && !('password_hash' in viaLive), 'projection carries no private fields');
assert.strictEqual(subjects.resolve(db, { subject_id: guest.subject_id }).subject.type, 'guest');
assert.strictEqual(subjects.resolve(db, { source_system: 'live', source_id: '321' }).subject.id, beth.subject_id, 'seeded from a reported Live link');
assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM identity_legacy_map WHERE source_system = 'tools'").get().n, 0, "OAuth 'network:<id>' links say nothing about site ids");
assert.strictEqual(subjects.resolve(db, { source_system: 'live', source_id: '999' }), null);

// A row inserted by a path that forgot subject_id is fixed lazily.
db.prepare("INSERT INTO users (id, username, password_hash) VALUES (3, 'cat', 'x')").run();
db.prepare('UPDATE users SET subject_id = NULL WHERE id = 3').run();
const cat = db.prepare('SELECT * FROM users WHERE id = 3').get();
const catSid = subjects.ensureUserSubject(db, cat);
assert.ok(/^usr_/.test(catSid) && cat.subject_id === catSid);
assert.strictEqual(subjects.ensureUserSubject(db, cat), catSid, 'idempotent');

// ── Legacy map writes ──
let r = subjects.upsertLegacy(db, [
    { network_user_id: 2, source_system: 'live', source_type: 'user', source_id: 88, verified: true },
    { network_user_id: 2, source_system: 'live', source_type: 'user', source_id: 88 },                 // repeat
    { network_user_id: 1, source_system: 'live', source_type: 'user', source_id: 88 },                 // someone else's id
    { network_user_id: 1, source_system: 'network', source_type: 'user', source_id: 2 },              // not writable
    { network_user_id: 404, source_system: 'live', source_type: 'user', source_id: 1 },               // unknown account
    { subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', source_system: 'live', source_type: 'user', source_id: 2 }, // unknown subject
    { network_user_id: 1, source_system: 'Live!', source_type: 'user', source_id: 3 },                // fails the contract
]);
assert.strictEqual(r.inserted, 1);
assert.strictEqual(r.unchanged, 1);
assert.deepStrictEqual(r.conflicts.map(c => c.index), [2], 'a mapped id is never repointed');
assert.deepStrictEqual(r.rejected.map(c => c.index), [3, 4, 5, 6]);
assert.strictEqual(subjects.resolve(db, { source_system: 'live', source_id: '88' }).subject.id, beth.subject_id);

// ── HTTP: /internal/identity behind the internal key ──
const app = express();
app.locals.db = db;
app.locals.config = { internalKey: 'k-test' };
app.use(express.json());
app.use('/internal', require('../server/internal/routes'));
const server = http.createServer(app);

// Tokens carry subject_id next to the integer sub.
const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const { signToken } = require('../server/auth/routes');

(async () => {
    await new Promise(res => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}/internal/identity`;
    const call = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'x-internal-key': 'k-test', 'content-type': 'application/json', ...(opts.headers || {}) } })
        .then(async x => ({ status: x.status, type: x.headers.get('content-type'), body: await x.json() }));

    let h = await call('/resolve?system=live&id=77');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.subject.id, before);
    assert.ok(h.body.legacy_ids.some(l => l.source_system === 'live' && l.source_id === '77'));
    h = await call('/resolve?system=live&id=12345');
    assert.strictEqual(h.status, 404);
    assert.ok(h.type.startsWith('application/problem+json') && contracts.validate('errors.problem', h.body).valid, '404 is a problem+json');
    assert.strictEqual(h.body.code, 'identity.subject_not_found');
    h = await call('/resolve');
    assert.strictEqual(h.status, 400);
    h = await call('/resolve-batch', { method: 'POST', body: JSON.stringify({ system: 'live', type: 'user', ids: ['77', '321', '404404'] }) });
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.results['77'].subject.id, before);
    assert.strictEqual(h.body.results['321'].subject.id, beth.subject_id);
    assert.strictEqual(h.body.results['404404'], null, 'unknown ids resolve to null, not an error');
    h = await call('/resolve-batch', { method: 'POST', body: JSON.stringify({ subject_ids: [before, 'usr_01JAB2C3D4E5F6G7H8J9K0ZZZZ'] }) });
    assert.strictEqual(h.body.results[before].username, 'alex');
    assert.strictEqual(h.body.results['usr_01JAB2C3D4E5F6G7H8J9K0ZZZZ'], null);
    h = await call('/resolve-batch', { method: 'POST', body: JSON.stringify({ ids: ['1'] }) });
    assert.strictEqual(h.status, 400, 'ids need a system');
    h = await call('/resolve-batch', { method: 'POST', body: JSON.stringify({ subject_ids: Array.from({ length: 501 }, (_, i) => String(i)) }) });
    assert.strictEqual(h.status, 413);
    h = await call('/legacy-map', { method: 'POST', body: JSON.stringify({ entries: [{ network_user_id: 3, source_system: 'live', source_id: 99 }] }) });
    assert.strictEqual(h.status, 200); assert.strictEqual(h.body.inserted, 1);
    h = await fetch(base.replace('/identity', '/link-account'), { method: 'POST', headers: { 'x-internal-key': 'k-test', 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 3, service: 'live', service_user_id: '555' }) });
    assert.strictEqual(h.status, 200);
    assert.strictEqual(subjects.resolve(db, { source_system: 'live', source_id: '555' }).network_user_id, 3, '/internal/link-account also writes the legacy map');
    h = await call('/legacy-map', { method: 'POST', body: JSON.stringify({ entries: [] }) });
    assert.strictEqual(h.status, 400);
    h = await fetch(base + '/resolve?system=live&id=77').then(x => ({ status: x.status }));
    assert.strictEqual(h.status, 403, 'no internal key, no identity data');

    if (signToken) {
        const token = signToken(db.prepare('SELECT * FROM users WHERE id = 1').get(), privateKey, { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } });
        const claims = jwt.decode(token);
        assert.strictEqual(claims.sub, 1, 'sub stays the integer id');
        assert.strictEqual(claims.subject_id, before, 'token carries the subject id');
    }

    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('identity subjects: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
