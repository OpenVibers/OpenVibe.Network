'use strict';
/**
 * The network's GitHub API token (read-only, public repositories). GitHub allows 60 anonymous
 * requests an hour per address, shared by everything on the host; with a token it is 5,000.
 *
 * Where it comes from (server/secrets.js, key github_token): GITHUB_TOKEN in network.env first, else
 * the value the owner saves in admin (Settings → GitHub). The value is never shown or logged: admin
 * sees its source and last four characters, and a test that asks GitHub for the token's rate limit.
 *
 * Who reads it:
 *   Network itself         the registry's library tags (server/registry/library-tags.js)
 *   OpenVibe.Blog          the network changelog, over GET /internal/integrations/github-token with its
 *                          service token (capability network.integration.github.read, granted to blog only)
 */
const express = require('express');
const secrets = require('../secrets');
const { requireOwner } = require('../auth/owner-guard');

const KEY = 'github_token';
// Classic (ghp_/gho_/ghs_/ghu_/ghr_), fine-grained (github_pat_) and legacy 40-hex tokens.
const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255}|[0-9a-f]{40})$/;

function tokenOf(db) {
    const v = db.getSetting ? db.getSetting(KEY) : null;
    return v && String(v).trim() ? String(v).trim() : null;
}

function status(db) {
    const t = tokenOf(db);
    return { source: secrets.source(db, KEY), env: secrets.envName(KEY), set: Boolean(t), last4: t ? t.slice(-4) : null,
        used_by: ['the registry library versions (Network)', 'the network changelog and Patch notes (OpenVibe.Blog)'] };
}

async function test(token, fetchImpl = globalThis.fetch) {
    const res = await fetchImpl('https://api.github.com/rate_limit', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenVibe.Network', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    const core = (body.resources && body.resources.core) || body.rate || {};
    return { ok: res.ok, status: res.status, authenticated: Boolean(token) && res.ok && (core.limit || 0) > 60,
        limit: core.limit ?? null, remaining: core.remaining ?? null, reset: core.reset ? new Date(core.reset * 1000).toISOString() : null,
        message: res.ok ? null : String(body.message || `GitHub answered ${res.status}`).slice(0, 200) };
}

/** Owner-only admin routes, mounted at /api/admin/integrations/github behind requireAuth. */
function adminRouter(db, { fetchImpl = globalThis.fetch } = {}) {
    const r = express.Router();
    r.use(requireOwner);
    r.get('/', (req, res) => res.json({ ok: true, github: status(db) }));
    r.put('/', express.json({ limit: '4kb' }), (req, res) => {
        if (secrets.source(db, KEY) === 'env') return res.status(409).json({ ok: false, error: `Set in the environment (${secrets.envName(KEY)}); change it there` });
        const token = String((req.body && req.body.token) || '').trim();
        if (!TOKEN_RE.test(token)) return res.status(400).json({ ok: false, error: 'That does not look like a GitHub token (ghp_…, github_pat_…)' });
        db.prepare('INSERT OR REPLACE INTO site_settings (key, value, type) VALUES (?, ?, ?)').run(KEY, token, 'secret');
        db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(req.user.id, 'integration_update', JSON.stringify({ integration: 'github', last4: token.slice(-4) }));
        res.json({ ok: true, github: status(db) });
    });
    r.delete('/', (req, res) => {
        if (secrets.source(db, KEY) === 'env') return res.status(409).json({ ok: false, error: `Set in the environment (${secrets.envName(KEY)}); change it there` });
        db.prepare("UPDATE site_settings SET value = '' WHERE key = ?").run(KEY);
        db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(req.user.id, 'integration_update', JSON.stringify({ integration: 'github', cleared: true }));
        res.json({ ok: true, github: status(db) });
    });
    r.post('/test', async (req, res) => {
        try { res.json({ ok: true, test: await test(tokenOf(db), fetchImpl) }); }
        catch (err) { res.status(502).json({ ok: false, error: `GitHub could not be reached: ${err.message}` }); }
    });
    return r;
}

/** GET /internal/integrations/github-token for a service holding network.integration.github.read. */
function internalHandler(db) {
    return (req, res) => {
        const t = tokenOf(db);
        res.set('Cache-Control', 'no-store');
        if (!t) return res.status(404).json({ error: 'not_configured', detail: 'No GitHub token is set (admin → Settings → GitHub, or GITHUB_TOKEN)' });
        res.json({ token: t, source: secrets.source(db, KEY) });
    };
}

module.exports = { adminRouter, internalHandler, tokenOf, status, test, TOKEN_RE, KEY };
