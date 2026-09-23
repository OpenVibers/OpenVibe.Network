'use strict';
/**
 * Versioned user modules (roadmap Wave 1 item 13, sections 4.3-4.5).
 *
 * One JSON record per (subject, namespace). Namespaces, their schemas, writers, public fields and
 * quotas come from openvibe-contracts (manifests/namespaces). Writes replace the record and must name
 * the revision they read (If-Match); a moved revision is 412, so two writers never silently overwrite
 * each other. Modules hold portable preferences and summaries, never domain truth.
 *
 *   user     GET    /api/modules                       every record of mine (export)
 *            GET    /api/modules/:ns                   mine
 *            PUT    /api/modules/:ns   If-Match: <rev>  { data }  (namespaces users may write)
 *            DELETE /api/modules/:ns                   mine, any namespace (my data)
 *   public   GET    /api/modules/:ns/public/:subject   only the namespace's public fields
 *   service  GET    /internal/modules/:ns/:subject     token with network.modules.read for ns
 *            PUT    /internal/modules/:ns/:subject     token with network.modules.write for ns, owner only
 *            DELETE /internal/modules/:ns/:subject     same; If-Match optional
 *
 * Every change emits network.module.updated (./module-events.js) in the same transaction. Revisions
 * never go backwards for a (subject, namespace): user_module_revisions keeps the last one issued, so
 * a record deleted and written again continues from there and a delete has a revision of its own.
 *
 * Lifecycle:
 *   - accounts: onSubjectRemoved() deletes a subject's records, onSubjectMerged() re-keys them into the
 *     surviving subject; both emit events. Triggers refuse deleting a users/anon_users row, or changing
 *     its subject_id, while module rows remain, so an account deletion or merge cannot skip them.
 *   - owning service retired (namespace onOwnerRemoved, contract modules.namespace@1): when the owner's
 *     service manifest says `retired`, the namespace is read-only (retain-readonly), and with
 *     delete-after-retention sweepRetired() deletes its records retentionDays after Network first saw
 *     the owner retired. People can always read, export and delete their own records.
 */
const express = require('express');
const { modules, services, http, assertValid } = require('openvibe-contracts');
const subjects = require('./subjects');
const moduleEvents = require('./module-events');

const SUBJECT_RE = /^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Namespaces whose owner moved before openvibe-contracts caught up. The manifest of chat.preferences
 * (0.30.x) still names live and says it "moves to OpenVibe.Chat in Wave 6"; Chat has served Live's chat
 * since the Wave 6 cutover (2026-09-23). The handoff applies only while the installed manifest still
 * names `from`: once Contracts publishes owner `to` it is a no-op, and the entry can be deleted.
 */
const OWNER_HANDOFFS = Object.freeze({
    'chat.preferences': Object.freeze({ from: 'live', to: 'chat' }),
});

/** The service that owns a namespace now (the manifest's owner unless a handoff moved it). */
function ownerOf(namespace) {
    const ns = modules.get(namespace);
    if (!ns) return null;
    const h = OWNER_HANDOFFS[namespace];
    return h && ns.owner === h.from ? h.to : ns.owner;
}

/** modules.canWrite with the handoff applied. writer = { type: 'user' } | { type: 'service', id } */
function canWrite(namespace, writer) {
    const ns = modules.get(namespace);
    if (!ns || !writer) return false;
    if (writer.type === 'user') return ns.writers.includes('user');
    if (writer.type === 'service') return ns.writers.includes('owner') && writer.id === ownerOf(namespace);
    return false;
}

/** Is the namespace's owning service retired (its service manifest's status)? */
function ownerRetired(namespace) {
    const owner = ownerOf(namespace);
    const m = owner ? services.get(owner) : null;
    return !!(m && m.status === 'retired');
}

