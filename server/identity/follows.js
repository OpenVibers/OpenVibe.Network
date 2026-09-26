'use strict';
/**
 * The follow graph (roadmap WS-E task 4, ADR-030; Contracts 0.65.0 network.follow.created / .deleted,
 * network.follow-status-result@1, network.follow-list-result@1, network.follows.read).
 *
 * Network owns follows, keyed by subjects. Today a target is a Live channel, named by its owner's
 * subject (target_type `channel`); other kinds join as products need them. Live keeps a projection it can
 * rebuild from the events, and go-live notifications can read the followers here instead of asking Live.
 *
 * user_follows has one row per (follower, target_type, target_id). An unfollow keeps the row with
 * active = 0, so the pair's revision keeps growing: every change raises it by one, and consumers keep
 * the highest revision they have applied. Each change writes network.follow.created (a follow, or new
 * notify flags) or network.follow.deleted into network_event_outbox in the same transaction (relayed to
 * OpenVibe.Events by server/developer/event-relay.js). Following again with the same flags, or unfollowing
 * what is not followed, changes nothing and announces nothing.
 *
 *   GET    /api/v1/follows/:type/:target                 public: { target_type, target_id, followers }, and
 *                                                        for a signed-in caller following, notify flags, since
 *   GET    /api/v1/follows/:type/:target/followers       the target's owner, or a service with network.follows.read
 *   GET    /api/v1/me/follows?type=&cursor=&limit=       what the caller follows
 *   PUT    /api/v1/me/follows/:type/:target              follow (201 new, 200 unchanged); body { notify_email?, notify_push? }
 *   DELETE /api/v1/me/follows/:type/:target              unfollow (200, idempotent)
 *
 * :target is a usr_ subject or a current username. Nobody follows themselves; guests do not follow.
 * Lists are never public (counts are). ADR-030's migration: importFollows() backfills Live's follows
 * (scripts/follows-backfill.js), holding any pair whose side has no subject in follow_import_holds.
 */
const express = require('express');
const { ids, validate, http } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');

const TYPES = ['channel'];
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const MAX_FOLLOWING = 5000;

class FollowError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

function ensureSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_follows (
        follower_subject TEXT NOT NULL,
        target_type      TEXT NOT NULL CHECK (target_type IN ('channel')),
        target_id        TEXT NOT NULL,
        active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        notify_email     INTEGER NOT NULL DEFAULT 1 CHECK (notify_email IN (0, 1)),
        notify_push      INTEGER NOT NULL DEFAULT 1 CHECK (notify_push IN (0, 1)),
        revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        source           TEXT NOT NULL DEFAULT 'network',
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (follower_subject, target_type, target_id),
        CHECK (follower_subject <> target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_follows_target ON user_follows(target_type, target_id, active, created_at);
    CREATE TABLE IF NOT EXISTS follow_import_holds (
        source        TEXT NOT NULL,
        follower_ref  TEXT NOT NULL,
        target_ref    TEXT NOT NULL,
        reason        TEXT NOT NULL,
        seen_at       TEXT NOT NULL,
        PRIMARY KEY (source, follower_ref, target_ref)
    );`);
}

const personRow = (db, where, value) => db.prepare(`SELECT id, subject_id, username, display_name, avatar_url, is_anon FROM users WHERE ${where}`).get(value);

/** The target a path names: a usr_ subject or a current username (any case) → the person row, or null. */
function findTarget(db, type, key) {
    if (!TYPES.includes(type)) throw new FollowError(404, 'follows.unknown_type', `target type must be one of ${TYPES.join(', ')}`);
    const k = String(key || '').trim();
    if (SUBJECT_RE.test(k)) return personRow(db, 'subject_id = ?', k) || null;
    if (!NAME_RE.test(k)) return null;
    return personRow(db, 'username = ? COLLATE NOCASE', k) || null;
}

function buildEnvelope({ follower, type, target, active, notifyEmail, notifyPush, revision, at, reason = null, actor = null }) {
    const ms = Date.parse(at) || Date.now();
    const eventType = active ? 'network.follow.created' : 'network.follow.deleted';
    const payload = active
        ? { follower, target_type: type, target_id: target, notify_email: !!notifyEmail, notify_push: !!notifyPush, revision, at: new Date(ms).toISOString() }
        : { follower, target_type: type, target_id: target, reason: reason || 'unfollowed', revision, at: new Date(ms).toISOString() };
    const env = {
        event_id: ids.newId('event', ms), event_type: eventType, version: 1, source: 'network',
        actor: actor || { type: 'user', id: follower }, timestamp: new Date(ms).toISOString(), visibility: 'subject',
        subject: { type: 'user', id: follower }, payload,
    };
    const v = validate('events.event-envelope@1', env);
    const pv = validate(`${eventType}@1`, payload);
    if (!v.valid || !pv.valid) throw new Error(`follows: bad event: ${JSON.stringify((v.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    return env;
}

/**
 * Set (follower → type/target) to `active` with the notify flags, in one transaction with its event.
 * → { changed, active, notify_email, notify_push, revision, created_at, at }
 * opts: notifyEmail/notifyPush (undefined keeps the stored value, else true), reason and actor (deletes),
 * emit (false for an import: no event), source, at.
 */
function setFollow(db, follower, type, target, active, { notifyEmail, notifyPush, reason = null, actor = null, emit = true, source = 'network', at: atIn = null } = {}) {
    if (!SUBJECT_RE.test(String(follower)) || !SUBJECT_RE.test(String(target))) throw new FollowError(400, 'follows.bad_subject', 'follows are between usr_ subjects');
    if (!TYPES.includes(type)) throw new FollowError(404, 'follows.unknown_type', `target type must be one of ${TYPES.join(', ')}`);
    if (follower === target) throw new FollowError(400, 'follows.self', 'you cannot follow yourself');
    return db.transaction(() => {
        const prev = db.prepare('SELECT * FROM user_follows WHERE follower_subject = ? AND target_type = ? AND target_id = ?').get(follower, type, target);
        const email = notifyEmail === undefined ? (prev ? !!prev.notify_email : true) : !!notifyEmail;
        const push = notifyPush === undefined ? (prev ? !!prev.notify_push : true) : !!notifyPush;
        const same = prev && !!prev.active === !!active && (!active || (!!prev.notify_email === email && !!prev.notify_push === push));
        if (same) return { changed: false, active: !!active, notify_email: email, notify_push: push, revision: prev.revision, created_at: prev.created_at, at: prev.updated_at };
        if (!prev && !active) return { changed: false, active: false, notify_email: email, notify_push: push, revision: 0, created_at: null, at: null };
        if (active && !(prev && prev.active)) {
            const n = db.prepare('SELECT COUNT(*) AS n FROM user_follows WHERE follower_subject = ? AND active = 1').get(follower).n;
            if (n >= MAX_FOLLOWING) throw new FollowError(409, 'follows.limit', `at most ${MAX_FOLLOWING} follows`);
        }
        const at = atIn || new Date().toISOString();
        const revision = prev ? prev.revision + 1 : 1;
        // A follow that starts again starts its "since" again; flag changes keep it.
        const createdAt = prev && prev.active && active ? prev.created_at : at;
        if (prev) {
            db.prepare(`UPDATE user_follows SET active = ?, notify_email = ?, notify_push = ?, revision = ?, source = ?, created_at = ?, updated_at = ?
                        WHERE follower_subject = ? AND target_type = ? AND target_id = ?`)
                .run(active ? 1 : 0, email ? 1 : 0, push ? 1 : 0, revision, source, createdAt, at, follower, type, target);
        } else {
            db.prepare(`INSERT INTO user_follows (follower_subject, target_type, target_id, active, notify_email, notify_push, revision, source, created_at, updated_at)
                        VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?, ?)`).run(follower, type, target, email ? 1 : 0, push ? 1 : 0, source, at, at);
        }
        if (emit) eventRelay.writerFor(db).enqueue(buildEnvelope({ follower, type, target, active, notifyEmail: email, notifyPush: push, revision, at, reason, actor }));
        return { changed: true, active: !!active, notify_email: email, notify_push: push, revision, created_at: active ? createdAt : null, at };
    })();
}

function kick(db) { const o = eventRelay.outboxFor(db); if (o) o.kick(); }

function count(db, type, target) {
    return db.prepare('SELECT COUNT(*) AS n FROM user_follows WHERE target_type = ? AND target_id = ? AND active = 1').get(type, target).n;
}

/** network.follow-status-result@1 for (type, target), with the viewer's own follow when given. */
function status(db, type, target, viewer = null) {
    const out = { target_type: type, target_id: target, followers: count(db, type, target) };
    if (viewer && SUBJECT_RE.test(viewer)) {
        const r = db.prepare('SELECT * FROM user_follows WHERE follower_subject = ? AND target_type = ? AND target_id = ? AND active = 1').get(viewer, type, target);
        out.following = !!r;
        if (r) Object.assign(out, { notify_email: !!r.notify_email, notify_push: !!r.notify_push, since: r.created_at });
    }
    return out;
}

const encodeCursor = (r) => Buffer.from(`${r.created_at}|${r.follower_subject}|${r.target_id}`).toString('base64url');
function decodeCursor(c) {
    if (!c) return null;
    const [at, a, b] = Buffer.from(String(c), 'base64url').toString('utf8').split('|');
    if (!at || !SUBJECT_RE.test(a || '') || !SUBJECT_RE.test(b || '')) throw new FollowError(400, 'follows.bad_cursor', 'cursor is not one this API issued');
    return { at, a, b };
}
const item = (r) => ({ follower: r.follower_subject, target_type: r.target_type, target_id: r.target_id, notify_email: !!r.notify_email, notify_push: !!r.notify_push, created_at: r.created_at });

/** A page of follows (newest first): by follower (what they follow) or by target (who follows it). */
function list(db, { follower = null, type = null, target = null, cursor = null, limit = 50 } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const c = decodeCursor(cursor);
    const where = ['active = 1'];
    const args = [];
    if (follower) { where.push('follower_subject = ?'); args.push(follower); }
    if (type) { where.push('target_type = ?'); args.push(type); }
    if (target) { where.push('target_id = ?'); args.push(target); }
    if (c) { where.push('(created_at < ? OR (created_at = ? AND (follower_subject, target_id) < (?, ?)))'); args.push(c.at, c.at, c.a, c.b); }
    const rows = db.prepare(`SELECT * FROM user_follows WHERE ${where.join(' AND ')} ORDER BY created_at DESC, follower_subject DESC, target_id DESC LIMIT ?`).all(...args, n + 1);
    const more = rows.length > n;
    if (more) rows.pop();
    return { items: rows.map(item), next_cursor: more ? encodeCursor(rows[rows.length - 1]) : null };
}

/**
 * An account's follows go with it (both directions), each announced as a delete. Call inside the
 * transaction that removes the account (account deletion, WS-B task 7). → the pairs removed
 */
function onSubjectRemoved(db, subject) {
    const rows = db.prepare('SELECT * FROM user_follows WHERE active = 1 AND (follower_subject = ? OR target_id = ?)').all(subject, subject);
    for (const r of rows) {
        setFollow(db, r.follower_subject, r.target_type, r.target_id, false, {
            reason: r.follower_subject === subject ? 'account_removed' : 'target_removed', actor: { type: 'system', id: 'network' },
        });
    }
    return rows.length;
}

/**
 * ADR-030 step 2: import follows from another system's rows, mapped to subjects by `subjectOf`.
 * rows: [{ follower_ref, target_ref, notify_email, notify_push, created_at }] (the refs are that system's ids).
 * A pair whose side has no subject (or is the same person) is held in follow_import_holds, never dropped.
 * No events (the source system already has these follows); dryRun changes nothing.
 * → { imported, unchanged, held: [{ follower_ref, target_ref, reason }] }
 */
function importFollows(db, source, rows, subjectOf, { dryRun = false, now = new Date().toISOString() } = {}) {
    const out = { imported: 0, unchanged: 0, held: [] };
    const run = () => {
        for (const r of rows) {
            const follower = subjectOf(r.follower_ref);
            const target = subjectOf(r.target_ref);
            let reason = null;
            if (!follower) reason = 'follower_has_no_subject';
            else if (!target) reason = 'target_has_no_subject';
            else if (follower === target) reason = 'self_follow';
            if (reason) {
                out.held.push({ follower_ref: String(r.follower_ref), target_ref: String(r.target_ref), reason });
                if (!dryRun) db.prepare('INSERT OR REPLACE INTO follow_import_holds (source, follower_ref, target_ref, reason, seen_at) VALUES (?, ?, ?, ?, ?)').run(source, String(r.follower_ref), String(r.target_ref), reason, now);
                continue;
            }
            const prev = db.prepare('SELECT active FROM user_follows WHERE follower_subject = ? AND target_type = ? AND target_id = ?').get(follower, 'channel', target);
            if (prev && prev.active) { out.unchanged++; continue; }
            if (!dryRun) {
                setFollow(db, follower, 'channel', target, true, {
                    notifyEmail: r.notify_email == null ? true : !!r.notify_email, notifyPush: r.notify_push == null ? true : !!r.notify_push,
                    emit: false, source, at: r.created_at ? new Date(r.created_at).toISOString() : now,
                });
            }
            out.imported++;
        }
    };
    if (dryRun) run(); else db.transaction(run)();
    return out;
}

/** The signed-in person as a follower, or a FollowError. */
function meOf(db, user) {
    if (!user || user.is_anon) throw new FollowError(403, 'follows.guest', 'sign in with an account to follow');
    const sid = require('./subjects').ensureUserSubject(db, user);
    if (!SUBJECT_RE.test(String(sid || ''))) throw new FollowError(403, 'follows.guest', 'sign in with an account to follow');
    return sid;
}

/** The session user of a request, or null (never refuses: for public reads). */
function viewerOf(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.cookies && req.cookies.ov_token);
    if (!token) return null;
    try {
        const out = require('../auth/session').verifySession(token, { db: req.app.locals.db, publicKey: req.app.locals.publicKey, config: req.app.locals.config });
        return out && out.user ? out.user : null;
    } catch { return null; }
}

function routers({ requireAuth, followsGuard }) {
    const send = (req, res, fn) => {
        res.set('Cache-Control', 'private, no-store');
        try { return fn(req.app.locals.db); } catch (err) {
            if (err instanceof FollowError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            console.error('[Follows]', err.message);
            return http.sendProblem(res, 500, 'follows.failed', { detail: 'the follow could not be changed', ctx: req.ov });
        }
    };
    const targetOrFail = (db, type, key) => {
        const u = findTarget(db, type, key);
        if (!u || u.is_anon || !SUBJECT_RE.test(String(u.subject_id || ''))) throw new FollowError(404, 'follows.unknown_target', 'no such channel');
        return u;
    };

    const me = express.Router();
    me.use(http.middleware());
    me.get('/', requireAuth, (req, res) => send(req, res, (db) => {
        const sid = meOf(db, req.user);
        const type = req.query.type ? String(req.query.type) : null;
        if (type && !TYPES.includes(type)) throw new FollowError(404, 'follows.unknown_type', `target type must be one of ${TYPES.join(', ')}`);
        res.json(list(db, { follower: sid, type, cursor: req.query.cursor, limit: req.query.limit }));
    }));
    me.put('/:type/:target', requireAuth, express.json({ limit: '4kb' }), (req, res) => send(req, res, (db) => {
        const sid = meOf(db, req.user);
        const t = targetOrFail(db, req.params.type, req.params.target);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const out = setFollow(db, sid, req.params.type, t.subject_id, true, {
            notifyEmail: typeof b.notify_email === 'boolean' ? b.notify_email : undefined, notifyPush: typeof b.notify_push === 'boolean' ? b.notify_push : undefined,
        });
        if (out.changed) kick(db);
        res.status(out.changed && out.revision === 1 ? 201 : 200).json(status(db, req.params.type, t.subject_id, sid));
    }));
    me.delete('/:type/:target', requireAuth, (req, res) => send(req, res, (db) => {
        const sid = meOf(db, req.user);
        const key = String(req.params.target || '');
        // A subject can be unfollowed even if its account is gone since.
        const t = findTarget(db, req.params.type, key) || (SUBJECT_RE.test(key) ? { subject_id: key } : null);
        if (!t || !t.subject_id) throw new FollowError(404, 'follows.unknown_target', 'no such channel');
        const out = setFollow(db, sid, req.params.type, t.subject_id, false);
        if (out.changed) kick(db);
        res.json(status(db, req.params.type, t.subject_id, sid));
    }));

    const pub = express.Router();
    pub.use(http.middleware());
    pub.get('/:type/:target', (req, res) => {
        try {
            const db = req.app.locals.db;
            const t = targetOrFail(db, req.params.type, req.params.target);
            const viewer = viewerOf(req);
            const body = status(db, req.params.type, t.subject_id, viewer && !viewer.is_anon ? viewer.subject_id : null);
            res.set('Cache-Control', viewer ? 'private, no-store' : 'public, max-age=30').set('Vary', 'Authorization, Cookie').json(body);
        } catch (err) {
            if (err instanceof FollowError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            throw err;
        }
    });
    // Who follows a target: its owner (signed in), or a service holding network.follows.read.
    pub.get('/:type/:target/followers', (req, res, next) => {
        const db = req.app.locals.db;
        let t;
        try { t = targetOrFail(db, req.params.type, req.params.target); } catch (err) { return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov }); }
        const answer = () => send(req, res, () => res.json(list(db, { type: req.params.type, target: t.subject_id, cursor: req.query.cursor, limit: req.query.limit })));
        const viewer = viewerOf(req);
        if (viewer && viewer.subject_id === t.subject_id) return answer();
        if (viewer) return http.sendProblem(res, 403, 'follows.not_yours', { detail: 'only the channel owner sees who follows it', ctx: req.ov });
        return followsGuard(req, res, answer);
    });

    return { me, pub };
}

module.exports = { TYPES, FollowError, ensureSchema, setFollow, status, list, count, findTarget, buildEnvelope, onSubjectRemoved, importFollows, routers, kick };
