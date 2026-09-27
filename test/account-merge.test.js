'use strict';
// Account merge (roadmap WS-B task 5, ADR-029; Contracts 0.69.0/0.70.0). The ADR's acceptance tests:
//   - a merge needs both sign-ins (an intent from the survivor, then a fresh sign-in to the other account: auth_time
//     within 10 minutes, never a renewal) and refuses otherwise;
//   - resolving either subject, or an old legacy id, answers the survivor (merged_from);
//   - balances sum with one ledger entry per side, and a retried merge applies once;
//   - module conflicts keep the survivor's fields (the other fills only what it lacks);
//   - follows, blocks, providers, sessions, OAuth tokens, projects, preferences move; a clash keeps the survivor's;
//   - network.subject.merged and network.user.token_valid_after (account_merged) are queued; the folded-in account's
//     old token is refused and signing in to it signs in to the survivor;
//   - a staff merge needs staff.identity.merge (the owner) and a written reason, and is audited;
//   - after 30 days the record keeps only the alias facts.
//   node test/account-merge.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { validate, ids } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const wallet = require('../server/coins/wallet');
const accountMerge = require('../server/identity/account-merge');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-merge-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
require('../server/identity/principals').ensureSchema(db);
require('../server/identity/follows').ensureSchema(db);
accountMerge.ensureSchema(db);
const ISSUER = 'https://openvibe.network';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
process.env.OWNER_USERNAME = 'boss';

