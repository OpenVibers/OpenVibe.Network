'use strict';
/**
 * /internal/identity/* — subject resolution for first-party services (behind X-Internal-Key,
 * mounted by server/internal/routes.js). Errors are RFC 9457 problems (errors.problem@1).
 *
 *   GET  /internal/identity/resolve?subject_id=usr_...
 *   GET  /internal/identity/resolve?system=live&type=user&id=123
 *   POST /internal/identity/legacy-map   { entries: [{ network_user_id | subject_id, source_system, source_type, source_id, verified? }] }
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const subjects = require('./subjects');

const router = express.Router();
router.use(http.middleware());
const MAX_ENTRIES = 1000;

router.get('/resolve', (req, res) => {
    const db = req.app.locals.db;
    const q = req.query;
    if (!q.subject_id && !(q.system && q.id)) {
        return http.sendProblem(res, 400, 'identity.bad_request', { detail: 'pass subject_id, or system + id (+ type, default user)', ctx: req.ov });
    }
    const out = subjects.resolve(db, { subject_id: q.subject_id, source_system: q.system, source_type: q.type || 'user', source_id: q.id });
    if (!out) return http.sendProblem(res, 404, 'identity.subject_not_found', { detail: 'no subject for that id', ctx: req.ov });
    res.json(out);
});

router.post('/legacy-map', express.json({ limit: '512kb' }), (req, res) => {
    const entries = req.body && req.body.entries;
    if (!Array.isArray(entries) || !entries.length) {
        return http.sendProblem(res, 400, 'identity.bad_request', { detail: 'entries must be a non-empty array', ctx: req.ov });
    }
    if (entries.length > MAX_ENTRIES) {
        return http.sendProblem(res, 413, 'identity.too_many_entries', { detail: `at most ${MAX_ENTRIES} entries per call`, ctx: req.ov });
    }
    res.json(subjects.upsertLegacy(req.app.locals.db, entries));
});

module.exports = router;
