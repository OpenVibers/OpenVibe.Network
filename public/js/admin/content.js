/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): pastes, storage, VODs, notifications broadcast and email.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// The VPN queue tab is gone: nothing writes Live's vpn_approvals since IP approval moved to OpenVibe.Chat. Held
// messages are reviewed per channel by the streamer and channel mods (openvibe.live/dashboard/moderation); the
// operator checklist points there.

// ═══════════════════════════════════════════════════════════════
// Pastes (OpenVibe.Community, through the pastes proxy: Network → Live → Community)
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
        const n = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString() : '—');
        const limit = (name, value) => `
            <div class="setting-row">
                <span style="flex:1"><strong style="font-size:13px">${esc(name)}</strong></span>
                <span style="font-size:13px">${esc(value)}</span>
            </div>`;
        c.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card"><div class="value">${n(s.total || 0)}</div><div class="label"><i class="fa-solid fa-paste" aria-hidden="true"></i> Total Pastes</div></div>
                <div class="stat-card"><div class="value">${n(s.textPastes || 0)}</div><div class="label"><i class="fa-solid fa-code" aria-hidden="true"></i> Text Pastes</div></div>
                <div class="stat-card"><div class="value">${n(s.screenshots || 0)}</div><div class="label"><i class="fa-solid fa-image" aria-hidden="true"></i> Screenshots</div></div>
                <div class="stat-card"><div class="value">${n(s.forks || 0)}</div><div class="label"><i class="fa-solid fa-code-fork" aria-hidden="true"></i> Forks</div></div>
            </div>
            <div class="card">
                <h3><i class="fa-solid fa-sliders" aria-hidden="true"></i> Paste limits</h3>
                <p class="muted" style="margin-bottom:8px">OpenVibe.Community sets these paste limits; this view is read-only. Change them in Community when adjusting capacity; higher limits allow more content and lower limits allow less.</p>
                ${limit('Largest text paste', `${n(cfg.maxSizeKb)} KB`)}
                ${limit('Largest image', `${n(cfg.screenshotMaxSizeMb)} MB`)}
                ${limit('Wait between pastes', `${n(cfg.cooldownSeconds)} seconds`)}
                ${limit('Pastes per person per day', Number(cfg.maxPerUserPerDay) === 0 ? 'No limit' : n(cfg.maxPerUserPerDay))}
            </div>
            <div class="card">
                <h3><i class="fa-solid fa-code-fork" aria-hidden="true"></i> Forks</h3><p class="admin-intro">These are copies people made of existing pastes. Delete them only during deliberate cleanup; deleted copies cannot be recovered here.</p>
                <p class="muted" style="margin-bottom:12px">Copies people made of other pastes. Deleting them cannot be undone.</p>
                <button class="btn btn-danger" onclick="deleteAllPasteForks()"${Number(s.forks || 0) ? '' : ' disabled'}><i class="fa-solid fa-trash-can" aria-hidden="true"></i> Delete all forks (${n(s.forks || 0)})</button>
            </div>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
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
    c.innerHTML = '<div class="loading"><span class="ov-mark" data-state="busy" data-size="16" data-tone="ink" aria-hidden="true"></span> Analyzing storage...</div>';
    try {
        const [data, tierData, vodData] = await Promise.all([
            api('/api/admin/streamer/storage'),
            api('/api/admin/streamer/storage/tiers').catch(() => null),
            api('/api/admin/streamer/storage/vods?sort=size&order=desc&limit=100').catch(() => null),
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
                    <h3><i class="fa-solid fa-hard-drive"></i> Disk Usage</h3><p class="admin-intro">This shows occupied and available disk space in bytes. Review it when the disk is filling up; a higher used percentage leaves less room for new files.</p>
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
                    <h3><i class="fa-solid fa-database"></i> Data Summary</h3><p class="admin-intro">This counts stored files and their combined size in bytes. Check it when comparing growth; higher totals mean more stored data.</p>
                    <div class="stats-grid" style="margin:0">
                        <div class="stat-card" style="padding:10px"><div class="value" style="font-size:18px">${fmtBytes(data.dataTotal?.bytes || 0)}</div><div class="label">Total Data</div></div>
                        <div class="stat-card" style="padding:10px"><div class="value" style="font-size:18px">${(data.dataTotal?.files || 0).toLocaleString()}</div><div class="label">Files</div></div>
                        <div class="stat-card" style="padding:10px"><div class="value" style="font-size:18px">${fmtBytes(data.database?.bytes || 0)}</div><div class="label">Database</div></div>
                        <div class="stat-card" style="padding:10px"><div class="value" style="font-size:18px">${dataPct}%</div><div class="label">% of Disk</div></div>
                    </div>
                </div>
            </div>

            <h3 style="margin-bottom:12px"><i class="fa-solid fa-folder-tree"></i> Storage Breakdown</h3><p class="admin-intro">This groups storage use by file category. Review the largest categories before deciding what to archive or remove.</p>
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
                <h3 style="margin:0"><i class="fa-solid fa-video"></i> VOD Management</h3>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <label for="vod-sort">Recording order</label><select id="vod-sort" aria-label="Recording order" aria-describedby="help-vod-sort" onchange="loadVodTable()" style="padding:6px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px">
                        <option value="size">Largest file first</option>
                        <option value="date">Newest recording first</option>
                        <option value="duration">Longest recording first</option>
                    </select>
                    <button class="btn btn-sm btn-danger" id="vod-bulk-btn" disabled onclick="bulkDeleteVods()"><i class="fa-solid fa-trash-can"></i> Permanently delete selected</button>
                </div>
            </div>
            <p class="admin-intro" style="margin:0 0 4px">These are saved stream recordings, also called VODs. Select recordings only when you intend to permanently delete them; recovery requires a separate backup.</p>
            <p class="admin-filter-hint" id="help-vod-sort" style="margin:0 0 12px">Largest file first is the default; choose newest or longest to find recordings by age or duration.</p>
            <div id="vod-table"><div class="loading">Loading VODs...</div></div>
        `;
        loadVodTable(vodData);
        loadStreamerStorageExtras(tierData, vodData);
        adminTableCards(c);   // the tier table is a card table too
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

// ── Streamer storage tiers (Local/B2/R2) + cloud usage/cost (openvibe.network admin) ──
function buildStreamerTierHtml(tierData, vodData) {
    // OpenVibe.Media's tier totals are behind its app-key console, so the tab counts the recordings it can read
    // instead of showing nothing (2026-11-14). The note under the table says which numbers these are.
    const vods = (vodData && vodData.vods) || [];
    const derived = vods.length ? vods.reduce((acc, v) => {
        const p = (v.storage_provider && v.storage_provider !== 'local') ? v.storage_provider : 'local';
        const row = acc[p] || (acc[p] = { count: 0, bytes: 0 });
        row.count++;
        row.bytes += Number(v.diskSize || v.file_size || 0);
        return acc;
    }, {}) : null;
    if (!tierData && !derived) return '';
    const t = (tierData && tierData.tiers) || derived || {};
    const ct = (tierData && tierData.clipTiers) || {};
    const prov = (tierData && tierData.providers) || {};
    const ts = (tierData && tierData.settings) || {};
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
            ? '<span style="color:var(--success-text, var(--success,#22c55e))"><i class="fa-solid fa-circle-check"></i> healthy</span>' + (p.bucket ? ' <span style="color:var(--text-muted);font-size:11px">· ' + esc(p.bucket) + '</span>' : '')
            : '<span style="color:var(--danger-text, var(--danger,#ef4444))"><i class="fa-solid fa-circle-xmark"></i> error</span>';
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
        + '<h3 style="margin:0 0 6px"><i class="fa-solid fa-layer-group"></i> Storage Tiers <span style="color:var(--text-muted);font-size:13px;font-weight:400">— ' + offloadPct + '% of recordings stored in cloud</span></h3><p class="admin-intro">These tiers show where recordings are stored. Review them when local space is low; a higher cloud percentage means more recording data is stored away from this server.</p>'
        + bar
        + '<div style="overflow-x:auto"><table class="admin-table" style="font-size:13px">'
        + '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)">'
        + '<th style="padding:6px 10px">Tier</th><th style="padding:6px 10px;text-align:right">VODs</th><th style="padding:6px 10px;text-align:right">VOD Size</th><th style="padding:6px 10px;text-align:right">Share</th><th style="padding:6px 10px;text-align:right">Clips</th><th style="padding:6px 10px">Provider</th></tr></thead>'
        + '<tbody>' + rowHtml
        + '<tr style="border-top:2px solid var(--border);font-weight:700"><td style="padding:8px 10px">Total</td><td style="padding:8px 10px;text-align:right">' + totalVods.toLocaleString() + '</td><td style="padding:8px 10px;text-align:right">' + fmtBytes(totalBytes) + '</td><td style="padding:8px 10px;text-align:right">100%</td><td style="padding:8px 10px;text-align:right">' + totalClips.toLocaleString() + '</td><td style="padding:8px 10px">' + ((tierData && tierData.sweepRunning) ? '<span style="color:#f59e0b"><span class="ov-mark" data-state="busy" data-size="16" data-tone="ink" aria-hidden="true"></span> sweeping</span>' : '<span style="color:var(--text-muted)">idle</span>') + '</td></tr>'
        + '</tbody></table></div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--text-muted);margin-top:12px">'
        + '<span><i class="fa-solid ' + (ts.enabled ? 'fa-circle-check' : 'fa-circle-xmark') + '" style="color:' + (ts.enabled ? '#22c55e' : '#ef4444') + '"></i> Auto-offload: ' + (ts.enabled ? 'ON' : 'OFF') + '</span>'
        + '<span>| Age &ge; ' + (ts.minAgeDays != null ? ts.minAgeDays : '?') + 'd</span><span>| Views &le; ' + (ts.maxViewsForCold != null ? ts.maxViewsForCold : '?') + '</span><span>| Idle &ge; ' + (ts.minLastAccessDays != null ? ts.minLastAccessDays : '?') + 'd</span>'
        + '</div>'
        + (tierData ? '' : '<p class="admin-note" style="margin-top:12px">These numbers are counted from the ' + vods.length + ' largest recordings listed below. OpenVibe.Media keeps its own tier totals, so the full counts are not readable from here.</p>')
        + '</div>';
}

function loadStreamerStorageExtras(tierData, vodData) {
    const c = document.getElementById('storage-content');
    if (!c) return;
    c.insertAdjacentHTML('afterbegin', '<div id="streamer-cloud-storage" style="margin-bottom:24px"></div>');
    c.insertAdjacentHTML('afterbegin', buildStreamerTierHtml(tierData, vodData));
    loadStreamerCloudStorage();
}

async function loadStreamerCloudStorage(force) {
    const el = document.getElementById('streamer-cloud-storage');
    if (!el) return;
    const header = '<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">'
        + '<h3 style="margin:0"><i class="fa-solid fa-cloud"></i> Cloud storage usage and cost</h3>'
        + '<button class="btn btn-sm btn-outline" onclick="loadStreamerCloudStorage(true)"><i class="fa-solid fa-rotate"></i> Rescan now</button></div>'
        + '<p class="admin-intro" style="margin:0 0 12px">This estimates storage in Backblaze B2 and Cloudflare R2, in bytes and US dollars per month. Rescan when checking capacity; higher usage means more stored data and may increase charges.</p>';
    el.innerHTML = header + '<div class="loading"><span class="ov-mark" data-state="busy" data-size="16" data-tone="ink" aria-hidden="true"></span> Scanning cloud buckets…</div>';
    try {
        // Network asks OpenVibe.Media for the scan itself (server/admin/storage.js), the way the owner settings
        // proxy asks a service: Network's own service token and the owner's usr_ in X-OV-Subject. When Media does
        // not answer, the route says why in words — the old line leaked "service tokens are not accepted on this
        // route" straight from Media (2026-11-14, the owner's phone).
        const data = await api('/api/admin/storage/cloud' + (force ? '?force=1' : ''));
        if (!data.ok) {
            el.innerHTML = header + `<div class="admin-note">${esc(data.detail || 'The cloud scan did not run.')}</div>`;
            return;
        }
        const usage = data.usage || {};
        const costs = data.costs || {};
        const money = (n) => '$' + (Number(n) || 0).toFixed(2);
        const card = (key, label, color) => {
            const u = usage[key];
            const cc = costs[key];
            if (!u || u.configured === false) return '<div class="card" style="flex:1;min-width:260px"><strong style="color:' + color + '"><i class="fa-solid fa-cloud"></i> ' + label + '</strong><div style="color:var(--text-muted);margin-top:8px">Cloud storage is not connected. Configure this provider in Live, then rescan.</div></div>';
            if (u.error) return '<div class="card" style="flex:1;min-width:260px"><strong style="color:' + color + '"><i class="fa-solid fa-cloud"></i> ' + label + '</strong><div style="color:var(--danger-text, var(--danger,#ef4444));margin-top:8px">Scan error: ' + esc(u.error) + '</div></div>';
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
            + '<div class="card" style="display:flex;align-items:center;justify-content:space-between"><span><i class="fa-solid fa-money-bill" style="color:var(--accent)"></i> <strong>Estimated cloud storage cost</strong> <span style="color:var(--text-muted);font-size:12px">(list prices; excludes egress/operations)</span></span><span style="font-size:22px;font-weight:800;color:var(--accent)">' + money(costs.totalStorageMonthly) + '<span style="font-size:13px;font-weight:400;color:var(--text-muted)">/mo</span></span></div>';
    } catch (e) {
        el.innerHTML = header + '<div class="admin-note is-bad">The cloud scan could not run: ' + esc(e.message || 'error') + '. The disk numbers above are current; the cloud usage is on the provider billing page.</div>';
    }
}

// The name behind a recording's owner id (2026-11-14): the column showed "-" because Media's recording row
// carries the owner's id, not a name. Live's own user list knows the name behind that id.
let _liveUserNames = null;
async function liveUserNames() {
    if (_liveUserNames) return _liveUserNames;
    const map = new Map();
    try {
        const data = await api('/api/admin/streamer/users?limit=200');
        for (const u of (data.users || [])) map.set(String(u.id), u.username || u.display_name || String(u.id));
    } catch { /* the id is shown instead when the names cannot be read */ }
    _liveUserNames = map;
    return map;
}

async function loadVodTable(preset) {
    const c = document.getElementById('vod-table');
    if (!c) return;
    const sort = document.getElementById('vod-sort')?.value || 'size';
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const [data, names] = await Promise.all([
            preset ? Promise.resolve(preset) : api(`/api/admin/streamer/storage/vods?sort=${sort}&order=desc&limit=100`),
            liveUserNames(),
        ]);
        const vods = data.vods || [];
        if (!vods.length) { c.innerHTML = '<p class="muted">No saved recordings. Return after a stream has been recorded.</p>'; return; }

        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th style="width:32px"><input type="checkbox" aria-label="Select all recordings for permanent deletion" onchange="toggleAllVods(this.checked)" style="cursor:pointer"></th>
                    <th>Title</th><th>User</th><th style="text-align:right">Size</th><th style="text-align:right">Duration</th><th>Date</th>
                </tr></thead>
                <tbody>${vods.map(v => `
                    <tr>
                        <td><input type="checkbox" aria-label="Select this recording for permanent deletion" class="vod-cb" value="${v.id}" onchange="updateVodSelection()" style="cursor:pointer"></td>
                        <td class="vod-title" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v.title||'')}">${esc(v.title || '(untitled)')}</td>
                        <td>${esc(v.username || names.get(String(v.user_id)) || (v.user_id ? 'User #' + v.user_id : 'Unknown'))}</td>
                        <td style="text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${fmtBytes(v.diskSize || v.file_size || 0)}</td>
                        <td style="text-align:right;color:var(--text-secondary)">${fmtDuration(v.duration_seconds)}</td>
                        <td>${v.created_at ? timeAgo(v.created_at) : '-'}</td>
                    </tr>
                `).join('')}</tbody>
            </table>
            ${data.total > 100 ? `<p class="muted" style="margin-top:8px;font-size:11px">Showing top 100 of ${data.total.toLocaleString()} VODs</p>` : ''}`;
        adminTableCards(c);
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

function toggleAllVods(checked) { document.querySelectorAll('.vod-cb').forEach(cb => cb.checked = checked); updateVodSelection(); }
function updateVodSelection() {
    const n = document.querySelectorAll('.vod-cb:checked').length;
    const btn = document.getElementById('vod-bulk-btn');
    if (btn) { btn.disabled = n === 0; btn.innerHTML = `<i class="fa-solid fa-trash-can"></i> Permanently delete selected${n ? ` (${n})` : ''}`; }
}

async function bulkDeleteVods() {
    const ids = [...document.querySelectorAll('.vod-cb:checked')].map(cb => parseInt(cb.value));
    if (!ids.length) return;
    if (!confirm(`Permanently delete ${ids.length} saved recording(s)? Viewers will lose access. This cannot be undone here; recovery requires a separate backup.`)) return;
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
    if (!confirm(`Send broadcast "${title}" to all users? It cannot be recalled here. If the announcement is wrong, send a correction.`)) return;
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

/**
 * The email kinds in words (2026-11-14, the owner's phone). The tab used to print the raw ids
 * (notification:OPERATOR_ALERT, email_verification, password_reset), which no one could read on a phone.
 * The ids stay in the database; only the panel speaks plainly.
 */
const EMAIL_KIND_WORDS = {
    email_verification: 'Email check',
    password_reset: 'Password reset',
    password_changed: 'Password changed',
    account_security: 'Account security',
    notification_digest: 'Notification digest',
    test: 'Test email',
};

/** Words from a machine word: OPERATOR_ALERT -> Operator alert. */
function adminHumanWords(text) {
    const t = String(text || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/** The kind of an email, in words: "Operator alert", "Notification: Operator alert", "Password reset". */
function emailKindWords(type) {
    const raw = String(type || '').trim();
    if (!raw) return 'Unknown kind';
    if (EMAIL_KIND_WORDS[raw]) return EMAIL_KIND_WORDS[raw];
    if (raw.startsWith('notification:')) return 'Notification: ' + adminHumanWords(raw.slice('notification:'.length));
    if (raw.startsWith('notification_digest:')) return 'Notification digest: ' + adminHumanWords(raw.split(':').slice(1).join(':'));
    if (raw.startsWith('webhook:')) return 'Provider report: ' + adminHumanWords(raw.slice('webhook:'.length).replace(/^email\./, ''));
    return adminHumanWords(raw);
}

/** The delivery state as a short chip; the long sentence is the tooltip (2026-11-14). */
const EMAIL_STATUS_CHIPS = {
    sent: { word: 'Sent', tone: 'ok', long: 'The provider accepted the email.' },
    delivered: { word: 'Delivered', tone: 'ok', long: 'The provider delivered the email to the mailbox.' },
    bounced: { word: 'Bounced', tone: 'bad', long: 'The mailbox rejected the email; the address may be wrong or full.' },
    complained: { word: 'Rejected', tone: 'bad', long: 'The recipient marked the email as spam; further mail is suppressed.' },
    failed: { word: 'Failed', tone: 'bad', long: 'The email could not be sent.' },
    queued: { word: 'Queued', tone: 'muted', long: 'The email is waiting to be sent.' },
    pending: { word: 'Queued', tone: 'muted', long: 'The email is waiting to be sent.' },
};

function emailStatusChip(status) {
    const key = String(status || '').toLowerCase();
    const s = EMAIL_STATUS_CHIPS[key] || { word: adminHumanWords(status) || 'Unknown', tone: 'muted', long: 'The provider reported: ' + (status || 'nothing') };
    return `<span class="admin-chip is-${s.tone}" title="${esc(s.long)}">${esc(s.word)}</span>`;
}
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
                <div class="stat-card"><div class="value">${Number(summary.sent || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-paper-plane"></i> Emails sent</div></div>
                <div class="stat-card"><div class="value">${Number(summary.failed || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-triangle-exclamation"></i> Failed</div></div>
                <div class="stat-card"><div class="value">${Number(summary.sent_24h || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-clock"></i> Sent · last 24 hours</div></div>
                <div class="stat-card"><div class="value">${Number(summary.password_resets_24h || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-key"></i> Password resets · last 24 hours</div></div>
                <div class="stat-card"><div class="value">${Number(summary.notifications_24h || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-bell"></i> Notification emails · last 24 hours</div></div>
                <div class="stat-card"><div class="value">${Number(summary.tests_24h || 0).toLocaleString()}</div><div class="label"><i class="fa-solid fa-flask-vial"></i> Test emails · last 24 hours</div></div>
            </div>

            <div class="card" style="padding:16px;margin-bottom:16px">
                <h3 style="margin-bottom:10px"><i class="fa-solid fa-chart-line"></i> Email Delivery Metrics</h3><p class="admin-intro">These are recorded delivery counts and recent failures. Check them after a test email or a reported delivery problem; more failed messages means more deliveries need investigation.</p>
                <div class="muted" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
                    <div><strong>Total recorded:</strong> ${Number(summary.total || 0).toLocaleString()}</div>
                    <div><strong>Failed in the last 24 hours:</strong> ${Number(summary.failed_24h || 0).toLocaleString()}</div>
                    <div><strong>Last email sent:</strong> ${summary.last_sent_at ? esc(timeAgo(summary.last_sent_at)) : 'Never'}</div>
                    <div><strong>Last failure:</strong> ${summary.last_failed_at ? esc(timeAgo(summary.last_failed_at)) : 'Never'}</div>
                </div>
            </div>

            ${data.can_edit === false ? '<p class="muted email-view-only"><i class="fa-solid fa-lock"></i> Only the owner changes how email is sent. You see the delivery numbers.</p>' : `<form id="email-form" style="max-width:600px;margin-bottom:16px">
                <div class="setting-row">
                    <label for="email-enabled"><strong>Send email</strong></label>
                    <input type="checkbox" id="email-enabled" aria-label="Send outgoing email" aria-describedby="help-email-enabled" ${email.enabled ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer"><span class="admin-help" id="help-email-enabled">Off by default, so no email is sent. Turn it on after configuring Resend; turning it off stops delivery, and turning it on resumes it.</span>
                </div>
                ${email.issue ? `<div style="background:#e74c3c22;border:1px solid #e74c3c44;border-radius:8px;padding:10px 14px;margin:8px 0 12px;font-size:13px;color:#e74c3c"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(email.issue)}</div>` : email.ready ? `<div style="background:#27ae6022;border:1px solid #27ae6044;border-radius:8px;padding:10px 14px;margin:8px 0 12px;font-size:13px;color:#27ae60"><i class="fa-solid fa-circle-check"></i> Resend is ready — emails will be delivered</div>` : ''}

                <h4 style="margin:12px 0 10px;font-size:14px"><i class="fa-solid fa-key"></i> Resend email key</h4><p class="admin-intro">This is the key that lets Network send email through the Resend service. Set it in the server environment before turning email on; changing it here has no effect.</p>
                <div class="form-field"><label for="email-api-key">Resend email key</label><input type="password" id="email-api-key" aria-label="Resend email key" aria-describedby="help-email-api-key" value="" placeholder="${email.api_key_source === 'env' ? `Set in the environment (${esc(email.api_key_env || 'RESEND_API_KEY')})` : 'Not set'}" disabled autocomplete="off"><span class="admin-help" id="help-email-api-key">No key is configured by default. This field is read-only; use the Resend API keys page below and set the key in the server environment.</span></div>
                <p class="muted" style="margin:-4px 0 8px;font-size:11px">${email.api_key_source === 'env' ? `The key comes from <code>${esc(email.api_key_env || 'RESEND_API_KEY')}</code> in the server's environment file; change it there.` : `Provider secrets live in the server's environment only: get a key from <a href="https://resend.com/api-keys" target="_blank" rel="noopener" style="color:var(--accent)">resend.com/api-keys</a>, set <code>${esc(email.api_key_env || 'RESEND_API_KEY')}</code> in <code>/etc/openvibe/network.env</code>, and restart Network.`}</p>

                <h4 style="margin:20px 0 10px;font-size:14px"><i class="fa-solid fa-envelope"></i> From addresses</h4><p class="admin-intro">These are the addresses recipients see when an email arrives. Change them when you want a different sender name or a per-service address; the overrides below only affect the service they name.</p>
                <div class="form-field"><label for="email-from-email">Default sender address</label><input type="email" id="email-from-email" aria-label="Default sender address" aria-describedby="help-email-from-email" value="${esc(email.from_email || '')}" placeholder="noreply@openvibe.network"><span class="admin-help" id="help-email-from-email">Uses the saved sender address, normally noreply@openvibe.network. Enter an address on your verified domain, for example alerts@example.com.</span></div>
                <div class="form-field"><label for="email-from-name">Sender name</label><input type="text" id="email-from-name" aria-label="Sender display name" aria-describedby="help-email-from-name" value="${esc(email.from_name || '')}" placeholder="OpenVibe"><span class="admin-help" id="help-email-from-name">The default is OpenVibe. Use a recognizable name, for example OpenVibe Support.</span></div>
                <div class="form-field"><label for="email-from-openvibelive">Live sender address <span class="muted">(optional override)</span></label><input type="email" id="email-from-openvibelive" aria-label="Live sender address" aria-describedby="help-email-from-openvibelive" value="${esc(email.from_email_openvibelive || '')}" placeholder="noreply@openvibe.live"><span class="admin-help" id="help-email-from-openvibelive">Blank uses the default sender. Enter a verified address such as noreply@openvibe.live to override it for Live.</span></div>
                <div class="form-field"><label for="email-from-openvibegames">Games sender address <span class="muted">(optional override)</span></label><input type="email" id="email-from-openvibegames" aria-label="Games sender address" aria-describedby="help-email-from-openvibegames" value="${esc(email.from_email_openvibegames || '')}" placeholder="noreply@openvibe.games"><span class="admin-help" id="help-email-from-openvibegames">Blank uses the default sender. Enter a verified address such as noreply@openvibe.games to override it for Games.</span></div>
                <div class="form-field"><label for="email-from-openvibenetwork">Tools sender address <span class="muted">(optional override)</span></label><input type="email" id="email-from-openvibenetwork" aria-label="Tools sender address" aria-describedby="help-email-from-openvibenetwork" value="${esc(email.from_email_openvibenetwork || '')}" placeholder="noreply@openvibe.network"><span class="admin-help" id="help-email-from-openvibenetwork">Blank uses the default sender. Enter a verified address such as noreply@openvibe.network to override it for Tools.</span></div>

                <div style="display:flex;gap:8px;margin-top:16px">
                    <button type="button" class="btn btn-primary" onclick="saveEmail()"><i class="fa-solid fa-floppy-disk"></i> Save email settings</button>
                    <button type="button" class="btn btn-outline" onclick="testEmail()"><i class="fa-solid fa-paper-plane"></i> Send a test email</button>
                </div>
                <div style="background:#2a2a3822;border:1px solid #333340;border-radius:8px;padding:12px 14px;margin-top:16px;font-size:12px;color:var(--text-muted)">
                    <strong style="color:var(--text)"><i class="fa-solid fa-globe"></i> DNS Setup</strong><br>
                    Add your domain at <a href="https://resend.com/domains" target="_blank" rel="noopener" style="color:var(--accent)">resend.com/domains</a> and add the SPF (TXT + MX) and DKIM records to your DNS provider. Once verified, emails will be sent from your domain.
                </div>
            </form>`}

            <div class="card" style="padding:16px;margin-bottom:16px">
                <h3 style="margin-bottom:10px"><i class="fa-solid fa-layer-group"></i> Delivery breakdown · last 30 days</h3><p class="admin-intro">This counts sent and failed messages by type over the last 30 days. Review it when one kind of email is failing more often than others.</p>
                ${byType.length ? `
                    <table class="admin-table">
                        <thead><tr><th>Kind of email</th><th>Status</th><th>Count</th></tr></thead>
                        <tbody>
                            ${byType.map(row => `
                                <tr>
                                    <td>${esc(emailKindWords(row.email_type))}</td>
                                    <td>${emailStatusChip(row.status)}</td>
                                    <td>${Number(row.count || 0).toLocaleString()}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>`
                : '<p class="muted">No email deliveries recorded. Save the configuration and send a test email to check delivery.</p>'}
            </div>

            ${data.can_edit === false ? '' : `<div class="card" style="padding:16px">
                <h3 style="margin-bottom:10px"><i class="fa-solid fa-clock-rotate-left"></i> Recent Email Activity</h3><p class="admin-intro">These are the most recent email delivery attempts and provider errors. Check a failed row after a delivery report, then correct the configuration and send a new test.</p>
                ${recent.length ? `
                    <table class="admin-table" data-title-col="1">
                        <thead><tr><th>When</th><th>Kind of email</th><th>Recipient</th><th>Status</th><th>Subject</th><th>Error</th></tr></thead>
                        <tbody>
                            ${recent.map(row => `
                                <tr>
                                    <td style="white-space:nowrap">${esc(timeAgo(row.created_at))}</td>
                                    <td>${esc(emailKindWords(row.email_type))}</td>
                                    <td>${esc(row.recipient)}</td>
                                    <td>${emailStatusChip(row.status)}</td>
                                    <td>${esc(row.subject || '-')}</td>
                                    <td style="font-size:11px;color:var(--text-muted)">${esc(row.error_message || '-')}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>`
                : '<p class="muted">No email deliveries recorded. Save the configuration and send a test email to check delivery.</p>'}
            </div>`}`;
        adminTableCards(c);
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
