'use strict';
/**
 * The share events, and the notifications they become (design 2026-11-06, SHARING-DESIGN-2026-11-06.md).
 *
 * OpenVibe.Events delivers every share event to Network (POST /internal/events). Each one does two
 * things: it updates Network's index of what is shared with whom (server/sharing/store.js) and it
 * makes the notification the design asks for:
 *
 *   share.granted             the person who was added gets "goosely shared \"LOOI bridge notes\" with you"
 *   share.access.requested    the owner gets "goosely asked for access to \"LOOI bridge notes\""
 *   share.transfer.requested  the recipient gets "goosely wants to give you \"LOOI bridge notes\""
 *   share.transfer.accepted   the old owner gets "goosely accepted \"LOOI bridge notes\". Now it is yours"
 *   share.transfer.declined   the old owner gets "goosely declined \"LOOI bridge notes\""
 *
 * The events carry ids only, so the name of the item comes from the owning service's share API
 * (server/sharing/item.js). When the service does not answer, the text says the site and the kind
 * instead: a notification never guesses a title.
 *
 * The event names and shapes are the ones of Contracts share.v1, which is still being written
 * (OpenVibe.Contracts, branch "share"): this code waits for that release before it ships.
 */
const store = require('./store');
const { refOf, memberOf, partyOf, ownerOf, whenOf } = require('./refs');
const { resolveItem, mintViewerToken, audienceOf, siteOf } = require('./item');

const TOPICS = Object.freeze([
    'share.granted',
    'share.revoked',
    'share.transfer.requested',
    'share.transfer.accepted',
    'share.transfer.declined',
    'share.access.requested',
]);

// The notification kinds of the design. They are Network's own kinds, sent through the ordinary
// inbox (server/notifications/notification-service.js), so a person can mute them like any other.
const KINDS = Object.freeze({
    added: 'share.added',
    accessRequested: 'share.access_requested',
    transferRequested: 'share.transfer.requested',
    transferAnswered: 'share.transfer.answered',
});

/** "@goosely", or "someone" when the owner is not a Network account we know. */
function nameOf(person) {
    if (!person) return 'Someone';
    return '@' + String(person.username || '').slice(0, 40);
}

/** "a paste on OpenVibe.Community": what the text says when the service does not name the item. */
function fallbackName(ref) {
    const site = siteOf(ref.service);
    const kind = String(ref.kind || 'item').replace(/[_-]+/g, ' ');
    return 'a ' + kind + (site ? ' on ' + (site.full_name || site.name) : '');
}

/** The name of the item: the service's own, or the site and kind. */
function itemName(details, ref) {
    return details && details.title ? '"' + details.title + '"' : fallbackName(ref);
}

/**
 * The item's name and link, as the owning service sees them, for one person.
 * @returns {Promise<{title: string|null, url: string|null}>}
 */
async function detailsFor(ctx, ref, person) {
    const audience = audienceOf(ref.service);
    const token = person && audience ? mintViewerToken(ctx, person, audience) : null;
    return await resolveItem(ctx, ref, { token });
}

/**
 * One notification, for one person.
 * @returns {Promise<string>} the outcome, for the consumer's log.
 */
async function notify(ctx, { to, from, kind, title, message, icon, priority = 'normal', ref, url }) {
    const db = ctx.db;
    if (!store.isSubject(to)) return 'ignored:recipient';
    const recipient = await store.personBySubject(db, to);
    if (!recipient) return 'ignored:recipient';
    const owner = from && store.isSubject(from) ? await store.personBySubject(db, from) : null;
    const details = await detailsFor(ctx, ref, recipient);
    const sender = owner ? nameOf(owner) : 'Someone';
    const text = message(sender, itemName(details, ref));
    const link = details.url || url || null;
    const created = await ctx.notifications.create({
        user_id: recipient.id,
        type: kind,
        category: 'social',
        priority,
        icon,
        title,
        message: text,
        service: ref.service,
        url: link,
        sender_id: owner ? owner.id : null,
        sender_name: owner ? (owner.display_name || owner.username) : null,
        sender_avatar: owner ? owner.avatar_url : null,
        rich_content: {
            service: ref.service,
            context: {
                share_kind: kind,
                resource: { service: ref.service, kind: ref.kind, id: ref.id },
                owner_subject: owner ? owner.subject_id : null,
                planned_url: link,
            },
        },
    });
    return created ? 'notified' : 'suppressed:preference';
}

/** share.granted: the person who was added is told, and the item joins their list. */
async function granted(ctx, event, ref, payload, now) {
    const member = memberOf(payload);
    if (!member) return 'ignored:payload';
    const owner = member.addedBy || ownerOf(event, payload);
    if (!owner) return 'ignored:owner';
    await store.recordGrant(ctx.db, {
        recipient: member.subject,
        owner,
        service: ref.service,
        kind: ref.kind,
        itemId: ref.id,
        role: member.role,
        expiresAt: member.expiresAt,
        grantedAt: member.addedAt || now,
        eventId: event.event_id,
    });
    return await notify(ctx, {
        to: member.subject,
        from: owner,
        kind: KINDS.added,
        title: 'Shared with you',
        message: (sender, item) => sender + ' shared ' + item + ' with you.',
        icon: '🤝',
        ref,
    });
}

