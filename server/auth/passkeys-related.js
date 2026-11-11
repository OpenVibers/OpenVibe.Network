'use strict';
/**
 * Cross-site passkeys: WebAuthn Related Origin Requests (openvibe.network/.well-known/webauthn).
 *
 * A person on openvibe.blog runs `navigator.credentials.get` with Network's rpID; the browser checks
 * Network's well-known list and allows it for that exact origin. The ceremony is brokered by the
 * product's own server, never by the browser calling Network:
 *
 *   POST /api/auth/passkeys/related/options  (OAuth client)  → { state, options }
 *   POST /api/auth/passkeys/related/verify   (OAuth client)  → { result }   one use
 *   POST /api/auth/passkeys/related/redeem   (OAuth client)  → tokens for the product's session
 *
 * The client authenticates with its registered OAuth secret. Its exact redirect origin and the
 * published related-origin list must both contain the origin, which is never taken from a browser
 * header. The challenge is stored with a hash of (client, origin, browser binding); the product keeps
 * the browser binding in its own `__Host-` cookie. Network verifies the exact signed origin and RP ID,
 * consumes the challenge atomically, and keeps the existing user/presence/verification/counter/
 * lockout checks. The result is single-use and redeemable only by the same client and origin; it turns
 * into the product's ordinary audience-scoped session through /oauth/token's issuer, never a Network
 * session cookie or a browser-held Network bearer token.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const webauthn = require('@simplewebauthn/server');
const mfa = require('./mfa');
const dock = require('./dock-tokens');
const devTokens = require('../developer/tokens');
const origins = require('../webauthn-origins');

const RP = 'openvibe.network';
const BINDING_RE = /^[A-Za-z0-9_-]{32,128}$/;
const hash = mfa.hash;
const liveUser = u => u && !u.is_banned && !u.deleted_at && !u.merged_into;

function sameSecret(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function credentials(req) {
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Basic ')) {
        let decoded;
        try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return null; }
        const at = decoded.indexOf(':');
        if (at < 0) return null;
        return { id: decoded.slice(0, at), secret: decoded.slice(at + 1) };
    }
    return { id: req.body && req.body.client_id, secret: req.body && req.body.client_secret };
}

/** The confidential first-party OAuth client that is calling, or null. */
async function clientFrom(req, db) {
    const given = credentials(req);
    if (!given || typeof given.id !== 'string' || !given.id || given.id.length > 200) return null;
    if (devTokens.isAppClient(given.id) || /^lnk_/.test(given.id)) return null;
    const client = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(given.id);
    if (!client || dock.isPublicClient(client)) return null;
    return sameSecret(client.client_secret, given.secret) ? client : null;
}

/** The exact https origins this client may return to (its registered redirect URIs). */
function clientOrigins(client) {
    let list;
    try { list = JSON.parse(client.redirect_uris || '[]'); } catch { return []; }
    const out = new Set();
    for (const value of Array.isArray(list) ? list : []) {
        try {
            const u = new URL(String(value));
            if (u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && u.pathname !== '') out.add(u.origin);
        } catch { /* not an origin */ }
    }
    return [...out];
}

function originAllowed(client, origin) {
    return !!origin && origins.isApprovedOrigin(origin) && clientOrigins(client).includes(origin);
}

const challengeBinding = (clientId, origin, browserBinding) => hash(`ov-related-passkey\n${clientId}\n${origin}\n${browserBinding}`);
const resultBinding = (clientId, origin) => hash(`ov-related-result\n${clientId}\n${origin}`);

const invalid = res => res.status(401).json({ error: 'invalid_client' });
const refused = res => res.status(401).json({ error: 'passkey_or_state_invalid' });

