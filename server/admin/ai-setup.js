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
 *   GET    /api/admin/ai/setup/agents             every coding agent Codes runs (its public catalogue), for the
 *                                                 coding agents step (2026-11-15, plan §AD.9)
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
    // Every coding agent Codes runs: its public catalogue, read here so the owner's page stays on its own origin.
    r.get('/agents', async (req, res) => {
        const config = req.app.locals.config || {};
        const base = String((config.services && config.services.codes && config.services.codes.internalUrl) || 'http://127.0.0.1:4900').replace(/\/+$/, '');
        try {
            // ?all=1 (Codes' codes.harnesses): every agent, the ones turned off marked, with the model each runs by default.
            const upstream = await fetchImpl(`${base}/api/v1/harnesses?all=1`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
            const j = upstream.ok ? await upstream.json() : null;
            const harnesses = (j && Array.isArray(j.harnesses) ? j.harnesses : []).filter((h) => h && typeof h.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(h.id))
                .map((h) => ({
                    id: h.id, name: String(h.name || h.id).slice(0, 80), provider: String(h.provider || '').slice(0, 40), price: h.price && typeof h.price === 'object' ? { text: String(h.price.text || '').slice(0, 120) } : null,
                    off: h.off === true,
                    default_agent: typeof h.default_agent === 'string' ? h.default_agent.slice(0, 64) : null,
                    agents: (Array.isArray(h.agents) ? h.agents : []).filter((x) => x && typeof x.id === 'string').slice(0, 20).map((x) => ({ id: x.id.slice(0, 64), model: String(x.model || x.id).slice(0, 80) })),
                    // Every model the agent runs (Codes data/models.js, from AI's directory), and the owner's default.
                    models: (Array.isArray(h.models) ? h.models : []).filter((m) => m && typeof m.id === 'string' && m.id).slice(0, 800)
                        .map((m) => ({ id: m.id.slice(0, 160), name: String(m.name || m.id).slice(0, 80), note: String(m.note || '').slice(0, 120) })),
                    default_model: typeof h.default_model === 'string' ? h.default_model.slice(0, 160) : null,
                }));
            res.set('Cache-Control', 'private, no-store');
            return res.json({ harnesses });
        } catch (err) {
            (log.warn || log.log).call(log, `[ai-setup] agents: ${err && err.code ? err.code : 'unreachable'}`);
            return res.status(502).json({ error: 'OpenVibe.Codes did not answer; try again in a moment' });
        }
    });
    return r;
}

module.exports = { createAiSetup };
