'use strict';
const cache = require('openvibe-shared/cache-policy');
/**
 * Mod principals (roadmap WS-M task 3, ADR-013; Contracts 0.72.0 mods.grant.manage, network.mod-principal@1,
 * network.mod.grants_changed@1).
 *
 * A mod install is a principal, `mod:<mod_id>`, whose grants are the approved subset of the capabilities its
 * manifest requests. The runtime that installs it (OpenVibe.Games) registers it here and is its owner:
 *   POST /internal/mods                       { manifest, approve[], actor }: requested = the manifest's
 *                                             capabilities; approve (each requested) is approved, the rest pending.
 *                                             Registering again answers the existing principal.
 *   POST /internal/mods/:mod_id/grants        { capability, action: approve|revoke, actor }
 *   POST /internal/mods/:mod_id/revoke        { actor, reason }: the install ends; every grant is revoked for good
 *   GET  /internal/mods[?owner=]  /:mod_id    the owner's principals
 * all with a service token carrying mods.grant.manage; a service only changes the mods it registered.
 * Staff (staff.games.manage) do the same from /api/admin/mods, each change with a written reason and an audit row.
 * Every change bumps the revision and queues network.mod.grants_changed with the complete approved set, so the
 * runtime's own copy (its hot path) follows a change staff made here.
 */
const express = require('express');
const { validate, staff } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');
const idsLib = require('openvibe-contracts').ids;

const MOD_RE = /^mod_[0-9A-HJKMNP-TV-Z]{26}$/;
const CAP_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/;

class ModPrincipalError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

const iso = (ms) => new Date(ms).toISOString();

async function view(db, modId) {
    const p = await db.prepare('SELECT * FROM mod_principals WHERE mod_id = ?').get(modId);
    if (!p) return null;
    const grants = await db.prepare('SELECT capability, state FROM mod_principal_grants WHERE mod_id = ? ORDER BY capability').all(modId);
    const by = (s) => grants.filter((g) => g.state === s).map((g) => g.capability);
    const out = {
        principal: `mod:${p.mod_id}`, mod_id: p.mod_id, owner: p.owner, runtime: p.runtime, status: p.status,
        requested: grants.map((g) => g.capability), approved: by('approved'), pending: by('pending'), revoked: by('revoked'),
        revision: p.revision, updated_at: p.updated_at,
    };
    if (p.name) out.name = p.name;
    if (p.version) out.version = p.version;
    return out;
}

async function announce(db, v, change, by, reason) {
    const at = v.updated_at;
    const payload = { mod_id: v.mod_id, owner: v.owner, status: v.status, approved: v.approved, pending: v.pending, revision: v.revision, change, by };
    if (reason) payload.reason = String(reason).slice(0, 500);
    const env = {
        event_id: idsLib.newId('event', Date.parse(at)), event_type: 'network.mod.grants_changed', version: 1, source: 'network',
        actor: by === 'staff' ? { type: 'service', id: 'network' } : { type: 'service', id: v.owner }, timestamp: at, visibility: 'internal',
        subject: { type: 'mod', id: v.mod_id }, payload,
    };
    const ev = validate('events.event-envelope@1', env);
    const pv = validate('network.mod.grants_changed@1', payload);
    if (!ev.valid || !pv.valid) throw new Error(`mod-principals: bad event ${JSON.stringify((ev.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    return eventRelay.writerFor(db).enqueue(env);
}

function kick(db) { try { const live = eventRelay.outboxFor(db); if (live) live.kick(); } catch { /* the relay polls */ } }

/** Register an install's principal (idempotent). → { status: 201|200, body: network.mod-principal@1 } */
async function register(db, owner, body, { now = Date.now() } = {}) {
    ensureSchema(db);
    const v = validate('network.mod-install-request@1', body);
    if (!v.valid) throw new ModPrincipalError(400, 'mod.invalid_request', JSON.stringify(v.errors).slice(0, 300));
    const mv = validate('mods.mod-manifest@1', body.manifest);
    if (!mv.valid) throw new ModPrincipalError(422, 'mod.manifest_invalid', JSON.stringify(mv.errors).slice(0, 300));
    const m = body.manifest;
    const requested = [...new Set((m.permissions && m.permissions.capabilities) || [])].sort();
    const approve = [...new Set(body.approve || [])];
    const unrequested = approve.filter((c) => !requested.includes(c));
    if (unrequested.length) throw new ModPrincipalError(422, 'mod.not_requested', `not requested by the manifest: ${unrequested.join(', ')}`);
    const existing = await db.prepare('SELECT owner FROM mod_principals WHERE mod_id = ?').get(m.id);
    if (existing) {
        if (existing.owner !== owner) throw new ModPrincipalError(409, 'mod.other_owner', 'that mod is registered by another runtime');
        return { status: 200, body: await view(db, m.id) };
    }
    const at = iso(now);
    await db.tx(async () => {
        await db.prepare(`INSERT INTO mod_principals (mod_id, owner, runtime, name, version, publisher, manifest, created_at, created_by, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(m.id, owner, m.runtime, m.name || null, m.version || null, m.publisher && m.publisher.id ? String(m.publisher.id).slice(0, 80) : null,
                JSON.stringify(m), at, body.actor ? String(body.actor).slice(0, 80) : owner, at);
        const g = db.prepare('INSERT INTO mod_principal_grants (mod_id, capability, state, changed_at, changed_by) VALUES (?, ?, ?, ?, ?)');
        for (const c of requested) await g.run(m.id, c, approve.includes(c) ? 'approved' : 'pending', at, body.actor || owner);
        await announce(db, await view(db, m.id), { action: 'register' }, 'runtime');
    });
    kick(db);
    return { status: 201, body: await view(db, m.id) };
}