function router() {
    const r = express.Router();
    // The product server is the caller; the browser never reaches these routes. Per-client, not per address: many
    // products share Network's loopback address.
    r.use(rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => String((req.body && req.body.client_id) || req.ip) }));

    r.post('/options', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const client = await clientFrom(req, db);
            if (!client) return invalid(res);
            const origin = origins.originOf(req.body && req.body.origin);
            if (!originAllowed(client, origin)) return res.status(403).json({ error: 'origin_not_allowed' });
            if (String((req.body && req.body.purpose) || 'login') !== 'login') return res.status(400).json({ error: 'unsupported_purpose' });
            const binding = String((req.body && req.body.binding) || '');
            if (!BINDING_RE.test(binding)) return res.status(400).json({ error: 'binding_required' });
            const options = await webauthn.generateAuthenticationOptions({ rpID: RP, userVerification: 'required' });
            const state = await require('./passkeys').save(db, 'related-login', options.challenge, null, challengeBinding(client.client_id, origin, binding));
            return res.json({ state, options });
        } catch { return res.status(503).json({ error: 'Passkey service unavailable' }); }
    });

    r.post('/verify', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const client = await clientFrom(req, db);
            if (!client) return invalid(res);
            const body = req.body || {};
            const origin = origins.originOf(body.origin);
            if (!originAllowed(client, origin)) return res.status(403).json({ error: 'origin_not_allowed' });
            const binding = String(body.binding || '');
            if (!BINDING_RE.test(binding) || typeof body.state !== 'string' || !body.state || !body.response || typeof body.response.id !== 'string') {
                return res.status(400).json({ error: 'invalid_request' });
            }
            const bind = challengeBinding(client.client_id, origin, binding);
            const result = await db.tx(async () => {
                const challenge = await require('./passkeys').take(db, body.state, 'related-login', bind);
                if (!challenge) return null;
                const key = await db.prepare('SELECT * FROM user_passkeys WHERE id = ?').get(body.response.id);
                if (!key) return null;
                const user = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(key.user_id);
                if (!liveUser(user)) return null;
                const factor = await mfa.factor(db, user.id, true);
                if (!factor || Number(factor.locked_until) > Date.now()) return null;
                // Re-read after the account lock: removal and concurrent assertions serialize here.
                const current = await db.prepare('SELECT * FROM user_passkeys WHERE id = ?').get(key.id);
                if (!current) return null;
                let checked;
                try {
                    checked = await webauthn.verifyAuthenticationResponse({
                        response: body.response,
                        expectedChallenge: challenge.challenge,
                        expectedOrigin: origin,          // the exact signed origin, never a header
                        expectedRPID: RP,
                        requireUserVerification: true,
                        credential: { id: current.id, publicKey: new Uint8Array(Buffer.from(current.public_key, 'base64url')), counter: Number(current.counter) },
                    });
                } catch { checked = { verified: false }; }
                // A discoverable sign-in must present the account's own user handle.
                const handle = body.response.response && body.response.response.userHandle;
                if (!checked.verified || !handle || handle !== factor.passkey_handle) {
                    const failures = Number(factor.locked_until) > 0 ? 1 : factor.failures + 1;
                    await db.prepare('UPDATE user_mfa SET failures = ?, locked_until = ? WHERE user_id = ?').run(failures, failures >= 5 ? Date.now() + 300000 : 0, user.id);
                    return null;
                }
                await db.prepare('UPDATE user_passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?').run(checked.authenticationInfo.newCounter, checked.authenticationInfo.credentialBackedUp, Date.now(), key.id);
                await db.prepare('UPDATE user_mfa SET failures = 0, locked_until = 0 WHERE user_id = ?').run(user.id);
                return require('./passkeys').save(db, 'related-result', '', user, resultBinding(client.client_id, origin));
            });
            if (!result) return refused(res);
            return res.json({ result });
        } catch { return res.status(503).json({ error: 'Passkey service unavailable' }); }
    });

    r.post('/redeem', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const client = await clientFrom(req, db);
            if (!client) return invalid(res);
            const body = req.body || {};
            const origin = origins.originOf(body.origin);
            if (!originAllowed(client, origin)) return res.status(403).json({ error: 'origin_not_allowed' });
            if (typeof body.result !== 'string' || !body.result) return res.status(400).json({ error: 'invalid_request' });
            const user = await db.tx(async () => {
                const challenge = await require('./passkeys').take(db, body.result, 'related-result', resultBinding(client.client_id, origin));
                if (!challenge || !challenge.user_id) return null;
                const row = await db.prepare('SELECT * FROM users WHERE id = ? FOR UPDATE').get(challenge.user_id);
                if (!liveUser(row) || challenge.credential_hash !== hash(row.password_hash)) return null;
                return row;
            });
            if (!user) return refused(res);
            const oauth = require('./oauth-routes');
            const pair = await oauth.issueTokenPair(db, req.app.locals.config, req, user, client, {}, 'profile');
            oauth.recordLinkedService(db, user, client);
            return res.json({
                access_token: pair.accessToken, refresh_token: pair.refreshToken, token_type: 'Bearer', expires_in: pair.expiresIn,
                user: { id: user.id, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url, profile_color: user.profile_color },
            });
        } catch { return res.status(503).json({ error: 'Passkey service unavailable' }); }
    });

    return r;
}

module.exports = { router, clientOrigins, originAllowed, RP };
