'use strict';
/**
 * Agents (plan T2 WS-Z2, docs/t2-projects-and-grants.md sections 3-5): an agent (agt_<ULID>) acts for one person,
 * inside one developer project, run by one host — an app of that project (in the app's environment) or a
 * first-party service listed in AGENT_HOST_SERVICES (always production). The schema is migrations/0016_agents.sql.
 *
 * - A person creates agents for themselves only: developer+ for a sandbox app or a service host, admin+ for a
 *   production app. Nobody creates an agent for another member; staff never create one.
 * - The owner or an admin+ renames and resumes; the owner, an admin+ or staff pause and revoke. A staff pause is
 *   lifted by the owner (or an admin), never by staff as such. `revoked` is final; `paused` is reversible.
 * - Losing the host or the project takes the agents with it, in the transaction that causes it: revoking the app,
 *   archiving the project, the owner leaving it, and the owner's account erasure (revokeWhere).
 * - Every change is a dev_audit row without an event: Contracts has no payload for it yet.
 * - Delegated grants (slice 3, migrations/0017_agent_grants.sql): the owner alone sets one, for a capability the
 *   host may use for this project (the delegation ceiling, `ceiling` below); the owner, an admin+ or staff revoke it.
 *   A capability the installed catalog marks sensitive is always `confirm`, whatever mode is stored. A change that
 *   shrinks the ceiling (an allowance, an app grant, a service's principal_grants row) revokes the delegated grants
 *   outside it in its own transaction (revokeBeyondHost).
 *   Budgets, standing rules, confirmations and agent tokens come in later slices (section 8).
 */
const { ids, capabilities } = require('openvibe-contracts');
const policy = require('./policy');
const store = require('./store');

const AGENT_ID_RE = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
const fail = (status, code, detail) => { throw new store.DevError(status, code, detail); };
const nowIso = () => new Date().toISOString();
const atLeast = (role, need) => !!role && store.ROLES.indexOf(role) >= store.ROLES.indexOf(need);

function ensureSchema(db) { /* the schema is migrations/0016_agents.sql (plan T2); nothing is created at runtime */ }

function agentView(a) {
    return {
        id: a.id, subject: { type: 'agent', id: a.id }, project_id: a.project_id,
        owner: { type: 'user', id: a.owner_subject },
        host: a.host_kind === 'app' ? { type: 'app', id: a.host_app_id } : { type: 'service', id: a.host_service },
        environment: a.environment, name: a.name, status: a.status,
        created_at: a.created_at, updated_at: a.updated_at, revoked_at: a.revoked_at || null,
    };
}

const cleanName = (v) => {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!s || s.length > 80) fail(422, 'agent.invalid', 'name must be 1-80 characters');
    return s;
};

async function loadAgent(db, projectId, agentId) {
    const a = AGENT_ID_RE.test(String(agentId)) ? await db.prepare('SELECT * FROM dev_agents WHERE id = ? AND project_id = ?').get(agentId, projectId) : null;
    if (!a) fail(404, 'agent.not_found', 'no such agent');
    return a;
}

async function listAgents(db, actor, projectId, { owner } = {}) {
    const { project } = await store.access(db, actor, projectId, { allowArchived: true });
    const rows = owner === 'me'
        ? await db.prepare('SELECT * FROM dev_agents WHERE project_id = ? AND owner_subject = ? ORDER BY id').all(project.id, actor.subject)
        : await db.prepare('SELECT * FROM dev_agents WHERE project_id = ? ORDER BY id').all(project.id);
    return rows.map(agentView);
}

async function getAgent(db, actor, projectId, agentId) {
    const { project } = await store.access(db, actor, projectId, { allowArchived: true });
    return agentView(await loadAgent(db, project.id, agentId));
}

