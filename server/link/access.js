'use strict';

// An asking machine and a receiving machine are always resolved from live Network principals.
// Bot checks the short-lived signed token and this row again before delivering each frame.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const { ids, http, validate } = require('openvibe-contracts');
const { ensureUserSubject } = require('../identity/subjects');
const eventRelay = require('../developer/event-relay');
const names = require('./names');

const SCOPES = new Set(['agent', 'send', 'screen', 'desk', 'computer', 'worker']);
const PRINCIPAL = /^lnk_[0-9A-HJKMNP-TV-Z]{26}$/;
const ONE_HOUR = 3600;
const MAX_SECONDS = 30 * 24 * ONE_HOUR;
const DAY_MS = 24 * ONE_HOUR * 1000;
const id = (prefix) => `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
const iso = (ms) => new Date(ms).toISOString();
const fail = (status, code, detail) => { throw Object.assign(new Error(detail), { status, code }); };
const array = (raw) => { try { return JSON.parse(raw); } catch { return []; } };

function scopesOf(value) {
    if (!Array.isArray(value) || !value.length || value.length > SCOPES.size ||
        value.some((s) => !SCOPES.has(s)) || new Set(value).size !== value.length) {
        fail(422, 'link_access.invalid_scopes', 'choose one or more distinct access scopes');
    }
    return value;
}

function durationOf(value, scopes, own) {
    if (value === null) {
        if (!own || scopes.some((s) => s !== 'agent' && s !== 'send')) {
            fail(422, 'link_access.duration', 'until revoked is for your own machines and agent or send only');
        }
        return null;
    }
    const n = value === undefined ? ONE_HOUR : Number(value);
    if (!Number.isInteger(n) || n < 60 || n > MAX_SECONDS) fail(422, 'link_access.duration', 'duration must be 60 seconds to 30 days');
    return n;
}

async function machine(db, principal) {
    if (!PRINCIPAL.test(String(principal))) return null;
    return db.prepare("SELECT id, name, owner_subject FROM platform_node_principals WHERE id = ? AND owner_kind = 'user' AND status = 'active'").get(principal);
}

async function target(db, input) {
    const value = String(input || '').trim();
    if (PRINCIPAL.test(value)) return machine(db, value);
    // The handle form reveals nothing unless the request is accepted by the owner policy below.
    const named = /^@([a-z0-9_]{2,32})\/(.{1,80})$/i.exec(value);
    if (!named) return null;
    const owner = await db.prepare('SELECT subject_id FROM users WHERE lower(username) = lower(?)').get(named[1]);
    if (!owner) return null;
    return db.prepare("SELECT id, name, owner_subject FROM platform_node_principals WHERE owner_subject = ? AND lower(name) = lower(?) AND owner_kind = 'user' AND status = 'active' ORDER BY id LIMIT 1").get(owner.subject_id, named[2]);
}

async function selfNode(db, req) {
    const sub = String(req.principal?.sub || '');
    if (!sub.startsWith('link:')) fail(403, 'link_access.machine_required', 'a paired machine token is required');
    const p = await machine(db, sub.slice(5));
    if (!p) fail(401, 'link_access.machine_unavailable', 'the machine is no longer paired');
    return p;
}

async function owner(db, req) {
    if (!req.user) fail(401, 'link_access.sign_in', 'sign in to manage machine access');
    return ensureUserSubject(db, req.user);
}

async function settings(db, principal) {
    const row = await db.prepare('SELECT others_may_ask, auto_agent_send, agents_talk FROM link_access_settings WHERE principal_id = ?').get(principal);
    return { others_may_ask: !!row?.others_may_ask, auto_agent_send: !!row?.auto_agent_send, agents_talk: !!row?.agents_talk };
}

async function putSettings(db, principal, who, body) {
    const p = await machine(db, principal);
    if (!p || p.owner_subject !== who) fail(404, 'link_access.machine_not_found', 'no such machine of yours');
    const keys = ['others_may_ask', 'auto_agent_send', 'agents_talk'];
    if (!body || typeof body !== 'object' || Object.keys(body).some((key) => !keys.includes(key)) ||
        keys.some((key) => body[key] !== undefined && typeof body[key] !== 'boolean')) {
        fail(422, 'link_access.invalid_settings', 'settings must be boolean owner switches');
    }
    const old = await settings(db, principal);
    const next = Object.fromEntries(keys.map((key) => [key, body[key] === undefined ? old[key] : body[key]]));
    await db.prepare(`INSERT INTO link_access_settings (principal_id, others_may_ask, auto_agent_send, agents_talk, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (principal_id) DO UPDATE SET others_may_ask = excluded.others_may_ask,
        auto_agent_send = excluded.auto_agent_send, agents_talk = excluded.agents_talk, updated_at = excluded.updated_at`)
        .run(principal, +next.others_may_ask, +next.auto_agent_send, +next.agents_talk, iso(Date.now()));
    return next;
}

function envelope(type, payload, ownerId, subjectId, at) {
    const env = { event_id: ids.newId('event', Date.parse(at)), event_type: type, version: 1, source: 'network',
        actor: { type: 'user', id: ownerId }, timestamp: at, visibility: 'internal',
        subject: { type: 'node_principal', id: subjectId }, payload };
    const ev = validate('events.event-envelope@1', env), pv = validate(`${type}@1`, payload);
    if (!ev.valid || !pv.valid) throw new Error(`link access event invalid: ${JSON.stringify((ev.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    return env;
}

async function emit(db, type, payload, who, nodeId, at) {
    await eventRelay.writerFor(db).enqueue(db, envelope(type, payload, who, nodeId, at));
}

function requestView(r) {
    return { id: r.id, from_principal: r.from_principal, to_principal: r.to_principal,
        from_owner: r.from_owner, to_owner: r.to_owner, from_agent: r.from_agent || null,
        scopes: array(r.scopes), reason: r.reason || null, duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
        status: r.status, asked_at: r.asked_at, pending_until: r.pending_until, answered_at: r.answered_at || null };
}
function grantView(g) {
    return { id: g.id, request_id: g.request_id || null, from_principal: g.from_principal, to_principal: g.to_principal,
        from_owner: g.from_owner, to_owner: g.to_owner, scopes: array(g.scopes), approved_by: g.approved_by,
        created_at: g.created_at, expires_at: g.expires_at || null, revoked_at: g.revoked_at || null };
}

async function ask(db, from, body, now = Date.now()) {
    const to = await target(db, body?.to_principal || body?.target);
    if (!to || to.id === from.id) fail(404, 'link_access.target_unavailable', 'that machine is unavailable');
    const scopes = scopesOf(body?.scopes), sameOwner = from.owner_subject === to.owner_subject;
    const duration = durationOf(body?.duration_seconds, scopes, sameOwner);
    const reason = body?.reason == null ? null : String(body.reason).trim();
    if (reason && (reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason))) fail(422, 'link_access.reason', 'reason must be plain text up to 500 characters');
    if (!sameOwner) {
        const switches = await settings(db, to.id);
        if (!switches.others_may_ask) fail(403, 'link_access.others_off', 'the owner is not accepting requests');
        // The owner's follow graph (server/identity/follows.js): its one target kind today is a Live channel, named
        // by the target person's subject, so an active channel follow of the asker is the person's follow.
        const followed = await db.prepare("SELECT 1 FROM user_follows WHERE follower_subject = ? AND target_type = 'channel' AND target_id = ? AND active = 1")
            .get(to.owner_subject, from.owner_subject);
        if (!followed) fail(403, 'link_access.not_followed', 'the receiving owner has not added the asker');
    }
    const agent = body?.from_agent == null ? null : String(body.from_agent);
    if (agent) {
        const row = await db.prepare('SELECT owner_subject, machine_id FROM agent_directory WHERE id = ?').get(agent);
        if (!row || row.owner_subject !== from.owner_subject || row.machine_id !== from.id) fail(403, 'link_access.agent_not_owned', 'that agent is not on the asking machine');
    }
    const request = await db.tx(async () => {
        if (!sameOwner) {
            // Serialize the count for one receiving machine, so concurrent asks cannot pass the fifth slot together.
            await db.prepare('SELECT id FROM platform_node_principals WHERE id = ? FOR UPDATE').get(to.id);
            const since = iso(now - DAY_MS);
            const refused = await db.prepare("SELECT 1 FROM link_access_requests WHERE from_owner = ? AND to_owner = ? AND status = 'denied' AND answered_at > ? LIMIT 1")
                .get(from.owner_subject, to.owner_subject, since);
            if (refused) fail(429, 'link_access.refused_cooldown', 'a refusal starts a one-day wait');
            const count = await db.prepare('SELECT COUNT(*) AS n FROM link_access_requests WHERE from_owner = ? AND to_owner = ? AND asked_at > ?')
                .get(from.owner_subject, to.owner_subject, since);
            if (Number(count.n) >= 5) fail(429, 'link_access.daily_limit', 'five requests per day is the limit');
        }
        const at = iso(now), reqId = id('req'), pendingUntil = iso(now + DAY_MS);
        await db.prepare(`INSERT INTO link_access_requests (id, from_principal, to_principal, from_owner, to_owner, from_agent, scopes, reason,
            duration_seconds, asked_at, pending_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(reqId, from.id, to.id, from.owner_subject, to.owner_subject, agent, JSON.stringify(scopes), reason, duration, at, pendingUntil);
        await emit(db, 'network.link.access.requested', { request_id: reqId, from_principal: from.id, to_principal: to.id, at }, from.owner_subject, to.id, at);
        return requestView(await db.prepare('SELECT * FROM link_access_requests WHERE id = ?').get(reqId));
    });
    if (sameOwner && scopes.every((s) => s === 'agent' || s === 'send') && (await settings(db, to.id)).auto_agent_send) {
        return (await answer(db, request.id, to.owner_subject, { approve: true }, now)).request;
    }
    return request;
}

async function answer(db, requestId, who, body, now = Date.now()) {
    return db.tx(async () => {
        const r = await db.prepare('SELECT * FROM link_access_requests WHERE id = ? FOR UPDATE').get(requestId);
        if (!r || r.to_owner !== who) fail(404, 'link_access.request_not_found', 'no such request of yours');
        if (r.status !== 'pending') fail(409, 'link_access.already_answered', 'this request was already settled');
        const at = iso(now);
        if (Date.parse(r.pending_until) <= now) {
            await db.prepare("UPDATE link_access_requests SET status = 'expired', answered_at = ? WHERE id = ?").run(at, r.id);
            await emit(db, 'network.link.access.answered', { request_id: r.id, status: 'expired', at }, who, r.to_principal, at);
            return { request: requestView(await db.prepare('SELECT * FROM link_access_requests WHERE id = ?').get(r.id)), grant: null, expired: true };
        }
        const approved = body?.approve === true;
        if (body?.approve !== true && body?.approve !== false) fail(422, 'link_access.answer', 'approve must be true or false');
        let grant = null;
        if (approved) {
            const wanted = array(r.scopes), chosen = body.scopes === undefined ? wanted : scopesOf(body.scopes);
            if (chosen.some((s) => !wanted.includes(s))) fail(422, 'link_access.widened_scope', 'an answer may only narrow scopes');
            const seconds = body.duration_seconds === undefined ? (r.duration_seconds == null ? null : Number(r.duration_seconds)) :
                durationOf(body.duration_seconds, chosen, r.from_owner === r.to_owner);
            if (r.duration_seconds != null && (seconds == null || seconds > Number(r.duration_seconds))) {
                fail(422, 'link_access.widened_time', 'an answer may only shorten time');
            }
            const a = await machine(db, r.from_principal), b = await machine(db, r.to_principal);
            if (!a || !b || a.owner_subject !== r.from_owner || b.owner_subject !== r.to_owner) fail(409, 'link_access.machine_unavailable', 'a machine changed since it asked');
            const grantId = id('grt'), expires = seconds == null ? null : iso(now + seconds * 1000);
            await db.prepare(`INSERT INTO link_access_grants (id, request_id, from_principal, to_principal, from_owner, to_owner,
                scopes, approved_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(grantId, r.id, r.from_principal, r.to_principal, r.from_owner, r.to_owner, JSON.stringify(chosen), who, at, expires);
            grant = grantView(await db.prepare('SELECT * FROM link_access_grants WHERE id = ?').get(grantId));
        }
        const status = approved ? 'approved' : 'denied';
        await db.prepare('UPDATE link_access_requests SET status = ?, answered_at = ? WHERE id = ?').run(status, at, r.id);
        await emit(db, 'network.link.access.answered', { request_id: r.id, status, ...(grant ? { grant_id: grant.id } : {}), at }, who, r.to_principal, at);
        return { request: requestView(await db.prepare('SELECT * FROM link_access_requests WHERE id = ?').get(r.id)), grant };
    });
}

async function expirePending(db, now = Date.now()) {
    const rows = await db.prepare("SELECT * FROM link_access_requests WHERE status = 'pending' AND pending_until <= ? ORDER BY pending_until LIMIT 100").all(iso(now));
    for (const row of rows) await db.tx(async () => {
        const at = iso(now);
        const changed = await db.prepare("UPDATE link_access_requests SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'pending'").run(at, row.id);
        if (changed.changes) await emit(db, 'network.link.access.answered', { request_id: row.id, status: 'expired', at }, row.to_owner, row.to_principal, at);
    });
    return rows.length;
}

async function liveGrant(db, grantId, now = Date.now()) {
    const g = await db.prepare('SELECT * FROM link_access_grants WHERE id = ?').get(grantId);
    if (!g || g.revoked_at || (g.expires_at && Date.parse(g.expires_at) <= now)) return null;
    const a = await machine(db, g.from_principal), b = await machine(db, g.to_principal);
    if (!a || !b || a.owner_subject !== g.from_owner || b.owner_subject !== g.to_owner) return null;
    return g;
}

async function grantToken(db, grantId, from, privateKey, issuer, now = Date.now()) {
    const g = await liveGrant(db, grantId, now);
    if (!g || g.from_principal !== from.id) fail(404, 'link_access.grant_not_found', 'no live grant for this machine');
    const iat = Math.floor(now / 1000), exp = Math.min(iat + 300, g.expires_at ? Math.floor(Date.parse(g.expires_at) / 1000) : iat + 300);
    if (exp <= iat) fail(410, 'link_access.expired', 'the grant expired');
    const claims = { iss: issuer, aud: g.to_principal, sub: g.from_principal, jti: id('tok'), grant_id: g.id, scopes: array(g.scopes), iat, exp };
    const checked = validate('link.access-grant-token@1', claims);
    if (!checked.valid) throw new Error(`grant claims invalid: ${JSON.stringify(checked.errors).slice(0, 300)}`);
    const algorithm = String(privateKey).includes('BEGIN') ? 'RS256' : 'HS256';
    return { grant: grantView(g), grant_token: jwt.sign(claims, privateKey, { algorithm, header: { kid: 'ov-network-1', typ: 'JWT' } }), expires_at: iso(exp * 1000) };
}

async function revoke(db, grantId, who, now = Date.now()) {
    return db.tx(async () => {
        const g = await db.prepare('SELECT * FROM link_access_grants WHERE id = ? FOR UPDATE').get(grantId);
        if (!g || (g.from_owner !== who && g.to_owner !== who)) fail(404, 'link_access.grant_not_found', 'no such grant of yours');
        if (!g.revoked_at) {
            const at = iso(now);
            await db.prepare('UPDATE link_access_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, g.id);
            await emit(db, 'network.link.access.revoked', { grant_id: g.id, from_principal: g.from_principal, to_principal: g.to_principal, at }, who, g.to_principal, at);
        }
        return grantView(await db.prepare('SELECT * FROM link_access_grants WHERE id = ?').get(g.id));
    });
}

// Called inside the existing unpair and account-deletion transactions.
async function revokeForPrincipal(db, principal, ownerId, now = Date.now()) {
    const rows = await db.prepare('SELECT * FROM link_access_grants WHERE (from_principal = ? OR to_principal = ?) AND revoked_at IS NULL').all(principal, principal);
    const at = iso(now);
    for (const row of rows) {
        await db.prepare('UPDATE link_access_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, row.id);
        await emit(db, 'network.link.access.revoked', { grant_id: row.id, from_principal: row.from_principal,
            to_principal: row.to_principal, at }, ownerId, row.to_principal, at);
    }
    await db.prepare("UPDATE agent_directory SET status = 'offline' WHERE machine_id = ?").run(principal);
    return rows.length;
}

async function useGrant(db, grantId, from, to, scope, action, now = Date.now()) {
    const g = await liveGrant(db, grantId, now);
    if (!g || g.from_principal !== from || g.to_principal !== to || !array(g.scopes).includes(scope)) {
        fail(403, 'link_access.grant_denied', 'no live grant for this frame and scope');
    }
    if (!SCOPES.has(scope) || typeof action !== 'string' || action.length < 1 || action.length > 100) fail(422, 'link_access.audit', 'invalid scope or action');
    await db.prepare('INSERT INTO link_access_audit (id, grant_id, from_owner, to_owner, scope, action, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id('aud'), g.id, g.from_owner, g.to_owner, scope, action, iso(now));
    return grantView(g);
}

function routers({ requireAuth, nodeGuard, relayGuard }) {
    const self = express.Router(), user = express.Router(), internal = express.Router();
    const wrap = (fn) => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await fn(req, res, req.app.locals.db); } catch (e) {
            if (e.status && e.code) return http.sendProblem(res, e.status, e.code, { detail: e.message });
            console.error('[link access]', e.message);
            return http.sendProblem(res, 500, 'link_access.failed', { detail: 'machine access could not be changed' });
        }
    };
    self.use(nodeGuard);
    self.post('/access-requests', express.json({ limit: '8kb' }), wrap(async (req, res, db) => res.status(201).json({ request: await ask(db, await selfNode(db, req), req.body) })));
    self.get('/access-requests', wrap(async (req, res, db) => {
        const p = await selfNode(db, req);
        await expirePending(db);
        const rows = await db.prepare('SELECT * FROM link_access_requests WHERE from_principal = ? OR to_principal = ? ORDER BY asked_at DESC LIMIT 100').all(p.id, p.id);
        res.json({ requests: rows.map(requestView) });
    }));
    // A machine answers only the requests addressed to it (a Link holds a node token, not a user session), while the
    // same decision from any signed-in surface settles it once.
    self.post('/access-requests/:id/answer', express.json({ limit: '8kb' }), wrap(async (req, res, db) => {
        const p = await selfNode(db, req);
        const row = await db.prepare('SELECT to_principal FROM link_access_requests WHERE id = ?').get(req.params.id);
        if (!row || row.to_principal !== p.id) fail(404, 'link_access.request_not_found', 'no such request for this machine');
        const out = await answer(db, req.params.id, p.owner_subject, req.body);
        res.status(out.expired ? 410 : 200).json(out);
    }));
    self.get('/access-grants', wrap(async (req, res, db) => {
        const p = await selfNode(db, req);
        const rows = await db.prepare('SELECT * FROM link_access_grants WHERE from_principal = ? OR to_principal = ? ORDER BY created_at DESC LIMIT 100').all(p.id, p.id);
        res.json({ grants: rows.map(grantView) });
    }));
    // Either machine in a grant may end it, from its own node token; the owner routes do the same by person.
    self.post('/access-grants/:id/revoke', wrap(async (req, res, db) => {
        const p = await selfNode(db, req);
        const row = await db.prepare('SELECT from_principal, to_principal FROM link_access_grants WHERE id = ?').get(req.params.id);
        if (!row || (row.from_principal !== p.id && row.to_principal !== p.id)) fail(404, 'link_access.grant_not_found', 'no such grant for this machine');
        res.json({ grant: await revoke(db, req.params.id, p.owner_subject) });
    }));
    // The person's agent directory, seen from the paired machine: the entries a local CLI may message.
    self.get('/agents', wrap(async (req, res, db) => {
        const p = await selfNode(db, req);
        const rows = await db.prepare('SELECT * FROM agent_directory WHERE owner_subject = ? ORDER BY updated_at DESC, id LIMIT 200').all(p.owner_subject);
        res.json({ agents: rows.map(require('./agents').directoryView) });
    }));
    self.post('/access-grants/:id/token', wrap(async (req, res, db) => res.json(await grantToken(db, req.params.id,
        await selfNode(db, req), req.app.locals.privateKey, req.app.locals.config.jwt.issuer))));
    self.get('/access-grants/:id/status', wrap(async (req, res, db) => {
        const p = await selfNode(db, req), g = await liveGrant(db, req.params.id);
        if (!g || (g.from_principal !== p.id && g.to_principal !== p.id)) {
            fail(404, 'link_access.grant_not_found', 'no live grant for this machine');
        }
        res.json({ grant: grantView(g), active: true });
    }));
    user.use(requireAuth);
    user.get('/access-requests', wrap(async (req, res, db) => {
        const who = await owner(db, req);
        await expirePending(db);
        const rows = await db.prepare('SELECT * FROM link_access_requests WHERE from_owner = ? OR to_owner = ? ORDER BY asked_at DESC LIMIT 100').all(who, who);
        // The owner's page names each side (openvibe.link/machines: "Jo's laptop asks for access to your desktop").
        res.json({ requests: await names.nameAccessRows(db, rows.map(requestView), who) });
    }));
    user.post('/access-requests', express.json({ limit: '8kb' }), wrap(async (req, res, db) => {
        const who = await owner(db, req), from = await machine(db, req.body?.from_principal);
        if (!from || from.owner_subject !== who) fail(404, 'link_access.machine_not_found', 'no such asking machine of yours');
        res.status(201).json({ request: await ask(db, from, req.body) });
    }));
    user.post('/access-requests/:id/answer', express.json({ limit: '8kb' }), wrap(async (req, res, db) => {
        const out = await answer(db, req.params.id, await owner(db, req), req.body);
        res.status(out.expired ? 410 : 200).json(out);
    }));
    user.get('/access-grants', wrap(async (req, res, db) => {
        const who = await owner(db, req);
        const rows = await db.prepare('SELECT * FROM link_access_grants WHERE from_owner = ? OR to_owner = ? ORDER BY created_at DESC LIMIT 100').all(who, who);
        res.json({ grants: await names.nameAccessRows(db, rows.map(grantView), who) });
    }));
    user.post('/access-grants/:id/revoke', wrap(async (req, res, db) => res.json({ grant: await revoke(db, req.params.id, await owner(db, req)) })));
    user.get('/access-audit', wrap(async (req, res, db) => {
        const who = await owner(db, req);
        // Each use names the two machines of its grant, so the page can say "Jo's laptop sent a file to your desktop".
        const rows = await db.prepare(`SELECT a.id, a.grant_id, a.from_owner, a.to_owner, a.scope, a.action, a.at, g.from_principal, g.to_principal
            FROM link_access_audit a JOIN link_access_grants g ON g.id = a.grant_id
            WHERE a.from_owner = ? OR a.to_owner = ? ORDER BY a.at DESC LIMIT 200`).all(who, who);
        res.json({ audit: await names.nameAccessRows(db, rows, who) });
    }));
    user.get('/:id/access-settings', wrap(async (req, res, db) => {
        const who = await owner(db, req), p = await machine(db, req.params.id);
        if (!p || p.owner_subject !== who) fail(404, 'link_access.machine_not_found', 'no such machine of yours');
        res.json({ principal: p.id, settings: await settings(db, p.id) });
    }));
    user.put('/:id/access-settings', express.json({ limit: '2kb' }), wrap(async (req, res, db) =>
        res.json({ principal: req.params.id, settings: await putSettings(db, req.params.id, await owner(db, req), req.body) })));
    internal.use(relayGuard);
    internal.get('/grants/:id', wrap(async (req, res, db) => {
        const g = await liveGrant(db, req.params.id);
        if (!g) fail(404, 'link_access.grant_not_found', 'no live grant');
        res.json({ grant: grantView(g) });
    }));
    internal.post('/grants/:id/use', express.json({ limit: '2kb' }), wrap(async (req, res, db) =>
        res.json({ grant: await useGrant(db, req.params.id, req.body?.from_principal, req.body?.to_principal, req.body?.scope, req.body?.action) })));
    return { self, user, internal };
}

module.exports = { SCOPES, scopesOf, durationOf, settings, putSettings, ask, answer, liveGrant, grantToken,
    revoke, revokeForPrincipal, useGrant, expirePending, machine, selfNode, routers, requestView, grantView };
