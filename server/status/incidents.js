'use strict';
/**
 * Incidents and maintenance windows on the public status page (roadmap WS-N task 12; Contracts 0.66.0
 * network.status-incident@1, network.status-incident-list@1, network.status-incident-request@1,
 * capability network.status.incident).
 *
 *   GET  /api/v1/status/incidents               public: { active, recent } (recent = closed in the last 30 days)
 *   POST /api/v1/status/incidents               open one        } staff admins (session), or a service token with
 *   POST /api/v1/status/incidents/:id/updates   add an update   } network.status.incident (the Host principal:
 *                                                                 ovhost incident / ovhost maintenance)
 *
 * An incident moves investigating → identified → monitoring → resolved; a maintenance window
 * scheduled → in_progress → completed. Each update keeps its message; the newest state is the incident's,
 * and resolved / completed close it (further updates are refused). Messages are plain text for people.
 * /status shows the active ones at the top (server/status/routes.js).
 */
const express = require('express');
const { ids, validate, http } = require('openvibe-contracts');

const INCIDENT_STATES = ['investigating', 'identified', 'monitoring', 'resolved'];
const MAINTENANCE_STATES = ['scheduled', 'in_progress', 'completed'];
const CLOSED = new Set(['resolved', 'completed']);
const RECENT_DAYS = 30;

class IncidentError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

const statesOf = (kind) => (kind === 'maintenance' ? MAINTENANCE_STATES : INCIDENT_STATES);

async function present(db, row) {
    if (!row) return null;
    const out = {
        id: row.id, kind: row.kind, title: row.title, ...(row.severity ? { severity: row.severity } : {}), state: row.state,
        services: JSON.parse(row.services || '[]'), starts_at: row.starts_at, ends_at: row.ends_at || null,
        updates: await db.prepare('SELECT at, state, message FROM status_incident_updates WHERE incident_id = ? ORDER BY at, seq').all(row.id),
        created_at: row.created_at, updated_at: row.updated_at,
    };
    return out;
}

async function get(db, id) { ensureSchema(db); return await present(db, await db.prepare('SELECT * FROM status_incidents WHERE id = ?').get(String(id))); }

/** Active: open incidents, and maintenance windows not completed. Recent: closed within 30 days. */
async function list(db, { now = Date.now() } = {}) {
    ensureSchema(db);
    const since = new Date(now - RECENT_DAYS * 86400000).toISOString();
    const active = (await Promise.all((await db.prepare("SELECT * FROM status_incidents WHERE state NOT IN ('resolved', 'completed') ORDER BY starts_at DESC").all()).map(async (r) => await present(db, r))));
    const recent = (await Promise.all((await db.prepare("SELECT * FROM status_incidents WHERE state IN ('resolved', 'completed') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 50").all(since)).map(async (r) => await present(db, r))));
    return { active, recent };
}

function check(schema, body) {
    const v = validate(schema, body);
    if (!v.valid) throw new IncidentError(400, 'status.invalid_request', `the body does not match ${schema}: ${JSON.stringify(v.errors || []).slice(0, 300)}`);
}

