'use strict';
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { getDb } = require('../server/db/database');
const auth = require('../server/auth/routes');
const { authenticator } = require('./helpers/passkey-authenticator');
const accountData = require('../server/identity/account-data');
(async () => {
    process.env.NETWORK_MFA_KEY = crypto.randomBytes(32).toString('hex');
    const db = getDb(); const pw = 'test-only-password';
    await db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?), (?, ?, ?)').run(71, 'passkey_alice', bcrypt.hashSync(pw, 4), 72, 'passkey_bob', bcrypt.hashSync(pw, 4));
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    const app = express(); app.use(express.json()); app.use(cookieParser()); Object.assign(app.locals, { db, config, ...keys }); app.use('/api/auth', auth);
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.on('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    await require('../server/identity/subjects').ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 72').get());
    const alice = await db.prepare('SELECT * FROM users WHERE id = 71').get(); const bob = await db.prepare('SELECT * FROM users WHERE id = 72').get();
    const at = auth.signToken(alice, keys.privateKey, config); const bt = auth.signToken(bob, keys.privateKey, config);
    const call = async (path, body, token, cookies) => {
        const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookies ? { cookie: cookies } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: res.status, body: await res.json(), cookies: res.headers.getSetCookie() };
    };
    const cookieOf = (r, name = '__Host-ov_passkey') => r.cookies.find(s => s.startsWith(name + '='))?.split(';')[0];
    const login = () => call('/login', { username: alice.username, password: pw });
    // Keep each phase below the production per-minute limiter without weakening middleware.
    const realNow = Date.now; let now = realNow(); Date.now = () => now;
    const next = () => { now += 61000; };
    const enroll = async (device, token = at, credentials = {}) => {
        const r = await call('/passkeys/register/options', { password: pw, ...credentials }, token); assert.equal(r.status, 200);
        const payload = { state: r.body.state, response: device.register(r.body.options), name: 'Test passkey' };
        const result = await call('/passkeys/register/verify', payload, token);
        if (result.status === 200) assert.equal((await call('/passkeys/register/verify', payload, token)).status, 401, 'registration state is single use');
        return result;
    };
    const assertion = async (device, overrides = {}, pending = '') => {
        const r = await call('/passkeys/login/options', {}, null, pending); assert.equal(r.status, 200);
        const body = { response: device.assert(r.body, overrides) }; const cookies = [cookieOf(r), pending].filter(Boolean).join('; ');
        return { r: await call('/passkeys/login/verify', body, null, cookies), body, cookies };
    };
    try {
        assert.equal((await login()).status, 200);
        assert.equal((await call('/passkeys/register/options', { password: pw }, at)).status, 404);
        await db.prepare("UPDATE site_settings SET value = 'all' WHERE key = 'mfa_enrollment'").run();
        assert.equal((await call('/passkeys/register/options', { password: 'wrong' }, at)).status, 401);
        const device = authenticator();
        let start = await call('/passkeys/register/options', { password: pw }, at);
        assert.equal(start.body.options.rp.id, 'openvibe.network'); assert.equal(start.body.options.attestation, 'none'); assert.equal(start.body.options.authenticatorSelection.userVerification, 'required');
        let payload = { state: start.body.state, response: device.register(start.body.options) };
        assert.equal((await call('/passkeys/register/verify', payload, bt)).status, 401, 'other account');
        await db.prepare('UPDATE passkey_challenges SET expires_at = 0').run();
        assert.equal((await call('/passkeys/register/verify', payload, at)).status, 401, 'expired');
        for (const invalid of [{ origin: 'https://evil.example' }, { rp: 'evil.example' }, { flags: 0x41 }]) {
            start = await call('/passkeys/register/options', { password: pw }, at);
            assert.equal((await call('/passkeys/register/verify', { state: start.body.state, response: device.register(start.body.options, invalid) }, at)).status, 401);
        }
        next();
        const enrolled = await enroll(device); assert.equal(enrolled.status, 200); const codes = enrolled.body.recovery_codes; assert.equal(codes.length, 10);
        assert.equal((await login()).status, 202, 'passkey protects password fallback');
        assert.equal((await call('/mfa/enroll', { password: pw }, at)).status, 409, 'adding TOTP also requires existing factor');
        assert.equal((await call('/passkeys/register/options', { password: pw }, at)).status, 401, 'existing factor required');
        start = await call('/passkeys/login/options', {});
        payload = { response: device.assert(start.body) };
        const race = await Promise.all([call('/passkeys/login/verify', payload, null, cookieOf(start)), call('/passkeys/login/verify', payload, null, cookieOf(start))]);
        assert.deepEqual(race.map(r => r.status).sort(), [200, 401], 'atomic assertion consumption');
        let result = await assertion(device); assert.equal(result.r.status, 200, 'real ES256 assertion'); assert.ok(result.r.body.token);
        assert.equal((await call('/passkeys/login/verify', result.body, null, result.cookies)).status, 401, 'replay');
        for (const invalid of [{ origin: 'https://evil.example' }, { rp: 'evil.example' }, { flags: 1 }, { wrongHandle: true }]) {
            assert.equal((await assertion(device, invalid)).r.status, 401);
        }
        assert.equal((await assertion(device, { flags: 1 })).r.status, 401, 'fifth failure');
        assert.equal((await assertion(device)).r.status, 401, 'valid assertion waits during lockout');
        assert.equal((await login()).status, 429, 'account lockout spans password and passkeys');
        now += 301000;
        next();
        start = await call('/passkeys/login/options', {}); payload = { response: device.assert(start.body) };
        await db.prepare('UPDATE passkey_challenges SET expires_at = 0').run();
        assert.equal((await call('/passkeys/login/verify', payload, null, cookieOf(start))).status, 401);
        // A valid assertion resets the shared failed-factor count.
        assert.equal((await assertion(device)).r.status, 200);
        const bobDevice = authenticator(); assert.equal((await enroll(bobDevice, bt)).status, 200);
        let pending = cookieOf(await login(), '__Host-ov_mfa_pending');
        assert.equal((await assertion(bobDevice, {}, pending)).r.status, 401, 'pending account cannot switch');
        assert.equal((await assertion(device, {}, pending)).r.status, 200, 'passkey second factor');
        assert.equal((await call('/mfa/verify', { code: codes[0] }, null, pending)).status, 401, 'pending consumed');
        pending = cookieOf(await login(), '__Host-ov_mfa_pending');
        assert.equal((await call('/mfa/verify', { code: codes[0] }, null, pending)).status, 200, 'passkey-only recovery');
        pending = cookieOf(await login(), '__Host-ov_mfa_pending');
        assert.equal((await call('/mfa/verify', { code: codes[0] }, null, pending)).status, 401, 'reused recovery');
        next();
        start = await call('/passkeys/reauth/options', {}, at);
        let reauth = await call('/passkeys/reauth/verify', { response: device.assert(start.body) }, at, cookieOf(start)); assert.equal(reauth.status, 200);
        assert.equal((await call('/passkeys/reauth/verify', { response: device.assert(start.body) }, at, cookieOf(start))).status, 401, 'reauth state is single use');
        const second = authenticator(); assert.equal((await enroll(second, at, { proof: reauth.body.proof })).status, 200);
        assert.equal((await call('/passkeys/remove', { password: pw, proof: reauth.body.proof, id: second.id }, at)).status, 401, 'proof used once');
        assert.equal((await call('/passkeys/remove', { password: pw, code: codes[1], id: device.id }, bt)).status, 401, 'other account cannot remove');
        const exported = await accountData.networkPart(db, alice.id);
        assert.ok(exported.files.some(f => f.name === 'user_passkeys.json')); assert.ok(exported.files.some(f => f.name === 'passkey_challenges.json'));
        assert.ok(!JSON.stringify(exported).includes(codes[2])); assert.ok(!JSON.stringify(exported).includes('public_key'));
        await db.prepare("UPDATE site_settings SET value = 'off' WHERE key = 'mfa_enrollment'").run();
        assert.equal((await assertion(device)).r.status, 200, 'existing keys work with flag off');
        assert.equal((await login()).status, 202);
        assert.equal((await call('/passkeys/remove', { password: pw, code: codes[1], id: device.id }, at)).status, 200);
        assert.equal((await assertion(device)).r.status, 401, 'removed credential refused');
        assert.equal((await call('/passkeys/remove', { password: pw, code: codes[2], id: second.id }, at)).status, 200);
        assert.equal((await login()).status, 200, 'last key removed');
        next();
        // The real ADR-033 erasure path removes credentials and pending account-bound states.
        await call('/passkeys/reauth/options', {}, bt);
        const deletion = await accountData.scheduleDeletion(db, bob, { auth_time: Math.floor(now / 1000) }, bob.username);
        await accountData.erase(db, await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(deletion.body.deletion_id));
        for (const table of ['user_passkeys', 'passkey_challenges']) assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(bob.id)).n, 0);
        assert.equal((await assertion(bobDevice)).r.status, 401, 'deleted account key refused');
        console.log('Passkeys: real ES256 registration/sign-in, origin/RP/UV, expiry/replay, account isolation, second factor, one-use recovery/proof, removal, export and flag-off checks passed');
    } finally { Date.now = realNow; server.close(); await globalThis.__ovNetworkTestDbClose?.(); }
})().catch(err => { console.error('Passkey tests failed (assertion details redacted)'); console.error(String(err.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4).join('\n')); process.exitCode = 1; });
