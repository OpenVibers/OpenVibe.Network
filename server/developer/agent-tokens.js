'use strict';
/**
 * Agent tokens (plan T2 WS-Z2 slice 8, docs/t2-projects-and-grants.md section 4 "Agent tokens"): the agent's host
 * authenticates at /oauth/token as itself — an app with its client_secret (./tokens.js), a service through
 * principals.issueToken — and adds `agent=agt_…`, `audience` and an optional `scope`.
 *
 * Claims (identity.service-token-claims@1, v0.90.0): sub agent:agt_<ULID>, actor_type agent, aud [audience], cap (the
 * agent's active, unexpired auto grants), cap_confirm (its confirm ones; omitted when none), ns, project_id, env
 * (the agent's environment), on_behalf_of (the owner), act { sub: app:app_… | svc:<host> }, iat, exp (+300 s), jti.
 * Both lists are the delegated grants ∩ the host's ceiling now (agents.ceiling) minus a budget of 0, so a token never
 * holds more than its host may do for the project. A confirm-mode capability is never in `cap`: each use needs an
 * approved confirmation that the owning service consumes (/internal/confirmations), so a receiver that does not know
 * agents refuses it. Signed by Network's RS256 key (the JWKS one), never a shared secret; no refresh.
 *
 * Refusals (OAuth errors; the host's own credentials are checked by the caller first):
 *   400 invalid_grant         one message for every host-binding failure (unknown agent, another host's agent, app of
 *                             another project or environment, revoked app, archived project, agent paused or revoked,
 *                             owner no longer a member, banned or deleted), so a host cannot probe others' agents
 *   400 invalid_request       no audience
 *   400 invalid_target        a sandbox agent asking for an audience that does not accept sandbox tokens
 *   400 invalid_scope         a scope the agent does not hold now (no grant, revoked or expired, outside the host's
 *                             ceiling, budget 0), or nothing at all for the audience
 * Every issuance and refusal writes a dev_audit row (agent.token_issued / agent.token_refused: audience, cap,
 * cap_confirm, jti, expiry, or the error and the internal reason); never a secret or the token.
 */
const crypto = require('crypto');
const { serviceAuth, assertValid, capabilities } = require('openvibe-contracts');
const store = require('./store');
const agents = require('./agents');
const { projectNamespaces, TOKEN_TTL_S } = require('./tokens');

const BINDING = 'unknown agent, or not one this client may act for';

/**
 * Mint a token for `agentId` on behalf of `host` — { kind: 'app', app } or { kind: 'service', clientId } — already
 * authenticated by the caller. → { status, body } (an OAuth token response or error).
 */
async function mint(db, { agentId, host, audience, scope, privateKey, issuer, settings, ctx }) {
    const hostSub = host.kind === 'app' ? `app:${host.app.id}` : `svc:${host.clientId}`;
    const agentOk = agents.AGENT_ID_RE.test(String(agentId || ''));
    const agent = agentOk ? await db.prepare('SELECT * FROM dev_agents WHERE id = ?').get(String(agentId)) : null;
    const refuse = async (error, description, reason, detail = {}) => {
        await store.audit(db, { projectId: agent ? agent.project_id : null, actor: hostSub, action: 'agent.token_refused',
            target: agentOk ? `agent:${agentId}` : null, detail: { error, reason, audience: audience ? String(audience).slice(0, 100) : undefined, ...detail }, ctx });
        return { status: 400, body: { error, error_description: description } };
    };
    const binding = await bindingFailure(db, agent, host);
    if (binding) return await refuse('invalid_grant', BINDING, binding);
    const aud = String(audience || '').trim();
    if (!aud || !/^[a-z0-9.-]+$/.test(aud)) return await refuse('invalid_request', 'audience is required', 'no audience');
    if (agent.environment === 'sandbox' && !settings.sandboxAudiences.has(aud)) {
        return await refuse('invalid_target', `${aud} does not accept sandbox tokens`, 'sandbox audience');
    }

    const held = await heldNow(db, agent, aud, settings);
    const wanted = scope ? String(scope).split(/\s+/).filter(Boolean) : null;
    const missing = wanted ? wanted.filter((w) => !held.has(w)) : [];
    if (missing.length) return await refuse('invalid_scope', `not delegated: ${missing.join(' ')}`, 'scope not held', { missing });
    const chosen = wanted ? [...new Set(wanted)].sort() : [...held.keys()].sort();
    if (!chosen.length) return await refuse('invalid_scope', `no delegated grants for audience ${aud}`, 'nothing held');
    const cap = chosen.filter((c) => held.get(c) === 'auto');
    const capConfirm = chosen.filter((c) => held.get(c) === 'confirm');

    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: issuer, sub: `agent:${agent.id}`, actor_type: 'agent', aud: [aud], cap,
        ...(capConfirm.length ? { cap_confirm: capConfirm } : {}),
        ns: await namespaces(db, agent, aud, chosen),
        project_id: agent.project_id, env: agent.environment, on_behalf_of: agent.owner_subject, act: { sub: hostSub },
        iat: now, exp: now + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    };
    assertValid('identity.service-token-claims@1', claims);
    const token = serviceAuth.signServiceToken(claims, privateKey);
    await store.audit(db, { projectId: agent.project_id, actor: hostSub, action: 'agent.token_issued', target: `agent:${agent.id}`,
        detail: { audience: aud, cap, cap_confirm: capConfirm, jti: claims.jti, expires_at: new Date(claims.exp * 1000).toISOString() }, ctx });
    return { status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: chosen.join(' ') } };
}

