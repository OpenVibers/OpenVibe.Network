'use strict';
// One-click sign-in for the browser extension (2026-10-30): a public first-party OAuth client
// (`companion`) with no secret, PKCE S256, exact extension redirects, a read-only scope ceiling and a
// private-issuer access token. The Dock guard accepts it for `dock`, the normal account guard does not;
// refresh rotates; revoke ends the family at once on Network. Existing confidential clients keep their
// secret and their optional PKCE.
//
//   node --import ./test/helpers/pg-preload.mjs test/oauth-extension.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const oauthRoutes = require('../server/auth/oauth-routes');
const authRoutes = require('../server/auth/routes');
const dockMod = require('../server/dock');
const { makeRequireAuth } = require('../server/auth/session');

const ISSUER = 'https://openvibe.network';
const CHROME = 'https://bjcjcfcecpkkmfndegkjekoipdmbgakd.chromiumapp.org/';
const FIREFOX = 'https://bb6593a68b1dcfbb7acd9650f04a169f4c5b57a0.extensions.allizom.org/';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const verifier = () => b64(crypto.randomBytes(32));
const challenge = (v) => b64(crypto.createHash('sha256').update(v).digest());

(async () => {
    const db = getDb();
    const quiet = console.log; console.log = () => {};
    const keys = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const config = { baseUrl: ISSUER, loginUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '7d' } };
    const user = { id: 1, username: 'dockana', display_name: 'Dock Ana', role: 'user', password_hash: 'x' };
    await db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'dockana', 'dockana@example.test', 'x', 'user')").run();
    await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 1').get());

    const dock = dockMod.createDock({ db });
    const requireAuth = makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
    const requireDock = (scope) => makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken, { dockScope: scope });
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/oauth', oauthRoutes);
    app.use('/api/v1/me/dock', dockMod.router({ dock, requireAuth: requireDock('dock') }));
    app.get('/api/v1/me/private', requireAuth, (req, res) => res.json({ ok: true }));
    app.get('/api/v1/me/actions', requireDock('activity'), (req, res) => res.json({ ok: true, scope: req.dockScope }));
    app.post('/api/v1/me/actions', requireAuth, (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const normal = authRoutes.signToken(await db.prepare('SELECT * FROM users WHERE id = 1').get(), keys.privateKey, config);

    const authorize = async (query) => {
        const r = await fetch(`${base}/oauth/authorize?${new URLSearchParams(query)}`, { redirect: 'manual' });
        return { status: r.status, location: r.headers.get('location') || null, body: await r.json().catch(() => null) };
    };
    const confirm = async (body) => {
        const r = await fetch(`${base}/oauth/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: normal, ...body }) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const token = async (body) => {
        const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const api = async (method, path, tok) => {
        const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tok}` } });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    try {
        // The migration is expand only: nullable/default columns, no NOT NULL on the new ones.
        const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0032_oauth_public_clients.sql'), 'utf8');
        assert.match(sql, /^-- phase: expand/m);
        assert.doesNotMatch(sql, /ADD COLUMN[^;]*NOT NULL/i, 'new columns are nullable/default');
        assert.match(sql, /ALTER COLUMN client_secret DROP NOT NULL/);

        // The registered name and exact redirects.
        let r = await fetch(`${base}/oauth/client-info?client_id=companion&redirect_uri=${encodeURIComponent(CHROME)}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await r.json()).name, 'OpenVibe extension');
        for (const uri of [CHROME, FIREFOX]) {
            const found = await db.prepare('SELECT redirect_uris FROM oauth_clients WHERE client_id = ?').get('companion');
            assert.ok(JSON.parse(found.redirect_uris).includes(uri), `registered: ${uri}`);
        }

        // Public client: state + PKCE + allowed scope required.
        assert.strictEqual((await authorize({ client_id: 'companion', redirect_uri: CHROME, response_type: 'code', scope: 'dock' })).status, 400, 'state required');
        assert.strictEqual((await authorize({ client_id: 'companion', redirect_uri: CHROME, response_type: 'code', state: 's', scope: 'dock' })).status, 400, 'PKCE required');
        assert.strictEqual((await authorize({ client_id: 'companion', redirect_uri: CHROME, response_type: 'code', state: 's', scope: 'dock chat.write', code_challenge: challenge(verifier()), code_challenge_method: 'S256' })).status, 400, 'scope ceiling');
        assert.strictEqual((await authorize({ client_id: 'companion', redirect_uri: 'https://evil.example/cb', response_type: 'code', state: 's', scope: 'dock', code_challenge: challenge(verifier()), code_challenge_method: 'S256' })).status, 400, 'exact redirect');

        // Code -> token with no secret.
        const codeVerifier = verifier();
        const state = 'state_' + crypto.randomBytes(12).toString('hex');
        const start = await authorize({ client_id: 'companion', redirect_uri: CHROME, response_type: 'code', scope: 'dock activity chat.read', state, code_challenge: challenge(codeVerifier), code_challenge_method: 'S256' });
        assert.strictEqual(start.status, 302);
        assert.match(start.location, /\/login\?/);
        assert.match(start.location, /client_name=OpenVibe\+extension/);
        const cx = await confirm({ client_id: 'companion', redirect_uri: CHROME, response_type: 'code', scope: 'dock activity chat.read', state, code_challenge: challenge(codeVerifier), code_challenge_method: 'S256' });
        assert.strictEqual(cx.status, 200, JSON.stringify(cx.body));
        const redirect = new URL(cx.body.redirect);
        assert.strictEqual(redirect.searchParams.get('state'), state);
        const code = redirect.searchParams.get('code');
        assert.ok(code);
        const noSecret = await token({ grant_type: 'authorization_code', client_id: 'companion', code, redirect_uri: CHROME, code_verifier: codeVerifier });
        assert.strictEqual(noSecret.status, 200, JSON.stringify(noSecret.body));
        assert.strictEqual(noSecret.body.expires_in, 3600);
        assert.strictEqual(noSecret.body.scope, 'dock activity chat.read');
        const claims = jwt.decode(noSecret.body.access_token);
        assert.strictEqual(claims.iss, `${ISSUER}/dock`);
        assert.deepStrictEqual(claims.aud, ['openvibe.network', 'openvibe.chat']);
        assert.deepStrictEqual([claims.client_id, claims.scope, claims.role, claims.staff_caps], ['companion', 'dock activity chat.read', undefined, undefined]);
        assert.match(claims.fam, /^fam_[0-9a-f]{24}$/);
        assert.ok(noSecret.body.refresh_token);

        // The Dock accepts it; a normal account route refuses it. Activity reads are open, action
        // writes are not, and a token that only has `dock` is refused the activity route.
        assert.strictEqual((await api('GET', '/api/v1/me/dock', noSecret.body.access_token)).status, 200);
        assert.strictEqual((await api('GET', '/api/v1/me/private', noSecret.body.access_token)).status, 401, 'not a normal session');
        assert.strictEqual((await api('GET', '/api/v1/me/private', normal)).status, 200, 'a normal session still works');
        assert.deepStrictEqual((await api('GET', '/api/v1/me/actions', noSecret.body.access_token)).body.scope, ['dock', 'activity', 'chat.read']);
        assert.strictEqual((await api('POST', '/api/v1/me/actions', noSecret.body.access_token)).status, 401, 'approve/decline is not a Dock-token route');
        const dockOnly = jwt.sign({
            sub: 1, id: 1, username: 'dockana', client_id: 'companion', scope: 'dock', fam: claims.fam,
            iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
        }, keys.privateKey, { algorithm: 'RS256', issuer: `${ISSUER}/dock`, audience: ['openvibe.network', 'openvibe.chat'] });
        assert.strictEqual((await api('GET', '/api/v1/me/actions', dockOnly)).status, 403, 'scope ceiling is enforced per route');

        // Refresh rotates: the old token is refused, the new one works, and reuse after the grace would
        // revoke the family (the rotation path itself is covered by test/refresh-tokens.test.js).
        const refreshed = await token({ grant_type: 'refresh_token', client_id: 'companion', refresh_token: noSecret.body.refresh_token });
        assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.body));
        assert.strictEqual(refreshed.body.expires_in, 3600);
        assert.notStrictEqual(refreshed.body.refresh_token, noSecret.body.refresh_token);
        assert.strictEqual((await token({ grant_type: 'refresh_token', client_id: 'companion', refresh_token: noSecret.body.refresh_token })).status, 400);
        assert.strictEqual((await api('GET', '/api/v1/me/dock', refreshed.body.access_token)).status, 200);

        // Sign out revokes the family: the access token stops on Network at once.
        const revoked = await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'companion', token: refreshed.body.refresh_token }) });
        assert.strictEqual(revoked.status, 200, JSON.stringify(await revoked.json()));
        assert.strictEqual((await api('GET', '/api/v1/me/dock', refreshed.body.access_token)).status, 401, 'family revoked');

        // Existing confidential clients do not change: secret required, PKCE still optional.
        const liveVerifier = verifier();
        const liveState = 'live_' + crypto.randomBytes(8).toString('hex');
        const liveStart = await authorize({ client_id: 'live', redirect_uri: 'https://openvibe.live/api/auth/callback', response_type: 'code', scope: 'profile theme', state: liveState });
        assert.strictEqual(liveStart.status, 302, 'PKCE stays optional for a confidential client');
        const live = await confirm({ client_id: 'live', redirect_uri: 'https://openvibe.live/api/auth/callback', response_type: 'code', scope: 'profile theme', state: liveState });
        assert.strictEqual(live.status, 200, JSON.stringify(live.body));
        const liveCode = new URL(live.body.redirect).searchParams.get('code');
        assert.strictEqual((await token({ grant_type: 'authorization_code', client_id: 'live', code: liveCode, redirect_uri: 'https://openvibe.live/api/auth/callback' })).status, 401, 'the live secret is still required');
        const secret = (await db.prepare("SELECT client_secret FROM oauth_clients WHERE client_id = 'live'").get()).client_secret;
        const withSecret = await token({ grant_type: 'authorization_code', client_id: 'live', client_secret: secret, code: liveCode, redirect_uri: 'https://openvibe.live/api/auth/callback' });
        assert.strictEqual(withSecret.status, 200, JSON.stringify(withSecret.body));
        assert.strictEqual(jwt.decode(withSecret.body.access_token).iss, ISSUER, 'a confidential client keeps the normal issuer');
    } finally {
        console.log = quiet;
        await new Promise((r) => server.close(r));
    }
    console.log('oauth extension: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
