'use strict';
/**
 * The adult account flag (the Exchange remake, "Uncensored").
 *
 * OpenVibe.AI serves an uncensored model only to an account that confirmed, here, that it is 18 or older. The flag is
 * the account's own: `users.adult_confirmed_at` (migration 0041). Setting it is a deliberate act — the person ticks
 * the box on `/my` and confirms — and withdrawing it clears it at once. Network never infers an age.
 *
 *   GET    /api/v1/me/adult   (session)  → { adult, confirmed_at }
 *   PUT    /api/v1/me/adult   (session)  { confirm: true } → { adult: true, confirmed_at }
 *   DELETE /api/v1/me/adult   (session)  → { adult: false }
 *
 *   GET    /internal/identity/adult?subject_id=usr_…  (service token, identity.subject.resolve)
 *        → { subject_id, adult, confirmed_at }   (AI asks this; server/policy/adult-status.js)
 *
 * Anonymous accounts cannot confirm: the flag has to belong to an account that can be held to it.
 */
const express = require('express');
const { http } = require('openvibe-contracts');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const CONFIRMATION_VERSION = 1;

async function readByUser(db, userId) {
    const row = await db.prepare('SELECT adult_confirmed_at FROM users WHERE id = ?').get(userId);
    return { adult: Boolean(row && row.adult_confirmed_at), confirmed_at: (row && row.adult_confirmed_at) || null };
}

async function readBySubject(db, subjectId) {
    const row = await db.prepare('SELECT subject_id, adult_confirmed_at FROM users WHERE subject_id = ?').get(subjectId);
    if (!row) return null;
    return { subject_id: row.subject_id, adult: Boolean(row.adult_confirmed_at), confirmed_at: row.adult_confirmed_at || null };
}

async function writeAudit(db, req, action, detail) {
    try { await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(req.user.id, action, JSON.stringify(detail)); }
    catch { /* the flag is the record; an audit failure must not undo a withdrawal */ }
}

/** /api/v1/me/adult — the person's own confirmation. */
function userRouter({ requireAuth, now = () => new Date().toISOString() }) {
    const r = express.Router();
    const refuseAnon = (req, res, next) => (req.user && req.user.is_anon ? res.status(403).json({ error: 'Anonymous accounts cannot confirm an age; sign in to a full account first.' }) : next());
    r.get('/', requireAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store').json(await readByUser(req.app.locals.db, req.user.id));
    });
    r.put('/', requireAuth, refuseAnon, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (b.confirm !== true) return res.status(400).json({ error: 'Tick the box: this records that you are 18 or older.' });
        const at = now();
        await req.app.locals.db.prepare('UPDATE users SET adult_confirmed_at = ?, updated_at = ? WHERE id = ?').run(at, at, req.user.id);
        await writeAudit(req.app.locals.db, req, 'adult.confirmed', { confirmation_version: CONFIRMATION_VERSION, confirmed_at: at });
        res.set('Cache-Control', 'no-store').json({ adult: true, confirmed_at: at, confirmation_version: CONFIRMATION_VERSION });
    });
    r.delete('/', requireAuth, async (req, res) => {
        await req.app.locals.db.prepare('UPDATE users SET adult_confirmed_at = NULL, updated_at = ? WHERE id = ?').run(now(), req.user.id);
        await writeAudit(req.app.locals.db, req, 'adult.withdrawn', {});
        res.set('Cache-Control', 'no-store').json({ adult: false });
    });
    return r;
}

/** /internal/identity/adult — what a first-party service with identity.subject.resolve may read. */
async function internalAdult(req, res) {
    const subjectId = String((req.query && req.query.subject_id) || '');
    if (!SUBJECT_RE.test(subjectId)) return http.sendProblem(res, 400, 'identity.bad_request', { detail: 'subject_id must be a usr_ subject', ctx: req.ov });
    const out = await readBySubject(req.app.locals.db, subjectId);
    if (!out) return http.sendProblem(res, 404, 'identity.subject_not_found', { detail: 'no subject for that id', ctx: req.ov });
    res.set('Cache-Control', 'no-store').json(out);
}

module.exports = { userRouter, internalAdult, readByUser, readBySubject, SUBJECT_RE, CONFIRMATION_VERSION };
