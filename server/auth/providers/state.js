'use strict';
/**
 * Where a started sign-in waits (plan §AB.20): one `signin_states` row, single use, ten minutes, never in a process
 * Map. That is what makes the callback correct across a restart, several Node processes and a load balancer (the old
 * discord-link.js kept its states in an in-memory Map and lost them on every restart, wrong across processes).
 *
 * The browser also carries a host-only, HttpOnly, SameSite=Lax cookie whose value is the state itself; only its
 * SHA-256 is in the row, and the cookie is cleared on the callback. The comparison is constant time. The PKCE
 * verifier and the nonce are sealed (AES-256-GCM) with a key derived from Network's own signing key, so the table
 * never holds them in the clear and a database copy alone cannot complete a flow.
 *
 *   const id = await states.create({ db, provider, mode, userId, verifier, nonce, returnTo, appQuery, seal })
 *   const row = await states.take({ db, state: cookieValue })   → the row once, then null forever
 */
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const COOKIE = '__Host-ov_signin';
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: TTL_MS };

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const newState = () => crypto.randomBytes(32).toString('base64url');

/** The sealing key: HKDF from the PEM that signs sessions, so no new secret has to be configured. */
function sealer(privateKey, salt = 'openvibe-network signin-state v1') {
    const ikm = Buffer.from(String(privateKey || ''), 'utf8');
    const keys = ikm.length >= 32 ? ikm : crypto.createHash('sha256').update(ikm).digest();
    const key = Buffer.from(crypto.hkdfSync('sha256', keys, Buffer.alloc(0), salt, 32));
    return {
        seal(value) {
            if (value == null) return null;
            const iv = crypto.randomBytes(12);
            const c = crypto.createCipheriv('aes-256-gcm', key, iv);
            const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
            return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
        },
        open(sealed) {
            if (!sealed) return null;
            try {
                const b = Buffer.from(String(sealed), 'base64');
                const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
                d.setAuthTag(b.subarray(12, 28));
                return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
            } catch { return null; }
        },
    };
}

/** Store one started flow; returns the state value for the cookie. */
async function create({ db, provider, mode, userId = null, verifier = null, nonce = null, returnTo = null, appQuery = null, seal }) {
    const state = newState();
    const expires = new Date(Date.now() + TTL_MS).toISOString();
    // A cheap sweep: an abandoned flow is one row each, and nothing else ever removes it.
    try { await db.prepare('DELETE FROM signin_states WHERE expires_at <= now()').run(); } catch { /* a first boot before the table exists */ }
    await db.prepare(`INSERT INTO signin_states (state_hash, provider, mode, user_id, verifier, nonce, return_to, app_query, expires_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(hash(state), provider, mode, userId, seal ? seal.seal(verifier) : verifier, seal ? seal.seal(nonce) : nonce, returnTo, appQuery, expires);
    return state;
}

/**
 * Redeem a state: the row once (deleted in the same statement), or null for an unknown, used or expired one. An
 * expired row is deleted too, so a late callback cannot be retried.
 */
async function take({ db, state }) {
    if (typeof state !== 'string' || !state) return null;
    const row = await db.prepare(`DELETE FROM signin_states WHERE state_hash = ? AND expires_at > now()
                                  RETURNING provider, mode, user_id, verifier, nonce, return_to, app_query`).get(hash(state));
    return row || null;
}

/** The cookie to set at the start of a flow, and to clear at its end. */
function setCookie(res, state) { res.cookie(COOKIE, state, COOKIE_OPTS); }
function clearCookie(res) { res.clearCookie(COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }); }

/** Whether a callback's state is the one this browser started (constant time; a missing cookie is a refusal). */
function matchesCookie(req, state) {
    const cookie = req.cookies ? req.cookies[COOKIE] : null;
    if (typeof cookie !== 'string' || typeof state !== 'string' || !cookie || !state) return false;
    const a = Buffer.from(cookie, 'utf8');
    const b = Buffer.from(state, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { create, take, sealer, setCookie, clearCookie, matchesCookie, hash, COOKIE, TTL_MS };