const hash = bcrypt.hashSync('secret12', 4);
const mk = (name, role = 'user') => {
    const id = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(name, hash, role).lastInsertRowid;
    subjects.ensureUserSubject(db, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
// A session token from 10 s ago (the revocation cutoff has second precision); authAgo: its sign-in time, or null for none.
const tok = (u, { authAgo = 10 } = {}) => jwt.sign({ sub: u.id, id: u.id, subject_id: u.subject_id, username: u.username, role: u.role || 'user',
    ...(authAgo == null ? {} : { auth_time: Math.floor(Date.now() / 1000) - authAgo }), iat: Math.floor(Date.now() / 1000) - 10 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const events = (type) => db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope)).filter((e) => e.event_type === type);

const authRoutes = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use(express.json()); app.use(cookieParser());
app.use('/api/auth', authRoutes);
const mr = accountMerge.routers({ requireAuth, staffClaims: require('../server/auth/staff-claims').staffClaims });
app.use('/api/v1/account', mr.me);
app.use('/api/admin/account-merges', mr.admin);
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, token, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    try {
        const carol = mk('carol'); const carol2 = mk('carol_old');
        const x = mk('xavier'); const y = mk('yolanda'); const z = mk('zed');
        // What the folded-in account has.
        db.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id) VALUES (?, 'google', 'g-carol'), (?, 'google', 'g-carol-old'), (?, 'discord', 'd-carol-old')").run(carol.id, carol2.id, carol2.id);
        db.prepare("INSERT INTO user_sessions (user_id, session_token, is_active, expires_at) VALUES (?, 'sess-old', 1, datetime('now', '+1 day'))").run(carol2.id);
        db.prepare("INSERT INTO oauth_tokens (token, client_id, user_id, scope, expires_at) VALUES ('rt-old', 'tools', ?, 'openid', datetime('now', '+1 day'))").run(carol2.id);
        db.prepare("INSERT INTO dev_projects (id, owner_subject, name, created_at, created_by) VALUES ('prj_01JAB2C3D4E5F6G7H8J9K0MNPQ', ?, 'bot', datetime('now'), ?)").run(carol2.subject_id, carol2.subject_id);
        wallet.credit(db, { user_id: carol.id, app_id: 'live', amount: 50, reason: 'chat', idempotency_key: 'c-1' });
        wallet.credit(db, { user_id: carol2.id, app_id: 'live', amount: 150, reason: 'chat', idempotency_key: 'c-2' });
        const modules = require('../server/identity/modules');
        const live = { type: 'service', id: 'live' };
        const w = (s, n, d) => { const o = modules.write(db, s, n, d, { writer: live }); assert.ok(!o.status || o.status < 300, JSON.stringify(o)); };
        w(carol.subject_id, 'live.profile', { is_streamer: true, followers: 12 });
        w(carol2.subject_id, 'live.profile', { is_streamer: false, followers: 3, channel_url: 'https://openvibe.live/@carol_old' });
        w(carol2.subject_id, 'live.stats', { streams_30d: 4 });
        const follows = require('../server/identity/follows');
        follows.setFollow(db, carol.subject_id, 'channel', x.subject_id, true, { emit: false });
        follows.setFollow(db, carol2.subject_id, 'channel', x.subject_id, true, { emit: false });   // clash: carol follows x already
        follows.setFollow(db, carol2.subject_id, 'channel', y.subject_id, true, { emit: false });
        follows.setFollow(db, z.subject_id, 'channel', carol2.subject_id, true, { emit: false });    // z follows the folded-in channel
        follows.setFollow(db, carol2.subject_id, 'channel', carol.subject_id, true, { emit: false }); // would become following oneself
        db.prepare("INSERT INTO user_preferences (user_id, language) VALUES (?, 'en'), (?, 'pt')").run(carol.id, carol2.id);
        db.prepare("INSERT INTO identity_legacy_map (source_system, source_type, source_id, subject_id) VALUES ('live', 'user', '70', ?)").run(carol2.subject_id);
        const oldCarol2 = tok(carol2);
        const sameSecond = jwt.sign({ sub: carol2.id, id: carol2.id, subject_id: carol2.subject_id, username: carol2.username, role: 'user', auth_time: Math.floor(Date.now() / 1000) }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });

        // ── Refusals ──
        let r = await call('POST', '/api/v1/account/merge/intents', tok(carol));
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const intent = r.body.intent;
        assert.match(intent, /^mgi_/);
        r = await call('POST', '/api/v1/account/merge', tok(carol2, { authAgo: 11 * 60 }), { intent });
        assert.deepStrictEqual([r.status, r.body.error], [401, 'merge.sign_in_again'], 'a sign-in older than 10 minutes');
        r = await call('POST', '/api/v1/account/merge', tok(carol2, { authAgo: null }), { intent });
        assert.deepStrictEqual([r.status, r.body.error], [401, 'merge.sign_in_again'], 'a token with no sign-in time (older sessions, renewals of them)');
        r = await call('POST', '/api/v1/account/merge', tok(carol2), { intent: 'mgi_nope' });
        assert.deepStrictEqual([r.status, r.body.error], [410, 'merge.intent_expired']);
        r = await call('POST', '/api/v1/account/merge', tok(carol), { intent });
        assert.deepStrictEqual([r.status, r.body.error], [400, 'merge.same_account']);
        const expired = accountMerge.createIntent(db, carol, { now: Date.now() - 11 * 60 * 1000 });
        r = await call('POST', '/api/v1/account/merge', tok(carol2), { intent: expired.intent });
        assert.deepStrictEqual([r.status, r.body.error], [410, 'merge.intent_expired'], 'an intent lives 10 minutes');

        // ── The merge ──
        r = await call('POST', '/api/v1/account/merge', tok(carol2), { intent });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.ok(validate('network.account-merge-result@1', r.body).valid, JSON.stringify(validate('network.account-merge-result@1', r.body).errors));
        assert.deepStrictEqual([r.body.from, r.body.into, r.body.replayed], [carol2.subject_id, carol.subject_id, false]);
        assert.deepStrictEqual(r.body.moved, { providers: 1, sessions: 1, oauth_grants: 1, projects: 1, coins: 150, modules: 2 });
        assert.strictEqual(Date.parse(r.body.split_until) - Date.parse(r.body.merged_at), 30 * 86400000);

        // Resolution: either subject, and the old legacy id, answer the survivor.
        let res = subjects.resolve(db, { subject_id: carol2.subject_id });
        assert.deepStrictEqual([res.subject.id, res.merged_from, res.username], [carol.subject_id, carol2.subject_id, 'carol']);
        res = subjects.resolve(db, { source_system: 'live', source_type: 'user', source_id: '70' });
        assert.deepStrictEqual([res.subject.id, res.merged_from], [carol.subject_id, carol2.subject_id], 'the legacy map is not repointed, the alias answers');
        assert.strictEqual(db.prepare("SELECT subject_id FROM identity_legacy_map WHERE source_id = '70'").get().subject_id, carol2.subject_id);
        assert.strictEqual(subjects.resolve(db, { subject_id: carol.subject_id }).merged_from, undefined);

        // Coins: summed, one ledger entry per side.
        assert.deepStrictEqual([wallet.getBalance(db, carol.id), wallet.getBalance(db, carol2.id)], [200, 0]);
        const ledger = db.prepare("SELECT user_id, delta FROM coin_transactions WHERE reason = 'account_merge' ORDER BY id").all();
        assert.deepStrictEqual(ledger.map((l) => [l.user_id, l.delta]), [[carol2.id, -150], [carol.id, 150]]);
        // Modules: the survivor's fields win; the other fills only what it lacks; a record only it had moves.
        assert.deepStrictEqual(modules.read(db, carol.subject_id, 'live.profile').data, { is_streamer: true, followers: 12, channel_url: 'https://openvibe.live/@carol_old' });
        assert.deepStrictEqual(modules.read(db, carol.subject_id, 'live.stats').data, { streams_30d: 4 });
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM user_modules WHERE subject_id = ?').get(carol2.subject_id).n, 0);
        const modEv = events('network.module.updated').filter((e) => e.payload.reason === 'subject_merged');
        assert.ok(modEv.some((e) => e.payload.merged_from && e.payload.change === 'updated' && e.payload.keys.includes('channel_url')), 'the filled record is announced');
        // Follows: moved, the clash and the self-follow dropped, the folded channel's follower now follows the survivor.
        const f = db.prepare('SELECT follower_subject AS a, target_id AS b FROM user_follows ORDER BY a, b').all().map((x2) => `${x2.a === carol.subject_id ? 'carol' : x2.a === z.subject_id ? 'zed' : x2.a}>${x2.b === x.subject_id ? 'x' : x2.b === y.subject_id ? 'y' : x2.b === carol.subject_id ? 'carol' : x2.b}`).sort();
        assert.deepStrictEqual(f, ['carol>x', 'carol>y', 'zed>carol']);
        // Providers: google clashed and stays on the folded-in account (signing in with it lands on the survivor); discord moved.
        assert.deepStrictEqual(db.prepare('SELECT service FROM linked_accounts WHERE user_id = ? ORDER BY service').all(carol.id).map((l) => l.service), ['discord', 'google']);
        assert.strictEqual(db.prepare("SELECT user_id FROM linked_accounts WHERE service_user_id = 'g-carol-old'").get().user_id, carol2.id);
        assert.strictEqual(db.prepare("SELECT user_id FROM user_sessions WHERE session_token = 'sess-old'").get().user_id, carol.id);
        assert.strictEqual(db.prepare("SELECT owner_subject FROM dev_projects WHERE id = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ'").get().owner_subject, carol.subject_id);
        assert.deepStrictEqual(db.prepare('SELECT user_id, language FROM user_preferences ORDER BY user_id').all().map((p) => [p.user_id, p.language]), [[carol.id, 'en']], 'the survivor keeps its preferences');

        // Events: network.subject.merged, and the folded-in account's tokens end (account_merged).
        const merged = events('network.subject.merged');
        assert.strictEqual(merged.length, 1);
        assert.ok(validate('events.event-envelope@1', merged[0]).valid && validate('network.subject.merged@1', merged[0].payload).valid);
        assert.deepStrictEqual([merged[0].payload.from, merged[0].payload.into, merged[0].payload.initiated_by, merged[0].visibility], [carol2.subject_id, carol.subject_id, 'person', 'internal']);
        const revoked = events('network.user.token_valid_after').filter((e) => e.subject.id === carol2.subject_id);
        assert.deepStrictEqual(revoked.map((e) => e.payload.reason), ['account_merged']);
        assert.strictEqual((await call('GET', '/api/auth/me', oldCarol2)).status, 401, "the folded-in account's old token is refused");
        assert.strictEqual((await call('GET', '/api/auth/me', sameSecond)).status, 401, 'even one minted in the second of the merge (strict cutoff; merged accounts have no tokens)');
        assert.ok(Date.parse(revoked[0].payload.valid_after) > Date.parse(merged[0].payload.merged_at) - 1000, 'services get a cutoff past the merge second');
        // Signing in to the folded-in account signs in to the survivor.
        r = await call('POST', '/api/auth/login', null, { username: 'carol_old', password: 'secret12' });
        assert.deepStrictEqual([r.status, r.body.user && r.body.user.username, r.body.merged_into], [200, 'carol', 'carol']);
        assert.ok(Number.isFinite(jwt.decode(r.body.token).auth_time), 'a sign-in carries auth_time');

        // A retry answers the first merge and moves nothing again. Over HTTP the folded-in account's tokens are gone
        // (401); the survivor lists the merge instead.
        r = await call('POST', '/api/v1/account/merge', tok(carol2), { intent });
        assert.strictEqual(r.status, 401);
        const again = accountMerge.merge(db, db.prepare('SELECT * FROM users WHERE id = ?').get(carol2.id), carol);
        assert.deepStrictEqual([again.replayed, again.merge_id], [true, merged[0].payload.merge_id]);
        r = await call('GET', '/api/v1/account/merges', tok(carol));
        assert.deepStrictEqual(r.body.merges.map((m) => m.merge_id), [merged[0].payload.merge_id]);
        assert.strictEqual(wallet.getBalance(db, carol.id), 200);
        assert.strictEqual(events('network.subject.merged').length, 1);
        assert.throws(() => accountMerge.merge(db, db.prepare('SELECT * FROM users WHERE id = ?').get(carol2.id), x), (e) => e.code === 'merge.already_merged');

        // ── Staff (account recovery) ──
        const admin = mk('adminy', 'admin'); const boss = mk('boss', 'admin');
        const d1 = mk('dora'); const d2 = mk('dora_lost');
        r = await call('POST', '/api/admin/account-merges', tok(admin), { from: 'dora_lost', into: 'dora', reason: 'lost her password, verified by email' });
        assert.strictEqual(r.status, 403, 'an admin is not the owner');
        r = await call('POST', '/api/admin/account-merges', tok(boss), { from: 'dora_lost', into: 'dora', reason: 'short' });
        assert.deepStrictEqual([r.status, r.body.error], [400, 'merge.reason_required']);
        r = await call('POST', '/api/admin/account-merges', tok(boss), { from: d2.subject_id, into: 'dora', reason: 'lost her password, verified by email' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(events('network.subject.merged').pop().payload.initiated_by, 'staff');
        const audit = db.prepare("SELECT details FROM audit_log WHERE action = 'account_merge'").all().map((a) => JSON.parse(a.details));
        assert.deepStrictEqual([audit.length, audit[0].from, audit[0].reason], [1, d2.subject_id, 'lost her password, verified by email']);
        r = await call('GET', '/api/admin/account-merges', tok(boss));
        assert.strictEqual(r.body.merges.length, 2);
        assert.strictEqual((await call('POST', '/api/admin/account-merges', tok(boss), { from: 'boss', into: 'dora', reason: 'the owner folds away' })).body.error, 'merge.owner');
        assert.ok(d1);

        // ── 30 days later: only the alias facts remain ──
        assert.strictEqual(accountMerge.reduceExpired(db, { now: Date.now() + 31 * 86400000 }), 2);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM account_merges WHERE pre_state IS NOT NULL').get().n, 0);
        assert.strictEqual(subjects.resolve(db, { subject_id: carol2.subject_id }).subject.id, carol.subject_id, 'the alias still answers');

        // auth_time: a renewal keeps the original sign-in time, a sign-in sets it.
        const renewed = jwt.decode(authRoutes.signToken(carol, keys.privateKey, config, { renew: { auth_time: 1234 } }));
        assert.strictEqual(renewed.auth_time, 1234);
        assert.strictEqual(jwt.decode(authRoutes.signToken(carol, keys.privateKey, config, { renew: {} })).auth_time, undefined, 'no sign-in time is never invented');
        assert.ok(Math.abs(jwt.decode(authRoutes.signToken(carol, keys.privateKey, config)).auth_time - Date.now() / 1000) < 5);
        assert.ok(ids);
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('account merge: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
