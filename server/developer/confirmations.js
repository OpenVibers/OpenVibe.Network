'use strict';
/**
 * Confirmations, owner side (plan T2 WS-Z2 slice 4, docs/t2-projects-and-grants.md sections 3-5): a sensitive use of a
 * delegated grant waits for its owner's approval. The schema is migrations/0018_confirmations.sql.
 *
 * - The owning service of the capability creates, consumes and cancels them (`create`, `consume`; its
 *   /internal/confirmations routes wait for slice 7). The owner reads, approves and denies them at
 *   /api/v1/confirmations (`router`); nobody else sees one (not admins, not staff: 404 confirmation.not_found).
 * - Views are network.confirmation-request@1 documents; audience, session_id, request_digest, rule_id, used_at,
 *   decided_by, cancel_reason and project_id stay Network-local, never inside the document.
 * - Approving with `session`, `until` or `always` leaves a standing rule that approves the next matching request at
 *   creation (`decided_by = 'rule:<id>'`). Denying never does.
 * - `consume` spends an approval once, after re-checking in one transaction (the agent row locked first) everything
 *   that let it be created: authority that lapsed without a Network write still stops it.
 * - Every change that takes authority away calls `cancelFor` in its own transaction: the pending and approved-unused
 *   rows it affects become `cancelled` with the cause, and the matching standing rules are revoked. Resuming an agent
 *   revives nothing.
 * - Every transition is a dev_audit row without an event (Contracts has no payload yet, slice 9). Audit rows never
 *   carry `summary` or `details`, which may hold message text.
 */
const { ids, validate, capabilities } = require('openvibe-contracts');
const policy = require('./policy');
const store = require('./store');
const agents = require('./agents');

const CNF_ID_RE = /^cnf_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const STATES = ['pending', 'approved', 'denied', 'expired', 'cancelled'];
const RULES = ['once', 'session', 'until', 'always'];
const TTL = { min: 60, max: 86400, default: 900 };
const MAX_PENDING = 20;
const SESSION_MAX_MS = 24 * 3600 * 1000;
const UNTIL_MAX_MS = 30 * 24 * 3600 * 1000;
const MAX_DETAILS = 8192;
// A row that may still be spent or decided: what a cascade cancels.
const LIVE = "(state = 'pending' OR (state = 'approved' AND used_at IS NULL))";

const fail = (status, code, detail) => { throw new store.DevError(status, code, detail); };
const nowIso = () => new Date().toISOString();

/** The state a read reports: a pending row past expires_at is expired before the sweep records it. */
const stateOf = (c, now = nowIso()) => (c.state === 'pending' && c.expires_at <= now ? 'expired' : c.state);

/** network.confirmation-request@1: owner and requested_by rebuilt as SubjectRefs, details/resources parsed. */
function confirmationView(c) {
    const doc = {
        id: c.id, owner: { type: 'user', id: c.owner_subject }, requested_by: { type: 'agent', id: c.agent_id },
        capability: c.capability, summary: c.summary, details: JSON.parse(c.details || '{}'), resources: JSON.parse(c.resources || '[]'),
        state: stateOf(c), expires_at: c.expires_at, created_at: c.created_at,
    };
    if (c.standing_rule) doc.standing_rule = c.standing_rule;
    if (c.decided_at) doc.decided_at = c.decided_at;
    return doc;
}

function ruleView(r) {
    return {
        id: Number(r.id), capability: r.capability, rule: r.rule, until_at: r.until_at || null, session_id: r.session_id || null,
        source: r.source, created_at: r.created_at, revoked_at: r.revoked_at || null,
    };
}

const agentContext = (a) => (a ? { name: a.name, project_id: a.project_id, host: agents.agentView(a).host } : null);

async function audit(db, c, action, { actor, detail, ctx } = {}) {
    await store.audit(db, { projectId: c.project_id, actor: actor || 'system:network', action, target: `confirmation:${c.id}`,
        detail: { agent: c.agent_id, capability: c.capability, ...detail }, ctx });
}

