'use strict';
/**
 * The Dock's state (the Dock plan 2026-10-30, K-D1; Contracts 0.251.0): the little floating surface every OpenVibe
 * site draws — your agent, your chats, your activity. It is drawn on many domains and localStorage is per site, so
 * the state it follows you with lives here, in the Network.
 *
 *   GET /api/v1/me/dock    network.dock-result@1: the state, the counts, and whether those counts are complete
 *   PUT /api/v1/me/dock    network.dock-result@1: a partial body (any subset of the state's fields) merged into it
 *
 * The subject comes from the caller's token and from nowhere else, so one person never reads or writes another's
 * state. The counts come from the Action Center's aggregator (server/actions/index.js forPerson, which keeps its
 * answer for 10 s, so a page view never fans out more than that) and from the notification service's unread count.
 *
 * A write is limited to 60 a minute per person: the page debounces anyway, and a runaway tab must not fill the
 * table. Every write is validated against network.dock-state@1 before it is stored, so a page can never leave a
 * half-formed state behind for the next page to read.
 */
const express = require('express');
const { validate, http } = require('openvibe-contracts');
const store = require('../developer/store');

const CONTRACT = 'network.dock-state@1';
const WRITE_LIMIT = 60;
const WRITE_WINDOW_MS = 60_000;
// The state a person has before they ever open the Dock: closed, on the activity tab, not pinned, bottom-right,
// and the site's own size.
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The default state, for a person who has never opened the Dock. */
function defaultState(at) {
    return {
        open: false, tab: 'activity', pinned: false, agent: null, chat: null,
        place: { phone: { corner: 'bottom-right' }, desktop: { corner: 'bottom-right', width: null, height: null } },
        updated_at: new Date(at).toISOString(),
    };
}

/**
 * Merge a partial body into the current state.
 *
 * `open`, `tab`, `pinned` and `chat` are replaced; `agent` is replaced whole (null clears it); `place` is merged
 * per device class, so a body that names only `place.phone` leaves the desktop where it was. A key the contract
 * does not know is carried into the result rather than dropped, so validation refuses the body instead of quietly
 * accepting it.
 */
function mergeState(current, patch) {
    const out = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'place' && isObject(value)) {
            const place = { ...(isObject(current.place) ? current.place : {}) };
            for (const [cls, v] of Object.entries(value)) {
                place[cls] = (cls === 'phone' || cls === 'desktop') && isObject(v)
                    ? { ...(isObject(place[cls]) ? place[cls] : {}), ...v }
                    : v;
            }
            out.place = place;
        } else {
            out[key] = value;
        }
    }
    return out;
}

/**
 * The Dock for one person.
 *   db           the Network database
 *   actions      the Action Center's aggregator ({ forPerson(actor) }) — the running and waiting counts
 *   notifications the notification service ({ getUnreadCount(userId) }) — the unread count
 */
