'use strict';
/**
 * Open stats (owner, 2026-10-27: "on the network site, we should publish the stats for all of the different platforms
 * and publish all the full analytics … make it all public for everyone to see"): every OpenVibe site's numbers on one
 * page, for anyone, and the same numbers as JSON and CSV for agents and bots.
 *
 *   GET /stats                          server-rendered, indexable, works without JavaScript; ?days=7|30|90
 *   GET /api/v1/stats                   the same numbers as JSON (CORS *); ?days=7|30|90
 *   GET /api/v1/stats/pageviews.csv     day,site,pageviews over the window
 *
 * Counts only, never about a person:
 *   - page views per site and day: the shared navbar's anonymous beacon (frame_hits: day, host, hits), and
 *     OpenVibe.Live's own analytics (live.analytics.read: totals, unique visitors, signed-in people)
 *   - accounts (Network's users, no guests or banned accounts) and OpenCoins (Network's ledger)
 *   - requests, server errors and response time per service over 24 hours, and the busiest pages (Prometheus, by
 *     route template: never a URL with anyone's data in it)
 *   - OpenVibe.Live's public home numbers (live now, watching, streamers, messages, recordings)
 *   - how many services answered their last health check (the status registry)
 * Each source is optional: one that does not answer leaves its part out, never a made-up zero. Everything is held for
 * five minutes, so the page is cheap however many people read it.
 */
const express = require('express');
const seo = require('openvibe-shared/seo');
const icons = require('openvibe-shared/ov-icons');
const { SITES, siteForHost, ICON_ALIAS } = require('../frame/sites');

const esc = seo.esc;
const DAY = 86400000;
const WINDOWS = [7, 30, 90];
const TTL_MS = 5 * 60 * 1000;
// Routes that are plumbing, not something a person uses (as the admin insights): left out of the busiest pages.
const PLUMBING = /^(\/metrics|\/api\/(ready|health)|static|\/release\.json|\/robots\.txt|\/favicon\.ico|\/internal\/|\/api\/frame\/hit|\/oauth\/token|\/\.well-known\/|\/api\/admin)/;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const fmt = (n) => {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n), a = Math.abs(v);
    if (a >= 1e9) return `${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '')}B`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (a >= 1e5) return `${Math.round(v / 1e3)}k`;
    return Math.round(v).toLocaleString('en-US');
};
const exact = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
/** Change against the window before, as a percentage, or null when there is nothing to compare with. */
const change = (now, before) => (before > 0 && now != null ? Math.round(((now - before) / before) * 100) : null);
function windowOf(q) { const d = parseInt(q, 10); return WINDOWS.includes(d) ? d : 30; }

