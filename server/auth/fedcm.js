'use strict';
// ═══════════════════════════════════════════════════════════════
// FedCM — openvibe.network as a browser-native identity provider.
//
// The Federated Credential Management API lets a site ask the *browser* "is this person signed
// in to openvibe.network, and may I have a token?" — no redirect, no hidden iframe, and it keeps
// working when third-party cookies are blocked, because the browser makes these requests itself
// (Chrome/Edge today; the shared navbar falls back to the iframe check + prompt=none elsewhere).
//
// Contract (developer.chrome.com/docs/identity/fedcm/implement/identity-provider):
//   GET  /.well-known/web-identity   → { provider_urls: [config] }        (eTLD+1 root)
//   GET  /fedcm/config.json          → endpoints + branding
//   GET  /fedcm/accounts             → { accounts: [...] }   credentialed, Sec-Fetch-Dest: webidentity, no Origin/Referer
//   GET  /fedcm/client-metadata      → { privacy_policy_url, terms_of_service_url }
//   POST /fedcm/assertion            → { token }             credentialed form POST, Origin = the RP, CORS with that exact origin
//   POST /fedcm/disconnect           → { account_id }
//
// The RP's clientId is its origin. The assertion is a short-lived RS256 JWT (aud = that origin,
// nonce, jti) that the RP's server then exchanges at /oauth/token with the jwt-bearer grant for
// the usual token pair — so every site keeps its existing session logic and the assertion
// itself never becomes a session.
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OWNED_ZONES } = require('./sso-owned');

const ASSERTION_TTL_S = 300;
const ORIGIN_RE = new RegExp(`^https://(?:[a-z0-9-]+\\.)*(?:${OWNED_ZONES.map(d => d.replace(/\./g, '\\.')).join('|')})$`, 'i');
const LOCAL_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

function rpOrigin(raw, env = process.env) {
    const o = String(raw || '').trim().replace(/\/$/, '');
    if (ORIGIN_RE.test(o)) return o;
    if (env.NODE_ENV !== 'production' && LOCAL_RE.test(o)) return o;
    return null;
}

function isWebIdentity(req) { return String(req.headers['sec-fetch-dest'] || '') === 'webidentity'; }

function accountOf(user, base) {
    const avatar = user.avatar_url ? (user.avatar_url.startsWith('http') ? user.avatar_url : `${base}${user.avatar_url}`) : `${base}/assets/logo-192.png`;
    return {
        id: String(user.id),
        name: user.display_name || user.username,
        given_name: user.display_name || user.username,
        username: user.username,
        email: user.email || `${user.username}@openvibe.network`,
        picture: avatar,
    };
}

/** Sign the FedCM assertion for one RP. */
function signAssertion(user, origin, nonce, ctx) {
    return jwt.sign(
        { sub: user.id, id: user.id, subject_id: user.subject_id || undefined, username: user.username, display_name: user.display_name || user.username, avatar_url: user.avatar_url || null, nonce: nonce || null, typ: 'fedcm', jti: crypto.randomBytes(16).toString('hex') },
        ctx.privateKey,
        { algorithm: ctx.privateKey.includes('BEGIN') ? 'RS256' : 'HS256', issuer: ctx.config.jwt.issuer, audience: origin, expiresIn: ASSERTION_TTL_S }
    );
}

// jti seen within the assertion lifetime → replay refused (one assertion, one session).
const _usedJti = new Map();
function jtiFresh(jti) {
    const now = Date.now();
    if (_usedJti.size > 5000) for (const [k, t] of _usedJti) if (t < now) _usedJti.delete(k);
    if (!jti || _usedJti.has(jti)) return false;
    _usedJti.set(jti, now + ASSERTION_TTL_S * 1000);
    return true;
}

/**
 * Verify an assertion presented by an RP server through the jwt-bearer grant. `allowedOrigins`
 * is a predicate for the OAuth client doing the exchange (tools may exchange assertions minted
 * for any *.openvibe.tools origin; live only for openvibe.live).
 */
