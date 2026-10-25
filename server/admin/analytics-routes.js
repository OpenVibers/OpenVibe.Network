'use strict';

// ═══════════════════════════════════════════════════════════════
// Admin Panel — Analytics Routes
// Mounted at /api/admin/analytics. Requires admin role.
// Aggregates analytics from all OpenVibe services:
//   openvibe-network (local), OpenVibe.Live, OpenVibe.Tools,
//   OpenVibe.Games, OpenVibe.Media
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

module.exports = function createAnalyticsRoutes(analytics, requireAuth, config, { selfToken = () => null } = {}) {

    // Tools is asked with a Network service token (tools.analytics.read).

    // All remote services with their internal URLs and fetch strategy
    const REMOTE_SERVICES = [
        { name: 'live',  label: 'OpenVibe.Live',  url: config.services?.live?.internalUrl  || 'http://127.0.0.1:3000', path: '/api/admin/analytics',    auth: 'bearer' },
        { name: 'tools', label: 'OpenVibe.Tools', url: config.services?.tools?.internalUrl || 'http://127.0.0.1:4001', path: '/api/internal/analytics', auth: 'internal' },
        // Games and Media keep no analytics of their own and never had this route: the navbar's page-view count is
        // their number (beaconFallback), without asking them.
        { name: 'games', label: 'OpenVibe.Games', url: config.services?.games?.internalUrl || 'http://127.0.0.1:8000', path: null, auth: 'beacon' },
        { name: 'media', label: 'OpenVibe.Media', url: config.services?.media?.internalUrl || 'http://127.0.0.1:4100', path: null, auth: 'beacon' },
    ];

    function requireAdmin(req, res, next) {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ ok: false, error: 'Admin access required' });
        }
        next();
    }

    router.use(requireAuth, requireAdmin);

    // Games and Media keep no analytics of their own. The shared navbar's anonymous page-view count
    // (frame_hits: day + host, nothing else) is the honest number for them; the summary says so.
    const BEACON_HOSTS = { games: 'openvibe.games', media: 'openvibe.media', tools: 'openvibe.tools' };
    async function beaconFallback(svc, days) {
        try {
            const host = BEACON_HOSTS[svc.name]; if (!host) return null;
            const row = await analytics.db.prepare("SELECT COALESCE(SUM(hits), 0)::bigint AS n FROM frame_hits WHERE day >= substring(datetime('now', ?), 1, 10) AND (host = ? OR host LIKE ?)").get(`-${Math.min(days || 30, 365)} days`, host, '%.' + host);
            return { ok: true, analytics: { summary: { total_pageviews: row.n, source: 'navbar page-view count (no service analytics)' }, realtime: {} } };
        } catch { return null; }
    }

    // ── Helper: fetch analytics from a remote service ────────
    async function fetchRemoteAnalytics(svc, subPath, token, days, hours) {
        try {
            const qs = hours ? `days=${days}&hours=${hours}` : `days=${days}`;
            const url = `${svc.url}${svc.path}${subPath}?${qs}`;
            const headers = { 'Content-Type': 'application/json' };

            if (svc.auth === 'beacon') return subPath ? null : await beaconFallback(svc, days);
            if (svc.auth === 'internal') {
                const t = selfToken(`openvibe.${svc.name}`, [`${svc.name}.analytics.read`]);
                if (!t) return null;
                headers['Authorization'] = `Bearer ${t}`;
            } else {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
            if (!res.ok) return subPath ? null : await beaconFallback(svc, days);
            return await res.json();
        } catch (err) {
            console.warn(`[Analytics] Failed to fetch from ${svc.name}:`, err.message);
            return subPath ? null : await beaconFallback(svc, days);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Insights — sign-ups (this database) and how every service is used and fails (Prometheus on the host, which
    // scrapes each service's /metrics: requests by route template and status class, latency histograms)
    // ═══════════════════════════════════════════════════════════
    // Routes that are plumbing, not something a person uses: left out of "most used".
    const PLUMBING = /^(\/metrics|\/api\/(ready|health)|static|\/release\.json|\/robots\.txt|\/favicon\.ico|\/internal\/|\/api\/frame\/hit|\/oauth\/token|\/\.well-known\/)/;
    router.get('/insights', async (req, res) => {
        const prom = String(config.prometheusUrl || process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090').replace(/\/+$/, '');
        const query = async (q) => {
            const r = await fetch(`${prom}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(6000) });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j || j.status !== 'success') throw new Error(`Prometheus answered ${r.status}`);
            return j.data.result.map((x) => ({ ...x.metric, value: Number(x.value[1]) }));
        };
        const out = { generated_at: new Date().toISOString(), window: '24h' };
        try {
            const db = analytics.db;
            const n = async (sql, ...a) => Number(((await db.prepare(sql).get(...a)) || {}).n) || 0;
            out.users = {
                total: await n('SELECT COUNT(*)::bigint AS n FROM users'),
                new_1d: await n("SELECT COUNT(*)::bigint AS n FROM users WHERE created_at >= to_char(now() AT TIME ZONE 'UTC' - interval '1 day', 'YYYY-MM-DD HH24:MI:SS')"),
                new_7d: await n("SELECT COUNT(*)::bigint AS n FROM users WHERE created_at >= to_char(now() AT TIME ZONE 'UTC' - interval '7 days', 'YYYY-MM-DD HH24:MI:SS')"),
                new_30d: await n("SELECT COUNT(*)::bigint AS n FROM users WHERE created_at >= to_char(now() AT TIME ZONE 'UTC' - interval '30 days', 'YYYY-MM-DD HH24:MI:SS')"),
                daily: (await db.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*)::bigint AS n FROM users WHERE created_at >= to_char(now() AT TIME ZONE 'UTC' - interval '14 days', 'YYYY-MM-DD') GROUP BY 1 ORDER BY 1").all()).map((r) => ({ day: r.day, n: Number(r.n) })),
            };
        } catch (err) { out.users = { error: err.message }; }
        try {
            const [reqs, c4, c5, p95, routes, errs] = await Promise.all([
                query('sum by (job) (increase(http_requests_total[24h]))'),
                query('sum by (job) (increase(http_requests_total{status_class="4xx"}[24h]))'),
                query('sum by (job) (increase(http_requests_total{status_class="5xx"}[24h]))'),
                query('histogram_quantile(0.95, sum by (job, le) (rate(http_request_duration_seconds_bucket[24h])))'),
                query('topk(80, sum by (job, route) (increase(http_requests_total{status_class=~"2xx|3xx"}[24h])))'),
                query('topk(20, sum by (job, route) (increase(http_requests_total{status_class="5xx"}[24h])) > 0)'),
            ]);
            const by = (list) => new Map(list.map((x) => [x.job, x.value]));
            const m4 = by(c4), m5 = by(c5), mp = by(p95);
            out.services = reqs.filter((x) => x.value >= 1).map((x) => ({
                service: x.job, requests: Math.round(x.value), client_errors: Math.round(m4.get(x.job) || 0), server_errors: Math.round(m5.get(x.job) || 0),
                p95_ms: Number.isFinite(mp.get(x.job)) ? Math.round(mp.get(x.job) * 1000) : null,
            })).sort((a, b) => b.requests - a.requests);
            out.top_routes = routes.filter((x) => x.route && !PLUMBING.test(x.route)).sort((a, b) => b.value - a.value).slice(0, 25).map((x) => ({ service: x.job, route: x.route, requests: Math.round(x.value) }));
            out.error_routes = errs.filter((x) => x.value >= 1).sort((a, b) => b.value - a.value).map((x) => ({ service: x.job, route: x.route, errors: Math.round(x.value) }));
            out.totals = { requests: out.services.reduce((a, s) => a + s.requests, 0), server_errors: out.services.reduce((a, s) => a + s.server_errors, 0) };
        } catch (err) { out.metrics_error = `Metrics are unavailable: ${err.message}`; }
        res.set('Cache-Control', 'private, no-store').json({ ok: true, insights: out });
    });

    // ═══════════════════════════════════════════════════════════
    // Overview — Cross-Service Summary
    // ═══════════════════════════════════════════════════════════

    router.get('/overview', async (req, res) => {
        try {
            const days = Math.min(parseInt(req.query.days) || 30, 365);
            const hours = req.query.hours ? Math.min(parseInt(req.query.hours), 8760) : null;

            // Fetch from all services in parallel
            const promises = [
                { ok: true, analytics: await analytics.getStats({ days, hours }), name: 'openvibe-network', label: 'OpenVibe.Network' },
                ...REMOTE_SERVICES.map(svc =>
                    fetchRemoteAnalytics(svc, '', req.token, days, hours).then(result => ({
                        ...result, name: svc.name, label: svc.label,
                    }))
                ),
            ];

            const results = await Promise.allSettled(promises);

            // Build service list
            const services = [];
            const allDataSources = [];
            for (const r of results) {
                if (r.status !== 'fulfilled' || !r.value) continue;
                const v = r.value;
                const data = v.analytics;
                if (!data) continue;

                allDataSources.push({ ...data, _name: v.name, _label: v.label });
                services.push({
                    name: v.name,
                    label: v.label,
                    ...data.summary,
                    realtime: data.realtime,
                    authBreakdown: data.authBreakdown || {},
                });
            }

            // Combined totals
            const totals = {
                total_pageviews: services.reduce((s, v) => s + (v.total_pageviews || 0), 0),
                total_api_calls: services.reduce((s, v) => s + (v.total_api_calls || 0), 0),
                total_unique_visitors: services.reduce((s, v) => s + (v.total_unique_visitors || 0), 0),
                total_unique_users: services.reduce((s, v) => s + (v.total_unique_users || 0), 0),
                total_bot_hits: services.reduce((s, v) => s + (v.total_bot_hits || 0), 0),
                total_errors: services.reduce((s, v) => s + (v.total_errors || 0), 0),
                avg_response_ms: Math.round(services.reduce((s, v) => s + (v.avg_response_ms || 0), 0) / Math.max(services.length, 1)),
            };

            // Combine daily trends from all data sources
            const dailyMap = new Map();
            for (const src of allDataSources) {
                if (!src?.daily) continue;
                for (const d of src.daily) {
                    const existing = dailyMap.get(d.date) || { date: d.date, pageviews: 0, api_calls: 0, unique_visitors: 0, bot_hits: 0 };
                    existing.pageviews += d.pageviews || 0;
                    existing.api_calls += d.api_calls || 0;
                    existing.unique_visitors += d.unique_visitors || 0;
                    existing.bot_hits += d.bot_hits || 0;
                    dailyMap.set(d.date, existing);
                }
            }
            const dailyTrend = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

            // Realtime across services
            const realtimeTotal = {
                requests: services.reduce((s, v) => s + (v.realtime?.requests || 0), 0),
                visitors: services.reduce((s, v) => s + (v.realtime?.visitors || 0), 0),
                bots: services.reduce((s, v) => s + (v.realtime?.bots || 0), 0),
            };

            // Aggregate enhanced metrics across services
            const totalBandwidth = {
                total_requests: 0, page_requests: 0, api_requests: 0, estimated_bytes: 0,
            };
            const totalSessions = allDataSources.reduce((s, d) => s + (d.sessionCount || 0), 0);
            for (const src of allDataSources) {
                if (src?.bandwidth) {
                    totalBandwidth.total_requests += src.bandwidth.total_requests || 0;
                    totalBandwidth.page_requests += src.bandwidth.page_requests || 0;
                    totalBandwidth.api_requests += src.bandwidth.api_requests || 0;
                    totalBandwidth.estimated_bytes += src.bandwidth.estimated_bytes || 0;
                }
            }

            // Combine time buckets for sub-day views
            const timeBucketMap = new Map();
            for (const src of allDataSources) {
                if (!src?.timeBuckets) continue;
                for (const b of src.timeBuckets) {
                    const existing = timeBucketMap.get(b.bucket) || { bucket: b.bucket, pageviews: 0, api_calls: 0, unique_visitors: 0, bot_hits: 0, errors: 0 };
                    existing.pageviews += b.pageviews || 0;
                    existing.api_calls += b.api_calls || 0;
                    existing.unique_visitors += b.unique_visitors || 0;
                    existing.bot_hits += b.bot_hits || 0;
                    existing.errors += b.errors || 0;
                    timeBucketMap.set(b.bucket, existing);
                }
            }
            const timeBuckets = Array.from(timeBucketMap.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

            // Aggregate auth trend across services
            const authTrendMap = new Map();
            for (const src of allDataSources) {
                if (!src?.authTrend) continue;
                for (const b of src.authTrend) {
                    const existing = authTrendMap.get(b.bucket) || { bucket: b.bucket, auth_visitors: 0, anon_visitors: 0, auth_hits: 0, anon_hits: 0 };
                    existing.auth_visitors += b.auth_visitors || 0;
                    existing.anon_visitors += b.anon_visitors || 0;
                    existing.auth_hits += b.auth_hits || 0;
                    existing.anon_hits += b.anon_hits || 0;
                    authTrendMap.set(b.bucket, existing);
                }
            }
            const authTrend = Array.from(authTrendMap.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

            // Per-service hourly trend (for stacked charts)
            const perServiceTrend = [];
            for (const src of allDataSources) {
                const trend = (hours && hours < 24 && src.timeBuckets?.length) ? src.timeBuckets : src.daily || [];
                if (trend.length) {
                    perServiceTrend.push({ name: src._name, label: src._label, data: trend });
                }
            }

            res.json({
                ok: true,
                overview: {
                    period_days: days,
                    period_hours: hours,
                    totals,
                    services,
                    dailyTrend,
                    timeBuckets,
                    realtime: realtimeTotal,
                    bandwidth: totalBandwidth,
                    sessionCount: totalSessions,
                    authTrend,
                    perServiceTrend,
                },
            });
        } catch (err) {
            console.error('[Analytics] Overview error:', err);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Per-Service Detail
    // ═══════════════════════════════════════════════════════════

    router.get('/service/:name', async (req, res) => {
        try {
            const { name } = req.params;
            const days = Math.min(parseInt(req.query.days) || 30, 365);
            const hours = req.query.hours ? Math.min(parseInt(req.query.hours), 8760) : null;
            let data = null;

            if (name === 'openvibe-network') {
                data = await analytics.getStats({ days, hours });
            } else {
                const svc = REMOTE_SERVICES.find(s => s.name === name);
                if (svc) {
                    const remote = await fetchRemoteAnalytics(svc, '', req.token, days, hours);
                    data = remote?.analytics || null;
                }
            }

            if (!data) {
                return res.status(404).json({ ok: false, error: `No analytics data available for ${name}` });
            }

            res.json({ ok: true, analytics: data });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Bot Analysis
    // ═══════════════════════════════════════════════════════════

    router.get('/bots', async (req, res) => {
        try {
            const days = Math.min(parseInt(req.query.days) || 30, 365);

            const promises = [
                { ok: true, bots: await analytics.getBotAnalysis(days), name: 'openvibe-network' },
                ...REMOTE_SERVICES.map(svc =>
                    fetchRemoteAnalytics(svc, '/bots', req.token, days).then(result => ({
                        ...result, name: svc.name,
                    }))
                ),
            ];

            const results = await Promise.allSettled(promises);
            const bots = {};
            for (const r of results) {
                if (r.status !== 'fulfilled' || !r.value?.bots) continue;
                bots[r.value.name] = r.value.bots;
            }

            res.json({ ok: true, bots });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Real-time snapshot
    // ═══════════════════════════════════════════════════════════

    router.get('/realtime', async (req, res) => {
        try {
            const fiveMinAgo = new Date(Date.now() - 300000).toISOString().slice(0, 19).replace('T', ' ');
            const db = analytics.db;

            // ADR-021: raw events carry no IP; visitors are distinct rotating session ids.
            const realtime = await db.prepare(`
                SELECT
                    COUNT(*) as requests,
                    COUNT(DISTINCT session_id) as visitors,
                    COUNT(*) FILTER (WHERE is_bot = 1) as bots,
                    COUNT(*) FILTER (WHERE event_type = 'pageview') as pageviews,
                    COUNT(*) FILTER (WHERE event_type = 'api_call') as api_calls
                FROM analytics_events
                WHERE created_at >= ?
            `).get(fiveMinAgo);

            const byPath = await db.prepare(`
                SELECT path, COUNT(*) as hits
                FROM analytics_events
                WHERE created_at >= ? AND is_bot = 0
                GROUP BY path ORDER BY hits DESC LIMIT 10
            `).all(fiveMinAgo);

            res.json({ ok: true, realtime: { ...realtime, topPaths: byPath } });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    return router;
};
