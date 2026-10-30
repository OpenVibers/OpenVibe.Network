'use strict';
/**
 * Run tokens (Codes C3): the consent, the audit trail and the limit behind a token that names a person.
 *
 * A run token is a service token that acts for a person (`on_behalf_of`). Minting one for somebody is only
 * safe when three things hold, and the caller (server/identity/principals.js issueToken) checks them in
 * this order:
 *
 *   1. The service holds the consent grant for the audience (ai.credential.manage). That is the grant that
 *      lets it store the person's own provider key in OpenVibe.AI.
 *   2. The person signed in to THAT service: a live refresh-token family in oauth_tokens for
 *      (client_id = the service, user_id = the person). A sign-out, a revoked family or an expired token
 *      ends it, so a service that is compromised cannot mint for a person who never signed in to it, and a
 *      person who signed out of Codes stops Codes from speaking for them.
 *   3. The service is within its limit for that person: at most RUN_TOKEN_LIMIT_PER_HOUR run tokens an hour
 *      for one (client, person) pair. Past that the request answers 429 with the seconds until the oldest
 *      one leaves the window.
 *
 * Every minted run token leaves an audit row — the action, the client, the person, the ttl and the jti, and
 * never the token itself — and a row in run_token_mints, the ledger the limit counts.
 */

/** Run tokens one service may mint for one person in an hour. */
const RUN_TOKEN_LIMIT_PER_HOUR = 120;
/** The window the limit counts in (ms). */
const RUN_TOKEN_WINDOW_MS = 60 * 60 * 1000;
/** The audit action every minted run token leaves. */
const RUN_TOKEN_AUDIT_ACTION = 'run_token_issued';

/** 'YYYY-MM-DD HH:MM:SS' (UTC) or an ISO string -> ms; NaN when it is not a time. */
function at(value) {
    if (!value) return NaN;
    const text = String(value);
    const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? t : NaN;
}

/**
 * The person behind a usr_ subject: their row in users (the subject is users.subject_id; the integer id
 * stays the key). → the row, or null when there is no such person.
 */
async function personRow(db, subject) {
    return await db.prepare('SELECT id, subject_id FROM users WHERE subject_id = ?').get(String(subject || ''));
}

/**
 * Has this person signed in to this service? A live refresh token of theirs for that client: not revoked,
 * not expired. The token itself is a hash in the row; nothing here reads it.
 * → { ok: true, userId } when they have, { ok: false, reason } when they have not.
 */
async function consentFor(db, clientId, subject) {
    const user = await personRow(db, subject);
    if (!user) return { ok: false, reason: 'no_person' };
    const rows = await db.prepare('SELECT expires_at FROM oauth_tokens WHERE client_id = ? AND user_id = ? AND revoked = 0')
        .all(String(clientId || ''), user.id);
    const now = Date.now();
    const live = rows.find((r) => { const t = at(r.expires_at); return Number.isFinite(t) && t > now; });
    return live ? { ok: true, userId: user.id } : { ok: false, reason: 'no_consent', userId: user.id };
}

/**
 * May this service mint another run token for this person right now?
 * → { ok: true, used } while there is room, { ok: false, retryAfter } once the limit is reached (the seconds
 * until the oldest mint of the window leaves it).
 */
async function mintLimit(db, { clientId, subject, now = Date.now() } = {}) {
    const rows = await db.prepare('SELECT minted_at FROM run_token_mints WHERE client_id = ? AND subject = ? AND minted_at > ? ORDER BY minted_at ASC')
        .all(String(clientId || ''), String(subject || ''), now - RUN_TOKEN_WINDOW_MS);
    if (rows.length < RUN_TOKEN_LIMIT_PER_HOUR) return { ok: true, used: rows.length };
    const oldest = Number(rows[0] && rows[0].minted_at) || now;
    const retryAfter = Math.max(1, Math.ceil((oldest + RUN_TOKEN_WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter, used: rows.length };
}

/**
 * The trace of one minted run token: the audit row (who, for whom, how long, which jti — never the token)
 * and the ledger row the limit counts. Both in one transaction, so a token that was minted is always traced.
 */
async function recordMint(db, { clientId, subject, userId = null, jti = null, ttl = null, now = Date.now() } = {}) {
    await db.tx(async () => {
        await db.prepare('INSERT INTO run_token_mints (client_id, subject, user_id, jti, minted_at) VALUES (?, ?, ?, ?, ?)')
            .run(String(clientId || ''), String(subject || ''), userId, jti, Math.floor(now));
        await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
            .run(userId, RUN_TOKEN_AUDIT_ACTION, JSON.stringify({ client_id: clientId, subject, ttl_seconds: ttl, jti }));
    });
}

module.exports = {
    RUN_TOKEN_LIMIT_PER_HOUR, RUN_TOKEN_WINDOW_MS, RUN_TOKEN_AUDIT_ACTION,
    personRow, consentFor, mintLimit, recordMint,
};
