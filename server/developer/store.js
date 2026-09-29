'use strict';
/**
 * Developer projects (roadmap Wave 20 foundation, ADR-014): projects, members, apps, credentials,
 * grants, quotas and an append-only audit, all owned by Network.
 *
 * - A project has one owner subject (usr_), members with roles, apps, an environment policy, and an
 *   allowance: the capabilities staff let its apps hold. Tenancy elsewhere is keyed by project_id.
 * - An app is an OAuth client whose client_id IS its subject id (app_<ULID>); it is kept apart from
 *   oauth_clients (first-party sites and service principals) so it never inherits first-party trust.
 * - Client secrets are stored only as SHA-256 hashes (256-bit random secrets, so a fast hash is
 *   enough) and returned once, at creation or rotation. Rotation keeps the previous secret valid for
 *   an overlap; revocation is immediate.
 * - Grants come only from the capability catalog and never exceed the allowance: approval checks
 *   it, shrinking the allowance revokes what falls outside, and token issuance intersects again.
 * - Quotas are recorded and exposed here; the owning service enforces them.
 * - dev_audit is append-only (triggers refuse UPDATE/DELETE). Rows that are platform events carry an
 *   event envelope (events.event-envelope@1). When OV_EVENTS_INTERNAL_URL is set, the same
 *   transaction enqueues the envelope into network_event_outbox and ./event-relay.js publishes it
 *   to OpenVibe.Events (openvibe-sdk outbox; events written while the relay was off are backfilled).
 */
const crypto = require('crypto');
const { ids, validate } = require('openvibe-contracts');
const subjects = require('../identity/subjects');
const policy = require('./policy');
const eventRelay = require('./event-relay');

const ROLES = ['viewer', 'developer', 'admin', 'owner'];
const RANK = { viewer: 1, developer: 2, admin: 3, owner: 4 };
const CLIENT_TYPES = ['confidential', 'public'];
const QUOTA_WINDOWS = ['minute', 'hour', 'day', 'month', 'total'];
const APP_ID_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const CRED_ID_RE = /^crd_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SECRET_PREFIX = 'ovsec_';

class DevError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail; }
}
const fail = (status, code, detail) => { throw new DevError(status, code, detail); };
const nowIso = () => new Date().toISOString();

function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

// ── Audit and events ───────────────────────────────────────────

/**
 * Append one audit row. `actor` is a subject string ('user:usr_…', 'system:network').
 * With `event` = { type, subject: { type, id }, payload }, the row also carries an event envelope.
 * `detail` must never contain secret material (callers pass ids, hints and names only).
 */
async function audit(db, { projectId, actor, action, target, detail, ctx, event }) {
    let envelope = null;
    if (event) {
        const [atype, aid] = String(actor).split(':');
        envelope = {
            event_id: ids.newId('event'),
            event_type: event.type, version: 1, source: 'network',
            actor: atype === 'user' ? { type: 'user', id: aid } : { type: 'system', id: 'network' },
            timestamp: nowIso(), visibility: 'internal', subject: event.subject, payload: event.payload || {},
        };
        if (ctx && /^[0-9a-f]{32}$/.test(ctx.traceId || '')) envelope.trace_id = ctx.traceId;
        const v = validate('events.event-envelope@1', envelope);
        if (!v.valid) throw new Error(`bad event envelope: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
    }
    // One transaction (a savepoint when the caller already has one): the audit row and, when the
    // Events relay is on, its outbox row exist together or not at all.
    const outbox = envelope ? eventRelay.outboxFor(db) : null;
    await db.tx(async () => {
        await db.prepare(`INSERT INTO dev_audit (at, project_id, actor, action, target, detail, request_id, event_type, event)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(nowIso(), projectId || null, actor, action, target || null, JSON.stringify(detail || {}), (ctx && ctx.requestId) || null,
                envelope ? envelope.event_type : null, envelope ? JSON.stringify(envelope) : null);
        if (outbox) await outbox.enqueue(db, envelope, { traceparent: ctx && ctx.traceparent });
    });
    if (outbox) outbox.kick();
}

async function listAudit(db, projectId, { before, limit = 50 } = {}) {
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = before
        ? await db.prepare('SELECT * FROM dev_audit WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(projectId, Number(before), n)
        : await db.prepare('SELECT * FROM dev_audit WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, n);
    return {
        entries: rows.map(r => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, target: r.target, detail: JSON.parse(r.detail || '{}'),
            request_id: r.request_id, event_type: r.event_type || undefined, event_id: r.event ? JSON.parse(r.event).event_id : undefined })),
        next_before: rows.length === n ? rows[rows.length - 1].id : null,
    };
}

// ── Actors ─────────────────────────────────────────────────────

/** { subject, user, staff } for an authenticated Network user row. */
async function actorOf(db, user) {
    const subject = await subjects.ensureUserSubject(db, user);
    if (!subject) fail(401, 'auth.no_subject', 'account has no subject id');
    return { subject, user, staff: user.role === 'admin', label: `user:${subject}` };
}

