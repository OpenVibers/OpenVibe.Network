'use strict';
/**
 * Platform blocks (roadmap WS-E task 5; Contracts 0.49.0 network.block.changed, network.blocks.read).
 *
 * A person blocks someone once, here, and every product honours it: Chat (no DM, no mention notification
 * from someone who blocked you), Community (no reply to their threads, comments or pastes) and Network's own
 * notifications (none from a person the recipient blocked; server/notifications/notification-service.js).
 *
 * user_blocks is keyed by subjects (usr_…), one row per (blocker, blocked). An unblock keeps the row with
 * active = 0 so the pair's revision keeps growing: every change raises it by one, and consumers keep the
 * highest revision they have applied. Each change writes network.block.changed into network_event_outbox in
 * the same transaction (relayed to OpenVibe.Events by server/developer/event-relay.js); setting a pair to the
 * state it already has changes nothing and announces nothing.
 *
 * Nobody blocks themselves, and guests (anonymous sessions) neither block nor are blocked. Staff can be
 * blocked like anyone (no DMs, mentions or replies from them), but a block never hides a staff action:
 * moderation, system and admin notices are always delivered, and services apply bans, removals and
 * warnings whatever the blocks.
 *
 *   GET    /api/v1/me/blocks                    who I blocked (subject, username, display name, avatar)
 *   PUT    /api/v1/me/blocks/:subjectOrUsername block (201 new, 200 already blocked)
 *   DELETE /api/v1/me/blocks/:subjectOrUsername unblock (200; 404 when not blocked)
 *   GET    /internal/blocks?subject=usr_…       { subject, blocks, blocked_by } for services holding
 *                                               network.blocks.read (service token only, never the key)
 */
const express = require('express');
const { ids, validate, http } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');

const EVENT_TYPE = 'network.block.changed';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
// Active blocks one person may hold; keeps /internal/blocks answers bounded.
const MAX_ACTIVE = 5000;

class BlockError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

function ensureSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_blocks (
        blocker_subject TEXT NOT NULL,
        blocked_subject TEXT NOT NULL,
        active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (blocker_subject, blocked_subject),
        CHECK (blocker_subject <> blocked_subject)
    );
    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_subject, active);`);
}

/** A person who can block or be blocked: a users row with a usr_ subject that is not a guest. */
const personRow = (db, where, value) => db.prepare(`SELECT id, subject_id, username, display_name, avatar_url, is_anon FROM users WHERE ${where}`).get(value);

/** The person a path segment names: a usr_ subject, or a current username (any case). */
function findTarget(db, key) {
    const k = String(key || '').trim();
    if (SUBJECT_RE.test(k)) return personRow(db, 'subject_id = ?', k) || null;
    if (/^gst_/.test(k)) throw new BlockError(400, 'blocks.guest', 'guests cannot be blocked');
    if (!NAME_RE.test(k)) return null;
    return personRow(db, 'username = ? COLLATE NOCASE', k) || null;
}

function isBlocked(db, blockerSubject, blockedSubject) {
    return !!db.prepare('SELECT 1 FROM user_blocks WHERE blocker_subject = ? AND blocked_subject = ? AND active = 1').get(String(blockerSubject), String(blockedSubject));
}

/** The envelope for one change; throws if it would not match the contract (a bug, never input). */
function buildEnvelope({ blocker, blocked, active, revision, at }) {
    const ms = Date.parse(at) || Date.now();
    const env = {
        event_id: ids.newId('event', ms), event_type: EVENT_TYPE, version: 1, source: 'network',
        actor: { type: 'user', id: blocker }, timestamp: new Date(ms).toISOString(), visibility: 'internal',
        subject: { type: 'user', id: blocker },
        payload: { blocker, blocked, active: !!active, revision, at: new Date(ms).toISOString() },
    };
    const v = validate('events.event-envelope@1', env);
    const pv = validate(`${EVENT_TYPE}@1`, env.payload);
    if (!v.valid || !pv.valid) throw new Error(`blocks: bad event: ${JSON.stringify((v.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    return env;
}

/**
 * Set (blocker, blocked) to `active`, in one transaction with its event. Both must be usr_ subjects
 * (the caller checked who they are). → { changed, active, revision, at }
 */
function setBlock(db, blocker, blocked, active) {
    if (!SUBJECT_RE.test(String(blocker)) || !SUBJECT_RE.test(String(blocked))) throw new BlockError(400, 'blocks.bad_subject', 'blocks are between usr_ subjects');
    if (blocker === blocked) throw new BlockError(400, 'blocks.self', 'you cannot block yourself');
    return db.transaction(() => {
        const prev = db.prepare('SELECT active, revision, updated_at FROM user_blocks WHERE blocker_subject = ? AND blocked_subject = ?').get(blocker, blocked);
        if (prev && !!prev.active === !!active) return { changed: false, active: !!active, revision: prev.revision, at: prev.updated_at };
        if (!prev && !active) return { changed: false, active: false, revision: 0, at: null };
        if (active) {
            const n = db.prepare('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_subject = ? AND active = 1').get(blocker).n;
            if (n >= MAX_ACTIVE) throw new BlockError(409, 'blocks.limit', `at most ${MAX_ACTIVE} people can be blocked`);
        }
        const at = new Date().toISOString();
        const revision = prev ? prev.revision + 1 : 1;
        if (prev) {
            db.prepare('UPDATE user_blocks SET active = ?, revision = ?, updated_at = ? WHERE blocker_subject = ? AND blocked_subject = ?')
                .run(active ? 1 : 0, revision, at, blocker, blocked);
        } else {
            db.prepare('INSERT INTO user_blocks (blocker_subject, blocked_subject, active, revision, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)')
                .run(blocker, blocked, at, at);
        }
        eventRelay.writerFor(db).enqueue(buildEnvelope({ blocker, blocked, active, revision, at }));
        return { changed: true, active: !!active, revision, at };
    })();
}

function kick(db) { const o = eventRelay.outboxFor(db); if (o) o.kick(); }

/** Who `subject` blocked (with names, newest first), for the person's own list. */
function listFor(db, subject) {
    return db.prepare(`SELECT b.blocked_subject, b.revision, b.updated_at, u.username, u.display_name, u.avatar_url
        FROM user_blocks b LEFT JOIN users u ON u.subject_id = b.blocked_subject
        WHERE b.blocker_subject = ? AND b.active = 1 ORDER BY b.updated_at DESC, b.blocked_subject`).all(String(subject))
        .map((r) => ({
            subject: r.blocked_subject, username: r.username || null, display_name: r.username ? (r.display_name || r.username) : null,
            avatar_url: r.avatar_url || null, blocked_at: r.updated_at, revision: r.revision,
        }));
}

/** What a service needs: who `subject` blocked and who blocked them (active blocks only). */
function edgesOf(db, subject) {
    const s = String(subject);
    return {
        subject: s,
        blocks: db.prepare('SELECT blocked_subject AS s FROM user_blocks WHERE blocker_subject = ? AND active = 1 ORDER BY blocked_subject').all(s).map((r) => r.s),
        blocked_by: db.prepare('SELECT blocker_subject AS s FROM user_blocks WHERE blocked_subject = ? AND active = 1 ORDER BY blocker_subject').all(s).map((r) => r.s),
    };
}

/** The signed-in person as a blocker, or a BlockError. */
function meOf(db, user) {
    if (!user || user.is_anon) throw new BlockError(403, 'blocks.guest', 'sign in with an account to block people');
    const sid = require('./subjects').ensureUserSubject(db, user);
    if (!SUBJECT_RE.test(String(sid || ''))) throw new BlockError(403, 'blocks.guest', 'sign in with an account to block people');
    return sid;
}

const view = (u, out) => ({ subject: u.subject_id, username: u.username, display_name: u.display_name || u.username, avatar_url: u.avatar_url || null, active: out.active, revision: out.revision, ...(out.active ? { blocked_at: out.at } : {}) });

function userRouter(requireAuth) {
    const router = express.Router();
    router.use(http.middleware());
    const send = (req, res, fn) => {
        res.set('Cache-Control', 'private, no-store');
        try { return fn(req.app.locals.db); } catch (err) {
            if (err instanceof BlockError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            console.error('[Blocks]', err.message);
            return http.sendProblem(res, 500, 'blocks.failed', { detail: 'the block could not be changed', ctx: req.ov });
        }
    };

    router.get('/', requireAuth, (req, res) => send(req, res, (db) => {
        const me = meOf(db, req.user);
        res.json({ subject: me, blocks: listFor(db, me) });
    }));

    router.put('/:target', requireAuth, (req, res) => send(req, res, (db) => {
        const me = meOf(db, req.user);
        const u = findTarget(db, req.params.target);
        if (!u) throw new BlockError(404, 'blocks.unknown_person', 'no such person');
        if (u.is_anon) throw new BlockError(400, 'blocks.guest', 'guests cannot be blocked');
        if (u.subject_id === me) throw new BlockError(400, 'blocks.self', 'you cannot block yourself');
        const out = setBlock(db, me, u.subject_id, true);
        if (out.changed) kick(db);
        res.status(out.changed ? 201 : 200).json({ changed: out.changed, block: view(u, out) });
    }));

    router.delete('/:target', requireAuth, (req, res) => send(req, res, (db) => {
        const me = meOf(db, req.user);
        const key = String(req.params.target || '');
        // A subject can be unblocked even if its account is gone since.
        const u = findTarget(db, key) || (SUBJECT_RE.test(key) ? { subject_id: key, username: null, display_name: null, avatar_url: null } : null);
        if (!u || !u.subject_id || !isBlocked(db, me, u.subject_id)) throw new BlockError(404, 'blocks.not_blocked', 'that person is not blocked');
        const out = setBlock(db, me, u.subject_id, false);
        if (out.changed) kick(db);
        res.json({ changed: out.changed, block: view(u, out) });
    }));

    return router;
}

/** GET /internal/blocks?subject=usr_… (mounted behind principals.guard('network.blocks.read', { legacy: false })). */
function internalHandler(db) {
    return (req, res) => {
        res.set('Cache-Control', 'no-store');
        const subject = String(req.query.subject || '');
        if (!SUBJECT_RE.test(subject)) return http.sendProblem(res, 400, 'blocks.bad_subject', { detail: 'subject must be a usr_ subject id' });
        res.json(edgesOf(db, subject));
    };
}

module.exports = { EVENT_TYPE, MAX_ACTIVE, BlockError, ensureSchema, setBlock, isBlocked, listFor, edgesOf, findTarget, buildEnvelope, userRouter, internalHandler, kick };
