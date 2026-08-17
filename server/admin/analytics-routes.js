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

module.exports = function createAnalyticsRoutes(analytics, requireAuth, config) {

    const INTERNAL_SECRET = 'openvibe-internal-2026';

    // All remote services with their internal URLs and fetch strategy
    const REMOTE_SERVICES = [
        { name: 'live',  label: 'OpenVibe.Live',  url: config.services?.live?.internalUrl  || 'http://127.0.0.1:3000', path: '/api/admin/analytics',    auth: 'bearer' },
        { name: 'tools', label: 'OpenVibe.Tools', url: config.services?.tools?.internalUrl || 'http://127.0.0.1:4001', path: '/api/internal/analytics', auth: 'internal' },
        { name: 'games', label: 'OpenVibe.Games', url: config.services?.games?.internalUrl || 'http://127.0.0.1:8000', path: '/api/internal/analytics', auth: 'internal' },
        { name: 'media', label: 'OpenVibe.Media', url: config.services?.media?.internalUrl || 'http://127.0.0.1:4100', path: '/api/internal/analytics', auth: 'internal' },
    ];

    function requireAdmin(req, res, next) {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ ok: false, error: 'Admin access required' });
        }
        next();
    }

    router.use(requireAuth, requireAdmin);

    // ── Helper: fetch analytics from a remote service ────────
    async function fetchRemoteAnalytics(svc, subPath, token, days, hours) {
        try {
            const qs = hours ? `days=${days}&hours=${hours}` : `days=${days}`;
            const url = `${svc.url}${svc.path}${subPath}?${qs}`;
            const headers = { 'Content-Type': 'application/json' };

            if (svc.auth === 'internal') {
                headers['X-Internal-Secret'] = INTERNAL_SECRET;
            } else {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            console.warn(`[Analytics] Failed to fetch from ${svc.name}:`, err.message);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Overview — Cross-Service Summary
    // ═══════════════════════════════════════════════════════════

    router.get('/overview', async (req, res) => {
        try {
            const days = Math.min(parseInt(req.query.days) || 30, 365);
            const hours = req.query.hours ? Math.min(parseInt(req.query.hours), 8760) : null;

            // Fetch from all services in parallel
            const promises = [
                Promise.resolve({ ok: true, analytics: analytics.getStats({ days, hours }), name: 'openvibe-network', label: 'OpenVibe.Network' }),
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
                data = analytics.getStats({ days, hours });
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
                Promise.resolve({ ok: true, bots: analytics.getBotAnalysis(days), name: 'openvibe-network' }),
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

    router.get('/realtime', (req, res) => {
        try {
            const fiveMinAgo = new Date(Date.now() - 300000).toISOString().slice(0, 19).replace('T', ' ');
            const db = analytics.db;

            const realtime = db.prepare(`
                SELECT
                    COUNT(*) as requests,
                    COUNT(DISTINCT ip) as visitors,
                    COUNT(*) FILTER (WHERE is_bot = 1) as bots,
                    COUNT(*) FILTER (WHERE event_type = 'pageview') as pageviews,
                    COUNT(*) FILTER (WHERE event_type = 'api_call') as api_calls
                FROM analytics_events
                WHERE created_at >= ?
            `).get(fiveMinAgo);

            const byPath = db.prepare(`
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
