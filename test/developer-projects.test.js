'use strict';
// Developer projects (server/developer, roadmap Wave 20 foundation, ADR-014): projects, members,
// apps, credentials, grants, quotas, audit/events, app tokens and the sandbox check.
//   node test/developer-projects.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { serviceAuth, validate } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const policy = require('../server/developer/policy');

// Everything the server logs is captured, so the test can prove no secret was ever logged.
const logged = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logged.push(a.map(String).join(' ')); };
const out = (...a) => orig.log(...a);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-devprojects-'));
const db = initDb(path.join(dir, 'network.db'));
db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (10, 'owner', 'x', 'user'), (11, 'dev', 'x', 'user'), (12, 'viewer', 'x', 'user'), (13, 'stranger', 'x', 'user'), (14, 'staff', 'x', 'admin')`).run();
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
    // No sandbox allowance here, so every grant goes through the staff-set allowance (the defaults
    // are covered by test/developer-defaults.test.js).
    developer: { sandboxAudiences: 'openvibe.media', sandboxAllowance: '', credentialOverlapS: 60 },
};
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal', require('../server/internal/routes'));
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);

const userToken = (id) => jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const T = { owner: userToken(10), dev: userToken(11), viewer: userToken(12), stranger: userToken(13), staff: userToken(14) };
const secretsSeen = [];

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body, headers = {}) => {
        const h = { ...(who ? { authorization: `Bearer ${T[who]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers };
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('content-type') || '', rid: r.headers.get('x-openvibe-request-id'), text, body: text ? JSON.parse(text) : null };
    };
    const token = (form) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
        .then(async r => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }));
    const cc = (appId, secret, audience = 'openvibe.media', extra = {}) => token({ grant_type: 'client_credentials', client_id: appId, client_secret: secret, audience, ...extra });
    // Inspects token contents, so it opts in to sandbox tokens (contracts v0.26.0 refuses them by default).
    const verify = (t, audience = 'openvibe.media') => serviceAuth.verifyServiceToken(t, { publicKey: keys.publicKey, issuer: ISSUER, audience, acceptSandbox: true });

    // ── Authentication: Bearer user tokens only; never X-Internal-Key ──
    let r = await api(null, 'GET', '', null, { 'x-internal-key': 'legacy-key' });
    assert.strictEqual(r.status, 401, 'the internal key opens nothing here');
    assert.match(r.type, /application\/problem\+json/);
    assert.strictEqual(r.body.code, 'auth.required');
    assert.ok(r.rid, 'request id on every response');
    r = await api(null, 'GET', '', null, { cookie: `ov_token=${T.owner}` });
    assert.strictEqual(r.status, 401, 'cookies are not read (no CSRF surface)');
    r = await api(null, 'GET', '', null, { 'x-openvibe-request-id': 'req_test_12345678', authorization: `Bearer ${T.owner}` });
    assert.strictEqual(r.rid, 'req_test_12345678', 'a caller request id is propagated');

    // ── Projects ──
    r = await api('owner', 'POST', '', { name: 'Demo Project' });
    assert.strictEqual(r.status, 201, r.text);
    const P = r.body.id;
    assert.match(P, /^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.strictEqual(r.body.role, 'owner');
    assert.deepStrictEqual(r.body.owner, { type: 'user', id: sid(10) });
    assert.deepStrictEqual(r.body.environments, ['sandbox'], 'new projects are sandbox-only');
    assert.deepStrictEqual(r.body.allowance, []);

    // Non-members cannot see the project (404, existence not disclosed)
    r = await api('stranger', 'GET', `/${P}`);
    assert.strictEqual(r.status, 404); assert.strictEqual(r.body.code, 'project.not_found');
    r = await api('stranger', 'GET', '');
    assert.deepStrictEqual(r.body.projects, []);
    r = await api('stranger', 'GET', `/${P}/apps`);
    assert.strictEqual(r.status, 404);
    r = await api('stranger', 'POST', `/${P}/members`, { username: 'stranger', role: 'admin' });
    assert.strictEqual(r.status, 404, 'non-members cannot add themselves');
    r = await api('staff', 'GET', '?all=1');
    assert.ok(r.body.projects.some(p => p.id === P), 'staff can list every project');

    // ── Members ──
    r = await api('owner', 'POST', `/${P}/members`, { username: 'dev', role: 'developer' });
    assert.strictEqual(r.status, 201, r.text);
    r = await api('owner', 'POST', `/${P}/members`, { subject_id: sid(12), role: 'viewer' });
    assert.strictEqual(r.status, 201, r.text);
    r = await api('owner', 'POST', `/${P}/members`, { username: 'staff', role: 'owner' });
    assert.strictEqual(r.status, 403, 'ownership is not assignable');
    r = await api('dev', 'POST', `/${P}/members`, { username: 'stranger', role: 'viewer' });
    assert.strictEqual(r.status, 403, 'developers do not manage members');
    r = await api('viewer', 'GET', `/${P}/members`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.members.map(m => m.role).sort(), ['developer', 'owner', 'viewer']);

    // ── Apps ──
    r = await api('viewer', 'POST', `/${P}/apps`, { name: 'Nope' });
    assert.strictEqual(r.status, 403, 'viewers cannot create apps');
    r = await api('dev', 'POST', `/${P}/apps`, { name: 'Prod', environment: 'production' });
    assert.strictEqual(r.status, 403);
    r = await api('dev', 'POST', `/${P}/apps`, { name: 'Uploader', environment: 'sandbox', type: 'confidential' });
    assert.strictEqual(r.status, 201, r.text);
    const A = r.body.id;
    assert.match(A, /^app_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.strictEqual(r.body.client_id, A);
    assert.deepStrictEqual(r.body.subject, { type: 'app', id: A });
    const secret1 = r.body.credential.client_secret;
    secretsSeen.push(secret1);
    assert.match(secret1, /^ovsec_[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(r.body.credential.shown_once, true);
    const cred1 = r.body.credential.id;

    // Secrets are never returned again
    for (const p of [`/${P}/apps/${A}`, `/${P}/apps`, `/${P}/apps/${A}/credentials`, `/${P}`, `/${P}/audit`]) {
        const g = await api('owner', 'GET', p);
        assert.strictEqual(g.status, 200, `${p}: ${g.text}`);
        assert.ok(!g.text.includes(secret1), `${p} does not return the secret`);
        assert.ok(!/secret_hash/.test(g.text), `${p} does not return the hash`);
    }
    r = await api('owner', 'GET', `/${P}/apps/${A}/credentials`);
    assert.strictEqual(r.body.credentials[0].hint, secret1.slice(-4));
    assert.strictEqual(r.body.credentials[0].state, 'active');

    // ── Grants: catalog only, never first-party, never beyond the allowance ──
    r = await api('dev', 'POST', `/${P}/apps/${A}/grants`, { capability: 'network.coins.credit' });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'grant.not_grantable', 'first-party capabilities are never grantable');
    r = await api('owner', 'POST', `/${P}/apps/${A}/grants`, { capability: 'identity.subject.resolve' });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'grant.not_grantable');
    r = await api('dev', 'POST', `/${P}/apps/${A}/grants`, { capability: 'nope.not.real' });
    assert.strictEqual(r.status, 422); assert.strictEqual(r.body.code, 'grant.unknown_capability');
    r = await api('dev', 'POST', `/${P}/apps/${A}/grants`, { capability: 'media.object.upload' });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.status, 'requested', 'developers request');
    assert.strictEqual(r.body.audience, 'openvibe.media');
    r = await api('owner', 'POST', `/${P}/apps/${A}/grants/media.object.upload/approve`);
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'grant.beyond_allowance');
    r = await api('owner', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload'] });
    assert.strictEqual(r.status, 403, 'only staff set the allowance');
    r = await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload', 'network.modules.read'] });
    assert.strictEqual(r.status, 422); assert.strictEqual(r.body.code, 'grant.not_grantable', 'staff cannot put first-party capabilities in an allowance');
    r = await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload', 'media.object.read'] });
    assert.strictEqual(r.status, 200, r.text);
    r = await api('dev', 'POST', `/${P}/apps/${A}/grants/media.object.upload/approve`);
    assert.strictEqual(r.status, 403, 'developers cannot approve');
    r = await api('owner', 'POST', `/${P}/apps/${A}/grants/media.object.upload/approve`);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, 'approved');
    r = await api('dev', 'POST', `/${P}/apps/${A}/grants`, { capability: 'media.object.read' });
    assert.strictEqual(r.body.status, 'requested', 'pending, so not in tokens');
    assert.ok(!policy.isGrantable('network.coins.credit') && policy.isGrantable('media.object.upload'));
    assert.ok(policy.grantableCatalog().every(c => c.visibility === 'public'));

    // ── Tokens carry only the granted capabilities ──
    let t = await cc(A, secret1);
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.strictEqual(t.cache, 'no-store');
    let v = verify(t.body.access_token);
    assert.ok(v.ok, v.reason);
    assert.strictEqual(v.claims.sub, `app:${A}`);
    assert.strictEqual(v.claims.actor_type, 'app');
    assert.deepStrictEqual(v.claims.cap, ['media.object.upload'], 'only the approved grant');
    assert.strictEqual(v.claims.project_id, P);
    assert.strictEqual(v.claims.env, 'sandbox');
    assert.deepStrictEqual(v.claims.ns, [P, `app.${P}.*`], 'the project and its app.<project_id>.* namespaces');
    assert.strictEqual(v.claims.exp - v.claims.iat, 300);
    assert.ok(validate('identity.service-token-claims@1', v.claims).valid);
    r = await fetch(`${base}/api/v1/projects`, { headers: { authorization: `Bearer ${t.body.access_token}` } });
    assert.strictEqual(r.status, 401, 'an app token is not a user');
    r = await fetch(`${base}/api/v1/projects`, { headers: { authorization: `Bearer ${jwt.sign({ sub: 10, id: 10 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: -10 })}` } });
    assert.strictEqual(r.status, 401, 'no session grace here: an expired user token is refused');
    t = await cc(A, secret1, 'openvibe.media', { scope: 'media.object.read' });
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'invalid_scope');
    t = await cc(A, 'ovsec_wrong');
    assert.strictEqual(t.status, 401); assert.strictEqual(t.body.error, 'invalid_client');

    // ── Sandbox: only opted-in audiences; receivers refuse env=sandbox ──
    t = await cc(A, secret1, 'openvibe.tools');
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'invalid_target', 'no sandbox token for an audience that did not opt in');
    assert.strictEqual(policy.environmentDecision({ env: 'sandbox' }).code, 'token.sandbox_refused');
    assert.ok(policy.environmentDecision({ env: 'sandbox' }, { acceptSandbox: true }).ok);
    assert.ok(policy.environmentDecision({ env: 'production' }).ok);
    assert.ok(policy.environmentDecision({}).ok, 'first-party service tokens carry no env');
    const now = Math.floor(Date.now() / 1000);
    const forged = (env) => serviceAuth.signServiceToken({ iss: ISSUER, sub: `app:${A}`, actor_type: 'app', aud: ['openvibe.network'], cap: ['identity.subject.resolve'],
        project_id: P, env, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey);
    const resolve = (tok) => fetch(`${base}/internal/identity/resolve?subject_id=${sid(10)}`, { headers: { authorization: `Bearer ${tok}` } }).then(async x => ({ status: x.status, body: await x.json() }));
    r = await resolve(forged('sandbox'));
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'token.sandbox_refused', 'Network (a production audience) refuses sandbox tokens');
    r = await resolve(forged('production'));
    assert.strictEqual(r.status, 200, 'the same token in production passes: only env differs');

    // ── Rotation overlap, then expiry; revocation is immediate ──
    r = await api('dev', 'POST', `/${P}/apps/${A}/credentials/rotate`, { overlap_seconds: 1 });
    assert.strictEqual(r.status, 201, r.text);
    const secret2 = r.body.credential.client_secret;
    secretsSeen.push(secret2);
    const cred2 = r.body.credential.id;
    assert.notStrictEqual(secret2, secret1);
    assert.strictEqual((await cc(A, secret1)).status, 200, 'old secret still valid during the overlap');
    assert.strictEqual((await cc(A, secret2)).status, 200, 'new secret valid');
    await new Promise(res => setTimeout(res, 1200));
    assert.strictEqual((await cc(A, secret1)).status, 401, 'old secret dead after the overlap');
    assert.strictEqual((await cc(A, secret2)).status, 200);
    r = await api('owner', 'GET', `/${P}/apps/${A}/credentials`);
    assert.strictEqual(r.body.credentials.find(c => c.id === cred1).state, 'expired');
    r = await api('dev', 'POST', `/${P}/apps/${A}/credentials/${cred2}/revoke`);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.state, 'revoked');
    t = await cc(A, secret2);
    assert.strictEqual(t.status, 401, 'a revoked secret fails at once');
    r = await api('dev', 'POST', `/${P}/apps/${A}/credentials/rotate`, { overlap_seconds: 0 });
    const secret3 = r.body.credential.client_secret;
    secretsSeen.push(secret3);
    assert.strictEqual((await cc(A, secret3)).status, 200);

    // ── Public app: authorization code + PKCE S256 required ──
    r = await api('dev', 'POST', `/${P}/apps`, { name: 'Browser', type: 'public' });
    assert.strictEqual(r.status, 422, 'a public app needs a redirect URI');
    const REDIRECT = 'https://dev.example.com/callback';
    r = await api('dev', 'POST', `/${P}/apps`, { name: 'Browser', type: 'public', redirect_uris: [REDIRECT] });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.credential, undefined, 'public apps have no secret');
    const B = r.body.id;
    r = await api('owner', 'POST', `/${P}/apps/${B}/grants`, { capability: 'media.object.upload' });
    assert.strictEqual(r.body.status, 'approved', 'owner inside the allowance approves at once');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authorize = (q) => fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: B, redirect_uri: REDIRECT, response_type: 'code', state: 's', ...q })}`, { redirect: 'manual' });
    let a = await authorize({});
    assert.strictEqual(a.status, 400, 'no PKCE, no authorization');
    a = await authorize({ code_challenge: challenge, code_challenge_method: 'plain' });
    assert.strictEqual(a.status, 400, 'plain PKCE refused');
    a = await authorize({ code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: 'https://evil.example.com/cb' });
    assert.strictEqual(a.status, 400, 'unregistered redirect refused');
    a = await authorize({ code_challenge: challenge, code_challenge_method: 'S256' });
    assert.strictEqual(a.status, 302);
    assert.match(new URL(a.headers.get('location')).searchParams.get('client_name'), /third-party app/);
    // The chooser's app name comes from the Network, by client_id and a registered redirect only.
    const info = (q) => fetch(`${base}/oauth/client-info?${new URLSearchParams(q)}`).then(async x => ({ status: x.status, body: await x.json() }));
    let ci = await info({ client_id: B, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    assert.strictEqual(ci.status, 200);
    assert.strictEqual(ci.body.third_party, true);
    assert.strictEqual(ci.body.redirect_host, new URL(REDIRECT).host);
    assert.ok(ci.body.name && !/OpenVibe Official/.test(ci.body.name));
    ci = await info({ client_id: B, redirect_uri: 'https://evil.example.com/cb', client_name: 'OpenVibe Official' });
    assert.strictEqual(ci.status, 404, 'no name for an unregistered redirect');
    a = await authorize({ code_challenge: challenge, code_challenge_method: 'S256', prompt: 'none' });
    assert.strictEqual(new URL(a.headers.get('location')).searchParams.get('error'), 'interaction_required', 'no silent codes for apps');
    const confirm = (who, extra = {}) => fetch(`${base}/oauth/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: T[who], client_id: B, redirect_uri: REDIRECT, state: 's', ...extra }) }).then(async x => ({ status: x.status, body: await x.json() }));
    let c = await confirm('dev');
    assert.strictEqual(c.status, 400, 'confirm without PKCE refused');
    c = await confirm('stranger', { code_challenge: challenge, code_challenge_method: 'S256' });
    assert.strictEqual(c.status, 403, 'sandbox apps are authorized only by project members');
    const codeFor = async () => new URL((await confirm('dev', { code_challenge: challenge, code_challenge_method: 'S256' })).body.redirect).searchParams.get('code');
    const exchange = (code, extra = {}) => token({ grant_type: 'authorization_code', client_id: B, code, redirect_uri: REDIRECT, audience: 'openvibe.media', ...extra });
    t = await cc(B, '');
    assert.strictEqual(t.body.error, 'unauthorized_client', 'public apps cannot use client_credentials');
    let code = await codeFor();
    t = await exchange(code);
    assert.strictEqual(t.status, 400); assert.match(t.body.error_description, /PKCE/);
    t = await exchange(code, { code_verifier: verifier });
    assert.strictEqual(t.status, 400, 'a failed verification burns the code');
    code = await codeFor();
    t = await exchange(code, { code_verifier: verifier });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    v = verify(t.body.access_token);
    assert.strictEqual(v.claims.sub, `app:${B}`);
    assert.strictEqual(v.claims.on_behalf_of, sid(11));
    assert.deepStrictEqual(v.claims.cap, ['media.object.upload']);
    t = await exchange(code, { code_verifier: verifier });
    assert.strictEqual(t.status, 400, 'codes are single-use');

    // ── Shrinking the allowance revokes grants outside it ──
    r = await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.read'] });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.trimmed.some(x => x.app_id === A && x.capability === 'media.object.upload' && x.status === 'revoked'));
    t = await cc(A, secret3);
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'invalid_scope', 'no capability outside the allowance survives');
    r = await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload', 'media.object.read'] });
    r = await api('owner', 'POST', `/${P}/apps/${A}/grants`, { capability: 'media.object.upload' });
    assert.strictEqual(r.body.status, 'approved');

    // ── Production needs staff; developers cannot manage production apps ──
    r = await api('owner', 'POST', `/${P}/apps`, { name: 'Prod', environment: 'production' });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'app.environment_not_allowed');
    r = await api('owner', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' });
    assert.strictEqual(r.status, 403);
    r = await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' });
    assert.strictEqual(r.status, 200);
    r = await api('owner', 'POST', `/${P}/apps`, { name: 'Prod', environment: 'production', redirect_uris: ['http://localhost:3000/cb'] });
    assert.strictEqual(r.status, 422, 'loopback redirects are sandbox-only');
    r = await api('owner', 'POST', `/${P}/apps`, { name: 'Prod', environment: 'production' });
    assert.strictEqual(r.status, 201, r.text);
    const C = r.body.id;
    secretsSeen.push(r.body.credential.client_secret);
    r = await api('dev', 'POST', `/${P}/apps/${C}/credentials/rotate`);
    assert.strictEqual(r.status, 403, 'developers do not rotate production secrets');
    await api('owner', 'POST', `/${P}/apps/${C}/grants`, { capability: 'media.object.read' });
    t = await cc(C, secretsSeen[secretsSeen.length - 1]);
    assert.strictEqual(t.status, 200, 'production app tokens need no sandbox opt-in');
    assert.strictEqual(verify(t.body.access_token).claims.env, 'production');

    // ── Quotas: staff set, members read ──
    r = await api('owner', 'PUT', `/${P}/quotas/media.object.upload`, { limit: 10, window: 'day', unit: 'bytes' });
    assert.strictEqual(r.status, 403);
    r = await api('staff', 'PUT', `/${P}/quotas/media.object.upload`, { limit: 1073741824, window: 'total', unit: 'bytes' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.enforced_by, 'openvibe.media');
    r = await api('viewer', 'GET', `/${P}/quotas`);
    assert.deepStrictEqual(r.body.quotas.map(q => [q.capability, q.limit, q.window, q.unit]), [['media.object.upload', 1073741824, 'total', 'bytes']]);
    r = await api('viewer', 'GET', `/${P}/audit`);
    assert.strictEqual(r.status, 403, 'audit is for admins and owners');

    // ── App revocation is immediate for new tokens ──
    r = await api('dev', 'DELETE', `/${P}/apps/${A}`);
    assert.strictEqual(r.status, 200); assert.ok(r.body.revoked_at);
    t = await cc(A, secret3);
    assert.strictEqual(t.status, 401); assert.strictEqual(t.body.error, 'invalid_client');

    // ── Events recorded in the append-only audit ──
    r = await api('owner', 'GET', `/${P}/audit?limit=200`);
    assert.strictEqual(r.status, 200);
    const types = new Set(r.body.entries.map(e => e.event_type).filter(Boolean));
    for (const e of ['network.app.created', 'network.app.revoked', 'network.credential.rotated', 'network.credential.revoked', 'network.grant.changed']) assert.ok(types.has(e), `event ${e}`);
    for (const row of db.prepare('SELECT event FROM dev_audit WHERE event IS NOT NULL').all()) {
        const env = JSON.parse(row.event);
        assert.ok(validate('events.event-envelope@1', env).valid, JSON.stringify(env));
        assert.strictEqual(env.source, 'network');
    }
    assert.throws(() => db.prepare('UPDATE dev_audit SET action = ?').run('x'), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM dev_audit').run(), /append-only/);

    // ── Archive revokes every app ──
    r = await api('dev', 'POST', `/${P}/archive`);
    assert.strictEqual(r.status, 403);
    r = await api('owner', 'POST', `/${P}/archive`);
    assert.strictEqual(r.status, 200); assert.ok(r.body.archived_at);
    t = await cc(C, secretsSeen[secretsSeen.length - 1]);
    assert.strictEqual(t.status, 401);
    r = await api('owner', 'POST', `/${P}/apps`, { name: 'Late' });
    assert.strictEqual(r.status, 409);

    // ── Secrets: never stored in plaintext, never logged ──
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(x => x.name);
    for (const s of secretsSeen) {
        for (const name of tables) {
            const dump = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
            assert.ok(!dump.includes(s), `secret stored in plaintext in ${name}`);
        }
        assert.ok(!logged.some(l => l.includes(s)), 'secret appeared in logs');
    }

    out('developer projects: all checks passed');
    server.close();
})().catch(err => { orig.error(err); process.exit(1); });