async function memberRole(db, projectId, subject) {
    const r = await db.prepare('SELECT role FROM dev_project_members WHERE project_id = ? AND subject_id = ?').get(projectId, subject);
    return r ? r.role : null;
}

/**
 * Load a project the actor may see. Non-members get 404 (existence is not disclosed); staff see all.
 * `need` is the minimum member role; `staffOk` lets staff through regardless of membership.
 */
async function access(db, actor, projectId, { need = 'viewer', staffOk = true, allowArchived = false } = {}) {
    const p = PROJECT_ID_RE.test(String(projectId)) ? await db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(projectId) : null;
    const role = p ? await memberRole(db, p.id, actor.subject) : null;
    if (!p || (!role && !actor.staff)) fail(404, 'project.not_found', 'no such project');
    const ok = (role && RANK[role] >= RANK[need]) || (actor.staff && staffOk);
    if (!ok) fail(403, 'project.forbidden', `requires ${need} role`);
    if (p.archived_at && !allowArchived) fail(409, 'project.archived', 'project is archived');
    return { project: p, role };
}

// ── Projects ───────────────────────────────────────────────────

const cleanName = (v, field = 'name') => {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!s || s.length > 80) fail(422, 'project.invalid', `${field} must be 1-80 characters`);
    return s;
};

async function projectView(db, p, role, settings) {
    return {
        id: p.id, name: p.name, owner: { type: 'user', id: p.owner_subject }, role: role || null,
        environment_policy: p.environment_policy, environments: policy.ENVIRONMENT_POLICIES[p.environment_policy],
        allowance: JSON.parse(p.allowance || '[]'),
        // Held by sandbox apps without a staff decision (DEV_SANDBOX_ALLOWANCE); production apps use `allowance` only.
        sandbox_allowance: (settings || policy.settings()).sandboxAllowance,
        created_at: p.created_at, archived_at: p.archived_at || null,
        counts: {
            members: (await db.prepare('SELECT COUNT(*) AS n FROM dev_project_members WHERE project_id = ?').get(p.id)).n,
            apps: (await db.prepare('SELECT COUNT(*) AS n FROM dev_apps WHERE project_id = ? AND revoked_at IS NULL').get(p.id)).n,
        },
    };
}

async function createProject(db, actor, { name }, { settings, ctx }) {
    const n = cleanName(name);
    const owned = (await db.prepare('SELECT COUNT(*) AS n FROM dev_projects WHERE owner_subject = ? AND archived_at IS NULL').get(actor.subject)).n;
    if (owned >= settings.maxProjectsPerOwner) fail(409, 'project.limit', `at most ${settings.maxProjectsPerOwner} active projects per owner`);
    const id = `prj_${ids.ulid()}`;
    const t = nowIso();
    await db.tx(async () => {
        await db.prepare(`INSERT INTO dev_projects (id, owner_subject, name, environment_policy, allowance, created_at, created_by)
                    VALUES (?, ?, ?, 'sandbox', ?, ?, ?)`).run(id, actor.subject, n, JSON.stringify(settings.defaultAllowance), t, actor.label);
        await db.prepare('INSERT INTO dev_project_members (project_id, subject_id, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)')
            .run(id, actor.subject, 'owner', t, actor.label);
        await audit(db, { projectId: id, actor: actor.label, action: 'project.created', target: id, detail: { name: n, allowance: settings.defaultAllowance }, ctx });
    });
    return await projectView(db, await db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(id), 'owner', settings);
}

async function listProjects(db, actor, { all = false, settings } = {}) {
    const rows = all && actor.staff
        ? await db.prepare('SELECT p.*, m.role FROM dev_projects p LEFT JOIN dev_project_members m ON m.project_id = p.id AND m.subject_id = ? ORDER BY p.id DESC').all(actor.subject)
        : await db.prepare('SELECT p.*, m.role FROM dev_projects p JOIN dev_project_members m ON m.project_id = p.id WHERE m.subject_id = ? ORDER BY p.id DESC').all(actor.subject);
    return (await Promise.all(rows.map(async r => await projectView(db, r, r.role, settings))));
}

async function renameProject(db, actor, projectId, { name }, { ctx, settings }) {
    const { project, role } = await access(db, actor, projectId, { need: 'admin', staffOk: false });
    const n = cleanName(name);
    await db.tx(async () => {
        await db.prepare('UPDATE dev_projects SET name = ? WHERE id = ?').run(n, project.id);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'project.renamed', target: project.id, detail: { from: project.name, to: n }, ctx });
    });
    return await projectView(db, await db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(project.id), role, settings);
}

