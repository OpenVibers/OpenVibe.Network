'use strict';
// openvibe.my: the account hub's own home (plan OpenVibe_Seven_Domains_Plan §4), served by Network. The Host
// header decides: openvibe.my serves the hub at / and its sections at /<section>; openvibe.network/my and the
// hub's old paths 302 there with the query (301 once openvibe.my has settled); www.openvibe.my 301s to the apex. Sign-in is the SDK's first-party
// OAuth client 'my' (PKCE S256, a host-only session on openvibe.my), with the silent path (prompt=none) and
// sign-out; no token is ever in a URL.
//   node test/my-home.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createSsoClient } = require('openvibe-sdk/sso');
const { createMyRoutes, canonicalNext } = require('../server/my/routes');

const ROOT = path.join(__dirname, '..');
const MY = 'openvibe.my';

(async () => {
    // ── A Network that issues the 'my' client's tokens ──
    const keys = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const grants = [];
    const fake = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
            let data = {};
            try { data = JSON.parse(body || '{}'); } catch { /* */ }
            grants.push({ path: req.url, data });
            if (req.url === '/oauth/revoke') return json(200, { ok: true });
            if (req.url !== '/oauth/token') return json(404, { error: 'not_found' });
            if (data.client_id !== 'my' || data.client_secret !== 'test-secret') return json(401, { error: 'invalid_client' });
            if (data.grant_type !== 'authorization_code') return json(400, { error: 'invalid_grant' });
            if (data.code !== 'good-code' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(data.code_verifier || ''))) {
                return json(400, { error: 'invalid_grant' });
            }
            const access = jwt.sign({
                sub: 7, id: 7, subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', username: 'alice', display_name: 'Alice', role: 'user',
            }, keys.privateKey, { algorithm: 'RS256', issuer: 'https://openvibe.network', audience: ['openvibe.network'], expiresIn: '1h' });
            return json(200, { access_token: access, refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 });
        });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

    const sso = createSsoClient({
        site: 'my', siteName: 'OpenVibe.My', baseUrl: 'https://openvibe.my',
        clientId: 'my', clientSecret: 'test-secret',
        redirectUri: 'https://openvibe.my/auth/callback',
        networkUrl: 'https://openvibe.network', networkInternalUrl: fakeUrl,
        issuer: 'https://openvibe.network', publicKey: keys.publicKey,
        audience: ['openvibe.network', 'openvibe.my'], secureCookies: false,
        log: { warn() {}, error() {}, log() {} },
    });
    const app = express();
    app.use(await createMyRoutes({ sso, config: { my: { baseUrl: 'https://openvibe.my' } }, pagePath: path.join(ROOT, 'public', 'my.html') }));
    app.get('/', (_req, res) => res.type('html').send('<p>network home</p>'));
    app.get('/themes', (_req, res) => res.type('html').send('<p>network themes</p>'));
    app.use(express.static(path.join(ROOT, 'public')));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const get = (p, host, cookies = []) => new Promise((resolve) => {
        const headers = { host };
        if (cookies.length) headers.cookie = cookies.join('; ');
        const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, setCookies: res.headers['set-cookie'] || [] }));
        });
        req.end();
    });
    const cookieValue = (setCookies, name) => {
        for (const c of setCookies) {
            const m = String(c).match(new RegExp(`^${name}=([^;]*)`));
            if (m) return decodeURIComponent(m[1]);
        }
        return null;
    };
    const locations = [];

    try {
        // ── Host routing ──
        let r = await get('/my?x=1', 'openvibe.network');
        assert.strictEqual(r.status, 302, '302 while openvibe.my is new: no browser caches the hop');
        assert.strictEqual(r.headers.location, 'https://openvibe.my/?x=1', 'the old /my keeps the query');
        locations.push(r.headers.location);

        r = await get('/my/security?from=notes', 'openvibe.network');
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, 'https://openvibe.my/security?from=notes', '/my/* strips /my');

        r = await get('/my.html', 'openvibe.network');
        assert.strictEqual(r.headers.location, 'https://openvibe.my/', 'my.html lands on the hub home');

        r = await get('/machines', 'openvibe.network');
        assert.strictEqual(r.headers.location, 'https://openvibe.link/machines', 'every old account-hub path moves');

        r = await get('/', 'openvibe.network');
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.includes('network home'), 'the Network apex is untouched');

        r = await get('/security?x=1', 'www.openvibe.my');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.location, 'https://openvibe.my/security?x=1', 'www 301s to the apex, path and query kept');

        r = await get('/my/security?x=1', MY);
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.location, '/security?x=1', 'on openvibe.my /my/* is canonicalized too');

        // ── The first screen ──
        r = await get('/', MY);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, '/auth/login?silent=1&next=%2F', 'a signed-out visit tries the silent sign-in first');

        r = await get('/security', MY);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, '/auth/login?silent=1&next=%2Fsecurity', 'the section is where the silent sign-in returns');

        r = await get('/?sso=none', MY);
        assert.strictEqual(r.status, 200, 'a Network guest gets the page quietly, with sso=none');
        assert.ok(r.body.includes('id="needs-you"'), 'the hub leads with Needs you');
        assert.ok(r.body.includes('id="needs-you-list"'), 'and has its list');
        assert.ok(r.body.indexOf('id="page-header"') < r.body.indexOf('id="needs-you"'), 'the person comes first');
        assert.ok(r.body.indexOf('id="needs-you"') < r.body.indexOf('id="me-acts"'), 'actions follow Needs you');
        assert.ok(r.body.includes('id="page-header"') && r.body.includes('class="section-tabs"'), 'the hero and sections stay');
        assert.ok(r.body.includes('<link rel="canonical" href="https://openvibe.my/">'), 'the canonical is openvibe.my');
        assert.strictEqual(r.headers['cache-control'], 'no-store', 'the hub is not cached');

        r = await get('/', MY, ['ov_token=already']);
        assert.strictEqual(r.status, 200, 'a session skips the silent redirect');

        r = await get('/machines', MY, ['ov_token=already']);
        assert.strictEqual(r.status, 200, 'signed-in /machines stays in the hub');
        assert.ok(r.body.includes('id="sec-machines"'), 'serves Machines');

        // ── The sign-in: PKCE S256, state and verifier in host-only cookies ──
        r = await get('/auth/login?next=%2Fsecurity', MY);
        assert.strictEqual(r.status, 302);
        const authorize = new URL(r.headers.location);
        assert.strictEqual(authorize.origin, 'https://openvibe.network');
        assert.strictEqual(authorize.pathname, '/oauth/authorize');
        assert.strictEqual(authorize.searchParams.get('client_id'), 'my');
        assert.strictEqual(authorize.searchParams.get('redirect_uri'), 'https://openvibe.my/auth/callback');
        assert.strictEqual(authorize.searchParams.get('response_type'), 'code');
        assert.strictEqual(authorize.searchParams.get('code_challenge_method'), 'S256');
        assert.ok(/^[A-Za-z0-9_-]{43,128}$/.test(authorize.searchParams.get('code_challenge')), 'S256 challenge');
        assert.ok(authorize.searchParams.get('state'), 'state');
        assert.ok(!/access_token|refresh_token|id_token|[?&]token=/.test(r.headers.location), 'no token in the sign-in URL');
        locations.push(r.headers.location);

        const state = cookieValue(r.setCookies, 'ov_oauth_state');
        const verifier = cookieValue(r.setCookies, 'ov_oauth_verifier');
        const next = cookieValue(r.setCookies, 'ov_oauth_next');
        assert.ok(state && verifier && next, 'state, verifier and next cookies are set');
        assert.strictEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'), 'the challenge is the verifier\'s SHA-256');
        for (const name of ['ov_oauth_state', 'ov_oauth_verifier']) {
            const c = r.setCookies.find((x) => String(x).startsWith(`${name}=`));
            assert.ok(c, `${name} cookie`);
            assert.match(c, /Path=\/auth/i, `${name} is scoped to /auth`);
            assert.match(c, /HttpOnly/i, `${name} is HttpOnly`);
            assert.match(c, /SameSite=Lax/i, `${name} is SameSite=Lax`);
            assert.ok(!/Domain=/i.test(c), `${name} is host-only`);
        }

        // ── The callback: the code is exchanged server-side and the session is host-only ──
        r = await get(`/auth/callback?code=good-code&state=${encodeURIComponent(state)}`, MY, [`ov_oauth_state=${state}`, `ov_oauth_verifier=${verifier}`, `ov_oauth_next=${encodeURIComponent(next)}`]);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, '/security', 'back where the person was going');
        assert.ok(!/access_token|refresh_token|[?&]token=/.test(r.headers.location), 'the token is never in the callback URL');
        const grant = grants.find((g) => g.data.grant_type === 'authorization_code');
        assert.strictEqual(grant.data.client_id, 'my');
        assert.strictEqual(grant.data.client_secret, 'test-secret', 'the code is exchanged server-side');
        assert.strictEqual(grant.data.code_verifier, verifier, 'the PKCE verifier is the one the cookie kept');
        const accessCookie = r.setCookies.find((x) => String(x).startsWith('ov_token='));
        const refreshCookie = r.setCookies.find((x) => String(x).startsWith('ov_refresh='));
        assert.ok(accessCookie && refreshCookie, 'the session is set');
        assert.ok(!/Domain=/i.test(accessCookie) && !/Domain=/i.test(refreshCookie), 'the session cookies are host-only');
        assert.match(refreshCookie, /Path=\/auth/i, 'the refresh token is scoped to /auth');
        assert.match(refreshCookie, /HttpOnly/i, 'the refresh token is HttpOnly');
        assert.match(accessCookie, /SameSite=Lax/i, 'the access cookie is SameSite=Lax');

        // ── The silent path: prompt=none, and a Network guest comes back quietly ──
        r = await get('/auth/login?silent=1&next=%2F', MY);
        assert.strictEqual(r.status, 302);
        const silentAuthorize = new URL(r.headers.location);
        assert.strictEqual(silentAuthorize.searchParams.get('prompt'), 'none');
        const silentState = cookieValue(r.setCookies, 'ov_oauth_state');
        r = await get(`/auth/callback?error=login_required&state=${encodeURIComponent(silentState)}`, MY, [`ov_oauth_state=${silentState}`]);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, '/?sso=none', 'a guest stays quiet, marked sso=none');
        assert.ok(!r.setCookies.some((c) => String(c).startsWith('ov_token=')), 'a failed silent sign-in sets no session');
        assert.ok(!/access_token|refresh_token|[?&]token=/.test(r.headers.location), 'no token in the silent URL');
        locations.push(r.headers.location);

        // ── Sign-out: this origin now, with the way everywhere left open ──
        r = await get('/auth/logout?next=%2F', MY, ['ov_token=old', 'ov_refresh=old-refresh']);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, '/');
        assert.ok(grants.some((g) => g.path === '/oauth/revoke' && g.data.token === 'old-refresh'), 'the refresh token is revoked');
        assert.ok(r.setCookies.some((c) => String(c).startsWith('ov_token=;')), 'the access cookie is cleared');
        assert.ok(r.setCookies.some((c) => String(c).startsWith('ov_refresh=;')), 'the refresh cookie is cleared');
        assert.ok(r.setCookies.some((c) => String(c).startsWith('ov_sso_hint=guest')), 'the browser is remembered as a guest');
        assert.ok(!/access_token|refresh_token|[?&]token=/.test(r.headers.location), 'no token in the sign-out URL');

        // The hub's "sign out everywhere" goes through Network's fanout after clearing this origin.
        r = await get('/sso/fanout?action=logout&next=%2Flinked', MY);
        assert.strictEqual(r.status, 302);
        const logoutFanout = new URL(r.headers.location, 'https://openvibe.my');
        assert.strictEqual(logoutFanout.pathname, '/auth/logout');
        const fanout = new URL(logoutFanout.searchParams.get('next'));
        assert.strictEqual(fanout.origin, 'https://openvibe.network');
        assert.strictEqual(fanout.pathname, '/sso/fanout');
        assert.strictEqual(fanout.searchParams.get('action'), 'logout');
        assert.strictEqual(fanout.searchParams.get('next'), 'https://openvibe.my/linked?sso=none', 'it comes back to the hub quietly, not into a silent sign-in');

        // The old /login links are the SDK's sign-in, with prompt for reauth / another account.
        r = await get('/login?reauth=1&return=%2Fmy%23delete', MY);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, '/auth/login?next=%2F%23delete&prompt=login');
        r = await get('/login?add_account=1&return=%2Faccounts', MY);
        assert.strictEqual(r.headers.location, '/auth/login?next=%2Faccounts&prompt=select_account');

        // ── No token in a URL the hub produces ──
        for (const loc of locations) assert.ok(!/access_token|refresh_token|id_token|[?&]token=/.test(String(loc)), `no token in ${loc}`);
        assert.strictEqual(canonicalNext('/my#delete'), '/#delete');
        assert.strictEqual(canonicalNext('https://openvibe.network/my/security?x=1'), '/security?x=1');
        assert.strictEqual(canonicalNext('https://evil.example/my'), '/', 'a foreign next goes home');

        // The page asks Network with the cookie anyway: it must not carry a token in a query.
        const html = fs.readFileSync(path.join(ROOT, 'public', 'my.html'), 'utf8');
        assert.ok(!/[?&](access_token|refresh_token|id_token|token)=/.test(html), 'the page never puts a token in a URL');
        const boot = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my', 'boot.js'), 'utf8');
        assert.ok(boot.includes("window.location.replace('/auth/logout?next=%2F')"), 'the account switcher signs out of openvibe.my itself');
        const profile = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my', 'profile.js'), 'utf8');
        assert.ok(profile.includes("sessionUrl: '/auth/me'") && profile.includes("logoutUrl: '/auth/logout?next={path}'"), 'the shared navbar uses the hub\'s session');
        assert.ok(profile.includes('function showSignedOutHub') && profile.includes("'Sign out everywhere'"), 'a signed-out hub stays put and offers everywhere');
        // Signed out, the page says what it is and what is inside, with one way in (it was a small card on an empty
        // screen that offered "Sign out everywhere" as a second button to someone who is signed out).
        assert.ok(profile.includes("'Everything that is yours on OpenVibe'") && profile.includes("el('a', 'btn btn-primary my-out-go', 'Sign in')"), 'what it is, and one button');
        ['Pick up where you left off', 'Your sites', 'Your numbers', 'Settings', 'Sign in on another device'].forEach((name) => assert.ok(profile.includes(`'${name}'`), `the signed-out page lists ${name}`));
        assert.ok(profile.includes("el('a', 'my-out-all', 'Sign out everywhere')"), 'signing out everywhere is a quiet line, not a second button');
        assert.ok(fs.readFileSync(path.join(ROOT, 'public', 'css', 'my.css'), 'utf8').includes('.my-out-list li{'), 'and it is styled');
        const security = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my', 'security.js'), 'utf8');
        assert.ok(security.includes("'https://openvibe.network/sso/fanout?action=logout&next='"), 'signing out everywhere still offers Network\'s fanout');
    } finally {
        server.close();
        fake.close();
    }

    console.log('my-home: host routing, 301s, PKCE sign-in, host-only session, silent path, sign-out and Needs you ok');
})().catch((e) => { console.error(e); process.exit(1); });