/** Open an incident or maintenance window (body: network.status-incident-request@1, the open form). */
async function open(db, body, author, { now = new Date().toISOString() } = {}) {
    ensureSchema(db);
    check('network.status-incident-request@1', body);
    if (!body.kind) throw new IncidentError(400, 'status.invalid_request', 'kind, title, services and message open an incident');
    const kind = body.kind;
    const state = body.state || (kind === 'maintenance' ? 'scheduled' : 'investigating');
    if (!statesOf(kind).includes(state)) throw new IncidentError(400, 'status.invalid_state', `a ${kind} starts in one of ${statesOf(kind).filter((s) => !CLOSED.has(s)).join(', ')}`);
    if (kind === 'maintenance' && body.severity) throw new IncidentError(400, 'status.invalid_request', 'maintenance has no severity');
    const id = `inc_${ids.ulid(Date.parse(now) || Date.now())}`;
    const startsAt = body.starts_at ? new Date(body.starts_at).toISOString() : now;
    const endsAt = body.ends_at ? new Date(body.ends_at).toISOString() : null;
    if (endsAt && endsAt < startsAt) throw new IncidentError(400, 'status.invalid_window', 'ends_at is before starts_at');
    await db.tx(async () => {
        await db.prepare(`INSERT INTO status_incidents (id, kind, title, severity, state, services, starts_at, ends_at, created_by, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, kind, body.title.trim(), kind === 'incident' ? (body.severity || 'minor') : null, state,
            JSON.stringify([...new Set(body.services)]), startsAt, endsAt, author, now, now);
        await db.prepare('INSERT INTO status_incident_updates (incident_id, at, state, message, author) VALUES (?, ?, ?, ?, ?)').run(id, now, state, body.message.trim(), author);
    });
    return await get(db, id);
}

/** Add an update (body: the update form): a new state and message; ends_at for a window. Closed ones refuse. */
async function update(db, id, body, author, { now = new Date().toISOString() } = {}) {
    ensureSchema(db);
    check('network.status-incident-request@1', body);
    if (!body.state || body.kind) throw new IncidentError(400, 'status.invalid_request', 'an update is { state, message, ends_at? }');
    const row = await db.prepare('SELECT * FROM status_incidents WHERE id = ?').get(String(id));
    if (!row) throw new IncidentError(404, 'status.incident_not_found', 'no such incident');
    if (CLOSED.has(row.state)) throw new IncidentError(409, 'status.incident_closed', `this ${row.kind} is ${row.state}`);
    if (!statesOf(row.kind).includes(body.state)) throw new IncidentError(400, 'status.invalid_state', `a ${row.kind} is one of ${statesOf(row.kind).join(', ')}`);
    const endsAt = body.ends_at ? new Date(body.ends_at).toISOString() : (CLOSED.has(body.state) ? now : row.ends_at);
    await db.tx(async () => {
        await db.prepare('UPDATE status_incidents SET state = ?, ends_at = ?, updated_at = ? WHERE id = ?').run(body.state, endsAt, now, row.id);
        await db.prepare('INSERT INTO status_incident_updates (incident_id, at, state, message, author) VALUES (?, ?, ?, ?, ?)').run(row.id, now, body.state, body.message.trim(), author);
    });
    return await get(db, row.id);
}

/**
 * Routes. Writers: a staff admin's session (requireAuth + role admin), or a service token holding
 * network.status.incident (incidentGuard, service tokens only).
 */
function router({ requireAuth, incidentGuard }) {
    const r = express.Router();
    r.use(http.middleware());
    r.get('/', async (req, res) => {
        res.set('Cache-Control', 'public, max-age=30').json(await list(req.app.locals.db));
    });
    const writer = async (req, res, next) => {
        const h = String(req.headers.authorization || '');
        const token = h.startsWith('Bearer ') ? h.slice(7) : (req.cookies && req.cookies.ov_token);
        let user = null;
        if (token) {
            try { const out = await require('../auth/session').verifySession(token, { db: req.app.locals.db, publicKey: req.app.locals.publicKey, config: req.app.locals.config }); user = out && out.user; } catch { user = null; }
        }
        if (user) {
            if (user.role !== 'admin') return http.sendProblem(res, 403, 'status.staff_only', { detail: 'only staff admins post incidents', ctx: req.ov });
            req.statusAuthor = `user:${user.username}`;
            return requireAuth(req, res, next);
        }
        return incidentGuard(req, res, () => { req.statusAuthor = req.principal ? String(req.principal.sub) : 'service'; next(); });
    };
    const send = async (res, req, fn, status = 200) => {
        res.set('Cache-Control', 'no-store');
        try { res.status(status).json(await fn()); } catch (err) {
            if (err instanceof IncidentError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            console.error('[Status incidents]', err.message);
            return http.sendProblem(res, 500, 'status.failed', { detail: 'the incident could not be saved', ctx: req.ov });
        }
    };
    r.post('/', express.json({ limit: '16kb' }), writer, async (req, res) => await send(res, req, async () => await open(req.app.locals.db, req.body || {}, req.statusAuthor), 201));
    r.post('/:id/updates', express.json({ limit: '16kb' }), writer, async (req, res) => await send(res, req, async () => await update(req.app.locals.db, req.params.id, req.body || {}, req.statusAuthor)));
    return r;
}

module.exports = { ensureSchema, open, update, list, get, router, IncidentError, INCIDENT_STATES, MAINTENANCE_STATES };
