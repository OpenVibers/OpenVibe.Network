/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): the analytics tab and its charts.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════
// Analytics
// ═══════════════════════════════════════════════════════════════
let analyticsCurrentSubTab = 'overview';
let analyticsCharts = {};
const CHART_COLORS = {
    accent: '#8b5cf6',
    accentLight: '#a78bfa',
    success: '#2ecc71',
    danger: '#e74c3c',
    warning: '#f59e0b',
    info: '#3498db',
    purple: '#9b59b6',
    pink: '#e84393',
    teal: '#00cec9',
    navy: '#2d3436',
};
const PIE_COLORS = ['#8b5cf6', '#3498db', '#2ecc71', '#e74c3c', '#9b59b6', '#f59e0b', '#e84393', '#00cec9', '#1abc9c', '#fd79a8'];

function getAnalyticsDays() {
    return parseInt(document.getElementById('analytics-period')?.value) || 30;
}

/** Parse the period select value into {days, hours, qs} */
function getAnalyticsPeriod() {
    const val = document.getElementById('analytics-period')?.value || '30';
    if (val.endsWith('h')) {
        const hours = parseInt(val);
        return { days: Math.ceil(hours / 24), hours, qs: `days=${Math.ceil(hours / 24)}&hours=${hours}` };
    }
    if (val.endsWith('d')) {
        const d = parseInt(val);
        const hours = d * 24;
        return { days: d, hours, qs: `days=${d}&hours=${hours}` };
    }
    const days = parseInt(val) || 30;
    return { days, hours: null, qs: `days=${days}` };
}

function showAnalyticsSubTab(tab, btn) {
    analyticsCurrentSubTab = tab;
    document.querySelectorAll('#analytics-sub-tabs button').forEach(b => b.classList.remove('active'));
    btn?.classList.add('active');
    document.getElementById('analytics-overview').style.display = tab === 'overview' ? 'block' : 'none';
    const serviceNames = ['live','openvibe-network','tools','games','media'];
    document.getElementById('analytics-service-detail').style.display = serviceNames.includes(tab) ? 'block' : 'none';
    document.getElementById('analytics-bots-detail').style.display = tab === 'bots' ? 'block' : 'none';
    if (tab === 'overview') loadAnalyticsOverview();
    else if (tab === 'bots') loadBotAnalysis();
    else loadServiceAnalytics(tab);
    _syncAdminUrl();
}

function reloadAnalytics() {
    if (analyticsCurrentSubTab === 'overview') loadAnalyticsOverview();
    else if (analyticsCurrentSubTab === 'bots') loadBotAnalysis();
    else loadServiceAnalytics(analyticsCurrentSubTab);
    _syncAdminUrl(true); // period lives in ?last= — replace, don't stack history
}

async function loadAnalytics() {
    loadAnalyticsOverview();
}

function destroyChart(id) {
    if (analyticsCharts[id]) { analyticsCharts[id].destroy(); delete analyticsCharts[id]; }
}

