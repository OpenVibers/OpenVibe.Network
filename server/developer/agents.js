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
 *   Delegated grants, budgets, standing rules, confirmations and agent tokens come in later slices (section 8).
 */
const { ids } = require('openvibe-contracts');
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

module.exports = { ensureSchema, AGENT_ID_RE, agentView, listAgents, getAgent, createAgent, renameAgent, changeStatus, revokeWhere };
