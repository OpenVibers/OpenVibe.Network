'use strict';
const express = require('express');
const { requireOwner } = require('../auth/owner-guard');
/** Fixed owner-only Tools paths; no caller-selected URL or path is forwarded. */
function createToolsWorkers({ requireAuth, signToken, services }) {
    const router = express.Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(requireAuth, requireOwner);
    router.use((req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method)) {
            const expected = new URL(req.app.locals.config?.baseUrl || 'https://openvibe.network').origin;
            if (req.headers.origin !== expected) return res.status(403).json({ error: 'Origin required' });
        }
        next();
    });
    const forward = pathFor => async (req, res) => {
        try {
            const path = pathFor(req);
            if (!path) return res.status(400).json({ error: 'Invalid worker id' });
            const token = req.user && req.app.locals.privateKey && typeof signToken === 'function'
                ? signToken(req.user, req.app.locals.privateKey, req.app.locals.config, { renew: req.tokenClaims || {} }) : req.token;
            const target = new URL(path, services.tools.internalUrl);
            const upstream = await fetch(target, {
                method: req.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://openvibe.tools' },
                body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
                signal: AbortSignal.timeout(10000), redirect: 'error',
            });
            res.status(upstream.status).json(await upstream.json());
        } catch { res.status(502).json({ error: 'Could not reach Tools worker controls' }); }
    };
    const worker = suffix => req => /^wrk_[a-f0-9]{24}$/.test(req.params.id) ? `/api/v1/owner/workers/${req.params.id}${suffix}` : null;
    router.get('/fleet', forward(() => '/api/v1/owner/workers'));
    router.post('/workers', forward(() => '/api/v1/owner/workers'));
    router.put('/workers/:id/drain', forward(worker('/drain')));
    router.delete('/workers/:id', forward(worker('')));
    router.get('/routing', forward(() => '/api/v1/owner/worker-routing'));
    router.put('/routing', forward(() => '/api/v1/owner/worker-routing'));
    return router;
}
module.exports = { createToolsWorkers };
