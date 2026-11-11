'use strict';
// Cross-site passkeys (Related Origin Requests): real ES256 assertions for a product origin, the
// published origin list, and every refusal the design names. Verification is never stubbed.
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { getDb } = require('../server/db/database');
const auth = require('../server/auth/routes');
const { authenticator } = require('./helpers/passkey-authenticator');
const webauthnOrigins = require('../server/webauthn-origins');

const basic = (id, secret) => 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

(async () => {
    process.env.NETWORK_MFA_KEY = crypto.randomBytes(32).toString('hex');
    const db = getDb();
    const pw = 'test-only-password';
    const aliceId = 91, bobId = 92;
    await db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?), (?, ?, ?)')
        .run(aliceId, 'related_alice', bcrypt.hashSync(pw, 4), bobId, 'related_bob', bcrypt.hashSync(pw, 4));
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    const app = express(); app.use(express.json()); app.use(cookieParser()); Object.assign(app.locals, { db, config, ...keys }); app.use('/api/auth', auth);
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.on('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    const alice = await db.prepare('SELECT * FROM users WHERE id = ?').get(aliceId);
    const at = auth.signToken(alice, keys.privateKey, config);
    const call = async (path, body, authHeader, cookies) => {
        const res = await fetch(base + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'content-type': 'application/json', ...(authHeader ? { authorization: authHeader } : {}), ...(cookies ? { cookie: cookies } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: await res.json(), cookies: res.headers.getSetCookie() };
    };
    const cookieOf = (r, name = '__Host-ov_passkey') => r.cookies.find(s => s.startsWith(name + '='))?.split(';')[0];
    const related = (path, body, creds = basic('blog-related', 'blog-secret')) => call('/passkeys/related/' + path, body, creds);
    const origin = 'https://openvibe.blog';
    const binding = crypto.randomBytes(32).toString('base64url');
    const reset = async (id) => db.prepare('UPDATE user_mfa SET failures = 0, locked_until = 0 WHERE user_id = ?').run(id);
    const assertionFor = async (device, state, overrides = {}, bind = binding) => {
        const r = await related('options', { origin, binding: bind, purpose: 'login' });
        assert.equal(r.status, 200, 'related options');
        const opts = r.body.options;
        return related('verify', { origin, binding: bind, state: r.body.state, response: device.assert(opts, { origin, rp: 'openvibe.network', ...overrides }) });
    };
    try {
        // ── the published list ─────────────────────────────────────
        const list = webauthnOrigins.origins();
        for (const want of ['https://openvibe.network', 'https://openvibe.blog', 'https://openvibe.live', 'https://openvibe.my', 'https://openre.stream', 'https://open.shoes']) {
            assert.ok(list.includes(want), `well-known lists ${want}`);
        }
        for (const no of ['https://openvibe.website', 'https://maps.openvibe.tools', 'https://api.openvibe.network', 'https://s3.openvibe.media', 'https://evil.example']) {
            assert.ok(!list.includes(no), `well-known excludes ${no}`);
        }
        assert.ok(list.every(o => /^https:\/\/[a-z0-9.-]+$/.test(o)), 'only exact https origins');
        assert.ok(webauthnOrigins.isApprovedOrigin(origin));
        const generated = webauthnOrigins.generatedOrigins([
            { id: 'a', publicOrigin: 'https://openvibe.a', exposure: { state: 'live', publicSite: 'service' } },
            { id: 'b', publicOrigin: 'https://openvibe.website', exposure: { state: 'live', publicSite: 'service' } },
            { id: 'c', publicOrigin: 'https://openvibe.c', exposure: { state: 'internal', publicSite: 'service' } },
            { id: 'd', publicOrigin: 'http://openvibe.d', exposure: { state: 'live', publicSite: 'service' } },
        ]);
        assert.ok(generated.includes('https://openvibe.a'));
        for (const no of ['https://openvibe.website', 'https://openvibe.c', 'http://openvibe.d']) assert.ok(!generated.includes(no), no);

        // ── fixtures: two confidential clients and one public, one unregistered origin ──
        const addClient = (id, secret, redirect, isPublic = 0) => db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party, is_public) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT (client_id) DO UPDATE SET client_secret = EXCLUDED.client_secret, redirect_uris = EXCLUDED.redirect_uris, is_public = EXCLUDED.is_public")
            .run(id, secret, id, JSON.stringify(redirect), isPublic);
        await addClient('blog-related', 'blog-secret', ['https://openvibe.blog/auth/callback']);
        await addClient('blog-other', 'other-secret', ['https://openvibe.blog/auth/callback']);
        await addClient('live-related', 'live-secret', ['https://openvibe.live/auth/callback']);
        await addClient('unknown-origin', 'unknown-secret', ['https://evil.example/auth/callback']);
        await addClient('public-related', '', ['https://openvibe.blog/auth/callback'], 1);
        await require('../server/identity/subjects').ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(bobId));

        // ── enroll a real credential for Alice through the existing Network flow ──
        await db.prepare("INSERT INTO site_settings (key, value) VALUES ('mfa_enrollment', 'all') ON CONFLICT (key) DO UPDATE SET value = 'all'").run();
        const device = authenticator(), bobDevice = authenticator();
        for (const [who, token, dev] of [[alice, at, device], [await db.prepare('SELECT * FROM users WHERE id = ?').get(bobId), auth.signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(bobId), keys.privateKey, config), bobDevice]]) {
            const start = await call('/passkeys/register/options', { password: pw }, 'Bearer ' + token); assert.equal(start.status, 200);
            const done = await call('/passkeys/register/verify', { state: start.body.state, response: dev.register(start.body.options), name: 'Related test key' }, 'Bearer ' + token);
            assert.equal(done.status, 200, 'real registration for the related tests');
        }

        // ── a real assertion for the product origin, then its single-use redeem ──
        const first = await related('options', { origin, binding, purpose: 'login' });
        assert.equal(first.status, 200); assert.equal(first.body.options.rpId, 'openvibe.network');
        const verified = await related('verify', { origin, binding, state: first.body.state, response: device.assert(first.body.options, { origin }) });
        if (verified.status !== 200) console.error('related verify', verified.status, JSON.stringify(verified.body)); assert.equal(verified.status, 200, 'real ES256 assertion for https://openvibe.blog'); assert.match(verified.body.result, /^[A-Za-z0-9_-]{20,}$/);
        const redeemed = await related('redeem', { origin, result: verified.body.result });
        assert.equal(redeemed.status, 200, 'single-use result redeems'); assert.ok(redeemed.body.access_token && redeemed.body.refresh_token);
        const claims = JSON.parse(Buffer.from(redeemed.body.access_token.split('.')[1], 'base64url').toString());
        assert.equal(claims.sub, aliceId); assert.equal(claims.client_id, 'blog-related'); assert.ok([].concat(claims.aud).includes('openvibe.network'));
        assert.equal(redeemed.body.user.username, 'related_alice');
        assert.equal((await related('redeem', { origin, result: verified.body.result })).status, 401, 'result replay');
        assert.equal((await related('verify', { origin, binding, state: first.body.state, response: device.assert(first.body.options, { origin }) })).status, 401, 'challenge replay');

        // ── concurrent redemption: exactly one winner ──
        const secondOptions = await related('options', { origin, binding });
        const secondVerified = await related('verify', { origin, binding, state: secondOptions.body.state, response: device.assert(secondOptions.body.options, { origin }) });
        assert.equal(secondVerified.status, 200);
        const race = await Promise.all([1, 2].map(() => related('redeem', { origin, result: secondVerified.body.result })));
        assert.deepEqual(race.map(r => r.status).sort(), [200, 401], 'atomic result redemption');

        // ── refusals ───────────────────────────────────────────────
        assert.equal((await related('options', { origin, binding }, basic('blog-related', 'wrong'))).status, 401, 'wrong client secret');
        assert.equal((await related('options', { origin, binding }, basic('public-related', ''))).status, 401, 'public client refused');
        assert.equal((await related('options', { origin: 'https://evil.example', binding })).status, 403, 'unpublished origin');
        assert.equal((await related('options', { origin: 'https://openvibe.live', binding })).status, 403, 'origin not registered to this client');
        assert.equal((await related('options', { origin, binding }, basic('unknown-origin', 'unknown-secret'))).status, 403, 'registered but unpublished origin');
        assert.equal((await related('options', { origin, binding, purpose: 'reauth' })).status, 400, 'only a login ceremony');
        assert.equal((await related('options', { origin, binding: '' })).status, 400, 'browser binding required');
        assert.equal((await related('verify', { origin, binding: 'x'.repeat(43), state: 'nope', response: {} })).status, 400, 'malformed body refused');
        let o = await related('options', { origin, binding });
        assert.equal((await related('verify', { origin, binding: crypto.randomBytes(32).toString('base64url'), state: o.body.state, response: device.assert(o.body.options, { origin }) })).status, 401, 'wrong browser binding');
        assert.equal((await related('verify', { origin: 'https://openvibe.live', binding, state: o.body.state, response: {} })).status, 403, 'borrowed state on another origin');
        for (const bad of [{ origin, rp: 'evil.example' }, { origin, flags: 0x41 }, { origin, wrongHandle: true }]) {
            o = await related('options', { origin, binding });
            const refused = await related('verify', { origin, binding, state: o.body.state, response: device.assert(o.body.options, bad) });
            assert.equal(refused.status, 401, `refused assertion ${JSON.stringify(Object.keys(bad))}`);
        }
        o = await related('options', { origin, binding });
        const expired = { origin, binding, state: o.body.state, response: device.assert(o.body.options, { origin }) };
        await db.prepare("UPDATE passkey_challenges SET expires_at = 0 WHERE purpose = 'related-login'").run();
        assert.equal((await related('verify', expired)).status, 401, 'expired challenge');
        const third = await related('options', { origin, binding });
        const thirdVerified = await related('verify', { origin, binding, state: third.body.state, response: device.assert(third.body.options, { origin }) });
        assert.equal(thirdVerified.status, 200);
        assert.equal((await related('redeem', { origin, result: thirdVerified.body.result }, basic('blog-other', 'other-secret'))).status, 401, 'another client cannot redeem');
        assert.equal((await related('redeem', { origin, result: thirdVerified.body.result }, basic('live-related', 'live-secret'))).status, 403, 'a client of another origin cannot even ask');
        assert.equal((await related('redeem', { origin: 'https://openvibe.live', result: thirdVerified.body.result })).status, 403, 'another origin cannot redeem');

        // ── account state: revoked/merged, and a pending password for someone else ──
        await reset(aliceId); await reset(bobId);
        const pending = cookieOf(await call('/login', { username: 'related_alice', password: pw }), '__Host-ov_mfa_pending');
        assert.ok(pending, 'Alice has a pending password challenge');
        o = await related('options', { origin, binding });
        const bobVerified = await related('verify', { origin, binding, state: o.body.state, response: bobDevice.assert(o.body.options, { origin }) });
        assert.equal(bobVerified.status, 200);
        const bobRedeemed = await related('redeem', { origin, result: bobVerified.body.result });
        assert.equal(bobRedeemed.status, 200);
        assert.equal(JSON.parse(Buffer.from(bobRedeemed.body.access_token.split('.')[1], 'base64url').toString()).sub, bobId, 'a pending password for Alice cannot switch the passkey account');
        await db.prepare('UPDATE users SET merged_into = ? WHERE id = ?').run(aliceId, aliceId);
        assert.equal((await assertionFor(device)).status, 401, 'merged user refused');
        await db.prepare('UPDATE users SET merged_into = NULL WHERE id = ?').run(aliceId);
        await reset(aliceId);
        const after = await assertionFor(device);
        assert.equal(after.status, 200, 'a merged flag removed lets the account use its key again');

        // The real verifier checked the signed origin: a valid Network-origin assertion is refused for this flow.
        o = await related('options', { origin, binding });
        const networkOrigin = await related('verify', { origin, binding, state: o.body.state, response: device.assert(o.body.options, { origin: 'https://openvibe.network' }) });
        assert.equal(networkOrigin.status, 401, 'Network-origin assertion is not a product-origin assertion');

        console.log('Related passkeys: published/read-only origins, real ES256 at https://openvibe.blog, RP/origin/UV/user-handle refusals, expiry, replay, concurrent redemption, client/origin binding, merged users and pending-password isolation passed');
    } finally { server.close(); await globalThis.__ovNetworkTestDbClose?.(); }
})().catch(err => {
    console.error('Related passkey tests failed (assertion details redacted)');
    console.error(String(err.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4).join('\n'));
    process.exitCode = 1;
});
