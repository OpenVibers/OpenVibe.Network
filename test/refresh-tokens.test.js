'use strict';
// Refresh tokens (roadmap §18.2(2), server/auth/refresh-tokens.js): only a hash is stored, each rotation
// is the next generation of the sign-in's family, a reused (already rotated) token revokes the whole
// family, and rows written with the raw token before this change keep working (hashed on first use)
// until scripts/hash-refresh-tokens.js hashes the rest in place, one-way (with a backup and a rollback).
//   node test/refresh-tokens.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { initDb } = require('../server/db/database');
const refreshTokens = require('../server/auth/refresh-tokens');

const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-refresh-'));
    const dbPath = path.join(dir, 'network.db');

    // ── A database as the old code left it: raw refresh tokens, no family or generation ──
    {
        const old = new Database(dbPath);
        old.exec(`CREATE TABLE oauth_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, client_id TEXT NOT NULL,
            user_id INTEGER NOT NULL, scope TEXT DEFAULT 'profile theme', expires_at DATETIME NOT NULL, revoked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        old.close();
    }
    const RAW_LIVE = crypto.randomBytes(48).toString('hex');
    const RAW_ROTATED = crypto.randomBytes(48).toString('hex');
    {
        const old = new Database(dbPath);
        const ins = old.prepare('INSERT INTO oauth_tokens (token, client_id, user_id, expires_at, revoked) VALUES (?, ?, ?, ?, ?)');
        ins.run(RAW_LIVE, 'live', 7, new Date(Date.now() + 86400e3).toISOString(), 0);
        ins.run(RAW_ROTATED, 'live', 7, new Date(Date.now() + 86400e3).toISOString(), 1);
        old.close();
    }

    // Boot: initDb only adds the columns; the raw rows are still raw (and still work, below).
    const db = quiet(() => initDb(dbPath));
    let rows = db.prepare('SELECT * FROM oauth_tokens ORDER BY id').all();
    assert.strictEqual(rows.length, 2);
    assert.ok('family_id' in rows[0] && 'generation' in rows[0] && 'revoked_reason' in rows[0], 'boot adds the columns');
    assert.strictEqual(rows[0].token, RAW_LIVE, 'boot changes no data');

    // ── The operator script: dry run, --apply needs a backup, one-way hashing in place, rollback ──
    const script = require('../scripts/hash-refresh-tokens');
    const out = [];
    const run = (...argv) => script.main(['--db', dbPath, ...argv], (m) => out.push(m));
    const EXTRA = crypto.randomBytes(48).toString('hex');
    db.prepare('INSERT INTO oauth_tokens (token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)').run(EXTRA, 'live', 7, new Date(Date.now() + 86400e3).toISOString());
    assert.strictEqual(await run(), 0);
    assert.ok(out.join('\n').includes('still stored raw 3'), out.join('\n'));
    assert.strictEqual(refreshTokens.countLegacy(db), 3, 'the dry run changes nothing');
    assert.strictEqual(await run('--apply'), 2, '--apply refuses without --backup');
    const backup = path.join(dir, 'pre-hash.db');
    assert.strictEqual(await run('--apply', '--backup', backup), 0, out.join('\n'));
    assert.strictEqual(fs.statSync(backup).mode & 0o777, 0o600, 'the backup is owner-only');
    assert.strictEqual(await run('--apply', '--backup', backup), 0, 'nothing left to hash: no backup needed');
    rows = db.prepare('SELECT * FROM oauth_tokens ORDER BY id').all();
    for (const r of rows) {
        assert.ok(r.token.startsWith('sha256:') && r.token.length === 'sha256:'.length + 64, 'every stored token is a SHA-256');
        assert.ok(r.family_id && r.generation === 0, 'legacy rows get a family and generation 0');
    }
    assert.strictEqual(rows[0].id, 1);
    assert.strictEqual(rows[0].token, refreshTokens.hash(RAW_LIVE), 'hashed in place (same row, same id)');
    const dump = JSON.stringify(db.prepare('SELECT * FROM oauth_tokens').all());
    assert.ok(!dump.includes(RAW_LIVE) && !dump.includes(RAW_ROTATED) && !dump.includes(EXTRA), 'no raw token is left: one-way');
    assert.ok(!out.join('\n').includes(RAW_LIVE), 'the script never prints a token');
    // Rollback (for a return to the pre-hashing release): dry run, then the raw values come back.
    out.length = 0;
    assert.strictEqual(await run('--restore-from', backup), 0);
    assert.ok(out.join('\n').includes('3 row(s) here still hold their hash'), out.join('\n'));
    assert.strictEqual(refreshTokens.countLegacy(db), 0, 'the rollback dry run changes nothing');
    assert.strictEqual(await run('--restore-from', backup, '--apply'), 0);
    assert.strictEqual(db.prepare('SELECT token FROM oauth_tokens WHERE id = 1').get().token, RAW_LIVE, 'rolled back');
    assert.strictEqual(await run('--apply', '--backup', path.join(dir, 'pre-hash-2.db')), 0, 'and forward again');
    assert.strictEqual(refreshTokens.countLegacy(db), 0);
    db.prepare('DELETE FROM oauth_tokens WHERE token = ?').run(refreshTokens.hash(EXTRA));
    // Put one raw row back as the old code would have left it, to show the server still takes it.
    db.prepare('UPDATE oauth_tokens SET token = ? WHERE id = 1').run(RAW_LIVE);

    db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
    db.prepare("UPDATE oauth_clients SET client_secret = 'tools-secret' WHERE client_id = 'tools'").run();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'viewer', 'x')").run();

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const ISSUER = 'https://openvibe.network';
    const app = express();
    app.use(express.json());
    app.locals.db = db;
    app.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h', refreshTokenExpiry: '30d' } };
    app.locals.privateKey = keys.privateKey;
    app.locals.publicKey = keys.publicKey;
    app.use('/oauth', require('../server/auth/oauth-routes'));
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
    const refresh = (token, client = 'live', secret = 'live-secret') => post('/oauth/token', { grant_type: 'refresh_token', client_id: client, client_secret: secret, refresh_token: token });
    const REDIRECT = 'https://openvibe.live/api/auth/callback';
    const userToken = jwt.sign({ sub: 7, id: 7, username: 'viewer' }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '5m' });
    const signIn = async () => {
        const c = await post('/oauth/confirm', { token: userToken, client_id: 'live', redirect_uri: REDIRECT });
        const t = await post('/oauth/token', { grant_type: 'authorization_code', client_id: 'live', client_secret: 'live-secret', code: new URL(c.body.redirect).searchParams.get('code'), redirect_uri: REDIRECT });
        assert.strictEqual(t.status, 200, JSON.stringify(t.body));
        return t.body.refresh_token;
    };
    const rowOf = (token) => db.prepare('SELECT * FROM oauth_tokens WHERE token = ?').get(refreshTokens.hash(token));
    const age = (token, seconds) => db.prepare("UPDATE oauth_tokens SET revoked_at = datetime('now', ?) WHERE token = ?").run(`-${seconds} seconds`, refreshTokens.hash(token));

    // ── A migrated (pre-change) token still refreshes, once ──
    let r = await refresh(RAW_LIVE);
    assert.strictEqual(r.status, 200, `a token written before the change still works: ${JSON.stringify(r.body)}`);
    const legacyFamily = rowOf(RAW_LIVE).family_id;
    assert.strictEqual(rowOf(r.body.refresh_token).family_id, legacyFamily, 'its successor continues the legacy family');
    assert.strictEqual(rowOf(r.body.refresh_token).generation, 1);
    r = await refresh(RAW_ROTATED);
    assert.strictEqual(r.status, 400, 'a token the old code had already rotated stays dead');

    // ── New sign-ins: hash only, family, generations ──
    const t0 = await signIn();
    assert.match(t0, /^[0-9a-f]{96}$/);
    const row0 = rowOf(t0);
    assert.ok(row0, 'found by its hash');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE token = ?').get(t0).n, 0, 'the token itself is not stored');
    assert.strictEqual(row0.generation, 0);
    assert.match(row0.family_id, /^fam_[0-9a-f]{24}$/);
    r = await refresh(t0);
    assert.strictEqual(r.status, 200);
    const t1 = r.body.refresh_token;
    assert.strictEqual(rowOf(t1).family_id, row0.family_id, 'rotation stays in the family');
    assert.strictEqual(rowOf(t1).generation, 1, 'generation counts rotations');
    assert.strictEqual(rowOf(t0).revoked_reason, 'rotated');
    r = await refresh(t1);
    const t2 = r.body.refresh_token;
    assert.strictEqual(rowOf(t2).generation, 2);

    // The stored hash is not a token, and a malformed token is refused without a lookup.
    r = await refresh(rowOf(t2).token);
    assert.strictEqual(r.status, 400, 'presenting the stored hash does not work');
    r = await refresh(rowOf(t2).token.slice('sha256:'.length));
    assert.strictEqual(r.status, 400, 'nor its hex');

    // Another client cannot use (or burn) the family.
    r = await refresh(t2, 'tools', 'tools-secret');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(rowOf(t2).revoked, 0, 'a client mismatch revokes nothing');

    // ── Reuse within the grace window (two tabs at once): refused, family intact ──
    r = await refresh(t1);
    assert.strictEqual(r.status, 400, 'a just-rotated token is single-use');
    assert.strictEqual(rowOf(t2).revoked, 0, 'a concurrent double refresh does not revoke the family');

    // ── Reuse after the grace window: the whole family is revoked ──
    age(t1, refreshTokens.REUSE_GRACE_S + 5);
    r = await refresh(t1);
    assert.strictEqual(r.status, 400, 'a replayed rotated token is refused');
    assert.strictEqual(rowOf(t2).revoked, 1, 'and its family is revoked: the latest generation dies too');
    assert.strictEqual(rowOf(t2).revoked_reason, 'reuse');
    r = await refresh(t2);
    assert.strictEqual(r.status, 400, 'the latest token no longer refreshes');
    const auditRow = db.prepare("SELECT * FROM audit_log WHERE action = 'oauth_refresh_reuse' ORDER BY id DESC").get();
    assert.ok(auditRow, 'reuse is audited');
    const details = JSON.parse(auditRow.details);
    assert.strictEqual(details.family_id, row0.family_id);
    assert.strictEqual(details.generation_presented, 1);
    assert.strictEqual(details.generation_current, 2);
    assert.ok(!auditRow.details.includes(t1) && !auditRow.details.includes(rowOf(t1).token), 'the audit carries no token or hash');
    // Other families of the same account are untouched.
    const other = await signIn();
    r = await refresh(other);
    assert.strictEqual(r.status, 200, 'a separate sign-in (family) keeps working');

    // ── Concurrent use of one token: exactly one wins ──
    const racer = await signIn();
    const results = await Promise.all([1, 2, 3].map(() => refresh(racer)));
    assert.strictEqual(results.filter(x => x.status === 200).length, 1, 'one of three concurrent refreshes wins');
    const winner = results.find(x => x.status === 200).body.refresh_token;
    assert.strictEqual((await refresh(winner)).status, 200, "the winner's token keeps working");

    // ── A raw row that appears after boot (defensive path) is hashed on first use ──
    const late = crypto.randomBytes(48).toString('hex');
    db.prepare('INSERT INTO oauth_tokens (token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)').run(late, 'live', 7, new Date(Date.now() + 86400e3).toISOString());
    r = await refresh(late);
    assert.strictEqual(r.status, 200, 'a raw row still works');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE token = ?').get(late).n, 0, 'and is hashed on use');
    assert.strictEqual(rowOf(late).revoked_reason, 'rotated');

    // Expired tokens are refused.
    const exp = await signIn();
    db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE token = ?').run(new Date(Date.now() - 1000).toISOString(), refreshTokens.hash(exp));
    assert.strictEqual((await refresh(exp)).status, 400, 'an expired refresh token is refused');

    server.close();
    console.log('refresh tokens: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
