'use strict';
/**
 * Sign in on another device (owner, 2026-11-04; NETWORK_QR_SIGNIN, off by default).
 *
 * A signed-in source device starts a transfer (POST /auth/qr/start). The QR carries
 * https://<network>/q#<id>.<secret>; the secret lives in the fragment, so no server log or
 * Referer ever sees it. The target device reads the fragment, posts it to /auth/qr/scan, and gets a
 * two-digit match code plus an httpOnly ov_qr cookie (path /auth/qr) that binds the transfer to
 * that browser. The source device approves the match code from the session that created the transfer;
 * the target's next /auth/qr/status poll creates an ordinary Network session (the same signToken +
 * setSessionCookies a password sign-in uses), exactly once.
 *
 * Security notes:
 *   - secret, match code and ov_qr nonce are stored only as SHA-256;
 *   - every unknown id, bad secret or expired transfer answers the same 404;
 *   - approval needs the creating session (its jti), not merely the same person;
 *   - status completes only with the ov_qr cookie and an atomic approved -> used update;
 *   - nothing here logs a secret, a code, an email or an IP, and audit_log details carry none of them.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { setSessionCookies } = require('./session');
const accountAliases = require('../identity/account-aliases');

const COOKIE = 'ov_qr';
const COOKIE_PATH = '/auth/qr';
const COOKIE_MAX_AGE_MS = 300 * 1000;
const TTL_MS = 120 * 1000;
const MAX_LIVE = 3;
const MAX_ATTEMPTS = 3;
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SECRET_RE = /^[0-9a-f]{32}$/;
const CODE_RE = /^[0-9]{2}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Is the feature on? Config reads NETWORK_QR_SIGNIN (server/config.js); off means the router is not mounted. */
function enabled(config = require('../config')) {
    return !!(config && config.qrSignin && config.qrSignin.enabled);
}

