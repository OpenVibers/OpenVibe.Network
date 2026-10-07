'use strict';
// Account export and deletion (roadmap WS-B task 7, ADR-033; Contracts 0.71.0). The ADR's acceptance tests:
//   - export: a job gathers every expected service's part (the holders of network.account.export.contribute), the zip
//     holds only the person's data and no secrets, a missing service makes it partial and says which, another person
//     cannot download it, one a day, and it expires after 7 days;
//   - deletion: refused without a fresh sign-in or the typed username, cancellable, nothing before the date;
//   - at the date Network's rows are erased, the username is released, the subject resolves as deleted, old tokens
//     are refused, and network.account.deleted (with the merged-in aliases) is queued once;
//   - services confirm with counts; staff (staff.users.manage) see what is outstanding and cancel with a reason.
//   node test/account-data.test.js
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
const { ids, validate, serviceAuth } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const wallet = require('../server/coins/wallet');
const accountMerge = require('../server/identity/account-merge');
const accountData = require('../server/identity/account-data');
const zip = require('../server/utils/zip');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-account-data-'));
const exportDir = path.join(dir, 'account-exports');
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
// The services that keep data about people are registered clients (production has them all).
for (const c of ['live', 'chat', 'community', 'space', 'media', 'games', 'tools']) await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, 'x', ?, '[]', 1) ON CONFLICT DO NOTHING").run(c, c);
const principals = require('../server/identity/principals');
await principals.ensureSchema(db);
require('../server/identity/follows').ensureSchema(db);
await accountMerge.ensureSchema(db);
await accountData.ensureSchema(db);
const ISSUER = 'https://openvibe.network';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
process.env.OWNER_USERNAME = 'boss';

