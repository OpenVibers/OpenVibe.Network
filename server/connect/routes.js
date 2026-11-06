'use strict';
/**
 * The Connect API (the Apps page's own backend).
 *
 *   GET    /api/v1/connect/catalogue              the ten apps and whether they are connected
 *   GET    /api/v1/connect/apps/:key              one app: the walkthrough, the actions, the auth kind
 *   POST   /api/v1/connect/apps/:key/test         the test call for a credential that is not stored yet
 *   POST   /api/v1/connect/apps/:key/connect      the test call, then the store (only if it worked)
 *   GET    /api/v1/connect/credentials            the credentials: app, label, scopes, when
 *   DELETE /api/v1/connect/credentials/:app/:label  revoke one
 *   GET    /api/v1/connect/callers                the callers and their grants per app
 *   POST   /api/v1/connect/callers                make a key for one caller of the person's own
 *   DELETE /api/v1/connect/callers/:id            revoke a caller
 *   PUT    /api/v1/connect/callers/:id/grants     one caller's grant in one app
 *   GET    /api/v1/connect/log                    the log
 *   GET    /api/v1/connect/approvals              what waits for the person
 *   POST   /api/v1/connect/approvals/:id          approve or deny
 *   GET    /api/v1/connect/export                 the apps (never the secrets)
 *   PUT    /api/v1/connect/rules                  a standing rule for one recipe
 *
 * Every route needs the person's session. The secret never comes back: a credential is written and
 * then only ever listed as metadata.
 */
const express = require('express');
const vault = require('./vault');
const callers = require('./callers');
const approvals = require('./approvals');
const registry = require('./apps');

class ApiError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail || code; }
}
const fail = (status, code, detail) => { throw new ApiError(status, code, detail); };

function createConnectRoutes({ db, config, requireAuth, gateway, limiter = null } = {}) {
    const router = express.Router();

    // The subject of the person behind the request.
    const subjectOf = (req) => req.user.subject_id || req.user.subject || String(req.user.id);

    /** The credential the person pasted: one string, or one string per field. */
    const credentialOf = (body, def) => {
        const fields = def.auth.fields || [];
        if (fields.length === 1) {
            const value = body.credential;
            if (value && typeof value === 'object') return value[fields[0].name] || null;
            return typeof value === 'string' ? value : null;
        }
        const out = {};
        for (const field of fields) out[field.name] = body.credentials && body.credentials[field.name] ? String(body.credentials[field.name]) : null;
        return out;
    };

    router.use(requireAuth);

    // The catalogue.
    router.get('/catalogue', async (req, res) => {
        const subject = subjectOf(req);
        const list = await vault.list(db, subject);
        const connected = new Set(list.map((c) => c.app));
        res.json({
            apps: registry.summaries().map((app) => ({ ...app, connected: connected.has(app.key) })),
        });
    });

    // One app: everything the walkthrough needs.
    router.get('/apps/:key', async (req, res) => {
        const def = registry.get(req.params.key);
        if (!def) fail(404, 'connect.unknown_app', 'no such app');
        const subject = subjectOf(req);
        const list = await vault.list(db, subject);
        res.json({
            app: {
                key: def.key, name: def.name, vendor: def.vendor, blurb: def.blurb, docsUrl: def.docsUrl || null,
                auth: { kind: def.auth.kind, label: def.auth.label, hint: def.auth.hint || null, scopes: def.auth.scopes || [], fields: def.auth.fields || [] },
                byok: def.byok || null,
                walkthrough: def.walkthrough || [],
                test: def.test ? { summary: def.test.summary } : null,
                actions: (def.actions || []).map((a) => ({ name: a.name, title: a.title, risk: a.risk, description: a.description || '' })),
            },
            credentials: list.filter((c) => c.app === def.key),
        });
    });

    // The test call. Nothing is stored: the person has not said "save it" yet.
    router.post('/apps/:key/test', async (req, res) => {
        const def = registry.get(req.params.key);
        if (!def) fail(404, 'connect.unknown_app', 'no such app');
        const credential = credentialOf(req.body || {}, def);
        if (!credential) fail(422, 'connect.invalid_credential', 'the credential is missing');
        const out = await gateway.test({ subject: subjectOf(req), appKey: def.key, credential });
        res.json(out);
    });

    // Connect: the test call first, and only a credential that works is stored.
    router.post('/apps/:key/connect', async (req, res) => {
        const def = registry.get(req.params.key);
        if (!def) fail(404, 'connect.unknown_app', 'no such app');
        const credential = credentialOf(req.body || {}, def);
        if (!credential) fail(422, 'connect.invalid_credential', 'the credential is missing');
        const subject = subjectOf(req);
        const scopes = Array.isArray((req.body || {}).scopes) ? req.body.scopes.map(String).slice(0, 50) : [];
        // The test call first: a refused test call stores nothing.
        const tested = await gateway.test({ subject, appKey: def.key, credential });
        const fields = def.auth.fields || [];
        const stored = [];
        for (const field of fields) {
            const value = typeof credential === 'object' ? credential[field.name] : credential;
            const label = fields.length === 1 ? 'default' : field.name;
            stored.push(await vault.store(db, subject, def.key, label, value, { scopes, config }));
        }
        res.json({ ok: true, app: def.key, credentials: stored, test: tested });
    });

    // The credentials.
    router.get('/credentials', async (req, res) => {
        res.json({ credentials: await vault.list(db, subjectOf(req)) });
    });

    router.delete('/credentials/:app/:label', async (req, res) => {
        const out = await vault.revoke(db, subjectOf(req), req.params.app, req.params.label);
        res.json(out);
    });

    // The callers.
    router.get('/callers', async (req, res) => {
        res.json({ callers: await callers.listCallers(db, subjectOf(req)) });
    });

    router.post('/callers', async (req, res) => {
        const out = await callers.createKeyCaller(db, subjectOf(req), (req.body || {}).name);
        res.json(out);
    });

    router.delete('/callers/:id', async (req, res) => {
        res.json(await callers.revokeCaller(db, req.params.id));
    });

    router.put('/callers/:id/grants', async (req, res) => {
        const body = req.body || {};
        const level = body.level === null || body.level === '' ? null : String(body.level);
        const out = await callers.setGrant(db, req.params.id, String(body.app || ''), level, subjectOf(req));
        res.json({ grants: out });
    });

    // The log.
    router.get('/log', async (req, res) => {
        res.json({ log: await gateway.listLog({ subject: subjectOf(req), limit: req.query.limit }) });
    });

    // The approvals that wait for the person.
    router.get('/approvals', async (req, res) => {
        const list = await approvals.list(db, subjectOf(req), { state: req.query.state || null });
        res.json({ approvals: list });
    });

    router.post('/approvals/:id', async (req, res) => {
        const out = await approvals.decide(db, subjectOf(req), req.params.id, String((req.body || {}).decision || ''));
        res.json(out);
    });

    // The export: the apps, never the secrets.
    router.get('/export', async (req, res) => {
        res.json({ apps: await vault.exportFor(db, subjectOf(req)) });
    });

    // A standing rule for one recipe.
    router.put('/rules', async (req, res) => {
        const body = req.body || {};
        const out = await approvals.setRule(db, subjectOf(req), String(body.app || ''), String(body.action || ''), body.on !== false);
        res.json(out);
    });

    // Errors: the shape the page reads.
    router.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
        const status = err.status || 500;
        if (status >= 500) console.error('[Connect]', err);
        res.status(status).json({ error: err.code || 'connect.failed', detail: err.detail || err.message || 'the call failed' });
    });

    return router;
}

module.exports = { createConnectRoutes, ApiError };
