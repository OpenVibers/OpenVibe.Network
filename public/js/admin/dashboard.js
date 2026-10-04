/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): the dashboard tab.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════════════════════════════
async function loadDashboard() {
    const statsEl = document.getElementById('dashboard-stats');
    const healthEl = document.getElementById('health-info');

    // Load both openvibe-network health and OpenVibe.Live stats in parallel
    const [toolsHealth, streamerStats] = await Promise.allSettled([
        api('/api/admin/health'),
        api('/api/admin/streamer/stats'),
    ]);

    const th = toolsHealth.status === 'fulfilled' ? toolsHealth.value.health : null;
    const ss = streamerStats.status === 'fulfilled' ? (streamerStats.value.stats || streamerStats.value) : null;

    const stats = [
        { label: 'Registered Users', value: th?.users || 0, icon: 'fa-users' },
        { label: 'Active Sessions', value: th?.active_sessions || 0, icon: 'fa-plug' },
        { label: 'Active Streams', value: ss?.streams?.live || ss?.activeStreams || 0, icon: 'fa-broadcast-tower' },
        { label: 'Total Streams', value: ss?.streams?.total || ss?.totalStreams || 0, icon: 'fa-video' },
        { label: 'Active Bans', value: ss?.users?.banned || ss?.activeBans || 0, icon: 'fa-ban' },
        { label: 'Notifications', value: th?.total_notifications || 0, icon: 'fa-bell' },
        { label: 'Unread Notifs', value: th?.unread_notifications || 0, icon: 'fa-bell-slash' },
        { label: 'Anon Users', value: th?.anon_users || 0, icon: 'fa-ghost' },
    ];

    statsEl.innerHTML = stats.map(s => `
        <div class="stat-card">
            <div class="value">${typeof s.value === 'number' ? s.value.toLocaleString() : s.value}</div>
            <div class="label"><i class="fa-solid ${s.icon}"></i> ${s.label}</div>
        </div>
    `).join('');

    // Health details
    if (th) {
        const mem = th.memory;
        const upH = Math.floor(th.uptime / 3600);
        const upM = Math.floor((th.uptime % 3600) / 60);
        healthEl.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;font-size:13px">
                <div><strong>Uptime:</strong> ${upH}h ${upM}m</div>
                <div><strong>Heap Used:</strong> ${fmtBytes(mem?.heapUsed)}</div>
                <div><strong>Heap Total:</strong> ${fmtBytes(mem?.heapTotal)}</div>
                <div><strong>RSS:</strong> ${fmtBytes(mem?.rss)}</div>
                <div><strong>Email:</strong> ${th.ses_enabled ? '<span style="color:var(--success)">Enabled</span>' : '<span style="color:var(--text-muted)">Disabled</span>'}</div>
            </div>
        `;
    } else {
        healthEl.innerHTML = '<p class="muted">Could not load health data</p>';
    }
}