function createChart(canvasId, config) {
    destroyChart(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    // Default dark theme
    config.options = config.options || {};
    config.options.responsive = true;
    config.options.maintainAspectRatio = true;
    config.options.plugins = config.options.plugins || {};
    config.options.plugins.legend = config.options.plugins.legend || { labels: { color: '#b0b0b8', font: { size: 11 } } };
    if (config.options.scales) {
        for (const [, axis] of Object.entries(config.options.scales)) {
            axis.ticks = axis.ticks || {};
            axis.ticks.color = axis.ticks.color || '#707080';
            axis.grid = axis.grid || {};
            axis.grid.color = axis.grid.color || 'rgba(42,42,58,0.5)';
        }
    }
    analyticsCharts[canvasId] = new Chart(ctx, config);
    return analyticsCharts[canvasId];
}

function fmtNum(n) { return (n || 0).toLocaleString(); }

async function loadAnalyticsOverview() {
    const period = getAnalyticsPeriod();
    const statsEl = document.getElementById('analytics-stats');
    statsEl.innerHTML = '<div class="loading">Loading analytics...</div>';
    try {
        const data = await api(`/api/admin/analytics/overview?${period.qs}`);
        const ov = data.overview;
        const t = ov.totals || {};
        const bw = ov.bandwidth || {};

        statsEl.innerHTML = [
            { icon: 'fa-eye', label: 'Page Views', value: fmtNum(t.total_pageviews) },
            { icon: 'fa-code', label: 'API Calls', value: fmtNum(t.total_api_calls) },
            { icon: 'fa-users', label: 'Unique Visitors', value: fmtNum(t.total_unique_visitors) },
            { icon: 'fa-id-badge', label: 'Sessions', value: fmtNum(ov.sessionCount || 0) },
            { icon: 'fa-robot', label: 'Bot Hits', value: fmtNum(t.total_bot_hits) },
            { icon: 'fa-circle-exclamation', label: 'Errors', value: fmtNum(t.total_errors) },
            { icon: 'fa-gauge-high', label: 'Avg Response', value: (t.avg_response_ms || 0) + 'ms' },
            { icon: 'fa-arrow-up-from-bracket', label: 'Est. Bandwidth', value: fmtBytes(bw.estimated_bytes) },
        ].map(s => `<div class="stat-card"><div class="value">${s.value}</div><div class="label"><i class="fa-solid ${s.icon}"></i> ${s.label}</div></div>`).join('');

        // Real-time card
        const rt = ov.realtime || {};
        const rtCard = document.getElementById('analytics-realtime-card');
        if (rt.requests > 0) {
            rtCard.style.display = 'block';
            document.getElementById('analytics-realtime').innerHTML = `
                <div style="display:flex;gap:24px;font-size:14px">
                    <span><strong style="color:var(--accent-light)">${fmtNum(rt.requests)}</strong> requests</span>
                    <span><strong style="color:var(--success)">${fmtNum(rt.visitors)}</strong> visitors</span>
                    <span><strong style="color:var(--danger)">${fmtNum(rt.bots)}</strong> bots</span>
                </div>`;
        } else {
            rtCard.style.display = 'none';
        }

        // Traffic trend chart — use timeBuckets for sub-day, dailyTrend for multi-day
        const buckets = ov.timeBuckets || [];
        const trend = ov.dailyTrend || [];
        const useSubDay = period.hours && period.hours < 24 && buckets.length > 0;
        const trendData = useSubDay ? buckets : trend;
        const trendLabels = useSubDay
            ? trendData.map(d => { const parts = d.bucket?.split(' '); return parts?.[1] || d.bucket; })
            : trendData.map(d => d.date?.slice(5) || '');
        if (trendData.length) {
            createChart('chart-traffic-trend', {
                type: 'line',
                data: {
                    labels: trendLabels,
                    datasets: [
                        { label: 'Page Views', data: trendData.map(d => d.pageviews), borderColor: CHART_COLORS.accent, backgroundColor: 'rgba(139,92,246,0.1)', fill: true, tension: 0.3 },
                        { label: 'API Calls', data: trendData.map(d => d.api_calls), borderColor: CHART_COLORS.info, backgroundColor: 'rgba(52,152,219,0.1)', fill: true, tension: 0.3 },
                        { label: 'Visitors', data: trendData.map(d => d.unique_visitors), borderColor: CHART_COLORS.success, backgroundColor: 'rgba(46,204,113,0.1)', fill: true, tension: 0.3 },
                    ],
                },
                options: { scales: { x: {}, y: { beginAtZero: true } } },
            });
        }

        // Service comparison bar chart
        const svcs = ov.services || [];
        if (svcs.length) {
            createChart('chart-service-compare', {
                type: 'bar',
                data: {
                    labels: svcs.map(s => s.label || s.name),
                    datasets: [
                        { label: 'Page Views', data: svcs.map(s => s.total_pageviews || 0), backgroundColor: CHART_COLORS.accent },
                        { label: 'API Calls', data: svcs.map(s => s.total_api_calls || 0), backgroundColor: CHART_COLORS.info },
                        { label: 'Bot Hits', data: svcs.map(s => s.total_bot_hits || 0), backgroundColor: CHART_COLORS.danger },
                    ],
                },
                options: { scales: { x: {}, y: { beginAtZero: true } } },
            });
        }

        // ── Unique Visitors Trend (dedicated chart) ──────────
        if (trendData.length) {
            createChart('chart-visitors-trend', {
                type: 'line',
                data: {
                    labels: trendLabels,
                    datasets: [
                        { label: 'Unique Visitors', data: trendData.map(d => d.unique_visitors || 0), borderColor: CHART_COLORS.success, backgroundColor: 'rgba(46,204,113,0.15)', fill: true, tension: 0.3, pointRadius: 3 },
                    ],
                },
                options: {
                    scales: { x: {}, y: { beginAtZero: true } },
                    plugins: { legend: { display: false } },
                },
            });
        }

        // ── Logged-in vs Anonymous Trend ─────────────────────
        const authTrend = ov.authTrend || [];
        if (authTrend.length) {
            const authLabels = useSubDay
                ? authTrend.map(d => { const parts = d.bucket?.split(' '); return parts?.[1] || d.bucket; })
                : authTrend.map(d => d.bucket?.slice(5) || '');
            createChart('chart-auth-trend', {
                type: 'line',
                data: {
                    labels: authLabels,
                    datasets: [
                        { label: 'Logged-in Visitors', data: authTrend.map(d => d.auth_visitors || 0), borderColor: CHART_COLORS.accent, backgroundColor: 'rgba(139,92,246,0.15)', fill: true, tension: 0.3, pointRadius: 2 },
                        { label: 'Anonymous Visitors', data: authTrend.map(d => d.anon_visitors || 0), borderColor: '#6c6c80', backgroundColor: 'rgba(108,108,128,0.15)', fill: true, tension: 0.3, pointRadius: 2 },
                    ],
                },
                options: { scales: { x: {}, y: { beginAtZero: true, stacked: true } }, plugins: { legend: { position: 'bottom' } } },
            });
        }

        // ── Per-Service Traffic Share (doughnut) ─────────────
        if (svcs.length) {
            const svcTraffic = svcs.map(s => (s.total_pageviews || 0) + (s.total_api_calls || 0)).filter(v => v > 0);
            const svcLabelsFiltered = svcs.filter((s, i) => svcTraffic.length > i && ((s.total_pageviews || 0) + (s.total_api_calls || 0)) > 0);
            if (svcTraffic.length) {
                createChart('chart-service-share', {
                    type: 'doughnut',
                    data: {
                        labels: svcLabelsFiltered.map(s => s.label || s.name),
                        datasets: [{ data: svcLabelsFiltered.map(s => (s.total_pageviews || 0) + (s.total_api_calls || 0)), backgroundColor: PIE_COLORS.slice(0, svcLabelsFiltered.length), borderWidth: 0 }],
                    },
                    options: { plugins: { legend: { position: 'bottom' } } },
                });
            }

            // Per-service visitors doughnut
            const svcVis = svcs.filter(s => (s.total_unique_visitors || 0) > 0);
            if (svcVis.length) {
                createChart('chart-service-visitors', {
                    type: 'doughnut',
                    data: {
                        labels: svcVis.map(s => s.label || s.name),
                        datasets: [{ data: svcVis.map(s => s.total_unique_visitors || 0), backgroundColor: PIE_COLORS.slice(0, svcVis.length), borderWidth: 0 }],
                    },
                    options: { plugins: { legend: { position: 'bottom' } } },
                });
            }
        }

        // ── Per-Service Traffic Over Time (stacked area) ─────
        const perSvcTrend = ov.perServiceTrend || [];
        if (perSvcTrend.length) {
            // Build unified labels from all series
            const labelSet = new Set();
            for (const s of perSvcTrend) {
                for (const d of s.data) labelSet.add(d.date || d.bucket);
            }
            const labels = Array.from(labelSet).sort();
            const fmtLabel = (l) => useSubDay ? (l.split(' ')[1] || l) : (l.slice(5) || l);
            const datasets = perSvcTrend.map((s, i) => {
                const dataMap = new Map(s.data.map(d => [d.date || d.bucket, (d.pageviews || 0) + (d.api_calls || 0)]));
                const color = PIE_COLORS[i % PIE_COLORS.length];
                return {
                    label: s.label || s.name,
                    data: labels.map(l => dataMap.get(l) || 0),
                    borderColor: color,
                    backgroundColor: color + '33',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 1,
                };
            });
            createChart('chart-per-service-trend', {
                type: 'line',
                data: { labels: labels.map(fmtLabel), datasets },
                options: { scales: { x: {}, y: { beginAtZero: true, stacked: true } }, plugins: { legend: { position: 'bottom' } } },
            });
        }

        // ── Service table with auth breakdown columns ────────
        const tblEl = document.getElementById('analytics-service-table');
        tblEl.innerHTML = svcs.length ? `
            <table class="admin-table">
                <thead><tr><th>Service</th><th>Views</th><th>API</th><th>Visitors</th><th>Logged-in</th><th>Anon</th><th>Bots</th><th>Errors</th><th>Avg ms</th></tr></thead>
                <tbody>${svcs.map(s => {
                    const auth = s.authBreakdown || {};
                    return `
                    <tr>
                        <td><strong>${esc(s.label || s.name)}</strong></td>
                        <td>${fmtNum(s.total_pageviews)}</td>
                        <td>${fmtNum(s.total_api_calls)}</td>
                        <td>${fmtNum(s.total_unique_visitors)}</td>
                        <td style="color:var(--accent-light)">${fmtNum(auth.unique_authenticated_users)}</td>
                        <td style="color:var(--text-secondary)">${fmtNum(auth.anonymous)}</td>
                        <td>${fmtNum(s.total_bot_hits)}</td>
                        <td>${fmtNum(s.total_errors)}</td>
                        <td>${s.avg_response_ms || 0}ms</td>
                    </tr>`;
                }).join('')}</tbody>
            </table>` : '<p class="muted">No data yet</p>';

        // Bot ratio donut
        const totalHuman = (t.total_pageviews || 0) + (t.total_api_calls || 0);
        const totalBots = t.total_bot_hits || 0;
        if (totalHuman > 0 || totalBots > 0) {
            createChart('chart-bot-ratio', {
                type: 'doughnut',
                data: {
                    labels: ['Human Traffic', 'Bot Traffic'],
                    datasets: [{ data: [totalHuman, totalBots], backgroundColor: [CHART_COLORS.success, CHART_COLORS.danger], borderWidth: 0 }],
                },
                options: { plugins: { legend: { position: 'bottom' } } },
            });
        }

        // Bandwidth & usage card
        const bwEl = document.getElementById('analytics-bandwidth');
        bwEl.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
                <div><strong style="color:var(--accent-light)">${fmtNum(bw.total_requests)}</strong><br><span class="muted">Total Requests</span></div>
                <div><strong style="color:var(--accent-light)">${fmtBytes(bw.estimated_bytes)}</strong><br><span class="muted">Est. Transfer</span></div>
                <div><strong style="color:var(--info)">${fmtNum(bw.page_requests)}</strong><br><span class="muted">Page Loads</span></div>
                <div><strong style="color:var(--info)">${fmtNum(bw.api_requests)}</strong><br><span class="muted">API Requests</span></div>
                <div><strong style="color:var(--success)">${fmtNum(ov.sessionCount || 0)}</strong><br><span class="muted">Unique Sessions</span></div>
                <div><strong style="color:var(--success)">${fmtNum(t.total_unique_users || 0)}</strong><br><span class="muted">Logged-in Users</span></div>
            </div>`;

    } catch (e) {
        statsEl.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
    }
}

async function loadServiceAnalytics(serviceName) {
    const period = getAnalyticsPeriod();
    const statsEl = document.getElementById('svc-analytics-stats');
    statsEl.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api(`/api/admin/analytics/service/${serviceName}?${period.qs}`);
        const a = data.analytics;
        const s = a.summary || {};
        const bw = a.bandwidth || {};
        const auth = a.authBreakdown || {};
        const vis = a.visitorTypes || {};
        const rp = a.responsePercentiles || {};

        // Stat cards — more metrics
        statsEl.innerHTML = [
            { icon: 'fa-eye', label: 'Page Views', value: fmtNum(s.total_pageviews) },
            { icon: 'fa-code', label: 'API Calls', value: fmtNum(s.total_api_calls) },
            { icon: 'fa-users', label: 'Unique Visitors', value: fmtNum(s.total_unique_visitors) },
            { icon: 'fa-user', label: 'Logged-in Users', value: fmtNum(s.total_unique_users) },
            { icon: 'fa-id-badge', label: 'Sessions', value: fmtNum(a.sessionCount || 0) },
            { icon: 'fa-robot', label: 'Bot Hits', value: fmtNum(s.total_bot_hits) },
            { icon: 'fa-circle-exclamation', label: 'Errors', value: fmtNum(s.total_errors) },
            { icon: 'fa-gauge-high', label: 'Avg Response', value: (s.avg_response_ms || 0) + 'ms' },
            { icon: 'fa-arrow-up-from-bracket', label: 'Est. Bandwidth', value: fmtBytes(bw.estimated_bytes) },
            // New vs returning needs a visitor identity that outlives a day; ADR-021 analytics keeps none.
            vis.new_visitors != null ? { icon: 'fa-user-plus', label: 'New Visitors', value: fmtNum(vis.new_visitors) } : null,
        ].filter(Boolean).map(s => `<div class="stat-card"><div class="value">${s.value}</div><div class="label"><i class="fa-solid ${s.icon}"></i> ${s.label}</div></div>`).join('');

        // For sub-day ranges, use timeBuckets for the "daily" chart
        const isSubDay = period.hours && period.hours < 24;
        const buckets = a.timeBuckets || [];

        // Daily / fine-grained traffic chart
        if (isSubDay && buckets.length) {
            document.getElementById('svc-hourly-title').textContent = 'Traffic (' + period.hours + 'h)';
            createChart('chart-svc-daily', {
                type: 'line',
                data: {
                    labels: buckets.map(b => { const parts = b.bucket?.split(' '); return parts?.[1] || b.bucket; }),
                    datasets: [
                        { label: 'Page Views', data: buckets.map(b => b.pageviews), borderColor: CHART_COLORS.accent, backgroundColor: 'rgba(139,92,246,0.1)', fill: true, tension: 0.3, pointRadius: 2 },
                        { label: 'API Calls', data: buckets.map(b => b.api_calls), borderColor: CHART_COLORS.info, tension: 0.3, pointRadius: 2 },
                        { label: 'Visitors', data: buckets.map(b => b.unique_visitors), borderColor: CHART_COLORS.success, tension: 0.3, pointRadius: 2 },
                        { label: 'Bots', data: buckets.map(b => b.bot_hits), borderColor: CHART_COLORS.danger, borderDash: [5,5], tension: 0.3, pointRadius: 1 },
                    ],
                },
                options: { scales: { x: {}, y: { beginAtZero: true } } },
            });
        } else {
            document.getElementById('svc-hourly-title').textContent = 'Hourly (24h)';
            const daily = a.daily || [];
            if (daily.length) {
                createChart('chart-svc-daily', {
                    type: 'line',
                    data: {
                        labels: daily.map(d => d.date.slice(5)),
                        datasets: [
                            { label: 'Page Views', data: daily.map(d => d.pageviews), borderColor: CHART_COLORS.accent, backgroundColor: 'rgba(139,92,246,0.1)', fill: true, tension: 0.3, pointRadius: 2 },
                            { label: 'API Calls', data: daily.map(d => d.api_calls), borderColor: CHART_COLORS.info, tension: 0.3, pointRadius: 2 },
                            { label: 'Visitors', data: daily.map(d => d.unique_visitors), borderColor: CHART_COLORS.success, tension: 0.3, pointRadius: 2 },
                            { label: 'Bots', data: daily.map(d => d.bot_hits), borderColor: CHART_COLORS.danger, borderDash: [5,5], tension: 0.3, pointRadius: 1 },
                        ],
                    },
                    options: { scales: { x: {}, y: { beginAtZero: true } } },
                });
            }
        }

        // Hourly bar chart
        const hourly = a.hourly || [];
        if (hourly.length) {
            createChart('chart-svc-hourly', {
                type: 'bar',
                data: {
                    labels: hourly.map(h => h.hour?.slice(11, 16) || ''),
                    datasets: [
                        { label: 'Page Views', data: hourly.map(h => h.pageviews), backgroundColor: 'rgba(139,92,246,0.7)' },
                        { label: 'API Calls', data: hourly.map(h => h.api_calls), backgroundColor: 'rgba(52,152,219,0.7)' },
                    ],
                },
                options: { scales: { x: {}, y: { beginAtZero: true } }, plugins: { legend: { position: 'bottom' } } },
            });
        }

        // Response time percentiles
        const rpEl = document.getElementById('svc-response-percentiles');
        if (rp.p50 !== undefined) {
            const pctBar = (label, val, max) => {
                const pct = max > 0 ? Math.min(100, (val / max) * 100) : 0;
                const color = val < 100 ? 'var(--success)' : val < 300 ? 'var(--accent-light)' : val < 1000 ? 'var(--warning)' : 'var(--danger)';
                return `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span class="muted">${label}</span><strong>${val}ms</strong></div><div class="storage-bar"><div class="storage-bar-fill" style="width:${pct}%;background:${color}"></div></div></div>`;
            };
            rpEl.innerHTML = pctBar('Median (p50)', rp.p50, rp.max) + pctBar('p90', rp.p90, rp.max) + pctBar('p95', rp.p95, rp.max) + pctBar('p99', rp.p99, rp.max) + pctBar('Max', rp.max, rp.max);
        } else {
            rpEl.innerHTML = '<p class="muted">No response time data</p>';
        }

        // Peak hours chart
        const peakHours = a.peakHours || [];
        if (peakHours.length) {
            createChart('chart-svc-peak-hours', {
                type: 'bar',
                data: {
                    labels: peakHours.map(h => h.hour_of_day + ':00'),
                    datasets: [
                        { label: 'Hits', data: peakHours.map(h => h.hits), backgroundColor: 'rgba(139,92,246,0.7)' },
                        { label: 'Visitors', data: peakHours.map(h => h.visitors), backgroundColor: 'rgba(46,204,113,0.5)' },
                    ],
                },
                options: { scales: { x: {}, y: { beginAtZero: true } }, plugins: { legend: { position: 'bottom' } } },
            });
        }

        // Devices pie
        const devices = a.deviceBreakdown || [];
        if (devices.length) {
            createChart('chart-svc-devices', {
                type: 'doughnut',
                data: {
                    labels: devices.map(d => d.device_type || 'unknown'),
                    datasets: [{ data: devices.map(d => d.cnt), backgroundColor: PIE_COLORS.slice(0, devices.length), borderWidth: 0 }],
                },
                options: { plugins: { legend: { position: 'bottom' } } },
            });
        }

        // Browsers pie
        const browsers = a.browserBreakdown || [];
        if (browsers.length) {
            createChart('chart-svc-browsers', {
                type: 'doughnut',
                data: {
                    labels: browsers.map(d => d.browser || 'unknown'),
                    datasets: [{ data: browsers.map(d => d.cnt), backgroundColor: PIE_COLORS.slice(0, browsers.length), borderWidth: 0 }],
                },
                options: { plugins: { legend: { position: 'bottom' } } },
            });
        }

        // OS pie
        const oses = a.osBreakdown || [];
        if (oses.length) {
            createChart('chart-svc-os', {
                type: 'doughnut',
                data: {
                    labels: oses.map(d => d.os || 'unknown'),
                    datasets: [{ data: oses.map(d => d.cnt), backgroundColor: PIE_COLORS.slice(0, oses.length), borderWidth: 0 }],
                },
                options: { plugins: { legend: { position: 'bottom' } } },
            });
        }

        // Bandwidth & sessions card
        const bsEl = document.getElementById('svc-bandwidth-sessions');
        bsEl.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px">
                <div><strong style="color:var(--accent-light)">${fmtBytes(bw.estimated_bytes)}</strong><br><span class="muted">Est. Transfer</span></div>
                <div><strong style="color:var(--accent-light)">${fmtNum(bw.total_requests)}</strong><br><span class="muted">Total Requests</span></div>
                <div><strong style="color:var(--info)">${fmtNum(bw.page_requests)}</strong><br><span class="muted">Page Loads</span></div>
                <div><strong style="color:var(--info)">${fmtNum(bw.api_requests)}</strong><br><span class="muted">API Requests</span></div>
                <div><strong style="color:var(--success)">${fmtNum(a.sessionCount || 0)}</strong><br><span class="muted">Sessions</span></div>
                ${vis.new_visitors != null
                    ? `<div><strong style="color:var(--success)">${fmtNum(vis.new_visitors)}</strong> new / <strong>${fmtNum(vis.returning_visitors)}</strong> returning<br><span class="muted">Visitors</span></div>`
                    : '<div><strong class="muted">Not measured</strong><br><span class="muted" title="ADR-021: no visitor identity outlives a day">New / returning</span></div>'}
            </div>`;

        // Auth vs anonymous chart
        const authCount = auth.authenticated || 0;
        const anonCount = auth.anonymous || 0;
        if (authCount > 0 || anonCount > 0) {
            createChart('chart-svc-auth', {
                type: 'doughnut',
                data: {
                    labels: ['Authenticated (' + fmtNum(auth.unique_authenticated_users) + ' users)', 'Anonymous'],
                    datasets: [{ data: [authCount, anonCount], backgroundColor: [CHART_COLORS.accent, '#4a4a5a'], borderWidth: 0 }],
                },
                options: { plugins: { legend: { position: 'bottom' } } },
            });
        }

        // Top pages
        const pages = a.topPages || [];
        document.getElementById('svc-top-pages').innerHTML = pages.length ? `
            <table class="admin-table">
                <thead><tr><th>Path</th><th>Hits</th><th>Visitors</th></tr></thead>
                <tbody>${pages.slice(0, 15).map(p => `
                    <tr><td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.path)}">${esc(p.path)}</td><td>${fmtNum(p.hits)}</td><td>${fmtNum(p.visitors)}</td></tr>
                `).join('')}</tbody>
            </table>` : '<p class="muted">No data</p>';

        // Top API endpoints
        const apiEndpoints = a.topApiEndpoints || [];
        document.getElementById('svc-top-api').innerHTML = apiEndpoints.length ? `
            <table class="admin-table">
                <thead><tr><th>Endpoint</th><th>Method</th><th>Hits</th><th>Avg ms</th><th>Errors</th></tr></thead>
                <tbody>${apiEndpoints.slice(0, 15).map(e => `
                    <tr>
                        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.path)}">${esc(e.path)}</td>
                        <td><span class="badge badge-info">${esc(e.method)}</span></td>
                        <td>${fmtNum(e.hits)}</td>
                        <td>${e.avg_ms || 0}ms</td>
                        <td style="color:${e.errors > 0 ? 'var(--danger)' : 'inherit'}">${fmtNum(e.errors)}</td>
                    </tr>
                `).join('')}</tbody>
            </table>` : '<p class="muted">No API data</p>';

        // Referers
        const refs = a.topReferers || [];
        document.getElementById('svc-top-referers').innerHTML = refs.length ? `
            <table class="admin-table">
                <thead><tr><th>Referer</th><th>Hits</th></tr></thead>
                <tbody>${refs.slice(0, 10).map(r => `
                    <tr><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.referer)}">${esc(r.referer)}</td><td>${fmtNum(r.hits)}</td></tr>
                `).join('')}</tbody>
            </table>` : '<p class="muted">No referers tracked</p>';

        // Slowest endpoints
        const slow = a.slowestEndpoints || [];
        document.getElementById('svc-slowest').innerHTML = slow.length ? `
            <table class="admin-table">
                <thead><tr><th>Endpoint</th><th>Method</th><th>Avg ms</th><th>Max ms</th><th>Hits</th></tr></thead>
                <tbody>${slow.slice(0, 10).map(e => `
                    <tr>
                        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.path)}">${esc(e.path)}</td>
                        <td><span class="badge badge-warning">${esc(e.method)}</span></td>
                        <td style="color:${e.avg_ms > 500 ? 'var(--danger)' : e.avg_ms > 200 ? 'var(--warning)' : 'inherit'}">${e.avg_ms || 0}ms</td>
                        <td style="color:var(--danger)">${e.max_ms || 0}ms</td>
                        <td>${fmtNum(e.hits)}</td>
                    </tr>
                `).join('')}</tbody>
            </table>` : '<p class="muted">No data</p>';

        // Status codes
        const statuses = a.statusCodes || [];
        if (statuses.length) {
            const statusColors = { '2xx': CHART_COLORS.success, '3xx': CHART_COLORS.info, '4xx': CHART_COLORS.warning, '5xx': CHART_COLORS.danger, 'other': '#707080' };
            createChart('chart-svc-status', {
                type: 'bar',
                data: {
                    labels: statuses.map(s => s.group_code),
                    datasets: [{ label: 'Count', data: statuses.map(s => s.cnt), backgroundColor: statuses.map(s => statusColors[s.group_code] || '#707080') }],
                },
                options: { scales: { x: {}, y: { beginAtZero: true } }, plugins: { legend: { display: false } } },
            });
        }

        // Countries
        const countries = a.countryBreakdown || [];
        document.getElementById('svc-countries').innerHTML = countries.length ? `
            <table class="admin-table">
                <thead><tr><th>Country</th><th>Hits</th></tr></thead>
                <tbody>${countries.slice(0, 15).map(c => `
                    <tr><td>${esc(c.country || 'Unknown')}</td><td>${fmtNum(c.cnt)}</td></tr>
                `).join('')}</tbody>
            </table>` : '<p class="muted">No country data (requires Cloudflare CF-IPCountry header)</p>';
    } catch (e) {
        statsEl.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
    }
}

