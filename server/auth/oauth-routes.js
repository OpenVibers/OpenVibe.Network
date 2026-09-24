'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — OAuth2 Authorization Server Routes
// Implements Authorization Code flow for cross-domain SSO.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const subjects = require('../identity/subjects');
const principals = require('../identity/principals');
const devTokens = require('../developer/tokens');
const oidc = require('./oidc');
const refreshTokens = require('./refresh-tokens');
const router = express.Router();

function getDb(req) { return req.app.locals.db; }

// PKCE (RFC 7636). S256 only: a `plain` challenge protects nothing once the authorize URL leaks.
const PKCE_RE = /^[A-Za-z0-9_-]{43,128}$/;
function readChallenge(src) {
    const challenge = src.code_challenge ? String(src.code_challenge) : null;
    const method = src.code_challenge_method ? String(src.code_challenge_method) : (challenge ? 'plain' : null);
    if (!challenge) return { challenge: null, method: null };
    if (method !== 'S256') return { error: 'code_challenge_method must be S256' };
    if (!PKCE_RE.test(challenge)) return { error: 'malformed code_challenge' };
    return { challenge, method };
}
function verifierMatches(verifier, challenge) {
    if (!PKCE_RE.test(String(verifier || ''))) return false;
    const digest = crypto.createHash('sha256').update(String(verifier)).digest('base64url');
    const a = Buffer.from(digest); const b = Buffer.from(String(challenge));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sameSecret(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function issueCode(db, { clientId, userId, redirectUri, scope, pkce, nonce }) {
    const code = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, expires_at, code_challenge, code_challenge_method, nonce)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, clientId, userId, redirectUri, scope || 'profile theme', expiresAt, pkce.challenge, pkce.method, nonce || null);
    return code;
}
const withCode = (redirectUri, code, state) => `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(state || '')}`;
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

    // Developer apps (app_<ULID>, server/developer): exact redirect URI, PKCE S256 always, no silent
    // prompt=none (a third-party app never gets a code without the person choosing to continue).
    if (devTokens.isAppClient(client_id)) {
        const found = devTokens.checkAuthorizeRequest(db, req.query);
        if (found.error) return res.status(400).json({ error: found.pkce ? 'invalid_request' : found.error, error_description: found.error });
        if (String(req.query.prompt || '') === 'none') {
            return res.redirect(`${redirect_uri}${redirect_uri.includes('?') ? '&' : '?'}error=interaction_required&state=${encodeURIComponent(state || '')}`);
        }
        const params = new URLSearchParams({ client_id, client_name: `${found.app.name} (third-party app)`, redirect_uri, response_type, scope: scope || '', state: state || '',
            code_challenge: String(req.query.code_challenge), code_challenge_method: 'S256' });
        return res.redirect(`${getConfig(req).loginUrl}/login?${params.toString()}`);
    }

    // Validate client
    const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
    if (!client) return res.status(400).json({ error: 'Unknown client_id' });

    const allowedUris = JSON.parse(client.redirect_uris || '[]');
    const uriLower = redirect_uri.toLowerCase();
    if (!allowedUris.some(u => u.toLowerCase() === uriLower)) {
        return res.status(400).json({ error: 'Invalid redirect_uri' });
    }
    const pkce = readChallenge(req.query);
    if (pkce.error) return res.status(400).json({ error: 'invalid_request', error_description: pkce.error });
    const nonce = oidc.cleanNonce(req.query.nonce);
    if (nonce === undefined) return res.status(400).json({ error: 'invalid_request', error_description: 'malformed nonce' });

    // prompt=none (silent SSO from an app whose own session lapsed): if this browser still has a
    // live/renewable openvibe.network session, continue as that account with no chooser. With no
    // session, bounce straight back with error=login_required so the app can stay quiet.
    if (String(req.query.prompt || '') === 'none') {
        const sep = redirect_uri.includes('?') ? '&' : '?';
        try {
            const { verifySession, setSessionCookies } = require('./session');
            const have = req.cookies?.ov_token || req.cookies?.ov_sso;
            const out = verifySession(have, { db, publicKey: req.app.locals.publicKey, config: getConfig(req) });
            if (!out.error) {
                const token = out.renew ? require('./routes').signToken(out.user, req.app.locals.privateKey, getConfig(req)) : have;
                setSessionCookies(res, token);
                const code = issueCode(db, { clientId: client_id, userId: out.user.id, redirectUri: redirect_uri, scope, pkce, nonce });
                return res.redirect(withCode(redirect_uri, code, state));
            }
        } catch { /* fall through */ }
        return res.redirect(`${redirect_uri}${sep}error=login_required&state=${encodeURIComponent(state || '')}`);
    }
    // Otherwise the account chooser — the user picks which account to continue with
    const loginParams = new URLSearchParams({
        client_id,
        client_name: client.name || client_id,
        redirect_uri,
        response_type,
        scope: scope || 'profile theme',
        state: state || '',
    });
    if (pkce.challenge) { loginParams.set('code_challenge', pkce.challenge); loginParams.set('code_challenge_method', pkce.method); }
    if (nonce) loginParams.set('nonce', nonce);
    res.redirect(`${getConfig(req).loginUrl}/login?${loginParams.toString()}`);
});