function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_modules (
            subject_id TEXT NOT NULL,
            namespace  TEXT NOT NULL,
            version    INTEGER NOT NULL,
            revision   INTEGER NOT NULL DEFAULT 0,
            data       TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_by TEXT,
            PRIMARY KEY (subject_id, namespace)
        );
        -- The last revision issued per (subject, namespace), kept across deletes.
        CREATE TABLE IF NOT EXISTS user_module_revisions (
            subject_id TEXT NOT NULL,
            namespace  TEXT NOT NULL,
            revision   INTEGER NOT NULL,
            PRIMARY KEY (subject_id, namespace)
        );
        -- When Network first saw a namespace's owning service retired (onOwnerRemoved).
        CREATE TABLE IF NOT EXISTS user_module_retirements (
            namespace       TEXT PRIMARY KEY,
            owner           TEXT NOT NULL,
            retired_seen_at INTEGER NOT NULL
        );
    `);
    moduleEvents.ensureSchema(db);
    // An account cannot disappear, or change subject, while module rows remain: the code that deletes or
    // merges it must call onSubjectRemoved/onSubjectMerged (same transaction), which also emit the events.
    for (const table of ['users', 'anon_users']) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS user_modules_guard_${table}_delete BEFORE DELETE ON ${table}
            WHEN OLD.subject_id IS NOT NULL AND EXISTS (SELECT 1 FROM user_modules WHERE subject_id = OLD.subject_id)
            BEGIN SELECT RAISE(ABORT, 'user_modules rows remain for this subject: call modules.onSubjectRemoved or onSubjectMerged first'); END;
            CREATE TRIGGER IF NOT EXISTS user_modules_guard_${table}_rekey BEFORE UPDATE OF subject_id ON ${table}
            WHEN OLD.subject_id IS NOT NULL AND NEW.subject_id IS NOT OLD.subject_id
                 AND EXISTS (SELECT 1 FROM user_modules WHERE subject_id = OLD.subject_id)
            BEGIN SELECT RAISE(ABORT, 'user_modules rows remain for this subject: call modules.onSubjectMerged first'); END;
        `);
    }
}

const subjectRef = (sid) => ({ type: sid.startsWith('gst_') ? 'guest' : 'user', id: sid });

function toRecord(row) {
    return { subject: subjectRef(row.subject_id), namespace: row.namespace, version: row.version, revision: row.revision,
        data: JSON.parse(row.data), updated_at: row.updated_at, updated_by: row.updated_by || undefined };
}

function read(db, subjectId, namespace) {
    const row = db.prepare('SELECT * FROM user_modules WHERE subject_id = ? AND namespace = ?').get(subjectId, namespace);
    return row ? toRecord(row) : null;
}

/** The next revision for (subject, namespace): one above both the current row and the last issued. */
function nextRevision(db, subjectId, namespace, current) {
    const hw = db.prepare('SELECT revision FROM user_module_revisions WHERE subject_id = ? AND namespace = ?').get(subjectId, namespace);
    const next = Math.max(current || 0, hw ? hw.revision : 0) + 1;
    db.prepare(`INSERT INTO user_module_revisions (subject_id, namespace, revision) VALUES (?, ?, ?)
                ON CONFLICT(subject_id, namespace) DO UPDATE SET revision = excluded.revision`).run(subjectId, namespace, next);
    return next;
}

/** Who a writer is, as an event actor. */
function actorOf(subjectId, writer) {
    if (writer.type === 'user') return subjectRef(subjectId);
    if (writer.type === 'service') return { type: 'service', id: writer.id };
    return { type: 'system', id: 'network' };
}

/**
 * Write a record. writer = { type: 'user' } | { type: 'service', id }. expectedRevision: the revision
 * the writer read (0 = "I expect no record"); undefined = unconditional (allowed for the owner service only).
 * Returns { status, record } or { status, code, detail, errors? }.
 */
