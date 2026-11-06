'use strict';
/**
 * Network's index of what is shared with whom (design 2026-11-06, SHARING-DESIGN-2026-11-06.md).
 *
 * The owning service stays the authority on access: its own canView decides who may open an item.
 * These rows are Network's read model, built from the share events over OpenVibe.Events
 * (share.granted, share.revoked, share.transfer.requested, share.transfer.accepted,
 * share.transfer.declined), and they answer three questions:
 *
 *   - "Shared with me": the items other people shared with this person (openvibe.network/shared).
 *   - "People you've shared with": the picker's suggestions, from this person's own history only.
 *   - the pending transfers, with the Accept and Decline links to the item.
 *
 * Event payloads carry ids only (never a title), so a row knows a service, a kind and an id; the
 * title and the item's own link come from the owning service's share API when it answers
 * (server/sharing/item.js).
 *
 * Timestamps are ISO-8601 UTC strings, so comparisons stay lexical.
 */
const crypto = require('crypto');

const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_SUGGESTIONS = 20;
const MAX_ITEMS = 200;

/** A usr_ subject, or null. */
const isSubject = (v) => USER_SUBJECT_RE.test(String(v || ''));

/** Plain, single-line, length-capped text: nothing from an event reaches a page as markup. */
function clean(v, n = 200) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

