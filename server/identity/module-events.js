'use strict';
/**
 * network.module.updated: one event per change to a user-module record (server/identity/modules.js),
 * written into network_event_outbox in the transaction that makes the change and relayed to
 * OpenVibe.Events by server/developer/event-relay.js (at least once; Events drops a repeated event_id).
 *
 * Envelope: source network, visibility internal, subject { type: 'user_module', id: '<owner>:<namespace>',
 * revision }, actor = who changed it (the person, the owning service, or system:network for account
 * lifecycle). Payload (proposed contract events/payloads/network.module.updated.v1):
 *
 *   owner           subject ref of the person the record belongs to (usr_ or gst_)
 *   namespace       e.g. chat.preferences
 *   namespace_owner the service that owns the namespace (after any handoff in modules.js)
 *   schema_version  the record's schema version (the namespace version it was written under)
 *   revision        the record's revision after the change; it grows by one on every change to
 *                   (owner, namespace), deletes included, and never restarts, so a consumer keeps the
 *                   highest revision it has applied and ignores anything lower
 *   change          created | updated | deleted
 *   reason          write | delete | owner_delete | subject_removed | subject_merged
 *   keys            top-level fields that were added, changed or removed (names only, sorted)
 *   public          only for fields the namespace declares public and that changed: their new value
 *                   (null = removed). Absent for private namespaces: a value never leaves otherwise.
 *   merged_into / merged_from  subject refs, on the two sides of an account merge
 *
 * Nothing here reads or writes user_modules; the caller passes before/after.
 */
const { ids, modules, validate } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');

const EVENT_TYPE = 'network.module.updated';
const SUBJECT_TYPE = 'user_module';
const REASONS = ['write', 'delete', 'owner_delete', 'subject_removed', 'subject_merged'];

const subjectRef = (sid) => ({ type: String(sid).startsWith('gst_') ? 'guest' : 'user', id: sid });

/** Top-level keys whose value differs between two data objects (added, changed or removed), sorted. */
function changedKeys(before, after) {
    const a = before && typeof before === 'object' ? before : {};
    const b = after && typeof after === 'object' ? after : {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/**
 * The envelope for one change. `actor` is a subject ref ({ type: 'user'|'guest'|'service'|'system', id }).
 * Throws if the envelope would not match events.event-envelope@1 (a bug, never user input).
 */
function buildEnvelope({ subjectId, namespace, namespaceOwner, schemaVersion, revision, change, reason, before, after, actor, mergedInto, mergedFrom, ctx }) {
    if (!REASONS.includes(reason)) throw new Error(`module-events: unknown reason ${reason}`);
    const keys = changedKeys(before, change === 'deleted' ? {} : after);
    const payload = {
        owner: subjectRef(subjectId), namespace, namespace_owner: namespaceOwner, schema_version: schemaVersion,
        revision, change, reason, keys,
    };
    const ns = modules.get(namespace);
    const publicKeys = ns && change !== 'deleted' ? keys.filter(k => ns.publicFields.includes(k)) : [];
    if (publicKeys.length) {
        payload.public = {};
        for (const k of publicKeys) payload.public[k] = after && Object.prototype.hasOwnProperty.call(after, k) ? after[k] : null;
    }
    if (mergedInto) payload.merged_into = subjectRef(mergedInto);
    if (mergedFrom) payload.merged_from = subjectRef(mergedFrom);
    const ms = Date.now();
    const env = {
        event_id: ids.newId('event', ms), event_type: EVENT_TYPE, version: 1, source: 'network',
        actor, timestamp: new Date(ms).toISOString(), visibility: 'internal',
        subject: { type: SUBJECT_TYPE, id: `${subjectId}:${namespace}`, revision }, payload,
    };
    if (ctx && /^[0-9a-f]{32}$/.test(ctx.traceId || '')) env.trace_id = ctx.traceId;
    const v = validate('events.event-envelope@1', env);
    if (!v.valid) throw new Error(`module-events: bad envelope: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
    return env;
}

/** Create network_event_outbox if no relay has yet (boot), so a module write never has to. */
function ensureSchema(db) {
    eventRelay.writerFor(db);
}

/** Build and enqueue; call INSIDE the transaction that makes the change. Returns the envelope. */
function record(db, change) {
    const env = buildEnvelope(change);
    eventRelay.writerFor(db).enqueue(env, { traceparent: change.ctx && change.ctx.traceparent });
    return env;
}

/** After the commit: wake the relay if this process runs one. */
function kick(db) {
    const live = eventRelay.outboxFor(db);
    if (live) live.kick();
}

module.exports = { EVENT_TYPE, SUBJECT_TYPE, REASONS, changedKeys, buildEnvelope, ensureSchema, record, kick };
