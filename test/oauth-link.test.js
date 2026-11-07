'use strict';
// OpenVibe Link on the phone (plan 2026-11-07 §13.2): a public first-party OAuth client (`link`) with no secret, PKCE
// S256, its own scheme as the redirect, and `session_token` set so the token it gets is the person's own session —
// normal issuer and audiences, with their role — rather than the extension's read-only Dock token. The phone uses it
// for the Action Center (read and answer) and the drive's upload. Every other public client keeps the Dock token.
//
//   node --import ./test/helpers/pg-preload.mjs test/oauth-link.test.js
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
const { makeRequireAuth } = require('../server/auth/session');

const ISSUER = 'https://openvibe.network';
const REDIRECT = 'openvibe-link://auth';
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
    await db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'phoneana', 'phoneana@example.test', 'x', 'user')").run();
    const user = await db.prepare('SELECT * FROM users WHERE id = 1').get();
    await subjects.ensureUserSubject(db, user);

    const requireAuth = makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
    const requireDock = (scope) => makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken, { dockScope: scope });
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/oauth', oauthRoutes);
    app.get('/api/v1/me/private', requireAuth, (req, res) => res.json({ ok: true, user: req.user.username }));
    app.get('/api/v1/me/actions', requireDock('activity'), (req, res) => res.json({ ok: true }));
    app.post('/api/v1/me/actions', requireAuth, (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const normal = authRoutes.signToken(user, keys.privateKey, config);

    const authorize = async (query) => {
        const r = await fetch(`${base}/oauth/authorize?${new URLSearchParams(query)}`, { redirect: 'manual' });
        return { status: r.status, location: r.headers.get('location') || null };
    };
    const confirm = async (body) => {
        const r = await fetch(`${base}/oauth/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: normal, ...body }) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const token = async (body) => {
        const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const api = async (method, route, tok) => {
        const r = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${tok}` } });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    try {
        // The migration is expand only, and the client is seeded as a public session client with the app's scheme.
        const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0049_oauth_session_public_clients.sql'), 'utf8');
        assert.match(sql, /^-- phase: expand/m);
        assert.match(sql, /ADD COLUMN IF NOT EXISTS session_token/);
        assert.doesNotMatch(sql, /ADD COLUMN[^;]*NOT NULL/i);

        const client = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get('link');
        assert.ok(client, 'the link client is seeded');
        assert.strictEqual(Number(client.is_public), 1);
        assert.strictEqual(Number(client.session_token), 1);
        assert.strictEqual(client.allowed_scopes, 'profile theme');
        assert.deepStrictEqual(JSON.parse(client.redirect_uris), [REDIRECT]);
        assert.strictEqual(client.client_secret, null, 'a public client keeps no secret');
        const companion = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get('companion');
        assert.strictEqual(Number(companion.session_token), 0, 'the extension stays a read-only Dock client');

        // Public client rules: exact redirect, state, PKCE S256, a scope inside the ceiling.
        assert.strictEqual((await authorize({ client_id: 'link', redirect_uri: REDIRECT, response_type: 'code', scope: 'profile theme' })).status, 400, 'state required');
        assert.strictEqual((await authorize({ client_id: 'link', redirect_uri: REDIRECT, response_type: 'code', state: 's', scope: 'profile theme' })).status, 400, 'PKCE required');
        assert.strictEqual((await authorize({ client_id: 'link', redirect_uri: REDIRECT, response_type: 'code', state: 's', scope: 'dock', code_challenge: challenge(verifier()), code_challenge_method: 'S256' })).status, 400, 'scope ceiling');
        assert.strictEqual((await authorize({ client_id: 'link', redirect_uri: 'openvibe-link://other', response_type: 'code', state: 's', scope: 'theme', code_challenge: challenge(verifier()), code_challenge_method: 'S256' })).status, 400, 'exact redirect');
        assert.strictEqual((await authorize({ client_id: 'link', redirect_uri: REDIRECT, response_type: 'code', state: 's', scope: 'theme', code_challenge: challenge(verifier()), code_challenge_method: 'plain' })).status, 400, 'S256 only');

        // Code -> token with no secret.
        const codeVerifier = verifier();
        const state = 'state_' + crypto.randomBytes(12).toString('hex');
        const start = await authorize({ client_id: 'link', redirect_uri: REDIRECT, response_type: 'code', scope: 'profile theme', state, code_challenge: challenge(codeVerifier), code_challenge_method: 'S256' });
        assert.strictEqual(start.status, 302);
        assert.match(start.location, /\/login\?/);
        const cx = await confirm({ client_id: 'link', redirect_uri: REDIRECT, response_type: 'code', scope: 'profile theme', state, code_challenge: challenge(codeVerifier), code_challenge_method: 'S256' });
        assert.strictEqual(cx.status, 200, JSON.stringify(cx.body));
        const redirect = new URL(cx.body.redirect);
        assert.strictEqual(redirect.searchParams.get('state'), state);
        const code = redirect.searchParams.get('code');
        assert.ok(code);

        const issued = await token({ grant_type: 'authorization_code', client_id: 'link', code, redirect_uri: REDIRECT, code_verifier: codeVerifier });
        assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
        assert.strictEqual(issued.body.expires_in, 86400);

        // The person's own session, not the extension's Dock token.
        const claims = jwt.decode(issued.body.access_token);
        assert.strictEqual(claims.iss, ISSUER, 'the normal issuer');
        assert.ok(claims.aud.includes('openvibe.network'), 'the normal audiences');
        assert.strictEqual(claims.role, 'user');
        assert.strictEqual(claims.client_id, 'link');
        assert.strictEqual(claims.scope, 'profile theme');
        assert.strictEqual(claims.typ, undefined);
        assert.strictEqual(claims.actor_type, undefined);

        // What the phone does with it: read the Action Center, answer an approval, and a normal account route.
        assert.strictEqual((await api('GET', '/api/v1/me/actions', issued.body.access_token)).status, 200);
        assert.strictEqual((await api('POST', '/api/v1/me/actions', issued.body.access_token)).status, 200, 'answering an approval');
        assert.strictEqual((await api('GET', '/api/v1/me/private', issued.body.access_token)).status, 200, 'a plain user token');
        assert.strictEqual((await api('GET', '/api/v1/me/private', 'nope')).status, 401);

        // A second code with the wrong verifier is refused (and spent, as the flow requires).
        const v2 = verifier();
        await authorize({ client_id: 'link', redirect_uri: REDIRECT, response_type: 'code', scope: 'profile theme', state: 's2', code_challenge: challenge(v2), code_challenge_method: 'S256' });
        const cx2 = await confirm({ client_id: 'link', redirect_uri: REDIRECT, response_type: 'code', scope: 'profile theme', state: 's2', code_challenge: challenge(v2), code_challenge_method: 'S256' });
        const code2 = new URL(cx2.body.redirect).searchParams.get('code');
        assert.strictEqual((await token({ grant_type: 'authorization_code', client_id: 'link', code: code2, redirect_uri: REDIRECT, code_verifier: verifier() })).status, 400, 'a wrong verifier is refused');

        // Refresh rotates and keeps the same kind of token.
        const refreshed = await token({ grant_type: 'refresh_token', client_id: 'link', refresh_token: issued.body.refresh_token });
        assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.body));
        assert.notStrictEqual(refreshed.body.refresh_token, issued.body.refresh_token);
        assert.strictEqual(jwt.decode(refreshed.body.access_token).iss, ISSUER);
        assert.strictEqual((await token({ grant_type: 'refresh_token', client_id: 'link', refresh_token: issued.body.refresh_token })).status, 400, 'the old refresh token is spent');
        assert.strictEqual((await api('GET', '/api/v1/me/actions', refreshed.body.access_token)).status, 200);
    } finally {
        await new Promise((r) => server.close(r));
        console.log = quiet;
    }
    console.log('oauth link: all passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
