'use strict';
// Plan E5: Network's trust signals on the existing identity read (server/identity/trust.js,
// GET /internal/identity/resolve?trust=1). No new route; the default projection is unchanged.
//   node --import ./test/helpers/pg-preload.mjs test/identity-trust.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const { trustSignals } = require('../server/identity/trust');

const DAY = 86_400_000;
const USER_NEW = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';
const USER_OLD = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP2';
const USER_LINKED = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP3';
const LOCKER_MEMBER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP4';
const USER_STALE = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP5';

(async () => {
    const db = getDb();
    const quiet = console.log; console.log = () => {};
    // A moving clock: the HTTP read below uses the real time, so a fixed date made the 24-hour
    // assertion fail the day after the fixture was written.
    const now = Date.now();
    const at = (ms) => new Date(ms).toISOString();
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, created_at, last_seen, email_verified) VALUES (1, 'newbie', 'x', ?, ?, ?, 0)").run(USER_NEW, at(now), at(now));
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, created_at, last_seen, email_verified) VALUES (2, 'old', 'x', ?, ?, ?, 0)").run(USER_OLD, at(now - 40 * DAY), at(now));
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, created_at, last_seen) VALUES (3, 'linked', 'x', ?, ?, ?)").run(USER_LINKED, at(now), at(now));
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, created_at, last_seen) VALUES (4, 'passkey', 'x', ?, ?, ?)").run(LOCKER_MEMBER, at(now), at(now));
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, created_at, last_seen) VALUES (5, 'stale', 'x', ?, ?, ?)").run(USER_STALE, at(now - 40 * DAY), at(now - 40 * DAY));
    await db.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id) VALUES (3, 'live', '33'), (3, 'tools', '44')").run();
    await db.prepare("INSERT INTO locker_key_backups (subject, kind, blob) VALUES (?, 'passkey', '{}'::jsonb)").run(LOCKER_MEMBER);
    console.log = quiet;

    const newbie = await trustSignals(db, USER_NEW, { now });
    assert.deepStrictEqual(newbie, { account_age_hours: 0, account_age_days: 0, passkey: false, linked_accounts: 0, active_30d: false, email_verified: false, verified: false, verified_by: [] });

    const old = await trustSignals(db, USER_OLD, { now });
    assert.strictEqual(old.account_age_days, 40);
    assert.strictEqual(old.active_30d, true);
    assert.strictEqual(old.verified, true);
    assert.deepStrictEqual(old.verified_by, ['30_days_active']);

    const linked = await trustSignals(db, USER_LINKED, { now });
    assert.strictEqual(linked.linked_accounts, 2);
    assert.deepStrictEqual(linked.verified_by, ['linked_account'], 'only the count, never which sites');

    const passkey = await trustSignals(db, LOCKER_MEMBER, { now });
    assert.strictEqual(passkey.passkey, true);
    assert.deepStrictEqual(passkey.verified_by, ['passkey']);

    const stale = await trustSignals(db, USER_STALE, { now });
    assert.strictEqual(stale.active_30d, false);
    assert.strictEqual(stale.verified, false);

    assert.strictEqual(await trustSignals(db, 'usr_01JAB2C3D4E5F6G7H8J9K0ZZZZ', { now }), null);
    assert.strictEqual(await trustSignals(db, 'not-a-subject', { now }), null);

    // ── HTTP: the same read through the existing route, only when asked ──
    const app = express();
    const { privateKey, publicKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const ISSUER = 'https://openvibe.network';
    app.locals.db = db;
    app.locals.config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
    app.locals.publicKey = publicKey;
    app.use(express.json());
    app.use('/internal', require('../server/internal/routes'));
    const server = http.createServer(app);
    const t0 = Math.floor(Date.now() / 1000);
    const TOKEN = contracts.serviceAuth.signServiceToken({ iss: ISSUER, sub: 'svc:ai', actor_type: 'service', aud: ['openvibe.network'], cap: ['identity.subject.resolve'], iat: t0, exp: t0 + 300, jti: 'tok_identity_trust' }, privateKey);
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}/internal/identity`;
    const call = (p) => fetch(base + p, { headers: { authorization: `Bearer ${TOKEN}` } }).then(async (x) => ({ status: x.status, body: await x.json() }));

    let h = await call(`/resolve?subject_id=${LOCKER_MEMBER}&trust=1`);
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.trust.verified, true);
    assert.strictEqual(h.body.trust.passkey, true);
    h = await call(`/resolve?subject_id=${LOCKER_MEMBER}`);
    assert.strictEqual(h.body.trust, undefined, 'the default projection is unchanged');
    h = await call(`/resolve?subject_id=${USER_NEW}&trust=1`);
    assert.strictEqual(h.body.trust.verified, false);
    assert.ok(h.body.trust.account_age_hours < 24, `age ${h.body.trust.account_age_hours}`);

    await new Promise((res) => server.close(res));
    await db.close?.();
    console.log('identity-trust: all checks passed');
    process.exit(0);
})().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