// ── Authority, as at creation and again at consume ─────────────

/**
 * Throws unless `agent` may still ask for `capability` now: the agent is active, its project is not archived, its owner
 * is still a member and not banned or deleted, an app host is live and still the project's and environment's; the
 * delegated grant is active, unexpired and confirmed; the host's ceiling still covers it; its budget is not 0.
 */
async function checkAuthority(db, agent, capability, settings) {
    const inactive = (why) => fail(409, 'confirmation.agent_inactive', why);
    if (agent.status !== 'active') inactive(`agent is ${agent.status}`);
    const project = await db.prepare('SELECT archived_at FROM dev_projects WHERE id = ?').get(agent.project_id);
    if (!project || project.archived_at) inactive('project is archived');
    if (!await store.memberRole(db, agent.project_id, agent.owner_subject)) inactive('owner is no longer a member');
    const owner = await db.prepare('SELECT is_banned, deleted_at FROM users WHERE subject_id = ?').get(agent.owner_subject);
    if (!owner || Number(owner.is_banned) || owner.deleted_at) inactive('owner account is not active');
    if (agent.host_kind === 'app' && !await db.prepare('SELECT 1 AS ok FROM dev_apps WHERE id = ? AND project_id = ? AND environment = ? AND revoked_at IS NULL')
        .get(agent.host_app_id, agent.project_id, agent.environment)) inactive('host app is revoked');
    const notDelegated = (why) => fail(403, 'grant.not_delegated', why);
    const g = await db.prepare("SELECT * FROM dev_agent_grants WHERE agent_id = ? AND capability = ? AND status = 'active'").get(agent.id, capability);
    if (!g || (g.expires_at && g.expires_at <= nowIso())) notDelegated('no active delegated grant for that capability');
    if (agents.effectiveMode(g) !== 'confirm') notDelegated('the grant is auto: nothing to confirm');
    if (!await agents.withinHost(db, agent, capability, settings)) notDelegated("the capability is outside the agent's host");
    const b = await db.prepare('SELECT limit_value FROM dev_agent_budgets WHERE agent_id = ? AND capability = ?').get(agent.id, capability);
    if (b && Number(b.limit_value) === 0) notDelegated('the budget for that capability is 0');
}

// ── The owning service's side (routes in slice 7) ──────────────

/**
 * Create a confirmation for an agent's sensitive use of `capability`, asked by `audience` (the owning service). The
 * owner is the agent's, never the caller's say. A live standing rule approves it at once. → the contract document.
 */
