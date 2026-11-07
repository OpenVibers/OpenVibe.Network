'use strict';
/**
 * A person's presence (plan 2026-10-22 track X item 9; Contracts 0.318.0 network.presence@1,
 * network.presence-update-request@1 and network.presence.changed@1).
 *
 * OpenVibe.Network owns the chosen online status. A heartbeat from any open tab keeps it fresh:
 *
 *   POST /api/v1/me/presence/heartbeat  { idle?: true }   any signed-in person, at most once a minute
 *   PUT  /api/v1/me/presence            network.presence-update-request@1
 *   GET  /api/v1/presence?subjects=…    the people the caller follows or has a DM with, and themselves
 *   GET  /internal/presence?for=usr_…&subjects=…   the same for a first-party service
 *                                                  (network.presence.read)
 *
 * Derived state: online while the newest heartbeat is under 2 minutes old; away after 10 minutes without
 * input (the client's idle heartbeat leaves last_active_at alone); offline after 3 minutes without a
 * heartbeat. invisible, or the "Show my status" switch off, reads as offline to everyone; an invisible
 * person is left out of another person's answer entirely. Last seen is never returned.
 *
 * live is true while the person is streaming on OpenVibe.Live. The live list is Live's public
 * GET /api/streams over loopback, cached 30 s, and mapped to Network subjects through
 * identity_legacy_map (source_system 'live'). Live outranks the chosen state; it is false while hidden.
 *
 * network.presence.changed is written into network_event_outbox in the same transaction as the row, only
 * for a real change of the public view, at most once per person per 30 s. A change inside the window sets
 * pending_since; flushDue() sends the view that stands when the window opens, so a tab that closes right
 * after a change still announces it. The payload is always the public view: invisible is offline with no
 * text or emoji.
 *
 * The DM part of the visibility rule is read from OpenVibe.Chat (POST /internal/chat/dm/peers,
 * chat.dm.peers.read), cached here for 30 s; when Chat does not answer, only follows count. The follow
 * part is Network's own user_follows ('channel' targets are the owner's subject).
 *
 * Tests: test/presence.test.js.
 */
const { ids, validate } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const HEARTBEAT_ONLINE_MS = 2 * 60 * 1000;
const OFFLINE_MS = 3 * 60 * 1000;
const AWAY_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 30 * 1000;
const LIVE_TTL_MS = 30 * 1000;
const DM_TTL_MS = 30 * 1000;
const MAX_SUBJECTS = 100;
const MAX_STATUS = 80;
const MAX_EMOJI = 16;

class PresenceError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail; }
}

const iso = (ms) => new Date(ms).toISOString();
const msOf = (t) => { const n = Date.parse(String(t || '')); return Number.isFinite(n) ? n : null; };

/** Plain single-line text: control characters and angle brackets never reach a status line. */
function cleanText(value) {
    if (value == null) return null;
    if (typeof value !== 'string') throw new PresenceError(400, 'presence.bad_status', 'status_text must be text or null');
    const s = value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if ([...s].length > MAX_STATUS) throw new PresenceError(400, 'presence.status_too_long', `a status line is at most ${MAX_STATUS} characters`);
    return s;
}

/** One emoji: one grapheme cluster, at most 16 code points (a family or a flag is one cluster). */
function cleanEmoji(value) {
    if (value == null) return null;
    if (typeof value !== 'string') throw new PresenceError(400, 'presence.bad_emoji', 'emoji must be text or null');
    const s = value.trim();
    if (!s) return null;
    if ([...s].length > MAX_EMOJI) throw new PresenceError(400, 'presence.emoji_too_long', 'emoji must be one emoji');
    const count = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;
    if (count !== 1) throw new PresenceError(400, 'presence.one_emoji', 'emoji must be one emoji');
    return s;
}

