'use strict';
/**
 * The menu's AI plans (plan AD.37 "Shared ov-usage in every menu", AD.39 item 9): what is left of the person's coding
 * agents' plan windows (Claude Code's week, Codex's five hours …) and when each resets, read from OpenVibe.Codes
 * (GET /api/v1/me/spare) with the person's own token. Every site's connect-src allows openvibe.network and none allows
 * openvibe.codes, so the menu asks here, the same way it gets Vibes beside OpenCoins (server/coins/routes.js).
 *
 *   GET /api/me/usage → { agents: [{ agent, name, windows: [{ name, left_pct, resets_at }] }], more }
 *
 * Only agents with a window whose use is known, at most six with three windows each. Codes not answering within two
 * seconds, or answering anything but a list, is an empty list: the menu leaves the box out, it never shows an error.
 * Each person's answer is kept for a minute, so opening menus on several sites asks Codes once.
 */
const express = require('express');
const config = require('../config');

const TIMEOUT_MS = 2000;
const KEEP_MS = 60_000;
const KEEP_MAX = 5000;
const MORE = 'https://openvibe.codes/settings/spare';

function shape(body) {
    const agents = Array.isArray(body && body.agents) ? body.agents : [];
    return agents.map((a) => ({
        agent: String(a.agent || '').slice(0, 60),
        name: String(a.name || a.agent || '').slice(0, 60),
        windows: (Array.isArray(a.windows) ? a.windows : [])
            .filter((w) => w && Number.isFinite(Number(w.used_pct)) && w.used_pct !== null)
            .slice(0, 3)
            .map((w) => ({ name: String(w.name || '').slice(0, 40), left_pct: Math.max(0, Math.min(100, 100 - Math.round(Number(w.used_pct)))), resets_at: typeof w.resets_at === 'string' ? w.resets_at.slice(0, 40) : null })),
    })).filter((a) => a.name && a.windows.length).slice(0, 6);
}

module.exports = function createUsageRoutes(requireAuth, opts = {}) {
    const router = express.Router();
    const codesUrl = String(opts.codesUrl || (config.services && config.services.codes && config.services.codes.internalUrl) || '').replace(/\/+$/, '');
    const fetchImpl = opts.fetchImpl || fetch;
    const now = opts.now || (() => Date.now());
    const kept = new Map();   // user id → { at, agents }

    async function agentsOf(req) {
        const auth = req.headers.authorization;
        if (!codesUrl || !auth || !/^Bearer /i.test(auth)) return [];
        const key = String(req.user.id);
        const hit = kept.get(key);
        if (hit && now() - hit.at < KEEP_MS) return hit.agents;
        let agents = [];
        try {
            const r = await fetchImpl(`${codesUrl}/api/v1/me/spare`, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (r.ok) agents = shape(await r.json());
        } catch { agents = []; }
        if (kept.size >= KEEP_MAX) kept.delete(kept.keys().next().value);
        kept.set(key, { at: now(), agents });
        return agents;
    }

    router.get('/', requireAuth, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.json({ agents: await agentsOf(req), more: MORE });
    });
    return router;
};
module.exports.shape = shape;
