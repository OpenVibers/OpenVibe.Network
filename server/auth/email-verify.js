'use strict';
// ═══════════════════════════════════════════════════════════════
// Email verification — proves the user controls the address before OpenVibe will send
// opt-in mail (go-live alerts etc.) to it. Tokens are random, hashed at rest, single-use,
// bound to the exact address they were issued for, and rate-limited per user + globally
// so the endpoint can't be used to spray a stranger's inbox or burn the email budget.
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');

const TOKEN_TTL_MIN = 60;

function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

function baseUrl(req) {
    try { return require('./reset-tokens').buildBaseUrl(req); } catch { /* */ }
    return 'https://openvibe.network';
}

/**
 * Issue + send a verification email. Returns { ok, reason }.
 * reasons: no-email, already-verified, email-disabled, rate-limited, cap
 */
async function sendVerification(req, user, { force = false } = {}) {
    const db = req.app.locals.db;
    const emailService = req.app.locals.emailService;
    if (!user?.email) return { ok: false, reason: 'no-email' };
    if (user.email_verified && !force) return { ok: false, reason: 'already-verified' };
    if (!emailService?.isEnabled) return { ok: false, reason: 'email-disabled' };

    // Per-user: 1 per 3 minutes, N per day (site_settings email_verify_user_daily_cap, default 6).
    const recent = db.prepare("SELECT COUNT(*) AS c FROM email_verification_tokens WHERE user_id = ? AND created_at > datetime('now','-3 minutes')").get(user.id)?.c || 0;
    if (recent > 0) return { ok: false, reason: 'rate-limited' };
    const dayCap = parseInt(db.getSetting('email_verify_user_daily_cap'), 10) || 6;
    const today = db.prepare("SELECT COUNT(*) AS c FROM email_verification_tokens WHERE user_id = ? AND created_at > datetime('now','-1 day')").get(user.id)?.c || 0;
    if (today >= dayCap) return { ok: false, reason: 'cap' };
    // Same address hammered from many accounts (abuse) — 5/day per address.
    const perAddr = db.prepare("SELECT COUNT(*) AS c FROM email_verification_tokens WHERE LOWER(email) = LOWER(?) AND created_at > datetime('now','-1 day')").get(user.email)?.c || 0;
    if (perAddr >= 5) return { ok: false, reason: 'cap' };
    // A bouncing address gets no more mail until the user changes it.
    if (user.email_bounced_at) return { ok: false, reason: 'bounced' };

    const raw = crypto.randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO email_verification_tokens (token_hash, user_id, email, expires_at) VALUES (?, ?, ?, datetime('now', '+${TOKEN_TTL_MIN} minutes'))`)
        .run(hashToken(raw), user.id, user.email);
    const verifyUrl = `${baseUrl(req)}/verify-email?token=${encodeURIComponent(raw)}`;
    const sent = await emailService.sendVerificationEmail({ to: user.email, username: user.display_name || user.username, verifyUrl, expiresMinutes: TOKEN_TTL_MIN });
    return sent ? { ok: true } : { ok: false, reason: 'send-failed' };
}

/** Consume a token. Returns { ok, error? , user? }. */
function consumeToken(db, raw) {
    if (!raw) return { ok: false, error: 'Missing token' };
    const row = db.prepare("SELECT * FROM email_verification_tokens WHERE token_hash = ?").get(hashToken(raw));
    if (!row) return { ok: false, error: 'This verification link is invalid.' };
    if (row.used_at) return { ok: false, error: 'This verification link was already used.' };
    if (new Date(String(row.expires_at).replace(' ', 'T') + 'Z').getTime() < Date.now()) return { ok: false, error: 'This verification link has expired — request a new one from your account page.' };
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) return { ok: false, error: 'Account not found.' };
    if (!user.email || user.email.toLowerCase() !== String(row.email).toLowerCase()) {
        return { ok: false, error: 'Your email address changed since this link was sent — request a new one.' };
    }
    const tx = db.transaction(() => {
        db.prepare("UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(row.token_hash);
        db.prepare("UPDATE users SET email_verified = 1, email_verified_at = CURRENT_TIMESTAMP, email_bounced_at = NULL, email_bounce_reason = NULL WHERE id = ?").run(user.id);
    });
    tx();
    return { ok: true, user };
}

/** Called when a user sets/changes their address: unverify + (best-effort) send a new link. */
function onEmailChanged(req, userId) {
    const db = req.app.locals.db;
    db.prepare('UPDATE users SET email_verified = 0, email_verified_at = NULL, email_bounced_at = NULL, email_bounce_reason = NULL WHERE id = ?').run(userId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (user?.email) sendVerification(req, user).catch(() => {});
}

function routes(requireAuth) {
    const router = express.Router();

    // Status for the account page: { email, verified, bounced, can_resend }
    router.get('/email/status', requireAuth, (req, res) => {
        const db = req.app.locals.db;
        const u = db.prepare('SELECT email, email_verified, email_verified_at, email_bounced_at, email_bounce_reason FROM users WHERE id = ?').get(req.user.id) || {};
        const recent = db.prepare("SELECT MAX(created_at) AS t FROM email_verification_tokens WHERE user_id = ? AND created_at > datetime('now','-3 minutes')").get(req.user.id)?.t || null;
        res.json({
            ok: true,
            email: u.email || null,
            verified: !!u.email_verified,
            verified_at: u.email_verified_at || null,
            bounced: !!u.email_bounced_at,
            bounce_reason: u.email_bounce_reason || null,
            email_enabled: !!req.app.locals.emailService?.isEnabled,
            can_resend: !!u.email && !u.email_verified && !recent,
        });
    });

    router.post('/email/send-verification', requireAuth, async (req, res) => {
        try {
            const db = req.app.locals.db;
            const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
            const r = await sendVerification(req, user);
            if (r.ok) return res.json({ ok: true, message: `Verification email sent to ${user.email}. Check your inbox (and spam).` });
            const msg = {
                'no-email': 'Add an email address to your profile first.',
                'already-verified': 'Your email is already verified.',
                'email-disabled': 'Email delivery is not configured on this site yet.',
                'rate-limited': 'A verification email was sent moments ago — give it a few minutes.',
                'cap': 'Too many verification emails today. Try again tomorrow.',
                'bounced': 'That address bounced. Update your email address, then verify the new one.',
                'send-failed': 'The email could not be sent. Try again later.',
            }[r.reason] || 'Could not send verification email.';
            res.status(r.reason === 'rate-limited' || r.reason === 'cap' ? 429 : 400).json({ ok: false, error: msg, reason: r.reason });
        } catch (err) {
            console.error('[EmailVerify] send error:', err);
            res.status(500).json({ ok: false, error: 'Failed to send verification email' });
        }
    });

    // JSON verify (used by the /verify-email page)
    router.post('/email/verify', (req, res) => {
        const db = req.app.locals.db;
        const r = consumeToken(db, String(req.body?.token || ''));
        if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
        try {
            req.app.locals.notificationService?.create({ user_id: r.user.id, type: 'EMAIL_VERIFIED', title: 'Email verified', message: `${r.user.email} is confirmed. Go-live alerts from streamers you follow will now reach your inbox.`, service: 'network', url: 'https://openvibe.network/notifications' });
        } catch { /* */ }
        res.json({ ok: true, email: r.user.email });
    });

    return router;
}

module.exports = { routes, sendVerification, consumeToken, onEmailChanged };
