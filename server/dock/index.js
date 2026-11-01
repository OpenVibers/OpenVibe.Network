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
 *
 * The timer (plan L48 R2; Contracts 0.271.0 for the field, 0.272.0 for the capability) has a second door, for a
 * first-party service and not for a person:
 *
 *   PUT /api/v1/people/:subject/dock/timer   network.dock.timer.write: set or clear ONE person's timer
 *
 * OpenVibe.Chat's Vibe starts the person's focus timer where they are ("Vibe, start a 25-minute focus timer"), and
 * it counts down in the Dock's pill on every OpenVibe site. The service names the person and writes the timer and
 * nothing else: every other field of the state is left as it was. The service token must hold
 * network.dock.timer.write (granted to Chat alone), and a person's own token never opens this route.
 */
const express = require('express');
const { validate, http, serviceAuth, capabilities } = require('openvibe-contracts');
const store = require('../developer/store');

const CONTRACT = 'network.dock-state@1';
const WRITE_LIMIT = 60;
const WRITE_WINDOW_MS = 60_000;
// The capability the timer route asks for (Contracts 0.272.0), the body it takes, and the audience the service
// token is for.
const SERVICE_CAPABILITY = 'network.dock.timer.write';
const REQUEST_CONTRACT = 'network.dock-timer-request@1';
const SELF_AUDIENCE = 'openvibe.network';
// A person's canonical subject, the only thing the timer route accepts as a person.
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
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
 * The timer a service asks for (network.dock-timer-request@1, Contracts 0.272.0): how long it runs, or that it stops.
 *
 * The body is checked against that contract: { minutes } (1 to 180) starts a timer, { clear: true } stops it, and
 * `kind`, `label` and `rounds` say what kind of timer it is. A key the contract does not know is refused, not
 * ignored. The timer that comes out of it is checked again against network.dock-state@1, with the rest of the
 * person's state, before anything is stored.
 *
 * → { error, errors } when the body is not one, or null when it is.
 */
