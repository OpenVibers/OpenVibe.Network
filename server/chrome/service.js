'use strict';
// ═══════════════════════════════════════════════════════════════
// Shared chrome data: what the navbar and footer of every site show.
//
//   GET /api/chrome?host=<hostname>     public, CORS *, max-age=600, ETag
//   → { updated, nav: [{ id, name, url, icon, tagline }],            open sites, most used first
//       soon: [{ id, name, url, icon, state }],                       state: internal | placeholder
//       footer: { blurb, discover: [{ name, url }], popular: [{ name, url }], legal: { terms, privacy, dmca } } }
//
// Ranking: page views and visitors from each service's own analytics (last 7 days) plus signed-in
// cross-site history, refreshed every 30 minutes and kept in the database so a restart or an
// unreachable service never reorders the network at random. Only totals cross the wire.
// Copy: once a day the configured AI (through OpenVibe.Live's internal API) may write a blurb per
// site and pick "discover" links BY ID from a list we supply; ids resolve to our own URLs here, text
// is stripped, length-capped and screened. No AI, or a bad answer → the hand-written copy stays.
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const { SITES, siteForHost } = require('./sites');
const toolsCatalog = require('../domains/catalog');

const RANK_MS = 30 * 60_000, COPY_MS = 24 * 60 * 60_000;
const BANNED = /\b(free|\$0|no ads|ad[- ]free|no cost|gratis)\b|https?:|www\.|[<>{}]/i;
const BASE_WEIGHT = { live: 6, tools: 5, community: 4, games: 3, media: 2, network: 1 };   // cold-start order only

/**
 * Footer copy comes from OpenVibe.AI's network.site_copy workflow (roadmap Wave 13, ADR-015), called with a
 * self-signed Network service token (sub svc:network, aud openvibe.ai, cap ai.run.create, ns network.*).
 * Live's /internal/ai/site-copy stays only as a fallback while AI is unreachable.
 */
function aiSiteCopy({ privateKey, issuer, aiUrl }) {
    const { serviceAuth } = require('openvibe-contracts');
    let cached = null;
    function token() {
        const now = Math.floor(Date.now() / 1000);
        if (cached && cached.exp - 60 > now) return cached.token;
        const claims = { iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.ai'], cap: ['ai.run.create', 'ai.run.read'], ns: ['network.*'], iat: now, exp: now + 300, jti: `tok_${require('crypto').randomBytes(12).toString('hex')}` };
        cached = { token: serviceAuth.signServiceToken(claims, privateKey), exp: claims.exp };
        return cached.token;
    }
    return async function run(body) {
        const r = await fetch(`${aiUrl}/api/v1/runs?wait=90000`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify({ workflow: 'network.site_copy', input: body }),
            signal: AbortSignal.timeout(100_000),
        });
        if (!r.ok) return null;
        const j = await r.json().catch(() => null);
        const run = j && j.run;
        if (!run || run.status !== 'succeeded' && run.status !== 'cached' || !run.output || !Array.isArray(run.output.sites)) return null;
        return { sites: run.output.sites, model: (run.model && (run.model.key || run.model.id)) || (run.route && run.route.key) || 'openvibe.ai' };
    };
}

