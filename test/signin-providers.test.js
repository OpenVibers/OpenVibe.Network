'use strict';
// Sign in with anything (plan §AB.20, wave 1): the provider layer against RECORDED provider answers — no test ever
// reaches the network. Covers:
//   · state: a tampered callback, an expired state and a replayed state all refuse, and no session is set;
//   · id_token: a wrong issuer, a wrong audience and a wrong nonce refuse (and an unsigned/HS token does too);
//   · a linked identity signs its person in; a new identity makes a new account;
//   · a verified email that matches an existing account never links or merges silently;
//   · link and unlink rules, including "never the last way in";
//   · Steam's OpenID 2.0 assertion verified server-side (a forged claimed_id is refused);
//   · every first-wave preset maps a recorded profile into the one identity shape.
//   node --import ./test/helpers/pg-preload.mjs test/signin-providers.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { getDb } = require('../server/db/database');
const authRoutes = require('../server/auth/routes');
const { makeRequireAuth } = require('../server/auth/session');
const providers = require('../server/auth/providers/routes');
const presets = require('../server/auth/providers/presets');
const configNs = require('../server/auth/providers/config');
const oidc = require('../server/auth/providers/oidc');
const oauth2 = require('../server/auth/providers/oauth2');
const openid2 = require('../server/auth/providers/openid2');
const { appleClientSecret } = require('../server/auth/providers/apple');

const ISSUER = 'https://openvibe.network';
const BASE = ISSUER;

/** The keys the fake providers sign with, and the JWKS they publish. */
const keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KID = 'test-key-1';
const jwk = (() => { const j = crypto.createPublicKey(keys.publicKey).export({ format: 'jwk' }); j.kid = KID; j.use = 'sig'; j.alg = 'RS256'; return j; })();

