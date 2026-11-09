'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createLinkAuthRoutes } = require('../server/link/auth');
const { render } = require('../server/link/page');
const listen = app => new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const close = s => new Promise(resolve => s.close(resolve));
const cookieJar = r => (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
(async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = { ...publicKey.export({ format: 'jwk' }), kid: 'link-test', alg: 'RS256', use: 'sig' };
    let grants = 0;
    const network = express(); network.use(express.json());
    network.get('/api/.well-known/jwks', (_req, res) => res.json({ keys: [key] }));
    network.post('/oauth/token', (req, res) => {
        assert.equal(req.body.client_id, 'link-web');
        assert.equal(req.body.client_secret, 'test-only-secret');
        if (req.body.code !== 'issued-test-code') return res.status(400).json({ error: 'invalid_grant' });
        assert.equal(req.body.redirect_uri, 'https://openvibe.link/auth/callback');
        assert.ok(req.body.code_verifier);
        grants++;
        res.json({ access_token: jwt.sign({ sub: '12', type: 'person', username: 'probe', is_anon: false }, privateKey,
            { algorithm: 'RS256', keyid: key.kid, issuer: 'https://openvibe.network', audience: 'openvibe.network', expiresIn: '1h' }), refresh_token: 'test-refresh' });
    });
    const ns = await listen(network);
    const app = express(); app.use(require('cookie-parser')());
    app.use(await createLinkAuthRoutes({
        db: { prepare: () => ({ get: async id => { assert.equal(id, 'link-web'); return { client_secret: 'test-only-secret' }; } }) },
        config: { networkUrl: 'https://openvibe.network', internalUrl: `http://127.0.0.1:${ns.address().port}`, jwt: { issuer: 'https://openvibe.network' }, nodeEnv: 'production' },
        log: { warn() {}, error() {} },
    }));
    const server = await listen(app);
    const get = (path, cookie = '', host = 'openvibe.link') => new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path, headers: { Host: host, Cookie: cookie } }, res => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }); req.on('error', reject);
    });
    try {
        assert.equal((await get('/auth/login', '', 'openvibe.network')).status, 404, 'only Link owns these routes');
        assert.equal((await get('/auth/login', '', 'evil.openvibe.link')).status, 404, 'no suffix host match');
        assert.deepEqual(JSON.parse((await get('/auth/me')).body), { user: null });
        assert.equal(JSON.parse((await get('/auth/health')).body).client, 'ok');
        const start = await get('/auth/login?silent=1&next=' + encodeURIComponent('https://openvibe.link/?from=nav#install'));
        const authorize = new URL(start.headers.location);
        assert.equal(authorize.searchParams.get('prompt'), 'none');
        assert.equal(authorize.searchParams.get('client_id'), 'link-web');
        assert.equal(authorize.searchParams.get('redirect_uri'), 'https://openvibe.link/auth/callback');
        assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
        const state = authorize.searchParams.get('state');
        const flow = cookieJar(start);
        const mismatch = await get('/auth/callback?code=issued-test-code&state=wrong', flow);
        assert.ok(!cookieJar(mismatch).includes('ov_token='), 'wrong state cannot establish a session');
        assert.equal(grants, 0);
        const guest = await get('/auth/callback?error=login_required&state=' + state, flow);
        assert.equal(guest.status, 302);
        assert.equal(guest.headers.location, 'https://openvibe.link/?from=nav&sso=none#install', 'guests return quietly, preserving the location');
        const success = await get('/auth/callback?code=issued-test-code&state=' + state, flow);
        assert.equal(success.status, 302);
        assert.equal(success.headers.location, 'https://openvibe.link/?from=nav#install');
        const access = success.headers['set-cookie'].find(c => c.startsWith('ov_token='));
        assert.ok(access && /Secure/i.test(access) && /SameSite=Lax/i.test(access));
        assert.ok(!/Domain=/i.test(access), 'host-only session');
        const me = await get('/auth/me', cookieJar(success));
        assert.equal(JSON.parse(me.body).user.username, 'probe');
        assert.equal(me.headers['cache-control'], 'no-store');
        const external = await get('/auth/login?silent=1&next=https%3A%2F%2Fevil.test%2F');
        const externalState = new URL(external.headers.location).searchParams.get('state');
        const fallback = await get('/auth/callback?error=login_required&state='+externalState, cookieJar(external));
        assert.equal(fallback.headers.location, '/?sso=none', 'off-origin next is refused');
        const html = render();
        for (const fragment of ["sessionUrl:'/auth/me'", "silentLogin:'/auth/login?silent=1&next={url}'", "logoutUrl:'/auth/logout?next={url}'"]) assert.ok(html.includes(fragment));
        console.log('link auth: SDK PKCE, host scope, guest return, session verification and redirect checks passed');
    } finally { await close(server); await close(ns); }
})().catch(err => { console.error(err); process.exitCode = 1; });