/** The public view of one row, or null when there is no row. `self` keeps the chosen hidden state for its owner. */
function publicView(row, { nowMs, streaming = false, self = false } = {}) {
    if (!row) return null;
    const hidden = !Number(row.show_status) || row.state === 'invisible';
    const lastBeat = msOf(row.last_heartbeat_at);
    const lastActive = msOf(row.last_active_at) ?? lastBeat;
    let state;
    // The owner's chosen DND is theirs whatever the heartbeat says (Chat reads it to mute their pings);
    // everyone else sees DND only while the heartbeat is fresh, and offline after it.
    if (self && !hidden && row.state === 'dnd') state = 'dnd';
    else if (hidden) state = self ? (row.state === 'invisible' ? 'invisible' : 'offline') : 'offline';
    else if (lastBeat == null || nowMs - lastBeat > OFFLINE_MS || lastBeat - nowMs > 60_000) state = 'offline';
    else if (row.state === 'dnd') state = 'dnd';
    // A heartbeat two minutes old still counts, but the connection is fading: away until the three-minute
    // cutoff makes it offline, or the next heartbeat makes it online again.
    else if (nowMs - lastBeat > HEARTBEAT_ONLINE_MS) state = 'away';
    else if (lastActive == null || nowMs - lastActive > AWAY_MS) state = 'away';
    else state = 'online';
    const visible = !hidden && state !== 'offline';
    return {
        subject: row.subject_id,
        state,
        status_text: visible || self ? (row.status_text || null) : null,
        emoji: visible || self ? (row.emoji || null) : null,
        live: !!(visible && streaming),
        updated_at: row.updated_at,
    };
}

/** Compare the public view with the last announced one (announced_at is not part of the view). */
function sameView(row, view) {
    return row.announced_state === view.state
        && (row.announced_status_text || null) === view.status_text
        && (row.announced_emoji || null) === view.emoji
        && Boolean(Number(row.announced_live)) === view.live;
}

