/**
 * session.js — one place that decides "is this token a live session?", with SLIDING renewal.
 *
 * Access tokens are short-ish (config.jwt.accessTokenExpiry) but a session is not over when the
 * token's exp passes: any token that expired within GRACE_MS, for a user that still exists, is
 * not banned and has not revoked tokens since (token_valid_after), is accepted AND renewed —
 * the caller gets a fresh token to set as the cookie / hand back in the X-OV-Token header.
 * Sessions therefore only end after GRACE_MS of not showing up at all, on logout, on password
 * change, or on ban. This is what stops "session expired, sign in again" every day.
 */
'use strict';
const jwt = require('jsonwebtoken');

const GRACE_MS = 60 * 24 * 60 * 60 * 1000;      // renewable for 60 days after the token's exp

function verifySession(token, { db, publicKey, config }) {
    if (!token) return { error: 'Authentication required', status: 401 };
    const algorithm = publicKey.includes('BEGIN') ? 'RS256' : 'HS256';
    let decoded, expired = false;
    try {
        decoded = jwt.verify(token, publicKey, { algorithms: [algorithm], issuer: config.jwt.issuer });
    } catch (err) {
        if (err && err.name === 'TokenExpiredError') {
            try { decoded = jwt.verify(token, publicKey, { algorithms: [algorithm], issuer: config.jwt.issuer, ignoreExpiration: true }); expired = true; }
            catch { return { error: 'Invalid token', status: 401 }; }
            if (Date.now() - decoded.exp * 1000 > GRACE_MS) return { error: 'Session expired', status: 401, beyondGrace: true };
        } else {
            return { error: 'Invalid or expired token', status: 401 };
        }
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub || decoded.id);
    if (!user) return { error: 'User not found', status: 401 };
    if (user.is_banned) return { error: 'Account banned', status: 403, ban_reason: user.ban_reason };
    if (user.token_valid_after) {
        const validAfter = new Date(user.token_valid_after + (user.token_valid_after.includes('Z') ? '' : 'Z')).getTime();
        if (decoded.iat * 1000 < validAfter) return { error: 'Token revoked', status: 401 };
    }
    // Renew when expired, or when more than half of its lifetime is gone (keeps busy users' cookies fresh).
    const life = (decoded.exp - decoded.iat) * 1000;
    const renew = expired || (Number.isFinite(life) && life > 0 && Date.now() > decoded.iat * 1000 + life / 2);
    return { user, decoded, renew };
}

const COOKIE = { httpOnly: false, maxAge: 90 * 24 * 60 * 60 * 1000, sameSite: 'Lax', secure: true, path: '/' };
// The same session for cross-site use: httpOnly and SameSite=None so a hidden <iframe> from
// another OpenVibe site (GET /sso/check) can see whether this browser is signed in here without
// any redirect. JS never reads it; prompt=none and /sso/check fall back to it when ov_token is
// not sent (third-party context). Browsers that partition third-party cookies simply answer
// "not signed in" and the site falls back to its own hint.
const SSO_COOKIE = { httpOnly: true, maxAge: 90 * 24 * 60 * 60 * 1000, sameSite: 'None', secure: true, path: '/' };
function setSessionCookies(res, token) {
    res.cookie('ov_token', token, COOKIE);
    res.cookie('ov_sso', token, SSO_COOKIE);
}
function clearSessionCookies(res) {
    res.clearCookie('ov_token', { path: '/', sameSite: 'Lax', secure: true });
    res.clearCookie('ov_sso', { path: '/', sameSite: 'None', secure: true, httpOnly: true });
}
/**
 * The session token a request carries: Bearer header, then the page cookie, then the cross-site
 * one. Only for endpoints that change nothing (/sso/check) — see makeRequireAuth for why.
 */
function requestToken(req) {
    const h = req.headers?.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    return req.cookies?.ov_token || req.cookies?.ov_sso || null;
}
/** Express guard factory: attaches req.user / req.token; slides the session when due. */
function makeRequireAuth(getCtx, signToken) {
    return function requireAuth(req, res, next) {
        const authHeader = req.headers.authorization;
        // Never ov_sso here: it is SameSite=None, so a hostile page could make the browser send it
        // on a cross-site POST. Only the read-only /sso/check and the prompt=none authorize
        // (which yields a code bound to a registered redirect_uri) may consult it.
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.ov_token;
        const ctx = getCtx(req);
        const out = verifySession(token, ctx);
        if (out.error) return res.status(out.status).json(out.status === 403 ? { error: out.error, ban_reason: out.ban_reason } : { error: out.error });
        req.user = out.user;
        req.token = token;
        if (out.renew && typeof signToken === 'function') {
            try {
                const fresh = signToken(out.user, req.app.locals.privateKey, ctx.config);
                req.token = fresh;
                setSessionCookies(res, fresh);
                res.set('X-OV-Token', fresh);                 // JS clients swap their stored token
                res.set('Access-Control-Expose-Headers', 'X-OV-Token');
            } catch { /* renewal is best-effort */ }
        }
        next();
    };
}

module.exports = { verifySession, makeRequireAuth, GRACE_MS, COOKIE, SSO_COOKIE, setSessionCookies, clearSessionCookies, requestToken };