function write(db, subjectId, namespace, data, { writer, expectedRevision, ctx } = {}) {
    const ns = modules.get(namespace);
    if (!ns) return { status: 404, code: 'modules.unknown_namespace', detail: `no namespace ${namespace}` };
    if (!canWrite(namespace, writer)) return { status: 403, code: 'modules.write_denied', detail: `${writer && writer.type === 'user' ? 'users' : writer && writer.id} may not write ${namespace}` };
    if (ownerRetired(namespace)) return { status: 409, code: 'modules.namespace_retired', detail: `${ownerOf(namespace)} is retired: ${namespace} is read-only (${ns.onOwnerRemoved})` };
    if (expectedRevision === undefined && writer.type === 'user') return { status: 428, code: 'modules.revision_required', detail: 'send If-Match with the revision you read (0 for a new record)' };
    const v = modules.validateData(namespace, data);
    if (!v.valid) return { status: 422, code: 'modules.invalid_data', detail: `does not match ${namespace} v${ns.version}`, errors: v.errors };
    const by = writer.type === 'user' ? `user:${subjectId}` : `svc:${writer.id}`;
    const out = db.transaction(() => {
        const cur = db.prepare('SELECT revision, data FROM user_modules WHERE subject_id = ? AND namespace = ?').get(subjectId, namespace);
        const have = cur ? cur.revision : 0;
        if (expectedRevision !== undefined && Number(expectedRevision) !== have) {
            return { status: 412, code: 'modules.revision_conflict', detail: `revision is ${have}, not ${expectedRevision}` };
        }
        const revision = nextRevision(db, subjectId, namespace, have);
        db.prepare(`INSERT INTO user_modules (subject_id, namespace, version, revision, data, updated_at, updated_by)
                    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
                    ON CONFLICT(subject_id, namespace) DO UPDATE SET version = excluded.version, revision = excluded.revision,
                        data = excluded.data, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by`)
            .run(subjectId, namespace, ns.version, revision, JSON.stringify(data), by);
        const record = read(db, subjectId, namespace);
        assertValid('modules.module-record@1', record);
        moduleEvents.record(db, {
            subjectId, namespace, namespaceOwner: ownerOf(namespace), schemaVersion: ns.version, revision,
            change: cur ? 'updated' : 'created', reason: 'write', before: cur ? JSON.parse(cur.data) : {}, after: data,
            actor: actorOf(subjectId, writer), ctx,
        });
        return { status: cur ? 200 : 201, record };
    })();
    if (out.record) moduleEvents.kick(db);
    return out;
}

/**
 * Delete one record inside the caller's transaction (or its own) and emit its event.
 * Returns the revision of the delete, or 0 when there was no record.
 */
function removeRow(db, subjectId, namespace, { actor, reason, mergedInto, ctx }) {
    const row = db.prepare('SELECT revision, version, data FROM user_modules WHERE subject_id = ? AND namespace = ?').get(subjectId, namespace);
    if (!row) return 0;
    db.prepare('DELETE FROM user_modules WHERE subject_id = ? AND namespace = ?').run(subjectId, namespace);
    const revision = nextRevision(db, subjectId, namespace, row.revision);
    moduleEvents.record(db, {
        subjectId, namespace, namespaceOwner: ownerOf(namespace) || 'network', schemaVersion: row.version, revision,
        change: 'deleted', reason, before: JSON.parse(row.data), after: {}, actor, mergedInto, ctx,
    });
    return revision;
}

/**
 * Delete a record. writer as for write(); a user deletes their own record in any namespace, a service
 * only in the namespaces it owns. expectedRevision optional (412 if it moved).
 * Returns { status: 204, revision } | { status, code, detail }.
 */