const hash = bcrypt.hashSync('secret12', 4);
const mk = async (name, role = 'user') => {
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id').run(name, `${name}@example.com`, hash, role)).lastInsertRowid;
    await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const tok = (u, { authAgo = 10 } = {}) => jwt.sign({ sub: u.id, id: u.id, subject_id: u.subject_id, username: u.username, role: u.role || 'user',
    ...(authAgo == null ? {} : { auth_time: Math.floor(Date.now() / 1000) - authAgo }), iat: Math.floor(Date.now() / 1000) - 10 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
// A service token as Network issues it: `cap` holds only what principal_grants gives that service.
const svc = (name, cap = ['network.account.export.contribute', 'network.account.deletion.confirm']) => serviceAuth.signServiceToken({ iss: ISSUER, sub: `svc:${name}`, actor_type: 'service', aud: ['openvibe.network'],
    cap, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey);
const events = async (type) => (await db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all()).map((r) => r.envelope).filter((e) => e.event_type === type);

const authRoutes = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const notified = [];
const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use(cookieParser());
const routers = accountData.routers({
    requireAuth, staffClaims: require('../server/auth/staff-claims').staffClaims, dir: exportDir, notify: (u, n) => notified.push([u, n.title]),
    contributeGuard: principals.guard('network.account.export.contribute', { legacy: false }), confirmGuard: principals.guard('network.account.deletion.confirm', { legacy: false }),
});
app.use('/api/v1/account', routers.me);
app.use('/internal', routers.internal);
app.use('/api/admin/account-deletions', routers.admin);
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, token, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) }))
        .then((r) => { try { r.body = JSON.parse(r.buf.toString('utf8')); } catch { r.body = {}; } return r; });
    const settle = () => new Promise((r) => setImmediate(r));
    try {
        const dana = await mk('dana'); const eve = await mk('eve'); const x = await mk('xavier'); const boss = await mk('boss', 'admin');
        await db.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id) VALUES (?, 'google', 'g-dana')").run(dana.id);
        await db.prepare("INSERT INTO user_sessions (user_id, session_token, device_name, is_active, expires_at) VALUES (?, 'sess-secret-dana', 'phone', 1, datetime('now', '+1 day'))").run(dana.id);
        await db.prepare("INSERT INTO oauth_tokens (token, client_id, user_id, scope, expires_at) VALUES ('rt-secret-dana', 'tools', ?, 'openid', datetime('now', '+1 day'))").run(dana.id);
        await wallet.credit(db, { user_id: dana.id, app_id: 'live', amount: 40, reason: 'chat', idempotency_key: 'd-1' });
        await require('../server/identity/modules').write(db, dana.subject_id, 'live.profile', { is_streamer: true, followers: 2 }, { writer: { type: 'service', id: 'live' } });
        const follows = require('../server/identity/follows');
        await follows.setFollow(db, dana.subject_id, 'channel', x.subject_id, true, { emit: false });
        await follows.setFollow(db, x.subject_id, 'channel', dana.subject_id, true, { emit: false });
        await db.prepare("INSERT INTO user_preferences (user_id, language) VALUES (?, 'en')").run(dana.id);

        // ── Export ──
        const expected = await accountData.expectedServices(db, 'network.account.export.contribute');
        assert.deepStrictEqual(expected, ['chat', 'community', 'games', 'live', 'media', 'space'], 'the holders of the contribute grant');
        let r = await call('POST', '/api/v1/account/export', tok(dana));
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        assert.ok(validate('network.account-export@1', r.body).valid, JSON.stringify(validate('network.account-export@1', r.body).errors));
        const exp = r.body.export_id;
        assert.deepStrictEqual(r.body.services.map((s) => `${s.service}:${s.status}`), expected.map((s) => `${s}:waiting`));
        const req = await events('network.account.export_requested');
        assert.strictEqual(req.length, 1);
        assert.deepStrictEqual([req[0].payload.export_id, req[0].payload.subject, req[0].visibility], [exp, dana.subject_id, 'internal']);
        r = await call('POST', '/api/v1/account/export', tok(dana));
        assert.deepStrictEqual([r.status, r.body.export_id], [200, exp], 'one open export at a time');

        const part = (files, subject = dana.subject_id) => ({ subject, files });
        r = await call('POST', `/internal/account-exports/${exp}/parts`, svc('live'), part([{ name: 'follows.json', content: [{ channel: 'xavier' }] }, { name: 'profile.json', content: { bio: 'hi' } }]));
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.ok(validate('network.account-data-receipt@1', r.body).valid);
        assert.deepStrictEqual([r.body.service, r.body.replaced], ['live', false]);
        r = await call('POST', `/internal/account-exports/${exp}/parts`, svc('live'), part([{ name: 'follows.json', content: [{ channel: 'xavier' }, { channel: 'yolanda' }] }]));
        assert.strictEqual(r.body.replaced, true, 'a second part replaces the first');
        r = await call('POST', `/internal/account-exports/${exp}/parts`, svc('chat'), part([{ name: 'messages.json', content: [] }], eve.subject_id));
        assert.deepStrictEqual([r.status, r.body.error], [400, 'export.wrong_subject']);
        r = await call('POST', `/internal/account-exports/${exp}/parts`, svc('chat'), part([{ name: '../network/account.json', content: {} }]));
        assert.deepStrictEqual([r.status, r.body.error], [400, 'export.invalid_part']);
        r = await call('POST', `/internal/account-exports/${exp}/parts`, svc('tools', ['network.modules.read']), part([{ name: 'usage.json', content: [] }]));
        assert.strictEqual(r.status, 403, 'a service without the grant is refused');
        r = await call('POST', `/internal/account-exports/${exp}/parts`, tok(dana), part([{ name: 'x.json', content: [] }]));
        assert.strictEqual(r.status, 401, 'a person token is not a service token');
        r = await call('POST', `/internal/account-exports/${exp}/parts`, svc('chat'), part([{ name: 'messages.json', content: [{ message: 'hello' }] }]));
        assert.strictEqual(r.status, 200);
        await settle();
        assert.strictEqual((await db.prepare('SELECT status FROM account_exports WHERE id = ?').get(exp)).status, 'pending', 'still waiting for three services');
        r = await call('GET', `/api/v1/account/export/${exp}/download`, tok(dana));
        assert.deepStrictEqual([r.status, r.body.error], [409, 'export.pending']);

        // The deadline passes: the archive is built without the silent services, and says so.
        const deadline = Date.parse((await db.prepare('SELECT deadline FROM account_exports WHERE id = ?').get(exp)).deadline);
        assert.deepStrictEqual(await accountData.sweep(db, { dir: exportDir, now: deadline + 1000, notify: (u, n) => notified.push([u, n.title]) }), { built: 1, expired: 0, deleted: 0 });
        r = await call('GET', `/api/v1/account/export/${exp}`, tok(dana));
        assert.strictEqual(r.body.status, 'partial');
        assert.ok(validate('network.account-export@1', r.body).valid);
        assert.deepStrictEqual(r.body.services.map((s) => `${s.service}:${s.status}`), ['network:received', 'chat:received', 'live:received', 'community:missing', 'games:missing', 'media:missing', 'space:missing']);
        assert.deepStrictEqual(notified.map((n) => n[0]), [dana.id], 'the person is told');
        r = await call('GET', `/api/v1/account/export/${exp}/download`, tok(dana));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('content-type'), 'application/zip');
        assert.match(r.headers.get('content-disposition'), /attachment; filename="openvibe-dana-\d{4}-\d\d-\d\d\.zip"/);
        const files = zip.read(r.buf);
        assert.ok(files['README.txt'].toString().includes('community: MISSING'));
        assert.ok(files['README.txt'].toString().includes('space: MISSING'));
        assert.deepStrictEqual(JSON.parse(files['live/follows.json']).map((f) => f.channel), ['xavier', 'yolanda'], 'the replacing part');
        const account = JSON.parse(files['network/account.json']);
        assert.deepStrictEqual([account.username, account.email, account.subject_id], ['dana', 'dana@example.com', dana.subject_id]);
        const all = Object.values(files).map((b) => b.toString()).join('\n');
        for (const secret of ['password_hash', 'sess-secret-dana', 'rt-secret-dana', hash]) assert.ok(!all.includes(secret), `no ${secret} in the archive`);
        assert.strictEqual(JSON.parse(files['network/opencoins.json']).balance, 40);
        assert.deepStrictEqual(JSON.parse(files['network/follows.json']).followers_count, 1, 'followers as a count, never their names');
        assert.ok(!all.includes('eve@example.com'), "nobody else's data");
        r = await call('GET', `/api/v1/account/export/${exp}/download`, tok(eve));
        assert.strictEqual(r.status, 404, 'another person cannot download it');
        r = await call('POST', `/internal/account-exports/${exp}/parts`, svc('media'), part([{ name: 'objects.json', content: [] }]));
        assert.deepStrictEqual([r.status, r.body.error], [409, 'export.closed'], 'too late');
        r = await call('POST', '/api/v1/account/export', tok(dana));
        assert.deepStrictEqual([r.status, r.body.error], [429, 'export.too_soon'], 'one a day');
        assert.ok(Number(r.headers.get('retry-after')) > 0);

        // Every expected service answers: ready at once.
        for (const s of ['community', 'games', 'media', 'space']) await db.prepare("UPDATE principal_grants SET revoked_at = ov_now() WHERE client_id = ? AND capability = 'network.account.export.contribute'").run(s);
        r = await call('POST', '/api/v1/account/export', tok(eve));
        const exp2 = r.body.export_id;
        await call('POST', `/internal/account-exports/${exp2}/parts`, svc('live'), part([{ name: 'profile.json', content: {} }], eve.subject_id));
        await call('POST', `/internal/account-exports/${exp2}/parts`, svc('chat'), part([{ name: 'messages.json', content: [] }], eve.subject_id));
        await settle(); await settle();
        assert.strictEqual((await db.prepare('SELECT status FROM account_exports WHERE id = ?').get(exp2)).status, 'ready');

        // After 7 days the archive is gone.
        const expires = Date.parse((await db.prepare('SELECT expires_at FROM account_exports WHERE id = ?').get(exp)).expires_at);
        assert.strictEqual((await accountData.sweep(db, { dir: exportDir, now: expires + 1000 })).expired, 2);
        assert.ok(!fs.existsSync(path.join(exportDir, `${exp}.zip`)));
        r = await call('GET', `/api/v1/account/export/${exp}/download`, tok(dana));
        assert.deepStrictEqual([r.status, r.body.error], [410, 'export.expired']);

        // ── Deletion ──
        r = await call('POST', '/api/v1/account/deletion', tok(dana, { authAgo: 11 * 60 }), { confirm_username: 'dana' });
        assert.deepStrictEqual([r.status, r.body.error], [401, 'deletion.sign_in_again']);
        r = await call('POST', '/api/v1/account/deletion', tok(dana, { authAgo: null }), { confirm_username: 'dana' });
        assert.deepStrictEqual([r.status, r.body.error], [401, 'deletion.sign_in_again'], 'a renewal is not a sign-in');
        r = await call('POST', '/api/v1/account/deletion', tok(dana), { confirm_username: 'dan' });
        assert.deepStrictEqual([r.status, r.body.error], [400, 'deletion.confirm_username']);
        r = await call('POST', '/api/v1/account/deletion', tok(boss), { confirm_username: 'boss' });
        assert.deepStrictEqual([r.status, r.body.error], [403, 'deletion.owner']);
        r = await call('POST', '/api/v1/account/deletion', tok(dana), { confirm_username: 'DANA' });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        assert.ok(validate('network.account-deletion@1', r.body).valid);
        assert.strictEqual(Date.parse(r.body.delete_after) - Date.parse(r.body.requested_at), 30 * 86400000);
        r = await call('DELETE', '/api/v1/account/deletion', tok(dana));
        assert.strictEqual(r.body.status, 'cancelled', 'cancelled');
        r = await call('GET', '/api/v1/account/deletion', tok(dana));
        assert.strictEqual(r.body.deletion, null);
        r = await call('POST', '/api/v1/account/deletion', tok(dana), { confirm_username: 'dana' });
        const del = r.body.deletion_id;
        const due = Date.parse(r.body.delete_after);
        assert.strictEqual((await accountData.sweep(db, { dir: exportDir, now: due - 60000 })).deleted, 0, 'nothing before the date');
        assert.strictEqual((await db.prepare('SELECT username FROM users WHERE id = ?').get(dana.id)).username, 'dana');

        // dana had folded an older account in (ADR-029): its subject goes with her.
        const old = await mk('dana_old');
        await accountMerge.merge(db, old, await db.prepare('SELECT * FROM users WHERE id = ?').get(dana.id), { initiatedBy: 'person' });
        // Two paired machines, one per subject: an account deletion revokes both and announces each (network.node.revoked@1).
        const pairedNodes = [];
        for (const subjectId of [dana.subject_id, old.subject_id]) {
            const ulid = ids.ulid();
            const principal = `nod_${ulid}`; const nodeId = `n-${ulid.toLowerCase()}`;
            await db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, owner_subject, trust, status,
                credential_hash, created_at, created_by, updated_at)
                VALUES (?, ?, 'wnam-1', 'user', ?, 'community', 'active', ?, ov_now_iso(), 'test', ov_now_iso())`)
                .run(principal, nodeId, subjectId, crypto.randomBytes(32).toString('hex'));
            pairedNodes.push([principal, nodeId, subjectId]);
        }
        const oldToken = tok(dana);
        assert.strictEqual((await accountData.sweep(db, { dir: exportDir, now: due + 1000 })).deleted, 1);
        const nodeEvents = await events('network.node.revoked');
        assert.strictEqual(nodeEvents.length, 2, 'each paired machine revoked exactly once');
        for (const [principal, nodeId, subjectId] of pairedNodes) {
            const p = await db.prepare('SELECT status, revoked_by FROM platform_node_principals WHERE id = ?').get(principal);
            assert.deepStrictEqual([p.status, p.revoked_by], ['revoked', 'account_deleted']);
            const rev = nodeEvents.find((e) => e.subject.id === principal);
            assert.ok(rev, `an event for ${principal}`);
            assert.ok(validate('events.event-envelope@1', rev).valid, JSON.stringify(validate('events.event-envelope@1', rev).errors));
            assert.ok(validate('network.node.revoked@1', rev.payload).valid, JSON.stringify(validate('network.node.revoked@1', rev.payload).errors));
            assert.deepStrictEqual([rev.payload.node_id, rev.payload.principal_id, rev.payload.owner, rev.payload.reason, rev.actor],
                [nodeId, principal, { kind: 'user', subject: subjectId }, 'account_deleted', { type: 'user', id: dana.subject_id }]);
            assert.ok(!/hash|credential|secret/i.test(JSON.stringify(rev.payload)), 'the payload carries no secret field');
        }
        const gone = await db.prepare('SELECT * FROM users WHERE id = ?').get(dana.id);
        assert.match(gone.username, /^deleted-/);
        assert.deepStrictEqual([gone.email, gone.display_name, gone.password_hash, !!gone.deleted_at], [null, null, '!deleted', true]);
        assert.match((await db.prepare('SELECT username FROM users WHERE id = ?').get(old.id)).username, /^deleted-/, 'the merged-in account too');
        for (const [t, col] of [['linked_accounts', 'user_id'], ['user_sessions', 'user_id'], ['oauth_tokens', 'user_id'], ['user_preferences', 'user_id']]) {
            assert.strictEqual((await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).get(dana.id)).n, 0, `${t} erased`);
        }
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM user_modules WHERE subject_id = ?').get(dana.subject_id)).n, 0);
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM user_follows WHERE follower_subject = ? OR target_id = ?').get(dana.subject_id, dana.subject_id)).n, 0, 'follows both ways');
        assert.strictEqual(wallet.getBalance ? await wallet.getBalance(db, dana.id) : (await db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(dana.id)).balance, 0);
        assert.strictEqual((await db.prepare("SELECT COUNT(*) AS n FROM coin_transactions WHERE user_id = ? AND reason = 'account_deleted'").get(dana.id)).n, 1, 'one closing entry; the ledger stays');
        assert.ok(await mk('dana'), 'the username is released');
        const p = await subjects.resolve(db, { subject_id: dana.subject_id });
        assert.deepStrictEqual([p.deleted, p.display_name], [true, 'Deleted account']);
        assert.strictEqual((await subjects.resolve(db, { subject_id: old.subject_id })).deleted, true, 'the alias resolves as deleted too');
        r = await call('GET', '/api/v1/account/deletion', oldToken);
        assert.strictEqual(r.status, 401, 'old tokens are refused');
        const ev = await events('network.account.deleted');
        assert.strictEqual(ev.length, 1);
        assert.ok(validate('network.account.deleted@1', ev[0].payload).valid);
        assert.deepStrictEqual([ev[0].payload.deletion_id, ev[0].payload.subject, ev[0].payload.aliases], [del, dana.subject_id, [old.subject_id]]);
        assert.ok((await events('network.user.token_valid_after')).some((e) => e.payload.reason === 'account_deleted'));
        assert.strictEqual((await accountData.sweep(db, { dir: exportDir, now: due + 5000 })).deleted, 0, 'once');
        assert.strictEqual((await events('network.node.revoked')).length, 2, 'a second sweep emits nothing new');

        // Services confirm; staff see what is outstanding.
        const confirm = { subject: dana.subject_id, completed_at: new Date().toISOString(), erased: { messages: 3 }, retained: { moderation_actions: 1 } };
        r = await call('POST', `/internal/account-deletions/${del}/confirmations`, svc('chat'), confirm);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.id, r.body.service, r.body.replaced], [del, 'chat', false]);
        r = await call('POST', `/internal/account-deletions/${del}/confirmations`, svc('chat'), confirm);
        assert.strictEqual(r.body.replaced, true);
        r = await call('POST', `/internal/account-deletions/${del}/confirmations`, svc('live'), { ...confirm, subject: eve.subject_id });
        assert.deepStrictEqual([r.status, r.body.error], [400, 'deletion.wrong_subject']);
        r = await call('GET', '/api/admin/account-deletions', tok(eve));
        assert.strictEqual(r.status, 403);
        r = await call('GET', '/api/admin/account-deletions', tok(boss));
        const row = r.body.deletions.find((d) => d.deletion_id === del);
        assert.deepStrictEqual([row.confirmed, row.outstanding], [['chat'], ['community', 'games', 'live', 'media', 'space']]);

        // Staff cancel a scheduled deletion only with a reason.
        await call('POST', '/api/v1/account/deletion', tok(eve), { confirm_username: 'eve' });
        const eveDel = (await db.prepare("SELECT id FROM account_deletions WHERE user_id = ? AND status = 'scheduled'").get(eve.id)).id;
        r = await call('POST', `/api/admin/account-deletions/${eveDel}/cancel`, tok(boss), { reason: 'no' });
        assert.deepStrictEqual([r.status, r.body.error], [400, 'deletion.reason_required']);
        r = await call('POST', `/api/admin/account-deletions/${eveDel}/cancel`, tok(boss), { reason: 'the person wrote to support and changed their mind' });
        assert.strictEqual(r.body.status, 'cancelled');
        assert.ok(await db.prepare("SELECT 1 FROM audit_log WHERE action = 'account_deletion_cancelled'").get());

        // ── Concurrent double-spend of one wallet: exactly one debit wins (decision 1, plan T2) ──
        // On PostgreSQL under READ COMMITTED the balance check moves into the conditional UPDATE, so two
        // spends of one wallet race safely; on SQLite the single writer hid this.
        const spender = await mk('spender');
        await wallet.credit(db, { user_id: spender.id, app_id: 'live', amount: 50, reason: 'chat', idempotency_key: 'sp-1' });
        const spends = await Promise.allSettled([
            wallet.debit(db, { user_id: spender.id, app_id: 'live', amount: 50, reason: 'chat', idempotency_key: 'sp-2' }),
            wallet.debit(db, { user_id: spender.id, app_id: 'live', amount: 50, reason: 'chat', idempotency_key: 'sp-3' }),
        ]);
        assert.strictEqual(spends.filter((s) => s.status === 'fulfilled').length, 1, 'one of two concurrent spends of one wallet wins');
        assert.strictEqual(await wallet.getBalance(db, spender.id), 0, 'the wallet was spent once, never twice');
        const losers = spends.filter((s) => s.status === 'rejected');
        assert.strictEqual(losers.length, 1);
        assert.strictEqual(losers[0].reason.status, 409, 'the loser is insufficient_funds, not a crash');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('account export and deletion: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
