'use strict';

// ═══════════════════════════════════════════════════════════════
// Owner guard + secret-key detection for openvibe.network.
//
// Owner = the configured OpenVibe owner account (OWNER_USERNAME,
// default 'goosely'). Admins run the network day-to-day but must NOT be
// able to view or change API keys / payment credentials / other secrets.
// This module centralises that rule so every secret-touching route uses
// the same definition (mirrors OpenVibe.Live's server/auth/permissions.js).
// ═══════════════════════════════════════════════════════════════

function ownerName() {
    return (process.env.OWNER_USERNAME || 'goosely').toLowerCase();
}

function isOwner(user) {
    return !!(user && user.username && String(user.username).toLowerCase() === ownerName());
}

function requireOwner(req, res, next) {
    if (!isOwner(req.user)) {
        return res.status(403).json({ ok: false, error: 'Owner access required' });
    }
    next();
}

// A settings/registry key is "sensitive" if its name looks like a credential.
const SENSITIVE_RE = /(api[_-]?key|secret|token|password|client_id|client_secret|service_account|private[_-]?key|access[_-]?key|webhook_secret)/i;
const SENSITIVE_PREFIXES = [
    'ai_', 'stripe_', 'paypal_', 'ccbill_', 'crypto_', 'tts_',
    'ses_', 'aws_', 's3_', 'b2_', 'backblaze', 'smtp_',
    'deploy_cloudflare', 'discord_bot', 'discord_oauth', 'resend_', 'net.',
];
const SENSITIVE_EXACT = new Set([
    'youtube_api_key', 'resend_api_key',
    'discord_bot_token', 'discord_oauth_client_secret',
]);

function isSensitiveSettingKey(key) {
    if (!key) return false;
    const k = String(key).toLowerCase();
    if (SENSITIVE_EXACT.has(k)) return true;
    if (SENSITIVE_PREFIXES.some((p) => k.startsWith(p))) return true;
    return SENSITIVE_RE.test(k);
}

function maskSecret(v) {
    if (v == null) return v;
    const s = String(v);
    if (!s) return s;
    return s.length <= 8 ? '••••••••' : '••••' + s.slice(-4);
}

module.exports = { isOwner, requireOwner, isSensitiveSettingKey, maskSecret, ownerName };