/** Archive: irreversible. Every app of the project is revoked (credentials included). */
async function archiveProject(db, actor, projectId, { ctx, settings }) {
    const { project, role } = await access(db, actor, projectId, { need: 'owner', staffOk: true });
    await db.tx(async () => {
        for (const app of await db.prepare('SELECT * FROM dev_apps WHERE project_id = ? AND revoked_at IS NULL').all(project.id)) await revokeAppTx(db, actor, project, app, ctx, 'project archived');
        await db.prepare('UPDATE dev_projects SET archived_at = ?, archived_by = ? WHERE id = ?').run(nowIso(), actor.label, project.id);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'project.archived', target: project.id, ctx });
    });
    return await projectView(db, await db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(project.id), role, settings);
}

/** Staff: the capabilities this project's apps may hold. Grants outside the new allowance are revoked. */
async function setAllowance(db, actor, projectId, { capabilities: list }, { ctx, settings }) {
    if (!actor.staff) fail(403, 'project.staff_only', 'only staff set a project allowance');
    const { project } = await access(db, actor, projectId);
    if (!Array.isArray(list) || list.length > 200) fail(422, 'project.invalid', 'capabilities must be an array (at most 200)');
    const wanted = [...new Set(list.map(String))].sort();
    for (const id of wanted) {
        const g = policy.grantability(id);
        if (!g.grantable) fail(422, g.code, g.reason);
    }
    const trimmed = [];
    await db.tx(async () => {
        await db.prepare('UPDATE dev_projects SET allowance = ? WHERE id = ?').run(JSON.stringify(wanted), project.id);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'project.allowance_set', target: project.id, detail: { from: JSON.parse(project.allowance), to: wanted }, ctx });
        const rows = await db.prepare(`SELECT g.*, a.project_id, a.environment FROM dev_grants g JOIN dev_apps a ON a.id = g.app_id
                                 WHERE a.project_id = ? AND g.status IN ('approved', 'requested')`).all(project.id);
        // A sandbox app's grant that is still inside the sandbox allowance survives a staff change.
        const updated = { ...project, allowance: JSON.stringify(wanted) };
        for (const g of rows.filter(r => !policy.allowanceFor(updated, { environment: r.environment }, settings).has(r.capability))) {
            const next = g.status === 'approved' ? 'revoked' : 'denied';
            await db.prepare('UPDATE dev_grants SET status = ?, decided_by = ?, decided_at = ? WHERE app_id = ? AND capability = ?').run(next, actor.label, nowIso(), g.app_id, g.capability);
            await grantEvent(db, actor, project.id, g.app_id, g.capability, g.audience, g.status, next, ctx, 'outside allowance');
            trimmed.push({ app_id: g.app_id, capability: g.capability, status: next });
        }
    });
    return { allowance: wanted, trimmed };
}

async function setEnvironmentPolicy(db, actor, projectId, { environment_policy: value }, { ctx }) {
    if (!actor.staff) fail(403, 'project.staff_only', 'only staff change the environment policy');
    const { project } = await access(db, actor, projectId);
    if (!policy.ENVIRONMENT_POLICIES[value]) fail(422, 'project.invalid', `environment_policy is one of ${Object.keys(policy.ENVIRONMENT_POLICIES).join(', ')}`);
    await db.tx(async () => {
        await db.prepare('UPDATE dev_projects SET environment_policy = ? WHERE id = ?').run(value, project.id);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'project.environment_policy_set', target: project.id, detail: { from: project.environment_policy, to: value }, ctx });
    });
    return { environment_policy: value, environments: policy.ENVIRONMENT_POLICIES[value] };
}

// ── Members ────────────────────────────────────────────────────

async function memberView(db, r) {
    const u = await db.prepare('SELECT username, display_name FROM users WHERE subject_id = ?').get(r.subject_id);
    return { subject: { type: 'user', id: r.subject_id }, username: u ? u.username : null, display_name: u ? (u.display_name || u.username) : null, role: r.role, added_at: r.added_at };
}

async function listMembers(db, actor, projectId) {
    const { project } = await access(db, actor, projectId, { allowArchived: true });
    return (await Promise.all((await db.prepare('SELECT * FROM dev_project_members WHERE project_id = ? ORDER BY added_at').all(project.id)).map(async r => await memberView(db, r))));
}

async function resolveUserSubject(db, { subject_id, username }) {
    let u = null;
    if (subject_id && USER_SUBJECT_RE.test(String(subject_id))) u = await db.prepare('SELECT id, subject_id, is_banned FROM users WHERE subject_id = ?').get(String(subject_id));
    else if (username) u = await db.prepare('SELECT id, subject_id, created_at, is_banned FROM users WHERE lower(username) = lower(?)').get(String(username));
    if (!u || u.is_banned) fail(404, 'member.user_not_found', 'no such account');
    return u.subject_id || await subjects.ensureUserSubject(db, u);
}

/** Admins manage developers and viewers; only the owner manages admins. Ownership is not assignable here. */
function canAssign(role, targetRole) {
    if (targetRole === 'owner') return false;
    if (targetRole === 'admin') return role === 'owner';
    return RANK[role] >= RANK.admin;
}