function remove(db, subjectId, namespace, { writer, expectedRevision, ctx } = {}) {
    if (!modules.get(namespace)) return { status: 404, code: 'modules.unknown_namespace', detail: `no namespace ${namespace}` };
    if (writer.type === 'service' && writer.id !== ownerOf(namespace)) return { status: 403, code: 'modules.write_denied', detail: `${writer.id} may not delete ${namespace}` };
    const out = db.transaction(() => {
        const cur = db.prepare('SELECT revision FROM user_modules WHERE subject_id = ? AND namespace = ?').get(subjectId, namespace);
        if (!cur) return { status: 404, code: 'modules.not_found' };
        if (expectedRevision !== undefined && Number(expectedRevision) !== cur.revision) {
            return { status: 412, code: 'modules.revision_conflict', detail: `revision is ${cur.revision}, not ${expectedRevision}` };
        }
        const revision = removeRow(db, subjectId, namespace, { actor: actorOf(subjectId, writer), reason: writer.type === 'user' ? 'delete' : 'owner_delete', ctx });
        return { status: 204, revision };
    })();
    if (out.status === 204) moduleEvents.kick(db);
    return out;
}

/**
 * An account is going away: delete every record of the subject, one network.module.updated (deleted,
 * reason subject_removed) each, and forget its revisions. Call inside the transaction that deletes the
 * account (the users/anon_users triggers refuse the delete otherwise). Returns how many were deleted.
 */
function onSubjectRemoved(db, subjectId, { ctx } = {}) {
    if (!SUBJECT_RE.test(String(subjectId || ''))) throw new TypeError('onSubjectRemoved: a usr_/gst_ subject id is required');
    const n = db.transaction(() => {
        const rows = db.prepare('SELECT namespace FROM user_modules WHERE subject_id = ? ORDER BY namespace').all(subjectId);
        for (const r of rows) removeRow(db, subjectId, r.namespace, { actor: { type: 'system', id: 'network' }, reason: 'subject_removed', ctx });
        db.prepare('DELETE FROM user_module_revisions WHERE subject_id = ?').run(subjectId);
        return rows.length;
    })();
    if (n) moduleEvents.kick(db);
    return n;
}

/**
 * Two accounts become one (`from` folds into `into`, which survives). Each record of `from` moves to
 * `into` when `into` has none in that namespace (created there, reason subject_merged, merged_from);
 * when `into` has one, the survivor's record is kept and `from`'s is dropped. Every record of `from`
 * ends deleted (reason subject_merged, merged_into). Moved records say updated_by svc:network.
 * Call inside the merge's transaction, before `from`'s row goes. Returns { moved, dropped }.
 */
function onSubjectMerged(db, { from, into, ctx } = {}) {
    if (!SUBJECT_RE.test(String(from || '')) || !SUBJECT_RE.test(String(into || ''))) throw new TypeError('onSubjectMerged: from and into must be usr_/gst_ subject ids');
    if (from === into) throw new TypeError('onSubjectMerged: from and into are the same subject');
    const system = { type: 'system', id: 'network' };
    const out = db.transaction(() => {
        const res = { moved: 0, dropped: 0 };
        for (const row of db.prepare('SELECT * FROM user_modules WHERE subject_id = ? ORDER BY namespace').all(from)) {
            const has = db.prepare('SELECT 1 FROM user_modules WHERE subject_id = ? AND namespace = ?').get(into, row.namespace);
            if (!has) {
                const revision = nextRevision(db, into, row.namespace, 0);
                db.prepare(`INSERT INTO user_modules (subject_id, namespace, version, revision, data, updated_at, updated_by)
                            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'svc:network')`).run(into, row.namespace, row.version, revision, row.data);
                moduleEvents.record(db, {
                    subjectId: into, namespace: row.namespace, namespaceOwner: ownerOf(row.namespace) || 'network', schemaVersion: row.version, revision,
                    change: 'created', reason: 'subject_merged', before: {}, after: JSON.parse(row.data), actor: system, mergedFrom: from, ctx,
                });
                res.moved++;
            } else {
                res.dropped++;
            }
            removeRow(db, from, row.namespace, { actor: system, reason: 'subject_merged', mergedInto: into, ctx });
        }
        db.prepare('DELETE FROM user_module_revisions WHERE subject_id = ?').run(from);
        return res;
    })();
    if (out.moved || out.dropped) moduleEvents.kick(db);
    return out;
}