function createChromeService(db, config, analytics, { privateKey = null, issuer = null, aiUrl = process.env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700' } = {}) {
    const fromAi = privateKey && issuer ? aiSiteCopy({ privateKey, issuer, aiUrl: String(aiUrl).replace(/\/+$/, '') }) : null;
    db.exec('CREATE TABLE IF NOT EXISTS chrome_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    // Anonymous page-view counts per host and day, sent by the shared navbar. No user, no IP, no path.
    db.exec('CREATE TABLE IF NOT EXISTS chrome_hits (day TEXT NOT NULL, host TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, host))');
    const bump = db.prepare("INSERT INTO chrome_hits (day, host, hits) VALUES (date('now'), ?, 1) ON CONFLICT(day, host) DO UPDATE SET hits = hits + 1");
    const load = (k) => { try { const r = db.prepare('SELECT value, updated_at FROM chrome_cache WHERE key = ?').get(k); return r ? { value: JSON.parse(r.value), at: Date.parse(r.updated_at + 'Z') || 0 } : null; } catch { return null; } };
    const save = (k, v) => db.prepare('INSERT INTO chrome_cache (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').run(k, JSON.stringify(v));

    let rank = (load('rank') || {}).value || { scores: {}, tools: [] };
    let copy = (load('copy') || {}).value || { sites: {} };
    let version = Date.now();

    const svcUrl = (name, fallback) => (config.services && config.services[name] && config.services[name].internalUrl) || fallback;
    async function getJson(url, headers) {
        try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) }); return r.ok ? await r.json() : null; } catch { return null; }
    }

    async function refreshRank() {
        const scores = Object.assign({}, rank.scores);
        // Live runs its own navbar and its own analytics: ask it for totals (internal key, totals only).
        const live = await getJson(`${svcUrl('live', 'http://127.0.0.1:3000')}/internal/analytics-summary?days=7`, { 'X-Internal-Key': config.internalKey });
        if (live && live.summary) scores.live = Math.round(Number(live.summary.total_pageviews) || 0);
        // Everything else: the navbar's page-view beacon, summed per site over 7 days.
        let tools = rank.tools || [];
        try {
            const rows = db.prepare("SELECT host, SUM(hits) AS n FROM chrome_hits WHERE day >= date('now', '-7 days') GROUP BY host").all();
            const perSite = {}; const perTool = new Map();
            const { catalog } = toolsCatalog.peek();
            const toolOfHost = new Map();
            for (const t of catalog.tools) for (const h of [t.hosts && t.hosts.canonical, t.hosts && t.hosts.short, ...((t.hosts && t.hosts.aliases) || [])]) if (h) toolOfHost.set(h, t.id);
            for (const r of rows) {
                const site = siteForHost(r.host) || (toolOfHost.has(r.host) ? { id: 'tools' } : null);
                if (!site) continue;
                perSite[site.id] = (perSite[site.id] || 0) + r.n;
                const tool = toolOfHost.get(r.host); if (tool) perTool.set(tool, (perTool.get(tool) || 0) + r.n);
            }
            for (const [id, n] of Object.entries(perSite)) if (id !== 'live') scores[id] = Math.round(id === 'network' ? n * 0.5 : n);   // the account desk is not a destination
            if (perTool.size) tools = [...perTool.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(x => x[0]);
        } catch { /* */ }
        // Signed-in history is a second opinion that also covers hosts without the shared navbar.
        try {
            const bySvc = db.prepare("SELECT service, COUNT(*) AS n, COUNT(DISTINCT user_id) AS u FROM user_history WHERE created_at > datetime('now', '-14 days') GROUP BY service").all();
            for (const r of bySvc) { const id = r.service === 'pastes' ? 'community' : r.service; if (!id) continue; scores[id + ':history'] = r.n + 5 * r.u; }
        } catch { /* table appears on first history write */ }
        rank = { scores, tools };
        save('rank', rank); version = Date.now();
    }

    const scoreOf = (id) => (rank.scores[id] || 0) + 3 * (rank.scores[id + ':history'] || 0);
    function orderedOpen() {
        const open = SITES.filter(s => s.status === 'open');
        const max = Math.max(1, ...open.map(s => scoreOf(s.id)));
        // Real use decides; the base weight only breaks ties and orders a cold start.
        return open.map(s => ({ s, v: scoreOf(s.id) / max + (BASE_WEIGHT[s.id] || 0) / 100 })).sort((a, b) => b.v - a.v).map(x => x.s);
    }

    function linkPool() {
        const { catalog } = toolsCatalog.peek();
        const pool = new Map();
        for (const s of SITES.filter(x => x.status === 'open')) pool.set('site:' + s.id, { name: 'OpenVibe.' + s.name, url: `https://${s.host}/`, about: s.tagline });
        for (const f of catalog.families) if (f.path) pool.set('family:' + f.id, { name: f.name, url: 'https://openvibe.tools' + f.path, about: f.tagline });
        for (const t of catalog.tools) pool.set('tool:' + t.id, { name: t.name, url: t.url, about: t.tagline });
        return pool;
    }
    function popularTools(limit) {
        const { catalog } = toolsCatalog.peek();
        const byId = new Map(catalog.tools.map(t => [t.id, t]));
        const seed = ['yt', 'convert', 'mergepdf', 'jsonfmt', 'mp3', 'dns', 'whois', 'compress'];
        return [...new Set([...(rank.tools || []), ...seed])].map(id => byId.get(id)).filter(Boolean).slice(0, limit).map(t => ({ name: t.name, url: t.url }));
    }

    async function refreshCopy() {
        if (!fromAi && (!config.internalKey || config.internalKey === 'change-me-in-production')) return;
        const pool = linkPool();
        const popular = new Set(popularTools(12).map(t => t.url));
        const links = [...pool.entries()].filter(([id, l]) => !id.startsWith('tool:') || popular.has(l.url)).map(([id, l]) => ({ id, name: l.name, about: l.about }));
        const body = { sites: SITES.filter(s => s.status === 'open').map(s => ({ id: s.id, name: 'OpenVibe.' + s.name, what: s.what, popular: s.id === 'tools' ? popularTools(6).map(t => t.name) : [] })), links };
        let j = null;
        if (fromAi) { try { j = await fromAi(body); } catch { j = null; } }
        if (!j && config.internalKey && config.internalKey !== 'change-me-in-production') {
            try {
                const r = await fetch(`${svcUrl('live', 'http://127.0.0.1:3000')}/internal/ai/site-copy`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Key': config.internalKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
                j = r.ok ? await r.json() : null;
            } catch { j = null; }
        }
        if (!j || !Array.isArray(j.sites)) return;
        const next = {};
        for (const row of j.sites) {
            const site = SITES.find(s => s.id === row.id); if (!site) continue;
            const blurb = String(row.blurb || '').replace(/\s+/g, ' ').trim();
            const picks = (Array.isArray(row.picks) ? row.picks : []).filter(id => pool.has(id) && id !== 'site:' + site.id).slice(0, 4);
            if (blurb.length < 20 || blurb.length > 170 || BANNED.test(blurb)) continue;      // screened out: the hand-written copy stays
            next[site.id] = { blurb, picks };
        }
        if (Object.keys(next).length) { copy = { sites: next, model: String(j.model || '').slice(0, 60) }; save('copy', copy); version = Date.now(); }
    }

    function payloadFor(hostname) {
        const site = siteForHost(hostname) || SITES.find(s => s.id === 'network');
        const open = orderedOpen(); const pool = linkPool();
        const ai = copy.sites[site.id];
        const discover = (ai ? ai.picks.map(id => pool.get(id)) : open.filter(s => s.id !== site.id).slice(0, 4).map(s => pool.get('site:' + s.id))).filter(Boolean).map(l => ({ name: l.name, url: l.url }));
        // Legal documents live on the site's own apex, so each domain answers for itself.
        const legalBase = `https://${site.host}`;
        return {
            updated: new Date(version).toISOString(), site: { id: site.id, name: site.name, host: site.host, status: site.status, state: site.state },
            nav: open.map(s => ({ id: s.id, name: s.name, url: `https://${s.host}/`, icon: s.icon, tagline: s.tagline })),
            // state: 'internal' (runs on loopback, the domain still shows a placeholder) or 'placeholder' (planned).
            soon: SITES.filter(s => s.status === 'soon').map(s => ({ id: s.id, name: s.name, url: `https://${s.host}/`, icon: s.icon, state: s.state })),
            footer: { blurb: (ai && ai.blurb) || site.what, ai: !!ai, discover, popular: popularTools(8), legal: { terms: legalBase + '/terms', privacy: legalBase + '/privacy', dmca: legalBase + '/dmca' } },
        };
    }

    const router = express.Router();
    const cache = new Map();
    router.get('/', (req, res) => {
        const host = String(req.query.host || '').toLowerCase().slice(0, 255);
        const site = siteForHost(host) || { id: 'network' };
        let e = cache.get(site.id);
        if (!e || e.version !== version) { const body = JSON.stringify(payloadFor(host)); e = { version, body, etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 18) + '"' }; cache.set(site.id, e); }
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=600, stale-while-revalidate=86400', ETag: e.etag, 'Content-Type': 'application/json; charset=utf-8' });
        if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
        res.send(e.body);
    });

    // POST /api/chrome/hit — one anonymous count for the calling page's host. The host comes from the
    // browser-set Origin header (never the body) and must be one of ours or a registered tool domain.
    const recent = new Map();   // ip → [count, windowStart]: 40/min is plenty for a person, useless for stuffing
    router.post('/hit', (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        try {
            const ua = String(req.headers['user-agent'] || '');
            let host = ''; try { host = new URL(String(req.headers.origin || '')).hostname.toLowerCase(); } catch { /* */ }
            const now = Date.now(); const k = req.ip || ''; const w = recent.get(k);
            if (!w || now - w[1] > 60_000) recent.set(k, [1, now]); else w[0]++;
            if (recent.size > 5000) recent.clear();
            const known = host && (siteForHost(host) || toolsCatalog.peek().catalog.tools.some(t => t.hosts && (t.hosts.canonical === host || t.hosts.short === host)));
            if (known && (recent.get(k) || [0])[0] <= 40 && !/bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python|node|go-http/i.test(ua)) bump.run(host);
        } catch { /* counting must never fail a page */ }
        res.status(204).end();
    });

    function start() {
        const rankAge = Date.now() - ((load('rank') || {}).at || 0), copyAge = Date.now() - ((load('copy') || {}).at || 0);
        const t1 = setTimeout(() => refreshRank().catch(() => {}), rankAge > RANK_MS ? 8000 : RANK_MS - rankAge); t1.unref();
        const i1 = setInterval(() => refreshRank().catch(() => {}), RANK_MS); i1.unref();
        const t2 = setTimeout(() => refreshCopy().catch(() => {}), copyAge > COPY_MS ? 60_000 : COPY_MS - copyAge); t2.unref();
        const i2 = setInterval(() => refreshCopy().catch(() => {}), COPY_MS); i2.unref();
    }

    return { router, start, refreshRank, refreshCopy, payloadFor, _state: () => ({ rank, copy }) };
}

module.exports = { createChromeService, BANNED };
