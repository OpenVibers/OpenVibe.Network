'use strict';
// Export tokens (server/developer/tokens.js mintExportToken, roadmap WS-N task 9):
// POST /api/v1/projects/:project/export-tokens { audience, env } mints a 5-minute, read-only token
// shaped as an app token (sub app:app_<project ULID>, purpose export, on_behalf_of the person) for
// the project's owner or an admin member only, and writes a dev_audit row for each one.
//   node test/developer-export-tokens.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { serviceAuth, validate, capabilities } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const tokens = require('../server/developer/tokens');

const logged = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logged.push(a.map(String).join(' ')); };
const out = (...a) => orig.log(...a);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-exporttokens-'));
const db = initDb(path.join(dir, 'network.db'));
db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (10, 'owner', 'x', 'user'), (11, 'admin', 'x', 'user'), (12, 'dev', 'x', 'user'), (13, 'viewer', 'x', 'user'),
    (14, 'stranger', 'x', 'user'), (15, 'staff', 'x', 'admin')`).run();
const sid = (id) => subjects.ensureUserSubject(db, db.prepare('SELECT * FROM users WHERE id = ?').get(id));

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = {
    baseUrl: ISSUER, loginUrl: ISSUER, internalKey: 'legacy-key',
    jwt: { issuer: ISSUER, accessTokenExpiry: '1h' },
    developer: { credentialOverlapS: 60 },
};
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);

const userToken = (id) => jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const T = { owner: userToken(10), admin: userToken(11), dev: userToken(12), viewer: userToken(13), stranger: userToken(14), staff: userToken(15) };
const minted = [];

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const h = { ...(who ? { authorization: `Bearer ${T[who] || who}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, cache: r.headers.get('cache-control'), text, body: text ? JSON.parse(text) : null };
    };
    const mint = (who, project, body) => api(who, 'POST', `/${project}/export-tokens`, body);
    const verify = (t, audience, o = {}) => serviceAuth.verifyServiceToken(t, { publicKey: keys.publicKey, issuer: ISSUER, audience, acceptSandbox: true, ...o });
    const exportRows = () => db.prepare("SELECT * FROM dev_audit WHERE action = 'project.export_token_issued' ORDER BY id").all();

    // A project with one member of each role, and a project the owner is not in.
    let r = await api('owner', 'POST', '', { name: 'Exported' });
    assert.strictEqual(r.status, 201, r.text);
    const P = r.body.id;
    for (const [who, role] of [['admin', 'admin'], ['dev', 'developer'], ['viewer', 'viewer']]) {
        r = await api('owner', 'POST', `/${P}/members`, { username: who, role });
        assert.strictEqual(r.status, 201, r.text);
    }
    r = await api('dev', 'POST', `/${P}/apps`, { name: 'Real app', environment: 'sandbox', type: 'confidential' });
    assert.strictEqual(r.status, 201, r.text);
    const realApp = r.body.id;
    r = await api('stranger', 'POST', '', { name: 'Someone else' });
    const Q = r.body.id;
    const ulidOf = (prj) => prj.replace(/^prj_/, '');

    // ── The owner: a Media token for production ──
    r = await mint('owner', P, { audience: 'openvibe.media', env: 'production' });
    assert.strictEqual(r.status, 201, r.text);
    assert.match(r.cache, /no-store/);
    minted.push(r.body.access_token);
    let v = verify(r.body.access_token, 'openvibe.media');
    assert.ok(v.ok, v.reason);
    assert.ok(validate('identity.service-token-claims@1', v.claims).valid, 'shaped by the service-token contract');
    assert.strictEqual(v.claims.sub, `app:app_${ulidOf(P)}`, 'the project\'s export principal');
    assert.strictEqual(v.claims.sub, tokens.exportSubject(P));
    assert.notStrictEqual(v.claims.sub, `app:${realApp}`, 'not one of the project\'s apps');
    assert.strictEqual(v.claims.actor_type, 'app', 'receivers take it as an app of the project');
    assert.deepStrictEqual(v.claims.aud, ['openvibe.media']);
    assert.deepStrictEqual(v.claims.cap, ['media.object.list', 'media.object.read'], 'list and read only');
    assert.deepStrictEqual(v.claims.ns, [P, `app.${P}.*`], 'the project\'s namespaces, both environments');
    assert.strictEqual(v.claims.project_id, P);
    assert.strictEqual(v.claims.env, 'production');
    assert.strictEqual(v.claims.on_behalf_of, sid(10), 'the person exporting');
    assert.strictEqual(v.claims.purpose, 'export');
    assert.strictEqual(v.claims.exp - v.claims.iat, 300, 'five minutes');
    assert.ok(Math.abs(v.claims.iat - Date.now() / 1000) < 5);
    assert.strictEqual(r.body.token_type, 'Bearer');
    assert.strictEqual(r.body.expires_in, 300);
    assert.strictEqual(r.body.expires_at, new Date(v.claims.exp * 1000).toISOString());
    assert.strictEqual(r.body.scope, 'media.object.list media.object.read');
    assert.deepStrictEqual([r.body.audience, r.body.env, r.body.purpose, r.body.subject, r.body.project_id, r.body.jti],
        ['openvibe.media', 'production', 'export', v.claims.sub, P, v.claims.jti]);
    // It expires: five minutes (plus the receivers' 30 s clock skew) later it no longer verifies.
    assert.strictEqual(verify(r.body.access_token, 'openvibe.media', { now: (v.claims.exp + 31) * 1000 }).code, 'token.expired');
    assert.strictEqual(verify(r.body.access_token, 'openvibe.events').code, 'token.wrong_audience', 'one audience per token');
    // No write capability rides along, whatever the project's grants.
    for (const c of ['media.object.upload', 'media.object.delete', 'events.app.publish', 'events.app.subscribe']) {
        assert.ok(!capabilities.grants(v.claims.cap, c), `${c} is not in an export token`);
    }

    // ── An admin: an Events token for the sandbox ──
    r = await mint('admin', P, { audience: 'openvibe.events', env: 'sandbox' });
    assert.strictEqual(r.status, 201, r.text);
    minted.push(r.body.access_token);
    v = verify(r.body.access_token, 'openvibe.events');
    assert.ok(v.ok, v.reason);
    assert.deepStrictEqual(v.claims.cap, ['events.app.read']);
    assert.strictEqual(v.claims.env, 'sandbox');
    assert.strictEqual(v.claims.on_behalf_of, sid(11));
    assert.strictEqual(verify(r.body.access_token, 'openvibe.events', { acceptSandbox: false }).code, 'token.sandbox_refused',
        'a receiver that did not opt in to sandbox tokens still refuses it');

    // ── Everyone else is refused, and nothing is minted or audited for them ──
    const before = exportRows().length;
    r = await mint('dev', P, { audience: 'openvibe.media', env: 'sandbox' });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'project.forbidden', 'a developer may not export');
    r = await mint('viewer', P, { audience: 'openvibe.media', env: 'sandbox' });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'project.forbidden', 'a viewer may not export');
    r = await mint('stranger', P, { audience: 'openvibe.media', env: 'sandbox' });
    assert.strictEqual(r.status, 404); assert.strictEqual(r.body.code, 'project.not_found', 'a non-member learns nothing');
    r = await mint('staff', P, { audience: 'openvibe.media', env: 'sandbox' });
    assert.strictEqual(r.status, 403, 'staff who are not an admin of the project get no export token');
    r = await mint('owner', Q, { audience: 'openvibe.media', env: 'sandbox' });
    assert.strictEqual(r.status, 404, 'the owner of one project gets nothing for another');
    r = await mint('owner', 'prj_NOTAPROJECT', { audience: 'openvibe.media', env: 'sandbox' });
    assert.strictEqual(r.status, 404);
    r = await mint(null, P, { audience: 'openvibe.media', env: 'sandbox' });
    assert.strictEqual(r.status, 401, 'a person\'s token is required');
    r = await mint(minted[0], P, { audience: 'openvibe.media', env: 'sandbox' });
    assert.strictEqual(r.status, 401, 'an export token is not a user: it cannot mint another');
    for (const [body, code] of [
        [{ audience: 'openvibe.tools', env: 'sandbox' }, 'export.invalid_audience'],
        [{ audience: 'openvibe.network', env: 'production' }, 'export.invalid_audience'],
        [{ env: 'production' }, 'export.invalid_audience'],
        [{ audience: 'openvibe.media', env: 'staging' }, 'export.invalid_env'],
        [{ audience: 'openvibe.media' }, 'export.invalid_env'],
    ]) {
        r = await mint('owner', P, body);
        assert.strictEqual(r.status, 422, JSON.stringify(body));
        assert.strictEqual(r.body.code, code, JSON.stringify(body));
    }
    assert.strictEqual(exportRows().length, before, 'refusals write no export audit row');

    // ── The export principal opens nothing else ──
    r = await api(minted[0], 'GET', `/${P}`);
    assert.strictEqual(r.status, 401, 'not a user at Network');
    const tok = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: `app_${ulidOf(P)}`, client_secret: 'ovsec_x', audience: 'openvibe.media' }) });
    assert.strictEqual(tok.status, 401, '/oauth/token never issues the export principal a token');
    r = await api('owner', 'GET', `/${P}/apps`);
    assert.deepStrictEqual(r.body.apps.map(a => a.id), [realApp], 'it is not listed as an app');

    // ── The audit: one row per token, with who, what and until when; never the token ──
    let rows = exportRows();
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map(x => [x.project_id, x.actor, x.target]),
        [[P, `user:${sid(10)}`, tokens.exportSubject(P)], [P, `user:${sid(11)}`, tokens.exportSubject(P)]]);
    const d0 = JSON.parse(rows[0].detail);
    const c0 = verify(minted[0], 'openvibe.media').claims;
    assert.deepStrictEqual(d0, { audience: 'openvibe.media', env: 'production', cap: ['media.object.list', 'media.object.read'], jti: c0.jti,
        expires_at: new Date(c0.exp * 1000).toISOString(), purpose: 'export' });
    assert.ok(rows.every(x => x.event_type === null), 'an audit row, not a platform event');
    r = await api('owner', 'GET', `/${P}/audit`);
    assert.ok(r.body.entries.some(e => e.action === 'project.export_token_issued' && e.detail.jti === c0.jti), 'members with the audit role see it');

    // ── An archived project can still be exported by its owner ──
    r = await api('owner', 'POST', `/${P}/archive`);
    assert.strictEqual(r.status, 200, r.text);
    r = await mint('owner', P, { audience: 'openvibe.events', env: 'production' });
    assert.strictEqual(r.status, 201, r.text);
    minted.push(r.body.access_token);
    assert.strictEqual(exportRows().length, 3);

    // ── Tokens are never stored or logged ──
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(x => x.name);
    for (const t of minted) {
        const sig = t.split('.')[2];
        for (const name of tables) assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()).includes(sig), `a token in ${name}`);
        assert.ok(!logged.some(l => l.includes(sig)), 'a token in the logs');
    }

    out('export tokens: all checks passed');
    server.close();
})().catch(err => { orig.error(err); process.exit(1); });
