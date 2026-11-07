'use strict';
// openvibe.my is in Network's CORS allow-list for the account hub's Bearer calls to /api/v1/me/*, and the
// `my` OAuth client is seeded with the exact redirect https://openvibe.my/auth/callback. The session cookie is
// host-only on openvibe.my: the cross-origin calls need no credentials, only the Authorization header.
//   node --import ./test/helpers/pg-preload.mjs test/my-cors.test.js
const assert = require('assert');
const http = require('http');
const { bootServer } = require('./helpers/boot-server');
const { signToken } = require('../server/auth/routes');

const MY = 'https://openvibe.my';

(async () => {
    const srv = await bootServer();
    try {
        const db = srv.app.locals.db;
        const config = srv.app.locals.config;
        await db.prepare("INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (91, 'mydomain', 'my@example.test', 'x', 1)").run();
        const user = await db.prepare('SELECT * FROM users WHERE id = 91').get();
        const token = signToken(user, srv.app.locals.privateKey, config);

        // The seed (server/db/database.js) made a confidential first-party client with the exact callback.
        const row = await db.prepare('SELECT client_id, client_secret, name, redirect_uris, is_first_party FROM oauth_clients WHERE client_id = ?').get('my');
        assert.ok(row, 'the my client is seeded');
        assert.strictEqual(row.name, 'OpenVibe.My');
        assert.deepStrictEqual(JSON.parse(row.redirect_uris), ['https://openvibe.my/auth/callback']);
        assert.strictEqual(Number(row.is_first_party), 1, 'a first-party client');
        assert.ok(row.client_secret && String(row.client_secret).length >= 16, 'it has a secret (never logged)');

        // The real app mounted the host routing: openvibe.network/my 302s, openvibe.my serves the hub (and its
        // static assets) itself, and a signed-out visit tries the silent sign-in first.
        const getHost = (p, host, cookies = []) => new Promise((resolve) => {
            const headers = { host };
            if (cookies.length) headers.cookie = cookies.join('; ');
            http.get({ host: '127.0.0.1', port: srv.port, path: p, headers }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, setCookies: res.headers['set-cookie'] || [] }));
            });
        });
        const cookieValue = (setCookies, name) => {
            for (const c of setCookies) {
                const m = String(c).match(new RegExp(`^${name}=([^;]*)`));
                if (m) return decodeURIComponent(m[1]);
            }
            return null;
        };
        let r0 = await getHost('/my?x=1', 'openvibe.network');
        assert.strictEqual(r0.status, 302, '302 while openvibe.my is new: no browser caches the hop');
        assert.strictEqual(r0.headers.location, 'https://openvibe.my/?x=1', 'the app, not only nginx, moves /my');
        r0 = await getHost('/?sso=none', 'openvibe.my');
        assert.strictEqual(r0.status, 200, 'openvibe.my serves the hub');
        assert.ok(r0.body.includes('id="needs-you"'), 'with Needs you above the hero');
        r0 = await getHost('/css/my.css', 'openvibe.my');
        assert.strictEqual(r0.status, 200, 'the hub\'s stylesheet is served by the same host');
        assert.match(String(r0.headers['content-type'] || ''), /text\/css/);
        r0 = await getHost('/', 'openvibe.my');
        assert.strictEqual(r0.status, 302);
        assert.strictEqual(r0.headers.location, '/auth/login?silent=1&next=%2F', 'the app starts the silent flow');

        // ── The whole sign-in on the real app: the 'my' client row's secret, PKCE, Network's own authorize and
        // token endpoints, and a host-only session on openvibe.my ──
        const login = await getHost('/auth/login?silent=1&next=%2Fsecurity', 'openvibe.my');
        assert.strictEqual(login.status, 302);
        const authUrl = new URL(login.headers.location);
        assert.strictEqual(authUrl.origin, 'https://openvibe.network');
        assert.strictEqual(authUrl.pathname, '/oauth/authorize');
        const state = cookieValue(login.setCookies, 'ov_oauth_state');
        const verifier = cookieValue(login.setCookies, 'ov_oauth_verifier');
        const next = cookieValue(login.setCookies, 'ov_oauth_next');
        assert.ok(state && verifier && next, 'the SDK started a stateful PKCE flow');
        const authorizePath = `${authUrl.pathname}${authUrl.search}`;
        // The browser is signed in on Network: prompt=none continues as that account and redirects to the hub.
        const authorized = await getHost(authorizePath, 'openvibe.network', [`ov_token=${encodeURIComponent(token)}`]);
        assert.strictEqual(authorized.status, 302, JSON.stringify(authorized.body));
        const back = new URL(authorized.headers.location);
        assert.strictEqual(back.origin, 'https://openvibe.my');
        assert.strictEqual(back.pathname, '/auth/callback');
        assert.ok(back.searchParams.get('code'), 'an authorization code');
        assert.strictEqual(back.searchParams.get('state'), state);
        // The callback exchanges it server-side, then sets the hub's own session.
        const callback = await getHost(`${back.pathname}${back.search}`, 'openvibe.my', [
            `ov_oauth_state=${state}`, `ov_oauth_verifier=${verifier}`, `ov_oauth_next=${encodeURIComponent(next)}`,
        ]);
        assert.strictEqual(callback.status, 302, JSON.stringify(callback.body));
        assert.strictEqual(callback.headers.location, '/security', 'back where the person was going');
        const session = cookieValue(callback.setCookies, 'ov_token');
        assert.ok(session, 'the hub session cookie is set');
        const claims = JSON.parse(Buffer.from(session.split('.')[1], 'base64url').toString('utf8'));
        assert.strictEqual(claims.iss, 'https://openvibe.network');
        assert.ok(Array.isArray(claims.aud) && claims.aud.includes('openvibe.network'), 'a real Network user token');
        assert.ok(!/access_token|refresh_token|[?&]token=/.test(callback.headers.location), 'the session is never in a URL');

        const preflight = await fetch(`${srv.base}/api/v1/me/actions`, {
            method: 'OPTIONS',
            headers: {
                origin: MY,
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'authorization, content-type',
            },
        });
        assert.strictEqual(preflight.status, 204, 'the preflight is answered');
        assert.strictEqual(preflight.headers.get('access-control-allow-origin'), MY, 'openvibe.my is allowed, exactly');
        assert.notStrictEqual(preflight.headers.get('access-control-allow-origin'), '*', 'never a wildcard');
        assert.match(String(preflight.headers.get('access-control-allow-headers') || '').toLowerCase(), /authorization/, 'Authorization is allowed');
        assert.ok(Number(preflight.headers.get('access-control-max-age')) > 0);

        // A Bearer call (no cookies) from openvibe.my reads the person's own route.
        let r = await fetch(`${srv.base}/api/v1/me/nodes`, { headers: { origin: MY, authorization: `Bearer ${token}` } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), MY);
        assert.strictEqual(r.headers.get('access-control-allow-credentials'), 'true', 'the allow-list keeps the platform\'s credentialed contract');
        await r.arrayBuffer();

        // The Action Center route too: unauthenticated still gets a readable 401 on the hub's origin.
        r = await fetch(`${srv.base}/api/v1/me/actions`, { headers: { origin: MY } });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), MY, 'the 401 is readable from openvibe.my');
        await r.arrayBuffer();

        // A foreign origin keeps the old refusal, so this change is scoped to first parties.
        r = await fetch(`${srv.base}/api/v1/me/nodes`, { headers: { origin: 'https://my.example.evil' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
        await r.arrayBuffer();

        console.log('my-cors: my client seed, openvibe.my preflight and Bearer /api/v1/me/* CORS ok');
    } catch (err) {
        console.error(srv.logs());
        throw err;
    } finally {
        await srv.stop();
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
