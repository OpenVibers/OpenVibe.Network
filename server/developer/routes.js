'use strict';
const cache = require('openvibe-shared/cache-policy');
/**
 * /api/v1/projects — developer projects for signed-in people (roadmap Wave 20 foundation, ADR-014).
 * The API Codes (the developer portal) calls with the user's Network access token.
 *
 * Authentication: `Authorization: Bearer <Network user access token>` only. Cookies are not read
 * (no CSRF surface), and service or app tokens are not users.
 * Errors are RFC 9457 problems; every response carries X-OpenVibe-Request-Id.
 *
 *   GET    /catalog                                        capabilities apps may ever be granted
 *   POST   /                      { name }                 create (caller becomes owner)
 *   GET    /[?all=1]                                        mine (staff: all=1 lists every project)
 *   GET    /:project                                        viewer+ (non-members: 404)
 *   PATCH  /:project              { name }                 admin+
 *   POST   /:project/archive                                owner or staff; revokes every app
 *   PUT    /:project/allowance    { capabilities: [] }     staff
 *   PUT    /:project/environment-policy { environment_policy }  staff (sandbox | sandbox+production)
 *   PUT    /:project/placement   { preferred_regions, residency? }  admin+ (home_cell/residency are derived)
 *   GET    /:project/members                                viewer+
 *   POST   /:project/members      { username | subject_id, role }  admin+ (owner for admins)
 *   PATCH  /:project/members/:subject { role }             admin+ (owner for admins)
 *   DELETE /:project/members/:subject                      admin+, or yourself
 *   GET    /:project/apps                                   viewer+
 *   POST   /:project/apps         { name, environment, type, redirect_uris }  developer+ (admin+ production)
 *   GET    /:project/apps/:app
 *   PATCH  /:project/apps/:app    { name, redirect_uris }
 *   DELETE /:project/apps/:app                              revoke (developer+ sandbox, admin+ production, staff)
 *   GET    /:project/apps/:app/credentials                  metadata only, never secrets
 *   POST   /:project/apps/:app/credentials/rotate { overlap_seconds }  new secret, shown once
 *   POST   /:project/apps/:app/credentials/:credential/revoke           immediate
 *   GET    /:project/apps/:app/grants
 *   POST   /:project/apps/:app/grants { capability }       developer+ requests; owner/admin get it approved
 *   POST   /:project/apps/:app/grants/:capability/approve   owner/admin, inside the allowance only
 *   POST   /:project/apps/:app/grants/:capability/deny      owner/admin
 *   DELETE /:project/apps/:app/grants/:capability           owner/admin or staff
 *   GET    /:project/agents[?owner=me]                      viewer+ (agents.js, plan T2 WS-Z2)
 *   POST   /:project/agents       { name, host }            for yourself: developer+ (admin+ production app host);
 *                                                           host { type: app, id } of this project or { type: service, id }
 *   GET    /:project/agents/:agent                          viewer+
 *   PATCH  /:project/agents/:agent { name }                 its owner or admin+
 *   POST   /:project/agents/:agent/pause                    its owner, admin+ or staff
 *   POST   /:project/agents/:agent/resume                   its owner or admin+ (not staff)
 *   DELETE /:project/agents/:agent                          revoke, final: its owner, admin+ or staff
 *   GET    /:project/agents/:agent/grants                   viewer+: delegated grants with effective_mode and within_host
 *   PUT    /:project/agents/:agent/grants/:capability { mode, expires_at? }  its owner only, inside the host's ceiling
 *   DELETE /:project/agents/:agent/grants/:capability      revoke: its owner, admin+ or staff
 *   GET    /:project/agents/:agent/budgets                  viewer+: { capability, limit, window, unit, enforced_by }
 *   PUT    /:project/agents/:agent/budgets/:capability { limit, window, unit? }  its owner or admin+ (not staff); needs
 *                                                           an active grant, never beyond the project's quota
 *   DELETE /:project/agents/:agent/budgets/:capability     its owner or admin+ (not staff)
 *   GET    /:project/agents/:agent/rules                    viewer+: the live standing rules (confirmations.js)
 *   DELETE /:project/agents/:agent/rules/:rule             revoke: its owner, admin+ or staff
 *   GET    /:project/quotas                                 viewer+
 *   PUT    /:project/quotas/:capability { limit, window, unit }  staff
 *   DELETE /:project/quotas/:capability                     staff
 *   GET    /:project/usage[?days=30&env=all]               owner/admin or staff: usage per day, quotas and
 *                                                           errors from the services' rollups (usage.js)
 *   GET    /:project/audit[?before=&limit=]                 admin+ or staff
 *   POST   /:project/export-tokens { audience, env }         owner or admin member (not staff as such):
 *                                                           a 5-minute read-only export token (tokens.js)
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { verifySession } = require('../auth/session');
const store = require('./store');
const agents = require('./agents');
const confirmations = require('./confirmations');
const policy = require('./policy');
const tokens = require('./tokens');
const usage = require('./usage');

/**
 * The base of a user API: problems with request ids, JSON bodies, private no-store, and Bearer Network user tokens
 * only (req.actor). Shared with /api/v1/confirmations (confirmations.js).
 */
