'use strict';
/**
 * The shapes of the share events (Contracts share.v1, in review: OpenVibe.Contracts, branch "share").
 *
 *   a resource ref   { service, kind, id }
 *   a member         { subject, role: viewer | editor, expires_at?, added_by, added_at }
 *   a transfer       { to, keep_access, requested_at, expires_at, state }
 *
 * The events are share.granted, share.revoked, share.transfer.requested, share.transfer.accepted and
 * share.transfer.declined; their payloads carry ids only, never a title or content.
 *
 * The parser here is deliberately forgiving about where a field sits (payload.resource or the flat
 * payload.service / payload.kind / payload.id, payload.member.subject or payload.recipient), because
 * the contract is still being written. What it never does is invent: a field it cannot read is null,
 * and the caller treats that as "the event does not say enough".
 */
const { clean, iso, isSubject } = require('./store');

const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const KIND_RE = /^[a-z][a-z0-9_-]{1,39}$/;
const ITEM_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The resource an event is about, or null when the payload does not name one. */
function refOf(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const r = (p.resource && typeof p.resource === 'object') ? p.resource
        : (p.ref && typeof p.ref === 'object') ? p.ref
            : (p.item && typeof p.item === 'object') ? p.item : p;
    const service = clean(r.service, 40).toLowerCase();
    const kind = clean(r.kind, 40).toLowerCase();
    const id = clean(r.id != null ? r.id : r.item_id, 128);
    if (!SERVICE_RE.test(service) || !KIND_RE.test(kind) || !ITEM_RE.test(id)) return null;
    return { service, kind, id };
}

/** The person a grant names, or null. */
function memberOf(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const m = (p.member && typeof p.member === 'object') ? p.member : p;
    const subject = clean(m.subject || m.subject_id || p.member_subject || p.recipient || p.to, 64);
    if (!isSubject(subject)) return null;
    const role = clean(m.role, 20).toLowerCase() === 'editor' ? 'editor' : 'viewer';
    const addedBy = clean(m.added_by || p.added_by || p.owner || p.from || p.from_subject, 64);
    return {
        subject,
        role,
        expiresAt: iso(m.expires_at || p.expires_at),
        addedBy: isSubject(addedBy) ? addedBy : null,
        addedAt: iso(m.added_at || p.added_at || p.granted_at),
    };
}

/** The person a transfer names, or null. */
function partyOf(payload, which) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const raw = which === 'from'
        ? (p.from || p.from_subject || p.owner || p.owner_subject || p.sender)
        : (p.to || p.to_subject || p.recipient || p.buyer);
    const subject = clean(raw, 64);
    return isSubject(subject) ? subject : null;
}

/** The owner of the item, from the event's subject or actor when they are a person. */
function ownerOf(event, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const fromPayload = clean(p.owner || p.owner_subject || p.added_by || p.from || p.from_subject, 64);
    if (isSubject(fromPayload)) return fromPayload;
    const s = event && event.subject;
    if (s && typeof s === 'object' && s.type === 'user' && isSubject(s.id)) return s.id;
    const a = event && event.actor;
    if (a && typeof a === 'object' && a.type === 'user' && isSubject(a.id)) return a.id;
    return null;
}

/** When the event happened, as an ISO instant. */
function whenOf(event) {
    return iso(event && event.occurred_at) || new Date().toISOString();
}

module.exports = { refOf, memberOf, partyOf, ownerOf, whenOf };
