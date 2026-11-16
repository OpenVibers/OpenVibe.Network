'use strict';

/**
 * The composer's Tools through the Frame (openvibe-shared 4.284.0; the owner, 11-16: the Tools row said "Failed to fetch"
 * on openvibe.live). Every site's Content-Security-Policy lets a page reach openvibe.network; few let it reach
 * openvibe.tools. So the composer asks here, and this asks the Tools gateway on loopback with the caller's address
 * (X-Forwarded-For; the gateway trusts a loopback proxy), so its own limits still count per person.
 *
 *   GET  /api/frame/tools?q=&api=true         the catalogue search          → gateway GET /api/v1/tools
 *   GET  /api/frame/tools/popular             the most used                 → /api/v1/tools/popular
 *   GET  /api/frame/tools/:id                 one tool                      → /api/v1/tools/:id
 *   GET  /api/frame/tools/:id/schema          its input                     → /api/v1/tools/:id/schema
 *   POST /api/frame/tools/:id/run             an anonymous run (JSON ≤ 64 KB) → /api/v1/tools/:id/run
 *
 * Nothing of the person goes along: no cookie, no token. Reads are kept 60 s per URL. A gateway that does not answer is
 * a 502 with a word, never a hang (15 s for a read, 60 s for a run).
 */
const express = require('express');

const ID = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const KEEP_MS = 60_000;

function createFrameTools({ toolsUrl = 'http://127.0.0.1:4001', fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    const base = String(toolsUrl).replace(/\/+$/, '');
    const kept = new Map();
    const router = express.Router();
    const cors = (res) => res.set({
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept', 'Access-Control-Max-Age': '600', Vary: 'Origin',
    });
    router.options(/^\/tools(\/.*)?$/, (_req, res) => { cors(res); res.status(204).end(); });

    async function pass(req, res, path, { method = 'GET', body = null, timeoutMs = 15_000, keep = false } = {}) {
        cors(res);
        const u = new URL(`${base}/api/v1${path}`);
        for (const [k, v] of Object.entries(req.query || {})) if (typeof v === 'string' && /^[a-z_]{1,20}$/.test(k)) u.searchParams.set(k, v.slice(0, 200));
        const key = `${method} ${u.pathname}?${u.searchParams}`;
        if (keep) {
            const hit = kept.get(key);
            if (hit && now() - hit.at < KEEP_MS) { res.status(hit.status).set({ 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=60' }); return res.send(hit.body); }
        }
        let r;
        try {
            r = await fetchImpl(u.href, {
                method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
                headers: { Accept: 'application/json', ...(req.ip ? { 'X-Forwarded-For': req.ip } : {}), ...(body != null ? { 'Content-Type': 'application/json' } : {}) },
                ...(body != null ? { body: JSON.stringify(body) } : {}),
            });
        } catch {
            return res.status(502).json({ error: 'tools.unreachable', detail: 'OpenVibe.Tools did not answer. Try again in a moment.' });
        }
        const type = String(r.headers.get('content-type') || 'application/json');
        const text = await r.text();
        if (keep && r.ok) {
            if (kept.size >= 500) kept.clear();
            kept.set(key, { at: now(), status: r.status, type, body: text });
        }
        const ra = r.headers.get('retry-after');
        if (ra) res.set('Retry-After', ra);
        res.status(r.status).set({ 'Content-Type': type, 'Cache-Control': keep && r.ok ? 'public, max-age=60' : 'no-store' });
        return res.send(text);
    }

    router.get('/tools', (req, res) => pass(req, res, '/tools', { keep: true }));
    router.get('/tools/popular', (req, res) => pass(req, res, '/tools/popular', { keep: true }));
    router.get('/tools/:id', (req, res) => (ID.test(req.params.id) ? pass(req, res, `/tools/${req.params.id}`, { keep: true }) : res.status(404).json({ error: 'tools.not_found' })));
    router.get('/tools/:id/schema', (req, res) => (ID.test(req.params.id) ? pass(req, res, `/tools/${req.params.id}/schema`, { keep: true }) : res.status(404).json({ error: 'tools.not_found' })));
    router.post('/tools/:id/run', express.json({ limit: '64kb' }), (req, res) => {
        if (!ID.test(req.params.id)) { cors(res); return res.status(404).json({ error: 'tools.not_found' }); }
        return pass(req, res, `/tools/${req.params.id}/run`, { method: 'POST', body: req.body && typeof req.body === 'object' ? req.body : {}, timeoutMs: 60_000 });
    });
    return router;
}

module.exports = { createFrameTools };