/** The host a creation names, checked against the project and the caller's role: an app host must be a live app of the project. */
async function resolveHost(db, project, role, host, settings) {
    if (host.type === 'app') {
        const app = store.APP_ID_RE.test(String(host.id))
            ? await db.prepare('SELECT * FROM dev_apps WHERE id = ? AND project_id = ? AND revoked_at IS NULL').get(host.id, project.id) : null;
        if (!app) fail(404, 'app.not_found', 'no such app');
        if (app.environment === 'production' && !atLeast(role, 'admin')) fail(403, 'project.forbidden', 'requires admin role');
        return { kind: 'app', app: app.id, service: null, environment: app.environment };
    }
    if (host.type === 'service') {
        const svc = String(host.id || '');
        if (!settings.agentHostServices.has(svc) || !await db.prepare('SELECT client_id FROM oauth_clients WHERE client_id = ?').get(svc)) {
            fail(422, 'agent.host_not_allowed', `${svc.slice(0, 40) || 'that service'} does not host agents`);
        }
        return { kind: 'service', app: null, service: svc, environment: 'production' };
    }
    fail(422, 'agent.invalid', "host is { type: 'app', id: 'app_…' } or { type: 'service', id }");
}

/** Create an agent for the caller. An app host must be a live app of this project: anything else is app.not_found. */
async function createAgent(db, actor, projectId, body, { ctx, settings }) {
    await store.access(db, actor, projectId, { need: 'developer', staffOk: false });
    if (body.owner !== undefined) {
        const o = body.owner && typeof body.owner === 'object' ? body.owner.id : body.owner;
        if (o !== actor.subject) fail(403, 'agent.forbidden', 'an agent is created for yourself only');
    }
    const name = cleanName(body.name);
    const host = body.host && typeof body.host === 'object' ? body.host : {};
    const id = ids.newId('agent');
    const t = nowIso();
    await db.tx(async () => {
        // Under the project's lock, which an app revocation, a member's removal, an archive and an account erasure
        // take before revoking agents: the project, the membership and the host are checked again here, so a
        // cascade that commits first is seen, and one that comes after sees this agent and revokes it.
        await store.lockProject(db, projectId);
        const { project, role } = await store.access(db, actor, projectId, { need: 'developer', staffOk: false });
        const h = await resolveHost(db, project, role, host, settings);
        await db.prepare(`INSERT INTO dev_agents (id, project_id, owner_subject, host_kind, host_app_id, host_service, environment, name, created_at, created_by, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, project.id, actor.subject, h.kind, h.app, h.service, h.environment, name, t, actor.label, t);
        await store.audit(db, { projectId: project.id, actor: actor.label, action: 'agent.created', target: `agent:${id}`,
            detail: { name, host: { type: h.kind, id: h.app || h.service }, environment: h.environment }, ctx });
    });
    return agentView(await db.prepare('SELECT * FROM dev_agents WHERE id = ?').get(id));
}

async function renameAgent(db, actor, projectId, agentId, body, { ctx }) {
    const { project, role } = await store.access(db, actor, projectId, { staffOk: false });
    const a = await loadAgent(db, project.id, agentId);
    if (a.owner_subject !== actor.subject && !atLeast(role, 'admin')) fail(403, 'agent.forbidden', "only the agent's owner or an admin renames it");
    if (a.status === 'revoked') fail(409, 'agent.revoked', 'agent is revoked');
    const name = cleanName(body.name);
    await db.tx(async () => {
        await db.prepare('UPDATE dev_agents SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), a.id);
        await store.audit(db, { projectId: project.id, actor: actor.label, action: 'agent.renamed', target: `agent:${a.id}`, detail: { from: a.name, to: name }, ctx });
    });
    return agentView(await db.prepare('SELECT * FROM dev_agents WHERE id = ?').get(a.id));
}

/**
 * Revoke every agent matching `where` that is not revoked yet, in the caller's transaction: one audit row each.
 * `reason` is stored as revoked_by (app_revoked, project_archived, member_removed, account_deleted); `actor` is
 * the subject label of whoever caused it. Returns how many were revoked.
 */
async function revokeWhere(db, where, params, { actor, reason, ctx }) {
    const t = nowIso();
    let n = 0;
    const rows = await db.prepare(`SELECT id, project_id FROM dev_agents WHERE (${where}) AND status <> 'revoked' ORDER BY id`).all(...params);
    for (const a of rows) {
        const r = await db.prepare("UPDATE dev_agents SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ? AND status <> 'revoked'").run(t, reason, t, a.id);
        if (!r.changes) continue;
        n++;
        await store.audit(db, { projectId: a.project_id, actor, action: 'agent.revoked', target: `agent:${a.id}`, detail: { reason }, ctx });
    }
    return n;
}

const TO = { pause: 'paused', resume: 'active', revoke: 'revoked' };

/** pause | resume | revoke. Staff may pause and revoke any project's agent, but not resume one. */
async function changeStatus(db, actor, projectId, agentId, action, { ctx }) {
    const staffOk = action !== 'resume';
    const { project, role } = await store.access(db, actor, projectId, { staffOk, allowArchived: action === 'revoke' });
    const a = await loadAgent(db, project.id, agentId);
    if (!(role && a.owner_subject === actor.subject) && !atLeast(role, 'admin') && !(staffOk && actor.staff)) {
        fail(403, 'agent.forbidden', `only the agent's owner, an admin${staffOk ? ' or staff' : ''} may ${action} it`);
    }
    const to = TO[action];
    await db.tx(async () => {
        // The status is read again under the row's lock and the update is conditioned on it: a revoke that commits
        // while this runs (a person's, or a cascade's) is seen here, never undone by a resume that read `paused`.
        const cur = await db.prepare('SELECT * FROM dev_agents WHERE id = ? FOR UPDATE').get(a.id);
        if (cur.status === to) return;
        if (cur.status === 'revoked') fail(409, 'agent.revoked', 'agent is revoked');
        const t = nowIso();
        const r = await db.prepare('UPDATE dev_agents SET status = ?, revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ? AND status = ?')
            .run(to, to === 'revoked' ? t : null, to === 'revoked' ? actor.label : null, t, a.id, cur.status);
        if (!r.changes) fail(409, 'agent.revoked', 'agent is revoked');
        await store.audit(db, { projectId: project.id, actor: actor.label, action: `agent.${to === 'active' ? 'resumed' : to}`, target: `agent:${a.id}`,
            detail: { from: cur.status, staff: actor.staff && !role ? true : undefined }, ctx });
    });
    return agentView(await db.prepare('SELECT * FROM dev_agents WHERE id = ?').get(a.id));
}

// ── Delegated grants ───────────────────────────────────────────

const GRANT_MODES = ['auto', 'confirm'];

/** Sensitive per the installed catalog, read on every call (never stored), so a capability marked later counts at once. */
const isSensitive = (capability) => { const c = capabilities.get(String(capability)); return !!(c && c.sensitive); };
/** What a grant means now: a sensitive capability is always confirmed, whatever mode the owner stored. */
const effectiveMode = (grant) => (isSensitive(grant.capability) ? 'confirm' : grant.mode);

/**
 * The delegation ceiling: the capabilities the agent's host may use for this project at `audience`, now.
 * App host: the app's effectiveGrants (approved ∩ allowance, ∪ the sandbox allowance for a sandbox app, ∩ grantable).
 * Service host: its unexpired principal_grants, never an `internal` capability. Either way only `active` ones, and
 * nothing for a revoked agent, a revoked host app or an archived project.
 */
async function ceiling(db, agent, audience, settings) {
    if (agent.status === 'revoked') return new Set();
    let held = [];
    if (agent.host_kind === 'app') {
        const app = await db.prepare('SELECT * FROM dev_apps WHERE id = ? AND revoked_at IS NULL').get(agent.host_app_id);
        const project = app && await db.prepare('SELECT * FROM dev_projects WHERE id = ? AND archived_at IS NULL').get(app.project_id);
        // Required here: tokens.js requires store.js, which requires this module lazily.
        if (project) held = await require('./tokens').effectiveGrants(db, app, project, audience, settings || policy.settings());
    } else {
        held = (await require('../identity/principals').grantsFor(db, agent.host_service, audience)).map((g) => g.capability)
            .filter((c) => { const m = capabilities.get(c); return m && m.visibility !== 'internal'; });
    }
    return new Set(held.filter((c) => { const m = capabilities.get(c); return m && m.status === 'active'; }));
}

async function withinHost(db, agent, capability, settings) {
    const audience = policy.audienceOf(capability);
    return !!audience && (await ceiling(db, agent, audience, settings)).has(capability);
}

function grantView(g, within) {
    return {
        capability: g.capability, audience: g.audience, mode: g.mode, effective_mode: effectiveMode(g), sensitive: isSensitive(g.capability),
        status: g.status, within_host: within, expires_at: g.expires_at || null, granted_at: g.granted_at, granted_by: g.granted_by,
    };
}

/** Views of an agent's grant rows, each ceiling computed once per audience. */
async function grantViews(db, agent, rows, settings) {
    const ceilings = new Map();
    const out = [];
    for (const g of rows) {
        if (!ceilings.has(g.audience)) ceilings.set(g.audience, await ceiling(db, agent, g.audience, settings));
        out.push(grantView(g, ceilings.get(g.audience).has(g.capability)));
    }
    return out;
}

/** The audit row of a delegated-grant change: no event, Contracts has no payload for it yet (section 2). */
async function grantAudit(db, agent, g, { actor, from, to, mode, reason, ctx }) {
    await store.audit(db, { projectId: agent.project_id, actor, action: 'grant.changed', target: `agent:${agent.id}`,
        detail: { capability: g.capability, audience: g.audience, from, to, mode, reason: reason || undefined }, ctx });
}

async function revokeGrantRow(db, agent, g, { actor, reason, ctx }) {
    const t = nowIso();
    const r = await db.prepare("UPDATE dev_agent_grants SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ?, updated_at = ? WHERE agent_id = ? AND capability = ? AND status = 'active'")
        .run(t, actor, reason || null, t, agent.id, g.capability);
    if (r.changes) await grantAudit(db, agent, g, { actor, from: 'active', to: 'revoked', mode: g.mode, reason, ctx });
    return r.changes > 0;
}

function expiryOf(v) {
    if (v == null || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) fail(422, 'grant.invalid', 'expires_at is not a date');
    if (d.getTime() <= Date.now()) fail(422, 'grant.invalid', 'expires_at is in the past');
    return d.toISOString();
}

async function listGrants(db, actor, projectId, agentId, { settings } = {}) {
    const { project } = await store.access(db, actor, projectId, { allowArchived: true });
    const a = await loadAgent(db, project.id, agentId);
    return await grantViews(db, a, await db.prepare('SELECT * FROM dev_agent_grants WHERE agent_id = ? ORDER BY capability').all(a.id), settings);
}

async function readGrant(db, agent, capability, settings) {
    return (await grantViews(db, agent, [await db.prepare('SELECT * FROM dev_agent_grants WHERE agent_id = ? AND capability = ?').get(agent.id, capability)], settings))[0];
}

/**
 * Set a delegated grant: { mode: 'auto'|'confirm' (default confirm), expires_at? }. The agent's owner only: a person
 * delegates their own authority. Refused: an unknown capability (404 grant.unknown_capability), one that is not
 * active (404 grant.not_grantable), `auto` on a sensitive one (422 grant.sensitive_requires_confirm), one outside the
 * host's ceiling (403 grant.beyond_host). Setting a revoked grant again makes it active with a new granted_at.
 */
async function putGrant(db, actor, projectId, agentId, capability, body, { ctx, settings }) {
    const { project, role } = await store.access(db, actor, projectId, { staffOk: false });
    const a = await loadAgent(db, project.id, agentId);
    if (!(role && a.owner_subject === actor.subject)) fail(403, 'agent.forbidden', "only the agent's owner delegates to it");
    const cap = capabilities.get(String(capability));
    if (!cap) fail(404, 'grant.unknown_capability', `no capability ${String(capability).slice(0, 80)} in the catalog`);
    if (cap.status !== 'active') fail(404, 'grant.not_grantable', `${cap.id} is ${cap.status}`);
    const mode = body.mode === undefined || body.mode === null ? 'confirm' : body.mode;
    if (!GRANT_MODES.includes(mode)) fail(422, 'grant.invalid', "mode is 'auto' or 'confirm'");
    const expiresAt = expiryOf(body.expires_at);
    if (mode === 'auto' && isSensitive(cap.id)) fail(422, 'grant.sensitive_requires_confirm', `${cap.id} is sensitive: every use is confirmed`);
    const audience = policy.audienceOf(cap.id);
    await db.tx(async () => {
        // Under the project's lock, which an allowance change (its UPDATE), an app grant revoke, an app revocation, an
        // archive and a member's removal hold while they cascade: the ceiling read here is the one they leave behind.
        await store.lockProject(db, project.id);
        await store.access(db, actor, projectId, { staffOk: false });
        const cur = await db.prepare('SELECT * FROM dev_agents WHERE id = ? FOR UPDATE').get(a.id);
        if (cur.status === 'revoked') fail(409, 'agent.revoked', 'agent is revoked');
        // A service's grant row is held until commit, so a concurrent /api/admin/grants/revoke cascades after this.
        if (cur.host_kind === 'service') await db.prepare('SELECT 1 AS held FROM principal_grants WHERE client_id = ? AND capability = ? AND audience = ? FOR SHARE').get(cur.host_service, cap.id, audience);
        if (!await withinHost(db, cur, cap.id, settings)) fail(403, 'grant.beyond_host', `${cap.id} is not something this agent's host may do for the project`);
        const prev = await db.prepare('SELECT * FROM dev_agent_grants WHERE agent_id = ? AND capability = ? FOR UPDATE').get(a.id, cap.id);
        const active = prev && prev.status === 'active';
        if (active && prev.mode === mode && (prev.expires_at || null) === expiresAt) return;
        const t = nowIso();
        if (active) {
            await db.prepare('UPDATE dev_agent_grants SET mode = ?, expires_at = ?, updated_at = ? WHERE agent_id = ? AND capability = ?').run(mode, expiresAt, t, a.id, cap.id);
        } else {
            await db.prepare(`INSERT INTO dev_agent_grants (agent_id, capability, audience, mode, status, granted_at, granted_by, updated_at, expires_at)
                        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
                        ON CONFLICT (agent_id, capability) DO UPDATE SET audience = excluded.audience, mode = excluded.mode, status = 'active',
                            granted_at = excluded.granted_at, granted_by = excluded.granted_by, updated_at = excluded.updated_at, expires_at = excluded.expires_at,
                            revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL`)
                .run(a.id, cap.id, audience, mode, t, actor.label, t, expiresAt);
        }
        await grantAudit(db, cur, { capability: cap.id, audience }, { actor: actor.label, from: prev ? prev.status : 'none', to: 'active', mode, ctx });
    });
    return await readGrant(db, await loadAgent(db, project.id, a.id), cap.id, settings);
}

/** Revoke a delegated grant: the agent's owner, an admin+ or staff. */
async function deleteGrant(db, actor, projectId, agentId, capability, { ctx, settings }) {
    const { project, role } = await store.access(db, actor, projectId, { allowArchived: true });
    const a = await loadAgent(db, project.id, agentId);
    if (!(role && a.owner_subject === actor.subject) && !atLeast(role, 'admin') && !actor.staff) {
        fail(403, 'agent.forbidden', "only the agent's owner, an admin or staff revoke its grants");
    }
    await db.tx(async () => {
        const g = await db.prepare('SELECT * FROM dev_agent_grants WHERE agent_id = ? AND capability = ? FOR UPDATE').get(a.id, String(capability));
        if (!g) fail(404, 'grant.not_found', 'no such grant');
        if (g.status !== 'active') fail(409, 'grant.not_active', `grant is ${g.status}`);
        await revokeGrantRow(db, a, g, { actor: actor.label, reason: null, ctx });
    });
    return await readGrant(db, a, String(capability), settings);
}

/**
 * The ceiling cascade, in the caller's transaction: revoke every active delegated grant of the (not revoked) agents
 * matching `where` that their host's ceiling no longer covers, one audit row each (reason beyond_host). `actor` is the
 * subject label of whoever shrank it. Returns how many were revoked.
 */
async function revokeBeyondHost(db, where, params, { actor, ctx, settings }) {
    let n = 0;
    for (const a of await db.prepare(`SELECT * FROM dev_agents WHERE (${where}) AND status <> 'revoked' ORDER BY id`).all(...params)) {
        const ceilings = new Map();
        for (const g of await db.prepare("SELECT * FROM dev_agent_grants WHERE agent_id = ? AND status = 'active' ORDER BY capability").all(a.id)) {
            if (!ceilings.has(g.audience)) ceilings.set(g.audience, await ceiling(db, a, g.audience, settings));
            if (!ceilings.get(g.audience).has(g.capability) && await revokeGrantRow(db, a, g, { actor, reason: 'beyond_host', ctx })) n++;
        }
    }
    return n;
}

module.exports = {
    ensureSchema, AGENT_ID_RE, agentView, listAgents, getAgent, createAgent, renameAgent, changeStatus, revokeWhere,
    effectiveMode, withinHost, listGrants, putGrant, deleteGrant, revokeBeyondHost,
};