async function create(db, { agentId, capability, audience, summary, details, resources, requestDigest, sessionId, ttlS }, { ctx, settings } = {}) {
    const invalid = (d) => fail(422, 'confirmation.invalid', d);
    if (!agents.AGENT_ID_RE.test(String(agentId))) fail(404, 'agent.not_found', 'no such agent');
    if (!capabilities.get(String(capability))) fail(404, 'grant.unknown_capability', 'no such capability in the catalog');
    if (policy.audienceOf(capability) !== audience) fail(403, 'confirmation.wrong_audience', 'the capability is not the caller\'s');
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 500) invalid('summary is 1-500 characters');
    if (details !== undefined && (!details || typeof details !== 'object' || Array.isArray(details))) invalid('details is an object');
    if (resources !== undefined && !Array.isArray(resources)) invalid('resources is an array of entity refs');
    const detailsJson = JSON.stringify(details || {});
    if (detailsJson.length > MAX_DETAILS) invalid('details is too large');
    if (!DIGEST_RE.test(String(requestDigest))) invalid('request_digest is a lowercase hex SHA-256');
    if (sessionId != null && !SESSION_RE.test(String(sessionId))) invalid('session_id is 8-128 of [A-Za-z0-9._:-]');
    const ttl = ttlS == null ? TTL.default : Number(ttlS);
    if (!Number.isInteger(ttl) || ttl < TTL.min || ttl > TTL.max) invalid(`ttl_s is ${TTL.min}-${TTL.max}`);
    const id = ids.newId('confirmation');
    await db.tx(async () => {
        const agent = await db.prepare('SELECT * FROM dev_agents WHERE id = ? FOR UPDATE').get(agentId);
        if (!agent) fail(404, 'agent.not_found', 'no such agent');
        await checkAuthority(db, agent, capability, settings);
        const now = nowIso();
        const pending = await db.prepare("SELECT count(*) AS n FROM dev_confirmations WHERE agent_id = ? AND state = 'pending' AND expires_at > ?").get(agent.id, now);
        if (Number(pending.n) >= MAX_PENDING) fail(429, 'confirmation.too_many_pending', `at most ${MAX_PENDING} pending confirmations per agent`);
        const rule = await db.prepare(`SELECT * FROM dev_standing_rules WHERE agent_id = ? AND capability = ? AND revoked_at IS NULL
                    AND (rule = 'always' OR (rule = 'until' AND until_at > ?) OR (rule = 'session' AND session_id = ? AND until_at > ?)) ORDER BY id LIMIT 1`)
            .get(agent.id, capability, now, sessionId == null ? null : String(sessionId), now);
        const row = {
            id, project_id: agent.project_id, agent_id: agent.id, owner_subject: agent.owner_subject, capability, summary, details: detailsJson,
            resources: JSON.stringify(resources || []), state: rule ? 'approved' : 'pending', standing_rule: rule ? rule.rule : null, expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
            created_at: now, decided_at: rule ? now : null,
        };
        const v = validate('network.confirmation-request@1', confirmationView(row));
        if (!v.valid) invalid(v.errors.map((e) => `${e.path} ${e.message}`).join('; ').slice(0, 300));
        await db.prepare(`INSERT INTO dev_confirmations (id, project_id, agent_id, owner_subject, capability, audience, summary, details, resources, state, standing_rule,
                        session_id, request_digest, rule_id, expires_at, created_at, decided_at, decided_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, row.project_id, row.agent_id, row.owner_subject, capability, audience, summary, row.details, row.resources, row.state, row.standing_rule,
                sessionId == null ? null : String(sessionId), requestDigest, rule ? rule.id : null, row.expires_at, now, row.decided_at, rule ? `rule:${rule.id}` : null);
        await audit(db, row, 'confirmation.created', { actor: `service:${audience}`, detail: { state: row.state }, ctx });
        if (rule) await audit(db, row, 'confirmation.approved', { actor: `rule:${rule.id}`, detail: { rule_id: Number(rule.id), standing_rule: rule.rule }, ctx });
    });
    return confirmationView(await db.prepare('SELECT * FROM dev_confirmations WHERE id = ?').get(id));
}

/**
 * Spend an approval once, for the action whose digest is `requestDigest`, asked by the audience that created it. One
 * transaction: the agent row is locked first so no revocation interleaves, authority is re-checked, then one
 * conditional UPDATE spends it. → { confirmation, used_at }
 */
async function consume(db, { id, audience, requestDigest }, { ctx, settings } = {}) {
    const notFound = () => fail(404, 'confirmation.not_found', 'no such confirmation');
    if (!CNF_ID_RE.test(String(id))) notFound();
    const first = await db.prepare('SELECT agent_id FROM dev_confirmations WHERE id = ? AND audience = ?').get(id, audience);
    if (!first) notFound();
    return await db.tx(async () => {
        const agent = await db.prepare('SELECT * FROM dev_agents WHERE id = ? FOR UPDATE').get(first.agent_id);
        const c = await db.prepare('SELECT * FROM dev_confirmations WHERE id = ? FOR UPDATE').get(id);
        const now = nowIso();
        if (c.state === 'cancelled') fail(409, 'confirmation.cancelled', `cancelled (${c.cancel_reason || 'service'})`);
        if (c.used_at) fail(409, 'confirmation.used', 'the confirmation was already used');
        if (c.state === 'expired' || c.expires_at <= now) fail(409, 'confirmation.expired', 'the confirmation has expired');
        if (c.state !== 'approved') fail(409, 'confirmation.not_pending', `confirmation is ${c.state}`);
        if (c.request_digest !== String(requestDigest)) fail(409, 'confirmation.mismatch', 'the approval is for another action');
        await checkAuthority(db, agent, c.capability, settings);
        const r = await db.prepare("UPDATE dev_confirmations SET used_at = ? WHERE id = ? AND audience = ? AND state = 'approved' AND used_at IS NULL AND expires_at > ? AND request_digest = ?")
            .run(now, c.id, audience, now, String(requestDigest));
        if (r.changes !== 1) fail(409, 'confirmation.used', 'the confirmation was already used');
        await audit(db, c, 'confirmation.used', { actor: `service:${audience}`, ctx });
        return { confirmation: confirmationView({ ...c, used_at: now }), used_at: now };
    });
}

/**
 * The cascade, in the caller's transaction: cancel the pending and approved-unused confirmations of `agentId` (only
 * those for `capability` when given) with `reason`, one audit row each, and revoke the matching live standing rules.
 * → how many confirmations were cancelled.
 */
async function cancelFor(db, { agentId, capability = null, reason, actor = 'system:network' }, { ctx } = {}) {
    const capSql = capability ? ' AND capability = ?' : '';
    const params = capability ? [agentId, capability] : [agentId];
    let n = 0;
    for (const c of await db.prepare(`SELECT * FROM dev_confirmations WHERE agent_id = ?${capSql} AND ${LIVE} ORDER BY id`).all(...params)) {
        const r = await db.prepare(`UPDATE dev_confirmations SET state = 'cancelled', cancel_reason = ? WHERE id = ? AND ${LIVE}`).run(reason, c.id);
        if (!r.changes) continue;
        n++;
        await audit(db, c, 'confirmation.cancelled', { actor, detail: { from: c.state, reason }, ctx });
    }
    const t = nowIso();
    for (const rule of await db.prepare(`SELECT * FROM dev_standing_rules WHERE agent_id = ?${capSql} AND revoked_at IS NULL ORDER BY id`).all(...params)) {
        await revokeRuleRow(db, rule, { actor, reason, t, ctx });
    }
    return n;
}

async function revokeRuleRow(db, rule, { actor, reason, t = nowIso(), ctx }) {
    const r = await db.prepare('UPDATE dev_standing_rules SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(t, actor, rule.id);
    if (!r.changes) return false;
    const a = await db.prepare('SELECT project_id FROM dev_agents WHERE id = ?').get(rule.agent_id);
    await store.audit(db, { projectId: a.project_id, actor, action: 'agent.rule_revoked', target: `agent:${rule.agent_id}`,
        detail: { rule_id: Number(rule.id), capability: rule.capability, rule: rule.rule, reason: reason || undefined }, ctx });
    return true;
}

/** Record every pending confirmation past expires_at as expired, once. → how many */
async function expireDue(db) {
    const due = await db.prepare("SELECT * FROM dev_confirmations WHERE state = 'pending' AND expires_at <= ? ORDER BY id").all(nowIso());
    let n = 0;
    for (const c of due) {
        await db.tx(async () => {
            const r = await db.prepare("UPDATE dev_confirmations SET state = 'expired' WHERE id = ? AND state = 'pending' AND expires_at <= ?").run(c.id, nowIso());
            if (!r.changes) return;
            n++;
            await audit(db, c, 'confirmation.expired');
        });
    }
    return n;
}

// ── The owner's inbox ──────────────────────────────────────────

async function ownRow(db, actor, id, { lock = false } = {}) {
    const c = CNF_ID_RE.test(String(id)) ? await db.prepare(`SELECT * FROM dev_confirmations WHERE id = ? AND owner_subject = ?${lock ? ' FOR UPDATE' : ''}`).get(id, actor.subject) : null;
    if (!c) fail(404, 'confirmation.not_found', 'no such confirmation');
    return c;
}

/** The caller's own confirmations, newest first. state defaults to pending; before is the last id of the previous page. */
async function list(db, actor, { state = 'pending', before, limit } = {}) {
    const st = state == null || state === '' ? 'pending' : String(state);
    if (!STATES.includes(st)) fail(422, 'confirmation.invalid', `state is one of ${STATES.join(', ')}`);
    const n = Math.min(100, Math.max(1, Number(limit) || 50));
    const now = nowIso();
    const where = { pending: "state = 'pending' AND expires_at > ?", expired: "(state = 'expired' OR (state = 'pending' AND expires_at <= ?))" }[st] || 'state = ?';
    const params = [actor.subject, st === 'pending' || st === 'expired' ? now : st];
    let sql = `SELECT * FROM dev_confirmations WHERE owner_subject = ? AND ${where}`;
    if (before !== undefined && before !== '') {
        if (!CNF_ID_RE.test(String(before))) fail(422, 'confirmation.invalid', 'before is a confirmation id');
        sql += ' AND id < ?';
        params.push(String(before));
    }
    const rows = await db.prepare(`${sql} ORDER BY id DESC LIMIT ?`).all(...params, n);
    const ctxs = {};
    for (const agentId of new Set(rows.map((r) => r.agent_id))) ctxs[agentId] = agentContext(await db.prepare('SELECT * FROM dev_agents WHERE id = ?').get(agentId));
    return { confirmations: rows.map(confirmationView), agents: ctxs, next_before: rows.length === n ? rows[rows.length - 1].id : null };
}

async function get(db, actor, id) {
    const c = await ownRow(db, actor, id);
    return { confirmation: confirmationView(c), agent: agentContext(await db.prepare('SELECT * FROM dev_agents WHERE id = ?').get(c.agent_id)) };
}

function untilOf(v, maxMs, required) {
    if (v == null || v === '') { if (required) fail(422, 'confirmation.invalid', 'until is required'); return null; }
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) fail(422, 'confirmation.invalid', 'until is a future date-time');
    if (d.getTime() > Date.now() + maxMs) fail(422, 'confirmation.invalid', `until is at most ${maxMs === SESSION_MAX_MS ? '24 hours' : '30 days'} away`);
    return d.toISOString();
}

/**
 * The owner approves or denies a pending confirmation. A pending row past expires_at is recorded expired and refused
 * (409 confirmation.expired); any other state is 409 confirmation.not_pending. Approving with session/until/always
 * also leaves a standing rule. → { confirmation, rule? }
 */
async function decide(db, actor, id, action, body = {}, { ctx } = {}) {
    if (action !== 'approve' && action !== 'deny') fail(404, 'confirmation.not_found', 'no such action');
    const standing = action === 'approve' ? (body.standing_rule == null ? 'once' : body.standing_rule) : null;
    if (action === 'approve' && !RULES.includes(standing)) fail(422, 'confirmation.invalid', `standing_rule is one of ${RULES.join(', ')}`);
    const expired = await db.tx(async () => {
        const c = await ownRow(db, actor, id, { lock: true });
        const now = nowIso();
        if (c.state === 'pending' && c.expires_at <= now) {
            await db.prepare("UPDATE dev_confirmations SET state = 'expired' WHERE id = ? AND state = 'pending'").run(c.id);
            await audit(db, c, 'confirmation.expired', { ctx });
            return true;
        }
        if (c.state !== 'pending') fail(409, 'confirmation.not_pending', `confirmation is ${stateOf(c, now)}`);
        let ruleId = null;
        if (standing && standing !== 'once') {
            if (standing === 'session' && !c.session_id) fail(422, 'confirmation.no_session', 'the request carries no session_id');
            const untilAt = standing === 'always' ? null
                : standing === 'session' ? (untilOf(body.until, SESSION_MAX_MS, false) || new Date(Date.now() + SESSION_MAX_MS).toISOString())
                    : untilOf(body.until, UNTIL_MAX_MS, true);
            ruleId = (await db.prepare(`INSERT INTO dev_standing_rules (agent_id, capability, rule, session_id, until_at, source, created_at, created_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(c.agent_id, c.capability, standing, standing === 'session' ? c.session_id : null, untilAt, c.id, now, actor.label)).id;
        }
        const to = action === 'approve' ? 'approved' : 'denied';
        await db.prepare("UPDATE dev_confirmations SET state = ?, standing_rule = ?, decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'")
            .run(to, standing, now, actor.label, c.id);
        await audit(db, c, `confirmation.${to}`, { actor: actor.label, detail: standing ? { standing_rule: standing, rule_id: ruleId == null ? undefined : Number(ruleId) } : {}, ctx });
        return false;
    });
    if (expired) fail(409, 'confirmation.expired', 'the confirmation has expired');
    const c = await ownRow(db, actor, id);
    const out = { confirmation: confirmationView(c) };
    const rule = await db.prepare('SELECT * FROM dev_standing_rules WHERE source = ? ORDER BY id DESC LIMIT 1').get(c.id);
    if (rule) out.rule = ruleView(rule);
    return out;
}