async function loadBotAnalysis() {
    const period = getAnalyticsPeriod();
    const el = document.getElementById('bots-content');
    el.innerHTML = '<div class="loading">Loading bot analysis...</div>';
    try {
        const data = await api(`/api/admin/analytics/bots?${period.qs}`);
        const bots = data.bots || {};
        let html = '';

        for (const [svcName, svcBots] of Object.entries(bots)) {
            if (!svcBots) continue;
            const label = svcName === 'live' ? 'OpenVibe.Live' : svcName === 'openvibe-network' ? 'OpenVibe.Network' : svcName === 'tools' ? 'OpenVibe.Tools' : svcName === 'games' ? 'OpenVibe.Games' : svcName === 'media' ? 'OpenVibe.Media' : svcName;

            html += `<div class="card"><h3><i class="fa-solid fa-robot"></i> ${esc(label)}</h3>`;

            // Bot types
            const types = svcBots.botTypes || [];
            if (types.length) {
                html += `<h4 style="font-size:12px;color:var(--text-muted);margin:12px 0 8px">Bot Types</h4>
                    <table class="admin-table"><thead><tr><th>Type</th><th>Hits</th><th>Sessions</th></tr></thead>
                    <tbody>${types.map(t => `<tr><td><span class="badge badge-danger">${esc(t.bot_type || 'unknown')}</span></td><td>${fmtNum(t.hits)}</td><td>${t.unique_sessions != null ? fmtNum(t.unique_sessions) : '-'}</td></tr>`).join('')}</tbody></table>`;
            }

            // Top bots by user-agent class (ADR-021: analytics stores no IP addresses)
            const topBots = svcBots.topBotIPs || [];
            if (topBots.length) {
                html += `<h4 style="font-size:12px;color:var(--text-muted);margin:12px 0 8px">Top Bots (user-agent class)</h4>
                    <table class="admin-table"><thead><tr><th>User-agent class</th><th>Hits</th><th>Sessions</th><th>Type</th><th>First Seen</th><th>Last Seen</th></tr></thead>
                    <tbody>${topBots.slice(0, 15).map(b => `
                        <tr><td style="font-family:monospace;font-size:11px">${esc(b.ua_class || '-')}</td><td>${fmtNum(b.hits)}</td>
                        <td>${b.sessions != null ? fmtNum(b.sessions) : '-'}</td>
                        <td><span class="badge badge-warning">${esc(b.bot_type || '?')}</span></td>
                        <td style="font-size:11px">${b.first_seen ? timeAgo(b.first_seen) : '-'}</td>
                        <td style="font-size:11px">${b.last_seen ? timeAgo(b.last_seen) : '-'}</td></tr>
                    `).join('')}</tbody></table>`;
            }

            // High-volume sessions classified as human (rotating session ids, never an IP or user id)
            const suspicious = svcBots.suspiciousIPs || [];
            if (suspicious.length) {
                html += `<h4 style="font-size:12px;color:var(--text-muted);margin:12px 0 8px">Suspicious Sessions (high volume, classified as human)</h4>
                    <table class="admin-table"><thead><tr><th>Session</th><th>Total Hits</th><th>Errors</th><th>Unique Paths</th><th>Period</th></tr></thead>
                    <tbody>${suspicious.map(s => `
                        <tr><td style="font-family:monospace;font-size:11px">${esc(s.session_id || '-')}</td><td>${fmtNum(s.total_hits)}</td>
                        <td style="color:var(--danger)">${fmtNum(s.error_hits)}</td><td>${fmtNum(s.unique_paths)}</td>
                        <td style="font-size:11px">${s.first_seen ? timeAgo(s.first_seen) : '-'} — ${s.last_seen ? timeAgo(s.last_seen) : '-'}</td></tr>
                    `).join('')}</tbody></table>`;
            }

            // Bot trend
            const trend = svcBots.botTrend || [];
            if (trend.length) {
                const canvasId = `chart-bot-trend-${svcName}`;
                html += `<div style="margin-top:12px"><canvas id="${canvasId}" height="180"></canvas></div>`;
                // Queue chart creation after DOM update
                setTimeout(() => {
                    createChart(canvasId, {
                        type: 'line',
                        data: {
                            labels: trend.map(d => d.date?.slice(5) || ''),
                            datasets: [
                                { label: 'Human', data: trend.map(d => d.human_hits || 0), borderColor: CHART_COLORS.success, tension: 0.3, fill: true, backgroundColor: 'rgba(46,204,113,0.1)' },
                                { label: 'Bots', data: trend.map(d => d.bot_hits || 0), borderColor: CHART_COLORS.danger, tension: 0.3, fill: true, backgroundColor: 'rgba(231,76,60,0.1)' },
                            ],
                        },
                        options: { scales: { x: {}, y: { beginAtZero: true } }, plugins: { legend: { position: 'bottom' } } },
                    });
                }, 50);
            }

            html += '</div>';
        }

        el.innerHTML = html || '<p class="muted">No bot data available yet. Analytics data will appear once traffic is recorded.</p>';
    } catch (e) {
        el.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
    }
}