/**
 * onOwnerRemoved for delete-after-retention namespaces: note when Network first sees the owner retired,
 * and once retentionDays have passed since, delete the namespace's records (reason owner_delete, actor
 * system:network). retain-readonly namespaces only become read-only (write()). Returns how many were deleted.
 */
function sweepRetired(db, { now = Date.now(), ctx } = {}) {
    let deleted = 0;
    for (const ns of modules.namespaces) {
        const owner = ownerOf(ns.namespace);
        if (!ownerRetired(ns.namespace)) {
            db.prepare('DELETE FROM user_module_retirements WHERE namespace = ?').run(ns.namespace);   // un-retired
            continue;
        }
        db.prepare('INSERT OR IGNORE INTO user_module_retirements (namespace, owner, retired_seen_at) VALUES (?, ?, ?)').run(ns.namespace, owner, now);
        if (ns.onOwnerRemoved !== 'delete-after-retention') continue;
        const seen = db.prepare('SELECT retired_seen_at FROM user_module_retirements WHERE namespace = ?').get(ns.namespace).retired_seen_at;
        if (now - seen < (ns.retentionDays || 0) * 86400000) continue;
        deleted += db.transaction(() => {
            const rows = db.prepare('SELECT subject_id FROM user_modules WHERE namespace = ?').all(ns.namespace);
            for (const r of rows) removeRow(db, r.subject_id, ns.namespace, { actor: { type: 'system', id: 'network' }, reason: 'owner_delete', ctx });
            return rows.length;
        })();
    }
    if (deleted) moduleEvents.kick(db);
    return deleted;
}

