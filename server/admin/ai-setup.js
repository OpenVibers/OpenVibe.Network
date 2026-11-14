'use strict';
/**
 * The owner's guided AI setup (Network's /admin/ai/setup), a thin proxy to OpenVibe.AI.
 *
 *   GET    /api/admin/ai/setup                    steps, prices, key pages, spend and caps
 *   PUT    /api/admin/ai/setup/providers/:p/key   write a provider key (AI seals it; it never comes back)
 *   POST   /api/admin/ai/setup/providers/:p/test  one tiny request with that provider
 *   POST   /api/admin/ai/setup/test/:step         one tiny request through the step's route
 *   PUT    /api/admin/ai/setup/routes/:step       pin the model a route uses
 *   PUT    /api/admin/ai/setup/caps/:step         the monthly cap per kind
 *   GET    /api/admin/ai/setup/decisions          the owner's decisions settings, per kind
 *   GET    /api/admin/ai/setup/decisions/models   the models that can answer a decision
 *   PUT    /api/admin/ai/setup/decisions/:kind    the model, the ladder and the threshold of one kind
 *   POST   /api/admin/ai/setup/recommended        fill every route with its recommended model
 *
 * Every route is owner only: API keys and money are the owner's, never any admin's. Network keeps
 * no value: the request body goes to AI and is dropped. AI is called with Network's own service
 * token (ai.provider.manage), and its answer is passed through as JSON. The page is
 * public/js/admin/ai-setup.js; server/admin/routes.js mounts this behind requireOwner.
 */
const express = require('express');
const { requireOwner } = require('../auth/owner-guard');

const AI_CAP = 'ai.provider.manage';
const JSON_TYPE = /^application\/([a-z.+-]+\+)?json\b/i;
const TIMEOUT_MS = 120000;   // a test makes one real provider call, and the speech test runs ffmpeg

function createAiSetup({ fetchImpl = globalThis.fetch, log = console } = {}) {
    const r = express.Router();
    r.use(requireOwner);

    function target(req) {
        const config = req.app.locals.config || {};
        const base = (config.services && config.services.ai && config.services.ai.internalUrl) || 'http://127.0.0.1:4700';
        return String(base).replace(/\/+$/, '');
    }

    async function forward(req, res, path, { method = req.method, body = undefined } = {}) {
        const app = req.app;
        const token = app.locals.selfToken ? app.locals.selfToken('openvibe.ai', [AI_CAP]) : null;
        if (!token) return res.status(503).json({ error: 'Network cannot sign a service token for OpenVibe.AI' });
        let upstream;
        try {
            upstream = await fetchImpl(target(req) + path, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (err) {
            (log.warn || log.log).call(log, `[ai-setup] ${method} ${path}: ${err && err.code ? err.code : 'unreachable'}`);
            return res.status(502).json({ error: 'OpenVibe.AI did not answer; try again in a moment' });
        }
        const text = await upstream.text().catch(() => '');
        res.status(upstream.status);
        if (JSON_TYPE.test(upstream.headers.get('content-type') || '')) return res.type('application/json').send(text || '{}');
        return res.type('text/plain').send(text);
    }

    r.get('/', (req, res) => forward(req, res, '/api/v1/setup'));
    r.get('/state', (req, res) => forward(req, res, '/api/v1/setup'));
    r.put('/providers/:provider/key', (req, res) => forward(req, res, `/api/v1/setup/providers/${encodeURIComponent(req.params.provider)}/key`, { body: req.body || {} }));
    r.post('/providers/:provider/test', (req, res) => forward(req, res, `/api/v1/setup/providers/${encodeURIComponent(req.params.provider)}/test`, { body: req.body || {} }));
    r.post('/test/:step', (req, res) => forward(req, res, `/api/v1/setup/test/${encodeURIComponent(req.params.step)}`, { body: req.body || {} }));
    r.put('/routes/:step', (req, res) => forward(req, res, `/api/v1/setup/routes/${encodeURIComponent(req.params.step)}`, { body: req.body || {} }));
    r.put('/caps/:step', (req, res) => forward(req, res, `/api/v1/setup/caps/${encodeURIComponent(req.params.step)}`, { body: req.body || {} }));
    // The decisions settings (2026-11-14): the model that answers each kind of question, the ladder to
    // escalate along and the confidence below which an answer is escalated, and the models that can answer.
    r.get('/decisions', (req, res) => forward(req, res, '/api/v1/setup/decisions'));
    r.get('/decisions/models', (req, res) => forward(req, res, '/api/v1/decisions/models'));
    r.put('/decisions/:kind', (req, res) => forward(req, res, `/api/v1/setup/decisions/${encodeURIComponent(req.params.kind)}`, { body: req.body || {} }));
    r.post('/recommended', (req, res) => forward(req, res, '/api/v1/setup/recommended', { body: req.body || {} }));
    return r;
}

module.exports = { createAiSetup };