// ── Standing rules, under /api/v1/projects/:project/agents/:agent/rules ──

async function listRules(db, actor, projectId, agentId) {
    const { project } = await store.access(db, actor, projectId, { allowArchived: true });
    const a = await agents.loadAgent(db, project.id, agentId);
    return (await db.prepare('SELECT * FROM dev_standing_rules WHERE agent_id = ? AND revoked_at IS NULL ORDER BY id').all(a.id)).map(ruleView);
}

/** Revoke a standing rule: the agent's owner, an admin+ or staff. */
async function revokeRule(db, actor, projectId, agentId, ruleId, { ctx }) {
    const { project, role } = await store.access(db, actor, projectId, { allowArchived: true });
    const a = await agents.loadAgent(db, project.id, agentId);
    if (!(role && a.owner_subject === actor.subject) && !agents.atLeast(role, 'admin') && !actor.staff) {
        fail(403, 'agent.forbidden', "only the agent's owner, an admin or staff revoke its rules");
    }
    const id = /^[1-9][0-9]{0,17}$/.test(String(ruleId)) ? String(ruleId) : null;
    const rule = id && await db.prepare('SELECT * FROM dev_standing_rules WHERE id = ? AND agent_id = ?').get(id, a.id);
    if (!rule) fail(404, 'rule.not_found', 'no such rule');
    await db.tx(async () => { await revokeRuleRow(db, rule, { actor: actor.label, ctx }); });
    return ruleView(await db.prepare('SELECT * FROM dev_standing_rules WHERE id = ?').get(rule.id));
}

