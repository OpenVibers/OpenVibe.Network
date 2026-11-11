'use strict';
/**
 * User reports (ask 287): "Report" on the user card. A signed-in person reports another
 * person with a reason; staff read the queue. Reports never resolve themselves — a staff
 * decision lives in the moderation audit log (server/admin/moderation-audit.js), and the
 * report's status only records whether staff have looked.
 *
 * user_reports holds one row per filing (reporter, target, reason, detail, status). Filing
 * twice about the same person while the first is still open returns the open one instead
 * of a duplicate. Nobody reports themselves, and guests report nothing.
 *
 *   POST   /api/v1/me/reports                   file (201 new, 200 already open)
 *   GET    /api/v1/staff/user-reports           the queue for staff holding
 *                                               staff.moderation.logs (newest first,
 *                                               ?status=open&target=usr_…&limit=)
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { http, staff } = require('openvibe-contracts');
const { staffClaims } = require('../auth/staff-claims');
const { findTarget } = require('./blocks');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const REASONS = new Set(['spam', 'harassment', 'impersonation', 'explicit', 'scam', 'other']);
const STATUSES = new Set(['open', 'reviewed', 'dismissed']);
const MAX_DETAIL = 2000;

class ReportError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

/** The person a value names, with report-shaped errors (blocks.findTarget raises blocks.*). */
async function target(db, key) {
    try {
        return await findTarget(db, key);
    } catch (err) {
        if (err && err.code === 'blocks.guest') throw new ReportError(400, 'user_reports.guest', 'guests cannot be reported');
        throw err;
    }
}

/** The signed-in person as a reporter, or a ReportError. */
async function meOf(db, user) {
    if (!user || user.is_anon) throw new ReportError(403, 'user_reports.guest', 'sign in with an account to report people');
    const sid = await require('./subjects').ensureUserSubject(db, user);
    if (!SUBJECT_RE.test(String(sid || ''))) throw new ReportError(403, 'user_reports.guest', 'sign in with an account to report people');
    return sid;
}

const cleanReason = (value) => {
    const r = String(value || '').trim().toLowerCase();
    if (!REASONS.has(r)) throw new ReportError(400, 'user_reports.reason', `reason must be one of ${[...REASONS].join(', ')}`);
    return r;
};
const cleanDetail = (value) => {
    const d = String(value == null ? '' : value).trim().slice(0, MAX_DETAIL);
    return d;
};

const view = (r) => ({ id: r.id, reporter: r.reporter_subject, target: r.target_subject, reason: r.reason, detail: r.detail || '', status: r.status, created_at: r.created_at, updated_at: r.updated_at });

/** File a report, or return the still-open one for the pair. → { report, created } */
async function file(db, reporter, targetSubject, reason, detail) {
    if (!SUBJECT_RE.test(String(reporter)) || !SUBJECT_RE.test(String(targetSubject))) throw new ReportError(400, 'user_reports.bad_subject', 'reports are between usr_ subjects');
    if (reporter === targetSubject) throw new ReportError(400, 'user_reports.self', 'you cannot report yourself');
    return await db.tx(async () => {
        const open = await db.prepare(`SELECT * FROM user_reports WHERE reporter_subject = ? AND target_subject = ? AND status = 'open'
            ORDER BY id DESC LIMIT 1`).get(reporter, targetSubject);
        if (open) return { report: view(open), created: false };
        const row = await db.prepare(`INSERT INTO user_reports (reporter_subject, target_subject, reason, detail)
            VALUES (?, ?, ?, ?) RETURNING *`).get(reporter, targetSubject, reason, detail);
        return { report: view(row), created: true };
    });
}

/** Whether `reporter` has an open report about `targetSubject`. */
async function hasOpen(db, reporter, targetSubject) {
    return !!await db.prepare(`SELECT 1 FROM user_reports WHERE reporter_subject = ? AND target_subject = ? AND status = 'open' LIMIT 1`)
        .get(String(reporter), String(targetSubject));
}

/** The staff queue, newest first. Filters: status (default open), target subject. */
async function listForStaff(db, { status = 'open', target = null, limit = 50 } = {}) {
    if (!STATUSES.has(status)) throw new ReportError(400, 'user_reports.status', `status must be one of ${[...STATUSES].join(', ')}`);
    if (target !== null && !SUBJECT_RE.test(String(target))) throw new ReportError(400, 'user_reports.bad_subject', 'target must be a usr_ subject id');
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const where = ['status = ?'];
    const args = [status];
    if (target !== null) { where.push('target_subject = ?'); args.push(String(target)); }
    args.push(n);
    return (await db.prepare(`SELECT * FROM user_reports WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args)).map(view);
}

function userRouter(requireAuth) {
    const router = express.Router();
    router.use(http.middleware());
    const send = async (req, res, fn) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        try { return await fn(req.app.locals.db); } catch (err) {
            if (err instanceof ReportError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            console.error('[UserReports]', err.message);
            return http.sendProblem(res, 500, 'user_reports.failed', { detail: 'the report could not be filed', ctx: req.ov });
        }
    };

    router.post('/', requireAuth, express.json({ limit: '16kb' }), async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const u = await target(db, body.target);
        if (!u) throw new ReportError(404, 'user_reports.unknown_person', 'no such person');
        if (u.is_anon) throw new ReportError(400, 'user_reports.guest', 'guests cannot be reported');
        if (u.subject_id === me) throw new ReportError(400, 'user_reports.self', 'you cannot report yourself');
        const out = await file(db, me, u.subject_id, cleanReason(body.reason), cleanDetail(body.detail));
        res.status(out.created ? 201 : 200).json({ created: out.created, report: out.report });
    }));

    return router;
}

/** GET /api/v1/staff/user-reports (mount behind requireAuth; the capability check is inside). */
function staffRouter() {
    const router = express.Router();
    router.use(http.middleware());
    router.get('/', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        try {
            if (!req.user || !staff.can(staffClaims(req.user), 'staff.moderation.logs')) {
                return http.sendProblem(res, 403, 'user_reports.forbidden', { detail: 'staff.moderation.logs required', ctx: req.ov });
            }
            res.json({ reports: await listForStaff(req.app.locals.db, { status: req.query.status, target: req.query.target || null, limit: req.query.limit }) });
        } catch (err) {
            if (err instanceof ReportError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            console.error('[UserReports]', err.message);
            return http.sendProblem(res, 500, 'user_reports.failed', { detail: 'the queue could not be read', ctx: req.ov });
        }
    });
    return router;
}

module.exports = { REASONS, STATUSES, ReportError, ensureSchema, file, hasOpen, listForStaff, userRouter, staffRouter };