/** Why `host` may not mint for `agent` now (an internal reason for the audit row), or null. */
async function bindingFailure(db, agent, host) {
    if (!agent) return 'unknown agent';
    if (host.kind === 'app') {
        if (agent.host_kind !== 'app' || agent.host_app_id !== host.app.id) return 'not the agent\'s host';
        // The 0016 foreign key already ties these; re-read so a future change to it cannot widen tokens.
        if (host.app.project_id !== agent.project_id || host.app.environment !== agent.environment) return 'host app of another project or environment';
        if (host.app.revoked_at) return 'host app revoked';
    } else if (agent.host_kind !== 'service' || agent.host_service !== host.clientId) return 'not the agent\'s host';
    if (agent.status !== 'active') return `agent ${agent.status}`;
    const project = await db.prepare('SELECT archived_at FROM dev_projects WHERE id = ?').get(agent.project_id);
    if (!project || project.archived_at) return 'project archived';
    if (!await store.memberRole(db, agent.project_id, agent.owner_subject)) return 'owner no longer a member';
    const owner = await db.prepare('SELECT is_banned, deleted_at FROM users WHERE subject_id = ?').get(agent.owner_subject);
    if (!owner || Number(owner.is_banned) || owner.deleted_at) return 'owner account not active';
    return null;
}

/**
 * The capabilities the agent holds at `audience` now → Map(capability → 'auto' | 'confirm'): its active, unexpired
 * delegated grants, inside the host's ceiling, without a budget of 0 (the per-capability off switch).
 */
async function heldNow(db, agent, audience, settings) {
    const now = new Date().toISOString();
    const grants = (await db.prepare("SELECT * FROM dev_agent_grants WHERE agent_id = ? AND audience = ? AND status = 'active' ORDER BY capability").all(agent.id, audience))
        .filter((g) => !g.expires_at || g.expires_at > now);
    if (!grants.length) return new Map();
    const ceiling = await agents.ceiling(db, agent, audience, settings);
    const off = new Set((await db.prepare('SELECT capability FROM dev_agent_budgets WHERE agent_id = ? AND limit_value = 0').all(agent.id)).map((b) => b.capability));
    return new Map(grants.filter((g) => ceiling.has(g.capability) && !off.has(g.capability)).map((g) => [g.capability, agents.effectiveMode(g)]));
}

/**
 * ns: an app host's agent names what the app's own token names. A service host's agent names the project's namespaces
 * that the host's own principal_grants rows for these capabilities cover (contracts' namespace matcher); none → [].
 */
async function namespaces(db, agent, audience, chosen) {
    const project = projectNamespaces(agent.project_id);
    if (agent.host_kind === 'app') return project;
    const rows = (await require('../identity/principals').grantsFor(db, agent.host_service, audience)).filter((g) => chosen.includes(g.capability));
    return project.filter((n) => rows.some((g) => capabilities.namespaceAllowed(g.namespaces, n)));
}

module.exports = { mint };
