'use strict';
/**
 * Friendships (ask 287): "Add friend" on the user card. No request inbox: adding is one
 * direction at a time, and the pair are friends when both directions are active. Removing
 * either direction ends it. The card reads the pair's state (none, pending, requested,
 * friends) so the action can say Add friend, Requested, or Friends.
 *
 * user_friends is keyed by subjects (usr_…), one row per (user, friend). An unfriend keeps
 * the row with active = 0 so the pair's revision keeps growing. Nobody friends themselves,
 * and guests neither friend nor are friended. No change event yet: nothing relays friends,
 * so the revision only orders the card's state.
 *
 *   GET    /api/v1/me/friends                  whom I friended (subject, username, display name)
 *   PUT    /api/v1/me/friends/:subjectOrUsername   add (201 new, 200 already added)
 *   DELETE /api/v1/me/friends/:subjectOrUsername   remove (200; 404 when not added)
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { http } = require('openvibe-contracts');
const { findTarget } = require('./blocks');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_ACTIVE = 5000;

class FriendError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

/** The person a path segment names, with friend-shaped errors (blocks.findTarget raises blocks.*). */
async function target(db, key) {
    try {
        return await findTarget(db, key);
    } catch (err) {
        if (err && err.code === 'blocks.guest') throw new FriendError(400, 'friends.guest', 'guests cannot be friended');
        throw err;
    }
}

async function outgoing(db, userSubject, friendSubject) {
    return !!await db.prepare('SELECT 1 FROM user_friends WHERE user_subject = ? AND friend_subject = ? AND active = 1').get(String(userSubject), String(friendSubject));
}

/** The pair's state from `viewer`'s side: none, pending (I added them), requested (they added me), friends. */
async function stateOf(db, viewer, other) {
    const mine = await outgoing(db, viewer, other);
    const theirs = await outgoing(db, other, viewer);
    if (mine && theirs) return 'friends';
    if (mine) return 'pending';
    if (theirs) return 'requested';
    return 'none';
}

/** Set (user, friend) to `active`. Both must be usr_ subjects. → { changed, active, revision, at } */
async function setFriend(db, user, friend, active) {
    if (!SUBJECT_RE.test(String(user)) || !SUBJECT_RE.test(String(friend))) throw new FriendError(400, 'friends.bad_subject', 'friends are between usr_ subjects');
    if (user === friend) throw new FriendError(400, 'friends.self', 'you cannot friend yourself');
    return await db.tx(async () => {
        const prev = await db.prepare('SELECT active, revision, updated_at FROM user_friends WHERE user_subject = ? AND friend_subject = ?').get(user, friend);
        if (prev && !!prev.active === !!active) return { changed: false, active: !!active, revision: prev.revision, at: prev.updated_at };
        if (!prev && !active) return { changed: false, active: false, revision: 0, at: null };
        if (active) {
            const n = (await db.prepare('SELECT COUNT(*) AS n FROM user_friends WHERE user_subject = ? AND active = 1').get(user)).n;
            if (n >= MAX_ACTIVE) throw new FriendError(409, 'friends.limit', `at most ${MAX_ACTIVE} people can be friended`);
        }
        const at = new Date().toISOString();
        const revision = prev ? prev.revision + 1 : 1;
        if (prev) {
            await db.prepare('UPDATE user_friends SET active = ?, revision = ?, updated_at = ? WHERE user_subject = ? AND friend_subject = ?')
                .run(active ? 1 : 0, revision, at, user, friend);
        } else {
            await db.prepare('INSERT INTO user_friends (user_subject, friend_subject, active, revision, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)')
                .run(user, friend, at, at);
        }
        return { changed: true, active: !!active, revision, at };
    });
}

/** Whom `subject` added (with names, newest first), for the person's own list. */
async function listFor(db, subject) {
    return (await db.prepare(`SELECT f.friend_subject, f.revision, f.updated_at, u.username, u.display_name
        FROM user_friends f LEFT JOIN users u ON u.subject_id = f.friend_subject
        WHERE f.user_subject = ? AND f.active = 1 ORDER BY f.updated_at DESC, f.friend_subject`).all(String(subject)))
        .map((r) => ({
            subject: r.friend_subject, username: r.username || null, display_name: r.username ? (r.display_name || r.username) : null,
            added_at: r.updated_at, revision: r.revision,
        }));
}

/** The signed-in person as a friend, or a FriendError. */
async function meOf(db, user) {
    if (!user || user.is_anon) throw new FriendError(403, 'friends.guest', 'sign in with an account to add friends');
    const sid = await require('./subjects').ensureUserSubject(db, user);
    if (!SUBJECT_RE.test(String(sid || ''))) throw new FriendError(403, 'friends.guest', 'sign in with an account to add friends');
    return sid;
}
const view = (u, out, state) => ({ subject: u.subject_id, username: u.username, display_name: u.display_name || u.username, active: out.active, revision: out.revision, state, ...(out.active ? { added_at: out.at } : {}) });

function userRouter(requireAuth) {
    const router = express.Router();
    router.use(http.middleware());
    const send = async (req, res, fn) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        try { return await fn(req.app.locals.db); } catch (err) {
            if (err instanceof FriendError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            console.error('[Friends]', err.message);
            return http.sendProblem(res, 500, 'friends.failed', { detail: 'the friendship could not be changed', ctx: req.ov });
        }
    };

    router.get('/', requireAuth, async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        res.json({ subject: me, friends: await listFor(db, me) });
    }));

    router.put('/:target', requireAuth, async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        const u = await target(db, req.params.target);
        if (!u) throw new FriendError(404, 'friends.unknown_person', 'no such person');
        if (u.is_anon) throw new FriendError(400, 'friends.guest', 'guests cannot be friended');
        if (u.subject_id === me) throw new FriendError(400, 'friends.self', 'you cannot friend yourself');
        const out = await setFriend(db, me, u.subject_id, true);
        res.status(out.changed ? 201 : 200).json({ changed: out.changed, friend: view(u, out, await stateOf(db, me, u.subject_id)) });
    }));

    router.delete('/:target', requireAuth, async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        const key = String(req.params.target || '');
        const u = await target(db, key) || (SUBJECT_RE.test(key) ? { subject_id: key, username: null, display_name: null } : null);
        if (!u || !u.subject_id || !await outgoing(db, me, u.subject_id)) throw new FriendError(404, 'friends.not_added', 'that person is not added');
        const out = await setFriend(db, me, u.subject_id, false);
        res.json({ changed: out.changed, friend: view(u, out, await stateOf(db, me, u.subject_id)) });
    }));

    return router;
}

module.exports = { MAX_ACTIVE, FriendError, ensureSchema, setFriend, outgoing, stateOf, listFor, userRouter };
