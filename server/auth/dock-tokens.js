'use strict';
/**
 * The Dock's private access token (the one-click extension sign-in, 2026-10-30).
 *
 * The extension is a public OAuth client (`companion`) with no secret. Its access token is a normal
 * person's token in every way except two:
 *
 *   * its issuer is `<network issuer>/dock`, so `verifySession` and every other service's normal
 *     `verifyUserToken` (which checks the Network issuer) refuse it — only the routes that opt in
 *     below accept it;
 *   * it carries `client_id`, `scope` and `fam`, no `role` and no `staff_caps`; it is a read-only
 *     Dock credential, never staff authority.
 *
 * The token is not a sliding session: it lives for the client's `access_token_ttl_s` (one hour) and
 * then the extension refreshes. A revoke (Sign out, the account page) revokes the refresh family; the
 * family check here makes the access token stop at once on Network. Chat cannot see this database, so
 * a revoked access token can live there until its `exp`; that is stated on the account page.
 */
const jwt = require('jsonwebtoken');

const CLIENT_ID = 'companion';
const CLIENT_NAME = 'OpenVibe extension';
const SCOPES = Object.freeze(['dock', 'activity', 'chat.read']);
const AUDIENCES = Object.freeze(['openvibe.network', 'openvibe.chat']);
const FAMILY_RE = /^fam_[0-9a-f]{24}$/;
const SCOPE_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

function isPublicClient(client) {
    return !!client && Number(client.is_public) === 1;
}

function isDockClient(client) {
    return isPublicClient(client) && client.client_id === CLIENT_ID;
}

function dockIssuer(config) {
    return `${String(config.jwt.issuer || '').replace(/\/+$/, '')}/dock`;
}

function scopesOf(claims) {
    return String((claims && claims.scope) || '').split(/\s+/).filter(Boolean);
}

function hasScope(claims, scope) {
    return scopesOf(claims).includes(scope);
}

function allowedScopes(client) {
    return String((client && client.allowed_scopes) || '').split(/\s+/).filter(Boolean);
}

/**
 * `{ scope }` or `{ error }`. Only a public client is scoped; every existing confidential client keeps
 * its unscoped token. An absent/empty scope is refused (not "all"), and a duplicate or unknown id is
 * refused rather than silently dropped.
 */
function readScopeForClient(client, raw) {
    if (!isPublicClient(client)) return { scope: null };
    const list = String(raw == null ? '' : raw).trim().split(/\s+/).filter(Boolean);
    if (!list.length) return { error: 'scope is required' };
    if (list.length > 20) return { error: 'too many scopes' };
    if (new Set(list).size !== list.length) return { error: 'duplicate scope' };
    const allowed = new Set(allowedScopes(client));
    const bad = list.filter((s) => !SCOPE_RE.test(s) || !allowed.has(s));
    if (bad.length) return { error: `scope not allowed: ${bad.join(' ')}` };
    return { scope: list.join(' ') };
}

/** A non-empty, bounded `state` for a public client; the server only echoes it, the app compares it. */
function readState(raw) {
    const value = String(raw == null ? '' : raw);
    if (!value || value.length > 256) return null;
    return value;
}

async function verifyDockSession(token, { db, publicKey, config }) {
    if (!token) return { error: 'Authentication required', status: 401 };
    const algorithm = publicKey.includes('BEGIN') ? 'RS256' : 'HS256';
    let decoded;
    try {
        decoded = jwt.verify(token, publicKey, {
            algorithms: [algorithm],
            issuer: dockIssuer(config),
            audience: 'openvibe.network',
        });
    } catch (err) {
        return { error: 'Invalid or expired token', status: 401 };
    }
    if (decoded.typ !== undefined || decoded.purpose !== undefined) return { error: 'Invalid token', status: 401 };
    if (decoded.actor_type !== undefined) return { error: 'Invalid token', status: 401 };
    if (decoded.client_id !== CLIENT_ID) return { error: 'Invalid token', status: 401 };
    if (decoded.role !== undefined || decoded.staff_caps !== undefined) return { error: 'Invalid token', status: 401 };
    if (!FAMILY_RE.test(String(decoded.fam || ''))) return { error: 'Invalid token', status: 401 };

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub || decoded.id);
    if (!user) return { error: 'User not found', status: 401 };
    if (user.is_banned) return { error: 'Account banned', status: 403, ban_reason: user.ban_reason };
    if (user.merged_into) return { error: 'Account merged', status: 401, merged: true };
    if (user.deleted_at) return { error: 'Account deleted', status: 401, deleted: true };
    if (user.token_valid_after) {
        const validAfter = new Date(String(user.token_valid_after).replace(' ', 'T') + (/[zZ]$/.test(String(user.token_valid_after)) ? '' : 'Z')).getTime();
        if (Number(decoded.iat) * 1000 < validAfter) return { error: 'Token revoked', status: 401 };
    }

    // The family must still have one live refresh generation: Sign out and the account page revoke
    // every generation, so the access token ends here too. `expires_at` is text; parse it in JS.
    const live = await db.prepare(`SELECT expires_at FROM oauth_tokens
        WHERE family_id = ? AND client_id = ? AND user_id = ? AND revoked = 0
        ORDER BY generation DESC LIMIT 1`).get(decoded.fam, CLIENT_ID, user.id);
    if (!live) return { error: 'Token revoked', status: 401 };
    const expires = new Date(String(live.expires_at).replace(' ', 'T') + (/[zZ]$/.test(String(live.expires_at)) ? '' : 'Z')).getTime();
    if (!(expires > Date.now())) return { error: 'Token expired', status: 401 };

    return { user, decoded, scopes: scopesOf(decoded), dock: true, renew: false };
}

module.exports = {
    CLIENT_ID, CLIENT_NAME, SCOPES, AUDIENCES, FAMILY_RE,
    isPublicClient, isDockClient, dockIssuer, scopesOf, hasScope, allowedScopes,
    readScopeForClient, readState, verifyDockSession,
};