async function load(db, modId, owner) {
    ensureSchema(db);
    const p = MOD_RE.test(String(modId)) ? await db.prepare('SELECT * FROM mod_principals WHERE mod_id = ?').get(modId) : null;
    if (!p) throw new ModPrincipalError(404, 'mod.not_found', 'no such mod principal');
    if (owner && p.owner !== owner) throw new ModPrincipalError(403, 'mod.other_owner', 'that mod is registered by another runtime');
    return p;
}

/** Approve or revoke one capability. by: 'runtime' (owner given) or 'staff'. → network.mod-principal@1 */
async function change(db, modId, { capability, action, actor, reason }, { owner = null, by = 'runtime', now = Date.now() } = {}) {
    const v = validate('network.mod-grant-change@1', { capability, action, ...(actor ? { actor: String(actor).slice(0, 80) } : {}), ...(reason ? { reason: String(reason).slice(0, 500) } : {}) });
    if (!v.valid || !CAP_RE.test(String(capability))) throw new ModPrincipalError(400, 'mod.invalid_request', 'capability and action (approve|revoke) are required');
    const p = await load(db, modId, owner);
    if (p.status === 'revoked') throw new ModPrincipalError(409, 'mod.revoked', 'a revoked install is never granted anything again');
    const g = await db.prepare('SELECT state FROM mod_principal_grants WHERE mod_id = ? AND capability = ?').get(modId, capability);
    if (!g) throw new ModPrincipalError(422, 'mod.not_requested', 'the manifest does not request that capability');
    const to = action === 'approve' ? 'approved' : 'revoked';
    if (g.state === to || (action === 'revoke' && g.state === 'pending')) return await view(db, modId);
    const at = iso(now);
    await db.tx(async () => {
        await db.prepare('UPDATE mod_principal_grants SET state = ?, changed_at = ?, changed_by = ? WHERE mod_id = ? AND capability = ?').run(to, at, actor || by, modId, capability);
        await db.prepare('UPDATE mod_principals SET revision = revision + 1, updated_at = ? WHERE mod_id = ?').run(at, modId);
        await announce(db, await view(db, modId), { action, capability }, by, reason);
    });
    kick(db);
    return await view(db, modId);
}

/** End the install: every grant revoked, for good. → network.mod-principal@1 */
async function revokeAll(db, modId, { actor, reason } = {}, { owner = null, by = 'runtime', now = Date.now() } = {}) {
    const p = await load(db, modId, owner);
    if (p.status === 'revoked') return await view(db, modId);
    const at = iso(now);
    await db.tx(async () => {
        await db.prepare("UPDATE mod_principal_grants SET state = 'revoked', changed_at = ?, changed_by = ? WHERE mod_id = ? AND state = 'approved'").run(at, actor || by, modId);
        await db.prepare("UPDATE mod_principals SET status = 'revoked', revision = revision + 1, updated_at = ?, revoked_at = ?, revoked_by = ? WHERE mod_id = ?").run(at, at, actor || by, modId);
        await announce(db, await view(db, modId), { action: 'revoke_all' }, by, reason);
    });
    kick(db);
    return await view(db, modId);
}

