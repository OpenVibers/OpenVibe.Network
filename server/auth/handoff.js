'use strict';
/**
 * One-time cross-site sign-in handoff tickets (signin arrival part 3).
 *
 *   POST /api/v1/handoff/tickets  → 200 { ticket, expires_at, expires_in, client_id }
 *   POST /api/v1/handoff/redeem   → 200 { code, expires_in }
 *
 * The source site's server mints a ticket for its signed-in person (the person's own Bearer
 * token, never a cookie a hostile page could send), puts it on a link to another OpenVibe site,
 * and the destination's server redeems it for a standard OAuth authorization code, which it
 * exchanges at /oauth/token through the unchanged grant path (client_secret + registered
 * redirect_uri + single-use code). The browser makes no extra round trip: the destination sets
 * its own session cookie while serving the first navigation, so the page renders signed in on
 * its first paint.
 *
 * Security properties:
 * - Only the SHA-256 hash is stored; the ticket itself (`ovh_` + 32 random bytes) is high
 *   entropy and never logged (POST bodies are not access-logged; never put it in a query string
 *   server-side).
 * - 60 s expiry, atomic single-use (`UPDATE ... WHERE used = 0`), bound to the exact destination
 *   client_id AND redirect_uri (both must match the client's registered redirect_uris).
 * - Redeem refuses banned/merged/deleted accounts and accounts whose tokens were revoked after
 *   the ticket was issued (password change / sign-out-everywhere).
 * - Audience checks are unchanged: the code is redeemed for the destination client's own
 *   audience-scoped session through the existing token endpoint.
 *
 * Integration contract for destinations (enforced there, not here):
 * - Never redeem when the destination already has a session (no silent account switch), and
 *   never redeem when the browser carries the destination's own guest hint (a guest stays a
 *   guest with no round trip at all).
 * - Known residual: a bearer ticket is redeemable by whichever browser presents it first, so a
 *   fresh ticket link pasted into a stranger's address bar within its 60 s life signs that
 *   browser into the ticket owner's account on that one site. The 60 s life, single use, exact
 *   destination binding and never-switch rule make a real-time targeted trick the only vector;
 *   a browser-transaction binding is future hardening (see signin-handoff-design.md).
 *
 *   401  no session (issue) / bad ticket or client credentials (redeem)
 *   403  guest sessions cannot mint tickets
 *   503  no such destination client or unregistered redirect_uri is 400, not 503
 */

const crypto = require('crypto');
const express = require('express');

const TTL_S = 60;
const CODE_TTL_S = 5 * 60;
const TICKET_PREFIX = 'ovh_';

function hashTicket(ticket) {
    return crypto.createHash('sha256').update(String(ticket || ''), 'utf8').digest('hex');
}

/** Mint a ticket for `userId` bound to one destination. → { ticket, ticketHash, issuedAt, expiresAt } */
function mintTicket({ userId, now = Date.now() } = {}) {
    if (!Number.isInteger(userId)) throw new Error('handoff ticket: a numeric user id is required');
    const ticket = `${TICKET_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + TTL_S * 1000).toISOString();
    return { ticket, ticketHash: hashTicket(ticket), issuedAt, expiresAt };
}

/** Issue a standard single-use authorization code row for the redeemed ticket. → { code, expiresAt } */
async function issueHandoffCode(db, { clientId, userId, redirectUri, scope }) {
    const code = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + CODE_TTL_S * 1000).toISOString();
    await db.prepare(`INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, expires_at, code_challenge, code_challenge_method, nonce)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`).run(code, clientId, userId, redirectUri, scope || 'profile theme', expiresAt);
    return { code, expiresAt };
}

function sameSecret(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function parseTime(v) {
    const s = String(v || '');
    if (!s) return NaN;
    return new Date(s + (s.includes('Z') ? '' : 'Z')).getTime();
}

function registeredRedirect(allowedUris, redirectUri) {
    const want = String(redirectUri || '').toLowerCase();
    return Array.isArray(allowedUris) && allowedUris.some(u => String(u).toLowerCase() === want);
}

/**
 * Mint a ticket for one destination, storing only its hash. Throws { status, code, error } when the
 * destination client is unknown or the redirect URI is not registered for it. Same-service arrivals
 * (openvibe.link's hub) mint through this instead of the HTTP route below.
 */
async function issueTicketForUser(database, { userId, clientId, redirectUri, scope = 'profile theme', source = null }) {
    if (!Number.isInteger(userId)) throw { status: 401, code: 'handoff.no_user', error: 'Sign in required' };
    if (!clientId || !redirectUri) throw { status: 400, code: 'invalid_request', error: 'client_id and redirect_uri are required' };
    const client = await database.prepare('SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?').get(String(clientId));
    if (!client) throw { status: 400, code: 'invalid_request', error: 'Unknown destination client' };
    if (!registeredRedirect(JSON.parse(client.redirect_uris || '[]'), String(redirectUri))) {
        throw { status: 400, code: 'invalid_request', error: 'Unregistered redirect_uri' };
    }
    const { ticket, ticketHash, issuedAt, expiresAt } = mintTicket({ userId });
    // Expired tickets never redeem; sweep them where a fresh one is minted so the table stays small.
    try { await database.prepare('DELETE FROM handoff_tickets WHERE expires_at < ?').run(new Date(Date.now() - 3600e3).toISOString()); } catch { /* sweep is best-effort */ }
    await database.prepare(`INSERT INTO handoff_tickets (ticket_hash, user_id, client_id, redirect_uri, scope, source, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketHash, userId, String(clientId), String(redirectUri), String(scope).slice(0, 200), source ? String(source).slice(0, 200) : null, issuedAt, expiresAt);
    return { ticket, expiresAt, expiresIn: TTL_S, clientId: String(clientId) };
}

