'use strict';
/**
 * What shipped, network-wide (roadmap WS-A):
 *
 *   GET /api/v1/changelog?service=&limit=&before=   cached proxy of OpenVibe.Blog's network changelog
 *       (its public /api/v1/changelog), so every OpenVibe site's shared "shipped" widget reads it from
 *       openvibe.network, which each site's CSP already allows. CORS *, 60 s cache, stale on failure.
 *   GET /updates[?site=<id|host>]                  the whole network's update log: server-rendered
 *       first page (useful without JavaScript), then openvibe-shared/shipped.js's log view (days,
 *       "Load more", a filter per site, the Patch notes posts).
 */
const express = require('express');

const TTL_MS = 60 * 1000;
const MAX_KEYS = 300;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,120}$/;

function createUpdatesRoutes({ blogUrl = 'http://127.0.0.1:4810', fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const base = String(blogUrl).replace(/\/+$/, '');
    const cache = new Map();   // key -> { at, body }

    function queryOf(q) {
        const out = new URLSearchParams();
        if (q.service && SERVICE_RE.test(String(q.service))) out.set('service', String(q.service));
        const n = parseInt(q.limit, 10);
        out.set('limit', String(Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 20));
        if (q.before && CURSOR_RE.test(String(q.before))) out.set('before', String(q.before));
        return out.toString();
    }

    /** The feed for a normalised query string: fresh from cache, else Blog, else stale, else null. */
    async function feed(qs) {
        const hit = cache.get(qs);
        if (hit && now() - hit.at < TTL_MS) return hit.body;
        try {
            const res = await fetchImpl(`${base}/api/v1/changelog?${qs}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
            if (!res.ok) throw new Error(`blog answered ${res.status}`);
            const body = await res.json();
            if (cache.size >= MAX_KEYS) cache.delete(cache.keys().next().value);
            cache.set(qs, { at: now(), body });
            return body;
        } catch (err) {
            if (log && log.warn) log.warn(`[updates] changelog unavailable: ${err.message}`);
            return hit ? hit.body : null;
        }
    }

    const r = express.Router();
    r.get('/api/v1/changelog', async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        const body = await feed(queryOf(req.query));
        if (!body) return res.status(502).set('Cache-Control', 'no-store').json({ error: 'changelog_unavailable', detail: 'The network changelog could not be read just now.' });
        res.set('Cache-Control', 'public, max-age=60').json(body);
    });
    r.options('/api/v1/changelog', (_req, res) => res.set('Access-Control-Allow-Origin', '*').set('Access-Control-Allow-Methods', 'GET').set('Access-Control-Max-Age', '86400').status(204).end());

    r.get('/updates', async (req, res) => {
        const asked = String(req.query.site || '').toLowerCase().trim();
        const site = serviceFor(asked);
        const body = await feed(queryOf({ service: site, limit: 50 }));
        res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'public, max-age=60');
        // The unfiltered log is the page; a per-site view is a filter of it (followed, not indexed).
        if (asked) res.set('X-Robots-Tag', 'noindex, follow');
        res.send(renderPage({ site, filtered: Boolean(asked), body }));
    });
    return { router: r, feed, queryOf };
}

const SITES = ['live', 'network', 'tools', 'media', 'community', 'chat', 'games', 'blog', 'wiki', 'news', 'reviews', 'deals', 'coupons', 'trade', 'codes', 'host', 'ai', 'search', 'sources', 'events', 'billing', 'tips', 'vip', 'openre', 'sites'];
const NAMES = { ai: 'AI', vip: 'VIP', openre: 'OpenRe' };
const nameOf = (id) => NAMES[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');

/** A registry id from an id or a hostname (openvibe.wiki → wiki, pdf.openvibe.tools → tools). */
function serviceFor(v) {
    const s = String(v || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    if (!s) return null;
    if (SITES.includes(s)) return s;
    if (/(^|\.)openre\.stream$/.test(s)) return 'openre';
    if (/(^|\.)openvibe\.tools$/.test(s)) return 'tools';
    if (/(^|\.)openvibe\.network$/.test(s)) { const sub = s.replace(/\.?openvibe\.network$/, ''); return SITES.includes(sub) ? sub : 'network'; }
    const m = /(?:^|\.)openvibe\.([a-z]+)$/.exec(s);
    return m && SITES.includes(m[1]) ? m[1] : null;
}

function renderPage({ site, filtered, body }) {
    const entries = (body && Array.isArray(body.entries)) ? body.entries : [];
    const posts = (body && Array.isArray(body.posts)) ? body.posts.filter((p) => /^https:\/\//.test(p.url || '')) : [];
    const title = site ? `What shipped on OpenVibe.${nameOf(site)}` : 'What shipped across OpenVibe';
    const days = [];
    for (const e of entries) {
        const d = String(e.deployed_at || '').slice(0, 10);
        if (!days.length || days[days.length - 1].day !== d) days.push({ day: d, list: [] });
        days[days.length - 1].list.push(e);
    }
    const dayHtml = days.map((g) => `<section class="ov-shipped-day"><h3>${esc(g.day)}</h3><div class="ov-shipped-entries">${g.list.map((e) => `<div class="ov-shipped-entry">${/^https:\/\//.test(e.url || '') ? `<a class="ov-shipped-hash" href="${esc(e.url)}" rel="noopener">${esc(e.short || String(e.sha || '').slice(0, 7))}</a>` : ''}${site ? '' : `<span class="ov-shipped-site">${esc(nameOf(e.service))}</span>`}<span class="ov-shipped-text">${esc(e.subject)}</span><span class="ov-shipped-meta">${esc(e.author ? `${e.author} · ` : '')}${esc(String(e.deployed_at || '').slice(11, 16))} UTC</span></div>`).join('')}</div></section>`).join('\n');
    const postsHtml = posts.length ? `<aside class="ov-shipped-posts"><h3>Patch notes</h3><ul>${posts.map((p) => `<li><a href="${esc(p.url)}">${esc(p.title || 'Patch notes')}</a>${p.published_at ? ` <small>${esc(String(p.published_at).slice(0, 10))}</small>` : ''}</li>`).join('')}</ul></aside>` : '';
    const chips = `<nav class="up-sites" aria-label="Sites"><a href="/updates"${site ? '' : ' aria-current="page"'}>Everything</a>${SITES.filter((s) => s !== 'sites').map((s) => `<a href="/updates?site=${s}"${site === s ? ' aria-current="page"' : ''}>${esc(nameOf(s))}</a>`).join('')}</nav>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · OpenVibe.Network</title>
<meta name="description" content="Every change deployed to the OpenVibe network, newest first: each site's commits as they ship, and the Patch notes posts that gather them.">
<link rel="canonical" href="https://openvibe.network/updates${filtered && site ? `?site=${esc(site)}` : ''}">
${filtered ? '<meta name="robots" content="noindex, follow">' : ''}
<link rel="alternate" type="application/json" href="/api/v1/changelog${site ? `?service=${esc(site)}` : ''}">
${require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: '/assets' })}
<meta name="color-scheme" content="dark light">
<script src="/shared/theme-loader.js" defer></script>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg-primary:#0a0f1c;--bg-secondary:#101828;--border:#1f2d47;--accent:#3b82f6;--text-primary:#e6edf7;--text-secondary:#96a7c2;--text-muted:#7386a3}
html,body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
a{color:var(--accent)}
.up{max-width:960px;margin:0 auto;padding:24px 16px 40px}
.up h1{font-size:clamp(1.5rem,4vw,2rem);margin:.2em 0 .3em}.up .lede{color:var(--text-secondary);margin:0 0 18px;line-height:1.55}
.up-sites{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px}.up-sites a{font-size:.8rem;padding:4px 12px;border-radius:999px;border:1px solid var(--border);color:var(--text-secondary);text-decoration:none}
.up-sites a[aria-current]{background:var(--accent-strong,#1d4ed8);border-color:var(--accent-strong,#1d4ed8);color:var(--on-accent-strong,#fff)}
.ov-shipped-day h3{font-size:.95rem;color:var(--text-secondary);border-bottom:1px solid var(--border);padding-bottom:8px;margin:18px 0 4px}
.ov-shipped-entry{display:flex;gap:10px;align-items:baseline;padding:8px 12px;flex-wrap:wrap}.ov-shipped-text{flex:1;min-width:0;overflow-wrap:anywhere}
.ov-shipped-meta{font-size:.75rem;color:var(--text-secondary)}.ov-shipped-hash{font-family:ui-monospace,monospace;font-size:.8rem}
.ov-shipped-site{font-size:.72rem;font-weight:700;padding:.05rem .45rem;border-radius:999px;background:rgba(59,130,246,.16)}
</style>
</head>
<body>
<div id="navbar-mount"></div>
${require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Updates', href: '/updates' }, { label: 'Status', href: '/status' }] })}
<main class="up" id="main">
<h1>${esc(title)}</h1>
<p class="lede">Every change deployed to OpenVibe, newest first. Each line is a commit from the OpenVibers repositories, linked to the change itself. When enough have gathered, or a large feature lands, they are written up as <a href="https://openvibe.blog/@openvibe">Patch notes on openvibe.blog</a>. JSON: <a href="/api/v1/changelog"><code>/api/v1/changelog</code></a>.</p>
${chips}
<div data-ov-shipped="log" data-service="${esc(site || '')}" data-limit="50">
${postsHtml}
${dayHtml || '<p class="ov-shipped-empty">The update history could not be loaded just now.</p>'}
</div>
</main>
${require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact', updates: '/updates' })}
<script src="/shared/navbar.js" defer></script>
<script src="/shared/shipped.js" defer></script>
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:location.origin});}catch(e){}});</script>
</body>
</html>`;
}

module.exports = { createUpdatesRoutes, serviceFor, renderPage };