const problem = (res, out, req) => http.sendProblem(res, out.status, out.code, { detail: out.detail, errors: out.errors, ctx: req.ov });
const revisionHeader = (req) => {
    const h = req.headers['if-match'];
    if (h === undefined) return undefined;
    const n = Number(String(h).replace(/^W\//, '').replace(/"/g, ''));
    return Number.isInteger(n) && n >= 0 ? n : NaN;
};
const withEtag = (res, record) => res.set('ETag', `"${record.revision}"`).set('Cache-Control', 'private, no-store');

/** User + public routes, mounted at /api/modules. */
function userRouter(requireAuth) {
    const router = express.Router();
    router.use(http.middleware());

    router.get('/:ns/public/:subject', (req, res) => {
        if (!modules.get(req.params.ns)) return problem(res, { status: 404, code: 'modules.unknown_namespace' }, req);
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(req.params.subject)) return problem(res, { status: 404, code: 'modules.not_found' }, req);
        const rec = read(req.app.locals.db, req.params.subject, req.params.ns);
        if (!rec) return problem(res, { status: 404, code: 'modules.not_found' }, req);
        res.set('Cache-Control', 'public, max-age=60').json({ subject: rec.subject, namespace: rec.namespace, version: rec.version, data: modules.publicView(rec.namespace, rec.data) });
    });

    router.get('/', requireAuth, (req, res) => {
        const db = req.app.locals.db;
        const sid = subjects.ensureUserSubject(db, req.user);
        const rows = db.prepare('SELECT * FROM user_modules WHERE subject_id = ? ORDER BY namespace').all(sid);
        res.set('Cache-Control', 'private, no-store').json({ subject: subjectRef(sid), modules: rows.map(toRecord),
            namespaces: modules.namespaces.map(n => ({ namespace: n.namespace, owner: ownerOf(n.namespace), userWritable: n.writers.includes('user') && !ownerRetired(n.namespace), description: n.description })) });
    });

    router.get('/:ns', requireAuth, (req, res) => {
        const db = req.app.locals.db;
        if (!modules.get(req.params.ns)) return problem(res, { status: 404, code: 'modules.unknown_namespace' }, req);
        const rec = read(db, subjects.ensureUserSubject(db, req.user), req.params.ns);
        if (!rec) return problem(res, { status: 404, code: 'modules.not_found', detail: 'no record yet (write with If-Match: 0)' }, req);
        withEtag(res, rec).json(rec);
    });

    router.put('/:ns', requireAuth, (req, res) => {
        const db = req.app.locals.db;
        const rev = revisionHeader(req);
        if (Number.isNaN(rev)) return problem(res, { status: 400, code: 'modules.bad_revision', detail: 'If-Match must be a revision number' }, req);
        const out = write(db, subjects.ensureUserSubject(db, req.user), req.params.ns, req.body && req.body.data, { writer: { type: 'user' }, expectedRevision: rev, ctx: req.ov });
        if (!out.record) return problem(res, out, req);
        withEtag(res, out.record).status(out.status).json(out.record);
    });

    router.delete('/:ns', requireAuth, (req, res) => {
        const db = req.app.locals.db;
        const out = remove(db, subjects.ensureUserSubject(db, req.user), req.params.ns, { writer: { type: 'user' }, ctx: req.ov });
        if (out.status === 404 && out.code === 'modules.unknown_namespace') return problem(res, out, req);
        res.status(out.status === 204 ? 204 : 404).end();
    });
    return router;
}

/** Service routes; mounted under /internal (after requireInternalKey) with principal guards. */
function serviceRoutes(router, principals) {
    const nsOf = (req) => req.params.ns;
    const resolveSubject = (db, s) => (/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(s) && db.prepare('SELECT 1 FROM users WHERE subject_id = ?').get(s) ? s : null);
    const serviceOf = (req) => String(req.principal.sub).replace(/^svc:/, '');

    router.get('/modules/:ns/:subject', principals.guard('network.modules.read', { namespace: nsOf, legacy: false }), (req, res) => {
        const db = req.app.locals.db;
        if (!modules.get(req.params.ns)) return problem(res, { status: 404, code: 'modules.unknown_namespace' }, req);
        const sid = resolveSubject(db, req.params.subject);
        const rec = sid && read(db, sid, req.params.ns);
        if (!rec) return problem(res, { status: 404, code: 'modules.not_found' }, req);
        withEtag(res, rec).json(rec);
    });

    router.put('/modules/:ns/:subject', principals.guard('network.modules.write', { namespace: nsOf, legacy: false }), (req, res) => {
        const db = req.app.locals.db;
        const sid = resolveSubject(db, req.params.subject);
        if (!sid) return problem(res, { status: 404, code: 'identity.subject_not_found' }, req);
        const rev = revisionHeader(req);
        if (Number.isNaN(rev)) return problem(res, { status: 400, code: 'modules.bad_revision' }, req);
        const out = write(db, sid, req.params.ns, req.body && req.body.data, { writer: { type: 'service', id: serviceOf(req) }, expectedRevision: rev, ctx: req.ov });
        if (!out.record) return problem(res, out, req);
        withEtag(res, out.record).status(out.status).json(out.record);
    });

    router.delete('/modules/:ns/:subject', principals.guard('network.modules.write', { namespace: nsOf, legacy: false }), (req, res) => {
        const db = req.app.locals.db;
        const sid = resolveSubject(db, req.params.subject);
        if (!sid) return problem(res, { status: 404, code: 'identity.subject_not_found' }, req);
        const rev = revisionHeader(req);
        if (Number.isNaN(rev)) return problem(res, { status: 400, code: 'modules.bad_revision' }, req);
        const out = remove(db, sid, req.params.ns, { writer: { type: 'service', id: serviceOf(req) }, expectedRevision: rev, ctx: req.ov });
        if (out.status !== 204) return problem(res, out, req);
        res.set('Cache-Control', 'private, no-store').status(204).end();
    });
}

module.exports = {
    OWNER_HANDOFFS, ownerOf, canWrite, ownerRetired,
    ensureSchema, read, write, remove, onSubjectRemoved, onSubjectMerged, sweepRetired,
    userRouter, serviceRoutes,
};