// ── Routes and the sweep ───────────────────────────────────────

/**
 * /api/v1/confirmations — the owner's inbox (Bearer user tokens only, as /api/v1/projects).
 *   GET  /[?state=pending&before=&limit=]   { confirmations, agents, next_before }
 *   GET  /:id                               { confirmation, agent }
 *   POST /:id/approve { standing_rule?, until? }   { confirmation, rule? }
 *   POST /:id/deny                          { confirmation }
 */
function router() {
    const { userApi, handler, finish } = require('./routes');
    const r = userApi();
    const handle = handler();
    r.get('/', handle(async (db, a, req) => await list(db, a, { state: req.query.state, before: req.query.before, limit: req.query.limit })));
    r.get('/:id', handle(async (db, a, req) => await get(db, a, req.params.id)));
    r.post('/:id/approve', handle(async (db, a, req, o) => await decide(db, a, req.params.id, 'approve', req.body || {}, o)));
    r.post('/:id/deny', handle(async (db, a, req, o) => await decide(db, a, req.params.id, 'deny', req.body || {}, o)));
    return finish(r);
}

let timer = null;
function start(db, { intervalMs = 60_000 } = {}) {
    if (timer) return;
    const run = async () => { try { await expireDue(db); } catch (err) { console.warn('[Confirmations] expiry:', err.message); } };
    timer = setInterval(run, intervalMs);
    if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
    create, list, get, decide, consume, cancelFor, expireDue, confirmationView, ruleView, listRules, revokeRule, router, start, stop,
    MAX_PENDING,
};