async function addMember(db, actor, projectId, body, { ctx }) {
    const { project, role } = await access(db, actor, projectId, { need: 'admin', staffOk: false });
    const newRole = String(body.role || 'developer');
    if (!ROLES.includes(newRole)) fail(422, 'member.invalid', `role is one of ${ROLES.filter(r => r !== 'owner').join(', ')}`);
    if (!canAssign(role, newRole)) fail(403, 'member.forbidden', `a ${role} cannot assign ${newRole}`);
    const subject = await resolveUserSubject(db, body);
    if (await memberRole(db, project.id, subject)) fail(409, 'member.exists', 'already a member');
    await db.tx(async () => {
        await db.prepare('INSERT INTO dev_project_members (project_id, subject_id, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)').run(project.id, subject, newRole, nowIso(), actor.label);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'member.added', target: `user:${subject}`, detail: { role: newRole }, ctx });
    });
    return await memberView(db, await db.prepare('SELECT * FROM dev_project_members WHERE project_id = ? AND subject_id = ?').get(project.id, subject));
}

async function updateMember(db, actor, projectId, subject, body, { ctx }) {
    const { project, role } = await access(db, actor, projectId, { need: 'admin', staffOk: false });
    const current = await memberRole(db, project.id, subject);
    if (!current) fail(404, 'member.not_found', 'not a member');
    const newRole = String(body.role || '');
    if (!ROLES.includes(newRole)) fail(422, 'member.invalid', 'unknown role');
    if (current === 'owner') fail(403, 'member.forbidden', 'the owner role is not changed here');
    if (!canAssign(role, current) || !canAssign(role, newRole)) fail(403, 'member.forbidden', `a ${role} cannot change ${current} to ${newRole}`);
    await db.tx(async () => {
        await db.prepare('UPDATE dev_project_members SET role = ? WHERE project_id = ? AND subject_id = ?').run(newRole, project.id, subject);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'member.role_changed', target: `user:${subject}`, detail: { from: current, to: newRole }, ctx });
    });
    return await memberView(db, await db.prepare('SELECT * FROM dev_project_members WHERE project_id = ? AND subject_id = ?').get(project.id, subject));
}

async function removeMember(db, actor, projectId, subject, { ctx }) {
    const self = subject === actor.subject;
    const { project, role } = await access(db, actor, projectId, { need: self ? 'viewer' : 'admin', staffOk: false, allowArchived: true });
    const current = await memberRole(db, project.id, subject);
    if (!current) fail(404, 'member.not_found', 'not a member');
    if (current === 'owner') fail(403, 'member.forbidden', 'the owner cannot be removed');
    if (!self && !canAssign(role, current)) fail(403, 'member.forbidden', `a ${role} cannot remove a ${current}`);
    await db.tx(async () => {
        await db.prepare('DELETE FROM dev_project_members WHERE project_id = ? AND subject_id = ?').run(project.id, subject);
        await audit(db, { projectId: project.id, actor: actor.label, action: self ? 'member.left' : 'member.removed', target: `user:${subject}`, detail: { role: current }, ctx });
    });
}

// ── Apps ───────────────────────────────────────────────────────

function validRedirects(list, environment) {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 10) fail(422, 'app.invalid', 'redirect_uris must be an array of at most 10 URLs');
    return [...new Set(list.map(u => {
        let url;
        try { url = new URL(String(u)); } catch { fail(422, 'app.invalid', `bad redirect URI ${String(u).slice(0, 200)}`); }
        const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.protocol !== 'https:' && !loopback) fail(422, 'app.invalid', 'redirect URIs must be https (http only for loopback)');
        if (loopback && environment !== 'sandbox') fail(422, 'app.invalid', 'loopback redirect URIs are for sandbox apps only');
        if (url.hash || url.username || url.password) fail(422, 'app.invalid', 'redirect URIs carry no fragment or credentials');
        if (String(u).length > 500) fail(422, 'app.invalid', 'redirect URI too long');
        return url.toString();
    }))];
}

/** Role needed to manage an app: developers manage sandbox apps, admins production ones. */
const manageRole = (environment) => (environment === 'production' ? 'admin' : 'developer');

async function appView(db, a) {
    return {
        id: a.id, subject: { type: 'app', id: a.id }, project_id: a.project_id, name: a.name, environment: a.environment,
        client_id: a.oauth_client_id, client_type: a.client_type, redirect_uris: JSON.parse(a.redirect_uris || '[]'),
        created_at: a.created_at, revoked_at: a.revoked_at || null,
        grants: (await db.prepare("SELECT capability FROM dev_grants WHERE app_id = ? AND status = 'approved' ORDER BY capability").all(a.id)).map(g => g.capability),
    };
}

async function loadApp(db, projectId, appId) {
    const a = APP_ID_RE.test(String(appId)) ? await db.prepare('SELECT * FROM dev_apps WHERE id = ? AND project_id = ?').get(appId, projectId) : null;
    if (!a) fail(404, 'app.not_found', 'no such app');
    return a;
}