function userApi() {
    const r = express.Router();
    r.use(http.middleware());
    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', cache.htmlHeaders({ private: true })); next(); });

    // Bearer user tokens only. An expired token is refused here even inside the session grace period:
    // this API hands out secrets, so it does not slide sessions.
    r.use(async (req, res, next) => {
        const h = String(req.headers.authorization || '');
        if (!h.startsWith('Bearer ')) return http.sendProblem(res, 401, 'auth.required', { detail: 'send Authorization: Bearer <Network access token>', ctx: req.ov });
        const { db, publicKey, config } = req.app.locals;
        const out = await verifySession(h.slice(7).trim(), { db, publicKey, config });
        if (out.error) return http.sendProblem(res, out.status === 403 ? 403 : 401, out.status === 403 ? 'auth.banned' : 'auth.invalid', { detail: out.error, ctx: req.ov });
        if (out.decoded && typeof out.decoded.exp === 'number' && out.decoded.exp * 1000 < Date.now()) {
            return http.sendProblem(res, 401, 'auth.expired', { detail: 'access token expired; refresh it', ctx: req.ov });
        }
        try { req.actor = await store.actorOf(db, out.user); } catch (err) { return send(req, res, err); }
        next();
    });
    return r;
}

/** handle(fn, status): fn(db, actor, req, { ctx, settings }) → JSON body, or 204 for undefined; errors as problems. */
function handler() {
    const ctxOf = (req) => ({ ctx: req.ov, settings: policy.settings(req.app.locals.config) });
    return (fn, status = 200) => async (req, res) => {
        try {
            const out = await fn(req.app.locals.db, req.actor, req, ctxOf(req));
            if (out === undefined) return res.status(204).end();
            res.status(status).json(out);
        } catch (err) { send(req, res, err); }
    };
}

/** Malformed JSON and other body errors as problems too. */
function finish(r) {
    r.use((err, req, res, _next) => send(req, res, err));
    return r;
}

