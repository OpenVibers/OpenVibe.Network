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
 */
const express = require('express');
const { modules, http, assertValid } = require('openvibe-contracts');
const subjects = require('./subjects');

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
    `);
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

/**
 * Write a record. writer = { type: 'user' } | { type: 'service', id }. expectedRevision: the revision
 * the writer read (0 = "I expect no record"); undefined = unconditional (allowed for the owner service only).
 * Returns { status, record } or { status, code, detail, errors? }.
 */
function write(db, subjectId, namespace, data, { writer, expectedRevision }) {
    const ns = modules.get(namespace);
    if (!ns) return { status: 404, code: 'modules.unknown_namespace', detail: `no namespace ${namespace}` };
    if (!modules.canWrite(namespace, writer)) return { status: 403, code: 'modules.write_denied', detail: `${writer.type === 'user' ? 'users' : writer.id} may not write ${namespace}` };
    if (expectedRevision === undefined && writer.type === 'user') return { status: 428, code: 'modules.revision_required', detail: 'send If-Match with the revision you read (0 for a new record)' };
    const v = modules.validateData(namespace, data);
    if (!v.valid) return { status: 422, code: 'modules.invalid_data', detail: `does not match ${namespace} v${ns.version}`, errors: v.errors };
    const by = writer.type === 'user' ? `user:${subjectId}` : `svc:${writer.id}`;
    return db.transaction(() => {
        const cur = db.prepare('SELECT revision FROM user_modules WHERE subject_id = ? AND namespace = ?').get(subjectId, namespace);
        const have = cur ? cur.revision : 0;
        if (expectedRevision !== undefined && Number(expectedRevision) !== have) {
            return { status: 412, code: 'modules.revision_conflict', detail: `revision is ${have}, not ${expectedRevision}` };
        }
        db.prepare(`INSERT INTO user_modules (subject_id, namespace, version, revision, data, updated_at, updated_by)
                    VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP, ?)
                    ON CONFLICT(subject_id, namespace) DO UPDATE SET version = excluded.version, revision = revision + 1,
                        data = excluded.data, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by`)
            .run(subjectId, namespace, ns.version, JSON.stringify(data), by);
        const record = read(db, subjectId, namespace);
        assertValid('modules.module-record@1', record);
        return { status: cur ? 200 : 201, record };
    })();
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
            namespaces: modules.namespaces.map(n => ({ namespace: n.namespace, owner: n.owner, userWritable: n.writers.includes('user'), description: n.description })) });
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
        const out = write(db, subjects.ensureUserSubject(db, req.user), req.params.ns, req.body && req.body.data, { writer: { type: 'user' }, expectedRevision: rev });
        if (!out.record) return problem(res, out, req);
        withEtag(res, out.record).status(out.status).json(out.record);
    });

    router.delete('/:ns', requireAuth, (req, res) => {
        const db = req.app.locals.db;
        if (!modules.get(req.params.ns)) return problem(res, { status: 404, code: 'modules.unknown_namespace' }, req);
        const n = db.prepare('DELETE FROM user_modules WHERE subject_id = ? AND namespace = ?').run(subjects.ensureUserSubject(db, req.user), req.params.ns).changes;
        res.status(n ? 204 : 404).end();
    });
    return router;
}

/** Service routes; mounted under /internal (after requireInternalKey) with principal guards. */
function serviceRoutes(router, principals) {
    const nsOf = (req) => req.params.ns;
    const resolveSubject = (db, s) => (/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(s) && db.prepare('SELECT 1 FROM users WHERE subject_id = ?').get(s) ? s : null);

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
        const service = String(req.principal.sub).replace(/^svc:/, '');
        const out = write(db, sid, req.params.ns, req.body && req.body.data, { writer: { type: 'service', id: service }, expectedRevision: rev });
        if (!out.record) return problem(res, out, req);
        withEtag(res, out.record).status(out.status).json(out.record);
    });
}

module.exports = { ensureSchema, read, write, userRouter, serviceRoutes };