function createOpenStats({ db, selfToken = () => null, statusRows = () => [], prometheusUrl, liveUrl, release = null, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    const prom = String(prometheusUrl || 'http://127.0.0.1:9090').replace(/\/+$/, '');
    const live = String(liveUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const cache = new Map();   // days → { at, promise }

    async function getJson(url, headers) {
        try {
            const r = await fetchImpl(url, { headers: { Accept: 'application/json', ...(headers || {}) }, signal: AbortSignal.timeout(6000) });
            return r.ok ? await r.json() : null;
        } catch { return null; }
    }
    const all = async (sql, ...p) => { try { return await db.prepare(sql).all(...p); } catch { return null; } };
    const one = async (sql, ...p) => { try { const r = await db.prepare(sql).get(...p); return r ? num(r.n) : null; } catch { return null; } };

    /** The days of the window, oldest first. */
    function daysOf(days) { const out = []; const t = now(); for (let i = days - 1; i >= 0; i--) out.push(dayOf(t - i * DAY)); return out; }

    // ── Page views: the navbar beacon per site and day, two windows back (this one, and the one before) ──
    async function pageviews(days) {
        const since = dayOf(now() - (2 * days - 1) * DAY);
        const rows = await all('SELECT day, host, SUM(hits)::bigint AS n FROM frame_hits WHERE day >= ? GROUP BY day, host', since);
        if (!rows) return null;
        const window = new Set(daysOf(days));
        const bySite = new Map();
        for (const r of rows) {
            const site = siteForHost(r.host);
            if (!site) continue;
            let e = bySite.get(site.id);
            if (!e) { e = { daily: new Map(), total: 0, prev: 0 }; bySite.set(site.id, e); }
            const n = Number(r.n) || 0;
            if (window.has(r.day)) { e.total += n; e.daily.set(r.day, (e.daily.get(r.day) || 0) + n); } else e.prev += n;
        }
        return bySite;
    }

    // ── OpenVibe.Live counts its own page views (its own navbar and analytics): totals for the windows ──
    async function livePageviews(days) {
        const token = selfToken('openvibe.live', ['live.analytics.read']);
        if (!token) return null;
        const ask = async (d) => {
            const j = await getJson(`${live}/internal/analytics-summary?days=${d}`, { Authorization: `Bearer ${token}` });
            return j && j.summary ? j.summary : null;
        };
        const [cur, both] = await Promise.all([ask(days), days * 2 <= 90 ? ask(days * 2) : null]);
        if (!cur) return null;
        const total = num(cur.total_pageviews);
        return {
            total, prev: both && total != null && num(both.total_pageviews) != null ? Math.max(0, num(both.total_pageviews) - total) : null,
            visitors: num(cur.total_unique_visitors), people: num(cur.total_unique_users), bots: num(cur.total_bot_hits),
        };
    }

    // ── Accounts and OpenCoins: Network's own tables ──
    async function accounts(days) {
        const real = 'COALESCE(is_anon, 0) = 0 AND COALESCE(is_banned, 0) = 0';
        const since = (d) => new Date(now() - d * DAY).toISOString().slice(0, 19).replace('T', ' ');
        const total = await one(`SELECT COUNT(*) AS n FROM users WHERE ${real}`);
        if (total == null) return null;
        const rows = await all(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE ${real} AND created_at >= ? GROUP BY 1`, since(days));
        const map = new Map((rows || []).map((r) => [r.day, Number(r.n) || 0]));
        const daily = daysOf(days).map((d) => ({ day: d, n: map.get(d) || 0 }));
        return {
            total, new: daily.reduce((a, d) => a + d.n, 0),
            prev: await one(`SELECT COUNT(*) AS n FROM users WHERE ${real} AND created_at >= ? AND created_at < ?`, since(2 * days), since(days)),
            daily,
        };
    }
    async function coins(days) {
        const since = (d) => new Date(now() - d * DAY).toISOString().slice(0, 19).replace('T', ' ');
        const earned = await one('SELECT COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0');
        if (earned == null) return null;
        const rows = await all("SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0 AND created_at >= ? GROUP BY 1", since(days));
        const map = new Map((rows || []).map((r) => [r.day, Number(r.n) || 0]));
        return {
            earned,
            spent: await one('SELECT COALESCE(-SUM(delta), 0) AS n FROM coin_transactions WHERE delta < 0'),
            holders: await one('SELECT COUNT(*) AS n FROM wallets WHERE balance > 0'),
            transactions: await one('SELECT COUNT(*) AS n FROM coin_transactions'),
            earned_window: await one('SELECT COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0 AND created_at >= ?', since(days)),
            earned_prev: await one('SELECT COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0 AND created_at >= ? AND created_at < ?', since(2 * days), since(days)),
            daily: daysOf(days).map((d) => ({ day: d, n: map.get(d) || 0 })),
        };
    }

    // ── Traffic per service over 24 hours (Prometheus), and the busiest pages by route template ──
    async function traffic() {
        const query = async (q) => {
            const j = await getJson(`${prom}/api/v1/query?query=${encodeURIComponent(q)}`);
            if (!j || j.status !== 'success') throw new Error('prometheus');
            return j.data.result.map((x) => ({ ...x.metric, value: Number(x.value[1]) }));
        };
        try {
            const [reqs, c5, p95, routes] = await Promise.all([
                query('sum by (job) (increase(http_requests_total[24h]))'),
                query('sum by (job) (increase(http_requests_total{status_class="5xx"}[24h]))'),
                query('histogram_quantile(0.95, sum by (job, le) (rate(http_request_duration_seconds_bucket[24h])))'),
                query('topk(60, sum by (job, route) (increase(http_requests_total{status_class=~"2xx|3xx"}[24h])))'),
            ]);
            const m5 = new Map(c5.map((x) => [x.job, x.value])); const mp = new Map(p95.map((x) => [x.job, x.value]));
            const byJob = new Map(reqs.filter((x) => x.value >= 1).map((x) => [x.job, {
                requests: Math.round(x.value), server_errors: Math.round(m5.get(x.job) || 0),
                p95_ms: Number.isFinite(mp.get(x.job)) ? Math.round(mp.get(x.job) * 1000) : null,
            }]));
            const top = routes.filter((x) => x.route && !PLUMBING.test(x.route) && x.value >= 1).sort((a, b) => b.value - a.value).slice(0, 15)
                .map((x) => ({ service: x.job, route: x.route, requests: Math.round(x.value) }));
            return { byJob, top };
        } catch { return null; }
    }

    // ── OpenVibe.Live's public home numbers ──
    async function liveNumbers() {
        const j = await getJson(`${live}/api/home/hero`);
        const s = j && j.stats;
        if (!s) return null;
        const pick = (k) => num(s[k]);
        return {
            live_now: pick('liveNow'), watching: pick('viewersNow'), streamers: pick('streamers'), streams: pick('liveSessions'),
            accounts: pick('users'), visitors: pick('anons'), messages: pick('chatMessages'), chatted_7d: pick('weeklyActive'),
            vods: pick('vods'), clips: pick('clips'), hours_watched: pick('hoursWatched'), hours_archived: pick('streamHours'),
            ai_moments: pick('aiMemories'), pastes: pick('pastes'), follows: pick('follows'),
        };
    }

    async function compute(days) {
        const [pv, livePv, acc, coin, tr, liveN] = await Promise.all([pageviews(days), livePageviews(days), accounts(days), coins(days), traffic(), liveNumbers()]);
        let services = null;
        try {
            const rows = statusRows().filter((r) => r.exposure && r.exposure.state === 'live');
            const known = rows.filter((r) => r.status !== 'unknown');
            if (known.length) services = { up: known.filter((r) => r.status === 'up').length, checked: known.length };
        } catch { services = null; }
        const window = daysOf(days);
        const sites = SITES.filter((s) => s.status === 'open').map((s) => {
            const e = pv && pv.get(s.id);
            const isLive = s.id === 'live';
            const total = isLive ? (livePv ? livePv.total : null) : (e ? e.total : (pv ? 0 : null));
            const prev = isLive ? (livePv ? livePv.prev : null) : (e ? e.prev : (pv ? 0 : null));
            const t = tr && tr.byJob.get(s.service);
            return {
                id: s.id, name: `OpenVibe.${s.name}`, short: s.name, host: s.host, url: `https://${s.host}/`, tagline: s.tagline || '',
                icon: ICON_ALIAS[s.icon] || s.icon,
                pageviews: total, pageviews_prev: prev, change_pct: change(total, prev),
                daily: isLive ? null : window.map((d) => ({ day: d, n: e ? e.daily.get(d) || 0 : 0 })),
                ...(isLive && livePv ? { unique_visitors: livePv.visitors, signed_in_people: livePv.people } : {}),
                traffic_24h: t || null,
            };
        }).sort((a, b) => (b.pageviews || 0) - (a.pageviews || 0) || a.name.localeCompare(b.name));
        // Network-wide page views per day: every navbar site's beacon (Live counts its own; its days are not split out).
        const daily = window.map((d) => ({ day: d, n: [...(pv ? pv.values() : [])].reduce((a, e) => a + (e.daily.get(d) || 0), 0) }));
        const pvTotal = sites.reduce((a, s) => a + (s.pageviews || 0), 0);
        const pvPrev = sites.reduce((a, s) => a + (s.pageviews_prev || 0), 0);
        return {
            generated_at: new Date(now()).toISOString(), window_days: days,
            note: 'Counts only, never about a person. Page views come from the shared navbar\'s anonymous counter (day and site) and OpenVibe.Live\'s own analytics; traffic is Prometheus by route template over 24 hours.',
            totals: {
                pageviews: pv || livePv ? pvTotal : null, pageviews_prev: pv || livePv ? pvPrev : null, change_pct: change(pvTotal, pvPrev),
                sites_open: sites.length, services, accounts: acc ? acc.total : null,
                requests_24h: tr ? [...tr.byJob.values()].reduce((a, x) => a + x.requests, 0) : null,
            },
            pageviews_daily: pv ? daily : null,
            accounts: acc, coins: coin, live: liveN,
            busiest_pages_24h: tr ? tr.top : null,
            sites,
        };
    }
    /** The numbers for a window, held TTL_MS; one computation at a time. `refresh` (the boot warm-up, just before the
     *  numbers expire) computes them again while readers keep the current ones, and swaps the new ones in when ready. */
    function collect(days, { refresh = false } = {}) {
        const e = cache.get(days);
        const fresh = !!e && now() - e.at < TTL_MS;
        if (fresh && !refresh) return e.promise;
        if (fresh && e.next) return e.next;
        const next = compute(days);
        if (fresh) {
            e.next = next;
            next.then(() => cache.set(days, { at: now(), promise: next }), () => { e.next = null; });
            return next;
        }
        cache.set(days, { at: now(), promise: next });
        next.catch(() => cache.delete(days));
        return next;
    }

    const router = express.Router();
    router.get('/api/v1/stats', async (req, res) => {
        try {
            const data = await collect(windowOf(req.query.days));
            res.set('Cache-Control', 'public, max-age=120').set('Access-Control-Allow-Origin', '*').json(data);
        } catch (err) { res.status(503).json({ error: 'stats are unavailable right now' }); }
    });
    router.get('/api/v1/stats/pageviews.csv', async (req, res) => {
        try {
            const data = await collect(windowOf(req.query.days));
            const lines = ['day,site,pageviews'];
            for (const s of data.sites) for (const d of s.daily || []) lines.push(`${d.day},${s.host},${d.n}`);
            res.set('Cache-Control', 'public, max-age=120').set('Access-Control-Allow-Origin', '*')
                .type('text/csv').set('Content-Disposition', `inline; filename="openvibe-pageviews-${data.window_days}d.csv"`).send(lines.join('\n') + '\n');
        } catch { res.status(503).type('text/plain').send('stats are unavailable right now\n'); }
    });
    router.get('/stats', async (req, res) => {
        const days = windowOf(req.query.days);
        let data = null;
        try { data = await collect(days); } catch { data = null; }
        res.set('Cache-Control', 'public, max-age=60').type('html').send(render(data, days, { releaseId: release && release.release }));
    });
    return { router, collect, ttlMs: TTL_MS };
}

