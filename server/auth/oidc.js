'use strict';
// ═══════════════════════════════════════════════════════════════
// OpenID Connect on Network's OAuth 2.0 authorization server (roadmap §4.1, §15.4).
//
//   GET /.well-known/openid-configuration         OIDC Discovery 1.0, at the issuer's root (the
//                                                 standard location: <issuer>/.well-known/...)
//   GET /.well-known/oauth-authorization-server   RFC 8414, the same metadata
//   GET /oauth/.well-known/openid-configuration   the older location, kept (server/auth/oauth-routes.js)
//   GET|POST /oauth/userinfo                      standard claims for a Network access token
//
// The authorization-code grant adds an id_token when the code's scope includes `openid` (idToken
// below), echoing the nonce the client sent to /oauth/authorize. `sub` is the account's Network id as
// a string, the same value access tokens carry; `subject_id` is its canonical usr_ id (ADR-001).
// ═══════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');

const KID = 'ov-network-1';           // the kid /api/.well-known/jwks publishes for the RS256 key
const ID_TOKEN_TTL_S = 3600;
const NONCE_MAX = 255;

/** The discovery document. `issuer` is the token issuer, verbatim; endpoints live at Network's base URL. */
function metadata(config) {
    const issuer = config.jwt.issuer;
    const base = String(config.baseUrl || issuer).replace(/\/+$/, '');
    return {
        issuer,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        userinfo_endpoint: `${base}/oauth/userinfo`,
        jwks_uri: `${base}/api/.well-known/jwks`,
        // openid adds an id_token to the code grant; profile and theme are the first-party scopes.
        // Developer apps (app_<ULID>) ask for capability ids instead (docs/developer-projects.md).
        scopes_supported: ['openid', 'profile', 'theme'],
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        // 'none' is for public developer apps, which always use PKCE.
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        code_challenge_methods_supported: ['S256'],
        claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'name', 'preferred_username', 'picture', 'subject_id'],
        request_parameter_supported: false,
        request_uri_parameter_supported: false,
        claims_parameter_supported: false,
    };
}

function sendMetadata(req, res) {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(metadata(req.app.locals.config));
}

/** Mount the root discovery documents on the app (before the 404 handler). */
function mount(app) {
    app.get(['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server'], sendMetadata);
}

const wantsOpenid = (scope) => String(scope || '').split(/\s+/).includes('openid');

/** A nonce as the client sent it to /oauth/authorize (printable, bounded), or null. */
function cleanNonce(v) {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v);
    return s.length <= NONCE_MAX && /^[\x21-\x7e]+$/.test(s) ? s : undefined;   // undefined = refuse
}

function profileClaims(user) {
    return {
        preferred_username: user.username,
        name: user.display_name || user.username,
        ...(user.avatar_url ? { picture: user.avatar_url } : {}),
        ...(user.subject_id ? { subject_id: user.subject_id } : {}),
    };
}

/** The id_token for a code whose scope includes openid. */
function idToken({ user, clientId, nonce, privateKey, issuer }) {
    const rs = String(privateKey).includes('BEGIN');
    return jwt.sign({ sub: String(user.id), ...profileClaims(user), ...(nonce ? { nonce } : {}) }, privateKey, {
        algorithm: rs ? 'RS256' : 'HS256', issuer, audience: clientId, expiresIn: ID_TOKEN_TTL_S, ...(rs ? { keyid: KID } : {}),
    });
}

/** GET|POST /oauth/userinfo with `Authorization: Bearer <Network access token>`. */
function userinfo(req, res) {
    res.set('Cache-Control', 'no-store');
    const ah = String(req.headers.authorization || '');
    const token = ah.startsWith('Bearer ') ? ah.slice(7).trim() : '';
    const fail = (status, error) => res.status(status).set('WWW-Authenticate', `Bearer error="${error}"`).json({ error });
    if (!token) return fail(401, 'invalid_token');
    const out = require('./session').verifySession(token, { db: req.app.locals.db, publicKey: req.app.locals.publicKey, config: req.app.locals.config });
    if (out.error) return fail(out.status === 403 ? 403 : 401, out.status === 403 ? 'insufficient_scope' : 'invalid_token');
    // verifySession renews a recently expired session; an expired bearer token is not accepted here.
    if (typeof out.decoded.exp !== 'number' || out.decoded.exp * 1000 < Date.now()) return fail(401, 'invalid_token');
    const user = out.user;
    let subjectId = user.subject_id || null;
    try { subjectId = require('../identity/subjects').ensureUserSubject(req.app.locals.db, user) || subjectId; } catch { /* the claim is optional */ }
    res.json({ sub: String(user.id), ...profileClaims({ ...user, subject_id: subjectId }) });
}

module.exports = { metadata, mount, sendMetadata, idToken, userinfo, wantsOpenid, cleanNonce, KID, ID_TOKEN_TTL_S };
