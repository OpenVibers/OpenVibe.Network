'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — OAuth2 Authorization Server Routes
// Implements Authorization Code flow for cross-domain SSO.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const router = express.Router();

function getDb(req) { return req.app.locals.db; }
function getConfig(req) { return req.app.locals.config; }

// ── GET /authorize ───────────────────────────────────────────
// OAuth2 authorization endpoint. Always shows the account chooser
// so the user can pick which account to continue with, add a new
// one, or create an account.
router.get('/authorize', (req, res) => {
    const db = getDb(req);
    const { client_id, redirect_uri, response_type, scope, state } = req.query;

    if (response_type !== 'code') {
        return res.status(400).json({ error: 'Only response_type=code is supported' });
    }
    if (!client_id || !redirect_uri) {
        return res.status(400).json({ error: 'client_id and redirect_uri are required' });
    }

    // Validate client
    const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
    if (!client) return res.status(400).json({ error: 'Unknown client_id' });

    const allowedUris = JSON.parse(client.redirect_uris || '[]');
    const uriLower = redirect_uri.toLowerCase();
    if (!allowedUris.some(u => u.toLowerCase() === uriLower)) {
        return res.status(400).json({ error: 'Invalid redirect_uri' });
    }

    // Always redirect to login/chooser — let the user pick which account to use
    const loginParams = new URLSearchParams({
        client_id,
        client_name: client.name || client_id,
        redirect_uri,
        response_type,
        scope: scope || 'profile theme',
        state: state || '',
    });
    res.redirect(`${getConfig(req).loginUrl}/login?${loginParams.toString()}`);
});