function router() {
    const r = userApi();
    const handle = handler();

    r.get('/catalog', (req, res) => res.json({
        capabilities: policy.grantableCatalog(),
        sandbox_allowance: policy.settings(req.app.locals.config).sandboxAllowance,
        rule: 'only active capabilities with visibility public (or partner, by staff allowance) are grantable to apps; sandbox apps may hold sandbox_allowance without staff, production apps only the staff-set project allowance',
    }));

    r.post('/', handle(async (db, a, req, o) => await store.createProject(db, a, req.body || {}, o), 201));
    r.get('/', handle(async (db, a, req, o) => ({ projects: await store.listProjects(db, a, { all: req.query.all === '1', settings: o.settings }) })));
    r.get('/:project', handle(async (db, a, req, o) => {
        const { project, role } = await store.access(db, a, req.params.project, { allowArchived: true });
        return await store.projectView(db, project, role, o.settings);
    }));
    r.patch('/:project', handle(async (db, a, req, o) => await store.renameProject(db, a, req.params.project, req.body || {}, o)));
    r.post('/:project/archive', handle(async (db, a, req, o) => await store.archiveProject(db, a, req.params.project, o)));
    r.put('/:project/allowance', handle(async (db, a, req, o) => await store.setAllowance(db, a, req.params.project, req.body || {}, o)));
    r.put('/:project/environment-policy', handle(async (db, a, req, o) => await store.setEnvironmentPolicy(db, a, req.params.project, req.body || {}, o)));
    r.put('/:project/placement', handle(async (db, a, req, o) => await store.setPlacement(db, a, req.params.project, req.body || {}, o)));

    r.get('/:project/members', handle(async (db, a, req) => ({ members: await store.listMembers(db, a, req.params.project) })));
    r.post('/:project/members', handle(async (db, a, req, o) => await store.addMember(db, a, req.params.project, req.body || {}, o), 201));
    r.patch('/:project/members/:subject', handle(async (db, a, req, o) => await store.updateMember(db, a, req.params.project, req.params.subject, req.body || {}, o)));
    r.delete('/:project/members/:subject', handle(async (db, a, req, o) => await store.removeMember(db, a, req.params.project, req.params.subject, o)));

    r.get('/:project/apps', handle(async (db, a, req) => ({ apps: await store.listApps(db, a, req.params.project) })));
    r.post('/:project/apps', handle(async (db, a, req, o) => await store.createApp(db, a, req.params.project, req.body || {}, o), 201));
    r.get('/:project/apps/:app', handle(async (db, a, req) => await store.getApp(db, a, req.params.project, req.params.app)));
    r.patch('/:project/apps/:app', handle(async (db, a, req, o) => await store.updateApp(db, a, req.params.project, req.params.app, req.body || {}, o)));
    r.delete('/:project/apps/:app', handle(async (db, a, req, o) => await store.revokeApp(db, a, req.params.project, req.params.app, o)));

    r.get('/:project/apps/:app/credentials', handle(async (db, a, req) => ({ credentials: await store.listCredentials(db, a, req.params.project, req.params.app) })));
    r.post('/:project/apps/:app/credentials/rotate', handle(async (db, a, req, o) => await store.rotateCredential(db, a, req.params.project, req.params.app, req.body || {}, o), 201));
    r.post('/:project/apps/:app/credentials/:credential/revoke', handle(async (db, a, req, o) => await store.revokeCredential(db, a, req.params.project, req.params.app, req.params.credential, o)));

    r.get('/:project/apps/:app/grants', handle(async (db, a, req) => ({ grants: await store.listGrants(db, a, req.params.project, req.params.app) })));
    r.post('/:project/apps/:app/grants', handle(async (db, a, req, o) => await store.requestGrant(db, a, req.params.project, req.params.app, req.body || {}, o), 201));
    r.post('/:project/apps/:app/grants/:capability/approve', handle(async (db, a, req, o) => await store.decideGrant(db, a, req.params.project, req.params.app, req.params.capability, 'approved', o)));
    r.post('/:project/apps/:app/grants/:capability/deny', handle(async (db, a, req, o) => await store.decideGrant(db, a, req.params.project, req.params.app, req.params.capability, 'denied', o)));
    r.delete('/:project/apps/:app/grants/:capability', handle(async (db, a, req, o) => await store.decideGrant(db, a, req.params.project, req.params.app, req.params.capability, 'revoked', o)));

    r.get('/:project/agents', handle(async (db, a, req) => ({ agents: await agents.listAgents(db, a, req.params.project, { owner: req.query.owner }) })));
    r.post('/:project/agents', handle(async (db, a, req, o) => await agents.createAgent(db, a, req.params.project, req.body || {}, o), 201));
    r.get('/:project/agents/:agent', handle(async (db, a, req) => await agents.getAgent(db, a, req.params.project, req.params.agent)));
    r.patch('/:project/agents/:agent', handle(async (db, a, req, o) => await agents.renameAgent(db, a, req.params.project, req.params.agent, req.body || {}, o)));
    r.post('/:project/agents/:agent/pause', handle(async (db, a, req, o) => await agents.changeStatus(db, a, req.params.project, req.params.agent, 'pause', o)));
    r.post('/:project/agents/:agent/resume', handle(async (db, a, req, o) => await agents.changeStatus(db, a, req.params.project, req.params.agent, 'resume', o)));
    r.delete('/:project/agents/:agent', handle(async (db, a, req, o) => await agents.changeStatus(db, a, req.params.project, req.params.agent, 'revoke', o)));
    r.get('/:project/agents/:agent/grants', handle(async (db, a, req, o) => ({ grants: await agents.listGrants(db, a, req.params.project, req.params.agent, o) })));
    r.put('/:project/agents/:agent/grants/:capability', handle(async (db, a, req, o) => await agents.putGrant(db, a, req.params.project, req.params.agent, req.params.capability, req.body || {}, o)));
    r.delete('/:project/agents/:agent/grants/:capability', handle(async (db, a, req, o) => await agents.deleteGrant(db, a, req.params.project, req.params.agent, req.params.capability, o)));
    r.get('/:project/agents/:agent/budgets', handle(async (db, a, req) => ({ budgets: await agents.listBudgets(db, a, req.params.project, req.params.agent) })));
    r.put('/:project/agents/:agent/budgets/:capability', handle(async (db, a, req, o) => await agents.setBudget(db, a, req.params.project, req.params.agent, req.params.capability, req.body || {}, o)));
    r.delete('/:project/agents/:agent/budgets/:capability', handle(async (db, a, req, o) => await agents.deleteBudget(db, a, req.params.project, req.params.agent, req.params.capability, o)));
    r.get('/:project/agents/:agent/rules', handle(async (db, a, req) => ({ rules: await confirmations.listRules(db, a, req.params.project, req.params.agent) })));
    r.delete('/:project/agents/:agent/rules/:rule', handle(async (db, a, req, o) => await confirmations.revokeRule(db, a, req.params.project, req.params.agent, req.params.rule, o)));

    r.get('/:project/quotas', handle(async (db, a, req) => ({ quotas: await store.listQuotas(db, a, req.params.project), note: 'quotas are enforced by the service that owns each capability; Network records and exposes them' })));
    r.put('/:project/quotas/:capability', handle(async (db, a, req, o) => await store.setQuota(db, a, req.params.project, req.params.capability, req.body || {}, o)));
    r.delete('/:project/quotas/:capability', handle(async (db, a, req, o) => await store.deleteQuota(db, a, req.params.project, req.params.capability, o)));

    // Usage (WS-N task 4): network.project-usage-result@1, for the owner and admins (and staff).
    r.get('/:project/usage', handle(async (db, a, req) => {
        const { project } = await store.access(db, a, req.params.project, { need: 'admin', allowArchived: true });
        return await usage.summary(db, project.id, usage.parseQuery(req.query));
    }));

    r.get('/:project/audit', handle(async (db, a, req) => {
        const { project } = await store.access(db, a, req.params.project, { need: 'admin', allowArchived: true });
        return await store.listAudit(db, project.id, { before: req.query.before, limit: req.query.limit });
    }));

    // Project export (WS-N task 9): Codes asks with the person's token, once per audience and env.
    r.post('/:project/export-tokens', handle(async (db, a, req, o) => await tokens.mintExportToken(db, a, req.params.project, req.body || {}, {
        privateKey: req.app.locals.privateKey, issuer: req.app.locals.config.jwt.issuer, ctx: o.ctx,
    }), 201));

    return finish(r);
}

function send(req, res, err) {
    if (err instanceof store.DevError || err instanceof usage.UsageQueryError) return http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx: req.ov });
    if (err && err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'request.malformed_json', { detail: 'body is not valid JSON', ctx: req.ov });
    if (err && err.type === 'entity.too.large') return http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
    // Never echo internals (and so never a secret) to the client.
    console.error('[developer] unexpected error:', err && err.code ? err.code : '', err && err.message ? err.message.slice(0, 200) : err);
    return http.sendProblem(res, 500, 'internal.error', { detail: 'unexpected error', ctx: req.ov });
}

module.exports = { router, userApi, handler, finish, send };