function buildEnvelope(view, nowMs) {
    const env = {
        event_id: ids.newId('event', nowMs), event_type: 'network.presence.changed', version: 1, source: 'network',
        actor: { type: 'user', id: view.subject }, timestamp: iso(nowMs), visibility: 'internal',
        subject: { type: 'user', id: view.subject }, payload: view,
    };
    const v = validate('events.event-envelope@1', env);
    const pv = validate('network.presence.changed@1', view);
    if (!v.valid || !pv.valid) throw new Error(`presence: bad event: ${JSON.stringify((v.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    return env;
}

/** The announced fields for a public view. */
const announcedParams = (view) => [view.state, view.status_text, view.emoji, view.live ? 1 : 0];

/**
 * Record the public view, and announce it if it is a real change outside the debounce window.
 * Runs inside the caller's transaction. `row` is the row after the write.
 */
async function announce(tx, row, view, nowMs) {
    const at = iso(nowMs);
    const hadAnnouncement = row.announced_state != null;
    if (hadAnnouncement && sameView(row, view)) {
        if (row.pending_since) await tx.prepare('UPDATE person_presence SET pending_since = NULL WHERE subject_id = ?').run(row.subject_id);
        return false;
    }
    // The first write of someone who is already offline is not a change anyone can see; remember it quietly
    // so their first online/away/dnd transition announces at once.
    if (!hadAnnouncement && view.state === 'offline') {
        await tx.prepare(`UPDATE person_presence SET announced_state = ?, announced_status_text = ?, announced_emoji = ?, announced_live = ?, pending_since = NULL WHERE subject_id = ?`)
            .run(...announcedParams(view), row.subject_id);
        return false;
    }
    const lastAt = msOf(row.announced_at);
    if (hadAnnouncement && lastAt != null && nowMs - lastAt < DEBOUNCE_MS) {
        await tx.prepare('UPDATE person_presence SET pending_since = COALESCE(pending_since, ?) WHERE subject_id = ?').run(at, row.subject_id);
        return false;
    }
    await eventRelay.writerFor(tx).enqueue(buildEnvelope(view, nowMs));
    await tx.prepare(`UPDATE person_presence SET announced_state = ?, announced_status_text = ?, announced_emoji = ?, announced_live = ?, announced_at = ?, pending_since = NULL WHERE subject_id = ?`)
        .run(...announcedParams(view), at, row.subject_id);
    return true;
}

/** Read one row and its public view. */
async function viewOf(db, subject, { nowMs, streaming = false, self = false } = {}) {
    const row = await db.prepare('SELECT * FROM person_presence WHERE subject_id = ?').get(subject);
    return { row, view: publicView(row, { nowMs, streaming, self }) };
}

/** A heartbeat: fresh last_heartbeat_at; last_active_at moves only when the client is not idle. */
async function heartbeat(db, subject, { idle = false, nowMs = Date.now(), streaming = false } = {}) {
    if (!SUBJECT_RE.test(String(subject || ''))) throw new PresenceError(400, 'presence.bad_subject', 'not a person subject');
    const at = iso(nowMs);
    let view = null;
    await db.tx(async () => {
        const before = await db.prepare('SELECT * FROM person_presence WHERE subject_id = ?').get(subject);
        if (!before) {
            await db.prepare(`INSERT INTO person_presence (subject_id, state, show_status, last_active_at, last_heartbeat_at, updated_at)
                VALUES (?, 'auto', 1, ?, ?, ?)`).run(subject, at, at, at);
        } else {
            await db.prepare(`UPDATE person_presence SET last_heartbeat_at = ?, last_active_at = CASE WHEN ? THEN last_active_at ELSE ? END, updated_at = ? WHERE subject_id = ?`)
                .run(at, idle ? 1 : 0, at, at, subject);
        }
        const row = await db.prepare('SELECT * FROM person_presence WHERE subject_id = ?').get(subject);
        view = publicView(row, { nowMs, self: false, streaming });
        await announce(db, row, view, nowMs);
        view = publicView(row, { nowMs, self: true, streaming });
    });
    return view;
}

/** PUT /api/v1/me/presence: only the fields sent change. The row is created on a first write. */
async function update(db, subject, body, { nowMs = Date.now(), streaming = false } = {}) {
    if (!SUBJECT_RE.test(String(subject || ''))) throw new PresenceError(401, 'token.missing', 'a signed-in person is required');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PresenceError(400, 'presence.bad_body', 'a JSON object is required');
    const allowed = new Set(['state', 'status_text', 'emoji', 'show_status']);
    for (const k of Object.keys(body)) if (!allowed.has(k)) throw new PresenceError(400, 'presence.unknown_field', `unknown field ${k}`);
    if (!Object.keys(body).length) throw new PresenceError(400, 'presence.empty', 'send at least one field');
    if (body.state !== undefined && !['auto', 'dnd', 'invisible'].includes(body.state)) throw new PresenceError(400, 'presence.bad_state', 'state must be auto, dnd or invisible');
    if (body.status_text !== undefined) cleanText(body.status_text);
    if (body.emoji !== undefined) cleanEmoji(body.emoji);
    if (body.show_status !== undefined && typeof body.show_status !== 'boolean') throw new PresenceError(400, 'presence.bad_show_status', 'show_status must be true or false');

    const at = iso(nowMs);
    let view = null;
    await db.tx(async () => {
        const before = await db.prepare('SELECT * FROM person_presence WHERE subject_id = ?').get(subject);
        if (!before) {
            await db.prepare(`INSERT INTO person_presence (subject_id, state, status_text, emoji, show_status, last_active_at, last_heartbeat_at, updated_at)
                VALUES (?, 'auto', NULL, NULL, 1, ?, NULL, ?)`).run(subject, at, at);
        }
        const row = await db.prepare('SELECT * FROM person_presence WHERE subject_id = ?').get(subject);
        const next = {
            state: body.state !== undefined ? body.state : row.state,
            status_text: body.status_text !== undefined ? cleanText(body.status_text) : row.status_text,
            emoji: body.emoji !== undefined ? cleanEmoji(body.emoji) : row.emoji,
            show_status: body.show_status !== undefined ? (body.show_status ? 1 : 0) : Number(row.show_status),
        };
        await db.prepare('UPDATE person_presence SET state = ?, status_text = ?, emoji = ?, show_status = ?, updated_at = ? WHERE subject_id = ?')
            .run(next.state, next.status_text, next.emoji, next.show_status, at, subject);
        const after = await db.prepare('SELECT * FROM person_presence WHERE subject_id = ?').get(subject);
        await announce(db, after, publicView(after, { nowMs, self: false, streaming }), nowMs);
        view = publicView(after, { nowMs, self: true, streaming });
    });
    return view;
}

/** The public view of `subjects` for `viewer`: themselves, people they follow, and DM peers only. */
async function visiblePresence(db, viewer, subjects, { nowMs = Date.now(), streaming = new Set(), dmPeers } = {}) {
    const self = subjects.includes(viewer);
    const others = subjects.filter((s) => s !== viewer);
    if (!others.length) {
        const own = await viewOf(db, viewer, { nowMs, streaming: streaming.has(viewer), self: true });
        return own.view ? [own.view] : [];
    }
    const followed = new Set();
    const rows = await db.prepare(`SELECT target_id FROM user_follows WHERE follower_subject = ? AND target_type = 'channel' AND active = 1 AND target_id = ANY(?)`)
        .all(viewer, others);
    for (const r of rows) followed.add(r.target_id);
    const peers = dmPeers ? await dmPeers(viewer, others) : new Set();
    const allowed = others.filter((s) => followed.has(s) || peers.has(s));
    const out = [];
    if (self) {
        const own = await viewOf(db, viewer, { nowMs, streaming: streaming.has(viewer), self: true });
        if (own.view) out.push(own.view);
    }
    if (allowed.length) {
        const found = await db.prepare('SELECT * FROM person_presence WHERE subject_id = ANY(?)').all(allowed);
        for (const row of found) {
            // An invisible person (or one with show_status off) is never disclosed, not even as offline.
            if (!Number(row.show_status) || row.state === 'invisible') continue;
            out.push(publicView(row, { nowMs, streaming: streaming.has(row.subject_id), self: false }));
        }
    }
    return out;
}

/** "usr_…,usr_…" or repeated ?subjects=; at most 100, deduplicated. */
function parseSubjects(input) {
    const raw = Array.isArray(input) ? input.join(',') : String(input == null ? '' : input);
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > MAX_SUBJECTS) throw new PresenceError(400, 'presence.too_many', `at most ${MAX_SUBJECTS} subjects`);
    for (const s of list) if (!SUBJECT_RE.test(s)) throw new PresenceError(400, 'presence.bad_subject', `${s.slice(0, 40)} is not a person subject`);
    return [...new Set(list)];
}

/** Default live set: Live's public list over loopback, mapped to Network subjects, cached 30 s. */
function createLiveSource({ db, config, fetchImpl, now }) {
    let cache = { at: 0, value: new Set() };
    return async function streamingSubjects() {
        const t = now();
        if (t - cache.at < LIVE_TTL_MS) return cache.value;
        const base = String((config.services && config.services.live && config.services.live.internalUrl) || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        try {
            const res = await fetchImpl(`${base}/api/streams`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2000) });
            if (!res.ok) return cache.value;
            const body = await res.json();
            const liveIds = [...new Set((Array.isArray(body.streams) ? body.streams : []).filter((s) => s && s.is_live && s.user_id != null).map((s) => String(s.user_id)))];
            const subjects = liveIds.length
                ? new Set((await db.prepare(`SELECT subject_id FROM identity_legacy_map WHERE source_system = 'live' AND source_type = 'user' AND source_id = ANY(?)`).all(liveIds)).map((r) => r.subject_id))
                : new Set();
            cache = { at: t, value: subjects };
            return subjects;
        } catch {
            // A Live that does not answer leaves the last good set in place; stale for 30 s at most is no leak.
            return cache.value;
        }
    };
}

/** Default DM peers: ask Chat which candidates share a conversation with the viewer, cached 30 s. */
function createDmPeers({ selfToken, config, fetchImpl, now }) {
    const cache = new Map();
    return async function dmPeers(viewer, candidates) {
        const key = `${viewer}|${candidates.slice().sort().join(',')}`;
        const hit = cache.get(key);
        if (hit && now() - hit.at < DM_TTL_MS) return hit.value;
        const value = new Set();
        try {
            const token = selfToken && selfToken('openvibe.chat', ['chat.dm.peers.read']);
            if (token) {
                const base = String((config.services && config.services.chat && config.services.chat.internalUrl) || 'http://127.0.0.1:4400').replace(/\/+$/, '');
                const res = await fetchImpl(`${base}/internal/chat/dm/peers`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ subject: viewer, candidates }),
                    signal: AbortSignal.timeout(1500),
                });
                if (res.ok) {
                    const body = await res.json().catch(() => ({}));
                    for (const p of Array.isArray(body.peers) ? body.peers : []) if (candidates.includes(p)) value.add(p);
                }
            }
        } catch { /* Chat down: follows only, never a stranger */ }
        if (cache.size > 1000) cache.clear();
        cache.set(key, { at: now(), value });
        return value;
    };
}

/**
 * The presence routers and its flusher.
 *   me        POST /heartbeat, PUT /          (mount after requireAuth)
 *   pub       GET /                          (mount after requireAuth)
 *   internal  GET /                          (mount after guard('network.presence.read'))
 */
function createPresence({ db, requireAuth, guard, selfToken, config = {}, fetchImpl = globalThis.fetch, now = Date.now, log = console }) {
    const streamingSubjects = createLiveSource({ db, config, fetchImpl, now });
    const dmPeers = createDmPeers({ selfToken, config, fetchImpl, now });

    async function flushDue(nowMs = now()) {
        const due = await db.prepare("SELECT * FROM person_presence WHERE pending_since IS NOT NULL AND pending_since <= ? ORDER BY pending_since LIMIT 200")
            .all(iso(nowMs - DEBOUNCE_MS));
        if (!due.length) return 0;
        const streaming = await streamingSubjects();
        let sent = 0;
        for (const candidate of due) {
            await db.tx(async () => {
                const row = await db.prepare('SELECT * FROM person_presence WHERE subject_id = ?').get(candidate.subject_id);
                if (!row || !row.pending_since) return;
                const view = publicView(row, { nowMs, streaming: streaming.has(row.subject_id), self: false });
                if (await announce(db, row, view, nowMs)) sent++;
            });
        }
        return sent;
    }

    function start({ intervalMs = 15_000 } = {}) {
        const timer = setInterval(() => flushDue().catch((err) => log.warn('[Presence] flush failed:', err.message)), intervalMs);
        if (timer.unref) timer.unref();
        return timer;
    }

    const me = require('express').Router();
    me.post('/heartbeat', async (req, res) => {
        if (!req.user || !req.user.subject_id) return res.status(401).json({ error: 'token.missing', detail: 'a signed-in person is required' });
        const idle = !!(req.body && req.body.idle);
        try {
            res.set('Cache-Control', 'no-store');
            const streaming = (await streamingSubjects()).has(req.user.subject_id);
            return res.json(await heartbeat(db, req.user.subject_id, { idle, nowMs: now(), streaming }));
        } catch (err) {
            if (err instanceof PresenceError) return res.status(err.status).json({ error: err.code, detail: err.detail });
            throw err;
        }
    });
    me.put('/', async (req, res) => {
        if (!req.user || !req.user.subject_id) return res.status(401).json({ error: 'token.missing', detail: 'a signed-in person is required' });
        try {
            res.set('Cache-Control', 'no-store');
            const streaming = (await streamingSubjects()).has(req.user.subject_id);
            return res.json(await update(db, req.user.subject_id, req.body, { nowMs: now(), streaming }));
        } catch (err) {
            if (err instanceof PresenceError) return res.status(err.status).json({ error: err.code, detail: err.detail });
            throw err;
        }
    });

    const pub = require('express').Router();
    pub.get('/', async (req, res) => {
        if (!req.user || !req.user.subject_id) return res.status(401).json({ error: 'token.missing', detail: 'a signed-in person is required' });
        try {
            const subjects = parseSubjects(req.query.subjects);
            res.set('Cache-Control', 'private, max-age=15');
            return res.json({ presence: await visiblePresence(db, req.user.subject_id, subjects, { nowMs: now(), streaming: await streamingSubjects(), dmPeers }) });
        } catch (err) {
            if (err instanceof PresenceError) return res.status(err.status).json({ error: err.code, detail: err.detail });
            throw err;
        }
    });

    const internal = require('express').Router();
    internal.get('/', async (req, res) => {
        const viewer = String(req.query.for || '');
        if (!SUBJECT_RE.test(viewer)) return res.status(400).json({ error: 'presence.bad_for', detail: 'for must be a person subject' });
        try {
            const subjects = parseSubjects(req.query.subjects);
            res.set('Cache-Control', 'private, max-age=15');
            return res.json({ presence: await visiblePresence(db, viewer, subjects, { nowMs: now(), streaming: await streamingSubjects(), dmPeers }) });
        } catch (err) {
            if (err instanceof PresenceError) return res.status(err.status).json({ error: err.code, detail: err.detail });
            throw err;
        }
    });

    return { me, pub, internal, flushDue, start, streamingSubjects, dmPeers, heartbeat, update, visiblePresence, parseSubjects, publicView };
}

module.exports = {
    createPresence, PresenceError, publicView, parseSubjects, heartbeat, update, visiblePresence,
    SUBJECT_RE, HEARTBEAT_ONLINE_MS, OFFLINE_MS, AWAY_MS, DEBOUNCE_MS, MAX_SUBJECTS,
};