function sendError(res, e) {
    if (e instanceof ModPrincipalError) return res.status(e.status).json({ error: e.code, detail: e.message });
    console.error('[ModPrincipals]', e);
    return res.status(500).json({ error: 'mod.failed', detail: 'that did not work' });
}

/** Routers: `internal` under /internal/mods (guard: mods.grant.manage), `admin` under /api/admin/mods (staff.games.manage). */
function routers({ guard, requireAuth, staffClaims }) {
    const owner = (req) => String((req.principal && req.principal.sub) || '').replace(/^svc:/, '');
    const internal = express.Router();
    internal.use(guard);
    internal.get('/', async (req, res) => {
        const db = req.app.locals.db; ensureSchema(db);
        const rows = await db.prepare('SELECT mod_id FROM mod_principals WHERE owner = ? ORDER BY created_at').all(owner(req));
        res.json({ mods: (await Promise.all(rows.map(async (r) => await view(db, r.mod_id)))) });
    });
    internal.get('/:id', async (req, res) => { try { await load(req.app.locals.db, req.params.id, owner(req)); res.json(await view(req.app.locals.db, req.params.id)); } catch (e) { sendError(res, e); } });
    internal.post('/', async (req, res) => { try { const out = await register(req.app.locals.db, owner(req), req.body || {}); res.status(out.status).json(out.body); } catch (e) { sendError(res, e); } });
    internal.post('/:id/grants', async (req, res) => { try { res.json(await change(req.app.locals.db, req.params.id, req.body || {}, { owner: owner(req) })); } catch (e) { sendError(res, e); } });
    internal.post('/:id/revoke', async (req, res) => { try { res.json(await revokeAll(req.app.locals.db, req.params.id, req.body || {}, { owner: owner(req) })); } catch (e) { sendError(res, e); } });

    const admin = express.Router();
    admin.use(express.json({ limit: '8kb' }));
    const staffOnly = (req, res, next) => (staff.can(staffClaims(req.user), 'staff.games.manage') ? next() : res.status(403).json({ error: 'forbidden', detail: 'staff.games.manage required' }));
    const reasoned = (req, res) => {
        const reason = String((req.body && req.body.reason) || '').trim();
        if (reason.length < 10) { res.status(400).json({ error: 'mod.reason_required', detail: 'a written reason (10 characters or more)' }); return null; }
        return reason.slice(0, 500);
    };
    const audit = async (req, action, detail) => await req.app.locals.db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(req.user.id, action, JSON.stringify(detail));
    admin.get('/', requireAuth, staffOnly, async (req, res) => {
        const db = req.app.locals.db; ensureSchema(db);
        res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ mods: (await Promise.all((await db.prepare('SELECT mod_id FROM mod_principals ORDER BY updated_at DESC LIMIT 500').all()).map(async (r) => await view(db, r.mod_id)))) });
    });
    admin.post('/:id/grants', requireAuth, staffOnly, async (req, res) => {
        const reason = reasoned(req, res); if (!reason) return;
        const actor = req.user.subject_id || `user:${req.user.id}`;
        try {
            const out = await change(req.app.locals.db, req.params.id, { capability: req.body.capability, action: req.body.action, actor, reason }, { by: 'staff' });
            await audit(req, 'mod_grant_change', { mod_id: req.params.id, capability: req.body.capability, action: req.body.action, reason });
            res.json(out);
        } catch (e) { sendError(res, e); }
    });
    admin.post('/:id/revoke', requireAuth, staffOnly, async (req, res) => {
        const reason = reasoned(req, res); if (!reason) return;
        try {
            const out = await revokeAll(req.app.locals.db, req.params.id, { actor: req.user.subject_id || `user:${req.user.id}`, reason }, { by: 'staff' });
            await audit(req, 'mod_revoke', { mod_id: req.params.id, reason });
            res.json(out);
        } catch (e) { sendError(res, e); }
    });
    return { internal, admin };
}

module.exports = { ensureSchema, register, change, revokeAll, view, routers, ModPrincipalError };