function verifyAssertion(token, ctx, allowedOrigins) {
    const decoded = jwt.verify(token, ctx.publicKey, { algorithms: [ctx.publicKey.includes('BEGIN') ? 'RS256' : 'HS256'], issuer: ctx.config.jwt.issuer });
    if (decoded.typ !== 'fedcm') throw new Error('not a FedCM assertion');
    const aud = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud;
    if (!aud || !allowedOrigins(aud)) throw new Error('assertion audience does not belong to this client');
    if (!jtiFresh(decoded.jti)) throw new Error('assertion already used');
    return decoded;
}

function createFedcmRoutes(getCtx) {
    const router = express.Router();
    // Browser-initiated fetches from other origins: helmet's same-origin CORP must not apply.
    router.use((req, res, next) => { res.set('Cross-Origin-Resource-Policy', 'cross-origin'); next(); });
    const base = () => (getCtx().config.networkUrl || 'https://openvibe.network').replace(/\/$/, '');
    const sessionUser = (req) => {
        const { verifySession, requestToken } = require('./session');
        const out = verifySession(requestToken(req), getCtx(req));
        return out.error || !out.user || out.user.is_anon || out.user.is_banned ? null : out.user;
    };

    router.get('/config.json', (req, res) => {
        const b = base();
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({
            accounts_endpoint: `${b}/fedcm/accounts`,
            client_metadata_endpoint: `${b}/fedcm/client-metadata`,
            id_assertion_endpoint: `${b}/fedcm/assertion`,
            disconnect_endpoint: `${b}/fedcm/disconnect`,
            login_url: `${b}/login`,
            supports_use_other_account: true,
            branding: { background_color: '#3b82f6', color: '#ffffff', name: 'OpenVibe', icons: [{ url: `${b}/assets/logo-192.png`, size: 192 }, { url: `${b}/assets/logo-512.png`, size: 512 }] },
        });
    });

    router.get('/accounts', (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!isWebIdentity(req)) return res.status(400).json({ error: 'not a FedCM request' });
        const user = sessionUser(req);
        if (!user) { res.set('Set-Login', 'logged-out'); return res.status(401).json({ accounts: [] }); }
        res.set('Set-Login', 'logged-in');
        res.json({ accounts: [accountOf(user, base())] });
    });

    router.get('/client-metadata', (req, res) => {
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({ privacy_policy_url: 'https://openvibe.live/privacy', terms_of_service_url: 'https://openvibe.live/tos' });
    });

    router.post('/assertion', express.urlencoded({ extended: false }), (req, res) => {
        res.set('Cache-Control', 'no-store');
        const origin = rpOrigin(req.headers.origin);
        if (!isWebIdentity(req) || !origin) return res.status(400).json({ error: { code: 'invalid_request' } });
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Credentials', 'true');
        res.set('Vary', 'Origin');
        const clientId = String(req.body?.client_id || '').replace(/\/$/, '');
        if (clientId !== origin) return res.status(403).json({ error: { code: 'unauthorized_client' } });
        const user = sessionUser(req);
        if (!user) return res.status(401).json({ error: { code: 'access_denied' } });
        if (String(req.body?.account_id || '') !== String(user.id)) return res.status(403).json({ error: { code: 'access_denied' } });
        let nonce = req.body?.nonce || null;
        if (!nonce && req.body?.params) { try { nonce = JSON.parse(req.body.params).nonce || null; } catch { /* */ } }
        res.json({ token: signAssertion(user, origin, nonce, getCtx(req)) });
    });

    router.post('/disconnect', express.urlencoded({ extended: false }), (req, res) => {
        const origin = rpOrigin(req.headers.origin);
        if (!isWebIdentity(req) || !origin) return res.status(400).json({ error: 'invalid_request' });
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Credentials', 'true');
        const user = sessionUser(req);
        // Nothing is stored per RP today (approval lives in the browser); answer with the account id.
        res.json({ account_id: user ? String(user.id) : String(req.body?.account_hint || '') });
    });

    return router;
}

function wellKnown(getCtx) {
    return (req, res) => {
        const b = (getCtx().config.networkUrl || 'https://openvibe.network').replace(/\/$/, '');
        res.set('Cache-Control', 'public, max-age=3600');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.json({ provider_urls: [`${b}/fedcm/config.json`] });
    };
}

module.exports = { createFedcmRoutes, wellKnown, verifyAssertion, signAssertion, rpOrigin, accountOf };