/** share.revoked: the item leaves that person's list. */
async function revoked(ctx, event, ref, payload, now) {
    const member = memberOf(payload);
    if (!member) return 'ignored:payload';
    const changed = await store.recordRevocation(ctx.db, {
        recipient: member.subject,
        service: ref.service,
        kind: ref.kind,
        itemId: ref.id,
        revokedAt: now,
        eventId: event.event_id,
    });
    return changed ? 'revoked' : 'ignored:unknown';
}

/** share.transfer.requested: the recipient is told, and the offer waits for them. */
async function transferRequested(ctx, event, ref, payload, now) {
    const from = partyOf(payload, 'from') || ownerOf(event, payload);
    const to = partyOf(payload, 'to');
    if (!from || !to) return 'ignored:payload';
    await store.recordTransfer(ctx.db, {
        id: payload.transfer_id ? String(payload.transfer_id).slice(0, 64) : null,
        service: ref.service,
        kind: ref.kind,
        itemId: ref.id,
        from,
        to,
        keepAccess: payload.keep_access === true,
        state: 'pending',
        requestedAt: store.iso(payload.requested_at) || now,
        expiresAt: store.iso(payload.expires_at),
        eventId: event.event_id,
    });
    return await notify(ctx, {
        to,
        from,
        kind: KINDS.transferRequested,
        title: 'Ownership offered',
        message: (sender, item) => sender + ' wants to give you ' + item + '.',
        icon: '🎁',
        priority: 'high',
        ref,
    });
}

/** share.transfer.accepted / .declined: the offer is answered, and the old owner is told. */
async function transferAnswered(ctx, event, ref, payload, now, accepted) {
    const from = partyOf(payload, 'from') || ownerOf(event, payload);
    const to = partyOf(payload, 'to');
    if (!from || !to) return 'ignored:payload';
    const state = accepted ? 'accepted' : 'declined';
    const keepAccess = payload.keep_access === true;
    const id = payload.transfer_id ? String(payload.transfer_id).slice(0, 64) : null;
    await store.recordTransfer(ctx.db, {
        id,
        service: ref.service,
        kind: ref.kind,
        itemId: ref.id,
        from,
        to,
        keepAccess,
        state,
        requestedAt: store.iso(payload.requested_at) || now,
        expiresAt: store.iso(payload.expires_at),
        answeredAt: now,
        eventId: event.event_id,
    });
    // The new owner holds the item; the old one keeps access only when they asked to keep it.
    if (accepted) {
        if (keepAccess) {
            await store.recordGrant(ctx.db, {
                recipient: from, owner: to, service: ref.service, kind: ref.kind, itemId: ref.id,
                role: 'viewer', expiresAt: null, grantedAt: now, eventId: event.event_id,
            });
        } else {
            await store.recordRevocation(ctx.db, {
                recipient: to, service: ref.service, kind: ref.kind, itemId: ref.id, revokedAt: now, eventId: event.event_id,
            });
        }
    }
    return await notify(ctx, {
        to: from,
        from: to,
        kind: KINDS.transferAnswered,
        title: 'Transfer answered',
        message: (sender, item) => accepted
            ? sender + ' accepted ' + item + '. It is theirs now.'
            : sender + ' declined ' + item + '. Nothing changed.',
        icon: '↩️',
        ref,
    });
}

/** share.access.requested: the owner is told, so they can add the person with one tap. */
async function accessRequested(ctx, event, ref, payload, now) {
    const from = partyOf(payload, 'from');
    const to = partyOf(payload, 'to') || ownerOf(event, payload);
    if (!from || !to) return 'ignored:payload';
    return await notify(ctx, {
        to,
        from,
        kind: KINDS.accessRequested,
        title: 'Access requested',
        message: (sender, item) => sender + ' asked for access to ' + item + '.',
        icon: '🔑',
        ref,
    });
}

/**
 * One share event: the index and the notification.
 * @returns {Promise<{outcome: string, detail?: object}>}
 */
async function applyShareEvent(ctx, event) {
    const type = String(event.event_type || '');
    if (!TOPICS.includes(type)) return { outcome: 'ignored:type' };
    const payload = (event.payload && typeof event.payload === 'object') ? event.payload : {};
    const ref = refOf(payload);
    if (!ref) return { outcome: 'ignored:payload' };
    const now = whenOf(event);
    let outcome;
    if (type === 'share.granted') outcome = await granted(ctx, event, ref, payload, now);
    else if (type === 'share.revoked') outcome = await revoked(ctx, event, ref, payload, now);
    else if (type === 'share.transfer.requested') outcome = await transferRequested(ctx, event, ref, payload, now);
    else if (type === 'share.transfer.accepted') outcome = await transferAnswered(ctx, event, ref, payload, now, true);
    else if (type === 'share.transfer.declined') outcome = await transferAnswered(ctx, event, ref, payload, now, false);
    else if (type === 'share.access.requested') outcome = await accessRequested(ctx, event, ref, payload, now);
    else outcome = 'ignored:type';
    return { outcome, detail: { resource: ref } };
}

module.exports = { applyShareEvent, TOPICS, KINDS };
