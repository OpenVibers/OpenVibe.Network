'use strict';
const crypto = require('crypto');
const OTPAuth = require('otpauth');
const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const MINUTE = 60000;
const DEVICE_AGE = 30 * 24 * 60 * MINUTE;
const PENDING_COOKIE = '__Host-ov_mfa_pending';
const DEVICE_COOKIE = '__Host-ov_mfa_device';
const cookie = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
function keys() {
    const raw = process.env.NETWORK_MFA_KEY || '';
    if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error('MFA unavailable');
    const derive = label => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), `network-mfa-${label}-v1`, 32));
    return { enc: derive('encryption'), sign: derive('device') };
}
function seal(secret, userId) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keys().enc, iv);
    c.setAAD(Buffer.from(`totp:${userId}`));
    const data = Buffer.concat([c.update(secret), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
function open(ciphertext, userId) {
    const b = Buffer.from(ciphertext, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', keys().enc, b.subarray(0, 12));
    d.setAAD(Buffer.from(`totp:${userId}`)); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString();
}
function totp(secret) { return new OTPAuth.TOTP({ issuer: 'OpenVibe.Network', label: 'OpenVibe', algorithm: 'SHA1', digits: 6, period: 30, secret }); }
function validStep(secret, code, now) {
    if (!/^\d{6}$/.test(code)) return null;
    const delta = totp(secret).validate({ token: code, timestamp: now, window: 1 });
    return delta === null ? null : Math.floor(now / 30000) + delta;
}
async function allowed(db, user) {
    try { keys(); } catch { return false; }
    const flag = await db.getSetting('mfa_enrollment');
    return flag === 'all' || ((flag === 'pilot' || process.env.NETWORK_MFA_PILOT === '1') && ['ovprobe_merge_keep', (process.env.OWNER_USERNAME || 'goosely').toLowerCase()].includes(user.username.toLowerCase()));
}
async function factor(db, userId, lock = false) {
    return db.prepare(`SELECT * FROM user_mfa WHERE user_id = ?${lock ? ' FOR UPDATE' : ''}`).get(userId);
}
function deviceSignature(token) { return crypto.createHmac('sha256', keys().sign).update(token).digest('base64url'); }
async function remembered(db, req, user, f, now) {
    const value = req.cookies?.[DEVICE_COOKIE];
    if (typeof value !== 'string' || value.length > 200) return false;
    const [token, sig] = value.split('.');
    const expect = deviceSignature(token);
    if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
    return !!await db.prepare('SELECT id FROM mfa_devices WHERE user_id = ? AND token_hash = ? AND generation = ? AND expires_at > ?').get(user.id, hash(token), f.generation, now);
}
// Returns true only when the password route must stop before issuing any session.
async function challengeLogin(db, req, res, user) {
    const f = await factor(db, user.id);
    if (!f || (!f.secret_ciphertext && !(await require('./passkeys').list(db, user.id)).length)) return false;
    keys(); // Fail closed even when enrollment is disabled or encryption configuration is missing.
    const now = Date.now();
    if (await remembered(db, req, user, f, now)) return false;
    if (Number(f.locked_until) > now) { res.status(429).json({ error: 'Please wait before trying another code.' }); return true; }
    const token = random();
    await db.tx(async () => {
        // Keep at most one pending sign-in per account; failures survive new passwords/challenges.
        await factor(db, user.id, true);
        await db.prepare('DELETE FROM mfa_challenges WHERE user_id = ? OR expires_at <= ?').run(user.id, now);
        await db.prepare('INSERT INTO mfa_challenges (token_hash, user_id, credential_hash, generation, expires_at) VALUES (?, ?, ?, ?, ?)')
            .run(hash(token), user.id, hash(user.password_hash), f.generation, now + 5 * MINUTE);
    });
    res.cookie(PENDING_COOKIE, token, { ...cookie, maxAge: 5 * MINUTE });
    res.status(202).json({ mfa_required: true });
    return true;
}
// Called only with the person's factor row locked. Failure counters commit even on rejection.
async function consume(db, f, code, now, enrollment = false) {
    if (Number(f.locked_until) > now) return false;
    const ciphertext = enrollment ? f.pending_secret_ciphertext : f.secret_ciphertext;
    if (enrollment && (!ciphertext || Number(f.pending_until) <= now)) return false;
    let ok = false;
    const step = ciphertext ? validStep(open(ciphertext, f.user_id), code, now) : null;
    if (step !== null && step > Number(f.last_step)) {
        await db.prepare('UPDATE user_mfa SET last_step = ? WHERE user_id = ?').run(step, f.user_id);
        ok = true;
    } else if (!enrollment && /^[A-F0-9]{20}$/.test(code)) {
        const candidates = await db.prepare('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL').all(f.user_id);
        for (const candidate of candidates) {
            if (await bcrypt.compare(code, candidate.code_hash)) {
                ok = (await db.prepare('UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(now, f.user_id, candidate.code_hash)).changes === 1;
                break;
            }
        }
    }
    const failures = ok ? 0 : (Number(f.locked_until) > 0 ? 1 : f.failures + 1);
    await db.prepare('UPDATE user_mfa SET failures = ?, locked_until = ? WHERE user_id = ?').run(failures, failures >= 5 ? now + 5 * MINUTE : 0, f.user_id);
    return ok;
}
const cleanCode = value => typeof value === 'string' ? value.replace(/[-\s]/g, '').toUpperCase().slice(0, 80) : '';
function router({ requireAuth, signToken, sanitizeUser }) {
    const r = express.Router();
    r.use(rateLimit({ windowMs: MINUTE, max: 30, standardHeaders: true, legacyHeaders: false }));
    r.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        // No HTML form submissions, including cross-site login CSRF. Account hub uses Bearer + JSON.
        if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
        if (req.headers['sec-fetch-site'] === 'cross-site' && !req.headers.authorization) return res.status(403).json({ error: 'Same-site request required' });
        next();
    });
    const route = fn => async (req, res) => { try { await fn(req, res, req.app.locals.db); } catch { res.status(503).json({ error: 'Authenticator service unavailable' }); } };
    r.post('/verify', route(async (req, res, db) => {
        const pending = req.cookies?.[PENDING_COOKIE];
        if (typeof pending !== 'string' || pending.length > 100) return res.status(401).json({ error: 'Sign in again' });
        const now = Date.now();
        let device;
        const user = await db.tx(async () => {
            const c = await db.prepare('SELECT * FROM mfa_challenges WHERE token_hash = ?').get(hash(pending));
            if (!c || Number(c.expires_at) <= now) return null;
            await db.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(c.user_id);
            const f = await factor(db, c.user_id, true);
            const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id);
            if (!f || (!f.secret_ciphertext && !(await require('./passkeys').list(db, c.user_id)).length) || f.generation !== c.generation || !u || u.is_banned || u.deleted_at || u.merged_into || hash(u.password_hash) !== c.credential_hash) return null;
            if (!await db.prepare('SELECT token_hash FROM mfa_challenges WHERE token_hash = ?').get(hash(pending))) return null;
            if (!await consume(db, f, cleanCode(req.body.code), now)) return null;
            await db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').run(hash(pending));
            if (req.body.remember === true) {
                device = random();
                await db.prepare('DELETE FROM mfa_devices WHERE user_id = ? AND expires_at <= ?').run(u.id, now);
                await db.prepare('INSERT INTO mfa_devices (id, user_id, token_hash, generation, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(crypto.randomUUID(), u.id, hash(device), f.generation, now, now + DEVICE_AGE);
            }
            return u;
        });
        if (!user) return res.status(401).json({ error: 'Code or sign-in state invalid. Try again or sign in again after five minutes.' });
        if (device) res.cookie(DEVICE_COOKIE, `${device}.${deviceSignature(device)}`, { ...cookie, maxAge: DEVICE_AGE });
        res.clearCookie(PENDING_COOKIE, cookie);
        const token = signToken(user, req.app.locals.privateKey, req.app.locals.config);
        require('./session').setSessionCookies(res, token);
        res.json({ token, user: sanitizeUser(user) });
    }));
    r.use(requireAuth);
    r.get('/', route(async (req, res, db) => {
        const f = await factor(db, req.user.id);
        res.json({ available: await allowed(db, req.user), enabled: !!f?.secret_ciphertext,
            devices: await db.prepare('SELECT id, created_at, expires_at FROM mfa_devices WHERE user_id = ? AND expires_at > ?').all(req.user.id, Date.now()) });
    }));
    r.post('/enroll', route(async (req, res, db) => {
        if (!await allowed(db, req.user)) return res.status(404).json({ error: 'Not available' });
        if (typeof req.body.password !== 'string' || !bcrypt.compareSync(req.body.password, req.user.password_hash)) return res.status(401).json({ error: 'Current password required' });
        const secret = new OTPAuth.Secret({ size: 20 }).base32;
        const result = await db.tx(async () => {
            req.user = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(req.user.id);
            if ((await require('./passkeys').list(db, req.user.id)).length && !await require('./passkeys').authorize(db, req)) return false;
            await db.prepare('INSERT INTO user_mfa (user_id, generation) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING').run(req.user.id, random());
            const f = await factor(db, req.user.id, true);
            if (f.secret_ciphertext || Number(f.locked_until) > Date.now()) return false;
            await db.prepare('UPDATE user_mfa SET pending_secret_ciphertext = ?, pending_until = ? WHERE user_id = ?').run(seal(secret, req.user.id), Date.now() + 10 * MINUTE, req.user.id);
            return true;
        });
        if (!result) return res.status(409).json({ error: 'Already enabled or temporarily locked' });
        res.json({ secret, qr: await QRCode.toDataURL(totp(secret).toString()) });
    }));
    r.post('/confirm', route(async (req, res, db) => {
        if (!await allowed(db, req.user)) return res.status(404).json({ error: 'Not available' });
        const codes = await db.tx(async () => {
            await db.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(req.user.id);
            const f = await factor(db, req.user.id, true);
            if (!f || f.secret_ciphertext || !await consume(db, f, cleanCode(req.body.code), Date.now(), true)) return null;
            const codes = Array.from({ length: 10 }, () => crypto.randomBytes(10).toString('hex').toUpperCase());
            await db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(req.user.id);
            for (const code of codes) await db.prepare('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)').run(req.user.id, await bcrypt.hash(code, 10));
            await db.prepare('UPDATE user_mfa SET secret_ciphertext = pending_secret_ciphertext, pending_secret_ciphertext = NULL, pending_until = 0, enabled_at = ? WHERE user_id = ?').run(Date.now(), req.user.id);
            for (const table of ['passkey_challenges', 'mfa_challenges', 'mfa_devices']) await db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(req.user.id);
            return codes;
        });
        if (!codes) return res.status(401).json({ error: 'Code or enrollment invalid' });
        res.json({ recovery_codes: codes });
    }));
    r.post('/disable', route(async (req, res, db) => {
        const ok = await db.tx(async () => {
            await db.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(req.user.id);
            const f = await factor(db, req.user.id, true);
            if (!f || !await consume(db, f, cleanCode(req.body.code), Date.now())) return false;
            if ((await require('./passkeys').list(db, req.user.id)).length) {
                await db.prepare('UPDATE user_mfa SET secret_ciphertext = NULL, pending_secret_ciphertext = NULL, generation = ? WHERE user_id = ?').run(random(), req.user.id);
                for (const table of ['mfa_challenges', 'mfa_devices', 'passkey_challenges']) await db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(req.user.id);
            } else {
                for (const table of ['mfa_recovery_codes', 'mfa_challenges', 'mfa_devices', 'user_mfa']) await db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(req.user.id);
            }
            return true;
        });
        res.status(ok ? 200 : 401).json(ok ? { ok: true } : { error: 'Code invalid' });
    }));
    r.post('/devices/revoke', route(async (req, res, db) => {
        const id = typeof req.body.id === 'string' ? req.body.id : '';
        await db.prepare('DELETE FROM mfa_devices WHERE user_id = ? AND id = ?').run(req.user.id, id);
        res.json({ ok: true });
    }));
    return r;
}
module.exports = { router, challengeLogin, validStep, totp, hash, allowed, factor, consume, cleanCode };