function createDock({ db, actions = null, notifications = null, now = () => Date.now(), writeLimit = WRITE_LIMIT, writeWindowMs = WRITE_WINDOW_MS, log = console } = {}) {
    if (!db) throw new TypeError('createDock: db is required');
    const writes = new Map();

    /** The person's stored state, or the default. */
    async function stateOf(actor, at) {
        const row = await db.prepare('SELECT state FROM dock_states WHERE subject = ?').get(actor.subject);
        if (!row) return defaultState(at);
        let state = row.state;
        if (typeof state === 'string') { try { state = JSON.parse(state); } catch { state = null; } }
        // A row written by an older release (or by hand) is still shown, but only if it is a state the contract
        // accepts: a broken row falls back to the default rather than breaking the page that reads it.
        return state && validate(CONTRACT, state).valid ? state : defaultState(at);
    }

    /** The counts the pill's status dot is drawn from. */
    async function countsOf(actor) {
        let running = 0;
        let waiting = 0;
        let partial = false;
        if (actions && typeof actions.forPerson === 'function') {
            try {
                const doc = await actions.forPerson(actor);
                running = Number(doc && doc.counts && doc.counts.running) || 0;
                waiting = Number(doc && doc.counts && doc.counts.waiting) || 0;
                partial = !!(doc && doc.partial);
            } catch (err) {
                partial = true;
                log.warn('[Dock] the Action Center did not answer:', err.message);
            }
        } else {
            partial = true;
        }
        let unread = 0;
        if (notifications && typeof notifications.getUnreadCount === 'function') {
            try {
                unread = Number(await notifications.getUnreadCount(actor.user.id)) || 0;
            } catch (err) {
                partial = true;
                log.warn('[Dock] the unread count did not answer:', err.message);
            }
        } else {
            partial = true;
        }
        return { counts: { running, waiting, unread }, sources_partial: partial };
    }

    /** network.dock-result@1 for one person. */
    async function read(actor) {
        const at = now();
        const state = await stateOf(actor, at);
        const { counts, sources_partial: partial } = await countsOf(actor);
        return { state, counts, sources_partial: partial };
    }

    /** 60 writes a minute, per person. */
    function mayWrite(subject, at) {
        const kept = (writes.get(subject) || []).filter((t) => at - t < writeWindowMs);
        if (kept.length >= writeLimit) { writes.set(subject, kept); return false; }
        kept.push(at);
        writes.set(subject, kept);
        if (writes.size > 5000) writes.delete(writes.keys().next().value);
        return true;
    }

    /** Merge a partial body into the person's state and store it. → network.dock-result@1 */
    async function write(actor, body, { ctx = null } = {}) {
        const at = now();
        if (!mayWrite(actor.subject, at)) {
            throw Object.assign(new Error('too many writes; wait a minute'), { status: 429, code: 'dock.rate_limited' });
        }
        if (!isObject(body)) {
            throw Object.assign(new Error('the body must be the state to change'), { status: 422, code: 'dock.invalid' });
        }
        const current = await stateOf(actor, at);
        const merged = { ...mergeState(current, body), updated_at: new Date(at).toISOString() };
        const check = validate(CONTRACT, merged);
        if (!check.valid) {
            throw Object.assign(new Error('that is not a Dock state'), { status: 422, code: 'dock.invalid', errors: check.errors });
        }
        await db.prepare(`INSERT INTO dock_states (subject, state, updated_at) VALUES (?, ?, now())
                          ON CONFLICT (subject) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
            .run(actor.subject, JSON.stringify(merged));
        const { counts, sources_partial: partial } = await countsOf(actor);
        return { state: merged, counts, sources_partial: partial };
    }

    return { read, write, stateOf, defaultState, _writes: writes };
}

/** The routes, behind Network's session check (the cookie on openvibe.network, a Bearer token elsewhere), like the bell's. */
function router({ dock, requireAuth }) {
    const r = express.Router();
    r.use(http.middleware());
    r.use(express.json({ limit: '8kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    r.get('/', requireAuth, async (req, res) => {
        try {
            const actor = await store.actorOf(req.app.locals.db, req.user);
            res.json(await dock.read(actor));
        } catch (err) {
            if (err && err.status) return http.sendProblem(res, err.status, err.code || 'dock.error', { detail: err.message, ctx: req.ov });
            console.error('[Dock] read:', err);
            http.sendProblem(res, 500, 'dock.error', { detail: 'could not read your Dock', ctx: req.ov });
        }
    });
    r.put('/', requireAuth, async (req, res) => {
        try {
            const actor = await store.actorOf(req.app.locals.db, req.user);
            res.json(await dock.write(actor, req.body, { ctx: req.ov }));
        } catch (err) {
            if (err && err.status) {
                return http.sendProblem(res, err.status, err.code || 'dock.error', { detail: err.message, errors: err.errors, ctx: req.ov });
            }
            console.error('[Dock] write:', err);
            http.sendProblem(res, 500, 'dock.error', { detail: 'could not save your Dock', ctx: req.ov });
        }
    });
    return r;
}

module.exports = { createDock, router, defaultState, mergeState, CONTRACT, WRITE_LIMIT, WRITE_WINDOW_MS, CORNERS };