// ── POST /oauth/confirm ─────────────────────────────────────
// Called from the account chooser UI. Accepts an openvibe.network JWT
// token and OAuth params, validates everything, issues an
// authorization code, and returns the redirect URL.
router.post('/confirm', (req, res) => {
    const db = getDb(req);
    const config = getConfig(req);
    const { token, client_id, redirect_uri, scope, state } = req.body;

    if (!token || !client_id || !redirect_uri) {
        return res.status(400).json({ error: 'token, client_id, and redirect_uri are required' });
    }

    // Validate client
    const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
    if (!client) return res.status(400).json({ error: 'Unknown client_id' });

    const allowedUris = JSON.parse(client.redirect_uris || '[]');
    const uriLower = redirect_uri.toLowerCase();
    if (!allowedUris.some(u => u.toLowerCase() === uriLower)) {
        return res.status(400).json({ error: 'Invalid redirect_uri' });
    }

    // Verify the token
    const publicKey = req.app.locals.publicKey;
    const algorithm = publicKey.includes('BEGIN') ? 'RS256' : 'HS256';
    let decoded;
    try {
        decoded = jwt.verify(token, publicKey, { algorithms: [algorithm], issuer: config.jwt.issuer });
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub || decoded.id);
    if (!user || user.is_banned) {
        return res.status(403).json({ error: 'User not found or banned' });
    }

    // Issue authorization code
    const code = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.prepare(`
        INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(code, client_id, user.id, redirect_uri, scope || 'profile theme', expiresAt);

    // Also set cookie to this account so openvibe.network itself knows the active session.
    // Host-only (NO Domain attribute) — the ov_token cookie belongs to openvibe.network alone.
    res.cookie('ov_token', token, { httpOnly: false, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'Lax', secure: true, path: '/' });

    const sep = redirect_uri.includes('?') ? '&' : '?';
    res.json({ redirect: `${redirect_uri}${sep}code=${code}&state=${state || ''}` });
});

// ── POST /token ──────────────────────────────────────────────
// OAuth2 token endpoint. Exchanges authorization codes or
// refresh tokens for access tokens.
router.post('/token', (req, res) => {
    const db = getDb(req);
    const config = getConfig(req);
    const { grant_type, client_id, client_secret, code, redirect_uri, refresh_token } = req.body;

    // Validate client credentials
    const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
    if (!client || client.client_secret !== client_secret) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }

    if (grant_type === 'authorization_code') {
        return handleAuthCodeGrant(db, config, req, res, client, code, redirect_uri);
    } else if (grant_type === 'refresh_token') {
        return handleRefreshGrant(db, config, req, res, client, refresh_token);
    } else {
        return res.status(400).json({ error: 'unsupported_grant_type' });
    }
});

function handleAuthCodeGrant(db, config, req, res, client, code, redirectUri) {
    if (!code) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code' });

    const authCode = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code);
    if (!authCode) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid authorization code' });
    if (authCode.used) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code already used' });
    if (authCode.client_id !== client.client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'Client mismatch' });
    if (authCode.redirect_uri !== redirectUri) return res.status(400).json({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' });

    const now = new Date();
    const expiresAt = new Date(authCode.expires_at + (authCode.expires_at.includes('Z') ? '' : 'Z'));
    if (now > expiresAt) return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });

    // Mark code as used
    db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(code);

    // Get user
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(authCode.user_id);
    if (!user || user.is_banned) return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found or banned' });

    // Issue tokens
    const { accessToken, refreshToken } = issueTokenPair(db, config, req, user, client);

    // Get preferences for theme sync
    const prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(user.id);

    const { password_hash, token_valid_after, ...safeUser } = user;
    res.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 86400, // 24h
        scope: authCode.scope,
        user: safeUser,
        preferences: prefs || { theme_id: 'vibe' },
    });
}

function handleRefreshGrant(db, config, req, res, client, refreshToken) {
    if (!refreshToken) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token' });

    const stored = db.prepare('SELECT * FROM oauth_tokens WHERE token = ?').get(refreshToken);
    if (!stored) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
    if (stored.revoked) return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token revoked' });
    if (stored.client_id !== client.client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'Client mismatch' });

    const now = new Date();
    const expiresAt = new Date(stored.expires_at + (stored.expires_at.includes('Z') ? '' : 'Z'));
    if (now > expiresAt) return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token expired' });

    // Revoke old refresh token (rotation)
    db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE id = ?').run(stored.id);

    // Get user
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id);
    if (!user || user.is_banned) return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found or banned' });

    // Issue new token pair
    const { accessToken, refreshToken: newRefresh } = issueTokenPair(db, config, req, user, client);

    res.json({
        access_token: accessToken,
        refresh_token: newRefresh,
        token_type: 'Bearer',
        expires_in: 86400,
        scope: stored.scope,
    });
}

function issueTokenPair(db, config, req, user, client) {
    const privateKey = req.app.locals.privateKey;
    const algorithm = privateKey.includes('BEGIN') ? 'RS256' : 'HS256';

    const accessToken = jwt.sign(
        {
            sub: user.id,
            id: user.id,
            username: user.username,
            display_name: user.display_name || user.username,
            role: user.role,
            avatar_url: user.avatar_url,
            profile_color: user.profile_color,
        },
        privateKey,
        {
            algorithm,
            issuer: config.jwt.issuer,
            audience: ['openvibe.live', 'openvibe.tools', 'openvibe.games', 'openvibe.media', 'openvibe.network'],
            expiresIn: config.jwt.accessTokenExpiry,
        }
    );

    const refreshTokenValue = crypto.randomBytes(48).toString('hex');
    const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
    db.prepare(`
        INSERT INTO oauth_tokens (token, client_id, user_id, scope, expires_at)
        VALUES (?, ?, ?, 'profile theme', ?)
    `).run(refreshTokenValue, client.client_id, user.id, refreshExpires);

    return { accessToken, refreshToken: refreshTokenValue };
}

// ── GET /.well-known/openid-configuration ────────────────────
// Discovery endpoint for OIDC-compatible clients.
router.get('/.well-known/openid-configuration', (req, res) => {
    const config = getConfig(req);
    res.json({
        issuer: config.jwt.issuer,
        authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
        token_endpoint: `${config.baseUrl}/oauth/token`,
        userinfo_endpoint: `${config.baseUrl}/api/auth/me`,
        jwks_uri: `${config.baseUrl}/api/.well-known/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['profile', 'theme', 'openid'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
    });
});

module.exports = router;