// ── GET /oauth/client-info ──────────────────────────────────
// The name the account chooser shows ("continue to <name>"), looked up by client_id and only for a
// registered redirect_uri. The chooser used to print client_name from its own URL, so a crafted
// link could claim to be any app. redirect_host is shown beside it: where the code will go.
router.get('/client-info', (req, res) => {
    const db = getDb(req);
    res.set('Cache-Control', 'no-store');
    const { client_id, redirect_uri } = req.query;
    if (!client_id || !redirect_uri) return res.status(400).json({ error: 'client_id and redirect_uri are required' });
    let host = '';
    try { host = new URL(String(redirect_uri)).host; } catch { return res.status(400).json({ error: 'Invalid redirect_uri' }); }
    if (devTokens.isAppClient(client_id)) {
        const found = devTokens.checkAuthorizeRequest(db, req.query);
        if (found.error && !found.pkce) return res.status(404).json({ error: found.error });
        const app = found.app || null;
        if (!app) return res.status(404).json({ error: 'Unknown client_id' });
        return res.json({ name: app.name, third_party: true, redirect_host: host });
    }
    const client = db.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE client_id = ?').get(String(client_id));
    if (!client) return res.status(404).json({ error: 'Unknown client_id' });
    const allowed = JSON.parse(client.redirect_uris || '[]').map(u => String(u).toLowerCase());
    if (!allowed.includes(String(redirect_uri).toLowerCase())) return res.status(404).json({ error: 'Invalid redirect_uri' });
    res.json({ name: client.name || String(client_id), third_party: false, redirect_host: host });
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

    const devApp = devTokens.isAppClient(client_id) ? devTokens.checkAuthorizeRequest(db, req.body) : null;
    if (devApp && devApp.error) return res.status(400).json({ error: devApp.pkce ? 'invalid_request' : devApp.error, error_description: devApp.error });
    let pkce = null;
    if (!devApp) {
        // Validate client
        const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
        if (!client) return res.status(400).json({ error: 'Unknown client_id' });

        const allowedUris = JSON.parse(client.redirect_uris || '[]');
        const uriLower = redirect_uri.toLowerCase();
        if (!allowedUris.some(u => u.toLowerCase() === uriLower)) {
            return res.status(400).json({ error: 'Invalid redirect_uri' });
        }
        pkce = readChallenge(req.body);
        if (pkce.error) return res.status(400).json({ error: 'invalid_request', error_description: pkce.error });
    }
    const nonce = oidc.cleanNonce(req.body.nonce);
    if (nonce === undefined) return res.status(400).json({ error: 'invalid_request', error_description: 'malformed nonce' });

    // Verify the token as a live, unexpired session: not revoked by a password change
    // (token_valid_after), not a FedCM assertion or a service/app token.
    const out = require('./session').verifySession(String(token), { db, publicKey: req.app.locals.publicKey, config });
    if (out.error) {
        if (out.status === 403 || out.error === 'User not found') return res.status(403).json({ error: 'User not found or banned' });
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (typeof out.decoded.exp !== 'number' || out.decoded.exp * 1000 < Date.now()) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const user = out.user;

    if (devApp) {
        const out = devTokens.issueCode(db, { app: devApp.app, project: devApp.project, user, redirectUri: redirect_uri, scope, challenge: String(req.body.code_challenge) });
        if (out.error) return res.status(out.status).json({ error: out.error });
        require('./session').setSessionCookies(res, token);
        return res.json({ redirect: withCode(redirect_uri, out.code, state) });
    }

    // Issue authorization code (bound to the PKCE challenge when the client sent one)
    const code = issueCode(db, { clientId: client_id, userId: user.id, redirectUri: redirect_uri, scope, pkce, nonce });

    // Also set cookie to this account so openvibe.network itself knows the active session.
    // Host-only (NO Domain attribute) — the ov_token cookie belongs to openvibe.network alone.
    require('./session').setSessionCookies(res, token);

    res.json({ redirect: withCode(redirect_uri, code, state) });
});

// ── POST /token ──────────────────────────────────────────────
// OAuth2 token endpoint. Exchanges authorization codes or
// refresh tokens for access tokens.
router.post('/token', (req, res) => {
    const db = getDb(req);
    const config = getConfig(req);
    const { grant_type, client_id, client_secret, code, redirect_uri, refresh_token } = req.body;

    // Developer apps (app_<ULID>): client_credentials or authorization_code + PKCE, own credential store.
    if (devTokens.isAppClient(client_id)) {
        const out = devTokens.handleTokenRequest(db, req.body, { privateKey: req.app.locals.privateKey, issuer: config.jwt.issuer, config });
        res.set('Cache-Control', 'no-store');
        return res.status(out.status).json(out.body);
    }

    // Service principals (Wave 1): a first-party service trades its client credentials for a
    // short-lived, capability-scoped token. Checked before the user-grant path below.
    if (grant_type === 'client_credentials') {
        const out = principals.issueToken(db, {
            clientId: client_id, clientSecret: client_secret, audience: req.body.audience, scope: req.body.scope,
            privateKey: req.app.locals.privateKey, issuer: config.jwt.issuer,
        });
        res.set('Cache-Control', 'no-store');
        return res.status(out.status).json(out.body);
    }

    // Validate client credentials
    const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
    if (!client || !sameSecret(client.client_secret, client_secret)) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }

    if (grant_type === 'authorization_code') {
        return handleAuthCodeGrant(db, config, req, res, client, code, redirect_uri, req.body.code_verifier);
    } else if (grant_type === 'refresh_token') {
        return handleRefreshGrant(db, config, req, res, client, refresh_token);
    } else if (grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        return handleFedcmAssertionGrant(db, config, req, res, client, req.body.assertion);
    } else {
        return res.status(400).json({ error: 'unsupported_grant_type' });
    }
});

