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

/**
 * The whole picture for one person (11-14, friends across every site: the menu's Chat, profiles, cards, Link): mutual
 * friends (both added), the requests waiting on them (they added, I did not), and the ones I asked (I added, they did
 * not), each with a name, a picture and whether they are on an OpenVibe site now (the Frame's 30-minute window).
 */
async function circleOf(db, me) {
    const rows = await db.prepare(`SELECT o.friend_subject AS subject, 'out' AS dir, o.updated_at FROM user_friends o WHERE o.user_subject = ? AND o.active = 1
        UNION ALL SELECT i.user_subject AS subject, 'in' AS dir, i.updated_at FROM user_friends i WHERE i.friend_subject = ? AND i.active = 1`).all(String(me), String(me));
    const out = new Map();
    for (const r of rows) { const e = out.get(r.subject) || { subject: r.subject, out: false, in: false, at: r.updated_at }; e[r.dir] = true; if (String(r.updated_at) > String(e.at)) e.at = r.updated_at; out.set(r.subject, e); }
    const subs = [...out.keys()];
    if (!subs.length) return { mutual: [], requests: [], asked: [] };
    const users = await db.prepare(`SELECT subject_id, username, display_name, avatar_url FROM users WHERE subject_id IN (${subs.map(() => '?').join(',')})`).all(...subs);
    const by = new Map(users.map((u) => [u.subject_id, u]));
    let seen = new Map(); try { seen = require('../frame/seen').snapshot().members; } catch { /* no presence here */ }
    const person = (e) => {
        const u = by.get(e.subject) || {}; const on = seen.get(e.subject);
        return { subject: e.subject, username: u.username || null, display_name: u.display_name || u.username || null,
            avatar_url: u.avatar_url || (u.username ? `https://openvibe.network/avatar/${encodeURIComponent(u.username)}?s=80` : null),
            online: !!on, site: on && on.site ? on.site : null, since: e.at || null };
    };
    const order = (a, b) => Number(b.online) - Number(a.online) || String(a.display_name || '').localeCompare(String(b.display_name || ''));
    const all = [...out.values()];
    return {
        mutual: all.filter((e) => e.out && e.in).map(person).sort(order),
        requests: all.filter((e) => e.in && !e.out).map(person).sort(order),
        asked: all.filter((e) => e.out && !e.in).map(person).sort(order),
    };
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
        // friends: whom I added (as before); mutual, requests and asked: the whole picture (11-14).
        res.json({ subject: me, friends: await listFor(db, me), ...await circleOf(db, me) });
    }));

    router.put('/:target', requireAuth, async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        const u = await target(db, req.params.target);
        if (!u) throw new FriendError(404, 'friends.unknown_person', 'no such person');
        if (u.is_anon) throw new FriendError(400, 'friends.guest', 'guests cannot be friended');
        if (u.subject_id === me) throw new FriendError(400, 'friends.self', 'you cannot friend yourself');
        const blocks = require('./blocks');
        if (await blocks.isBlocked(db, me, u.subject_id) || await blocks.isBlocked(db, u.subject_id, me)) throw new FriendError(403, 'friends.blocked', 'you cannot add this person');
        const out = await setFriend(db, me, u.subject_id, true);
        res.status(out.changed ? 201 : 200).json({ changed: out.changed, friend: view(u, out, await stateOf(db, me, u.subject_id)) });
    }));

    // Accept a request: add them back (they added me first). 404 when they did not.
    router.post('/:target/accept', requireAuth, async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        const u = await target(db, req.params.target);
        if (!u || !u.subject_id) throw new FriendError(404, 'friends.unknown_person', 'no such person');
        if (!await outgoing(db, u.subject_id, me)) throw new FriendError(404, 'friends.no_request', 'that person has not added you');
        const out = await setFriend(db, me, u.subject_id, true);
        res.json({ changed: out.changed, friend: view(u, out, await stateOf(db, me, u.subject_id)) });
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

/** GET /internal/friends?subject=usr_… (behind the friends-read capability, once Contracts names it): mutual friends' subjects. */
function internalHandler(db) {
    return async (req, res) => {
        const subject = String(req.query.subject || '');
        if (!SUBJECT_RE.test(subject)) return res.status(400).json({ error: 'subject must be a usr_ subject' });
        try {
            const rows = await db.prepare(`SELECT o.friend_subject AS s FROM user_friends o JOIN user_friends i ON i.user_subject = o.friend_subject AND i.friend_subject = o.user_subject AND i.active = 1
                WHERE o.user_subject = ? AND o.active = 1 LIMIT ?`).all(subject, MAX_ACTIVE);
            res.set('Cache-Control', 'no-store').json({ subject, friends: rows.map((r) => r.s) });
        } catch (err) { console.error('[Friends] internal:', err.message); res.status(500).json({ error: 'failed' }); }
    };
}

module.exports = { MAX_ACTIVE, FriendError, ensureSchema, setFriend, outgoing, stateOf, listFor, circleOf, userRouter, internalHandler };