// ── Charts: server-drawn SVG (no script, crisp at any size), each with its numbers in a <title> and a text summary ──
function sparkline(points, { w = 120, h = 32 } = {}) {
    const vals = (points || []).map((p) => Number(p.n) || 0);
    if (vals.length < 2 || !vals.some((v) => v > 0)) return '<span class="os-spark os-spark--empty" aria-hidden="true"></span>';
    const max = Math.max(...vals, 1);
    const xy = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 2 - (v / max) * (h - 6)]);
    const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return `<svg class="os-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="os-spark-area" d="M0,${h} L${line.replace(/ /g, ' L')} L${w},${h} Z"/><polyline points="${line}"/></svg>`;
}
function bars(points, label, unit = '') {
    const vals = (points || []).map((p) => Number(p.n) || 0);
    if (!vals.length) return '';
    const max = Math.max(...vals, 1), W = 720, H = 180, gap = vals.length > 40 ? 1 : 2;
    const bw = W / vals.length - gap;
    const total = vals.reduce((a, b) => a + b, 0);
    const best = points.reduce((a, p) => (p.n > a.n ? p : a), points[0]);
    const rects = points.map((p, i) => {
        const v = Number(p.n) || 0;
        const bh = Math.max(v > 0 ? 2 : 0, (v / max) * (H - 24));
        return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(H - 16 - bh).toFixed(1)}" width="${Math.max(1, bw).toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(3, bw / 2).toFixed(1)}"><title>${esc(p.day)}: ${exact(v)}${unit}</title></rect>`;
    }).join('');
    const first = points[0].day, last = points[points.length - 1].day;
    // The dates sit under the chart as text, so they stay readable however small the chart is drawn.
    return `<figure class="os-chart"><svg viewBox="0 0 ${W} ${H - 16}" preserveAspectRatio="none" role="img" aria-label="${esc(`${label}, ${first} to ${last}: ${exact(total)} in all, the busiest day ${best.day} with ${exact(best.n)}`)}">${rects}</svg><div class="os-axis"><span>${esc(first)}</span><span>busiest ${esc(best.day)}: ${exact(best.n)}</span><span>${esc(last)}</span></div>
<details class="os-table"><summary>Every day</summary><table><thead><tr><th>Day</th><th>${esc(label)}</th></tr></thead><tbody>${points.slice().reverse().map((p) => `<tr><td>${esc(p.day)}</td><td>${exact(p.n)}</td></tr>`).join('')}</tbody></table></details></figure>`;
}
/** A site's mark, drawn on the server and styled by the inlined icon CSS: complete on the first paint, no spinning ring. */
const mark = (name, size, cls) => `<span class="ov-icon ${cls}" data-fx="none" style="--ovi-size:${size}px">${icons.svg(name, size)}</span>`;
const pill = (pct, days) => (pct == null ? '' : `<span class="os-pill ${pct > 0 ? 'is-up' : pct < 0 ? 'is-down' : 'is-flat'}" title="Against the ${days} days before">${pct > 0 ? '▲' : pct < 0 ? '▼' : '–'} ${Math.abs(pct)}%</span>`);
const tile = (label, value, sub, extra = '') => `<div class="os-tile"><span class="os-tile-l">${esc(label)}</span><b class="os-tile-v">${value}</b>${sub ? `<span class="os-tile-s">${sub}</span>` : ''}${extra}</div>`;