function badTimer(body) {
    if (!isObject(body)) {
        return { error: 'the body must say how long the timer runs, or that it stops', errors: [] };
    }
    const check = validate(REQUEST_CONTRACT, body);
    if (check.valid) return null;
    const first = (check.errors || [])[0];
    const field = String((first && first.instancePath) || '').replace(/^\//, '').replace(/\//g, '.');
    return {
        error: field ? `${field}: ${first.message}` : String((first && first.message) || 'that is not a timer'),
        errors: check.errors,
    };
}

/**
 * The timer object, exactly the one the Dock itself writes (openvibe-shared/dock-timer.js start()): the Dock reads
 * what Vibe writes, so the shape is the same down to the field names. A plain timer carries its kind, its start and
 * its end; a focus block also carries the round it is in, how many rounds there are, and the length of a round and
 * of the break after it (so it alternates by itself).
 */
function timerOf(body, at) {
    if (body.clear === true) return null;
    const minutes = Number(body.minutes);
    const kind = body.kind === 'focus' ? 'focus' : 'timer';
    const timer = { kind, started_at: new Date(at).toISOString(), ends_at: new Date(at + minutes * 60000).toISOString() };
    if (body.label) timer.label = String(body.label).slice(0, 60);
    if (kind === 'focus') Object.assign(timer, { round: 1, rounds: Number(body.rounds) || 4, focus_min: minutes, break_min: 5 });
    return timer;
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

    /**
     * Set or clear the person's Dock timer. Only the timer changes: every other field of the state stays as it was,
     * and the whole state is checked against network.dock-state@1 before it is stored, like any other write.
     * → network.dock-result@1
     */
    async function writeTimer(actor, body, { ctx = null } = {}) {
        const at = now();
        if (!mayWrite(actor.subject, at)) {
            throw Object.assign(new Error('too many writes; wait a minute'), { status: 429, code: 'dock.rate_limited' });
        }
        const bad = badTimer(body);
        if (bad) throw Object.assign(new Error(bad.error), { status: 422, code: 'dock.invalid', errors: bad.errors });
        const current = await stateOf(actor, at);
        const merged = { ...current, timer: timerOf(body, at), updated_at: new Date(at).toISOString() };
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

    return { read, write, writeTimer, stateOf, defaultState, _writes: writes };
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

/**
 * The guard for the timer's service route: a first-party service token (Network's own issuer signed it) holding
 * network.dock.timer.write.
 *
 * A person's own token never opens this route: the token is checked as a service token, and a session token is not
 * one. A service without the grant is refused, and so is an app, an agent or a module: only a first-party service
 * (svc:chat) may act for a person here, which is why the grant is given to Chat alone.
 *
 * The capability is checked against the contracts' registry (network.dock.timer.write, Contracts 0.272.0), so a
 * retired or unknown id is refused like everywhere else on the network.
 */
function serviceGuard() {
    return function dockServiceGuard(req, res, next) {
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Bearer ')) {
            return http.sendProblem(res, 401, 'token.required', { detail: 'a service token is needed here, not a person\'s', ctx: req.ov });
        }
        const publicKey = req.app.locals.publicKey;
        const issuer = req.app.locals.config && req.app.locals.config.jwt && req.app.locals.config.jwt.issuer;
        const r = serviceAuth.verifyServiceToken(auth.slice(7).trim(), { publicKey, issuer, audience: SELF_AUDIENCE });
        if (!r.ok) return http.sendProblem(res, 401, r.code || 'token.invalid', { detail: r.reason, ctx: req.ov });
        const sub = String(r.claims.sub || '');
        if (r.claims.actor_type !== 'service' || !/^svc:[a-z0-9-]{1,39}$/.test(sub)) {
            return http.sendProblem(res, 403, 'capability.owner_denied', { detail: 'only a first-party service may set a person\'s Dock timer', ctx: req.ov });
        }
        const c = capabilities.check(r.claims, SERVICE_CAPABILITY);
        if (!c.allowed) return http.sendProblem(res, 403, c.code || 'capability.denied', { detail: c.reason, ctx: req.ov });
        req.principal = { sub, cap: r.claims.cap, jti: r.claims.jti };
        return next();
    };
}

/**
 * The timer's service route: PUT /api/v1/people/:subject/dock/timer. The router is mounted at /api/v1/people (the
 * person is in the path, so the route carries it itself: a mount path's parameters are not passed on to a router).
 *
 * The person is the one in the path, and the service names them: when the request carries X-OV-Subject as well, it
 * must be the same person. The service writes the timer and nothing else.
 */
function serviceRouter({ dock }) {
    const r = express.Router();
    r.use(http.middleware());
    r.use(express.json({ limit: '4kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    r.put('/:subject/dock/timer', serviceGuard(), async (req, res) => {
        try {
            const subject = String(req.params.subject || '');
            if (!SUBJECT_RE.test(subject)) {
                return http.sendProblem(res, 400, 'dock.subject_required', { detail: 'name the person: usr_…', ctx: req.ov });
            }
            const named = String(req.headers['x-ov-subject'] || '');
            if (named && named !== subject) {
                return http.sendProblem(res, 403, 'dock.subject_mismatch', { detail: 'X-OV-Subject names another person', ctx: req.ov });
            }
            const db = req.app.locals.db;
            const user = await db.prepare('SELECT id, subject_id FROM users WHERE subject_id = ?').get(subject);
            if (!user) {
                return http.sendProblem(res, 404, 'identity.subject_not_found', { detail: 'no such person', ctx: req.ov });
            }
            const actor = { subject, user: { id: user.id } };
            res.json(await dock.writeTimer(actor, req.body, { ctx: req.ov }));
        } catch (err) {
            if (err && err.status) {
                return http.sendProblem(res, err.status, err.code || 'dock.error', { detail: err.message, errors: err.errors, ctx: req.ov });
            }
            console.error('[Dock] timer:', err);
            http.sendProblem(res, 500, 'dock.error', { detail: 'could not set the timer', ctx: req.ov });
        }
    });
    return r;
}

module.exports = { createDock, router, serviceRouter, serviceGuard, defaultState, mergeState, badTimer, timerOf, CONTRACT, WRITE_LIMIT, WRITE_WINDOW_MS, CORNERS, SERVICE_CAPABILITY };
