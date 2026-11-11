'use strict';
/**
 * Platform mutes (ask 287): hush one person for the person who muted them. Blocks stop
 * every contact; a mute only hushes their non-staff notices — their messages and mentions
 * stop pinging, while moderation, system and admin notices are always delivered.
 *
 * user_mutes is keyed by subjects (usr_…), one row per (muter, muted). An unmute keeps the
 * row with active = 0 so the pair's revision keeps growing. Nobody mutes themselves, and
 * guests neither mute nor are muted. Chat, Community and Network's own notifications read
 * this the way they read blocks (server/identity/blocks.js) once its internal read ships.
 *
 * No change event yet: nothing relays mutes, so the revision only orders the card's state.
 *
 *   GET    /api/v1/me/mutes                    whom I muted (subject, username, display name)
 *   PUT    /api/v1/me/mutes/:subjectOrUsername mute (201 new, 200 already muted)
 *   DELETE /api/v1/me/mutes/:subjectOrUsername unmute (200; 404 when not muted)
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { http } = require('openvibe-contracts');
const { findTarget } = require('./blocks');

/** The person a path segment names, with mute-shaped errors (blocks.findTarget raises blocks.*). */
async function target(db, key) {
    try {
        return await findTarget(db, key);
    } catch (err) {
        if (err && err.code === 'blocks.guest') throw new MuteError(400, 'mutes.guest', 'guests cannot be muted');
        throw err;
    }
}

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_ACTIVE = 5000;

class MuteError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

async function isMuted(db, muterSubject, mutedSubject) {
    return !!await db.prepare('SELECT 1 FROM user_mutes WHERE muter_subject = ? AND muted_subject = ? AND active = 1').get(String(muterSubject), String(mutedSubject));
}

/** Set (muter, muted) to `active`. Both must be usr_ subjects. → { changed, active, revision, at } */
async function setMute(db, muter, muted, active) {
    if (!SUBJECT_RE.test(String(muter)) || !SUBJECT_RE.test(String(muted))) throw new MuteError(400, 'mutes.bad_subject', 'mutes are between usr_ subjects');
    if (muter === muted) throw new MuteError(400, 'mutes.self', 'you cannot mute yourself');
    return await db.tx(async () => {
        const prev = await db.prepare('SELECT active, revision, updated_at FROM user_mutes WHERE muter_subject = ? AND muted_subject = ?').get(muter, muted);
        if (prev && !!prev.active === !!active) return { changed: false, active: !!active, revision: prev.revision, at: prev.updated_at };
        if (!prev && !active) return { changed: false, active: false, revision: 0, at: null };
        if (active) {
            const n = (await db.prepare('SELECT COUNT(*) AS n FROM user_mutes WHERE muter_subject = ? AND active = 1').get(muter)).n;
            if (n >= MAX_ACTIVE) throw new MuteError(409, 'mutes.limit', `at most ${MAX_ACTIVE} people can be muted`);
        }
        const at = new Date().toISOString();
        const revision = prev ? prev.revision + 1 : 1;
        if (prev) {
            await db.prepare('UPDATE user_mutes SET active = ?, revision = ?, updated_at = ? WHERE muter_subject = ? AND muted_subject = ?')
                .run(active ? 1 : 0, revision, at, muter, muted);
        } else {
            await db.prepare('INSERT INTO user_mutes (muter_subject, muted_subject, active, revision, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)')
                .run(muter, muted, at, at);
        }
        return { changed: true, active: !!active, revision, at };
    });
}

/** Whom `subject` muted (with names, newest first), for the person's own list. */
async function listFor(db, subject) {
    return (await db.prepare(`SELECT m.muted_subject, m.revision, m.updated_at, u.username, u.display_name
        FROM user_mutes m LEFT JOIN users u ON u.subject_id = m.muted_subject
        WHERE m.muter_subject = ? AND m.active = 1 ORDER BY m.updated_at DESC, m.muted_subject`).all(String(subject)))
        .map((r) => ({
            subject: r.muted_subject, username: r.username || null, display_name: r.username ? (r.display_name || r.username) : null,
            muted_at: r.updated_at, revision: r.revision,
        }));
}

/** The signed-in person as a muter, or a MuteError. */
async function meOf(db, user) {
    if (!user || user.is_anon) throw new MuteError(403, 'mutes.guest', 'sign in with an account to mute people');
    const sid = await require('./subjects').ensureUserSubject(db, user);
    if (!SUBJECT_RE.test(String(sid || ''))) throw new MuteError(403, 'mutes.guest', 'sign in with an account to mute people');
    return sid;
}
const view = (u, out) => ({ subject: u.subject_id, username: u.username, display_name: u.display_name || u.username, active: out.active, revision: out.revision, ...(out.active ? { muted_at: out.at } : {}) });

function userRouter(requireAuth) {
    const router = express.Router();
    router.use(http.middleware());
    const send = async (req, res, fn) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        try { return await fn(req.app.locals.db); } catch (err) {
            if (err instanceof MuteError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            console.error('[Mutes]', err.message);
            return http.sendProblem(res, 500, 'mutes.failed', { detail: 'the mute could not be changed', ctx: req.ov });
        }
    };

    router.get('/', requireAuth, async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        res.json({ subject: me, mutes: await listFor(db, me) });
    }));

    router.put('/:target', requireAuth, async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        const u = await target(db, req.params.target);
        if (!u) throw new MuteError(404, 'mutes.unknown_person', 'no such person');
        if (u.is_anon) throw new MuteError(400, 'mutes.guest', 'guests cannot be muted');
        if (u.subject_id === me) throw new MuteError(400, 'mutes.self', 'you cannot mute yourself');
        const out = await setMute(db, me, u.subject_id, true);
        res.status(out.changed ? 201 : 200).json({ changed: out.changed, mute: view(u, out) });
    }));

    router.delete('/:target', requireAuth, async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        const key = String(req.params.target || '');
        const u = await target(db, key) || (SUBJECT_RE.test(key) ? { subject_id: key, username: null, display_name: null } : null);
        if (!u || !u.subject_id || !await isMuted(db, me, u.subject_id)) throw new MuteError(404, 'mutes.not_muted', 'that person is not muted');
        const out = await setMute(db, me, u.subject_id, false);
        res.json({ changed: out.changed, mute: view(u, out) });
    }));

    return router;
}

module.exports = { MAX_ACTIVE, MuteError, ensureSchema, setMute, isMuted, listFor, userRouter };