function render(data, days, { releaseId } = {}) {
    const d = data || { totals: {}, sites: [] };
    const T = d.totals || {};
    const tabs = WINDOWS.map((w) => `<a href="/stats${w === 30 ? '' : `?days=${w}`}"${w === days ? ' aria-current="page"' : ''}>${w} days</a>`).join('');
    const siteRows = (d.sites || []).map((s) => {
        const t = s.traffic_24h;
        return `<li class="os-site">
<a class="os-site-head" href="${esc(s.url)}">${mark(s.icon, 34, 'os-site-icon')}<span class="os-site-name"><b><span class="os-pre">OpenVibe.</span>${esc(s.short || s.name)}</b><small>${esc(s.host)}</small></span></a>
<div class="os-site-main"><span class="os-site-n">${fmt(s.pageviews)}</span><span class="os-site-l">page views</span>${pill(s.change_pct, days)}</div>
${s.daily ? sparkline(s.daily) : '<span class="os-site-own">counts its own visits</span>'}
<dl class="os-site-meta">${s.unique_visitors != null ? `<div><dt>Visitors</dt><dd>${fmt(s.unique_visitors)}</dd></div>` : ''}${t ? `<div><dt>Requests, 24 h</dt><dd>${fmt(t.requests)}</dd></div><div><dt>Fast (p95)</dt><dd>${t.p95_ms != null ? `${exact(t.p95_ms)} ms` : '—'}</dd></div><div><dt>Errors</dt><dd>${t.requests ? `${((t.server_errors / t.requests) * 100).toFixed(t.server_errors && t.server_errors / t.requests < 0.001 ? 2 : 1)}%` : '—'}</dd></div>` : ''}</dl>
</li>`;
    }).join('');
    const L = d.live;
    const liveTiles = L ? [
        ['Live now', fmt(L.live_now)], ['Watching', fmt(L.watching)], ['Streamers', fmt(L.streamers)], ['Streams', fmt(L.streams)],
        ['Chatted, 7 days', fmt(L.chatted_7d)], ['Messages', fmt(L.messages)], ['Visitors', fmt(L.visitors)], ['Hours watched', fmt(L.hours_watched)],
        ['Recordings', fmt(L.vods)], ['Clips', fmt(L.clips)], ['Hours archived', fmt(L.hours_archived)], ['AI moments', fmt(L.ai_moments)],
    ].map(([l, v]) => `<div class="os-mini"><b>${v}</b><span>${esc(l)}</span></div>`).join('') : '';
    const C = d.coins;
    const A = d.accounts;
    const busy = (d.busiest_pages_24h || []).map((r) => `<tr><td><code>${esc(r.route)}</code></td><td>${esc(r.service)}</td><td>${exact(r.requests)}</td></tr>`).join('');
    const title = 'Open stats: every OpenVibe site\'s numbers';
    const desc = `Page views, people, streams, OpenCoins and traffic for every OpenVibe site over the last ${days} days, public and free to reuse as JSON or CSV.`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · OpenVibe.Network</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://openvibe.network/stats${days === 30 ? '' : `?days=${days}`}">
<link rel="alternate" type="application/json" href="/api/v1/stats?days=${days}" title="These numbers as JSON">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website">
${require('../boost').meta(releaseId)}
${require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: '/assets' })}
<meta name="color-scheme" content="dark light">
<script src="/shared/theme-loader.js" defer></script>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Dataset', name: title, description: desc, url: 'https://openvibe.network/stats', isAccessibleForFree: true, creator: { '@type': 'Organization', name: 'OpenVibe' }, distribution: [{ '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: 'https://openvibe.network/api/v1/stats' }, { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: 'https://openvibe.network/api/v1/stats/pageviews.csv' }] }).replace(/</g, '\\u003c')}</script>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg-primary:#0a0f1c;--bg-secondary:#101828;--bg-card:#0f1729;--border:#1f2d47;--accent:#3b82f6;--text-primary:#e6edf7;--text-secondary:#96a7c2;--text-muted:#7386a3;--up:#22c55e;--down:#f87171}
html,body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
a{color:var(--accent)}
${icons.CSS}
${CSS}
</style>
</head>
<body>
<div id="navbar-mount"></div>
${require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Open stats', href: '/stats' }, { label: 'Status', href: '/status' }] })}
<main class="os" id="main">
<header class="os-head">
<p class="os-kicker">Open stats</p>
<h1>Every OpenVibe site's numbers</h1>
<p class="os-lede">Public for everyone: page views, people, streams, OpenCoins and how fast each service answers. Counts only, never about a person. Updated every five minutes${d.generated_at ? ` · <time datetime="${esc(d.generated_at)}">${esc(d.generated_at.slice(0, 16).replace('T', ' '))} UTC</time>` : ''}.</p>
<nav class="os-tabs" aria-label="Time range">${tabs}</nav>
<p class="os-data"><a href="/api/v1/stats?days=${days}">JSON</a> · <a href="/api/v1/stats/pageviews.csv?days=${days}">CSV</a> · <a href="/status">Service status</a></p>
</header>
${data ? '' : '<p class="os-lede">The numbers are being gathered. Try again in a minute.</p>'}
<section class="os-tiles" aria-label="Across the network">
${tile(`Page views, ${days} days`, fmt(T.pageviews), pill(T.change_pct, days), sparkline(d.pageviews_daily, { w: 160, h: 36 }))}
${tile('Accounts', fmt(T.accounts), A ? `+${exact(A.new)} in ${days} days ${pill(change(A.new, A.prev), days)}` : '')}
${L ? tile('Live right now', fmt(L.live_now), `${fmt(L.watching)} watching`) : ''}
${C ? tile('OpenCoins earned', fmt(C.earned), `+${fmt(C.earned_window)} in ${days} days ${pill(change(C.earned_window, C.earned_prev), days)}`) : ''}
${T.services ? tile('Services up', `${exact(T.services.up)}<small> of ${exact(T.services.checked)}</small>`, '<a href="/status">Status</a>') : ''}
${T.requests_24h != null ? tile('Requests, 24 h', fmt(T.requests_24h), `${exact(T.sites_open)} sites`) : ''}
</section>
${d.pageviews_daily ? `<section class="os-sec" aria-labelledby="h-pv"><h2 id="h-pv">Page views a day</h2><p class="os-fine">Every site with the shared navbar. OpenVibe.Live counts its own visits and is in the totals above, not in these bars.</p>${bars(d.pageviews_daily, 'Page views')}</section>` : ''}
<section class="os-sec" aria-labelledby="h-sites"><h2 id="h-sites">Every site</h2><p class="os-fine">Most visited first, over the last ${days} days. Requests, speed (95% of answers were at least this fast) and server errors are over the last 24 hours.</p>
<ul class="os-sites">${siteRows}</ul></section>
${L ? `<section class="os-sec" aria-labelledby="h-live"><h2 id="h-live">${mark('live', 28, 'os-h-icon')}OpenVibe.Live</h2><div class="os-minis">${liveTiles}</div><p class="os-fine"><a href="https://openvibe.live/">openvibe.live</a> has these over time on its home page: tap any number there.</p></section>` : ''}
${A ? `<section class="os-sec" aria-labelledby="h-acc"><h2 id="h-acc">New accounts a day</h2>${bars(A.daily, 'New accounts')}</section>` : ''}
${C ? `<section class="os-sec" aria-labelledby="h-coins"><h2 id="h-coins">OpenCoins</h2><p class="os-fine">The coin people earn across every OpenVibe site, for watching, chatting and using the tools.</p><div class="os-minis">${[['Earned', fmt(C.earned)], ['Spent', fmt(C.spent)], ['Wallets holding coins', fmt(C.holders)], ['Transactions', fmt(C.transactions)]].map(([l, v]) => `<div class="os-mini"><b>${v}</b><span>${esc(l)}</span></div>`).join('')}</div>${bars(C.daily, 'OpenCoins earned')}</section>` : ''}
${busy ? `<section class="os-sec" aria-labelledby="h-busy"><h2 id="h-busy">Busiest routes, 24 hours</h2><p class="os-fine">Pages and API routes, by their template (never a real address), with plumbing left out.</p><div class="os-scroll"><table class="os-busy"><thead><tr><th>Route</th><th>Service</th><th>Requests</th></tr></thead><tbody>${busy}</tbody></table></div></section>` : ''}
<section class="os-sec os-how" aria-labelledby="h-how"><h2 id="h-how">How these are counted</h2><p class="os-fine">${esc(d.note || '')} Accounts leave out guests and banned accounts. Nothing here names or follows anyone. Reuse anything: <a href="/api/v1/stats?days=${days}"><code>/api/v1/stats</code></a> answers the same numbers as JSON, open to every site and agent.</p></section>
</main>
${require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact' })}
<script src="/shared/navbar.js" defer></script>
${require('../boost').SCRIPT}
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:location.origin});}catch(e){}});</script>
</body>
</html>`;
}

const CSS = `
.os{max-width:1180px;margin:0 auto;padding:28px 20px 56px}
.os-head{margin-bottom:22px}
.os-kicker{margin:0 0 6px;font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.os h1{margin:0 0 8px;font-size:clamp(1.6rem,4vw,2.3rem);letter-spacing:-.02em}
.os-lede{margin:0 0 14px;max-width:760px;color:var(--text-secondary);line-height:1.55}
.os-tabs{display:inline-flex;gap:4px;padding:4px;border-radius:999px;background:var(--bg-secondary);border:1px solid var(--border)}
.os-tabs a{padding:7px 14px;border-radius:999px;color:var(--text-secondary);text-decoration:none;font-size:.86rem;font-weight:700}
.os-tabs a[aria-current]{background:var(--accent);color:#fff}
.os-data{margin:12px 0 0;font-size:.84rem;color:var(--text-muted)}
.os-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:22px 0 8px}
.os-tile{position:relative;display:flex;flex-direction:column;gap:4px;padding:16px 16px 14px;border-radius:16px;background:linear-gradient(160deg,color-mix(in srgb,var(--accent) 10%,transparent),transparent 70%),var(--bg-card);border:1px solid var(--border);min-height:112px}
.os-tile-l{font-size:.76rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)}
.os-tile-v{font-size:1.9rem;font-weight:850;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.os-tile-v small{font-size:.9rem;color:var(--text-muted);font-weight:700}
.os-tile-s{font-size:.82rem;color:var(--text-secondary);display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.os-tile .os-spark{position:absolute;right:12px;bottom:12px;width:44%;height:34px;opacity:.9}
.os-pill{display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border-radius:999px;font-size:.74rem;font-weight:800;white-space:nowrap}
.os-pill.is-up{color:var(--up);background:color-mix(in srgb,var(--up) 14%,transparent)}
.os-pill.is-down{color:var(--down);background:color-mix(in srgb,var(--down) 14%,transparent)}
.os-pill.is-flat{color:var(--text-muted);background:color-mix(in srgb,var(--text-muted) 14%,transparent)}
.os-spark{display:block;width:100%;height:32px;color:var(--accent);overflow:visible}
.os-spark polyline{fill:none;stroke:currentColor;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round}
.os-spark-area{fill:currentColor;opacity:.14}
.os-spark--empty{display:block;height:32px;border-bottom:1px dashed var(--border)}
.os-sec{margin-top:34px}
.os-sec h2{display:flex;align-items:center;gap:10px;margin:0 0 6px;font-size:1.25rem}
.os-h-icon{display:inline-flex}
.os-fine{margin:0 0 14px;font-size:.86rem;color:var(--text-muted);line-height:1.5;max-width:820px}
.os-sites{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.os-site{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:16px;background:var(--bg-card);border:1px solid var(--border)}
.os-site-head{display:flex;align-items:center;gap:10px;color:inherit;text-decoration:none;min-width:0}
.os-site-head:hover b{text-decoration:underline}
.os-site-icon{flex:none;display:inline-flex}
.os-site-name{display:flex;flex-direction:column;min-width:0}
.os-site-name b{font-size:.98rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.os-site-name small{font-size:.78rem;color:var(--text-muted)}
.os-site-main{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.os-site-n{font-size:1.45rem;font-weight:850;font-variant-numeric:tabular-nums}
.os-site-l{font-size:.8rem;color:var(--text-muted)}
.os-site-own{font-size:.78rem;color:var(--text-muted);height:32px;display:flex;align-items:center}
.os-site-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(58px,1fr));gap:8px;margin:0;padding-top:10px;border-top:1px solid var(--border)}
.os-site-meta div{min-width:0}
.os-site-meta dt{font-size:.7rem;color:var(--text-muted);white-space:nowrap}
.os-site-meta dd{margin:2px 0 0;font-size:.88rem;font-weight:700;font-variant-numeric:tabular-nums}
.os-minis{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:14px}
.os-mini{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border-radius:14px;background:var(--bg-card);border:1px solid var(--border)}
.os-mini b{font-size:1.25rem;font-variant-numeric:tabular-nums}
.os-mini span{font-size:.78rem;color:var(--text-muted)}
.os-chart{margin:0;padding:14px;border-radius:16px;background:var(--bg-card);border:1px solid var(--border)}
.os-chart svg{display:block;width:100%;height:clamp(110px,22vw,170px)}
.os-axis{display:flex;justify-content:space-between;gap:10px;margin-top:6px;font-size:.74rem;color:var(--text-muted);font-variant-numeric:tabular-nums}
.os-axis span:nth-child(2){text-align:center}
.os-chart rect{fill:var(--accent)}
.os-chart rect:hover{fill:color-mix(in srgb,var(--accent) 70%,#fff)}
.os-table{margin-top:8px;font-size:.84rem}
.os-table summary{cursor:pointer;color:var(--text-secondary)}
.os-table table,.os-busy{width:100%;border-collapse:collapse;margin-top:8px;font-variant-numeric:tabular-nums}
.os-table td,.os-table th,.os-busy td,.os-busy th{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left}
.os-table td:last-child,.os-busy td:last-child,.os-busy th:last-child{text-align:right}
.os-scroll{overflow-x:auto;border-radius:14px;border:1px solid var(--border);background:var(--bg-card)}
.os-busy code{font-size:.82rem;overflow-wrap:anywhere}
.os-busy th{font-size:.76rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em}
.os-how{padding-top:6px;border-top:1px solid var(--border)}
@media (max-width:600px){.os{padding:20px 16px 44px}.os-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.os-tile{min-height:104px;padding:14px 12px 12px}.os-tile-v{font-size:1.5rem}.os-tile .os-spark{position:static;width:100%;margin-top:4px}
/* Phones: two sites to a row, each its views, change, line and two facts (37 full cards made a 10,000 px page). */
.os-sites{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.os-pre{display:none}.os-site{padding:10px;gap:6px;border-radius:14px}.os-site-name small,.os-site-l{display:none}.os-site-name b{font-size:.86rem}.os-site-n{font-size:1.15rem}.os-site-meta{grid-template-columns:1fr 1fr;padding-top:6px}.os-site-meta div:nth-child(n+3){display:none}.os-site-meta dt{font-size:.64rem}.os-site-meta dd{font-size:.8rem}.os-site-own{height:26px;font-size:.7rem}.os-site .os-spark{height:26px}.os-axis span:nth-child(2){display:none}}
`;

module.exports = { createOpenStats, render, sparkline, bars, windowOf };
