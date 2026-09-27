'use strict';
// Mod principals (roadmap WS-M task 3, ADR-013; Contracts 0.72.0). A runtime holding mods.grant.manage registers an
// install's principal mod:<mod_id>: the manifest's capabilities are requested, the approved subset approved, the
// rest pending; registering again answers the same principal; another runtime can neither register nor change it.
// Approve and revoke move one capability (only requested ones); revoking the install ends every grant for good.
// Staff (staff.games.manage) change grants with a written reason and an audit row. Every change bumps the revision
// and queues network.mod.grants_changed with the complete approved set.
//   node test/mod-principals.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { validate, serviceAuth } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-mod-principals-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
for (const c of ['games']) db.prepare("INSERT OR IGNORE INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, 'x', ?, '[]', 1)").run(c, c);
const principals = require('../server/identity/principals');
principals.ensureSchema(db);
const modPrincipals = require('../server/identity/mod-principals');
const ISSUER = 'https://openvibe.network';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
const svc = (name, cap = ['mods.grant.manage']) => serviceAuth.signServiceToken({ iss: ISSUER, sub: `svc:${name}`, actor_type: 'service', aud: ['openvibe.network'], cap,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey);
const mk = (name, role) => {
    const id = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', ?)").run(name, role).lastInsertRowid;
    subjects.ensureUserSubject(db, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const tok = (u) => jwt.sign({ sub: u.id, id: u.id, subject_id: u.subject_id, username: u.username, role: u.role, iat: Math.floor(Date.now() / 1000) - 10 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const events = () => db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope)).filter((e) => e.event_type === 'network.mod.grants_changed');
const manifest = JSON.parse(fs.readFileSync(require.resolve('openvibe-contracts/fixtures/mods.mod-manifest/valid/market-stall-1.1.json'), 'utf8'));

const authRoutes = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use(express.json());
const r = modPrincipals.routers({ guard: principals.guard('mods.grant.manage', { legacy: false }), requireAuth, staffClaims: require('../server/auth/staff-claims').staffClaims });
app.use('/internal/mods', r.internal);
app.use('/api/admin/mods', r.admin);
const server = http.createServer(app);

(async () => {
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, token, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
        .then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    try {
        assert.ok(principals.grantsFor(db, 'games', 'openvibe.network').some((g) => g.capability === 'mods.grant.manage'), 'Games holds mods.grant.manage');
        const games = svc('games');
        const [a, b] = manifest.permissions.capabilities;

        // ── Register ──
        let x = await call('POST', '/internal/mods', svc('games', ['identity.subject.resolve']), { manifest, approve: [a] });
        assert.strictEqual(x.status, 403, 'a token without mods.grant.manage');
        x = await call('POST', '/internal/mods', games, { manifest, approve: ['games.world.announce'] });
        assert.deepStrictEqual([x.status, x.body.error], [422, 'mod.not_requested']);
        x = await call('POST', '/internal/mods', games, { manifest: { ...manifest, id: 'nope' }, approve: [] });
        assert.deepStrictEqual([x.status, x.body.error], [422, 'mod.manifest_invalid']);
        x = await call('POST', '/internal/mods', games, { manifest, approve: [a], actor: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' });
        assert.strictEqual(x.status, 201, JSON.stringify(x.body));
        assert.ok(validate('network.mod-principal@1', x.body).valid, JSON.stringify(validate('network.mod-principal@1', x.body).errors));
        assert.deepStrictEqual([x.body.principal, x.body.owner, x.body.approved, x.body.pending, x.body.revision], [`mod:${manifest.id}`, 'games', [a], [b], 1]);
        x = await call('POST', '/internal/mods', games, { manifest, approve: [a, b] });
        assert.deepStrictEqual([x.status, x.body.approved, x.body.revision], [200, [a], 1], 'registering again answers the existing principal');
        x = await call('POST', '/internal/mods', svc('tools'), { manifest, approve: [] });
        assert.deepStrictEqual([x.status, x.body.error], [409, 'mod.other_owner']);
        x = await call('POST', `/internal/mods/${manifest.id}/grants`, svc('tools'), { capability: b, action: 'approve' });
        assert.deepStrictEqual([x.status, x.body.error], [403, 'mod.other_owner'], 'another runtime cannot change it');
        x = await call('GET', '/internal/mods', svc('tools'));
        assert.deepStrictEqual(x.body.mods, [], "another runtime does not see Games' mods");

        // ── Approve and revoke ──
        x = await call('POST', `/internal/mods/${manifest.id}/grants`, games, { capability: 'games.world.announce', action: 'approve' });
        assert.deepStrictEqual([x.status, x.body.error], [422, 'mod.not_requested']);
        x = await call('POST', `/internal/mods/${manifest.id}/grants`, games, { capability: b, action: 'approve' });
        assert.deepStrictEqual([x.body.approved, x.body.pending, x.body.revision], [[a, b].sort(), [], 2]);
        x = await call('POST', `/internal/mods/${manifest.id}/grants`, games, { capability: b, action: 'approve' });
        assert.strictEqual(x.body.revision, 2, 'no change, no revision');
        x = await call('POST', `/internal/mods/${manifest.id}/grants`, games, { capability: a, action: 'revoke' });
        assert.deepStrictEqual([x.body.approved, x.body.revoked, x.body.revision], [[b], [a], 3]);
        x = await call('GET', `/internal/mods/${manifest.id}`, games);
        assert.strictEqual(x.body.revision, 3);

        // ── Staff ──
        const boss = mk('boss', 'admin'); const eve = mk('eve', 'user');
        x = await call('GET', '/api/admin/mods', tok(eve));
        assert.strictEqual(x.status, 403);
        x = await call('POST', `/api/admin/mods/${manifest.id}/grants`, tok(boss), { capability: b, action: 'revoke', reason: 'no' });
        assert.deepStrictEqual([x.status, x.body.error], [400, 'mod.reason_required']);
        x = await call('POST', `/api/admin/mods/${manifest.id}/grants`, tok(boss), { capability: b, action: 'revoke', reason: 'placed props in the spawn area' });
        assert.deepStrictEqual([x.status, x.body.approved, x.body.revision], [200, [], 4]);
        assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'mod_grant_change'").get(), 'audited');

        // ── Revoke the install ──
        x = await call('POST', `/internal/mods/${manifest.id}/revoke`, games, { actor: 'games', reason: 'the install ended' });
        assert.deepStrictEqual([x.body.status, x.body.approved, x.body.revision], ['revoked', [], 5]);
        x = await call('POST', `/internal/mods/${manifest.id}/grants`, games, { capability: a, action: 'approve' });
        assert.deepStrictEqual([x.status, x.body.error], [409, 'mod.revoked'], 'never granted again');

        // Every change announced once, with the complete approved set.
        const ev = events();
        assert.deepStrictEqual(ev.map((e) => [e.payload.revision, e.payload.change.action, e.payload.by, e.payload.approved.length]),
            [[1, 'register', 'runtime', 1], [2, 'approve', 'runtime', 2], [3, 'revoke', 'runtime', 1], [4, 'revoke', 'staff', 0], [5, 'revoke_all', 'runtime', 0]]);
        for (const e of ev) assert.ok(validate('network.mod.grants_changed@1', e.payload).valid && e.visibility === 'internal' && e.subject.type === 'mod');
        assert.strictEqual(ev[3].payload.reason, 'placed props in the spawn area');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('mod principals: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
