/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): VPN queue, pastes, storage, VODs, notifications broadcast and email.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════
// VPN queue (via admin proxy)
// ═══════════════════════════════════════════════════════════════
async function loadVPNQueue() {
    const c = document.getElementById('vpn-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/streamer/vpn-queue');
        const queue = data.queue || [];
        if (!queue.length) { c.innerHTML = '<p class="muted">VPN approval queue empty</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr><th>User</th><th>IP</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>${queue.map(item => `
                    <tr>
                        <td><strong>${esc(item.username || item.user_id || '-')}</strong></td>
                        <td>${esc(item.ip_address || '-')}</td>
                        <td>${esc(item.reason || '-')}</td>
                        <td><span class="badge badge-${item.status === 'approved' ? 'success' : item.status === 'denied' ? 'danger' : 'warning'}">${esc(item.status || 'pending')}</span></td>
                        <td>${item.status === 'pending' ? `
                            <div style="display:flex;gap:6px">
                                <button class="btn btn-sm btn-success" onclick="updateVPNStatus('${item.id}','approved')"><i class="fa-solid fa-check"></i> Approve</button>
                                <button class="btn btn-sm btn-danger" onclick="updateVPNStatus('${item.id}','denied')"><i class="fa-solid fa-xmark"></i> Deny</button>
                            </div>` : '<span class="muted">Handled</span>'}
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function updateVPNStatus(id, status) {
    try {
        await api(`/api/admin/streamer/vpn-queue/${id}`, { method: 'PUT', body: { status } });
        toast(`VPN request ${status}`, status === 'approved' ? 'success' : 'info');
        loadVPNQueue();
    } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Pastes (via pastes proxy + streamer settings)
// ═══════════════════════════════════════════════════════════════
async function loadPastesAdmin() {
    const c = document.getElementById('pastes-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const [statsData, configData] = await Promise.all([
            api('/api/admin/streamer-pastes/admin/stats'),
            api('/api/admin/streamer-pastes/config'),
        ]);
        const s = statsData.stats || {};
        const cfg = configData || {};
        c.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card"><div class="value">${Number(s.total || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-paste"></i> Total Pastes</div></div>
                <div class="stat-card"><div class="value">${Number(s.textPastes || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-code"></i> Text Pastes</div></div>
                <div class="stat-card"><div class="value">${Number(s.screenshots || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-image"></i> Screenshots</div></div>
                <div class="stat-card"><div class="value">${Number(s.forks || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-code-fork"></i> Forks</div></div>
            </div>
            <div class="card">
                <h3><i class="fa-solid fa-sliders"></i> Paste Limits</h3>
                <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
                    <div class="form-field"><label>Max Paste Size (KB)</label><input type="number" id="paste-max-size-kb" value="${esc(cfg.maxSizeKb || 512)}"></div>
                    <div class="form-field"><label>Max Image Size (MB)</label><input type="number" id="paste-screenshot-max-mb" value="${esc(cfg.screenshotMaxSizeMb || 8)}"></div>
                    <div class="form-field"><label>Cooldown (seconds)</label><input type="number" id="paste-cooldown" value="${esc(cfg.cooldownSeconds || 30)}"></div>
                    <div class="form-field"><label>Max / User / Day</label><input type="number" id="paste-max-per-day" value="${esc(cfg.maxPerUserPerDay || 50)}"></div>
                </div>
                <div class="setting-row"><label><strong>Allow anonymous pastes</strong></label><input type="checkbox" id="paste-anon" ${cfg.anonAllowed !== false ? 'checked' : ''} style="width:18px;height:18px"></div>
                <div class="setting-row"><label><strong>Allow image uploads</strong></label><input type="checkbox" id="paste-image-upload" ${cfg.imageUploadEnabled !== false ? 'checked' : ''} style="width:18px;height:18px"></div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
                    <button class="btn btn-primary" onclick="savePasteAdminConfig()"><i class="fa-solid fa-floppy-disk"></i> Save Paste Settings</button>
                    <button class="btn btn-danger" onclick="deleteAllPasteForks()"><i class="fa-solid fa-trash-can"></i> Delete All Forks (${Number(s.forks || 0).toLocaleString()})</button>
                </div>
            </div>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function savePasteAdminConfig() {
    try {
        await api('/api/admin/streamer/settings', {
            method: 'PUT',
            body: {
                settings: {
                    paste_max_size_kb: document.getElementById('paste-max-size-kb').value,
                    paste_screenshot_max_size_mb: document.getElementById('paste-screenshot-max-mb').value,
                    paste_cooldown_seconds: document.getElementById('paste-cooldown').value,
                    paste_max_per_user_per_day: document.getElementById('paste-max-per-day').value,
                    paste_anon_allowed: document.getElementById('paste-anon').checked ? 'true' : 'false',
                    paste_image_upload_enabled: document.getElementById('paste-image-upload').checked ? 'true' : 'false',
                },
            },
        });
        toast('Paste settings saved', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteAllPasteForks() {
    if (!confirm('Delete all forked pastes? This cannot be undone.')) return;
    try {
        const data = await api('/api/admin/streamer-pastes/admin/forks', { method: 'DELETE' });
        toast(`Deleted ${Number(data.deleted || 0).toLocaleString()} forked paste(s)`, 'success');
        loadPastesAdmin();
    } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Storage (via openvibelive proxy)
// ═══════════════════════════════════════════════════════════════
async function loadStorage() {
    const c = document.getElementById('storage-content');
    c.innerHTML = '<div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Analyzing storage...</div>';
    try {
        const [data, tierData] = await Promise.all([
            api('/api/admin/streamer/storage'),
            api('/api/admin/streamer/storage/tiers').catch(() => null),
        ]);
        const d = data.disk || {};
        const usePct = d.total ? ((d.used / d.total) * 100).toFixed(1) : 0;
        const dataPct = d.total ? ((data.dataTotal?.bytes || 0) / d.total * 100).toFixed(1) : 0;
        const pctColor = parseFloat(usePct) >= 90 ? 'var(--danger)' : parseFloat(usePct) >= 75 ? 'var(--warning)' : 'var(--success)';
        const breakdown = (data.breakdown || []).sort((a, b) => b.bytes - a.bytes);
        const maxB = Math.max(...breakdown.map(b => b.bytes), 1);

        c.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
                <div class="card">
                    <h3><i class="fa-solid fa-hard-drive"></i> Disk Usage</h3>
                    <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:14px">
                        <span>${fmtBytes(d.used)} used of ${fmtBytes(d.total)}</span>
                        <span style="font-weight:700;color:${pctColor}">${usePct}%</span>
                    </div>
                    <div class="storage-bar">
                        <div class="storage-bar-fill" style="background:${pctColor};width:${usePct}%"></div>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--text-muted)">
                        <span>${fmtBytes(d.available)} available</span>
                        <span>Mount: ${esc(d.mount || '/')}</span>
                    </div>
                </div>
                <div class="card">
                    <h3><i class="fa-solid fa-database"></i> Data Summary</h3>
                    <div class="stats-grid" style="margin:0">
                        <div class="stat-card" style="padding:10px"><div class="value" style="font-size:18px">${fmtBytes(data.dataTotal?.bytes || 0)}</div><div class="label">Total Data</div></div>
                        <div class="stat-card" style="padding:10px"><div class="value" style="font-size:18px">${(data.dataTotal?.files || 0).toLocaleString()}</div><div class="label">Files</div></div>
                        <div class="stat-card" style="padding:10px"><div class="value" style="font-size:18px">${fmtBytes(data.database?.bytes || 0)}</div><div class="label">Database</div></div>
                        <div class="stat-card" style="padding:10px"><div class="value" style="font-size:18px">${dataPct}%</div><div class="label">% of Disk</div></div>
                    </div>
                </div>
            </div>

            <h3 style="margin-bottom:12px"><i class="fa-solid fa-folder-tree"></i> Storage Breakdown</h3>
            <div style="display:grid;gap:8px;margin-bottom:24px">
                ${breakdown.map(b => `
                    <div style="display:grid;grid-template-columns:140px 1fr 100px 80px;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px">
                        <span style="font-weight:600;font-size:13px"><i class="fa-solid ${esc(b.icon || 'fa-folder')}" style="width:18px;text-align:center;margin-right:6px;color:var(--accent)"></i>${esc(b.name)}</span>
                        <div class="storage-bar"><div class="storage-bar-fill" style="background:var(--accent);width:${(b.bytes/maxB*100).toFixed(1)}%"></div></div>
                        <span style="text-align:right;font-weight:600;font-size:12px">${fmtBytes(b.bytes)}</span>
                        <span style="text-align:right;font-size:11px;color:var(--text-muted)">${b.files?.toLocaleString() || 0} files</span>
                    </div>
                `).join('')}
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <h3><i class="fa-solid fa-video"></i> VOD Management</h3>
                <div style="display:flex;gap:8px">
                    <select id="vod-sort" onchange="loadVodTable()" style="padding:6px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px">
                        <option value="size">Sort by Size</option>
                        <option value="date">Sort by Date</option>
                        <option value="duration">Sort by Duration</option>
                    </select>
                    <button class="btn btn-sm btn-danger" id="vod-bulk-btn" disabled onclick="bulkDeleteVods()"><i class="fa-solid fa-trash-can"></i> Delete Selected</button>
                </div>
            </div>
            <div id="vod-table"><div class="loading">Loading VODs...</div></div>
        `;
        loadVodTable();
        loadStreamerStorageExtras(tierData);
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

// ── Streamer storage tiers (Local/B2/R2) + cloud usage/cost (openvibe.network admin) ──
function buildStreamerTierHtml(tierData) {
    if (!tierData) return '';
    const t = tierData.tiers || {};
    const ct = tierData.clipTiers || {};
    const prov = tierData.providers || {};
    const ts = tierData.settings || {};
    const L = t.local || { count: 0, bytes: 0 };
    const B = t.b2 || { count: 0, bytes: 0 };
    const R = t.r2 || { count: 0, bytes: 0 };
    const totalBytes = (L.bytes || 0) + (B.bytes || 0) + (R.bytes || 0);
    const totalVods = (L.count || 0) + (B.count || 0) + (R.count || 0);
    const totalClips = ((ct.local && ct.local.count) || 0) + ((ct.b2 && ct.b2.count) || 0) + ((ct.r2 && ct.r2.count) || 0);
    const offloaded = (B.bytes || 0) + (R.bytes || 0);
    const offloadPct = totalBytes > 0 ? ((offloaded / totalBytes) * 100).toFixed(1) : '0.0';
    const pctOf = (b) => totalBytes > 0 ? (b / totalBytes) * 100 : 0;
    const provStatus = (p) => {
        if (!p) return '<span style="color:var(--text-muted)">—</span>';
        if (!p.configured) return '<span style="color:var(--text-muted)">not configured</span>';
        return p.healthy
            ? '<span style="color:var(--success,#22c55e)"><i class="fa-solid fa-circle-check"></i> healthy</span>' + (p.bucket ? ' <span style="color:var(--text-muted);font-size:11px">· ' + esc(p.bucket) + '</span>' : '')
            : '<span style="color:var(--danger,#ef4444)"><i class="fa-solid fa-circle-xmark"></i> error</span>';
    };
    const rows = [
        { label: 'Local (SSD)', icon: 'fa-hard-drive', color: '#f59e0b', v: L, clips: (ct.local && ct.local.count) || 0, status: '<span style="color:var(--text-muted)">primary disk</span>' },
        { label: 'Backblaze B2', icon: 'fa-box-archive', color: '#e21e2b', v: B, clips: (ct.b2 && ct.b2.count) || 0, status: provStatus(prov.b2) },
        { label: 'Cloudflare R2', icon: 'fa-cloud', color: '#f6821f', v: R, clips: (ct.r2 && ct.r2.count) || 0, status: provStatus(prov.r2) },
    ];
    const bar = '<div style="display:flex;height:16px;border-radius:8px;overflow:hidden;margin:6px 0 14px;background:var(--bg-tertiary)">'
        + '<div title="Local ' + pctOf(L.bytes).toFixed(1) + '%" style="width:' + pctOf(L.bytes) + '%;background:#f59e0b"></div>'
        + '<div title="B2 ' + pctOf(B.bytes).toFixed(1) + '%" style="width:' + pctOf(B.bytes) + '%;background:#e21e2b"></div>'
        + '<div title="R2 ' + pctOf(R.bytes).toFixed(1) + '%" style="width:' + pctOf(R.bytes) + '%;background:#f6821f"></div></div>';
    const rowHtml = rows.map(r => '<tr>'
        + '<td style="padding:8px 10px"><i class="fa-solid ' + r.icon + '" style="color:' + r.color + '"></i> <strong>' + r.label + '</strong></td>'
        + '<td style="padding:8px 10px;text-align:right">' + (r.v.count || 0).toLocaleString() + '</td>'
        + '<td style="padding:8px 10px;text-align:right">' + fmtBytes(r.v.bytes || 0) + '</td>'
        + '<td style="padding:8px 10px;text-align:right">' + pctOf(r.v.bytes).toFixed(1) + '%</td>'
        + '<td style="padding:8px 10px;text-align:right">' + (r.clips || 0).toLocaleString() + '</td>'
        + '<td style="padding:8px 10px">' + r.status + '</td></tr>').join('');
    return '<div class="card" style="margin-bottom:24px">'
        + '<h3 style="margin:0 0 6px"><i class="fa-solid fa-layer-group"></i> Storage Tiers <span style="color:var(--text-muted);font-size:13px;font-weight:400">— ' + offloadPct + '% of VOD data offloaded to cloud</span></h3>'
        + bar
        + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">'
        + '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)">'
        + '<th style="padding:6px 10px">Tier</th><th style="padding:6px 10px;text-align:right">VODs</th><th style="padding:6px 10px;text-align:right">VOD Size</th><th style="padding:6px 10px;text-align:right">Share</th><th style="padding:6px 10px;text-align:right">Clips</th><th style="padding:6px 10px">Provider</th></tr></thead>'
        + '<tbody>' + rowHtml
        + '<tr style="border-top:2px solid var(--border);font-weight:700"><td style="padding:8px 10px">Total</td><td style="padding:8px 10px;text-align:right">' + totalVods.toLocaleString() + '</td><td style="padding:8px 10px;text-align:right">' + fmtBytes(totalBytes) + '</td><td style="padding:8px 10px;text-align:right">100%</td><td style="padding:8px 10px;text-align:right">' + totalClips.toLocaleString() + '</td><td style="padding:8px 10px">' + (tierData.sweepRunning ? '<span style="color:#f59e0b"><i class="fa-solid fa-spinner fa-spin"></i> sweeping</span>' : '<span style="color:var(--text-muted)">idle</span>') + '</td></tr>'
        + '</tbody></table></div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--text-muted);margin-top:12px">'
        + '<span><i class="fa-solid ' + (ts.enabled ? 'fa-toggle-on' : 'fa-toggle-off') + '" style="color:' + (ts.enabled ? '#22c55e' : '#ef4444') + '"></i> Auto-offload: ' + (ts.enabled ? 'ON' : 'OFF') + '</span>'
        + '<span>| Age &ge; ' + (ts.minAgeDays != null ? ts.minAgeDays : '?') + 'd</span><span>| Views &le; ' + (ts.maxViewsForCold != null ? ts.maxViewsForCold : '?') + '</span><span>| Idle &ge; ' + (ts.minLastAccessDays != null ? ts.minLastAccessDays : '?') + 'd</span>'
        + '</div></div>';
}

function loadStreamerStorageExtras(tierData) {
    const c = document.getElementById('storage-content');
    if (!c) return;
    c.insertAdjacentHTML('afterbegin', '<div id="streamer-cloud-storage" style="margin-bottom:24px"></div>');
    c.insertAdjacentHTML('afterbegin', buildStreamerTierHtml(tierData));
    loadStreamerCloudStorage();
}

async function loadStreamerCloudStorage(force) {
    const el = document.getElementById('streamer-cloud-storage');
    if (!el) return;
    const header = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
        + '<h3 style="margin:0"><i class="fa-solid fa-cloud"></i> Cloud Storage — B2 &amp; R2 Usage &amp; Cost</h3>'
        + '<button class="btn btn-sm btn-outline" onclick="loadStreamerCloudStorage(true)"><i class="fa-solid fa-rotate"></i> Rescan</button></div>';
    el.innerHTML = header + '<div class="loading"><i class="fa-solid fa-spinner fa-spin"></i> Scanning cloud buckets…</div>';
    try {
        const data = await api('/api/admin/streamer/storage/buckets' + (force ? '?force=1' : ''));
        const usage = data.usage || {};
        const costs = data.costs || {};
        const money = (n) => '$' + (Number(n) || 0).toFixed(2);
        const card = (key, label, color) => {
            const u = usage[key];
            const cc = costs[key];
            if (!u || u.configured === false) return '<div class="card" style="flex:1;min-width:260px"><strong style="color:' + color + '"><i class="fa-solid fa-cloud"></i> ' + label + '</strong><div style="color:var(--text-muted);margin-top:8px">Not configured</div></div>';
            if (u.error) return '<div class="card" style="flex:1;min-width:260px"><strong style="color:' + color + '"><i class="fa-solid fa-cloud"></i> ' + label + '</strong><div style="color:var(--danger,#ef4444);margin-top:8px">Scan error: ' + esc(u.error) + '</div></div>';
            const tops = Object.entries(u.prefixes || {}).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8);
            const prefixRows = tops.map(([p, v]) => '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);padding:2px 0"><span>' + esc(p) + '</span><span>' + fmtBytes(v.bytes) + ' · ' + v.objects.toLocaleString() + '</span></div>').join('');
            return '<div class="card" style="flex:1;min-width:260px">'
                + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><strong style="color:' + color + '"><i class="fa-solid fa-cloud"></i> ' + label + '</strong><span style="color:var(--text-muted);font-size:12px">' + esc(u.bucket || '') + '</span></div>'
                + '<div style="display:flex;gap:16px;margin-bottom:10px"><div><div style="font-size:20px;font-weight:700">' + fmtBytes(u.bytes) + '</div><div style="color:var(--text-muted);font-size:11px">' + u.objects.toLocaleString() + ' objects</div></div>'
                + '<div><div style="font-size:20px;font-weight:700;color:' + color + '">' + (cc ? money(cc.storageMonthly) : '—') + '<span style="font-size:12px;font-weight:400;color:var(--text-muted)">/mo</span></div><div style="color:var(--text-muted);font-size:11px">storage @ $' + (cc ? cc.storagePerGbMonth : '?') + '/GB</div></div></div>'
                + '<div style="color:var(--text-muted);font-size:11px;margin-bottom:6px">Egress: ' + (cc ? esc(cc.egressNote) : '—') + '</div>'
                + (prefixRows ? '<div style="border-top:1px solid var(--border);padding-top:6px">' + prefixRows + '</div>' : '') + '</div>';
        };
        el.innerHTML = header
            + '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">' + card('b2', 'Backblaze B2', '#e21e2b') + card('r2', 'Cloudflare R2', '#f6821f') + '</div>'
            + '<div class="card" style="display:flex;align-items:center;justify-content:space-between"><span><i class="fa-solid fa-file-invoice-dollar" style="color:var(--accent)"></i> <strong>Estimated cloud storage cost</strong> <span style="color:var(--text-muted);font-size:12px">(list prices; excludes egress/operations)</span></span><span style="font-size:22px;font-weight:800;color:var(--accent)">' + money(costs.totalStorageMonthly) + '<span style="font-size:13px;font-weight:400;color:var(--text-muted)">/mo</span></span></div>';
    } catch (e) {
        el.innerHTML = header + '<div style="color:var(--danger,#ef4444)">Failed to scan buckets: ' + esc(e.message) + '</div>';
    }
}

async function loadVodTable() {
    const c = document.getElementById('vod-table');
    if (!c) return;
    const sort = document.getElementById('vod-sort')?.value || 'size';
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api(`/api/admin/streamer/storage/vods?sort=${sort}&order=desc&limit=100`);
        const vods = data.vods || [];
        if (!vods.length) { c.innerHTML = '<p class="muted">No VODs found</p>'; return; }

        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th style="width:32px"><input type="checkbox" onchange="toggleAllVods(this.checked)" style="cursor:pointer"></th>
                    <th>Title</th><th>User</th><th style="text-align:right">Size</th><th style="text-align:right">Duration</th><th>Date</th>
                </tr></thead>
                <tbody>${vods.map(v => `
                    <tr>
                        <td><input type="checkbox" class="vod-cb" value="${v.id}" onchange="updateVodSelection()" style="cursor:pointer"></td>
                        <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v.title||'')}">${esc(v.title || '(untitled)')}</td>
                        <td>${esc(v.username || '-')}</td>
                        <td style="text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${fmtBytes(v.diskSize || v.file_size || 0)}</td>
                        <td style="text-align:right;color:var(--text-secondary)">${fmtDuration(v.duration_seconds)}</td>
                        <td>${v.created_at ? timeAgo(v.created_at) : '-'}</td>
                    </tr>
                `).join('')}</tbody>
            </table>
            ${data.total > 100 ? `<p class="muted" style="margin-top:8px;font-size:11px">Showing top 100 of ${data.total.toLocaleString()} VODs</p>` : ''}`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

function toggleAllVods(checked) { document.querySelectorAll('.vod-cb').forEach(cb => cb.checked = checked); updateVodSelection(); }
function updateVodSelection() {
    const n = document.querySelectorAll('.vod-cb:checked').length;
    const btn = document.getElementById('vod-bulk-btn');
    if (btn) { btn.disabled = n === 0; btn.innerHTML = `<i class="fa-solid fa-trash-can"></i> Delete Selected${n ? ` (${n})` : ''}`; }
}

async function bulkDeleteVods() {
    const ids = [...document.querySelectorAll('.vod-cb:checked')].map(cb => parseInt(cb.value));
    if (!ids.length) return;
    if (!confirm(`Permanently delete ${ids.length} VOD(s)?`)) return;
    try {
        const data = await api('/api/admin/streamer/storage/vods/bulk', { method: 'DELETE', body: { ids } });
        toast(`Deleted ${data.deleted || 0} VOD(s), freed ${fmtBytes(data.freed || 0)}`, 'success');
        loadStorage();
    } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Broadcast Notification
// ═══════════════════════════════════════════════════════════════
async function sendBroadcast() {
    const title = document.getElementById('broadcast-title')?.value.trim();
    const message = document.getElementById('broadcast-msg')?.value.trim();
    const icon = document.getElementById('broadcast-icon')?.value.trim() || '📢';
    const priority = document.getElementById('broadcast-priority')?.value || 'normal';
    const url = document.getElementById('broadcast-url')?.value.trim();
    if (!title) return toast('Title required', 'error');
    if (!confirm(`Send broadcast "${title}" to all users?`)) return;
    try {
        const data = await api('/api/admin/broadcast', { method: 'POST', body: { title, message, icon, priority, url } });
        toast(`Broadcast sent to ${data.sent || 0} users`, 'success');
        document.getElementById('broadcast-title').value = '';
        document.getElementById('broadcast-msg').value = '';
    } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Email Configuration
// ═══════════════════════════════════════════════════════════════
async function loadEmail() {
    const c = document.getElementById('email-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/email');
        const email = data.email || {};
        const metrics = data.metrics || {};
        const summary = metrics.summary || {};
        const byType = Array.isArray(metrics.by_type) ? metrics.by_type : [];
        const recent = Array.isArray(metrics.recent) ? metrics.recent : [];
        c.innerHTML = `
            <div class="stats-grid" style="margin-bottom:16px">
                <div class="stat-card"><div class="value">${Number(summary.sent || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-paper-plane"></i> Emails Sent</div></div>
                <div class="stat-card"><div class="value">${Number(summary.failed || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-triangle-exclamation"></i> Failed</div></div>
                <div class="stat-card"><div class="value">${Number(summary.sent_24h || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-clock"></i> Sent · 24h</div></div>
                <div class="stat-card"><div class="value">${Number(summary.password_resets_24h || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-key"></i> Password Resets · 24h</div></div>
                <div class="stat-card"><div class="value">${Number(summary.notifications_24h || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-bell"></i> Notification Emails · 24h</div></div>
                <div class="stat-card"><div class="value">${Number(summary.tests_24h || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-vial"></i> Test Emails · 24h</div></div>
            </div>

            <div class="card" style="padding:16px;margin-bottom:16px">
                <h3 style="margin-bottom:10px"><i class="fa-solid fa-chart-line"></i> Email Delivery Metrics</h3>
                <div class="muted" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
                    <div><strong>Total Logged:</strong> ${Number(summary.total || 0).toLocaleString()}</div>
                    <div><strong>Failed · 24h:</strong> ${Number(summary.failed_24h || 0).toLocaleString()}</div>
                    <div><strong>Last Sent:</strong> ${summary.last_sent_at ? esc(timeAgo(summary.last_sent_at)) : 'Never'}</div>
                    <div><strong>Last Failure:</strong> ${summary.last_failed_at ? esc(timeAgo(summary.last_failed_at)) : 'Never'}</div>
                </div>
            </div>

            <form id="email-form" style="max-width:600px;margin-bottom:16px">
                <div class="setting-row">
                    <label><strong>Email Enabled</strong></label>
                    <input type="checkbox" id="email-enabled" ${email.enabled ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer">
                </div>
                ${email.issue ? `<div style="background:#e74c3c22;border:1px solid #e74c3c44;border-radius:8px;padding:10px 14px;margin:8px 0 12px;font-size:13px;color:#e74c3c"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(email.issue)}</div>` : email.ready ? `<div style="background:#27ae6022;border:1px solid #27ae6044;border-radius:8px;padding:10px 14px;margin:8px 0 12px;font-size:13px;color:#27ae60"><i class="fa-solid fa-circle-check"></i> Resend is ready — emails will be delivered</div>` : ''}

                <h4 style="margin:12px 0 10px;font-size:14px"><i class="fa-solid fa-key"></i> Resend API</h4>
                <div class="form-field"><label>API Key</label><input type="password" id="email-api-key" value="" placeholder="${email.api_key_source === 'env' ? `Set in the environment (${esc(email.api_key_env || 'RESEND_API_KEY')})` : 'Not set'}" disabled autocomplete="off"></div>
                <p class="muted" style="margin:-4px 0 8px;font-size:11px">${email.api_key_source === 'env' ? `The key comes from <code>${esc(email.api_key_env || 'RESEND_API_KEY')}</code> in the server's environment file; change it there.` : `Provider secrets live in the server's environment only: get a key from <a href="https://resend.com/api-keys" target="_blank" rel="noopener" style="color:var(--accent)">resend.com/api-keys</a>, set <code>${esc(email.api_key_env || 'RESEND_API_KEY')}</code> in <code>/etc/openvibe/network.env</code>, and restart Network.`}</p>

                <h4 style="margin:20px 0 10px;font-size:14px"><i class="fa-solid fa-envelope"></i> From Addresses</h4>
                <div class="form-field"><label>Default From Email</label><input type="email" id="email-from-email" value="${esc(email.from_email || '')}" placeholder="noreply@openvibe.network"></div>
                <div class="form-field"><label>Default From Name</label><input type="text" id="email-from-name" value="${esc(email.from_name || '')}" placeholder="OpenVibe"></div>
                <div class="form-field"><label>OpenVibe.Live From <span class="muted">(optional override)</span></label><input type="email" id="email-from-openvibelive" value="${esc(email.from_email_openvibelive || '')}" placeholder="noreply@openvibe.live"></div>
                <div class="form-field"><label>OpenVibe Quest From <span class="muted">(optional override)</span></label><input type="email" id="email-from-openvibegames" value="${esc(email.from_email_openvibegames || '')}" placeholder="noreply@openvibe.games"></div>
                <div class="form-field"><label>OpenVibe Tools From <span class="muted">(optional override)</span></label><input type="email" id="email-from-openvibenetwork" value="${esc(email.from_email_openvibenetwork || '')}" placeholder="noreply@openvibe.network"></div>

                <div style="display:flex;gap:8px;margin-top:16px">
                    <button type="button" class="btn btn-primary" onclick="saveEmail()"><i class="fa-solid fa-floppy-disk"></i> Save Email Config</button>
                    <button type="button" class="btn btn-outline" onclick="testEmail()"><i class="fa-solid fa-paper-plane"></i> Send Test Email</button>
                </div>
                <div style="background:#2a2a3822;border:1px solid #333340;border-radius:8px;padding:12px 14px;margin-top:16px;font-size:12px;color:var(--text-muted)">
                    <strong style="color:var(--text)"><i class="fa-solid fa-globe"></i> DNS Setup</strong><br>
                    Add your domain at <a href="https://resend.com/domains" target="_blank" style="color:var(--accent)">resend.com/domains</a> and add the SPF (TXT + MX) and DKIM records to your DNS provider. Once verified, emails will be sent from your domain.
                </div>
            </form>

            <div class="card" style="padding:16px;margin-bottom:16px">
                <h3 style="margin-bottom:10px"><i class="fa-solid fa-layer-group"></i> Delivery Breakdown · 30 days</h3>
                ${byType.length ? `
                    <table class="admin-table">
                        <thead><tr><th>Email Type</th><th>Status</th><th>Count</th></tr></thead>
                        <tbody>
                            ${byType.map(row => `
                                <tr>
                                    <td>${esc(row.email_type)}</td>
                                    <td>${row.status === 'sent' ? '<span class="badge badge-success">Sent</span>' : '<span class="badge badge-danger">Failed</span>'}</td>
                                    <td>${Number(row.count || 0).toLocaleString()}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>`
                : '<p class="muted">No email activity logged yet.</p>'}
            </div>

            <div class="card" style="padding:16px">
                <h3 style="margin-bottom:10px"><i class="fa-solid fa-clock-rotate-left"></i> Recent Email Activity</h3>
                ${recent.length ? `
                    <table class="admin-table">
                        <thead><tr><th>When</th><th>Type</th><th>Recipient</th><th>Status</th><th>Subject</th><th>Error</th></tr></thead>
                        <tbody>
                            ${recent.map(row => `
                                <tr>
                                    <td style="white-space:nowrap">${esc(timeAgo(row.created_at))}</td>
                                    <td>${esc(row.email_type)}</td>
                                    <td>${esc(row.recipient)}</td>
                                    <td>${row.status === 'sent' ? '<span class="badge badge-success">Sent</span>' : '<span class="badge badge-danger">Failed</span>'}</td>
                                    <td>${esc(row.subject || '-')}</td>
                                    <td style="font-size:11px;color:var(--text-muted)">${esc(row.error_message || '-')}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>`
                : '<p class="muted">No email activity logged yet.</p>'}
            </div>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function saveEmail() {
    try {
        await api('/api/admin/email', { method: 'PUT', body: {
            enabled: document.getElementById('email-enabled').checked,
            api_key: document.getElementById('email-api-key').disabled ? undefined : document.getElementById('email-api-key').value,
            from_email: document.getElementById('email-from-email').value,
            from_name: document.getElementById('email-from-name').value,
            from_email_openvibelive: document.getElementById('email-from-openvibelive').value,
            from_email_openvibegames: document.getElementById('email-from-openvibegames').value,
            from_email_openvibenetwork: document.getElementById('email-from-openvibenetwork').value,
        }});
        toast('Email configuration saved', 'success');
        loadEmail();
    } catch (e) { toast(e.message, 'error'); }
}

async function testEmail() {
    const email = prompt('Send test email to:');
    if (!email) return;
    try {
        const result = await api('/api/admin/email/test', { method: 'POST', body: { email } });
        if (result.sent) {
            toast('Test email sent successfully! Check your inbox.', 'success');
        } else {
            toast(result.error || 'Send failed — check delivery log', 'error');
        }
    } catch (e) { toast(e.message, 'error'); }
}
