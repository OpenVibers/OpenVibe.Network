'use strict';
// OpenVibe Link on the phone (plan 2026-11-07 §13.2, security round 2): a public first-party OAuth client (`link`) with
// no secret and PKCE S256. Its session — the person's own token, so Actor and the drive accept it — is issued only when
// BOTH hold: the authorization returned to the claimed https App Link (https://openvibe.network/link/auth, claimed in
// /.well-known/assetlinks.json for the release certificate) and LINK_ANDROID_CERT_SHA256 publishes at least one
// fingerprint. A custom scheme any app can answer, and an unpublished certificate, get the extension's read-only Dock
// token instead. The chooser always says what the app does, and prompt=none is refused.
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
const appLinks = require('../server/auth/app-links');
const { makeRequireAuth } = require('../server/auth/session');

const ISSUER = 'https://openvibe.network';
const APP_LINK = 'https://openvibe.network/link/auth';
const SCHEME = 'openvibe-link://auth';
const PRINTS = ['AA:'.repeat(31) + 'AA', 'BB:'.repeat(31) + 'BB'];
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
    await db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (2, 'phoneadmin', 'phoneadmin@example.test', 'x', 'admin')").run();
    await db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (3, 'phonestreamer', 'phonestreamer@example.test', 'x', 'streamer')").run();
    const user = await db.prepare('SELECT * FROM users WHERE id = 1').get();
    const admin = await db.prepare('SELECT * FROM users WHERE id = 2').get();
    const streamer = await db.prepare('SELECT * FROM users WHERE id = 3').get();
    for (const u of [user, admin, streamer]) await subjects.ensureUserSubject(db, u);

    const requireAuth = makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
    const requireDock = (scope) => makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken, { dockScope: scope });
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use('/oauth', oauthRoutes);
    appLinks.mount(app);
    app.get('/api/v1/me/private', requireAuth, (req, res) => res.json({ ok: true, user: req.user.username }));
    app.get('/api/v1/me/actions', requireDock('activity'), (req, res) => res.json({ ok: true }));
    app.post('/api/v1/me/actions', requireAuth, (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const authorize = async (query) => {
        const r = await fetch(`${base}/oauth/authorize?${new URLSearchParams(query)}`, { redirect: 'manual' });
        return { status: r.status, location: r.headers.get('location') || null };
    };
    const confirm = async (token, body) => {
        const r = await fetch(`${base}/oauth/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }) });
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
    const info = async (query) => {
        const r = await fetch(`${base}/oauth/client-info?${new URLSearchParams(query)}`);
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    /** A full code grant for one redirect and one person, with the verifier it must be redeemed with. */
    const grant = async (redirectUri, who = user) => {
        const v = verifier();
        const state = 'state_' + crypto.randomBytes(12).toString('hex');
        const start = await authorize({ client_id: 'link', redirect_uri: redirectUri, response_type: 'code', scope: 'profile theme', state, code_challenge: challenge(v), code_challenge_method: 'S256' });
        assert.strictEqual(start.status, 302);
        assert.match(start.location, /\/login\?/);
        const cx = await confirm(authRoutes.signToken(who, keys.privateKey, config), { client_id: 'link', redirect_uri: redirectUri, response_type: 'code', scope: 'profile theme', state, code_challenge: challenge(v), code_challenge_method: 'S256' });
        assert.strictEqual(cx.status, 200, JSON.stringify(cx.body));
        const redirect = new URL(cx.body.redirect);
        assert.strictEqual(redirect.searchParams.get('state'), state);
        const code = redirect.searchParams.get('code');
        assert.ok(code);
        const issued = await token({ grant_type: 'authorization_code', client_id: 'link', code, redirect_uri: redirectUri, code_verifier: v });
        assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
        return issued.body;
    };
    const claimsOf = (body) => jwt.decode(body.access_token);

    try {
        // ── The migration is expand only, and the client is seeded with the claimed link and the debug scheme.
        const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0050_oauth_token_session_families.sql'), 'utf8');
        assert.match(sql, /^-- phase: expand/m);
        assert.match(sql, /ADD COLUMN IF NOT EXISTS session_family/);
        assert.doesNotMatch(sql, /ADD COLUMN[^;]*NOT NULL/i);

        const client = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get('link');
        assert.ok(client, 'the link client is seeded');
        assert.strictEqual(Number(client.is_public), 1);
        assert.strictEqual(Number(client.session_token), 1);
        assert.strictEqual(client.allowed_scopes, 'profile theme');
        assert.deepStrictEqual(JSON.parse(client.redirect_uris), [APP_LINK, SCHEME]);
        assert.strictEqual(client.client_secret, null, 'a public client keeps no secret');

        // ── Claimed https redirect (RFC 8252 §7.2): assetlinks.json names the package and the env's certificates.
        delete process.env.LINK_ANDROID_CERT_SHA256;
        let links = await (await fetch(`${base}/.well-known/assetlinks.json`)).json();
        assert.deepStrictEqual(links[0].target.package_name, 'network.openvibe.link');
        assert.deepStrictEqual(links[0].target.sha256_cert_fingerprints, [], 'no release key, no claim');
        assert.deepStrictEqual(links[0].relation, ['delegate_permission/common.handle_all_urls']);
        process.env.LINK_ANDROID_CERT_SHA256 = `${PRINTS[0].toLowerCase()}, not-a-fingerprint,${PRINTS[1]}`;
        links = await (await fetch(`${base}/.well-known/assetlinks.json`)).json();
        assert.deepStrictEqual(links[0].target.sha256_cert_fingerprints, PRINTS, 'the env fingerprints, upper-cased, junk dropped');

        // ── /link/auth is the plain page a browser gets when no installed app could claim it.
        const page = await fetch(`${base}/link/auth?code=SECRET_CODE&state=s`);
        assert.strictEqual(page.status, 200);
        assert.match(page.headers.get('x-robots-tag') || '', /noindex/);
        const html = await page.text();
        assert.match(html, /Open this in OpenVibe Link/);
        assert.doesNotMatch(html, /SECRET_CODE/, 'the page never echoes the code');

        // ── Consent is always shown: client-info says what it does, and prompt=none is refused, never silent.
        const linkInfo = await info({ client_id: 'link', redirect_uri: APP_LINK, scope: 'profile theme' });
        assert.strictEqual(linkInfo.status, 200);
        assert.strictEqual(linkInfo.body.act_as_you, true);
        assert.match(linkInfo.body.consent_text, /act as you/);
        assert.match(linkInfo.body.consent_text, /approvals/);
        const companionInfo = await info({ client_id: 'companion', redirect_uri: 'https://bjcjcfcecpkkmfndegkjekoipdmbgakd.chromiumapp.org/', scope: 'dock' });
        assert.strictEqual(companionInfo.status, 200);
        assert.strictEqual(companionInfo.body.act_as_you, undefined, 'the extension reads; it does not act as you');
        const silent = await authorize({ client_id: 'link', redirect_uri: APP_LINK, response_type: 'code', scope: 'profile theme', state: 's0', prompt: 'none', code_challenge: challenge(verifier()), code_challenge_method: 'S256' });
        assert.strictEqual(silent.status, 302);
        assert.match(silent.location, /^https:\/\/openvibe\.network\/link\/auth\?/);
        assert.match(silent.location, /error=interaction_required/);
        assert.doesNotMatch(silent.location, /code=/, 'no code without the chooser');

        // ── Public client rules still hold: exact redirect, state, PKCE S256, a scope inside the ceiling.
        assert.strictEqual((await authorize({ client_id: 'link', redirect_uri: APP_LINK, response_type: 'code', scope: 'profile theme' })).status, 400, 'state required');
        assert.strictEqual((await authorize({ client_id: 'link', redirect_uri: APP_LINK, response_type: 'code', state: 's', scope: 'profile theme' })).status, 400, 'PKCE required');
        assert.strictEqual((await authorize({ client_id: 'link', redirect_uri: APP_LINK, response_type: 'code', state: 's', scope: 'dock', code_challenge: challenge(verifier()), code_challenge_method: 'S256' })).status, 400, 'scope ceiling');
        assert.strictEqual((await authorize({ client_id: 'link', redirect_uri: 'openvibe-link://other', response_type: 'code', state: 's', scope: 'theme', code_challenge: challenge(verifier()), code_challenge_method: 'S256' })).status, 400, 'exact redirect');

        // ── The custom scheme gets the read-only Dock token, even with certificates published: any app can claim it.
        process.env.LINK_ANDROID_CERT_SHA256 = PRINTS.join(',');
        const viaScheme = await grant(SCHEME);
        let claims = claimsOf(viaScheme);
        assert.strictEqual(claims.iss, `${ISSUER}/dock`, 'the private issuer: no normal user-token check takes it');
        assert.ok(claims.aud.includes('openvibe.chat'));
        assert.strictEqual(claims.role, undefined, 'a Dock token carries no role');
        assert.strictEqual(claims.staff_caps, undefined);
        assert.strictEqual(claims.client_id, 'link');
        assert.ok(claims.fam);
        assert.strictEqual((await api('GET', '/api/v1/me/private', viaScheme.access_token)).status, 401, 'not a session');

        // ── The claimed https link with NO published certificate: Dock too. Android verified nothing.
        delete process.env.LINK_ANDROID_CERT_SHA256;
        const unverified = await grant(APP_LINK);
        assert.strictEqual(claimsOf(unverified).iss, `${ISSUER}/dock`);
        assert.strictEqual(claimsOf(unverified).role, undefined);

        // ── The claimed https link WITH a certificate: the person's own session.
        process.env.LINK_ANDROID_CERT_SHA256 = PRINTS.join(',');
        const session = await grant(APP_LINK);
        claims = claimsOf(session);
        assert.strictEqual(session.expires_in, 86400);
        assert.strictEqual(claims.iss, ISSUER, 'the normal issuer');
        assert.ok(claims.aud.includes('openvibe.network'), 'the normal audiences');
        assert.strictEqual(claims.role, 'user');
        assert.strictEqual(claims.client_id, 'link');
        assert.strictEqual(claims.scope, 'profile theme');
        assert.ok(claims.fam, 'the family, so the account page can end it');
        assert.strictEqual(claims.is_owner, undefined);
        assert.strictEqual(claims.staff_caps, undefined, 'a session token carries no staff claims');
        assert.strictEqual(claims.typ, undefined);
        assert.strictEqual((await api('GET', '/api/v1/me/actions', session.access_token)).status, 200);
        assert.strictEqual((await api('POST', '/api/v1/me/actions', session.access_token)).status, 200, 'answering an approval');
        assert.strictEqual((await api('GET', '/api/v1/me/private', session.access_token)).status, 200, 'a plain user token');
        assert.strictEqual((await api('GET', '/api/v1/me/private', 'nope')).status, 401);

        // ── A staff member's phone acts as a user: role capped, no staff claims. A non-staff role is kept.
        const adminSession = claimsOf(await grant(APP_LINK, admin));
        assert.strictEqual(adminSession.role, 'user', "an admin's phone is not an admin");
        assert.strictEqual(adminSession.staff_caps, undefined);
        assert.strictEqual(adminSession.is_owner, undefined);
        assert.strictEqual(claimsOf(await grant(APP_LINK, streamer)).role, 'streamer', 'a streamer is not staff');
        assert.strictEqual(claimsOf(await grant(APP_LINK, streamer)).staff_caps, undefined);

        // ── A refresh keeps its family's kind: Dock stays Dock, session stays session (while a certificate is published).
        const dockRefresh = await token({ grant_type: 'refresh_token', client_id: 'link', refresh_token: viaScheme.refresh_token });
        assert.strictEqual(dockRefresh.status, 200, JSON.stringify(dockRefresh.body));
        assert.strictEqual(claimsOf(dockRefresh.body).iss, `${ISSUER}/dock`, 'a scheme family never becomes a session');
        assert.notStrictEqual(dockRefresh.body.refresh_token, viaScheme.refresh_token, 'rotated');

        const sessionRefresh = await token({ grant_type: 'refresh_token', client_id: 'link', refresh_token: session.refresh_token });
        assert.strictEqual(sessionRefresh.status, 200, JSON.stringify(sessionRefresh.body));
        assert.strictEqual(claimsOf(sessionRefresh.body).iss, ISSUER);
        assert.strictEqual(claimsOf(sessionRefresh.body).role, 'user');
        assert.strictEqual(claimsOf(sessionRefresh.body).staff_caps, undefined);
        assert.strictEqual((await token({ grant_type: 'refresh_token', client_id: 'link', refresh_token: session.refresh_token })).status, 400, 'the old refresh token is spent');

        // Withdrawing the certificate stops sessions at the next refresh; the family cannot promote itself back.
        delete process.env.LINK_ANDROID_CERT_SHA256;
        const downgraded = await token({ grant_type: 'refresh_token', client_id: 'link', refresh_token: sessionRefresh.body.refresh_token });
        assert.strictEqual(downgraded.status, 200, JSON.stringify(downgraded.body));
        assert.strictEqual(claimsOf(downgraded.body).iss, `${ISSUER}/dock`, 'no certificate, no session');

        // ── A wrong verifier is refused (and spent, as the flow requires).
        const v2 = verifier();
        await authorize({ client_id: 'link', redirect_uri: APP_LINK, response_type: 'code', scope: 'profile theme', state: 's2', code_challenge: challenge(v2), code_challenge_method: 'S256' });
        const cx2 = await confirm(authRoutes.signToken(user, keys.privateKey, config), { client_id: 'link', redirect_uri: APP_LINK, response_type: 'code', scope: 'profile theme', state: 's2', code_challenge: challenge(v2), code_challenge_method: 'S256' });
        const code2 = new URL(cx2.body.redirect).searchParams.get('code');
        assert.strictEqual((await token({ grant_type: 'authorization_code', client_id: 'link', code: code2, redirect_uri: APP_LINK, code_verifier: verifier() })).status, 400, 'a wrong verifier is refused');
    } finally {
        delete process.env.LINK_ANDROID_CERT_SHA256;
        await new Promise((r) => server.close(r));
        console.log = quiet;
    }
    console.log('oauth link: all passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
