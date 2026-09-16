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
/** Express guard factory: attaches req.user / req.token; slides the session when due. */
function makeRequireAuth(getCtx, signToken) {
    return function requireAuth(req, res, next) {
        const authHeader = req.headers.authorization;
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
                res.cookie('ov_token', fresh, COOKIE);
                res.set('X-OV-Token', fresh);                 // JS clients swap their stored token
                res.set('Access-Control-Expose-Headers', 'X-OV-Token');
            } catch { /* renewal is best-effort */ }
        }
        next();
    };
}

module.exports = { verifySession, makeRequireAuth, GRACE_MS, COOKIE };
