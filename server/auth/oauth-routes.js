'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — OAuth2 Authorization Server Routes
// Implements Authorization Code flow for cross-domain SSO.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const subjects = require('../identity/subjects');
const { staffClaims } = require('./staff-claims');
const principals = require('../identity/principals');
const devTokens = require('../developer/tokens');
const devPolicy = require('../developer/policy');
const oidc = require('./oidc');
const refreshTokens = require('./refresh-tokens');
const dock = require('./dock-tokens');
const { isExtensionOrigin } = require('./extension-origin');
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

/**
 * The authorize/confirm parameters a public client must send: a bounded state, a PKCE S256
 * challenge, and a scope inside the client's allowed_scopes. Confidential first-party clients keep
 * their existing behaviour (optional PKCE, raw scope, no state requirement).
 */
function publicAuthorizeParams(client, src) {
    if (!dock.isPublicClient(client)) {
        const pkce = readChallenge(src);
        if (pkce.error) return { error: pkce.error };
        return { pkce, scope: src.scope || null, state: String(src.state == null ? '' : src.state) };
    }
    const state = dock.readState(src.state);
    if (!state) return { error: 'state is required' };
    const pkce = readChallenge(src);
    if (pkce.error) return { error: pkce.error };
    if (!pkce.challenge) return { error: 'code_challenge is required (S256)' };
    const scoped = dock.readScopeForClient(client, src.scope);
    if (scoped.error) return { error: scoped.error };
    return { pkce, scope: scoped.scope, state };
}
async function issueCode(db, { clientId, userId, redirectUri, scope, pkce, nonce }) {
    const code = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await db.prepare(`INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, expires_at, code_challenge, code_challenge_method, nonce)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, clientId, userId, redirectUri, scope || 'profile theme', expiresAt, pkce.challenge, pkce.method, nonce || null);
    return code;
}
/**
 * OpenID Connect's login_hint: which account the site expects (a username, @ allowed, or an account id). The chooser
 * continues as it when this browser has it saved, and fills in the sign-in form otherwise. Anything else is dropped.
 */
function cleanLoginHint(raw) {
    const v = String(raw == null ? '' : raw).trim();
    return v && v.length <= 64 && /^@?[A-Za-z0-9_.-]+$/.test(v) ? v : '';
}
const withCode = (redirectUri, code, state) => `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(state || '')}`;
function getConfig(req) { return req.app.locals.config; }

// ── GET /authorize ───────────────────────────────────────────
// OAuth2 authorization endpoint. Always shows the account chooser
// so the user can pick which account to continue with, add a new
// one, or create an account.
router.get('/authorize', async (req, res) => {
    const db = await getDb(req);
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
        const found = await devTokens.checkAuthorizeRequest(db, req.query);
        if (found.error) return res.status(400).json({ error: found.pkce ? 'invalid_request' : found.error, error_description: found.error });
        if (String(req.query.prompt || '') === 'none') {
            return res.redirect(`${redirect_uri}${redirect_uri.includes('?') ? '&' : '?'}error=interaction_required&state=${encodeURIComponent(state || '')}`);
        }
        const params = new URLSearchParams({ client_id, client_name: `${found.app.name} (third-party app)`, redirect_uri, response_type, scope: scope || '', state: state || '',
            code_challenge: String(req.query.code_challenge), code_challenge_method: 'S256' });
        const appHint = cleanLoginHint(req.query.login_hint);   // fills in the sign-in form; a third-party app never continues by itself
        if (appHint) params.set('login_hint', appHint);
        return res.redirect(`${getConfig(req).loginUrl}/login?${params.toString()}`);
    }

    // Validate client
    const client = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
    if (!client) return res.status(400).json({ error: 'Unknown client_id' });

    const allowedUris = JSON.parse(client.redirect_uris || '[]');
    const uriLower = redirect_uri.toLowerCase();
    if (!allowedUris.some(u => u.toLowerCase() === uriLower)) {
        return res.status(400).json({ error: 'Invalid redirect_uri' });
    }
    const allowed = publicAuthorizeParams(client, req.query);
    if (allowed.error) return res.status(400).json({ error: 'invalid_request', error_description: allowed.error });
    const { pkce } = allowed;
    const requestScope = allowed.scope;
    const requestState = allowed.state;
    const nonce = oidc.cleanNonce(req.query.nonce);
    if (nonce === undefined) return res.status(400).json({ error: 'invalid_request', error_description: 'malformed nonce' });

    // prompt=none (silent SSO from an app whose own session lapsed): if this browser still has a
    // live/renewable openvibe.network session, continue as that account with no chooser. With no
    // session, bounce straight back with error=login_required so the app can stay quiet. From an
    // extension origin a cookie never counts (server/auth/session.js): only a Bearer would, and an
    // authorize navigation does not carry one.
    if (String(req.query.prompt || '') === 'none') {
        const sep = redirect_uri.includes('?') ? '&' : '?';
        try {
            const { verifySession, setSessionCookies } = require('./session');
            const have = isExtensionOrigin(req.headers.origin) ? null : (req.cookies?.ov_token || req.cookies?.ov_sso);
            const out = await verifySession(have, { db, publicKey: req.app.locals.publicKey, config: getConfig(req) });
            if (!out.error) {
                const token = out.renew ? require('./routes').signToken(out.user, req.app.locals.privateKey, getConfig(req), { renew: out.decoded }) : have;
                if (!isExtensionOrigin(req.headers.origin)) setSessionCookies(res, token);
                const code = await issueCode(db, { clientId: client_id, userId: out.user.id, redirectUri: redirect_uri, scope: requestScope, pkce, nonce });
                return res.redirect(withCode(redirect_uri, code, requestState));
            }
        } catch { /* fall through */ }
        return res.redirect(`${redirect_uri}${sep}error=login_required&state=${encodeURIComponent(requestState || '')}`);
    }
    // Otherwise the account chooser — the user picks which account to continue with
    const loginParams = new URLSearchParams({
        client_id,
        client_name: client.name || client_id,
        redirect_uri,
        response_type,
        scope: requestScope || 'profile theme',
        state: requestState || '',
    });
    if (pkce.challenge) { loginParams.set('code_challenge', pkce.challenge); loginParams.set('code_challenge_method', pkce.method); }
    if (nonce) loginParams.set('nonce', nonce);
    // The site asked for the chooser ("use another account"): the page shows it even with one account saved.
    if (['select_account', 'login'].includes(String(req.query.prompt || ''))) loginParams.set('prompt', String(req.query.prompt));
    const hint = cleanLoginHint(req.query.login_hint);
    if (hint) loginParams.set('login_hint', hint);
    res.redirect(`${getConfig(req).loginUrl}/login?${loginParams.toString()}`);
});

/**
 * The name a first-party sign-in names, from where it returns to: one OAuth client can serve several sites (media-hub is
 * openvibe.video, openvibe.download and openvibe.pics), and the chooser said "continue to OpenVibe.Download" to someone
 * signing in on openvibe.video. A product on its own domain, else the site that owns the host; null when neither.
 */
function siteNameForHost(host) {
    const { PRODUCTS, siteForHost } = require('../frame/sites');
    const h = String(host || '').toLowerCase();
    const site = PRODUCTS.find((p) => p.host === h) || siteForHost(h);
    if (!site || !site.name) return null;
    return /^Open|\./.test(site.name) ? site.name : `OpenVibe.${site.name}`;
}

// ── GET /oauth/client-info ──────────────────────────────────
// The name the account chooser shows ("continue to <name>"), looked up by client_id and only for a
// registered redirect_uri. The chooser used to print client_name from its own URL, so a crafted
// link could claim to be any app. redirect_host is shown beside it: where the code will go.
// With the authorize request's `scope`, a third-party app also gets the consent screen's capability
// list: the requested ids the app can be granted (catalog metadata, `sensitive` marked) and the
// refused ids the screen must not name. Never another app, never a secret.
router.get('/client-info', async (req, res) => {
    const db = await getDb(req);
    res.set('Cache-Control', 'no-store');
    const { client_id, redirect_uri, scope } = req.query;
    if (!client_id || !redirect_uri) return res.status(400).json({ error: 'client_id and redirect_uri are required' });
    let host = '';
    try { host = new URL(String(redirect_uri)).host; } catch { return res.status(400).json({ error: 'Invalid redirect_uri' }); }
    if (devTokens.isAppClient(client_id)) {
        const found = await devTokens.checkAuthorizeRequest(db, req.query);
        if (found.error && !found.pkce) return res.status(404).json({ error: found.error });
        const app = found.app || null;
        if (!app) return res.status(404).json({ error: 'Unknown client_id' });
        const { capabilities, refused } = devTokens.consentView(scope);
        return res.json({ name: app.name, third_party: true, redirect_host: host, capabilities, refused });
    }
    const client = await db.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE client_id = ?').get(String(client_id));
    if (!client) return res.status(404).json({ error: 'Unknown client_id' });
    const allowed = JSON.parse(client.redirect_uris || '[]').map(u => String(u).toLowerCase());
    if (!allowed.includes(String(redirect_uri).toLowerCase())) return res.status(404).json({ error: 'Invalid redirect_uri' });
    res.json({ name: siteNameForHost(host) || client.name || String(client_id), third_party: false, redirect_host: host, capabilities: [], refused: [] });
});

// ── POST /oauth/confirm ─────────────────────────────────────
// Called from the account chooser UI. Accepts an openvibe.network JWT
// token and OAuth params, validates everything, issues an
// authorization code, and returns the redirect URL.
router.post('/confirm', async (req, res) => {
    const db = await getDb(req);
    const config = getConfig(req);
    const { token, client_id, redirect_uri, scope, state } = req.body;

    if (!token || !client_id || !redirect_uri) {
        return res.status(400).json({ error: 'token, client_id, and redirect_uri are required' });
    }

    const devApp = devTokens.isAppClient(client_id) ? await devTokens.checkAuthorizeRequest(db, req.body) : null;
    if (devApp && devApp.error) return res.status(400).json({ error: devApp.pkce ? 'invalid_request' : devApp.error, error_description: devApp.error });
    let pkce = null;
    let requestScope;
    let requestState;
    if (!devApp) {
        // Validate client
        const client = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
        if (!client) return res.status(400).json({ error: 'Unknown client_id' });

        const allowedUris = JSON.parse(client.redirect_uris || '[]');
        const uriLower = redirect_uri.toLowerCase();
        if (!allowedUris.some(u => u.toLowerCase() === uriLower)) {
            return res.status(400).json({ error: 'Invalid redirect_uri' });
        }
        const allowed = publicAuthorizeParams(client, req.body);
        if (allowed.error) return res.status(400).json({ error: 'invalid_request', error_description: allowed.error });
        pkce = allowed.pkce;
        requestScope = allowed.scope;
        requestState = allowed.state;
    }
    const nonce = oidc.cleanNonce(req.body.nonce);
    if (nonce === undefined) return res.status(400).json({ error: 'invalid_request', error_description: 'malformed nonce' });

    // Verify the token as a live, unexpired session: not revoked by a password change
    // (token_valid_after), not a FedCM assertion or a service/app token.
    const out = await require('./session').verifySession(String(token), { db, publicKey: req.app.locals.publicKey, config });
    if (out.error) {
        if (out.status === 403 || out.error === 'User not found') return res.status(403).json({ error: 'User not found or banned' });
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (typeof out.decoded.exp !== 'number' || out.decoded.exp * 1000 < Date.now()) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const user = out.user;

    if (devApp) {
        const out = await devTokens.issueCode(db, { app: devApp.app, project: devApp.project, user, redirectUri: redirect_uri, scope, challenge: String(req.body.code_challenge) });
        if (out.error) return res.status(out.status).json({ error: out.error });
        require('./session').setSessionCookies(res, token);
        return res.json({ redirect: withCode(redirect_uri, out.code, state) });
    }

    // Issue authorization code (bound to the PKCE challenge when the client sent one)
    const code = await issueCode(db, { clientId: client_id, userId: user.id, redirectUri: redirect_uri, scope: requestScope !== undefined ? requestScope : scope, pkce, nonce });

    // Also set cookie to this account so openvibe.network itself knows the active session.
    // Host-only (NO Domain attribute) — the ov_token cookie belongs to openvibe.network alone.
    require('./session').setSessionCookies(res, token);

    res.json({ redirect: withCode(redirect_uri, code, requestState !== undefined ? requestState : state) });
});

// ── POST /token ──────────────────────────────────────────────
// OAuth2 token endpoint. Exchanges authorization codes or
// refresh tokens for access tokens.
router.post('/token', async (req, res) => {
    const db = await getDb(req);
    const config = getConfig(req);
    const { grant_type, client_id, client_secret, code, redirect_uri, refresh_token } = req.body;
    res.set('Cache-Control', 'no-store');   // every grant answers with tokens (RFC 6749 §5.1)

    // A public first-party client has no secret and only the two user grants. Resolve it before the
    // service-principal branch so client_credentials can never mint a service token for it.
    const client = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
    if (client && dock.isPublicClient(client) && !['authorization_code', 'refresh_token'].includes(grant_type)) {
        return res.status(400).json({ error: 'unauthorized_client', error_description: 'a public client uses authorization_code or refresh_token' });
    }

    // Developer apps (app_<ULID>): client_credentials or authorization_code + PKCE, own credential store.
    if (devTokens.isAppClient(client_id)) {
        const out = await devTokens.handleTokenRequest(db, req.body, { privateKey: req.app.locals.privateKey, issuer: config.jwt.issuer, config, ctx: req.ov });
        res.set('Cache-Control', 'no-store');
        return res.status(out.status).json(out.body);
    }

    // Service principals (Wave 1): a first-party service trades its client credentials for a
    // short-lived, capability-scoped token. Checked before the user-grant path below.
    if (grant_type === 'client_credentials') {
        // A paired machine (node principal, docs/t2-cells-and-node-principal.md section 4.3): its own credential store.
        if (/^nod_/.test(client_id)) {
            if (req.body.agent !== undefined) return res.status(400).json({ error: 'invalid_grant', error_description: 'nodes host no agents' });
            const out = await require('../registry/node-principals').issueNodeToken(db, {
                clientId: client_id, clientSecret: client_secret, audience: req.body.audience,
                privateKey: req.app.locals.privateKey, issuer: config.jwt.issuer,
            });
            return res.status(out.status).json(out.body);
        }
        const out = await principals.issueToken(db, {
            clientId: client_id, clientSecret: client_secret, audience: req.body.audience, scope: req.body.scope,
            privateKey: req.app.locals.privateKey, issuer: config.jwt.issuer,
            agent: req.body.agent, settings: devPolicy.settings(config), ctx: req.ov,
            // A run token (Codes C3): the person it acts for, and how long it may live.
            onBehalfOf: req.body.on_behalf_of, ttl: req.body.ttl,
        });
        res.set('Cache-Control', 'no-store');
        // A refused rate limit says when to come back (the seconds until the window has room).
        if (out.body && out.body.retry_after) res.set('Retry-After', String(out.body.retry_after));
        return res.status(out.status).json(out.body);
    }

    // Validate client credentials. A public client sends none; every confidential client keeps the
    // required secret and the old code path exactly.
    if (!client) return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    if (dock.isPublicClient(client)) {
        if (client_secret) return res.status(400).json({ error: 'invalid_request', error_description: 'public clients do not send a client_secret' });
    } else if (!sameSecret(client.client_secret, client_secret)) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }

    if (grant_type === 'authorization_code') {
        return await handleAuthCodeGrant(db, config, req, res, client, code, redirect_uri, req.body.code_verifier);
    } else if (grant_type === 'refresh_token') {
        return await handleRefreshGrant(db, config, req, res, client, refresh_token);
    } else if (grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        return await handleFedcmAssertionGrant(db, config, req, res, client, req.body.assertion);
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
async function recordLinkedService(db, user, client) {
    if (!client?.client_id || !user?.id || user.is_anon || dock.isPublicClient(client)) return;
    try {
        await db.prepare(`
            INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, linked_at, last_used_at)
            VALUES (?, ?, ?, ?, ov_now(), ov_now())
            ON CONFLICT(user_id, service) DO UPDATE SET
                service_username = COALESCE(linked_accounts.service_username, excluded.service_username),
                last_used_at = ov_now()
        `).run(user.id, client.client_id, `network:${user.id}`, user.username || null);
    } catch (err) { console.warn('[OAuth] linked service record failed:', err.message); }
}

async function handleAuthCodeGrant(db, config, req, res, client, code, redirectUri, codeVerifier) {
    if (!code) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code' });

    const authCode = await db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code);
    if (!authCode) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid authorization code' });
    if (authCode.used) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code already used' });
    if (authCode.client_id !== client.client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'Client mismatch' });
    if (authCode.redirect_uri !== redirectUri) return res.status(400).json({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' });

    const now = new Date();
    const expiresAt = new Date(authCode.expires_at + (authCode.expires_at.includes('Z') ? '' : 'Z'));
    if (now > expiresAt) return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });

    // A public client's code must have been issued with a PKCE S256 challenge and be redeemed with
    // the matching verifier; a confidential client keeps today's optional-PKCE behaviour. A failed
    // check burns the code.
    const publicClient = dock.isPublicClient(client);
    if (publicClient && (!authCode.code_challenge || !verifierMatches(codeVerifier, authCode.code_challenge))) {
        await db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(code);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    if (!publicClient && authCode.code_challenge && !verifierMatches(codeVerifier, authCode.code_challenge)) {
        await db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(code);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    // Mark code as used (atomically: two concurrent exchanges of one code cannot both succeed)
    if ((await db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ? AND used = 0').run(code)).changes !== 1) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Code already used' });
    }

    // Get user
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(authCode.user_id);
    if (!user || user.is_banned) return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found or banned' });

    // Issue tokens
    const issued = await issueTokenPair(db, config, req, user, client, {}, authCode.scope);
    const { accessToken, refreshToken } = issued;
    await recordLinkedService(db, user, client);

    // Get preferences for theme sync
    const prefs = await db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(user.id);

    const { password_hash, token_valid_after, ...safeUser } = user;
    // OpenID Connect (server/auth/oidc.js): scope openid adds an id_token for this client.
    const idToken = oidc.wantsOpenid(authCode.scope)
        ? oidc.idToken({ user: { ...user, subject_id: await subjects.ensureUserSubject(db, user) || user.subject_id }, clientId: client.client_id, nonce: authCode.nonce, privateKey: req.app.locals.privateKey, issuer: config.jwt.issuer })
        : undefined;
    res.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        scope: authCode.scope,
        ...(idToken ? { id_token: idToken } : {}),
        ...(publicClient
            ? { user: { id: user.id, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url } }
            : { user: safeUser, preferences: prefs || { theme_id: 'vibe' } }),
    });
}

/**
 * RFC 7523 jwt-bearer grant carrying a FedCM assertion (server/auth/fedcm.js): the RP's server
 * hands back the assertion the browser obtained for it and receives the same token pair the
 * code grant issues, so its session logic does not change. The assertion must be ours, unused,
 * unexpired, and minted for an origin this client owns.
 */
async function handleFedcmAssertionGrant(db, config, req, res, client, assertion) {
    if (!assertion) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing assertion' });
    let decoded;
    try {
        const { verifyAssertion } = require('./fedcm');
        const { clientOriginMatcher } = require('./sso-owned');
        decoded = verifyAssertion(String(assertion), { publicKey: req.app.locals.publicKey, config }, clientOriginMatcher(client));
    } catch (err) {
        return res.status(400).json({ error: 'invalid_grant', error_description: err.message });
    }
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub || decoded.id);
    if (!user || user.is_banned) return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found or banned' });
    const issued = await issueTokenPair(db, config, req, user, client);
    await recordLinkedService(db, user, client);
    const prefs = await db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(user.id);
    const { password_hash, token_valid_after, ...safeUser } = user;
    res.json({ access_token: issued.accessToken, refresh_token: issued.refreshToken, token_type: 'Bearer', expires_in: issued.expiresIn, scope: 'profile theme', user: safeUser, preferences: prefs || { theme_id: 'vibe' } });
}

async function handleRefreshGrant(db, config, req, res, client, refreshToken) {
    if (!refreshToken) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token' });

    // Hashed lookup, rotation, and family revocation on reuse (server/auth/refresh-tokens.js).
    const r = await refreshTokens.rotate(db, refreshToken, client.client_id);
    if (!r.ok) {
        if (r.reuse) console.warn(`[OAuth] refresh token reuse (${client.client_id}): family revoked`);
        return res.status(400).json({ error: r.error, error_description: r.description });
    }
    const stored = r.row;

    // Get user
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id);
    if (!user || user.is_banned) return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found or banned' });
    // A password change/reset (token_valid_after) ends every refresh token issued before it.
    if (user.token_valid_after && stored.created_at) {
        const at = (v) => new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z')).getTime();
        if (at(stored.created_at) < at(user.token_valid_after)) {
            return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token revoked' });
        }
    }

    // Issue new token pair: the next generation of the same family
    const issued = await issueTokenPair(db, config, req, user, client, { familyId: r.familyId, generation: r.generation }, stored.scope);
    await recordLinkedService(db, user, client);

    res.json({
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        scope: stored.scope,
    });
}

async function issueTokenPair(db, config, req, user, client, family = {}, scope = null) {
    const privateKey = req.app.locals.privateKey;
    const algorithm = privateKey.includes('BEGIN') ? 'RS256' : 'HS256';
    const publicClient = dock.isPublicClient(client);
    const ttl = publicClient ? Math.max(60, Math.min(86400, Number(client.access_token_ttl_s) || 3600)) : null;
    const familyId = family.familyId || refreshTokens.newFamily();
    const subjectId = await subjects.ensureUserSubject(db, user) || undefined;

    const base = {
        sub: user.id,
        id: user.id,
        subject_id: subjectId,
        username: user.username,
        display_name: user.display_name || user.username,
        avatar_url: user.avatar_url,
        profile_color: user.profile_color,
    };
    // A Dock token is a read credential: no role and no staff caps, and a private issuer so no other
    // service's normal user-token check accepts it. The family id lets Network end it on revoke.
    const claims = publicClient
        ? { ...base, client_id: client.client_id, scope: String(scope || ''), fam: familyId }
        : { ...base, role: user.role, ...staffClaims(user) };

    const accessToken = jwt.sign(claims, privateKey, {
        algorithm,
        issuer: publicClient ? dock.dockIssuer(config) : config.jwt.issuer,
        audience: publicClient ? [...dock.AUDIENCES] : ['openvibe.live', 'openvibe.tools', 'openvibe.games', 'openvibe.media', 'openvibe.network'],
        expiresIn: publicClient ? ttl : config.jwt.accessTokenExpiry,
    });

    // 30 days; only its SHA-256 is stored. A sign-in starts a family; a refresh continues it.
    const issued = await refreshTokens.issue(db, {
        clientId: client.client_id, userId: user.id, scope: publicClient ? String(scope || '') : 'profile theme',
        familyId, generation: family.generation || 0,
    });

    return { accessToken, refreshToken: issued.token, expiresIn: publicClient ? ttl : 86400, familyId: issued.familyId };
}

/**
 * RFC 7009 revoke. The extension sends its refresh token here on Sign out; the account page revokes a
 * family directly. A public client authenticates with possession of the token alone (no secret); a
 * confidential client still authenticates with its secret. Unknown, expired and already-revoked tokens
 * answer 200 {} so the endpoint is not an oracle.
 */
router.post('/revoke', async (req, res) => {
    const db = await getDb(req);
    res.set('Cache-Control', 'no-store');
    const token = String(req.body?.token || '');
    const clientId = String(req.body?.client_id || '');
    if (!clientId) return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
    const client = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId);
    if (!client) return res.json({});
    if (!dock.isPublicClient(client) && !sameSecret(client.client_secret, req.body?.client_secret)) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }
    const row = await refreshTokens.find(db, token);
    if (row && row.client_id === clientId) {
        const familyId = row.family_id || `fam_legacy_${row.id}`;
        await refreshTokens.revokeFamily(db, familyId, 'signed_out');
        try {
            await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
                .run(row.user_id, 'oauth_refresh_revoked', JSON.stringify({ client_id: clientId, family_id: familyId }));
        } catch { /* audit is best effort */ }
    }
    return res.json({});
});

// ── GET|POST /oauth/userinfo ─────────────────────────────────
// OpenID Connect UserInfo: standard claims for a Network access token (Bearer).
router.get('/userinfo', oidc.userinfo);
router.post('/userinfo', oidc.userinfo);

module.exports = router;
module.exports.cleanLoginHint = cleanLoginHint;
module.exports.siteNameForHost = siteNameForHost;