/**
 * Consume a ticket for one destination, atomically single-use. → { user, scope }. Throws
 * { status, code, error } for an unknown, used, expired, mismatched or revoked ticket, or when the
 * account is banned, merged, deleted, or its tokens were revoked after issuance. Same-service
 * arrivals use this and then sign their own session; cross-service arrivals go through /redeem.
 */
async function consumeTicket(database, { ticket, clientId, redirectUri }) {
    const fail = (status, code, error) => { throw { status, code, error }; };
    const presented = String(ticket || '');
    if (!presented.startsWith(TICKET_PREFIX) || presented.length > 200) fail(400, 'invalid_grant', 'Unknown or used handoff ticket');
    const row = await database.prepare('SELECT * FROM handoff_tickets WHERE ticket_hash = ?').get(hashTicket(presented));
    if (!row || row.used) fail(400, 'invalid_grant', 'Unknown or used handoff ticket');
    if (row.client_id !== String(clientId)) fail(400, 'invalid_grant', 'Ticket is for another client');
    if (String(row.redirect_uri).toLowerCase() !== String(redirectUri).toLowerCase()) fail(400, 'invalid_grant', 'Redirect URI mismatch');
    if (Date.now() > parseTime(row.expires_at)) {
        await database.prepare('UPDATE handoff_tickets SET used = 1 WHERE ticket_hash = ?').run(row.ticket_hash);
        fail(400, 'invalid_grant', 'Handoff ticket expired');
    }
    const user = await database.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user || user.is_banned || user.merged_into || user.deleted_at) {
        await database.prepare('UPDATE handoff_tickets SET used = 1 WHERE ticket_hash = ?').run(row.ticket_hash);
        fail(400, 'invalid_grant', 'Account is no longer valid');
    }
    // A password change or sign-out-everywhere after issuance revokes outstanding tickets.
    if (user.token_valid_after && parseTime(row.issued_at) < parseTime(user.token_valid_after)) {
        await database.prepare('UPDATE handoff_tickets SET used = 1 WHERE ticket_hash = ?').run(row.ticket_hash);
        fail(400, 'invalid_grant', 'Handoff ticket revoked');
    }
    // Atomic single-use: two concurrent redeems cannot both succeed.
    const consumed = await database.prepare('UPDATE handoff_tickets SET used = 1 WHERE ticket_hash = ? AND used = 0').run(row.ticket_hash);
    if (consumed.changes !== 1) fail(400, 'invalid_grant', 'Unknown or used handoff ticket');
    return { user, scope: row.scope };
}

/** The redeem router. `requireAuth` is the session guard (user Bearer token or first-party cookie). */
function router({ db, requireAuth }) {
    const r = express.Router();
    const getDb = async () => (typeof db?.prepare === 'function' ? db : await db);

    // The ticket mint: the person's own source site calls with the person's Bearer token.
    r.post('/tickets', requireAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const database = await getDb();
            const user = req.user;
            if (!user || user.is_anon) return res.status(403).json({ code: 'handoff.guest', error: 'sign in with an account to mint a handoff ticket' });
            const { ticket, expiresAt, expiresIn, clientId } = await issueTicketForUser(database, {
                userId: user.id, clientId: String(req.body?.client_id || ''), redirectUri: String(req.body?.redirect_uri || ''),
                scope: req.body?.scope, source: req.body?.source,
            });
            res.json({ ticket, expires_at: expiresAt, expires_in: expiresIn, client_id: clientId });
        } catch (err) {
            if (err && err.status) return res.status(err.status).json({ code: err.code, error: err.error });
            res.status(500).json({ error: 'handoff issue failed' });
        }
    });

    // The destination's server redeems with its OAuth client credentials. No browser session needed.
    r.post('/redeem', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const database = await getDb();
            const { ticket, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri } = req.body || {};
            if (!ticket || !clientId || !clientSecret || !redirectUri) {
                return res.status(400).json({ error: 'invalid_request', error_description: 'ticket, client_id, client_secret and redirect_uri are required' });
            }
            const client = await database.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(String(clientId));
            if (!client || !sameSecret(client.client_secret, clientSecret)) {
                return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
            }
            const { user, scope } = await consumeTicket(database, { ticket, clientId, redirectUri });
            const { code } = await issueHandoffCode(database, { clientId: client.client_id, userId: user.id, redirectUri: String(redirectUri), scope });
            res.json({ code, expires_in: CODE_TTL_S });
        } catch (err) {
            if (err && err.status) return res.status(err.status).json({ error: err.code || 'invalid_grant', error_description: err.error });
            res.status(500).json({ error: 'handoff redeem failed' });
        }
    });

    return r;
}

module.exports = { router, mintTicket, issueTicketForUser, consumeTicket, issueHandoffCode, hashTicket, TTL_S, CODE_TTL_S, TICKET_PREFIX };
