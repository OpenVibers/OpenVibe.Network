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
const { serviceRouter, meRouter } = require('../server/identity/trust-routes');

const DAY = 86_400_000;
const USER_NEW = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';
const USER_OLD = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP2';
const USER_LINKED = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP3';
const LOCKER_MEMBER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP4';
const USER_STALE = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP5';
const GUEST_NEW = 'gst_01JAB2C3D4E5F6G7H8J9K0MNP1';
const GUEST_OTHER = 'gst_01JAB2C3D4E5F6G7H8J9K0MNP2';
const GUEST_OLD = 'gst_01JAB2C3D4E5F6G7H8J9K0MNP3';

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
    await db.prepare("INSERT INTO anon_users (id, anon_number, session_token, subject_id, first_seen) VALUES (101, 901, 'guest-session-token', ?, ?)").run(GUEST_NEW, at(now - 3 * 3_600_000));
    await db.prepare("INSERT INTO anon_users (id, anon_number, session_token, subject_id, first_seen) VALUES (102, 902, 'guest-session-other', ?, ?)").run(GUEST_OTHER, at(now - 2 * 3_600_000));
    await db.prepare("INSERT INTO anon_users (id, anon_number, session_token, subject_id, first_seen) VALUES (103, 903, 'guest-session-old', ?, ?)").run(GUEST_OLD, at(now - 2 * DAY));
    await db.prepare("INSERT INTO anon_ip_log (anon_id, ip) VALUES (101, '192.0.2.44'), (101, '192.0.2.45'), (102, '192.0.2.44'), (103, '192.0.2.45')").run();
    await db.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id) VALUES (3, 'live', '33'), (3, 'tools', '44')").run();
    await db.prepare("INSERT INTO locker_key_backups (subject, kind, blob) VALUES (?, 'passkey', '{}'::jsonb)").run(LOCKER_MEMBER);
    console.log = quiet;

    const newbie = await trustSignals(db, USER_NEW, { now });
    assert.deepStrictEqual(newbie, { kind: 'account', age_band: 'under_1h', account_age_hours: 0, account_age_days: 0, passkey: false, linked_accounts: 0, active_30d: false, email_verified: false, verified: false, verified_by: [] });

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

    const guest = await trustSignals(db, GUEST_NEW, { now });
    assert.deepStrictEqual(guest, { kind: 'guest', age_band: 'under_1d', age_hours: 3, age_days: 0, networks_seen: 2, guests_from_same_networks_24h: 1, converted: false });
    assert.strictEqual(JSON.stringify(guest).includes('192.0.2.'), false, 'no network address leaves the trust function');
    assert.strictEqual((await trustSignals(db, GUEST_OLD, { now })).guests_from_same_networks_24h, 1);

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
    app.use('/api/v1/trust', serviceRouter(require('../server/identity/principals')));
    app.use('/api/v1/me/trust', meRouter());
    app.use('/internal', require('../server/internal/routes'));
    const server = http.createServer(app);
    const t0 = Math.floor(Date.now() / 1000);
    const TOKEN = contracts.serviceAuth.signServiceToken({ iss: ISSUER, sub: 'svc:ai', actor_type: 'service', aud: ['openvibe.network'], cap: ['identity.subject.resolve'], iat: t0, exp: t0 + 300, jti: 'tok_identity_trust' }, privateKey);
    const TRUST_TOKEN = contracts.serviceAuth.signServiceToken({ iss: ISSUER, sub: 'svc:ai', actor_type: 'service', aud: ['openvibe.network'], cap: ['identity.subject.resolve', 'identity.trust.read'], iat: t0, exp: t0 + 300, jti: 'tok_identity_trust_read' }, privateKey);
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
    h = await call(`/resolve?subject_id=${GUEST_NEW}&trust=1`);
    assert.strictEqual(h.status, 200);
    assert.deepStrictEqual(h.body.trust, guest, 'the existing internal route now includes guest signals');

    const api = (path, token) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { authorization: `Bearer ${token}` } }).then(async (x) => ({ status: x.status, cache: x.headers.get('cache-control'), body: await x.json() }));
    h = await api(`/api/v1/trust/${GUEST_NEW}`, TOKEN);
    assert.strictEqual(h.status, 403, 'identity.subject.resolve alone cannot read trust signals');
    assert.strictEqual(h.cache, 'private, no-store', 'denied service reads are no-store too');
    h = await api(`/api/v1/trust/${GUEST_NEW}`, TRUST_TOKEN);
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.cache, 'private, no-store');
    assert.strictEqual(h.body.kind, 'guest');
    assert.strictEqual(JSON.stringify(h.body).includes('192.0.2.'), false, 'API never returns IPs');

    h = await api('/api/v1/me/trust', 'guest-session-token');
    assert.strictEqual(h.status, 200, 'a guest session token reads its own trust');
    assert.strictEqual(h.body.kind, 'guest');
    const ownToken = require('jsonwebtoken').sign({ sub: '1', id: 1 }, privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
    h = await api('/api/v1/me/trust', ownToken);
    assert.strictEqual(h.status, 200, 'an account session token reads its own trust');
    assert.strictEqual(h.body.kind, 'account');

    await new Promise((res) => server.close(res));
    await db.close?.();
    console.log('identity-trust: all checks passed');
    process.exit(0);
})().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
