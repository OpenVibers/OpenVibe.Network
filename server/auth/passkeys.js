'use strict';
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const webauthn = require('@simplewebauthn/server');
const mfa = require('./mfa');
const RP = 'openvibe.network';
const ORIGIN = 'https://openvibe.network';
const COOKIE = '__Host-ov_passkey';
const cookie = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = mfa.hash;
const liveUser = u => u && !u.is_banned && !u.deleted_at && !u.merged_into;
const binding = req => req.tokenClaims?.jti || '';
async function list(db, id) { return db.prepare('SELECT * FROM user_passkeys WHERE user_id = ? ORDER BY created_at').all(id); }
async function save(db, purpose, challenge, user, bind) {
    const token = random();
    await db.prepare('DELETE FROM passkey_challenges WHERE expires_at <= ?').run(Date.now());
    await db.prepare('INSERT INTO passkey_challenges (token_hash, user_id, purpose, challenge, binding, credential_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(hash(token), user?.id || null, purpose, challenge, bind, user ? hash(user.password_hash) : '', Date.now() + 300000);
    return token;
}
async function take(db, token, purpose, bind) {
    if (typeof token !== 'string' || token.length > 100) return null;
    return db.prepare('DELETE FROM passkey_challenges WHERE token_hash = ? AND purpose = ? AND binding = ? AND expires_at > ? RETURNING *').get(hash(token), purpose, bind, Date.now());
}
// Inside the locked account transaction. Each management proof authorizes one operation.
async function authorize(db, req) {
    if (!binding(req) || typeof req.body.password !== 'string' || !await bcrypt.compare(req.body.password, req.user.password_hash)) return false;
    const f = await mfa.factor(db, req.user.id, true);
    if (!f?.secret_ciphertext && !(await list(db, req.user.id)).length) return true;
    const proof = await take(db, req.body.proof, 'proof', binding(req));
    if (proof && proof.user_id === req.user.id && proof.credential_hash === hash(req.user.password_hash)) return true;
    return !!f && await mfa.consume(db, f, mfa.cleanCode(req.body.code), Date.now());
}
function router({ requireAuth, signToken, sanitizeUser }) {
    const r = express.Router();
    // The server-to-server related routes have their own per-client limit (one address for every product).
    r.use(rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false, skip: req => String(req.path).startsWith('/related/') }));
    r.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
        if (req.headers.origin && req.headers.origin !== ORIGIN) return res.status(403).json({ error: 'Network origin required' });
        if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Same-site request required' });
        next();
    });
    const route = fn => async (req, res) => { try { await fn(req, res, req.app.locals.db); } catch { res.status(503).json({ error: 'Passkey service unavailable' }); } };
    const fail = res => res.status(401).json({ error: 'Passkey or authentication state invalid' });
    async function options(req, res, db, purpose) {
        const options = await webauthn.generateAuthenticationOptions({ rpID: RP, userVerification: 'required', ...(purpose === 'reauth' ? { allowCredentials: (await list(db, req.user.id)).map(k => ({ id: k.id })) } : {}) });
        const pending = req.cookies?.['__Host-ov_mfa_pending'];
        // A password challenge is bound at creation; it cannot later switch accounts.
        const bind = purpose === 'reauth' ? binding(req) : (pending ? hash(pending) : '');
        const token = await save(db, purpose, options.challenge, purpose === 'reauth' ? req.user : null, bind);
        res.cookie(COOKIE, token, { ...cookie, maxAge: 300000 });
        res.json(options);
    }
    async function verify(req, res, db, purpose) {
        const pending = req.cookies?.['__Host-ov_mfa_pending'];
        const bind = purpose === 'reauth' ? binding(req) : (pending ? hash(pending) : '');
        const result = await db.tx(async () => {
            const token = req.cookies?.[COOKIE];
            if (typeof token !== 'string' || token.length > 100) return null;
            const c = await db.prepare('SELECT * FROM passkey_challenges WHERE token_hash = ? AND purpose = ? AND binding = ? AND expires_at > ?').get(hash(token), purpose, bind, Date.now());
            if (!c || !req.body.response || typeof req.body.response.id !== 'string') return null;
            const key = await db.prepare('SELECT * FROM user_passkeys WHERE id = ?').get(req.body.response.id);
            if (!key || (c.user_id && c.user_id !== key.user_id)) return null;
            const u = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(key.user_id);
            if (!liveUser(u) || (c.user_id && c.credential_hash !== hash(u.password_hash))) return null;
            if (!await take(db, token, purpose, bind)) return null;
            const f = await mfa.factor(db, u.id, true);
            if (!f || Number(f.locked_until) > Date.now()) return null;
            if (bind && purpose === 'login') {
                const p = await db.prepare('SELECT * FROM mfa_challenges WHERE token_hash = ?').get(bind);
                if (!p || p.user_id !== u.id || p.generation !== f.generation || p.credential_hash !== hash(u.password_hash) || Number(p.expires_at) <= Date.now()) return null;
            }
            // Re-read after the account lock: removal and concurrent assertions serialize here.
            const current = await db.prepare('SELECT * FROM user_passkeys WHERE id = ?').get(key.id);
            if (!current) return null;
            let checked;
            try {
                checked = await webauthn.verifyAuthenticationResponse({ response: req.body.response, expectedChallenge: c.challenge,
                    expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: true,
                    credential: { id: current.id, publicKey: new Uint8Array(Buffer.from(current.public_key, 'base64url')), counter: Number(current.counter) } });
            } catch { checked = { verified: false }; }
            if (!checked.verified || (req.body.response.response.userHandle ? req.body.response.response.userHandle !== f.passkey_handle : purpose === 'login')) {
                const failures = Number(f.locked_until) > 0 ? 1 : f.failures + 1;
                await db.prepare('UPDATE user_mfa SET failures = ?, locked_until = ? WHERE user_id = ?').run(failures, failures >= 5 ? Date.now() + 300000 : 0, u.id);
                return null;
            }
            await db.prepare('UPDATE user_passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?').run(checked.authenticationInfo.newCounter, checked.authenticationInfo.credentialBackedUp, Date.now(), key.id);
            await db.prepare('UPDATE user_mfa SET failures = 0, locked_until = 0 WHERE user_id = ?').run(u.id);
            if (purpose === 'reauth') return { proof: await save(db, 'proof', '', u, binding(req)) };
            if (bind) await db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').run(bind);
            return { user: u };
        });
        res.clearCookie(COOKIE, cookie);
        if (!result) return fail(res);
        if (result.proof) return res.json({ proof: result.proof });
        res.clearCookie('__Host-ov_mfa_pending', cookie);
        const token = signToken(result.user, req.app.locals.privateKey, req.app.locals.config);
        require('./session').setSessionCookies(res, token);
        res.json({ token, user: sanitizeUser(result.user) });
    }
    r.post('/login/options', route((req, res, db) => options(req, res, db, 'login')));
    // Cross-site passkeys (Related Origin Requests): a product's server, authenticated as its OAuth
    // client, gets and verifies one ceremony. Mounted before requireAuth: the client is the caller.
    r.use('/related', require('./passkeys-related').router());
    r.post('/login/verify', route((req, res, db) => verify(req, res, db, 'login')));
    r.use(requireAuth);
    r.get('/', route(async (req, res, db) => res.json({ available: await mfa.allowed(db, req.user), keys: (await list(db, req.user.id)).map(({ id, name, created_at, last_used_at, device_type, backed_up }) => ({ id, name, created_at, last_used_at, device_type, backed_up })) })));
    r.post('/reauth/options', route((req, res, db) => options(req, res, db, 'reauth')));
    r.post('/reauth/verify', route((req, res, db) => verify(req, res, db, 'reauth')));
    r.post('/register/options', route(async (req, res, db) => {
        if (!await mfa.allowed(db, req.user)) return res.status(404).json({ error: 'Not available' });
        const out = await db.tx(async () => {
            req.user = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(req.user.id);
            if (!await authorize(db, req)) return null;
            const keys = await list(db, req.user.id);
            if (keys.length >= 10) return null;
            await db.prepare('INSERT INTO user_mfa (user_id, generation, passkey_handle) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING').run(req.user.id, random(), random());
            await db.prepare('UPDATE user_mfa SET passkey_handle = ? WHERE user_id = ? AND passkey_handle IS NULL').run(random(), req.user.id);
            const f = await mfa.factor(db, req.user.id);
            const options = await webauthn.generateRegistrationOptions({ rpName: 'OpenVibe.Network', rpID: RP, userName: req.user.username,
                userID: new Uint8Array(Buffer.from(f.passkey_handle, 'base64url')), attestationType: 'none',
                excludeCredentials: keys.map(k => ({ id: k.id })), authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
            const state = await save(db, 'register', options.challenge, req.user, binding(req));
            return { options, state };
        });
        if (!out) return fail(res);
        res.json(out);
    }));
    r.post('/register/verify', route(async (req, res, db) => {
        if (!await mfa.allowed(db, req.user)) return res.status(404).json({ error: 'Not available' });
        const out = await db.tx(async () => {
            const u = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(req.user.id);
            const c = await take(db, req.body.state, 'register', binding(req));
            if (!c || c.user_id !== u.id || c.credential_hash !== hash(u.password_hash) || !liveUser(u) || (await list(db, u.id)).length >= 10) return null;
            let checked;
            try {
                const client = JSON.parse(Buffer.from(req.body.response.response.clientDataJSON, 'base64url').toString());
                if (client.crossOrigin || client.topOrigin) return null;
                checked = await webauthn.verifyRegistrationResponse({ response: req.body.response, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: true }); } catch { return null; }
            if (!checked.verified) return null;
            const info = checked.registrationInfo;
            if (await db.prepare('SELECT id FROM user_passkeys WHERE id = ?').get(info.credential.id)) return null;
            const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
            await db.prepare('INSERT INTO user_passkeys (id, user_id, public_key, counter, name, device_type, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(info.credential.id, u.id, Buffer.from(info.credential.publicKey).toString('base64url'), info.credential.counter, name || 'Passkey', info.credentialDeviceType, info.credentialBackedUp, Date.now());
            await db.prepare('INSERT INTO user_mfa (user_id, generation) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING').run(u.id, random());
            let codes = [];
            if (!(await db.prepare('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = ?').get(u.id))) {
                codes = Array.from({ length: 10 }, () => crypto.randomBytes(10).toString('hex').toUpperCase());
                for (const code of codes) await db.prepare('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)').run(u.id, await bcrypt.hash(code, 10));
            }
            await invalidate(db, u.id);
            return { ok: true, recovery_codes: codes };
        });
        if (!out) return fail(res);
        res.json(out);
    }));
    r.post('/remove', route(async (req, res, db) => {
        const ok = await db.tx(async () => {
            req.user = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(req.user.id);
            if (!await authorize(db, req)) return false;
            const removed = await db.prepare('DELETE FROM user_passkeys WHERE id = ? AND user_id = ?').run(typeof req.body.id === 'string' ? req.body.id : '', req.user.id);
            if (!removed.changes) return false;
            await invalidate(db, req.user.id);
            if (!(await list(db, req.user.id)).length && !(await mfa.factor(db, req.user.id))?.secret_ciphertext) {
                await db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(req.user.id);
            }
            return true;
        });
        if (!ok) return fail(res);
        res.json({ ok: true });
    }));
    return r;
}
async function invalidate(db, userId) {
    await db.prepare('UPDATE user_mfa SET generation = ?, pending_secret_ciphertext = NULL, pending_until = 0 WHERE user_id = ?').run(random(), userId);
    for (const t of ['passkey_challenges', 'mfa_challenges', 'mfa_devices']) await db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
}
module.exports = { router, list, authorize, save, take, hash };
