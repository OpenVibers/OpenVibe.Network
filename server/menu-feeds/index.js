'use strict';
/**
 * The OpenVibe menu's "Choose your feeds" (2026-11-07): the sites' menu cards a person chose to show, in their
 * order, so the menu shows the same feeds on every OpenVibe site. localStorage is per site, so the choice follows
 * the person here, in the Network.
 *
 *   GET /api/v1/me/menu-feeds   network.menu-feeds@2: { order, off, updated_at }
 *   PUT /api/v1/me/menu-feeds   v2 { order, off } or legacy v1 { on }; answers v2
 *
 * The person comes from the token and nowhere else, so one person never reads or writes another's choice. The body
 * is checked against the matching contract before anything is stored, and a
 * body the contract refuses is a 400 with the field and the fault in `detail` — never a quietly changed choice.
 * A write is limited to 60 a minute per person, like the Dock's, so a runaway tab cannot fill the row.
 *
 * The column, not a table: the choice belongs in the preferences row the person already has, and an account's
 * export and erasure already carry that row (migrations/0048_menu_feeds.sql, expand-only).
 */
const express = require('express');
const { validate } = require('openvibe-contracts');

const CONTRACT = 'network.menu-feeds@2';
const LEGACY = 'network.menu-feeds@1';
const WRITE_LIMIT = 60;
const WRITE_WINDOW_MS = 60_000;
// The two fields a PUT body may carry. `updated_at` is the server's to set; a client that echoes it back is
// accepted, but it never chooses the time.
const BODY_FIELDS = new Set(['on', 'order', 'off', 'updated_at']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The first fault in a contract result, as `field: message`, for the 400's detail. */
function firstFault(errors) {
    const first = (errors || [])[0];
    if (!first) return 'not a menu-feeds choice';
    const field = String(first.path || first.instancePath || '').replace(/^\//, '').replace(/\//g, '.');
    return field ? `${field}: ${first.message}` : String(first.message || 'not a menu-feeds choice');
}

/** A value the contract accepts, or null when it does not. */
function checked(value) {
    const r = validate(CONTRACT, value);
    return r.valid ? null : (r.errors || []);
}

/**
 * The menu-feeds choice for one person.
 *   db   the Network database
 *   now  the clock, injectable for the tests
 */
function createMenuFeeds({ db, now = () => Date.now(), writeLimit = WRITE_LIMIT, writeWindowMs = WRITE_WINDOW_MS, log = console } = {}) {
    if (!db) throw new TypeError('createMenuFeeds: db is required');
    const writes = new Map();

    /** The stored v2 choice, or an empty default-on choice when there is none. */
    async function read(userId) {
        const row = await db.prepare('SELECT menu_feeds FROM user_preferences WHERE user_id = ?').get(userId);
        let value = row && row.menu_feeds;
        if (typeof value === 'string') {
            try { value = JSON.parse(value); } catch { value = null; }
        }
        // A row written by an older release (or by hand) is shown only when the contract accepts it; anything else
        // reads as "never set" rather than as a choice the menu cannot draw.
        if (isObject(value) && Array.isArray(value.on)) value = { order: value.on, off: [], updated_at: value.updated_at || null };
        if (!isObject(value) || checked(value)) {
            if (row && row.menu_feeds != null) log.warn(`[MenuFeeds] user ${userId} has a choice the contract refuses; showing none`);
            return { order: [], off: [], updated_at: null };
        }
        return { order: value.order, off: value.off, updated_at: value.updated_at };
    }

    /** 60 writes a minute, per person. */
    function mayWrite(userId, at) {
        const kept = (writes.get(userId) || []).filter((t) => at - t < writeWindowMs);
        if (kept.length >= writeLimit) { writes.set(userId, kept); return false; }
        kept.push(at);
        writes.set(userId, kept);
        if (writes.size > 5000) writes.delete(writes.keys().next().value);
        return true;
    }

    /** Replace the person's choice and store it. → network.menu-feeds@2 */
    async function write(userId, body, { ctx = null } = {}) {
        const at = now();
        if (!mayWrite(userId, at)) {
            throw Object.assign(new Error('too many writes; wait a minute'), { status: 429, code: 'menu-feeds.rate_limited' });
        }
        if (!isObject(body)) {
            throw Object.assign(new Error('the body must be { on: [\'<site>:<cardId>\', …] }'), { status: 400, code: 'menu-feeds.invalid' });
        }
        const unknown = Object.keys(body).find((k) => !BODY_FIELDS.has(k));
        if (unknown) {
            throw Object.assign(new Error(`${unknown}: is not part of a menu-feeds choice`), { status: 400, code: 'menu-feeds.invalid' });
        }
        const legacy = Object.hasOwn(body, 'on');
        if (legacy && (Object.hasOwn(body, 'order') || Object.hasOwn(body, 'off'))) {
            throw Object.assign(new Error('on cannot be combined with order or off'), { status: 400, code: 'menu-feeds.invalid' });
        }
        const value = legacy ? { order: body.on, off: [], updated_at: new Date(at).toISOString() }
            : { order: body.order, off: body.off, updated_at: new Date(at).toISOString() };
        if (legacy && !validate(LEGACY, { on: body.on, updated_at: value.updated_at }).valid) {
            throw Object.assign(new Error('on: invalid v1 choice'), { status: 400, code: 'menu-feeds.invalid' });
        }
        const errors = checked(value);
        if (errors) {
            throw Object.assign(new Error(firstFault(errors)), { status: 400, code: 'menu-feeds.invalid', errors });
        }
        await db.prepare(`INSERT INTO user_preferences (user_id, menu_feeds, updated_at) VALUES (?, ?, ov_now())
                          ON CONFLICT (user_id) DO UPDATE SET menu_feeds = excluded.menu_feeds, updated_at = ov_now()`)
            .run(userId, JSON.stringify(value));
        return value;
    }

    return { read, write, _writes: writes };
}

/** The routes, behind Network's user-session check. */
function router({ menuFeeds, requireAuth }) {
    const r = express.Router();
    r.use(express.json({ limit: '2kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    const userIdOf = (req) => req.user.id ?? req.user.sub;
    r.get('/', requireAuth, async (req, res) => {
        try {
            res.json(await menuFeeds.read(userIdOf(req)));
        } catch (err) {
            console.error('[MenuFeeds] read:', err);
            res.status(500).json({ error: 'menu-feeds.error', detail: 'could not read your menu feeds' });
        }
    });
    r.put('/', requireAuth, async (req, res) => {
        try {
            res.json(await menuFeeds.write(userIdOf(req), req.body, { ctx: req.ov }));
        } catch (err) {
            if (err && err.status) return res.status(err.status).json({ error: err.code || 'menu-feeds.error', detail: err.message, ...(err.errors ? { errors: err.errors } : {}) });
            console.error('[MenuFeeds] write:', err);
            res.status(500).json({ error: 'menu-feeds.error', detail: 'could not save your menu feeds' });
        }
    });
    return r;
}

module.exports = { createMenuFeeds, router, CONTRACT, WRITE_LIMIT, WRITE_WINDOW_MS };