/**
 * Every successful OAuth exchange is the proof that this account is used on that service, so
 * it is recorded as a linked service here — the Linked Services tab used to show only the
 * sites that reported the link themselves (Live), and openvibe.tools never appeared even
 * right after signing in there. A site that maps the account to its own user id (Live) still
 * owns service_user_id; the exchange never overwrites it, only bumps last_used_at.
 */
function recordLinkedService(db, user, client) {
    if (!client?.client_id || !user?.id || user.is_anon) return;
    try {
        db.prepare(`
            INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, linked_at, last_used_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, service) DO UPDATE SET
                service_username = COALESCE(service_username, excluded.service_username),
                last_used_at = CURRENT_TIMESTAMP
        `).run(user.id, client.client_id, `network:${user.id}`, user.username || null);
    } catch (err) { console.warn('[OAuth] linked service record failed:', err.message); }
}

function handleAuthCodeGrant(db, config, req, res, client, code, redirectUri, codeVerifier) {
    if (!code) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code' });

    const authCode = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code);
    if (!authCode) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid authorization code' });
    if (authCode.used) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code already used' });
    if (authCode.client_id !== client.client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'Client mismatch' });
    if (authCode.redirect_uri !== redirectUri) return res.status(400).json({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' });

    const now = new Date();
    const expiresAt = new Date(authCode.expires_at + (authCode.expires_at.includes('Z') ? '' : 'Z'));
    if (now > expiresAt) return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });

    // A code bound to a PKCE challenge is only redeemable with the matching verifier.
    if (authCode.code_challenge && !verifierMatches(codeVerifier, authCode.code_challenge)) {
        db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(code);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    // Mark code as used (atomically: two concurrent exchanges of one code cannot both succeed)
    if (db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ? AND used = 0').run(code).changes !== 1) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Code already used' });
    }

    // Get user
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(authCode.user_id);
    if (!user || user.is_banned) return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found or banned' });

    // Issue tokens
    const { accessToken, refreshToken } = issueTokenPair(db, config, req, user, client);
    recordLinkedService(db, user, client);

    // Get preferences for theme sync
    const prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(user.id);

    const { password_hash, token_valid_after, ...safeUser } = user;
    // OpenID Connect (server/auth/oidc.js): scope openid adds an id_token for this client.
    const idToken = oidc.wantsOpenid(authCode.scope)
        ? oidc.idToken({ user: { ...user, subject_id: subjects.ensureUserSubject(db, user) || user.subject_id }, clientId: client.client_id, nonce: authCode.nonce, privateKey: req.app.locals.privateKey, issuer: config.jwt.issuer })
        : undefined;
    res.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 86400, // 24h
        scope: authCode.scope,
        ...(idToken ? { id_token: idToken } : {}),
        user: safeUser,
        preferences: prefs || { theme_id: 'vibe' },
    });
}

