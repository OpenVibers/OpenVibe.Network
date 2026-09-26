'use strict';
/**
 * /api/v1/projects — developer projects for signed-in people (roadmap Wave 20 foundation, ADR-014).
 * The API Codes (the developer portal) calls with the user's Network access token.
 *
 * Authentication: `Authorization: Bearer <Network user access token>` only. Cookies are not read
 * (no CSRF surface), X-Internal-Key is never accepted, and service or app tokens are not users.
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
 *   GET    /:project/quotas                                 viewer+
 *   PUT    /:project/quotas/:capability { limit, window, unit }  staff
 *   DELETE /:project/quotas/:capability                     staff
 *   GET    /:project/audit[?before=&limit=]                 admin+ or staff
 *   POST   /:project/export-tokens { audience, env }         owner or admin member (not staff as such):
 *                                                           a 5-minute read-only export token (tokens.js)
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { verifySession } = require('../auth/session');
const store = require('./store');
const policy = require('./policy');
const tokens = require('./tokens');

function router() {
    const r = express.Router();
    r.use(http.middleware());
    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

    // Bearer user tokens only. An expired token is refused here even inside the session grace period:
    // this API hands out secrets, so it does not slide sessions.
    r.use((req, res, next) => {
        const h = String(req.headers.authorization || '');
        if (!h.startsWith('Bearer ')) return http.sendProblem(res, 401, 'auth.required', { detail: 'send Authorization: Bearer <Network access token>', ctx: req.ov });
        const { db, publicKey, config } = req.app.locals;
        const out = verifySession(h.slice(7).trim(), { db, publicKey, config });
        if (out.error) return http.sendProblem(res, out.status === 403 ? 403 : 401, out.status === 403 ? 'auth.banned' : 'auth.invalid', { detail: out.error, ctx: req.ov });
        if (out.decoded && typeof out.decoded.exp === 'number' && out.decoded.exp * 1000 < Date.now()) {
            return http.sendProblem(res, 401, 'auth.expired', { detail: 'access token expired; refresh it', ctx: req.ov });
        }
        try { req.actor = store.actorOf(db, out.user); } catch (err) { return send(req, res, err); }
        next();
    });

    const ctxOf = (req) => ({ ctx: req.ov, settings: policy.settings(req.app.locals.config) });
    const handle = (fn, status = 200) => (req, res) => {
        try {
            const out = fn(req.app.locals.db, req.actor, req, ctxOf(req));
            if (out === undefined) return res.status(204).end();
            res.status(status).json(out);
        } catch (err) { send(req, res, err); }
    };

    r.get('/catalog', (req, res) => res.json({
        capabilities: policy.grantableCatalog(),
        sandbox_allowance: policy.settings(req.app.locals.config).sandboxAllowance,
        rule: 'only active capabilities with visibility public (or partner, by staff allowance) are grantable to apps; sandbox apps may hold sandbox_allowance without staff, production apps only the staff-set project allowance',
    }));

    r.post('/', handle((db, a, req, o) => store.createProject(db, a, req.body || {}, o), 201));
    r.get('/', handle((db, a, req, o) => ({ projects: store.listProjects(db, a, { all: req.query.all === '1', settings: o.settings }) })));
    r.get('/:project', handle((db, a, req, o) => {
        const { project, role } = store.access(db, a, req.params.project, { allowArchived: true });
        return store.projectView(db, project, role, o.settings);
    }));
    r.patch('/:project', handle((db, a, req, o) => store.renameProject(db, a, req.params.project, req.body || {}, o)));
    r.post('/:project/archive', handle((db, a, req, o) => store.archiveProject(db, a, req.params.project, o)));
    r.put('/:project/allowance', handle((db, a, req, o) => store.setAllowance(db, a, req.params.project, req.body || {}, o)));
    r.put('/:project/environment-policy', handle((db, a, req, o) => store.setEnvironmentPolicy(db, a, req.params.project, req.body || {}, o)));

    r.get('/:project/members', handle((db, a, req) => ({ members: store.listMembers(db, a, req.params.project) })));
    r.post('/:project/members', handle((db, a, req, o) => store.addMember(db, a, req.params.project, req.body || {}, o), 201));
    r.patch('/:project/members/:subject', handle((db, a, req, o) => store.updateMember(db, a, req.params.project, req.params.subject, req.body || {}, o)));
    r.delete('/:project/members/:subject', handle((db, a, req, o) => store.removeMember(db, a, req.params.project, req.params.subject, o)));

    r.get('/:project/apps', handle((db, a, req) => ({ apps: store.listApps(db, a, req.params.project) })));
    r.post('/:project/apps', handle((db, a, req, o) => store.createApp(db, a, req.params.project, req.body || {}, o), 201));
    r.get('/:project/apps/:app', handle((db, a, req) => store.getApp(db, a, req.params.project, req.params.app)));
    r.patch('/:project/apps/:app', handle((db, a, req, o) => store.updateApp(db, a, req.params.project, req.params.app, req.body || {}, o)));
    r.delete('/:project/apps/:app', handle((db, a, req, o) => store.revokeApp(db, a, req.params.project, req.params.app, o)));

    r.get('/:project/apps/:app/credentials', handle((db, a, req) => ({ credentials: store.listCredentials(db, a, req.params.project, req.params.app) })));
    r.post('/:project/apps/:app/credentials/rotate', handle((db, a, req, o) => store.rotateCredential(db, a, req.params.project, req.params.app, req.body || {}, o), 201));
    r.post('/:project/apps/:app/credentials/:credential/revoke', handle((db, a, req, o) => store.revokeCredential(db, a, req.params.project, req.params.app, req.params.credential, o)));

    r.get('/:project/apps/:app/grants', handle((db, a, req) => ({ grants: store.listGrants(db, a, req.params.project, req.params.app) })));
    r.post('/:project/apps/:app/grants', handle((db, a, req, o) => store.requestGrant(db, a, req.params.project, req.params.app, req.body || {}, o), 201));
    r.post('/:project/apps/:app/grants/:capability/approve', handle((db, a, req, o) => store.decideGrant(db, a, req.params.project, req.params.app, req.params.capability, 'approved', o)));
    r.post('/:project/apps/:app/grants/:capability/deny', handle((db, a, req, o) => store.decideGrant(db, a, req.params.project, req.params.app, req.params.capability, 'denied', o)));
    r.delete('/:project/apps/:app/grants/:capability', handle((db, a, req, o) => store.decideGrant(db, a, req.params.project, req.params.app, req.params.capability, 'revoked', o)));

    r.get('/:project/quotas', handle((db, a, req) => ({ quotas: store.listQuotas(db, a, req.params.project), note: 'quotas are enforced by the service that owns each capability; Network records and exposes them' })));
    r.put('/:project/quotas/:capability', handle((db, a, req, o) => store.setQuota(db, a, req.params.project, req.params.capability, req.body || {}, o)));
    r.delete('/:project/quotas/:capability', handle((db, a, req, o) => store.deleteQuota(db, a, req.params.project, req.params.capability, o)));

    r.get('/:project/audit', handle((db, a, req) => {
        const { project } = store.access(db, a, req.params.project, { need: 'admin', allowArchived: true });
        return store.listAudit(db, project.id, { before: req.query.before, limit: req.query.limit });
    }));

    // Project export (WS-N task 9): Codes asks with the person's token, once per audience and env.
    r.post('/:project/export-tokens', handle((db, a, req, o) => tokens.mintExportToken(db, a, req.params.project, req.body || {}, {
        privateKey: req.app.locals.privateKey, issuer: req.app.locals.config.jwt.issuer, ctx: o.ctx,
    }), 201));

    // Malformed JSON and other body errors as problems too.
    r.use((err, req, res, _next) => send(req, res, err));
    return r;
}

function send(req, res, err) {
    if (err instanceof store.DevError) return http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx: req.ov });
    if (err && err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'request.malformed_json', { detail: 'body is not valid JSON', ctx: req.ov });
    if (err && err.type === 'entity.too.large') return http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
    // Never echo internals (and so never a secret) to the client.
    console.error('[developer] unexpected error:', err && err.code ? err.code : '', err && err.message ? err.message.slice(0, 200) : err);
    return http.sendProblem(res, 500, 'internal.error', { detail: 'unexpected error', ctx: req.ov });
}

module.exports = { router };
