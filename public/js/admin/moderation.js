/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): streams, lineage, bans, chat logs, moderators, mod log, audit, deliveries, checklist, theme review and grants.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════
// Streams (via openvibelive proxy)
// ═══════════════════════════════════════════════════════════════
async function loadStreams() {
    const c = document.getElementById('streams-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/streamer/streams');
        const streams = data.streams || [];
        if (!streams.length) { c.innerHTML = '<p class="muted">No streams are live. Return when someone starts broadcasting.</p>'; return; }
        // Each ban is a card (the owner, 11-13: on a phone the table scrolled who and why out of sight): who, as a name
        // that opens their card; the reason; who banned them and when; how long; and, for the owner, lifting it.
        const when = (t) => (t ? `${timeAgo(t)}` : '');
        const nameTag = (u, id) => u
            ? `<a class="ban-who" href="https://openvibe.network/@${encodeURIComponent(u)}" data-ov-user="${esc(u)}">@${esc(u)}</a>`
            : `<span class="ban-who muted">user ${esc(String(id))}</span>`;
        c.innerHTML = `<p class="muted ban-count">${bans.length === 1 ? '1 person is' : `${bans.length} people are`} banned across the site.</p>
            <ul class="ban-list">${bans.map((b) => `
                <li class="ban-card">
                    <div class="ban-top">${nameTag(b.username, b.user_id)}<span class="ban-len ${b.expires_at ? '' : 'is-perm'}">${b.expires_at ? `until ${esc(new Date(b.expires_at).toLocaleDateString())}` : 'Permanent'}</span></div>
                    <p class="ban-reason">${b.reason ? esc(b.reason) : '<span class="muted">No reason was written.</span>'}</p>
                    <div class="ban-meta muted">Banned ${b.banned_by_username ? `by ${nameTag(b.banned_by_username)}` : ''} ${esc(when(b.created_at))}</div>
                    <div class="ban-act">${owner
                        ? `<button class="btn btn-sm btn-outline" onclick="unbanStreamer('${esc(String(b.user_id))}')"><i class="fa-solid fa-user-check"></i> Allow access again</button>`
                        : '<span class="muted ban-owner" title="Only the owner can lift a site-wide ban">Only the owner can lift it</span>'}</div>
                </li>`).join('')}</ul>`;
        if (window.OVUser && typeof window.OVUser.bind === 'function') { try { window.OVUser.bind(c); } catch (e) { /* the card is optional */ } }
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

// Unresolved lineage references (Live GET /api/admin/lineage/unresolved through the /api/admin/streamer proxy).
async function loadLineage(reason = '') {
    const c = document.getElementById('lineage-content');
    const tabs = document.getElementById('lineage-reasons');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api(`/api/admin/streamer/lineage/unresolved${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`);
        const by = data.by_reason || {};
        tabs.innerHTML = [['', 'All']].concat(Object.keys(by).sort().map(r => [r, `${r.replace(/_/g, ' ')} (${by[r].refs})`]))
            .map(([r, label]) => `<button class="${r === reason ? 'active' : ''}" onclick="loadLineage('${esc(r)}')">${esc(label)}</button>`).join('');
        const rows = data.unresolved || [];
        if (!rows.length) { c.innerHTML = '<p class="muted">No unmatched references in the last 30 days. Return here if a channel link stops resolving.</p>'; return; }
        c.innerHTML = `
            <div style="overflow-x:auto"><table class="admin-table">
                <thead><tr><th>Reference</th><th>Reason</th><th>Detail</th><th>Last caller</th><th>Times</th><th>First seen</th><th>Last seen</th></tr></thead>
                <tbody>${rows.map(u => `
                    <tr>
                        <td><code>${esc(u.ref)}</code></td>
                        <td><span class="badge badge-warning">${esc(adminWords(u.reason))}</span></td>
                        <td>${esc(u.detail || '')}</td>
                        <td>${esc(u.last_caller || '-')}</td>
                        <td>${Number(u.count) || 0}</td>
                        <td>${u.first_at ? timeAgo(u.first_at) : '-'}</td>
                        <td>${u.last_at ? timeAgo(u.last_at) : '-'}</td>
                    </tr>`).join('')}</tbody>
            </table></div>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function endStream(id) {
    if (!confirm('End this broadcast now? Viewers will be disconnected. The streamer must start a new broadcast to resume.')) return;
    try {
        await api(`/api/admin/streamer/streams/${id}`, { method: 'DELETE' });
        toast('Stream ended', 'success');
        loadStreams();
    } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Bans (via openvibelive proxy)
// ═══════════════════════════════════════════════════════════════
async function loadBans() {
    const c = document.getElementById('bans-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/streamer/bans');
        const bans = data.bans || [];
        // Only the owner lifts a site-wide ban (2026-11-13); admins see the list, who and why.
        const owner = !!(typeof currentUser !== 'undefined' && currentUser && currentUser.is_owner);
        if (!bans.length) { c.innerHTML = '<p class="muted">No active bans. Review Users if an account needs a restriction.</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>User</th><th>Reason</th><th>Banned By</th><th>Banned At</th><th>Expires</th><th>Actions</th>
                </tr></thead>
                <tbody>${bans.map(b => `
                    <tr>
                        <td><strong>${esc(b.username || b.user_id)}</strong></td>
                        <td>${esc(b.reason || '-')}</td>
                        <td>${esc(b.banned_by_username || '-')}</td>
                        <td>${b.created_at ? timeAgo(b.created_at) : '-'}</td>
                        <td>${b.expires_at ? new Date(b.expires_at).toLocaleString() : 'Permanent'}</td>
                        <td>${owner
                            ? `<button class="btn btn-sm btn-outline" onclick="unbanStreamer('${esc(String(b.user_id))}')"><i class="fa-solid fa-user-check"></i> Allow access again</button>`
                            : '<span class="muted" title="Only the owner can lift a site-wide ban">Owner only</span>'}</td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
        adminTableCards(c);
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function unbanStreamer(userId) {
    try {
        await api(`/api/admin/streamer/users/${userId}/ban`, { method: 'DELETE' });
        toast('User unbanned on OpenVibe.Live', 'success');
        loadBans();
    } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Chat Logs (via openvibelive mod proxy)
// ═══════════════════════════════════════════════════════════════
let chatLogsOffset = 0;
async function searchChatLogs() {
    chatLogsOffset = 0;
    await fetchChatLogs();
}

async function fetchChatLogs() {
    const c = document.getElementById('chat-logs-content');
    const pager = document.getElementById('chat-logs-pager');
    const q = document.getElementById('chat-search-q')?.value.trim() || '';
    const uid = document.getElementById('chat-search-uid')?.value.trim() || '';
    if (!q && !uid) { c.innerHTML = '<p class="muted">Enter a search query or user ID</p>'; return; }
    c.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const params = new URLSearchParams({ limit: '50', offset: String(chatLogsOffset) });
        if (q) params.set('q', q);
        if (uid) params.set('user_id', uid);
        const data = await api(`/api/admin/streamer-mod/chat/search?${params}`);
        const msgs = data.messages || [];
        const total = data.total || 0;

        if (!msgs.length) { c.innerHTML = '<p class="muted">No messages match. Try different words or another person.</p>'; pager.innerHTML = ''; return; }

        c.innerHTML = `
            <table class="admin-table">
                <thead><tr><th>Time</th><th>User</th><th>Message</th><th>Stream</th></tr></thead>
                <tbody>${msgs.map(m => `
                    <tr>
                        <td style="white-space:nowrap;font-size:11px">${m.timestamp ? timeAgo(m.timestamp) : '-'}</td>
                        <td style="white-space:nowrap;color:${esc(m.profile_color || (m.anon_id ? '#6b7280' : '#999'))}">${esc(m.display_name || m.username || m.anon_id || 'anon')}</td>
                        <td style="word-break:break-word">${esc(m.message)}</td>
                        <td style="font-size:11px">${m.stream_id || '-'}</td>
                    </tr>
                `).join('')}</tbody>
            </table>`;

        const pages = Math.ceil(total / 50);
        const curPage = Math.floor(chatLogsOffset / 50) + 1;
        pager.innerHTML = pages > 1 ? `
            <button class="btn btn-sm btn-outline" ${chatLogsOffset<=0?'disabled':''} onclick="chatLogsOffset=Math.max(0,chatLogsOffset-50);fetchChatLogs()"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="muted">Page ${curPage}/${pages} (${total} results)</span>
            <button class="btn btn-sm btn-outline" ${curPage>=pages?'disabled':''} onclick="chatLogsOffset+=50;fetchChatLogs()"><i class="fa-solid fa-chevron-right"></i></button>
        ` : `<span class="muted">${total} results</span>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; pager.innerHTML = ''; }
}

// ═══════════════════════════════════════════════════════════════
// Moderators (via openvibelive proxy)
// ═══════════════════════════════════════════════════════════════
async function loadModerators() {
    const c = document.getElementById('mods-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/streamer/moderators');
        const mods = data.moderators || [];
        if (!mods.length) { c.innerHTML = '<p class="muted">No global moderators yet. Enter a trusted username above to add one.</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr><th>Username</th><th>Display Name</th><th>Last Seen</th><th>Actions</th></tr></thead>
                <tbody>${mods.map(m => `
                    <tr>
                        <td><strong>${esc(m.username)}</strong></td>
                        <td>${esc(m.display_name || m.username)}</td>
                        <td>${m.last_seen ? timeAgo(m.last_seen) : 'Never'}</td>
                        <td>
                            <button class="btn btn-sm btn-danger" onclick="demoteMod('${m.id}','${esc(m.username)}')"><i class="fa-solid fa-user-minus"></i> Remove moderator access</button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function promoteMod() {
    const username = document.getElementById('mod-username')?.value.trim();
    if (!username) return toast('Enter a username', 'error');
    try {
        await api('/api/admin/streamer/moderators', { method: 'POST', body: { username } });
        toast(`${username} promoted to global moderator`, 'success');
        document.getElementById('mod-username').value = '';
        loadModerators();
    } catch (e) { toast(e.message, 'error'); }
}

async function demoteMod(id, username) {
    if (!confirm(`Remove global moderation access from ${username}? They will lose these permissions. Promote them again to restore access.`)) return;
    try {
        await api(`/api/admin/streamer/moderators/${id}`, { method: 'DELETE' });
        toast(`${username} demoted`, 'success');
        loadModerators();
    } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Audit Log
// ═══════════════════════════════════════════════════════════════
let auditOffset = 0;
let _modlogNext = null;
// The filters as a query: dates are whole days (until includes its day).
function modLogQuery() {
    const q = new URLSearchParams();
    const val = (id) => (document.getElementById(id)?.value || '').trim();
    for (const [k, id] of [['service', 'modlog-service'], ['action', 'modlog-action'], ['actor', 'modlog-actor'], ['target', 'modlog-target']]) if (val(id)) q.set(k, val(id));
    if (val('modlog-since')) q.set('since', `${val('modlog-since')}T00:00:00Z`);
    if (val('modlog-until')) { const d = new Date(`${val('modlog-until')}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); q.set('until', d.toISOString()); }
    return q;
}
async function exportModLog() {
    const q = modLogQuery();
    q.set('format', 'csv');
    try {
        const headers = token ? { Authorization: 'Bearer ' + token } : {};
        const res = await fetch(`${API}/api/v1/staff/moderation-audit?${q}`, { headers, credentials: 'include' });
        if (!res.ok) throw new Error(`export failed (${res.status})`);
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url; a.download = `moderation-audit-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) { alert(err.message || 'Export failed'); }
}
let _deliveries = [];
async function loadDeliveries() {
    const c = document.getElementById('dlq-content');
    const q = new URLSearchParams({ status: document.getElementById('dlq-status').value, limit: '200' });
    const sub = document.getElementById('dlq-sub').value.trim();
    if (sub) q.set('subscription_id', sub);
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const d = await api(`/api/admin/events/deliveries?${q}`);
        _deliveries = d.deliveries || [];
        const counts = d.counts || {};
        document.getElementById('dlq-counts').textContent = Object.entries(counts).map(([k, v]) => `${{dead:'Stopped retrying',failed:'Retrying after a failure',pending:'Waiting to be delivered',delivered:'Delivered successfully'}[k] || adminWords(k)}: ${v} deliveries`).join(' · ');
        const bySub = {};
        for (const x of _deliveries) (bySub[x.subscription_id] = bySub[x.subscription_id] || []).push(x.event_id);
        const replayAll = Object.entries(bySub).map(([s, ids]) => `<button class="btn btn-sm" data-sub="${esc(s)}" onclick="replayDeliveries(this.dataset.sub, null)">Replay ${ids.length} deliveries for ${esc(s.slice(0, 14))}…</button>`).join(' ');
        c.innerHTML = _deliveries.length ? `<div style="margin-bottom:8px">${replayAll}</div><table class="admin-table"><thead><tr><th>Event</th><th>Subscription</th><th>Seq</th><th>Attempts</th><th>Last answer</th><th></th></tr></thead><tbody>${_deliveries.map(x => `
            <tr><td style="font-size:11px"><code>${esc(x.event_id)}</code></td><td style="font-size:11px"><code>${esc(x.subscription_id)}</code></td><td>${esc(String(x.seq))}</td><td>${esc(String(x.attempt))}</td>
            <td style="font-size:11px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.last_error || '')}">${x.last_status ? `The receiver answered HTTP ${esc(String(x.last_status))}.` : 'No response recorded.'} ${esc(x.last_error || '')}</td>
            <td><button class="btn btn-sm" data-sub="${esc(x.subscription_id)}" data-evt="${esc(x.event_id)}" onclick="replayDeliveries(this.dataset.sub, [this.dataset.evt])">Replay delivery</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No deliveries match. Choose another delivery state or clear the subscription filter.</p>';
    } catch (err) {
        c.innerHTML = `<p class="muted">Deliveries could not be loaded: ${esc(err.message || 'error')}</p>`;
    }
}
async function replayDeliveries(sub, ids) {
    const eventIds = ids || _deliveries.filter(x => x.subscription_id === sub).map(x => x.event_id);
    if (!eventIds.length || !confirm(`Replay ${eventIds.length} deliver${eventIds.length === 1 ? 'y' : 'ies'} to ${sub}? This sends the events again and cannot be recalled. Fix the destination before retrying.`)) return;
    try { const r = await api('/api/admin/events/replay', { method: 'POST', body: { subscription_id: sub, event_ids: eventIds } }); alert(`Queued ${r.queued}`); loadDeliveries(); }
    catch (err) { alert(err.message || 'Replay failed'); }
}
// The status words the status page uses (server/status/routes.js): up, degraded, down, not-running, unknown.
// The panel used to ask for "ready", a word the status service never returns, so every row said the status was
// unavailable (2026-11-14, the owner's phone).
const CHECKLIST_STATUS = {
    up: 'Ready to use.',
    degraded: 'Working with a problem; check the linked service.',
    down: 'Unavailable; check the linked service.',
    'not-running': 'Not running on this host.',
    unknown: 'Not checked.',
};

async function loadOperatorChecklist() {
    const c = document.getElementById('checklist-content');
    let areas = [];
    try { areas = (await api('/api/admin/operator-checklist')).areas || []; } catch (err) { c.textContent = 'Could not load: ' + err.message; return; }
    c.replaceChildren();
    const colour = { up: 'var(--success, #3ee6b0)', degraded: 'var(--warning, #f5a524)', down: 'var(--danger, #ef4444)', 'not-running': 'var(--text-muted, #888)', unknown: 'var(--text-muted, #888)' };
    for (const a of areas) {
        const h = document.createElement('h3'); h.textContent = a.area; h.className = 'checklist-area'; c.appendChild(h);
        for (const it of a.items) {
            const row = document.createElement('div');
            row.className = 'checklist-row';
            const dot = document.createElement('span'); dot.className = 'checklist-dot';
            dot.title = (it.service || '') + ': ' + (it.status || 'unknown');
            dot.style.background = colour[it.status] || 'var(--text-muted, #888)';
            const name = document.createElement('strong'); name.className = 'checklist-name';
            const word = CHECKLIST_STATUS[it.status] || CHECKLIST_STATUS.unknown;
            // A service the status service has not answered for says so, and why.
            let why = (it.status === 'unknown' || it.status === 'not-running') ? String(it.status_reason || '').trim() : '';
            if (/^not checked/i.test(why)) why = '';   // the word already says it
            name.textContent = it.item + ': ' + word + (why ? ' ' + why : '');
            const places = document.createElement('div'); places.className = 'checklist-places';
            for (const w of it.where) {
                let el;
                if (w.kind === 'tab') { el = document.createElement('button'); el.type = 'button'; el.className = 'btn'; el.textContent = 'Open ' + w.tab; el.onclick = () => showTab(w.tab, null); }
                else if (w.kind === 'url') { el = document.createElement('a'); el.href = w.url; el.target = '_blank'; el.rel = 'noopener'; el.textContent = w.url.replace(/^https:\/\//, ''); }
                else { el = document.createElement('code'); el.textContent = (w.kind === 'cli' ? '$ ' : 'API ') + (w.cli || w.api); }
                places.appendChild(el);
                if (w.note) { const n = document.createElement('span'); n.className = 'muted'; n.textContent = '(' + w.note + ')'; places.appendChild(n); }
            }
            if (!it.console) { const gap = document.createElement('span'); gap.className = 'checklist-gap'; gap.textContent = 'No settings page yet; use the listed command or API.'; places.appendChild(gap); }
            row.append(dot, name, places);
            c.appendChild(row);
        }
    }
}

async function loadThemeReview() {
    const c = document.getElementById('themes-review-content');
    let list = [];
    try { list = (await api('/api/admin/themes?status=pending')).themes || []; } catch (err) { c.textContent = 'Could not load: ' + err.message; return; }
    c.replaceChildren();
    if (!list.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No themes are waiting for review. Return after a theme author submits one.'; c.appendChild(p); return; }
    for (const t of list) {
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;display:grid;gap:8px';
        const head = document.createElement('div');
        const n = document.createElement('strong'); n.textContent = t.name + ' ';
        const meta = document.createElement('span'); meta.className = 'muted'; meta.textContent = `/${t.slug} · ${t.mode} · by ${t.author || 'unknown'}`;
        head.append(n, meta);
        const swatches = document.createElement('div'); swatches.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap';
        for (const [k, v] of Object.entries(t.variables || {}).filter(([, v]) => /^#|^rgb|^hsl/i.test(v)).slice(0, 14)) {
            const sw = document.createElement('span'); sw.title = `${adminWords(k)}: ${v}`; sw.style.cssText = 'width:22px;height:22px;border-radius:6px;border:1px solid var(--border)'; sw.style.background = v; swatches.appendChild(sw);
        }
        const note = document.createElement('input'); note.placeholder = 'Reason (needed to reject)'; note.setAttribute('aria-label', 'Review reason; required for rejection, for example unreadable text'); note.maxLength = 300; note.style.minWidth = '240px';
        const act = (decision) => async () => {
            try { await api(`/api/admin/themes/${encodeURIComponent(t.id)}/review`, { method: 'POST', body: JSON.stringify({ decision, note: note.value }) }); loadThemeReview(); }
            catch (err) { alert(err.message); }
        };
        const ok = document.createElement('button'); ok.className = 'btn'; ok.textContent = 'Approve'; ok.onclick = act('approve');
        const no = document.createElement('button'); no.className = 'btn'; no.textContent = 'Reject'; no.onclick = act('reject');
        const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center'; row.append(note, ok, no);
        const help = document.createElement('p'); help.className = 'admin-help'; help.textContent = 'Explain a rejection so the author can fix and resubmit the theme; for example, text is unreadable. Approval publishes the theme; there is no undo control in this queue.'; card.append(head, swatches, help, row);
        c.appendChild(card);
    }
}

let _grants = [];
async function loadGrants() {
    const c = document.getElementById('grants-content');
    try {
        const [g, ch] = await Promise.all([api('/api/admin/grants'), api('/api/admin/grants/changes?limit=50')]);
        _grants = g.grants || [];
        renderGrants();
        const rows = (ch.changes || []).map(x => `<tr><td style="white-space:nowrap;font-size:11px" title="${esc(x.at)}">${timeAgo(x.at)}</td><td><strong>${esc(x.change)}</strong></td><td><code>${esc(x.client_id)}</code></td><td><code>${esc(x.capability)}</code></td><td style="font-size:11px">${esc(x.reason || '-')}</td><td style="font-size:11px"><code>${esc(x.actor || 'system')}</code></td></tr>`).join('');
        document.getElementById('grant-changes').innerHTML = rows ? `<table class="admin-table"><thead><tr><th>When</th><th>Change</th><th>Service</th><th>Capability</th><th>Reason</th><th>By</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No changes yet: every grant is still a default.</p>';
    } catch (err) {
        c.innerHTML = `<p class="muted">Grants could not be loaded: ${esc(err.message || 'error')}</p>`;
    }
}
function renderGrants() {
    const f = (document.getElementById('grant-filter').value || '').trim().toLowerCase();
    const list = _grants.filter(g => !f || g.client_id.includes(f));
    const badge = { active: 'badge-success', revoked: 'badge-danger', expired: 'badge-warning' };
    document.getElementById('grants-content').innerHTML = list.length ? `<table class="admin-table"><thead><tr><th>Service</th><th>Capability</th><th>Audience</th><th>Namespaces</th><th>State</th><th>Expires</th><th>By</th><th></th></tr></thead><tbody>${list.map(g => `
        <tr><td><code>${esc(g.client_id)}</code></td><td><code>${esc(g.capability)}</code></td><td style="font-size:11px">${esc(g.audience)}</td>
        <td style="font-size:11px">${esc((g.namespaces || []).join(', ') || '-')}</td><td><span class="badge ${badge[g.state] || ''}">${esc({active:'Access is allowed.',revoked:'Access was removed.',expired:'Access has expired.'}[g.state] || 'Access state is unknown.')}</span></td>
        <td style="font-size:11px">${g.expires_at ? esc(g.expires_at.slice(0, 10)) : '-'}</td><td style="font-size:11px">${esc(g.granted_by === 'default' ? 'default' : (g.granted_by || '-'))}</td>
        <td>${g.state === 'active' ? `<button class="btn btn-sm" data-client="${esc(g.client_id)}" data-cap="${esc(g.capability)}" title="Remove access; grant again to restore it" onclick="revokeGrant(this.dataset.client, this.dataset.cap)">Revoke access</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No permissions match. Clear the service filter or add the required permission above.</p>';
}
async function submitGrant() {
    const v = (id) => document.getElementById(id).value.trim();
    const body = { client_id: v('grant-client'), capability: v('grant-cap'), reason: v('grant-reason'), namespaces: v('grant-ns') ? v('grant-ns').split(',').map(x => x.trim()).filter(Boolean) : [] };
    if (v('grant-exp')) body.expires_at = `${v('grant-exp')}T00:00:00Z`;
    try { await api('/api/admin/grants', { method: 'POST', body }); document.getElementById('grant-reason').value = ''; loadGrants(); }
    catch (err) { alert(err.message || 'Grant failed'); }
}
async function revokeGrant(client, capability) {
    const reason = prompt(`Revoke ${capability} from ${client}? This stops that service from using the permission. Grant it again to restore access. Reason:`);
    if (!reason) return;
    try { await api('/api/admin/grants/revoke', { method: 'POST', body: { client_id: client, capability, reason } }); loadGrants(); }
    catch (err) { alert(err.message || 'Revoke failed'); }
}
async function loadModLog(reset) {
    const c = document.getElementById('modlog-content');
    const more = document.getElementById('modlog-more');
    if (reset) { _modlogNext = null; c.innerHTML = '<div class="loading">Loading...</div>'; }
    try {
        const q = modLogQuery();
        q.set('limit', '50');
        if (!reset && _modlogNext) q.set('before', String(_modlogNext));
        const data = await api(`/api/v1/staff/moderation-audit?${q}`);
        const items = data.items || [];
        const rowsHtml = items.map(e => `
            <tr>
                <td style="white-space:nowrap;font-size:11px" title="${esc(e.occurred_at)}">${e.occurred_at ? timeAgo(e.occurred_at) : '-'}</td>
                <td><span class="badge badge-info">${esc(e.service)}</span></td>
                <td><strong>${esc(e.action)}</strong>${e.scope ? `<div class="muted" style="font-size:11px">${esc(e.scope)}</div>` : ''}</td>
                <td style="font-size:11px"><code>${esc(e.actor_subject || '-')}</code></td>
                <td style="font-size:11px">${esc(e.target_type || '')} <code>${esc(e.target_id || '-')}</code>${e.target_subject && e.target_subject !== e.target_id ? `<div class="muted">${esc(e.target_subject)}</div>` : ''}</td>
                <td style="font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.reason || '')}">${esc(e.reason || '-')}</td>
            </tr>`).join('');
        if (reset) {
            c.innerHTML = items.length ? `<table class="admin-table" data-title-col="2"><thead><tr><th>When</th><th>Service</th><th>Action</th><th>By</th><th>Target</th><th>Reason</th></tr></thead><tbody id="modlog-rows">${rowsHtml}</tbody></table>` : '<p class="muted">No staff actions match these filters. Clear the filters or return after staff activity.</p>';
            adminTableCards(c);
        } else {
            const rows = document.getElementById('modlog-rows');
            rows?.insertAdjacentHTML('beforeend', rowsHtml);
            if (rows) adminTableCards(rows);
        }
        _modlogNext = data.next || null;
        more.hidden = !_modlogNext;
    } catch (err) {
        c.innerHTML = `<p class="muted">The moderation log could not be loaded: ${esc(err.message || 'error')}</p>`;
    }
}

async function loadAudit() {
    const c = document.getElementById('audit-content');
    const pager = document.getElementById('audit-pager');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api(`/api/admin/audit?limit=50&offset=${auditOffset}`);
        const entries = data.entries || [];
        if (!entries.length) { c.innerHTML = '<p class="muted">No administrative changes recorded here. Return after a settings or account change.</p>'; pager.innerHTML = ''; return; }
        c.innerHTML = `
            <table class="admin-table" data-title-col="2">
                <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
                <tbody>${entries.map(e => `
                    <tr>
                        <td style="white-space:nowrap;font-size:11px">${e.created_at ? timeAgo(e.created_at) : '-'}</td>
                        <td><strong>${esc(e.username || e.user_id || '-')}</strong></td>
                        <td><span class="badge badge-info">${esc(e.action)}</span></td>
                        <td style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.details || '')}">${esc(e.details || '-')}</td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
        adminTableCards(c);

        const hasMore = entries.length >= 50;
        pager.innerHTML = `
            <button class="btn btn-sm btn-outline" ${auditOffset<=0?'disabled':''} onclick="auditOffset=Math.max(0,auditOffset-50);loadAudit()"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="muted">Showing records from ${auditOffset + 1}</span>
            <button class="btn btn-sm btn-outline" ${!hasMore?'disabled':''} onclick="auditOffset+=50;loadAudit()"><i class="fa-solid fa-chevron-right"></i></button>
        `;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; pager.innerHTML = ''; }
}