/**
 * RFC 7523 jwt-bearer grant carrying a FedCM assertion (server/auth/fedcm.js): the RP's server
 * hands back the assertion the browser obtained for it and receives the same token pair the
 * code grant issues, so its session logic does not change. The assertion must be ours, unused,
 * unexpired, and minted for an origin this client owns.
 */
function handleFedcmAssertionGrant(db, config, req, res, client, assertion) {
    if (!assertion) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing assertion' });
    let decoded;
    try {
        const { verifyAssertion } = require('./fedcm');
        const { clientOriginMatcher } = require('./sso-owned');
        decoded = verifyAssertion(String(assertion), { publicKey: req.app.locals.publicKey, config }, clientOriginMatcher(client));
    } catch (err) {
        return res.status(400).json({ error: 'invalid_grant', error_description: err.message });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub || decoded.id);
    if (!user || user.is_banned) return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found or banned' });
    const { accessToken, refreshToken } = issueTokenPair(db, config, req, user, client);
    recordLinkedService(db, user, client);
    const prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(user.id);
    const { password_hash, token_valid_after, ...safeUser } = user;
    res.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 86400, scope: 'profile theme', user: safeUser, preferences: prefs || { theme_id: 'vibe' } });
}

function handleRefreshGrant(db, config, req, res, client, refreshToken) {
    if (!refreshToken) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token' });

    // Hashed lookup, rotation, and family revocation on reuse (server/auth/refresh-tokens.js).
    const r = refreshTokens.rotate(db, refreshToken, client.client_id);
    if (!r.ok) {
        if (r.reuse) console.warn(`[OAuth] refresh token reuse (${client.client_id}): family revoked`);
        return res.status(400).json({ error: r.error, error_description: r.description });
    }
    const stored = r.row;

    // Get user
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id);
    if (!user || user.is_banned) return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found or banned' });
    // A password change/reset (token_valid_after) ends every refresh token issued before it.
    if (user.token_valid_after && stored.created_at) {
        const at = (v) => new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z')).getTime();
        if (at(stored.created_at) < at(user.token_valid_after)) {
            return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token revoked' });
        }
    }

    // Issue new token pair: the next generation of the same family
    const { accessToken, refreshToken: newRefresh } = issueTokenPair(db, config, req, user, client, { familyId: r.familyId, generation: r.generation });
    recordLinkedService(db, user, client);

    res.json({
        access_token: accessToken,
        refresh_token: newRefresh,
        token_type: 'Bearer',
        expires_in: 86400,
        scope: stored.scope,
    });
}

function issueTokenPair(db, config, req, user, client, family = {}) {
    const privateKey = req.app.locals.privateKey;
    const algorithm = privateKey.includes('BEGIN') ? 'RS256' : 'HS256';

    const accessToken = jwt.sign(
        {
            sub: user.id,
            id: user.id,
            subject_id: subjects.ensureUserSubject(db, user) || undefined,
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

    // 30 days; only its SHA-256 is stored. A sign-in starts a family; a refresh continues it.
    const refreshTokenValue = refreshTokens.issue(db, { clientId: client.client_id, userId: user.id, familyId: family.familyId, generation: family.generation || 0 });

    return { accessToken, refreshToken: refreshTokenValue };
}

// ── GET /oauth/.well-known/openid-configuration ──────────────
// The older discovery location; the standard one is the issuer's root (server/auth/oidc.js mounts
// /.well-known/openid-configuration and /.well-known/oauth-authorization-server). Same document.
router.get('/.well-known/openid-configuration', oidc.sendMetadata);

// ── GET|POST /oauth/userinfo ─────────────────────────────────
// OpenID Connect UserInfo: standard claims for a Network access token (Bearer).
router.get('/userinfo', oidc.userinfo);
router.post('/userinfo', oidc.userinfo);

module.exports = router;