function newSecret() {
    const secret = SECRET_PREFIX + crypto.randomBytes(32).toString('base64url');
    return { secret, hash: hashSecret(secret), hint: secret.slice(-4) };
}
const hashSecret = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function insertCredential(db, app, actor) {
    const s = newSecret();
    const id = `crd_${ids.ulid()}`;
    await db.prepare('INSERT INTO dev_credentials (id, app_id, secret_hash, hint, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, app.id, s.hash, s.hint, nowIso(), actor.label);
    return { id, secret: s.secret, hint: s.hint };
}

async function listApps(db, actor, projectId) {
    const { project } = await access(db, actor, projectId, { allowArchived: true });
    return (await Promise.all((await db.prepare('SELECT * FROM dev_apps WHERE project_id = ? ORDER BY id').all(project.id)).map(async a => await appView(db, a))));
}

async function getApp(db, actor, projectId, appId) {
    const { project } = await access(db, actor, projectId, { allowArchived: true });
    return await appView(db, await loadApp(db, project.id, appId));
}

/** Create an app. Confidential apps get their first secret, returned here once and never again. */
async function createApp(db, actor, projectId, body, { settings, ctx }) {
    const environment = String(body.environment || 'sandbox');
    if (!policy.ENVIRONMENTS.includes(environment)) fail(422, 'app.invalid', 'environment is sandbox or production');
    const { project } = await access(db, actor, projectId, { need: manageRole(environment), staffOk: false });
    if (!policy.ENVIRONMENT_POLICIES[project.environment_policy].includes(environment)) fail(403, 'app.environment_not_allowed', `this project may only have ${policy.ENVIRONMENT_POLICIES[project.environment_policy].join(', ')} apps (staff enable production)`);
    const clientType = String(body.type || body.client_type || 'confidential');
    if (!CLIENT_TYPES.includes(clientType)) fail(422, 'app.invalid', 'type is confidential or public');
    const name = cleanName(body.name);
    const redirects = validRedirects(body.redirect_uris, environment);
    if (clientType === 'public' && !redirects.length) fail(422, 'app.invalid', 'a public app needs at least one redirect URI (it can only use authorization code + PKCE)');
    const active = (await db.prepare('SELECT COUNT(*) AS n FROM dev_apps WHERE project_id = ? AND revoked_at IS NULL').get(project.id)).n;
    if (active >= settings.maxAppsPerProject) fail(409, 'app.limit', `at most ${settings.maxAppsPerProject} active apps per project`);
    const id = ids.newId('app');
    let credential = null;
    await db.tx(async () => {
        await db.prepare(`INSERT INTO dev_apps (id, project_id, name, environment, oauth_client_id, client_type, redirect_uris, created_at, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, project.id, name, environment, id, clientType, JSON.stringify(redirects), nowIso(), actor.label);
        const app = await db.prepare('SELECT * FROM dev_apps WHERE id = ?').get(id);
        if (clientType === 'confidential') credential = await insertCredential(db, app, actor);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'app.created', target: `app:${id}`,
            detail: { name, environment, client_type: clientType, credential_id: credential ? credential.id : undefined }, ctx,
            event: { type: 'network.app.created', subject: { type: 'app', id }, payload: { project_id: project.id, environment, client_type: clientType } } });
    });
    const out = await appView(db, await db.prepare('SELECT * FROM dev_apps WHERE id = ?').get(id));
    if (credential) out.credential = { id: credential.id, client_secret: credential.secret, hint: credential.hint, shown_once: true };
    return out;
}

async function updateApp(db, actor, projectId, appId, body, { ctx }) {
    const { project } = await access(db, actor, projectId, { need: 'viewer', staffOk: false });
    const app = await loadApp(db, project.id, appId);
    await access(db, actor, projectId, { need: manageRole(app.environment), staffOk: false });
    if (app.revoked_at) fail(409, 'app.revoked', 'app is revoked');
    const name = body.name !== undefined ? cleanName(body.name) : app.name;
    const redirects = body.redirect_uris !== undefined ? validRedirects(body.redirect_uris, app.environment) : JSON.parse(app.redirect_uris);
    if (app.client_type === 'public' && !redirects.length) fail(422, 'app.invalid', 'a public app needs at least one redirect URI');
    await db.tx(async () => {
        await db.prepare('UPDATE dev_apps SET name = ?, redirect_uris = ? WHERE id = ?').run(name, JSON.stringify(redirects), app.id);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'app.updated', target: `app:${app.id}`, detail: { name, redirect_uris: redirects }, ctx });
    });
    return await appView(db, await db.prepare('SELECT * FROM dev_apps WHERE id = ?').get(app.id));
}

async function revokeAppTx(db, actor, project, app, ctx, reason) {
    const t = nowIso();
    await db.prepare('UPDATE dev_apps SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(t, actor.label, app.id);
    await db.prepare('UPDATE dev_credentials SET revoked_at = ?, revoked_by = ? WHERE app_id = ? AND revoked_at IS NULL').run(t, actor.label, app.id);
    await db.prepare('UPDATE dev_auth_codes SET used = 1 WHERE app_id = ?').run(app.id);
    await audit(db, { projectId: project.id, actor: actor.label, action: 'app.revoked', target: `app:${app.id}`, detail: { reason: reason || null }, ctx,
        event: { type: 'network.app.revoked', subject: { type: 'app', id: app.id }, payload: { project_id: project.id, environment: app.environment, reason: reason || null } } });
}

/** Revoke an app: immediate for new tokens; issued tokens expire within their 5-minute lifetime. */
async function revokeApp(db, actor, projectId, appId, { ctx }) {
    const { project } = await access(db, actor, projectId, { need: 'viewer', staffOk: true });
    const app = await loadApp(db, project.id, appId);
    if (!actor.staff) await access(db, actor, projectId, { need: manageRole(app.environment), staffOk: false });
    if (app.revoked_at) return await appView(db, app);
    await db.tx(async () => await revokeAppTx(db, actor, project, app, ctx, actor.staff && !await memberRole(db, project.id, actor.subject) ? 'staff' : null));
    return await appView(db, await db.prepare('SELECT * FROM dev_apps WHERE id = ?').get(app.id));
}

// ── Credentials ────────────────────────────────────────────────

function credentialState(c, now = Date.now()) {
    if (c.revoked_at) return 'revoked';
    if (c.expires_at && Date.parse(c.expires_at) <= now) return 'expired';
    return c.expires_at ? 'expiring' : 'active';
}

function credentialView(c) {
    return { id: c.id, hint: c.hint, state: credentialState(c), created_at: c.created_at, expires_at: c.expires_at || null, revoked_at: c.revoked_at || null, last_used_at: c.last_used_at || null };
}

async function listCredentials(db, actor, projectId, appId) {
    const { project } = await access(db, actor, projectId, { allowArchived: true });
    const app = await loadApp(db, project.id, appId);
    return (await db.prepare('SELECT * FROM dev_credentials WHERE app_id = ? ORDER BY id DESC').all(app.id)).map(credentialView);
}

/**
 * Rotate: a new secret (returned once); every still-valid previous secret stays valid for
 * `overlap_seconds` (default settings.credentialOverlapS, 0..7 days), never longer than it already had.
 */
async function rotateCredential(db, actor, projectId, appId, body, { settings, ctx }) {
    const { project } = await access(db, actor, projectId, { need: 'viewer', staffOk: false });
    const app = await loadApp(db, project.id, appId);
    await access(db, actor, projectId, { need: manageRole(app.environment), staffOk: false });
    if (app.revoked_at) fail(409, 'app.revoked', 'app is revoked');
    if (app.client_type !== 'confidential') fail(409, 'credential.public_client', 'public apps have no client secret');
    let overlap = settings.credentialOverlapS;
    if (body && body.overlap_seconds !== undefined) {
        const n = Number(body.overlap_seconds);
        if (!Number.isInteger(n) || n < 0 || n > 7 * 86400) fail(422, 'credential.invalid', 'overlap_seconds is an integer from 0 to 604800');
        overlap = n;
    }
    const until = new Date(Date.now() + overlap * 1000).toISOString();
    let created;
    const kept = [];
    await db.tx(async () => {
        for (const c of await db.prepare('SELECT * FROM dev_credentials WHERE app_id = ? AND revoked_at IS NULL').all(app.id)) {
            if (credentialState(c) === 'expired') continue;
            const exp = c.expires_at && Date.parse(c.expires_at) < Date.parse(until) ? c.expires_at : until;
            await db.prepare('UPDATE dev_credentials SET expires_at = ? WHERE id = ?').run(exp, c.id);
            kept.push({ id: c.id, expires_at: exp });
        }
        created = await insertCredential(db, app, actor);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'credential.rotated', target: `app:${app.id}`,
            detail: { credential_id: created.id, hint: created.hint, overlap_seconds: overlap, previous: kept }, ctx,
            event: { type: 'network.credential.rotated', subject: { type: 'app', id: app.id }, payload: { project_id: project.id, credential_id: created.id, previous_valid_until: kept.length ? until : null } } });
    });
    return { credential: { id: created.id, client_secret: created.secret, hint: created.hint, shown_once: true }, previous: kept };
}

/** Revoke one credential: it stops authenticating at once. */
async function revokeCredential(db, actor, projectId, appId, credId, { ctx }) {
    const { project } = await access(db, actor, projectId, { need: 'viewer', staffOk: true, allowArchived: true });
    const app = await loadApp(db, project.id, appId);
    if (!actor.staff) await access(db, actor, projectId, { need: manageRole(app.environment), staffOk: false, allowArchived: true });
    const c = CRED_ID_RE.test(String(credId)) ? await db.prepare('SELECT * FROM dev_credentials WHERE id = ? AND app_id = ?').get(credId, app.id) : null;
    if (!c) fail(404, 'credential.not_found', 'no such credential');
    if (!c.revoked_at) {
        await db.tx(async () => {
            await db.prepare('UPDATE dev_credentials SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(nowIso(), actor.label, c.id);
            await audit(db, { projectId: project.id, actor: actor.label, action: 'credential.revoked', target: `app:${app.id}`, detail: { credential_id: c.id, hint: c.hint }, ctx,
                event: { type: 'network.credential.revoked', subject: { type: 'app', id: app.id }, payload: { project_id: project.id, credential_id: c.id } } });
        });
    }
    return credentialView(await db.prepare('SELECT * FROM dev_credentials WHERE id = ?').get(c.id));
}

/** Token path: the credential row a presented secret matches, if it is still valid. Updates last_used_at. */
async function matchSecret(db, appId, secret) {
    if (typeof secret !== 'string' || !secret.startsWith(SECRET_PREFIX) || secret.length > 200) return null;
    const want = Buffer.from(hashSecret(secret), 'hex');
    const now = Date.now();
    for (const c of await db.prepare('SELECT * FROM dev_credentials WHERE app_id = ? AND revoked_at IS NULL').all(appId)) {
        if (credentialState(c, now) === 'expired') continue;
        if (crypto.timingSafeEqual(Buffer.from(c.secret_hash, 'hex'), want)) {
            await db.prepare('UPDATE dev_credentials SET last_used_at = ? WHERE id = ?').run(nowIso(), c.id);
            return c;
        }
    }
    return null;
}

// ── Grants ─────────────────────────────────────────────────────

function grantView(g) {
    return { app_id: g.app_id, capability: g.capability, audience: g.audience, status: g.status, requested_by: g.requested_by, requested_at: g.requested_at, decided_by: g.decided_by || null, decided_at: g.decided_at || null };
}

async function grantEvent(db, actor, projectId, appId, capability, audience, from, to, ctx, reason) {
    await audit(db, { projectId, actor: actor.label, action: `grant.${to}`, target: `app:${appId}`, detail: { capability, audience, from, reason: reason || undefined }, ctx,
        event: { type: 'network.grant.changed', subject: { type: 'app', id: appId }, payload: { project_id: projectId, capability, audience, from, to } } });
}

async function listGrants(db, actor, projectId, appId) {
    const { project } = await access(db, actor, projectId, { allowArchived: true });
    const app = await loadApp(db, project.id, appId);
    return (await db.prepare('SELECT * FROM dev_grants WHERE app_id = ? ORDER BY capability').all(app.id)).map(grantView);
}

/** Inside the project's allowance, or (sandbox apps) the sandbox allowance. */
function withinAllowance(project, app, capability, settings) {
    return policy.allowanceFor(project, app, settings).has(capability);
}

/**
 * Request a capability for an app (developer+). Owners and admins get it approved at once when it
 * is inside the allowance; otherwise it waits for an owner/admin.
 */
async function requestGrant(db, actor, projectId, appId, { capability }, { ctx, settings }) {
    const { project, role } = await access(db, actor, projectId, { need: 'developer', staffOk: false });
    const app = await loadApp(db, project.id, appId);
    if (app.revoked_at) fail(409, 'app.revoked', 'app is revoked');
    const g = policy.grantability(capability);
    if (!g.grantable) fail(g.code === 'grant.unknown_capability' ? 422 : 403, g.code, g.reason);
    const audience = policy.audienceOf(capability);
    const existing = await db.prepare('SELECT * FROM dev_grants WHERE app_id = ? AND capability = ?').get(app.id, capability);
    if (existing && ['approved', 'requested'].includes(existing.status)) return grantView(existing);
    const approveNow = RANK[role] >= RANK.admin && withinAllowance(project, app, capability, settings);
    const status = approveNow ? 'approved' : 'requested';
    const t = nowIso();
    await db.tx(async () => {
        await db.prepare(`INSERT INTO dev_grants (app_id, capability, audience, status, requested_by, requested_at, decided_by, decided_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(app_id, capability) DO UPDATE SET audience = excluded.audience, status = excluded.status, requested_by = excluded.requested_by,
                        requested_at = excluded.requested_at, decided_by = excluded.decided_by, decided_at = excluded.decided_at`)
            .run(app.id, capability, audience, status, actor.label, t, approveNow ? actor.label : null, approveNow ? t : null);
        if (approveNow) await grantEvent(db, actor, project.id, app.id, capability, audience, existing ? existing.status : 'none', 'approved', ctx);
        else await audit(db, { projectId: project.id, actor: actor.label, action: 'grant.requested', target: `app:${app.id}`, detail: { capability, audience }, ctx });
    });
    return grantView(await db.prepare('SELECT * FROM dev_grants WHERE app_id = ? AND capability = ?').get(app.id, capability));
}

async function decideGrant(db, actor, projectId, appId, capability, decision, { ctx, settings }) {
    const { project } = await access(db, actor, projectId, { need: 'admin', staffOk: decision === 'revoked', allowArchived: decision === 'revoked' });
    const app = await loadApp(db, project.id, appId);
    const g = await db.prepare('SELECT * FROM dev_grants WHERE app_id = ? AND capability = ?').get(app.id, String(capability));
    if (!g) fail(404, 'grant.not_found', 'no such grant');
    if (decision === 'approved') {
        if (app.revoked_at) fail(409, 'app.revoked', 'app is revoked');
        const ok = policy.grantability(g.capability);
        if (!ok.grantable) fail(403, ok.code, ok.reason);
        if (!withinAllowance(project, app, g.capability, settings)) {
            fail(403, 'grant.beyond_allowance', `${g.capability} is not in this project's ${app.environment === 'sandbox' ? 'allowance or the sandbox allowance' : 'allowance (staff set it for production apps)'}`);
        }
        if (g.status === 'approved') return grantView(g);
    } else if (decision === 'denied') {
        if (g.status !== 'requested') fail(409, 'grant.not_pending', `grant is ${g.status}`);
    } else if (decision === 'revoked') {
        if (g.status !== 'approved') fail(409, 'grant.not_active', `grant is ${g.status}`);
    }
    await db.tx(async () => {
        await db.prepare('UPDATE dev_grants SET status = ?, decided_by = ?, decided_at = ? WHERE app_id = ? AND capability = ?').run(decision, actor.label, nowIso(), app.id, g.capability);
        await grantEvent(db, actor, project.id, app.id, g.capability, g.audience, g.status, decision, ctx);
    });
    return grantView(await db.prepare('SELECT * FROM dev_grants WHERE app_id = ? AND capability = ?').get(app.id, g.capability));
}

// ── Quotas ─────────────────────────────────────────────────────

function quotaView(q) {
    return { capability: q.capability, limit: q.limit_value, window: q.quota_window, unit: q.unit, enforced_by: policy.audienceOf(q.capability), updated_at: q.updated_at };
}

async function listQuotas(db, actor, projectId) {
    const { project } = await access(db, actor, projectId, { allowArchived: true });
    return (await db.prepare('SELECT * FROM dev_quotas WHERE project_id = ? ORDER BY capability').all(project.id)).map(quotaView);
}

async function setQuota(db, actor, projectId, capability, body, { ctx }) {
    if (!actor.staff) fail(403, 'project.staff_only', 'only staff set quotas');
    const { project } = await access(db, actor, projectId);
    const g = policy.grantability(capability);
    if (!g.grantable) fail(422, g.code, g.reason);
    const limit = Number(body.limit);
    if (!Number.isSafeInteger(limit) || limit < 0) fail(422, 'quota.invalid', 'limit is a non-negative integer');
    const window = String(body.window || '');
    if (!QUOTA_WINDOWS.includes(window)) fail(422, 'quota.invalid', `window is one of ${QUOTA_WINDOWS.join(', ')}`);
    const unit = String(body.unit || 'requests');
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(unit)) fail(422, 'quota.invalid', 'unit is a short lowercase word (requests, bytes, tokens, ...)');
    await db.tx(async () => {
        await db.prepare(`INSERT INTO dev_quotas (project_id, capability, limit_value, quota_window, unit, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, capability) DO UPDATE SET limit_value = excluded.limit_value, quota_window = excluded.quota_window, unit = excluded.unit,
                        updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
            .run(project.id, capability, limit, window, unit, nowIso(), actor.label);
        await audit(db, { projectId: project.id, actor: actor.label, action: 'quota.set', target: project.id, detail: { capability, limit, window, unit }, ctx });
    });
    return quotaView(await db.prepare('SELECT * FROM dev_quotas WHERE project_id = ? AND capability = ?').get(project.id, capability));
}

async function deleteQuota(db, actor, projectId, capability, { ctx }) {
    if (!actor.staff) fail(403, 'project.staff_only', 'only staff set quotas');
    const { project } = await access(db, actor, projectId);
    const n = (await db.prepare('DELETE FROM dev_quotas WHERE project_id = ? AND capability = ?').run(project.id, String(capability))).changes;
    if (!n) fail(404, 'quota.not_found', 'no quota for that capability');
    await audit(db, { projectId: project.id, actor: actor.label, action: 'quota.deleted', target: project.id, detail: { capability }, ctx });
}

module.exports = {
    ensureSchema, DevError, ROLES, APP_ID_RE, PROJECT_ID_RE, SECRET_PREFIX,
    audit, listAudit, actorOf, access, memberRole,
    createProject, listProjects, renameProject, archiveProject, setAllowance, setEnvironmentPolicy, projectView,
    listMembers, addMember, updateMember, removeMember,
    listApps, getApp, createApp, updateApp, revokeApp,
    listCredentials, rotateCredential, revokeCredential, matchSecret, hashSecret,
    listGrants, requestGrant, decideGrant,
    listQuotas, setQuota, deleteQuota,
};
