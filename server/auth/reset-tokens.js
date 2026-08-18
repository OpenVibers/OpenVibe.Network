'use strict';

// ═══════════════════════════════════════════════════════════════
// Password-reset token helpers.
//
// Extracted from auth/routes.js so the self-service "forgot password" flow and
// the owner-initiated admin flow mint tokens exactly the same way. Duplicating
// this would be the kind of drift that ends with one path hashing tokens and the
// other storing them in the clear.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Tokens are stored hashed — a database leak must not yield usable reset links. */
function hashResetToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function buildBaseUrl(req) {
    return (process.env.OV_NETWORK_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

/**
 * Invalidate any outstanding tokens for a user and mint a fresh one.
 * Returns { rawToken, resetUrl, expiresMinutes } — rawToken is the only time the
 * plaintext exists, so it must go straight into the email and never be stored.
 */
function issueResetToken(db, req, userId) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    // One live token per user: issuing a new link revokes the previous one.
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
    db.prepare(`
        INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, requested_user_agent)
        VALUES (?, ?, ?, ?, ?)
    `).run(userId, hashResetToken(rawToken), expiresAt, req.ip || null, req.headers['user-agent'] || null);

    return {
        rawToken,
        resetUrl: `${buildBaseUrl(req)}/reset-password?token=${encodeURIComponent(rawToken)}`,
        expiresMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
    };
}

module.exports = { RESET_TOKEN_TTL_MS, hashResetToken, buildBaseUrl, issueResetToken };
