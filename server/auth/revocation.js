'use strict';
/**
 * Ending a person's tokens everywhere (roadmap WS-B task 4; Contracts 0.39.0
 * network.user.token_valid_after).
 *
 * revokeTokens() moves users.token_valid_after to now, ends their Network sessions and, in the same
 * transaction, queues network.user.token_valid_after in network_event_outbox (relayed to
 * OpenVibe.Events by server/developer/event-relay.js). Network itself already refuses a token whose
 * iat * 1000 < token_valid_after (auth/session.js, /api/auth/refresh) and a refresh token created
 * before it (auth/oauth-routes.js); the event makes Chat, Community, Live, Media, Tools and Games do
 * the same and close the sockets those tokens opened.
 *
 * Reasons: password_changed | password_reset | signed_out_everywhere | banned | account_deleted |
 * staff_revoked. Call it inside the caller's transaction when there is one (it nests), then kick().
 */
const { ids, validate } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');

const EVENT_TYPE = 'network.user.token_valid_after';
const REASONS = ['password_changed', 'password_reset', 'signed_out_everywhere', 'banned', 'account_deleted', 'staff_revoked'];

const iso = (v) => new Date(String(v) + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z')).toISOString();

function buildEnvelope({ subjectId, validAfter, reason, actor, ctx }) {
    const payload = { subject: { type: 'user', id: subjectId }, valid_after: validAfter, reason };
    const pv = validate(`${EVENT_TYPE}@1`, payload);
    if (!pv.valid) throw new Error(`revocation: bad payload: ${pv.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
    const ms = Date.now();
    const env = {
        event_id: ids.newId('event', ms), event_type: EVENT_TYPE, version: 1, source: 'network',
        actor, timestamp: new Date(ms).toISOString(), visibility: 'internal',
        subject: { type: 'user', id: subjectId }, payload,
    };
    if (ctx && /^[0-9a-f]{32}$/.test(ctx.traceId || '')) env.trace_id = ctx.traceId;
    const v = validate('events.event-envelope@1', env);
    if (!v.valid) throw new Error(`revocation: bad envelope: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
    return env;
}

/**
 * @param {object} db      better-sqlite3 database
 * @param {number} userId  users.id
 * @param {{ reason: string, actor?: object, ctx?: object }} opts  actor defaults to the person themself
 * @returns {{ validAfter: string, event: object|null }}  event is null for an account with no subject
 */
function revokeTokens(db, userId, { reason, actor, ctx } = {}) {
    if (!REASONS.includes(reason)) throw new Error(`revocation: unknown reason ${reason}`);
    return db.transaction(() => {
        const user = db.prepare('SELECT id, subject_id FROM users WHERE id = ?').get(userId);
        if (!user) throw new Error(`revocation: no user ${userId}`);
        db.prepare('UPDATE users SET token_valid_after = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
        db.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').run(user.id);
        const validAfter = iso(db.prepare('SELECT token_valid_after AS t FROM users WHERE id = ?').get(user.id).t);
        let event = null;
        if (ids.isSubjectId('user', user.subject_id)) {
            const by = actor || { type: 'user', id: user.subject_id };
            event = buildEnvelope({ subjectId: user.subject_id, validAfter, reason, actor: by, ctx });
            eventRelay.writerFor(db).enqueue(event, { traceparent: ctx && ctx.traceparent });
        }
        return { validAfter, event };
    })();
}

/** After the commit: wake the relay if this process runs one. */
function kick(db) {
    const live = eventRelay.outboxFor(db);
    if (live) live.kick();
}

module.exports = { revokeTokens, kick, buildEnvelope, EVENT_TYPE, REASONS };