/** An ISO-8601 UTC instant, or null when the value is not a time. */
function iso(v) {
    if (v == null || v === '') return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The id of a membership row: the same person, item and grant always get the same row. */
function grantId(recipient, service, kind, itemId) {
    const h = crypto.createHash('sha256').update([recipient, service, kind, itemId].join('\u0000')).digest('hex').toUpperCase();
    return 'sgr_' + h.slice(0, 26);
}

/** The id of a transfer row, when the event does not name one. */
function transferId(from, to, service, kind, itemId) {
    const h = crypto.createHash('sha256').update([from, to, service, kind, itemId].join('\u0000')).digest('hex').toUpperCase();
    return 'sht_' + h.slice(0, 26);
}

/** The schema lives in migrations/0038_sharing.sql; nothing is created at runtime. */
function ensureSchema(db) { /* nothing to do */ }

/**
 * A membership: the item is shared with `recipient` by `owner`.
 * A second grant for the same item and person updates the row (the role may have changed).
 */
async function recordGrant(db, g) {
    const id = grantId(g.recipient, g.service, g.kind, g.itemId);
    await db.prepare(`INSERT INTO share_grants
        (id, recipient_subject, owner_subject, service, kind, item_id, role, expires_at, granted_at, revoked_at, event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT (recipient_subject, service, kind, item_id) DO UPDATE SET
            owner_subject = EXCLUDED.owner_subject,
            role = EXCLUDED.role,
            expires_at = EXCLUDED.expires_at,
            granted_at = EXCLUDED.granted_at,
            revoked_at = NULL,
            event_id = EXCLUDED.event_id`).run(
        id, g.recipient, g.owner, g.service, g.kind, g.itemId, g.role || 'viewer',
        g.expiresAt || null, g.grantedAt, g.eventId || null);
    return id;
}

/** The owner's access ended: the item leaves that person's list. */
async function recordRevocation(db, r) {
    const res = await db.prepare(`UPDATE share_grants SET revoked_at = ?, event_id = ?
        WHERE recipient_subject = ? AND service = ? AND kind = ? AND item_id = ? AND revoked_at IS NULL`)
        .run(r.revokedAt, r.eventId || null, r.recipient, r.service, r.kind, r.itemId);
    return res.changes || 0;
}

/** A transfer, or the answer to one. */
async function recordTransfer(db, t) {
    const id = t.id || transferId(t.from, t.to, t.service, t.kind, t.itemId);
    await db.prepare(`INSERT INTO share_transfers
        (id, service, kind, item_id, from_subject, to_subject, keep_access, state, requested_at, expires_at, answered_at, event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
            state = EXCLUDED.state,
            keep_access = EXCLUDED.keep_access,
            expires_at = EXCLUDED.expires_at,
            answered_at = EXCLUDED.answered_at,
            event_id = EXCLUDED.event_id`).run(
        id, t.service, t.kind, t.itemId, t.from, t.to, t.keepAccess ? 1 : 0, t.state || 'pending',
        t.requestedAt, t.expiresAt || null, t.answeredAt || null, t.eventId || null);
    return id;
}

/** The items shared with this person, newest first. A revoked or expired grant is not in the list. */
async function listGrants(db, subject, { now = new Date().toISOString(), limit = MAX_ITEMS } = {}) {
    if (!isSubject(subject)) return [];
    return await db.prepare(`SELECT * FROM share_grants
        WHERE recipient_subject = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY granted_at DESC, id DESC LIMIT ?`).all(subject, now, limit);
}

/** The transfers of this person, newest first. An offer past its date reads as expired. */
async function listTransfers(db, subject, { now = new Date().toISOString(), limit = 50 } = {}) {
    if (!isSubject(subject)) return [];
    const rows = await db.prepare(`SELECT * FROM share_transfers WHERE to_subject = ? OR from_subject = ?
        ORDER BY requested_at DESC, id DESC LIMIT ?`).all(subject, subject, limit);
    return rows.map((r) => (r.state === 'pending' && r.expires_at && r.expires_at <= now ? { ...r, state: 'expired' } : r));
}

/** The person's own row: their subject, name and picture. */
async function personBySubject(db, subject) {
    if (!isSubject(subject)) return null;
    return await db.prepare('SELECT id, subject_id, username, display_name, avatar_url FROM users WHERE subject_id = ?').get(subject);
}

/** How a person is shown: @name and a display name. */
function personView(row) {
    if (!row) return null;
    return {
        subject: row.subject_id,
        username: row.username,
        display_name: row.display_name || row.username,
        avatar_url: row.avatar_url || null,
    };
}

/**
 * The people this person has shared with (the picker's suggestions): only from their own history,
 * newest first, at most 20.
 */
async function listSuggestions(db, subject, { limit = MAX_SUGGESTIONS } = {}) {
    if (!isSubject(subject)) return [];
    const rows = await db.prepare(`SELECT recipient_subject, MAX(granted_at) AS last_at, COUNT(*)::int AS shares
        FROM share_grants WHERE owner_subject = ? AND recipient_subject <> owner_subject
        GROUP BY recipient_subject ORDER BY last_at DESC LIMIT ?`).all(subject, Math.min(Number(limit) || MAX_SUGGESTIONS, MAX_SUGGESTIONS));
    const out = [];
    for (const r of rows) {
        const person = await personBySubject(db, r.recipient_subject);
        if (!person) continue;                     // a deleted or merged account is not a suggestion
        out.push({ ...personView(person), shared_at: r.last_at, shares: Number(r.shares) || 1 });
    }
    return out;
}

/** One @name check, counted against the person's budget. */
async function recordNameCheck(db, userId, name, now = new Date().toISOString()) {
    await db.prepare('INSERT INTO share_name_checks (user_id, name, checked_at) VALUES (?, ?, ?)')
        .run(Number(userId), clean(name, 64), now);
}

/** How many @name checks this person made since a moment. */
async function countNameChecks(db, userId, since) {
    const r = await db.prepare('SELECT COUNT(*)::int AS n FROM share_name_checks WHERE user_id = ? AND checked_at > ?')
        .get(Number(userId), since);
    return Number(r && r.n) || 0;
}

module.exports = {
    ensureSchema, isSubject, clean, iso, grantId, transferId,
    recordGrant, recordRevocation, recordTransfer,
    listGrants, listTransfers, personBySubject, personView, listSuggestions,
    recordNameCheck, countNameChecks,
    MAX_SUGGESTIONS, MAX_ITEMS,
};