/** A small cookie jar: the browser keeps the state cookie between the start and the callback. */
function jar() {
    const cookies = new Map();
    return {
        header() { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; '); },
        absorb(res) {
            const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
            for (const line of raw) {
                const [pair] = String(line).split(';');
                const at = pair.indexOf('=');
                const name = pair.slice(0, at).trim();
                const value = pair.slice(at + 1).trim();
                if (!value || /expires=Thu, 01 Jan 1970/i.test(line)) cookies.delete(name); else cookies.set(name, value);
            }
        },
        clear() { cookies.clear(); },
    };
}

(async () => {
    const db = getDb();
    const quiet = console.log; console.log = () => {};

    // A sealing KEK, as production has: the shared store seals every secret-class value.
    process.env.OV_CONFIG_KEKS = `k1:${crypto.randomBytes(32).toString('base64')}`;
    process.env.OV_CONFIG_KEK_CURRENT = 'k1';

    const config = { baseUrl: BASE, loginUrl: BASE, jwt: { issuer: ISSUER, accessTokenExpiry: '1h', refreshExpiry: '30d' } };

    // ── Recorded provider answers, keyed by URL (path + query prefix) ──
    const routes = new Map();
    const calls = [];
    const fakeFetch = async (url, opts = {}) => {
        const href = String(url);
        calls.push({ url: href, method: opts.method || 'GET' });
        for (const [prefix, answer] of routes) {
            if (!href.startsWith(prefix)) continue;
            const a = typeof answer === 'function' ? await answer(href, opts) : answer;
            if (a instanceof Response) return a;
            if (typeof a === 'string') return new Response(a, { status: 200, headers: { 'content-type': 'text/plain' } });
            return new Response(JSON.stringify(a.body === undefined ? a : a.body), { status: (a && a.status) || 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`the test has no recorded answer for ${href}`);
    };

    const discovery = (issuer, tokenUrl) => ({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenUrl || `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
    });
    const jwks = { keys: [jwk] };
    const signIdToken = (claims) => jwt.sign(claims, keys.privateKey, { algorithm: 'RS256', keyid: KID });

    // Every OIDC preset's recorded documents.
    for (const p of presets.PROVIDERS.filter((x) => x.kind === 'oidc')) {
        const issuer = p.issuer || p.discoveryIssuer;
        routes.set(`${issuer}/.well-known/openid-configuration`, discovery(issuer));
        routes.set(`${issuer}/jwks`, jwks);
    }
    routes.set('https://appleid.apple.com/.well-known/openid-configuration', discovery('https://appleid.apple.com'));
    routes.set('https://appleid.apple.com/jwks', jwks);
    // Microsoft's document is the common one; the token names its tenant.
    routes.set('https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration', {
        ...discovery('https://login.microsoftonline.com/{tenantid}/v2.0', 'https://login.microsoftonline.com/common/oauth2/v2.0/token'),
    });

    // OAuth2 presets: a token answer and a profile answer.
    const oauthProfiles = {
        github: { token: { access_token: 'gh-token', token_type: 'bearer' }, profile: { id: 4242, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.test/octo.png' }, emails: [{ email: 'octo@github.test', primary: true, verified: true }, { email: 'other@github.test', primary: false, verified: true }] },
        kick: { token: { access_token: 'kick-token' }, profile: { data: [{ user_id: 77, name: 'Kicky', profile_picture: 'https://files.kick.test/k.png', email: 'kick@kick.test' }] } },
        x: { token: { access_token: 'x-token' }, profile: { data: { id: '9', name: 'Ex', username: 'exy', profile_image_url: 'https://pbs.x.test/e.jpg', verified: true } } },
    };
    routes.set('https://github.com/login/oauth/access_token', () => oauthProfiles.github.token);
    routes.set('https://api.github.com/user/emails', () => oauthProfiles.github.emails);
    routes.set('https://api.github.com/user', () => oauthProfiles.github.profile);
    routes.set('https://id.kick.com/oauth/token', () => oauthProfiles.kick.token);
    routes.set('https://api.kick.com/public/v1/users', () => oauthProfiles.kick.profile);
    routes.set('https://api.x.com/2/oauth2/token', () => oauthProfiles.x.token);
    routes.set('https://api.x.com/2/users/me', () => oauthProfiles.x.profile);
    // Steam's check_authentication: a POST answers is_valid:true; a summary read answers a player.
    let steamValid = 'true';
    routes.set('https://steamcommunity.com/openid/login', () => `ns:http://specs.openid.net/auth/2.0\nis_valid:${steamValid}\n`);
    routes.set('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/', { response: { players: [{ personaname: 'Steamy', avatarfull: 'https://avatars.steam.test/s.jpg' }] } });

    // ── The owner's keys, in the sign-in namespace ──
    const store = await configNs.forDb(db, BASE);
    const setKey = async (key, value, { secret = false } = {}) => {
        if (secret) await store.setSecret(key, value, { actor: { type: 'service', id: 'network' }, reason: 'test' });
        else await store.apply({ [key]: value }, { merge: true, actor: { type: 'service', id: 'network' }, reason: 'test' });
    };
    await setKey('google.client_id', 'google-client');
    await setKey('google.client_secret', 'google-secret', { secret: true });
    await setKey('discord.client_id', 'discord-client');
    await setKey('discord.client_secret', 'discord-secret', { secret: true });
    await setKey('github.client_id', 'github-client');
    await setKey('github.client_secret', 'github-secret', { secret: true });
    await setKey('kick.client_id', 'kick-client');
    await setKey('kick.client_secret', 'kick-secret', { secret: true });
    await setKey('x.client_id', 'x-client');
    await setKey('twitch.client_id', 'twitch-client');
    await setKey('twitch.client_secret', 'twitch-secret', { secret: true });
    await setKey('roblox.client_id', 'roblox-client');
    await setKey('roblox.client_secret', 'roblox-secret', { secret: true });
    await setKey('facebook.client_id', 'facebook-client');
    await setKey('facebook.client_secret', 'facebook-secret', { secret: true });
    await setKey('microsoft.client_id', 'microsoft-client');
    await setKey('microsoft.client_secret', 'microsoft-secret', { secret: true });
    const MS_TENANT = '11111111-2222-3333-4444-555555555555';
    await setKey('microsoft.tenant', MS_TENANT);

    // ── People, one of them with a linked identity and an address ──
    const addUser = async (id, username, { email = null, password = 'x', verified = 0 } = {}) => {
        await db.prepare('INSERT INTO users (id, username, email, password_hash, display_name, role, email_verified) VALUES (?, ?, ?, ?, ?, \'user\', ?)')
            .run(id, username, email, password, username, verified);
        return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    };
    const alice = await addUser(11, 'aliceprov', { email: 'alice@example.test', verified: 1, password: providers.NO_PASSWORD });
    await addUser(12, 'bobyprov');
    await db.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (11, 'google', 'google-sub-1', 'alice')").run();

    // ── The app under test: the real router, the real session guard and token minter ──
    const requireAuth = makeRequireAuth(async () => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(require('cookie-parser')());
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    const signIn = providers.createRouter({
        requireAuth, signToken: authRoutes.signToken, config, fetch: fakeFetch, log: { info() {}, warn() {}, error() {} },
    });
    app.use('/api/auth/connect', signIn.router);
    app.use('/api/auth/discord', signIn.discordAlias);
    app.get('/api/v1/me', requireAuth, (req, res) => res.json({ ok: true, username: req.user.username }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const c = jar();
    const get = (path, { cookies = c } = {}) => fetch(base + path, { redirect: 'manual', headers: { cookie: cookies.header() } }).then(async (r) => { cookies.absorb(r); return { status: r.status, location: r.headers.get('location'), text: await r.text() }; });
    const post = (path, body, { cookies = c } = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { cookie: cookies.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => { cookies.absorb(r); return { status: r.status, location: r.headers.get('location'), text: await r.text() }; });
    const me = async () => { const token = (c.header().match(/ov_token=([^;]+)/) || [])[1]; if (!token) return null; const r = await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } }); return r.ok ? await r.json() : null; };
    const callbackQ = (q) => `?${new URLSearchParams(q)}`;
    const stateOf = (location) => new URL(location).searchParams.get('state');

    try {
        // ── The list the sign-in page draws: only configured providers, most used first ──
        let r = await get('/api/auth/connect');
        let listed = JSON.parse(r.text).providers;
        assert.deepStrictEqual(listed.map((p) => p.id), ['google', 'discord', 'steam', 'twitch', 'github', 'microsoft', 'kick', 'x', 'roblox', 'facebook'],
            'Google first, Steam (no keys needed) and the rest, and no Apple until its four fields are set');
        assert.deepStrictEqual(listed[0].icon, { brand: 'google' }, 'each button carries its brand glyph');

        // ── Microsoft: a tenant the owner named goes into the authorize URL, not just the issuer check ──
        c.clear();
        r = await get('/api/auth/connect/microsoft?return=%2Fmy');
        assert.strictEqual(r.status, 302, r.text);
        assert.ok(r.location.startsWith(`https://login.microsoftonline.com/${MS_TENANT}/`), `the tenant replaces {tenantid} in the endpoint too (${r.location})`);
        assert.ok(!/\/(common|organizations|consumers)\//.test(r.location) && !r.location.includes('{tenantid}'), 'and nothing common or templated is left');

        // ── A start: state cookie, PKCE S256, nonce, and the redirect to the provider ──
        r = await get('/api/auth/connect/google?return=%2Fmy');
        assert.strictEqual(r.status, 302);
        const started = new URL(r.location);
        assert.strictEqual(started.origin, 'https://accounts.google.com');
        assert.strictEqual(started.searchParams.get('code_challenge_method'), 'S256');
        assert.ok(started.searchParams.get('code_challenge'), 'a PKCE challenge is sent');
        assert.ok(started.searchParams.get('nonce'), 'a nonce is sent');
        assert.strictEqual(started.searchParams.get('redirect_uri'), `${BASE}/api/auth/connect/google/callback`);
        const state1 = started.searchParams.get('state');
        assert.ok(c.header().includes('__Host-ov_signin'), 'the state travels in a host-only cookie too');

        // ── Tampering: a different state than the cookie's — refused, no session ──
        c.clear();
        await get('/api/auth/connect/google?return=%2Fmy');
        r = await get(`/api/auth/connect/google/callback${callbackQ({ code: 'c1', state: 'not-the-cookie' })}`);
        assert.strictEqual(r.status, 302);
        assert.match(r.location, /error=state_mismatch/);
        assert.strictEqual(await me(), null, 'a tampered callback signs nobody in');

        // ── Expired state: the row is past its ten minutes — refused ──
        c.clear();
        r = await get('/api/auth/connect/google?return=%2Fmy');
        const stateExpired = stateOf(r.location);
        await db.prepare("UPDATE signin_states SET expires_at = now() - interval '1 second' WHERE state_hash = ?").run(crypto.createHash('sha256').update(stateExpired).digest('hex'));
        r = await get(`/api/auth/connect/google/callback${callbackQ({ code: 'c2', state: stateExpired })}`);
        assert.match(r.location, /error=state_expired/, 'a state older than ten minutes is refused');

        // ── Replayed state: one use only, even when the cookie is still there ──
        c.clear();
        r = await get('/api/auth/connect/google?return=%2Fmy');
        const stateReplay = stateOf(r.location);
        const idTokenFor = (over = {}) => signIdToken({ iss: 'https://accounts.google.com', aud: 'google-client', sub: 'google-sub-1', nonce: new URL(r.location).searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), email: 'alice@example.test', email_verified: true, name: 'Alice', ...over });
        routes.set('https://accounts.google.com/token', { id_token: idTokenFor(), access_token: 'at', token_type: 'Bearer' });
        r = await get(`/api/auth/connect/google/callback${callbackQ({ code: 'c3', state: stateReplay })}`);
        assert.strictEqual(r.status, 302);
        assert.ok(!/error=/.test(r.location), `a good answer signs in (${r.location})`);
        assert.ok(await me(), 'the linked identity signed its person in');
        c.clear();
        // The same state again: the row is gone, so not even a fresh cookie helps.
        r = await get(`/api/auth/connect/google/callback${callbackQ({ code: 'c4', state: stateReplay })}`, { cookies: (() => { const j = jar(); return j; })() });
        assert.match(r.location, /error=state_(expired|mismatch)/, 'a replayed state is refused: one use only');

        // ── id_token checks: wrong issuer, wrong audience, wrong nonce, an unsigned token ──
        const attempt = async (over, label) => {
            c.clear();
            const s = await get('/api/auth/connect/google?return=%2Fmy');
            const nonce = new URL(s.location).searchParams.get('nonce');
            routes.set('https://accounts.google.com/token', { id_token: idTokenFor({ nonce, ...over }), access_token: 'at', token_type: 'Bearer' });
            const out = await get(`/api/auth/connect/google/callback${callbackQ({ code: 'cx', state: stateOf(s.location) })}`);
            assert.match(out.location, /error=id_token_/, `${label}: refused with an id_token_ code (${out.location})`);
            assert.strictEqual(await me(), null, `${label}: no session`);
        };
        await attempt({ iss: 'https://evil.example' }, 'a wrong issuer');
        await attempt({ aud: 'someone-else' }, 'a wrong audience');
        await attempt({ nonce: 'not-the-nonce' }, 'a wrong nonce');

        // The verifier itself: an HS256 token is refused whatever the metadata says.
        const meta = { issuer: 'https://accounts.google.com', jwks_uri: 'https://accounts.google.com/jwks', id_token_signing_alg_values_supported: ['RS256'] };
        const hs = jwt.sign({ iss: 'https://accounts.google.com', aud: 'google-client', sub: 'x', exp: Math.floor(Date.now() / 1000) + 60 }, 'a-shared-secret', { algorithm: 'HS256' });
        await assert.rejects(
            oidc.verifyIdToken({ token: hs, meta, provider: 'google', clientId: 'google-client', nonce: 'n', fetch: fakeFetch }),
            (err) => err.code === 'id_token_alg', 'an HS256 id_token is refused');

        // ── A sign-in started for an app goes back through /login with its query, marked for the page to continue ──
        c.clear();
        const appQuery = 'client_id=openvibe.live&redirect_uri=https%3A%2F%2Fopenvibe.live%2Fauth%2Fcallback&response_type=code&scope=openid+profile&state=xyz';
        r = await get(`/api/auth/connect/google?app=${encodeURIComponent(appQuery)}`);
        const appState = stateOf(r.location);
        routes.set('https://accounts.google.com/token', { id_token: idTokenFor({ nonce: new URL(r.location).searchParams.get('nonce') }), access_token: 'at', token_type: 'Bearer' });
        r = await get(`/api/auth/connect/google/callback${callbackQ({ code: 'app1', state: appState })}`);
        assert.match(r.location, /^https:\/\/openvibe\.network\/login\?/, 'an app sign-in lands on the sign-in page');
        assert.match(r.location, /signed_in=1/, 'marked so the page continues for the app');
        assert.match(r.location, /client_id=openvibe\.live/, 'with the app\'s own query intact');

        // ── A new identity makes a NEW account, with the provider's picture and no password ──
        c.clear();
        r = await get('/api/auth/connect/github?return=%2Fmy');
        const ghState = stateOf(r.location);
        routes.set('https://github.com/login/oauth/access_token', { access_token: 'gh-token', token_type: 'bearer' });
        r = await get(`/api/auth/connect/github/callback${callbackQ({ code: 'gh1', state: ghState })}`);
        assert.ok(!/error=/.test(r.location), `a first GitHub sign-in makes an account (${r.location})`);
        const octo = await db.prepare("SELECT * FROM users WHERE username = 'octo'").get();
        assert.ok(octo, 'the username comes from the provider handle');
        assert.strictEqual(octo.password_hash, providers.NO_PASSWORD, 'no password, the existing "not a password" sentinel');
        assert.strictEqual(octo.email, 'octo@github.test', 'the verified primary address is stored');
        assert.strictEqual(Number(octo.email_verified), 1, 'and it is marked verified, because GitHub said so');
        assert.strictEqual(octo.avatar_url, 'https://avatars.test/octo.png', 'the picture comes from the provider');
        const ghLink = await db.prepare("SELECT * FROM linked_accounts WHERE service = 'github' AND service_user_id = '4242'").get();
        assert.strictEqual(Number(ghLink.user_id), Number(octo.id), 'and the identity is linked');

        // ── A verified email that matches an existing account: no silent merge, no duplicate ──
        c.clear();
        r = await get('/api/auth/connect/github?return=%2Fmy');
        routes.set('https://api.github.com/user', { id: 5151, login: 'alice-gh', name: 'Alice GH', avatar_url: null });
        routes.set('https://api.github.com/user/emails', [{ email: 'alice@example.test', primary: true, verified: true }]);
        r = await get(`/api/auth/connect/github/callback${callbackQ({ code: 'gh2', state: stateOf(r.location) })}`);
        assert.match(r.location, /error=email_taken/, 'a matching verified address asks the person to use their account');
        assert.match(r.location, /email=alice%40example\.test/, 'and names the address, in the page only');
        const beforeAlice = await db.prepare("SELECT COUNT(*) AS n FROM linked_accounts WHERE service = 'github'").get();
        assert.strictEqual(Number(beforeAlice.n), 1, 'nothing was linked to the existing account');
        assert.strictEqual(await db.prepare("SELECT id FROM users WHERE username = 'alice_gh'").get(), undefined, 'and no duplicate was created');
        assert.strictEqual(await me(), null, 'nobody was signed in');

        // ── Linking a new identity to the signed-in person ──
        const token = jwt.sign({ sub: alice.id, id: alice.id, username: alice.username, subject_id: alice.subject_id, role: 'user' }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
        const signedIn = jar(); signedIn.absorb({ headers: { getSetCookie: () => [`ov_token=${token}; Path=/`] } });
        r = await get('/api/auth/connect/github?mode=link', { cookies: signedIn });
        assert.strictEqual(r.status, 302);
        routes.set('https://api.github.com/user', { id: 5151, login: 'alice-gh', name: 'Alice GH', avatar_url: null });
        r = await get(`/api/auth/connect/github/callback${callbackQ({ code: 'gh3', state: stateOf(r.location) })}`, { cookies: signedIn });
        assert.match(r.location, /linked=github&result=success/, 'the identity is attached to the signed-in account');
        const aliceLinks = await db.prepare('SELECT service FROM linked_accounts WHERE user_id = ? ORDER BY service').all(alice.id);
        assert.deepStrictEqual(aliceLinks.map((x) => x.service), ['github', 'google']);

        // The same GitHub identity on someone else's session: explained, never moved.
        await addUser(13, 'carolprov');
        const carol = await db.prepare('SELECT * FROM users WHERE id = 13').get();
        const carolToken = jwt.sign({ sub: carol.id, id: carol.id, username: carol.username, subject_id: carol.subject_id, role: 'user' }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
        const carolJar = jar(); carolJar.absorb({ headers: { getSetCookie: () => [`ov_token=${carolToken}; Path=/`] } });
        r = await get('/api/auth/connect/github?mode=link', { cookies: carolJar });
        r = await get(`/api/auth/connect/github/callback${callbackQ({ code: 'gh4', state: stateOf(r.location) })}`, { cookies: carolJar });
        assert.match(r.location, /result=already_linked_other/, 'an identity linked elsewhere is a plain answer');
        assert.strictEqual(Number((await db.prepare("SELECT user_id FROM linked_accounts WHERE service = 'github' AND service_user_id = '5151'").get()).user_id), Number(alice.id), 'and it stays where it was');

        // ── Unlink: never the last way in ──
        const del = (path, j) => fetch(base + path, { method: 'DELETE', headers: { cookie: j.header(), authorization: `Bearer ${(j.header().match(/ov_token=([^;]+)/) || [])[1]}` } }).then(async (x) => ({ status: x.status, body: await x.json() }));
        // Alice has no password (sentinel) and two providers: removing one leaves the other, so it is allowed.
        let out = await del('/api/auth/connect/github/link', signedIn);
        assert.strictEqual(out.status, 200, JSON.stringify(out.body));
        // Now Google is her only way in: removing it is refused.
        out = await del('/api/auth/connect/google/link', signedIn);
        assert.strictEqual(out.status, 409);
        assert.strictEqual(out.body.code, 'last_way_in');

        // A site's own linked row (Live, or the code exchange's `network:<id>`) is not a way in: with one provider
        // left, it must not make the unlink look safe.
        await db.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (11, 'live', 'network:11', 'aliceprov')").run();
        out = await del('/api/auth/connect/google/link', signedIn);
        assert.strictEqual(out.status, 409, 'a site row does not count as another way in');
        await db.prepare("DELETE FROM linked_accounts WHERE user_id = 11 AND service = 'live'").run();

        // A person with a password may remove their only provider.
        const bob = await db.prepare("SELECT * FROM users WHERE username = 'bobyprov'").get();
        await db.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (12, 'discord', 'discord-1', 'bob')").run();
        const bobToken = jwt.sign({ sub: bob.id, id: bob.id, username: bob.username, subject_id: bob.subject_id, role: 'user' }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
        const bobJar = jar(); bobJar.absorb({ headers: { getSetCookie: () => [`ov_token=${bobToken}; Path=/`] } });
        out = await del('/api/auth/connect/discord/link', bobJar);
        assert.strictEqual(out.status, 200);

        // ── Steam: the assertion is verified server-side; a forged one is refused ──
        c.clear();
        r = await get('/api/auth/connect/steam?return=%2Fmy');
        const steamRedirect = new URL(r.location);
        assert.strictEqual(steamRedirect.origin, 'https://steamcommunity.com');
        assert.strictEqual(steamRedirect.searchParams.get('openid.mode'), 'checkid_setup');
        // The state comes back inside openid.return_to, not as its own parameter.
        const steamState = new URL(steamRedirect.searchParams.get('openid.return_to')).searchParams.get('state');
        const assertion = {
            'openid.mode': 'id_res',
            'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
            'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
            'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
            'openid.return_to': `${BASE}/api/auth/connect/steam/callback?state=${encodeURIComponent(steamState)}`,
            'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
            'openid.response_nonce': '2026-11-14T00:00:00Zabc',
            'openid.assoc_handle': '1234567890',
            'openid.sig': 'not-checked-here',
            'state': steamState,
        };
        // Steam says the assertion is not valid: refused.
        steamValid = 'false';
        r = await get(`/api/auth/connect/steam/callback${callbackQ(assertion)}`);
        assert.match(r.location, /error=openid_invalid/, 'a check_authentication answer of is_valid:false is refused');
        // The forged shape (a claimed_id but no valid assertion) is refused too.
        steamValid = 'true';
        c.clear();
        r = await get('/api/auth/connect/steam?return=%2Fmy');
        const forgedState = new URL(new URL(r.location).searchParams.get('openid.return_to')).searchParams.get('state');
        const forged = { ...assertion, state: forgedState, 'openid.return_to': `${BASE}/api/auth/connect/steam/callback?state=${encodeURIComponent(forgedState)}` };
        r = await get(`/api/auth/connect/steam/callback${callbackQ({ ...forged, 'openid.mode': 'cancel' })}`);
        assert.match(r.location, /error=/, 'a bare redirect is not a proof');
        // A good assertion signs in and makes the account, with Steam's name when the Web API key is set.
        await setKey('steam.api_key', 'steam-api-key', { secret: true });
        c.clear();
        r = await get('/api/auth/connect/steam?return=%2Fmy');
        const goodState = new URL(new URL(r.location).searchParams.get('openid.return_to')).searchParams.get('state');
        const good = { ...assertion, state: goodState, 'openid.return_to': `${BASE}/api/auth/connect/steam/callback?state=${encodeURIComponent(goodState)}` };
        r = await get(`/api/auth/connect/steam/callback${callbackQ(good)}`);
        assert.ok(!/error=/.test(r.location), `a verified Steam assertion signs in (${r.location})`);
        const steamy = await db.prepare("SELECT * FROM users WHERE lower(username) = 'steamy'").get();
        assert.ok(steamy, 'a Steam identity makes an account from the persona name');
        assert.strictEqual(steamy.email, null, 'Steam gives no email, ever');
        assert.strictEqual(steamy.password_hash, providers.NO_PASSWORD);

        // ── Each preset maps a recorded profile into the one identity shape ──
        const mapped = {
            google: presets.BY_ID.get('google').map({ sub: 'g1', name: 'G Person', picture: 'https://p/g.png', email: 'g@x.test', email_verified: true }),
            discord: presets.BY_ID.get('discord').map({ sub: 'd1', username: 'dperson', global_name: 'D Person', avatar_url: 'https://p/d.png', email: null, verified: false }),
            twitch: presets.BY_ID.get('twitch').map({ sub: 't1', preferred_username: 'tperson', picture: 'https://p/t.png', email: 't@x.test', email_verified: true }),
            apple: presets.BY_ID.get('apple').map({ sub: 'a1', email: 'relay@privaterelay.appleid.com', email_verified: 'true', name: 'A Person' }),
            microsoft: presets.BY_ID.get('microsoft').map({ sub: 'p1', oid: 'm1', name: 'M Person', preferred_username: 'm@x.test', email_verified: true }),
            roblox: presets.BY_ID.get('roblox').map({ sub: 'r1', nickname: 'R Person', preferred_username: 'rperson', picture: 'https://p/r.png', email: 'r@x.test', email_verified: true }),
            facebook: presets.BY_ID.get('facebook').map({ sub: 'f1', name: 'F Person', email: 'f@x.test' }),
        };
        for (const [id, got] of Object.entries(mapped)) {
            assert.ok(got.provider_user_id, `${id}: a stable id`);
            assert.ok(got.display_name, `${id}: a display name`);
            assert.ok('email' in got && typeof got.email_verified === 'boolean', `${id}: an email and its flag, always`);
        }
        assert.strictEqual(mapped.discord.email, null, 'Discord without an email is "no email", never an error');
        assert.strictEqual(mapped.discord.email_verified, false);
        assert.strictEqual(mapped.apple.email, 'relay@privaterelay.appleid.com', 'Apple private-relay addresses are legitimate');
        assert.strictEqual(mapped.apple.email_verified, true, 'Apple says "true" as a string');
        assert.strictEqual(mapped.facebook.email_verified, false, 'Facebook has no verified flag');

        // OAuth2 presets: the mapper, from their recorded profile.
        for (const [id, recorded] of Object.entries(oauthProfiles)) {
            const p = presets.BY_ID.get(id);
            routes.set(p.profile.startsWith('https://api.x.com') ? 'https://api.x.com/2/users/me' : p.profile, recorded.profile);
            if (p.emails) routes.set(p.emails, recorded.emails);
            const got = await oauth2.profile({ provider: p, values: { client_id: 'x', client_secret: 'y' }, token: { access_token: 't' }, fetch: fakeFetch });
            assert.ok(got.provider_user_id && got.display_name, `${id}: mapped`);
            if (id === 'github') {
                assert.strictEqual(got.email, 'octo@github.test', 'GitHub: the primary verified address');
                assert.strictEqual(got.email_verified, true);
                assert.strictEqual(got.username, 'octo');
            }
            if (id === 'kick') assert.strictEqual(got.email_verified, false, 'Kick sends no verified flag: never proof');
            if (id === 'x') assert.strictEqual(got.username, 'exy');
        }

        // ── Apple's derived client secret is an ES256 JWT with the right claims ──
        const p8 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
        const secret = appleClientSecret({ values: { services_id: 'network.signin', team_id: 'TEAM123456', key_id: 'KEY1234567', private_key: p8 } });
        assert.ok(secret, 'a valid .p8 mints the client secret');
        const decoded = jwt.decode(secret, { complete: true });
        assert.strictEqual(decoded.header.alg, 'ES256');
        assert.strictEqual(decoded.header.kid, 'KEY1234567');
        assert.strictEqual(decoded.payload.iss, 'TEAM123456');
        assert.strictEqual(decoded.payload.sub, 'network.signin');
        assert.strictEqual(decoded.payload.aud, 'https://appleid.apple.com');
        assert.ok(decoded.payload.exp - decoded.payload.iat <= 15777000, 'Apple caps the life at six months');

        // ── Microsoft's templated issuer: resolved from the token's tenant, never compared to "common" ──
        const msMeta = { issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' };
        const tid = '11111111-2222-3333-4444-555555555555';
        assert.strictEqual(oidc.expectedIssuer(msMeta, 'microsoft', { tid }), `https://login.microsoftonline.com/${tid}/v2.0`);
        assert.strictEqual(oidc.expectedIssuer(msMeta, 'microsoft', {}), null, 'a token with no tenant is refused');

        // ── The owner's verify is owner only (it makes an outbound call and names endpoints) ──
        r = await fetch(`${base}/api/auth/connect/google/verify`, { headers: { authorization: `Bearer ${token}` } });
        assert.strictEqual(r.status, 403, 'a signed-in person who is not the owner cannot make the provider call');

        // ── Every start/link/sign-in left an audit row with no token or secret in it ──
        const audits = await db.prepare("SELECT action, details FROM audit_log WHERE action LIKE 'signin%'").all();
        assert.ok(audits.length >= 6, 'sign-ins and links are audited');
        for (const a of audits) {
            assert.ok(!/google-secret|discord-secret|github-token|at\b/.test(a.details || ''), `no token or secret in ${a.action}: ${a.details}`);
        }

        // ── The account page's own list: every offered app, and whether it can be removed ──
        r = await fetch(`${base}/api/auth/connect/apps/status`, { headers: { authorization: `Bearer ${(signedIn.header().match(/ov_token=([^;]+)/) || [])[1]}` } });
        const mine = await r.json();
        assert.strictEqual(mine.apps.google.linked.service_user_id, 'google-sub-1', 'the account page sees the linked app');
        assert.strictEqual(mine.apps.discord.linked, null, 'and the ones not linked');
        // Alice has only Google left: it cannot be removed.
        assert.strictEqual(mine.apps.google.can_unlink, false, 'her only way in is flagged as such');

        // ── The sign-in page itself: indexable, with one button per offered provider and its brand glyph ──
        const page = require('../server/auth/providers/page');
        const html = page.render(require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'login.html'), 'utf8'), listed);
        assert.ok(html.includes('Sign in to OpenVibe with Google, Discord, Steam, Twitch, GitHub, Microsoft, Kick, X, Roblox and Facebook'),
            'the heading a crawler reads names them all, in the order of use');
        assert.ok(/<meta name="description" content="Sign in to OpenVibe with Google, Discord/.test(html), 'and the description says the same');
        assert.ok(html.includes('href="/api/auth/connect/google"'), 'each provider is a plain link');
        assert.ok(html.includes('<i data-ov-brand="google"'), 'with its brand glyph');
        assert.ok(html.includes('<i data-ov-icon="window"'), 'and a Shared glyph when there is no brand mark (Microsoft)');
        assert.ok(!/noindex/i.test(html), 'the page is indexable');
        // /forgot-password and /reset-password are the same file: no provider buttons there, and no description change.
        const forgot = await page.signInPage({ db, baseUrl: BASE, providers: false });
        assert.ok(!forgot.html.includes('id="signin-providers"'), 'the reset page never offers provider buttons');
        assert.ok(forgot.html.includes('<meta name="description" content="Sign in to OpenVibe with Google, Discord, Twitch, GitHub, Microsoft, Apple, Kick, X, Roblox, Facebook or Steam'), 'and keeps the file\'s own description');
        // The master switch hides every button at once.
        await setKey('signin_switch', false);
        r = await get('/api/auth/connect');
        assert.deepStrictEqual(JSON.parse(r.text).providers, [], 'the master switch hides them all');
        r = await get('/api/auth/connect/google?return=%2Fmy');
        assert.strictEqual(r.status, 503, 'and refuses a start');
        await setKey('signin_switch', true);

        // ── The owner's Setup rows: the same store, through the in-process config handlers ──
        const ownerConfig = require('../server/auth/providers/owner-config');
        const ownerReq = { app, user: { report_key: null, subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, headers: {}, tokenClaims: { auth_time: Math.floor(Date.now() / 1000) } };
        let oc = await ownerConfig.local(app, ownerReq, '/internal/config/network.signin');
        assert.strictEqual(oc.status, 200, JSON.stringify(oc.answer));
        assert.strictEqual(oc.answer.namespace, 'network.signin');
        assert.ok(oc.answer.schema.properties['google.client_id']['x-owner-input'].group === 'sign-in-apps', 'the row says what it unlocks');
        assert.ok(String(oc.answer.schema.properties['google.client_id'].description).includes(`${BASE}/api/auth/connect/google/callback`),
            'and carries the exact redirect URI to copy into Google\'s app');
        const marker = oc.answer.secrets && oc.answer.secrets['google.client_secret'];
        assert.ok(marker && marker.redacted && !JSON.stringify(oc.answer).includes('google-secret'), 'a secret is a marker, never the value');
        // A provider switch off hides it, and the keys stay.
        oc = await ownerConfig.local(app, ownerReq, '/internal/config/network.signin', { method: 'POST', body: { values: { 'google.enabled': false }, reason: 'quiet week', merge: true } });
        assert.ok(oc.status >= 200 && oc.status < 300, JSON.stringify(oc.answer));
        r = await get('/api/auth/connect');
        assert.ok(!JSON.parse(r.text).providers.some((p) => p.id === 'google'), 'a switched-off provider is not offered');
        assert.strictEqual((await store.get())['google.client_id'], 'google-client', 'and its keys are still there');
        await ownerConfig.local(app, ownerReq, '/internal/config/network.signin', { method: 'POST', body: { values: { 'google.enabled': true }, reason: 'back', merge: true } });
        // A secret is write-only, and a write needs a fresh sign-in.
        oc = await ownerConfig.local(app, ownerReq, '/internal/config/network.signin/secrets/google.client_secret', { method: 'PUT', body: { value: 'rotated-secret', reason: 'rotate' } });
        assert.strictEqual(oc.status, 403, 'a secret write without a fresh sign-in is refused');
        assert.strictEqual(oc.answer.code, 'config.fresh_required');
        oc = await ownerConfig.local(app, { ...ownerReq, headers: { 'x-ov-fresh': '1' } }, '/internal/config/network.signin/secrets/google.client_secret', { method: 'PUT', body: { value: 'rotated-secret', reason: 'rotate' } });
        assert.ok(oc.status >= 200 && oc.status < 300, JSON.stringify(oc.answer));
        assert.ok(!JSON.stringify(oc.answer).includes('rotated-secret'), 'the answer names the marker, never the secret');
        // Setup's Test on the provider row reads the provider's own service, and never a token exchange.
        const callsBeforeTest = calls.length;
        oc = await ownerConfig.local(app, ownerReq, '/internal/config/network.signin/test/google.client_id', { method: 'POST', body: {} });
        assert.strictEqual(oc.status, 200, JSON.stringify(oc.answer));
        assert.strictEqual(oc.answer.ok, true, 'Google answers its discovery document');
        assert.match(oc.answer.message, /Google answered/, 'in one line');
        assert.ok(calls.slice(callsBeforeTest).every((x) => !/\/token$/.test(new URL(x.url, 'http://x').pathname)), 'a test never exchanges a code or a token');

        // ── The Discord alias still works ──
        c.clear();
        r = await get('/api/auth/discord/link');
        assert.strictEqual(r.status, 401, 'the old link path still needs a session');
        r = await get('/api/auth/connect');
        assert.ok(JSON.parse(r.text).providers.some((p) => p.id === 'discord'));

        console.log = quiet;
        console.log('sign-in providers: all checks passed');
    } finally {
        await new Promise((res) => server.close(res));
    }
})().catch((err) => { console.log = console.error.bind(console); console.error(err); process.exit(1); });