/** A ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32. */
function newUlid(ms = Date.now()) {
    let time = '';
    let t = ms;
    for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
    let rand = '';
    for (let i = 0; i < 16; i++) rand += CROCKFORD[crypto.randomInt(0, 32)];
    return time + rand;
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const secretHash = (secret) => sha256(`qr-secret:${secret}`);
const codeHash = (code) => sha256(`qr-code:${code}`);
const nonceHash = (nonce) => sha256(`qr-nonce:${nonce}`);

function sameHash(stored, presented) {
    const a = Buffer.from(String(stored || ''), 'hex');
    const b = Buffer.from(String(presented || ''), 'hex');
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** "iPhone · Safari" from the User-Agent. Browser and OS only: never an IP, never the raw UA. */
function deviceSummary(userAgent) {
    const ua = String(userAgent || '');
    let device = 'Device';
    if (/iPhone/i.test(ua)) device = 'iPhone';
    else if (/iPad/i.test(ua)) device = 'iPad';
    else if (/Android/i.test(ua)) device = 'Android';
    else if (/Macintosh|Mac OS X/i.test(ua)) device = 'Mac';
    else if (/Windows/i.test(ua)) device = 'Windows';
    else if (/Linux/i.test(ua)) device = 'Linux';
    let browser = 'Browser';
    if (/EdgA?\//i.test(ua)) browser = 'Edge';
    else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Internet';
    else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox';
    else if (/Chrome|CriOS/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua)) browser = 'Safari';
    return `${device} · ${browser}`.slice(0, 80);
}

/** The source session that created a transfer: its jti, or a stable hash for a token minted before jti. */
function creatorOf(req) {
    const jti = req.tokenClaims && req.tokenClaims.jti;
    return jti ? String(jti) : `tok:${sha256(req.token || '')}`;
}

/** A same-origin browser request. No Origin (curl, server-to-server) is allowed; a foreign one is not. */
function sameOrigin(req, config) {
    const origin = req.headers && req.headers.origin;
    if (!origin) return true;
    let got;
    try { got = new URL(origin); } catch { return false; }
    if (got.protocol !== 'https:' && got.protocol !== 'http:') return false;
    const allowed = new Set();
    for (const raw of [config.networkUrl, config.baseUrl, config.loginUrl]) {
        try { allowed.add(new URL(raw).origin); } catch { /* unset */ }
    }
    // The request's own host (local development, and a white-label install that names no URL). In
    // production the configured https origin above is the rule; an http spelling from a proxy is not added.
    if (req.get && req.get('host')) {
        const candidate = `${req.protocol}://${req.get('host')}`;
        if (config.nodeEnv !== 'production' || allowed.has(candidate)) allowed.add(candidate);
    }
    return allowed.has(got.origin);
}

async function audit(db, userId, action, details) {
    try {
        await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
            .run(userId, action, JSON.stringify(details));
    } catch { /* audit is best effort: it never fails a sign-in */ }
}

function publicUser(user) {
    return { id: user.id, username: user.username, display_name: user.display_name || user.username, avatar_url: user.avatar_url || null };
}

function createQrSignin({ db, config, privateKey, signToken, requireAuth, notifications = null, now = () => Date.now() }) {
    const router = express.Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    // A browser POST must come from this Network origin, whatever first-party CORS would otherwise allow.
    router.use((req, res, next) => {
        if (req.method === 'POST' && !sameOrigin(req, config)) return res.status(403).json({ error: 'origin not allowed' });
        next();
    });

    // 10 starts per person per hour. Signed-out requests never reach it (requireAuth first).
    const startLimit = rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        validate: false,
        keyGenerator: (req) => `qr-start:${req.user ? req.user.id : 'none'}`,
        handler: (_req, res) => res.status(429).json({ error: 'too_many_codes', error_description: 'You have asked for 10 codes this hour. Try again later.' }),
    });

    const notFound = (res) => res.status(404).json({ error: 'not_found' });
    const liveSince = () => new Date(now()).toISOString();

    async function transferById(id) {
        if (!ID_RE.test(String(id || ''))) return null;
        return await db.prepare(`SELECT t.*, u.username, u.display_name, u.avatar_url, u.is_banned, u.deleted_at, u.merged_into
            FROM qr_signin_transfers t JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(String(id));
    }

    // ── Start (source device, signed in) ───────────────────────
    router.post('/start', requireAuth, startLimit, async (req, res) => {
        const id = newUlid(now());
        const secret = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(now() + TTL_MS).toISOString();
        // The target session inherits this, never a new "now": scanning a code is not a re-authentication.
        const sourceAuthTime = Number.isFinite(Number(req.tokenClaims && req.tokenClaims.auth_time))
            ? Math.trunc(Number(req.tokenClaims.auth_time)) : null;
        const base = config.networkUrl || config.baseUrl || 'https://openvibe.network';
        const url = new URL('/q', base);
        url.hash = `${id}.${secret}`;

        let qrSvg;
        try {
            qrSvg = await QRCode.toString(url.toString(), {
                type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 232,
                color: { dark: '#0d0d14', light: '#ffffff' },
            });
        } catch {
            return res.status(500).json({ error: 'qr_unavailable' });
        }

        const created = await db.tx(async (t) => {
            // One row lock per person: two tabs cannot both take the third live slot, and the hourly
            // count in audit_log holds across processes (the in-memory limiter above is only a shortcut).
            await t.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(req.user.id);
            const starts = (await t.prepare("SELECT COUNT(*) AS n FROM qr_signin_starts WHERE user_id = ? AND created_at > datetime(ov_now(), '-1 hour')").get(req.user.id)).n;
            if (Number(starts) >= 10) return 'rate';
            const live = (await t.prepare("SELECT COUNT(*) AS n FROM qr_signin_transfers WHERE user_id = ? AND status IN ('waiting','scanned','approved') AND expires_at > ?").get(req.user.id, liveSince())).n;
            if (Number(live) >= MAX_LIVE) return 'live';
            await t.prepare('INSERT INTO qr_signin_starts (user_id) VALUES (?)').run(req.user.id);
            await t.prepare(`INSERT INTO qr_signin_transfers (id, user_id, secret_hash, creator_jti, source_auth_time, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(id, req.user.id, secretHash(secret), creatorOf(req), sourceAuthTime, expiresAt);
            await t.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
                .run(req.user.id, 'qr_signin_started', JSON.stringify({ transfer_id: id, device: null, outcome: 'waiting' }));
            return 'ok';
        });
        if (created === 'live') return res.status(429).json({ error: 'too_many_codes', error_description: 'Finish or cancel a code you already have first.' });
        if (created !== 'ok') return res.status(429).json({ error: 'too_many_codes', error_description: 'You have asked for 10 codes this hour. Try again later.' });

        res.status(201).json({ id, expires_at: expiresAt, url: url.toString(), qr_svg: qrSvg });
    });

    // ── Scan (target device, public but secret-gated) ──────────
    router.post('/scan', async (req, res) => {
        const id = String((req.body && req.body.id) || '').trim();
        const secret = String((req.body && req.body.secret) || '').trim();
        if (!ID_RE.test(id) || !SECRET_RE.test(secret)) return notFound(res);

        const row = await transferById(id);
        if (!row) return notFound(res);
        if (row.expires_at <= liveSince()) return notFound(res);
        if (!sameHash(row.secret_hash, secretHash(secret))) return notFound(res);
        if (row.status !== 'waiting') return res.status(409).json({ error: 'already used on another device' });

        const code = String(crypto.randomInt(10, 100));
        const nonce = crypto.randomBytes(16).toString('hex');
        const targetDevice = deviceSummary(req.headers['user-agent']);
        const scannedAt = new Date(now()).toISOString();
        const won = await db.prepare(`UPDATE qr_signin_transfers SET status = 'scanned', code_hash = ?, target_nonce_hash = ?,
            device_summary = ?, scanned_at = ? WHERE id = ? AND status = 'waiting' AND expires_at > ?`)
            .run(codeHash(code), nonceHash(nonce), targetDevice, scannedAt, id, liveSince());
        if (!won.changes) {
            const after = await transferById(id);
            if (!after || after.expires_at <= liveSince()) return notFound(res);
            return res.status(409).json({ error: 'already used on another device' });
        }

        res.cookie(COOKIE, nonce, {
            httpOnly: true, secure: true, sameSite: 'lax', path: COOKIE_PATH, maxAge: COOKIE_MAX_AGE_MS,
        });
        await audit(db, row.user_id, 'qr_signin_scanned', { transfer_id: id, device: targetDevice, outcome: 'scanned' });
        res.json({ code, user_hint: { display_name: row.display_name || row.username, avatar_url: row.avatar_url || null } });
    });

    // ── Target status (ov_qr cookie) ───────────────────────────
    // Defined before /:id so "status" is not read as a transfer id.
    router.get('/status', async (req, res) => {
        const nonce = String((req.cookies && req.cookies[COOKIE]) || '');
        if (!/^[0-9a-f]{32}$/.test(nonce)) return notFound(res);
        const row = await db.prepare(`SELECT t.*, u.username, u.display_name, u.avatar_url, u.is_banned, u.deleted_at, u.merged_into
            FROM qr_signin_transfers t JOIN users u ON u.id = t.user_id WHERE t.target_nonce_hash = ?`).get(nonceHash(nonce));
        if (!row) return notFound(res);
        if (row.expires_at <= liveSince()) {
            res.clearCookie(COOKIE, { path: COOKIE_PATH, sameSite: 'lax', secure: true, httpOnly: true });
            return notFound(res);
        }

        if (row.status === 'waiting') return res.json({ state: 'waiting' });
        if (row.status === 'scanned') return res.json({ state: 'scanned' });
        if (row.status === 'denied') {
            res.clearCookie(COOKIE, { path: COOKIE_PATH, sameSite: 'lax', secure: true, httpOnly: true });
            return res.json({ state: 'denied' });
        }
        if (row.status === 'used') {
            res.clearCookie(COOKIE, { path: COOKIE_PATH, sameSite: 'lax', secure: true, httpOnly: true });
            return res.json({ state: 'used', signed_in: false });
        }

        // status === 'approved': exactly one poll may create the session.
        const result = await db.tx(async (t) => {
            const user = await t.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
            if (!user || user.is_banned || user.deleted_at) {
                await t.prepare("UPDATE qr_signin_transfers SET status = 'denied' WHERE id = ? AND status = 'approved'").run(row.id);
                return { denied: true };
            }
            const survivor = await accountAliases.effectiveUser(t, user);
            if (!survivor || survivor.is_banned || survivor.deleted_at) {
                await t.prepare("UPDATE qr_signin_transfers SET status = 'denied' WHERE id = ? AND status = 'approved'").run(row.id);
                return { denied: true };
            }
            const won = await t.prepare(`UPDATE qr_signin_transfers SET status = 'used', used_at = ?
                WHERE id = ? AND status = 'approved' AND expires_at > ?`).run(new Date(now()).toISOString(), row.id, liveSince());
            if (!won.changes) return { lost: true };

            // A QR-created session is not a fresh sign-in: inherit the source session's auth_time (or none),
            // so the owner's key/money check still require a real re-authentication.
            const authTime = row.source_auth_time == null ? null : Number(row.source_auth_time);
            const token = signToken(survivor, privateKey, config, { authTime });
            // The device summary only: no raw User-Agent and no IP in the target's session row.
            await t.prepare(`INSERT INTO user_sessions (user_id, session_token, device_name, expires_at)
                VALUES (?, ?, ?, ?)`).run(
                survivor.id, crypto.randomUUID(), row.device_summary || 'Device',
                new Date(now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            );
            return { token, user: survivor };
        });

        if (result.denied) {
            res.clearCookie(COOKIE, { path: COOKIE_PATH, sameSite: 'lax', secure: true, httpOnly: true });
            return res.json({ state: 'denied' });
        }
        if (result.lost || !result.token) {
            res.clearCookie(COOKIE, { path: COOKIE_PATH, sameSite: 'lax', secure: true, httpOnly: true });
            return res.json({ state: 'used', signed_in: false });
        }

        setSessionCookies(res, result.token);
        res.clearCookie(COOKIE, { path: COOKIE_PATH, sameSite: 'lax', secure: true, httpOnly: true });
        await audit(db, result.user.id, 'qr_signin_used', { transfer_id: row.id, device: row.device_summary || 'Device', outcome: 'used' });
        if (notifications) {
            try {
                await notifications.create({
                    user_id: result.user.id,
                    type: 'GENERIC',
                    category: 'system',
                    priority: 'high',
                    title: 'New sign-in',
                    message: `${row.device_summary || 'Device'} signed in by QR from your other device. If this was not you, sign out everywhere and change your password.`,
                    service: 'network',
                    url: 'https://openvibe.network/my',
                });
            } catch { /* the sign-in stands even if the notice cannot be stored */ }
        }
        res.json({ state: 'used', signed_in: true, user: publicUser(result.user) });
    });

    // ── Poll (source device, creating session) ─────────────────
    router.get('/:id', requireAuth, async (req, res) => {
        const row = await transferById(req.params.id);
        if (!row || row.expires_at <= liveSince()) return notFound(res);
        if (Number(row.user_id) !== Number(req.user.id)) return notFound(res);
        if (row.creator_jti !== creatorOf(req)) return res.status(403).json({ error: 'not_the_creating_session' });
        res.json({ id: row.id, state: row.status, device: row.device_summary || null, expires_at: row.expires_at });
    });

    // ── Approve (source device, creating session) ──────────────
    router.post('/:id/approve', requireAuth, async (req, res) => {
        const row = await transferById(req.params.id);
        if (!row || row.expires_at <= liveSince()) return notFound(res);
        if (Number(row.user_id) !== Number(req.user.id)) return notFound(res);
        if (row.creator_jti !== creatorOf(req)) return res.status(403).json({ error: 'not_the_creating_session' });
        if (row.status === 'approved') return res.json({ state: 'approved' });
        if (row.status === 'used') return res.status(409).json({ error: 'already_used' });
        if (row.status === 'denied') return res.status(403).json({ error: 'denied' });
        if (row.status !== 'scanned') return res.status(409).json({ error: 'not_scanned' });

        const code = String((req.body && req.body.code) || '').trim();
        if (!CODE_RE.test(code)) return res.status(400).json({ error: 'code_required', attempts_left: MAX_ATTEMPTS - Number(row.attempts || 0) });

        if (sameHash(row.code_hash, codeHash(code))) {
            const won = await db.prepare("UPDATE qr_signin_transfers SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'scanned'")
                .run(new Date(now()).toISOString(), row.id);
            if (!won.changes) {
                const after = await transferById(row.id);
                if (after && after.status === 'approved') return res.json({ state: 'approved' });
                return res.status(409).json({ error: 'already_used' });
            }
            await audit(db, req.user.id, 'qr_signin_approved', { transfer_id: row.id, device: row.device_summary || null, outcome: 'approved' });
            return res.json({ state: 'approved' });
        }

        // A wrong number counts, atomically: exactly three wrong attempts deny the transfer.
        const result = await db.tx(async (t) => {
            const current = await t.prepare('SELECT status, attempts FROM qr_signin_transfers WHERE id = ? FOR UPDATE').get(row.id);
            if (!current || current.status !== 'scanned') return { status: current ? current.status : 'missing' };
            const attempts = Number(current.attempts || 0) + 1;
            const denied = attempts >= MAX_ATTEMPTS;
            await t.prepare('UPDATE qr_signin_transfers SET attempts = ?, status = ? WHERE id = ?')
                .run(attempts, denied ? 'denied' : 'scanned', row.id);
            return { status: denied ? 'denied' : 'scanned', attempts, denied };
        });
        if (result.denied) {
            await audit(db, req.user.id, 'qr_signin_denied', { transfer_id: row.id, device: row.device_summary || null, outcome: 'denied' });
            return res.status(403).json({ error: 'denied', attempts_left: 0 });
        }
        if (result.status !== 'scanned') return res.status(409).json({ error: 'not_scanned' });
        res.status(400).json({ error: 'code_mismatch', attempts_left: Math.max(0, MAX_ATTEMPTS - result.attempts) });
    });

    // ── Deny (source device, creating session) ─────────────────
    router.post('/:id/deny', requireAuth, async (req, res) => {
        const row = await transferById(req.params.id);
        if (!row || row.expires_at <= liveSince()) return notFound(res);
        if (Number(row.user_id) !== Number(req.user.id)) return notFound(res);
        if (row.creator_jti !== creatorOf(req)) return res.status(403).json({ error: 'not_the_creating_session' });
        if (row.status === 'used') return res.status(409).json({ error: 'already_used' });
        if (row.status !== 'denied') {
            await db.prepare("UPDATE qr_signin_transfers SET status = 'denied' WHERE id = ? AND status IN ('waiting','scanned','approved')").run(row.id);
            await audit(db, req.user.id, 'qr_signin_denied', { transfer_id: row.id, device: row.device_summary || null, outcome: 'denied' });
        }
        res.json({ state: 'denied' });
    });

    return { router, sweep: (opts) => sweep(db, opts), enabled: enabled(config), page: pageHandler };
}

/** Delete transfers past their two minutes; the audit_log keeps what happened. */
async function sweep(db, { now = Date.now() } = {}) {
    const expired = new Date(now).toISOString();
    const transfers = (await db.prepare('DELETE FROM qr_signin_transfers WHERE expires_at < ?').run(expired)).changes;
    const starts = (await db.prepare("DELETE FROM qr_signin_starts WHERE created_at < datetime(ov_now(), '-2 hours')").run()).changes;
    return transfers + starts;
}

/** The public /q page: static markup plus the shared look-boot script, never cached. */
let targetPageHtml = null;
function targetPage() {
    if (!targetPageHtml) {
        const lookBoot = require('../look-boot');
        targetPageHtml = lookBoot.apply(fs.readFileSync(path.join(__dirname, '..', 'qr-signin', 'q.html'), 'utf8'));
    }
    return targetPageHtml;
}
function pageHandler(_req, res) {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(targetPage());
}

module.exports = {
    createQrSignin, sweep, enabled, pageHandler, deviceSummary, newUlid, sameOrigin, sameHash,
    COOKIE, COOKIE_PATH, TTL_MS, MAX_LIVE, MAX_ATTEMPTS,
};
