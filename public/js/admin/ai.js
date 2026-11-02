/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): AI, AI viewers, streamer media tools and TTS (OpenVibe.Chat).
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ── AI: provider config + usage cost breakdown ──
// Live's own provider settings are gone (WS-O task 2): OpenVibe.AI holds the key, the models and their prices.
const AI_KEYS = ['ai_enabled',
    'ai_paste_analysis_enabled', 'ai_stream_memory_enabled', 'ai_stream_capture_interval_sec', 'ai_transcription_enabled', 'ai_timeline_enabled',
    'ai_max_cost_usd_per_day',
    'ai_viewers_enabled', 'ai_viewers_max_roster', 'ai_viewers_max_lines_per_min', 'ai_viewers_global_cap_usd_per_day', 'ai_viewers_default_settings_json'];

// ── The staff room (OpenVibe.Chat /r/staff): one room for all of staff, with Vibe and a shared work queue ──
const CHAT_ORIGIN = 'https://openvibe.chat';
const TASK_STATE = { queued: 'Waiting', running: 'Working', succeeded: 'Done', failed: 'Stuck', cancelled: 'Cancelled' };
let staffRoomTimer = null;
async function chatApi(path, opts = {}) {
    const res = await fetch(CHAT_ORIGIN + '/api/chat/rooms/staff' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('OpenVibe.Chat answered ' + res.status));
    return body;
}
async function loadStaffRoom() {
    const el = document.getElementById('ai-staff-room'); if (!el) return;
    let tasks = null, err = null;
    try { tasks = (await chatApi('/tasks?limit=12')).tasks || []; } catch (e) { err = e.message; }
    const row = (t) => `<li style="padding:6px 0;border-bottom:1px solid var(--border)"><a href="${CHAT_ORIGIN}${esc(t.url)}" target="_blank" rel="noopener"><strong>${esc(TASK_STATE[t.status] || t.status)}</strong> · ${esc(t.title)}</a><br><small class="muted">${esc(t.kind)} · ${esc((t.requested_by && t.requested_by.name) || 'someone')}${t.via === 'vibe' ? ' via Vibe' : ''}${t.runner ? ' · ' + esc(t.runner === 'actor' ? 'OpenVibe.Actor' : t.runner) : ''}${t.error ? ' · ' + esc(t.error) : ''}</small></li>`;
    const open = (tasks || []).filter((t) => t.status === 'queued' || t.status === 'running').length;
    el.innerHTML = `<fieldset style="max-width:760px;border:1px solid var(--accent);border-radius:10px;padding:14px 16px;margin-bottom:16px">
        <legend style="padding:0 8px;font-weight:700">Staff room ${open ? `<span class="muted" style="font-weight:500">· ${open} open</span>` : ''}</legend>
        <p class="muted" style="margin:0 0 10px">One room for all of staff on OpenVibe.Chat: talk, ask <code>@vibe</code> to look into or do something, and see the shared work queue. Research and web answers run at once on OpenVibe.Actor; code and computer work waits for a worker (a person or a coding agent) to take it, or the person who asked presses <em>Run on my computer</em> and their own machine does it (OpenVibe.Codes through OpenVibe.Run). Alerts from OpenVibe.Watch and other systems arrive through the room's hooks (room settings). Results come back into the room.</p>
        <p style="margin:0 0 12px"><a class="btn btn-primary" href="${CHAT_ORIGIN}/r/staff" target="_blank" rel="noopener"><i class="fa-solid fa-people-group"></i> Open the staff room</a></p>
        <form id="staff-task-form" style="display:grid;gap:6px;margin-bottom:10px">
            <input name="title" required minlength="3" maxlength="200" placeholder="Add work: what to do" style="padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
            <div style="display:flex;gap:6px;flex-wrap:wrap"><select name="kind" style="padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)"><option value="research">research (runs now)</option><option value="web">web answer (runs now)</option><option value="code">code (a worker takes it)</option><option value="computer">computer (a worker takes it)</option><option value="other">other</option></select>
            <button class="btn btn-secondary" type="submit">Add to the queue</button></div>
        </form>
        ${err ? `<p class="muted">The queue could not be read: ${esc(err)}</p>` : (tasks.length ? `<ol style="list-style:none;margin:0;padding:0">${tasks.map(row).join('')}</ol>` : '<p class="muted">Nothing queued yet.</p>')}
    </fieldset>`;
    const form = document.getElementById('staff-task-form');
    if (form) form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        try { await chatApi('/tasks', { method: 'POST', body: JSON.stringify({ title: fd.get('title'), kind: fd.get('kind') }) }); toast('Added to the staff room queue'); loadStaffRoom(); } catch (e) { toast(e.message, 'error'); }
    });
    clearTimeout(staffRoomTimer);
    staffRoomTimer = setTimeout(() => { if (document.getElementById('sec-ai') && document.getElementById('sec-ai').classList.contains('active') && !document.hidden) loadStaffRoom(); }, 15000);
}

async function loadAi() {
    loadStaffRoom();
    const c = document.getElementById('ai-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const [data, usageResp] = await Promise.all([
            api('/api/admin/streamer/settings'),
            api('/api/admin/streamer/ai/usage?days=30').catch(() => ({ usage: null })),
        ]);
        const byKey = {}; (data.settings || []).forEach(s => { byKey[s.key] = s; });
        const field = (key) => {
            const s = byKey[key]; if (!s) return '';
            const sensitive = /(api_key|secret)/i.test(key);
            // Server redacts API keys / money settings for non-owner admins — show locked.
            if (s.redacted) return `
                <div class="setting-row" style="flex-direction:column;align-items:stretch">
                    <label><strong>${esc(key)}</strong> <span style="color:var(--muted);font-size:11px;font-weight:600">🔒 Owner only</span><br><small>${esc(s.description||'')}</small></label>
                    <input type="text" value="${esc(s.value)}" disabled data-redacted="1"
                        style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:13px;opacity:0.65"></div>`;
            if (s.type === 'boolean') return `
                <div class="setting-row"><label><strong>${esc(key)}</strong><br><small>${esc(s.description||'')}</small></label>
                <input type="checkbox" data-key="${esc(key)}" data-type="boolean" ${s.value==='true'?'checked':''} style="width:18px;height:18px;cursor:pointer"></div>`;
            if (s.type === 'json' || /_json$/.test(key)) return `<div class="setting-row" style="flex-direction:column;align-items:stretch">
                <label><strong>${esc(key)}</strong><br><small>${esc(s.description||'')}</small></label>
                <textarea data-key="${esc(key)}" data-type="json" rows="4" spellcheck="false" style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;font-family:ui-monospace,monospace">${esc((() => { try { return JSON.stringify(JSON.parse(s.value), null, 2); } catch { return s.value; } })())}</textarea></div>`;
            const type = s.type === 'number' ? 'number' : (sensitive ? 'password' : 'text');
            return `<div class="setting-row" style="flex-direction:column;align-items:stretch">
                <label><strong>${esc(key)}</strong><br><small>${esc(s.description||'')}</small></label>
                <input type="${type}" data-key="${esc(key)}" data-type="${esc(s.type||'string')}" value="${esc(s.value)}"
                    style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px"></div>`;
        };
        const u = usageResp && usageResp.usage;
        let costHtml = '<p class="muted">No AI usage recorded yet.</p>';
        if (u && u.totals) {
            const money = (n) => '$' + (Number(n||0)).toFixed(4);
            costHtml = `
                <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px">
                    <div><div style="font-size:22px;font-weight:700">${money(u.today)}</div><small class="muted">Today</small></div>
                    <div><div style="font-size:22px;font-weight:700">${money(u.totals.cost_usd)}</div><small class="muted">30 days</small></div>
                    <div><div style="font-size:22px;font-weight:700">${u.totals.calls||0}</div><small class="muted">Calls (30d)</small></div>
                    <div><div style="font-size:22px;font-weight:700">${((u.totals.input_tokens||0)+(u.totals.output_tokens||0)).toLocaleString()}</div><small class="muted">Tokens (30d)</small></div>
                </div>
                <div class="muted" style="font-size:12px;margin-bottom:8px">Prompt cache hit rate: <b>${Math.round((u.cachedShare||0)*100)}%</b> of input tokens (30d) · ${(u.totals.cached_tokens||0).toLocaleString()} cached tokens</div>
                ${(u.byRole||[]).length ? `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:10px"><tr><th style="text-align:left">Role</th><th style="text-align:right">Calls</th><th style="text-align:right">Cached</th><th style="text-align:right">Avg ms</th><th style="text-align:right">Cost</th></tr>
                    ${u.byRole.map(k=>`<tr><td>${esc(k.role||'—')}</td><td style="text-align:right">${k.calls}</td><td style="text-align:right">${k.input_tokens ? Math.round((k.cached_tokens||0)/k.input_tokens*100) : 0}%</td><td style="text-align:right">${Math.round(k.avg_latency_ms||0)}</td><td style="text-align:right">${money(k.cost_usd)}</td></tr>`).join('')}</table>` : ''}
                ${(u.byKind||[]).length ? `<details><summary class="muted" style="cursor:pointer;font-size:12px">By feature</summary><table style="width:100%;font-size:13px;border-collapse:collapse"><tr><th style="text-align:left">Feature</th><th style="text-align:right">Calls</th><th style="text-align:right">Cost</th></tr>
                    ${u.byKind.map(k=>`<tr><td>${esc(k.kind||'—')}</td><td style="text-align:right">${k.calls}</td><td style="text-align:right">${money(k.cost_usd)}</td></tr>`).join('')}</table></details>` : ''}
                ${(u.byOwner||[]).length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:12px">By streamer (attributed spend)</summary><table style="width:100%;font-size:13px;border-collapse:collapse"><tr><th style="text-align:left">Streamer</th><th style="text-align:right">Calls</th><th style="text-align:right">Today</th><th style="text-align:right">30d</th><th style="text-align:right">of which BYO</th></tr>
                    ${u.byOwner.map(k=>`<tr><td>${esc(k.username||('#'+k.user_id))}</td><td style="text-align:right">${k.calls}</td><td style="text-align:right">${money(k.cost_today)}</td><td style="text-align:right">${money(k.cost_usd)}</td><td style="text-align:right">${money(k.cost_byo)}</td></tr>`).join('')}</table></details>` : ''}`;
        }
        c.innerHTML = `
            <div style="max-width:760px">
                <p class="muted" style="margin-bottom:12px">AI analysis for pastes, live-stream memories and AI viewers. Every call is a run on OpenVibe.AI, which holds the provider keys, models and prices (its console at ai.openvibe.network/console). Nothing runs until <strong>ai_enabled</strong> is on. Set <strong>ai_max_cost_usd_per_day</strong> to cap Live's daily spend.</p>
                <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:16px">
                    <legend style="padding:0 8px;font-weight:700">Estimated Cost</legend>
                    ${costHtml}
                </fieldset>
                <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:16px">
                    <legend style="padding:0 8px;font-weight:700">AI Chat Viewers</legend>
                    <div id="ai-viewers-fleet"><span class="muted">Loading…</span></div>
                </fieldset>
                <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:16px">
                    <legend style="padding:0 8px;font-weight:700">AI Status</legend>
                    <button type="button" class="btn" onclick="testAiStatus()"><i class="fa-solid fa-heart-pulse"></i> Run Status Check</button>
                    <div id="ai-status-out" style="margin-top:10px"></div>
                </fieldset>
                <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:16px">
                    <legend style="padding:0 8px;font-weight:700">AI Explorer</legend>
                    <p class="muted" style="margin:0 0 8px">Browse a streamer's AI memory, analyzed pastes, and VODs — and generate a per-streamer overview aggregated across all of it.</p>
                    <div style="display:flex;gap:8px">
                        <input id="ai-explorer-search" placeholder="Search streamer username…" onkeydown="if(event.key==='Enter'){event.preventDefault();aiExplorerSearch();}"
                            style="flex:1;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">
                        <button type="button" class="btn" onclick="aiExplorerSearch()"><i class="fa-solid fa-magnifying-glass"></i></button>
                    </div>
                    <div id="ai-explorer-results" style="margin-top:8px"></div>
                    <div id="ai-explorer-detail" style="margin-top:12px"></div>
                </fieldset>
                ${currentUser.is_owner ? `
                <form id="ai-form">
                    <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:16px">
                        <legend style="padding:0 8px;font-weight:700">Configuration</legend>
                        ${AI_KEYS.map(field).join('')}
                    </fieldset>
                    <button type="button" class="btn btn-primary" onclick="saveAi()"><i class="fa-solid fa-floppy-disk"></i> Save AI Settings</button>
                </form>` : `
                <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:16px;opacity:0.8">
                    <legend style="padding:0 8px;font-weight:700">Configuration</legend>
                    <p class="muted" style="margin:0"><i class="fa-solid fa-lock"></i> AI provider configuration and API keys are owner-only. You have full access to usage, costs, status, and the AI Explorer above.</p>
                </fieldset>`}
            </div>`;
        loadAiViewersFleet();
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function loadAiViewersFleet() {
    const el = document.getElementById('ai-viewers-fleet'); if (!el) return;
    try {
        const d = await api('/api/admin/streamer/ai/viewers/status');
        const money = (n) => '$' + (Number(n||0)).toFixed(4);
        el.innerHTML = `
            <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
                <span>Default engine: <b>${esc(d.engine_default)}</b></span>
                <span>Kill switch: <b style="color:${d.kill_switch ? '#f87171' : '#4ade80'}">${d.kill_switch ? 'ENGAGED (all channels silent)' : 'off'}</b></span>
                <span>Shared-key viewer spend today: <b>${money(d.global_spend_today_usd)}</b></span>
                <span class="muted" style="font-size:12px">The kill switch is ai_viewers_enabled in Configuration below.</span>
            </div>
            ${d.running.length ? `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:10px"><tr><th style="text-align:left">Running now</th><th>Engine</th><th>Stream</th><th>Bots</th><th>Mode</th><th>Lines</th><th>Passes</th><th style="text-align:right">Cost</th><th></th></tr>
                ${d.running.map(r=>`<tr><td>${esc(r.username||('#'+r.user_id))}</td><td>${esc(r.engine)}</td><td>${r.stream_id}</td><td>${r.bots}</td><td>${esc(r.paused ? 'paused' : (r.mode||''))}</td><td>${r.stats ? r.stats.lines : '—'}</td><td>${r.stats ? r.stats.ticks : '—'}</td><td style="text-align:right">${r.stats ? money(r.stats.cost) : '—'}</td>
                    <td style="white-space:nowrap"><button class="btn btn-sm btn-outline" onclick="aiViewersAdmin(${r.user_id},'${r.paused ? 'resume' : 'pause'}')">${r.paused ? 'Resume' : 'Pause'}</button> <button class="btn btn-sm btn-danger" onclick="aiViewersAdmin(${r.user_id},'stop')">Stop + disable</button></td></tr>`).join('')}</table>` : '<p class="muted" style="margin:0 0 8px">No AI viewer workers running right now.</p>'}
            <details><summary class="muted" style="cursor:pointer;font-size:12px">Channels with AI viewers configured (${d.channels.length})</summary>
            <table style="width:100%;font-size:13px;border-collapse:collapse"><tr><th style="text-align:left">Channel</th><th>Enabled</th><th>Activity</th><th>Bots</th><th>Key</th><th style="text-align:right">Today / cap</th></tr>
                ${d.channels.map(c=>`<tr><td>${esc(c.username)}</td><td>${c.enabled ? '✔' : '—'}</td><td>${esc(c.activity||'—')}</td><td>${c.bots}</td><td>${c.shared_key ? 'shared' : 'BYO'}</td><td style="text-align:right">${money(c.spent_today_usd)} / ${c.shared_key ? '$'+c.cap_usd.toFixed(2) : '∞'}</td></tr>`).join('')}</table></details>`;
    } catch (e) { el.innerHTML = `<span class="muted">Unavailable: ${esc(e.message)}</span>`; }
}
async function aiViewersAdmin(userId, action) {
    if (action === 'stop' && !confirm('Stop this channel\'s AI viewers now and disable them?')) return;
    try { const d = await api(`/api/admin/streamer/ai/viewers/${userId}/${action}`, { method: 'POST', body: {} }); toast(d.message || 'ok', 'success'); loadAiViewersFleet(); }
    catch (e) { toast(e.message, 'error'); }
}

async function saveAi() {
    const inputs = document.querySelectorAll('#ai-form [data-key]');
    const settings = {};
    for (const input of inputs) {
        let v = input.dataset.type === 'boolean' ? (input.checked ? 'true' : 'false') : input.value;
        if (input.dataset.type === 'json') { try { v = JSON.stringify(JSON.parse(input.value)); } catch (e) { return toast(`${input.dataset.key}: invalid JSON — ${e.message}`, 'error'); } }
        settings[input.dataset.key] = v;
    }
    try {
        await api('/api/admin/streamer/settings', { method: 'PUT', body: { settings } });
        toast('AI settings saved', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

// ── AI Status + Explorer ─────────────────────────────────────
async function testAiStatus() {
    const out = document.getElementById('ai-status-out');
    if (!out) return;
    out.innerHTML = '<span class="muted">Checking… (this makes one tiny live call)</span>';
    try {
        const { status } = await api('/api/admin/streamer/ai/status');
        const badge = status.ok ? '<span style="color:#4ade80">● OK</span>' : '<span style="color:#f87171">● Problem</span>';
        out.innerHTML = `<div style="font-size:13px;line-height:1.7">
            ${badge} &nbsp; via <b>${esc(status.service || 'openvibe-ai')}</b>${status.probed ? ` · reply "${esc(status.reply||'')}" · ${status.latency_ms}ms` : ''}
            <br>enabled: <b>${status.enabled}</b> · paste analysis: ${status.paste_analysis} · stream memory: ${status.stream_memory}
            <br>cost today: <b>$${Number(status.cost_today||0).toFixed(4)}</b> · daily cap: ${status.budget_cap_usd_per_day ? '$'+status.budget_cap_usd_per_day : 'none'}
            ${status.error ? `<br><span style="color:#f87171">${esc(status.error)}</span>` : ''}
        </div>`;
    } catch (e) { out.innerHTML = `<span style="color:#f87171">${esc(e.message)}</span>`; }
}

async function aiExplorerSearch() {
    const q = (document.getElementById('ai-explorer-search').value || '').trim();
    const box = document.getElementById('ai-explorer-results');
    box.innerHTML = '<span class="muted">Searching…</span>';
    try {
        const data = await api('/api/admin/streamer/users?search=' + encodeURIComponent(q) + '&limit=15');
        const users = data.users || [];
        box.innerHTML = users.length
            ? users.map(u => `<button type="button" class="btn btn-sm" style="margin:2px" onclick="aiExplorerLoad(${u.id})">@${esc(u.username)}${u.display_name && u.display_name !== u.username ? ' ('+esc(u.display_name)+')' : ''}</button>`).join('')
            : '<span class="muted">No matching users.</span>';
    } catch (e) { box.innerHTML = `<span style="color:#f87171">${esc(e.message)}</span>`; }
}

async function aiExplorerLoad(userId) {
    const box = document.getElementById('ai-explorer-detail');
    box.innerHTML = '<div class="loading">Loading…</div>';
    try {
        const d = await api('/api/admin/streamer/ai/explorer/' + userId);
        const ov = d.overview;
        const tbl = (rows, head) => `<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:6px"><thead><tr>${head.map(h=>`<th style="text-align:left;border-bottom:1px solid var(--border);padding:3px 6px">${h}</th>`).join('')}</tr></thead><tbody>${rows||`<tr><td style="padding:6px" class="muted">None</td></tr>`}</tbody></table>`;
        const scrollCell = (t) => t ? `<div style="max-height:90px;overflow:auto;white-space:pre-wrap;font-size:11px;line-height:1.45">${esc(t)}</div>` : '<span class="muted">—</span>';
        const isHeard = (s) => /heard:/i.test(s||'');
        const memRows = (d.memories||[]).map(m => `<tr><td style="padding:3px 6px;white-space:nowrap;color:var(--muted)">${esc((m.created_at||'').slice(0,16))}${isHeard(m.description)?' <span title="contains audio transcript" style="color:var(--accent)">🔊</span>':''}</td><td style="padding:3px 6px">${esc(m.description||'')}</td></tr>`).join('');
        const pasteRows = (d.pastes||[]).map(p => `<tr><td style="padding:3px 6px">${esc(p.type||'')}</td><td style="padding:3px 6px">${esc(p.title||'')}</td><td style="padding:3px 6px">${esc(p.ai_summary||'—')}</td></tr>`).join('');
        const vodRows = (d.vods||[]).map(v => `<tr><td style="padding:3px 6px">${esc(v.title||'')}</td><td style="padding:3px 6px">${esc(v.ai_overview||'—')}</td><td style="padding:3px 6px;min-width:180px">${scrollCell(v.ai_transcript)}</td></tr>`).join('');
        const clipRows = (d.clips||[]).map(c => `<tr><td style="padding:3px 6px">${esc(c.title||'')}</td><td style="padding:3px 6px">${esc(c.ai_overview||'—')}</td><td style="padding:3px 6px;min-width:180px">${scrollCell(c.ai_transcript)}</td></tr>`).join('');
        const txCount = (d.vods||[]).filter(v=>v.ai_transcript).length + (d.clips||[]).filter(c=>c.ai_transcript).length + (d.memories||[]).filter(m=>isHeard(m.description)).length;
        box.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                <h3 style="margin:0">@${esc(d.user.username)}</h3>
                <button type="button" class="btn btn-sm btn-primary" onclick="aiGenerateOverview(${userId})"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate Overview</button>
            </div>
            <div style="padding:10px;background:var(--bg-input);border-radius:6px;margin-bottom:10px">
                <strong>AI Overview</strong> ${ov?`<small class="muted">(${esc((ov.generated_at||'').slice(0,16))} · ${esc(ov.model||'')})</small>`:''}
                <div style="margin-top:6px;white-space:pre-wrap;font-size:13px;line-height:1.5">${ov?esc(ov.overview):'<span class="muted">Not generated yet — click “Generate Overview”.</span>'}</div>
            </div>
            <p class="muted" style="font-size:12px;margin:0 0 6px">${d.counts.memories} memories · ${d.counts.pastes} pastes · ${d.counts.vods} vods · ${d.counts.clips||0} clips · <span style="color:var(--accent)">🔊 ${txCount} with transcript</span></p>
            <details style="margin-bottom:6px"><summary style="cursor:pointer">Stream memories (${d.counts.memories}) — 🔊 = includes audio transcript</summary>${tbl(memRows,['When','Description'])}</details>
            <details style="margin-bottom:6px"><summary style="cursor:pointer">Pastes (${d.counts.pastes})</summary>${tbl(pasteRows,['Type','Title','AI summary'])}</details>
            <details style="margin-bottom:6px"><summary style="cursor:pointer">VODs (${d.counts.vods}) — overview + transcript</summary>${tbl(vodRows,['Title','AI overview','Transcript'])}</details>
            <details><summary style="cursor:pointer">Clips (${d.counts.clips||0}) — overview + transcript</summary>${tbl(clipRows,['Title','AI overview','Transcript'])}</details>`;
    } catch (e) { box.innerHTML = `<span style="color:#f87171">${esc(e.message)}</span>`; }
}

async function aiGenerateOverview(userId) {
    toast('Generating overview… (one AI call)', 'info');
    try {
        await api('/api/admin/streamer/ai/streamer/' + userId + '/overview', { method: 'POST' });
        toast('Overview generated', 'success');
        aiExplorerLoad(userId);
    } catch (e) { toast(e.message || 'Failed', 'error'); }
}

async function loadStreamerMediaTools() {
    const c = document.getElementById('settings-media');
    c.innerHTML = '<div class="loading">Loading...</div>';

    let status = {};
    try {
        status = await api('/api/admin/streamer/media-tools/status');
    } catch (e) {
        c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
        return;
    }

    c.innerHTML = `
        <div style="display:grid;gap:16px;max-width:860px">
            <div class="card">
                <h3><i class="fa-solid fa-wrench"></i> OpenVibe.Live yt-dlp Status</h3>
                <div style="display:grid;gap:8px;font-size:0.95rem">
                    <div><strong>yt-dlp available:</strong> ${status.ytdlp_available
                        ? '<span style="color:var(--success-text, var(--success,#22c55e))"><i class="fa-solid fa-check-circle"></i> Yes</span>'
                        : '<span style="color:var(--danger-text, var(--danger,#ef4444))"><i class="fa-solid fa-xmark-circle"></i> No</span>'
                    }</div>
                    <div><strong>Path:</strong> <span style="font-family:monospace;font-size:0.88rem">${esc(status.ytdlp_path || '')}</span></div>
                    <div><strong>YouTube cookies:</strong> ${status.cookies_configured
                        ? `<span style="color:var(--success-text, var(--success,#22c55e))"><i class="fa-solid fa-cookie"></i> Configured (${esc(String(status.cookies_size || 0))} bytes)</span>`
                        : '<span class="muted"><i class="fa-solid fa-cookie-bite"></i> Not configured</span>'
                    }</div>
                    ${!status.cookies_configured ? '<div style="color:var(--warn,#f59e0b);font-size:0.88rem"><i class="fa-solid fa-triangle-exclamation"></i> YouTube server-side downloads will fail until cookies.txt is added.</div>' : ''}
                </div>
            </div>

            <div class="card">
                <h3><i class="fa-solid fa-cookie"></i> YouTube Cookies</h3>
                <p class="muted" style="margin-top:0">Paste a Netscape-format cookies.txt export from a browser session logged into YouTube. This is required when YouTube bot detection blocks server-side downloads.</p>
                <textarea id="streamer-media-cookies-input" rows="10" placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;0&#9;SID&#9;value..."
                    style="width:100%;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:10px;border-radius:6px;font-family:monospace;font-size:12px;resize:vertical"></textarea>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
                    <button type="button" class="btn btn-primary" onclick="saveStreamerMediaCookies()"><i class="fa-solid fa-floppy-disk"></i> Save &amp; Test</button>
                    <button type="button" class="btn" onclick="checkStreamerMediaCookies()" ${status.cookies_configured ? '' : 'disabled'}><i class="fa-solid fa-kit-medical"></i> Test Current Cookies</button>
                    <button type="button" class="btn" onclick="deleteStreamerMediaCookies()" ${status.cookies_configured ? '' : 'disabled'}><i class="fa-solid fa-trash"></i> Remove Cookies</button>
                </div>
                <div id="streamer-media-cookie-verdict"></div>

                <details style="margin-top:16px">
                    <summary style="cursor:pointer;font-weight:600"><i class="fa-solid fa-circle-question"></i> How to get cookies that actually work</summary>
                    <div style="margin-top:12px;font-size:0.9rem;line-height:1.65">
                        <p style="margin-top:0"><strong>Why this is needed.</strong> YouTube treats requests from datacenter IPs as suspicious and answers with
                        <em>&ldquo;Sign in to confirm you&rsquo;re not a bot&rdquo;</em>. A signed-in cookie jar is what gets past that. Some videos work without it;
                        age-restricted and heavily-flagged ones will not.</p>

                        <p><strong>The one thing that matters.</strong> The export must contain YouTube&rsquo;s <em>first-party</em> session cookies —
                        <code>SID</code>, <code>HSID</code>, <code>SSID</code>, <code>APISID</code>, <code>SAPISID</code>, <code>__Secure-1PSID</code>.
                        An export holding only <code>__Secure-3P*</code> cookies parses fine and is <em>not signed in</em>; it will fail exactly the same way.
                        Save &amp; Test now tells you which of these are present.</p>

                        <p><strong>Recommended method — a throwaway account in a separate browser profile:</strong></p>
                        <ol style="margin:6px 0 0 18px;padding:0">
                            <li>Create a <em>burner</em> Google account. Do not use your main one: this jar grants access to that account, and it lives on the server.</li>
                            <li>Open a brand-new browser profile (not incognito &mdash; incognito is what produces the third-party-only exports that fail).</li>
                            <li>Sign in to YouTube in that profile and watch a few seconds of any video so the session is fully established.</li>
                            <li>Install a cookies.txt exporter extension (&ldquo;Get cookies.txt LOCALLY&rdquo; or similar) and export for <code>youtube.com</code>.</li>
                            <li>Paste the file contents above and press <strong>Save &amp; Test</strong>. It validates the jar and runs a real extraction before accepting it.</li>
                            <li>Then <strong>close that browser profile without logging out</strong>. Logging out invalidates the cookies you just exported.</li>
                        </ol>

                        <p style="margin-top:12px"><strong>Keeping it working:</strong></p>
                        <ul style="margin:6px 0 0 18px;padding:0">
                            <li>Cookies expire. Press <strong>Test Current Cookies</strong> if requests start failing &mdash; it reports the earliest expiry.</li>
                            <li>Do not use that burner account in another browser afterwards; YouTube rotates the session and the saved jar goes stale.</li>
                            <li>The file must be tab-separated Netscape format. Copying from a viewer that converts tabs to spaces produces a file that parses to nothing &mdash; the validator flags this.</li>
                            <li>A residential proxy avoids the problem at its source, since the block is driven by the server&rsquo;s datacenter IP.</li>
                        </ul>

                        <p style="margin-top:12px;color:var(--warn,#f59e0b)"><i class="fa-solid fa-triangle-exclamation"></i>
                        Anyone with admin access to this panel can read these cookies, and they are stored unencrypted on the server. Treat the account as compromised-by-design &mdash; burner only.</p>
                    </div>
                </details>
            </div>

            <div class="card">
                <h3><i class="fa-solid fa-flask-vial"></i> Test Extraction</h3>
                <p class="muted" style="margin-top:0">Test a YouTube URL against the live OpenVibe.Live server to confirm cookies and yt-dlp are working.</p>
                <div class="input-row">
                    <input type="text" id="streamer-media-test-url" placeholder="https://www.youtube.com/watch?v=...">
                    <button type="button" class="btn btn-primary" onclick="testStreamerMediaExtraction()"><i class="fa-solid fa-play"></i> Test</button>
                </div>
                <div id="streamer-media-test-results" style="margin-top:12px"></div>
            </div>
        </div>`;
}


/**
 * Render the cookie validation + live-test verdict returned by the server.
 * The old flow just said "saved", so a jar that could never work looked identical to a
 * good one — this shows exactly which check failed and what to do about it.
 */
function renderCookieVerdict(data) {
    const el = document.getElementById('streamer-media-cookie-verdict');
    if (!el) return;
    if (!data) { el.innerHTML = ''; return; }
    const c = data.check || {};
    const t = data.test || {};
    const ok = (v) => v
        ? '<span style="color:var(--success-text, var(--success,#22c55e))"><i class="fa-solid fa-circle-check"></i> '
        : '<span style="color:var(--danger-text, var(--danger,#ef4444))"><i class="fa-solid fa-circle-xmark"></i> ';

    const rows = [];
    rows.push(`<div>${ok(c.ok)}Signed-in cookies${c.ok ? '' : ' — missing'}</span></div>`);
    if (c.firstParty && c.firstParty.length) {
        rows.push(`<div class="muted" style="font-size:.85rem">First-party session: ${esc(c.firstParty.join(', '))}</div>`);
    }
    if (c.missingFirstParty && c.missingFirstParty.length && !c.ok) {
        rows.push(`<div class="muted" style="font-size:.85rem">Missing: ${esc(c.missingFirstParty.join(', '))}</div>`);
    }
    if (c.thirdParty && c.thirdParty.length && !c.firstParty?.length) {
        rows.push(`<div class="muted" style="font-size:.85rem">Only third-party found: ${esc(c.thirdParty.join(', '))}</div>`);
    }
    if (c.cookieCount != null) {
        rows.push(`<div class="muted" style="font-size:.85rem">${c.cookieCount} cookie(s)${c.expiresAt ? `, earliest expiry ${esc(new Date(c.expiresAt).toLocaleString())}` : ''}</div>`);
    }
    if (t.ran) {
        rows.push(`<div style="margin-top:6px">${ok(t.ok)}Live extraction${t.ok ? `: ${esc(t.title || 'ok')}` : ' failed'}</span></div>`);
        if (!t.ok && t.error) rows.push(`<div class="muted" style="font-size:.82rem;word-break:break-word">${esc(String(t.error).slice(0, 300))}</div>`);
    }
    (c.errors || []).forEach(e => rows.push(`<div style="color:var(--danger-text, var(--danger,#ef4444));font-size:.86rem;margin-top:6px">${esc(e)}</div>`));
    (c.warnings || []).forEach(w => rows.push(`<div style="color:var(--warn,#f59e0b);font-size:.86rem">${esc(w)}</div>`));

    el.innerHTML = `<div style="margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input)">${rows.join('')}</div>`;
}

async function checkStreamerMediaCookies() {
    const el = document.getElementById('streamer-media-cookie-verdict');
    if (el) el.innerHTML = '<div class="muted" style="margin-top:10px"><i class="fa-solid fa-spinner fa-spin"></i> Validating and running a live extraction…</div>';
    try {
        const data = await api('/api/admin/streamer/media-tools/cookies/check', { method: 'POST', body: {} });
        renderCookieVerdict(data);
    } catch (e) {
        if (el) el.innerHTML = `<div style="color:var(--danger-text, var(--danger,#ef4444));margin-top:10px">${esc(e.message)}</div>`;
    }
}

async function saveStreamerMediaCookies() {
    const ta = document.getElementById('streamer-media-cookies-input');
    const cookies = ta?.value?.trim() || '';
    if (!cookies) return toast('Paste cookies.txt content first', 'error');
    const el = document.getElementById('streamer-media-cookie-verdict');
    if (el) el.innerHTML = '<div class="muted" style="margin-top:10px"><i class="fa-solid fa-spinner fa-spin"></i> Validating and running a live extraction…</div>';
    try {
        const data = await api('/api/admin/streamer/media-tools/cookies', { method: 'PUT', body: { cookies } });
        toast(data?.test?.ok ? 'Cookies saved — live extraction passed' : 'Cookies saved', 'success');
        renderCookieVerdict(data);
    } catch (e) {
        // The server refuses a jar it can already tell is unusable and returns the reason.
        toast(e.message, 'error');
        if (e.body) renderCookieVerdict(e.body);
        else if (el) el.innerHTML = `<div style="color:var(--danger-text, var(--danger,#ef4444));margin-top:10px">${esc(e.message)}</div>`;
    }
}

async function deleteStreamerMediaCookies() {
    if (!confirm('Remove OpenVibe.Live yt-dlp cookies?')) return;
    try {
        await api('/api/admin/streamer/media-tools/cookies', { method: 'DELETE' });
        toast('OpenVibe.Live cookies removed', 'success');
        loadStreamerMediaTools();
    } catch (e) { toast(e.message, 'error'); }
}

async function testStreamerMediaExtraction() {
    const url = document.getElementById('streamer-media-test-url')?.value?.trim() || '';
    const results = document.getElementById('streamer-media-test-results');
    if (!url) return toast('Enter a URL to test', 'error');
    results.innerHTML = '<p class="muted"><i class="fa-solid fa-spinner fa-spin"></i> Testing live OpenVibe.Live extraction…</p>';
    try {
        const data = await api('/api/admin/streamer/media-tools/test', { method: 'POST', body: { url } });
        results.innerHTML = `<div style="display:grid;gap:8px;font-size:0.9rem">${(data.steps || []).map(step => {
            const icon = step.ok
                ? '<i class="fa-solid fa-check-circle" style="color:var(--success-text, var(--success,#22c55e))"></i>'
                : '<i class="fa-solid fa-xmark-circle" style="color:var(--danger-text, var(--danger,#ef4444))"></i>';
            const detail = step.error
                ? `<span style="color:var(--danger-text, var(--danger,#ef4444))"> — ${esc(step.error)}</span>`
                : step.data ? ` — ${esc(JSON.stringify(step.data))}` : '';
            return `<div>${icon} <strong>${esc(step.name)}</strong>${detail}</div>`;
        }).join('')}</div>`;
    } catch (e) {
        results.innerHTML = `<p style="color:var(--danger-text, var(--danger,#ef4444))">${esc(e.message)}</p>`;
    }
}

// ═══════════════════════════════════════════════════════════════
// TTS: OpenVibe.Chat's /api/tts admin routes, through the admin proxy (/api/admin/streamer-tts → Chat). Chat checks
// the admin role again and keeps the provider credentials owner-only (it masks them for other admins and ignores
// them in their saves); the settings themselves are stored with Live's site settings.
// ═══════════════════════════════════════════════════════════════
async function loadTTS() {
    const c = document.getElementById('tts-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const [settingsRes, voicesRes] = await Promise.all([
            api('/api/admin/streamer-tts/admin/settings'),
            api('/api/admin/streamer-tts/voices'),
        ]);
        const s = settingsRes.settings || {};
        const locked = !!s._secretsRedacted;   // not the owner: credentials are shown masked and cannot be changed
        const voices = voicesRes.voices || [];
        const byEngine = (engine) => voices.filter(v => v.engine === engine);
        const voiceOptions = (list) => list.map(v => `<option value="${esc(v.id)}" ${v.id === s.defaultVoice ? 'selected' : ''}>${esc(v.name)} (${esc(v.rarity || 'standard')})${v.available ? '' : ' ⚠ unavailable'}</option>`).join('');
        const secret = (id, label, value) => `<div class="form-field"><label for="${id}">${label}</label><input type="password" id="${id}" value="${esc(value || '')}" autocomplete="off"${locked ? ' disabled' : ''}></div>`;
        const ownerNote = locked ? '<p class="muted" style="margin-bottom:12px"><i class="fa-solid fa-lock" aria-hidden="true"></i> Only the owner can see or change provider credentials.</p>' : '';

        c.innerHTML = `
            <form id="tts-form" style="display:grid;gap:16px;max-width:760px">
                <p class="muted">Text-to-speech in chat runs in OpenVibe.Chat. These settings apply to every channel.</p>
                <div class="card">
                    <h3><i class="fa-solid fa-sliders" aria-hidden="true"></i> TTS Configuration</h3>
                    <div class="setting-row"><label for="tts-enabled"><strong>Enabled</strong><br><small>Allow text-to-speech messages in chat.</small></label><input type="checkbox" id="tts-enabled" ${s.enabled ? 'checked' : ''} style="width:18px;height:18px"></div>
                    <div class="form-field"><label for="tts-provider">Provider</label><select id="tts-provider"><option value="espeak-ng" ${s.provider === 'espeak-ng' ? 'selected' : ''}>espeak-ng</option><option value="google-cloud" ${s.provider === 'google-cloud' ? 'selected' : ''}>Google Cloud</option><option value="amazon-polly" ${s.provider === 'amazon-polly' ? 'selected' : ''}>Amazon Polly</option></select></div>
                    <div class="form-field"><label for="tts-default-voice">Default Voice</label><select id="tts-default-voice"><optgroup label="espeak-ng">${voiceOptions(byEngine('espeak-ng'))}</optgroup><optgroup label="Google Cloud">${voiceOptions(byEngine('google-cloud'))}</optgroup><optgroup label="Amazon Polly">${voiceOptions(byEngine('amazon-polly'))}</optgroup></select></div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
                        <div class="form-field"><label for="tts-max-length">Max Message Length</label><input type="number" id="tts-max-length" value="${esc(s.maxLength || 200)}"></div>
                        <div class="form-field"><label for="tts-max-per-user">Max Queue / User</label><input type="number" id="tts-max-per-user" value="${esc(s.maxQueuePerUser || 3)}"></div>
                        <div class="form-field"><label for="tts-max-global">Max Global Queue</label><input type="number" id="tts-max-global" value="${esc(s.maxQueueGlobal || 20)}"></div>
                    </div>
                </div>

                <div class="card">
                    <h3><i class="fa-brands fa-google" aria-hidden="true"></i> Google Cloud</h3>
                    ${ownerNote}
                    ${secret('tts-google-api-key', 'API Key', s.googleApiKey)}
                    <div class="form-field"><label for="tts-google-sa">Service Account JSON</label><textarea id="tts-google-sa" rows="4" style="resize:vertical"${locked ? ' disabled' : ''}>${esc(s.googleServiceAccount || '')}</textarea></div>
                </div>

                <div class="card">
                    <h3><i class="fa-solid fa-cloud" aria-hidden="true"></i> Amazon Polly</h3>
                    ${ownerNote}
                    ${secret('tts-aws-key', 'AWS Access Key ID', s.awsAccessKeyId)}
                    ${secret('tts-aws-secret', 'AWS Secret Access Key', s.awsSecretAccessKey)}
                    <div class="form-field"><label for="tts-aws-region">AWS Region</label><input type="text" id="tts-aws-region" value="${esc(s.awsRegion || 'us-east-1')}"></div>
                </div>

                <div style="display:flex;gap:10px;flex-wrap:wrap">
                    <button type="button" class="btn btn-primary" onclick="saveTTS()"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save TTS Settings</button>
                    <button type="button" class="btn btn-outline" onclick="testTTSVoice()"><i class="fa-solid fa-volume-high" aria-hidden="true"></i> Test Voice</button>
                </div>
            </form>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function saveTTS() {
    const val = (id) => document.getElementById(id).value;
    const settings = {
        tts_enabled: document.getElementById('tts-enabled').checked,
        tts_provider: val('tts-provider'),
        tts_default_voice: val('tts-default-voice'),
        tts_max_length: parseInt(val('tts-max-length'), 10) || 200,
        tts_max_queue_per_user: parseInt(val('tts-max-per-user'), 10) || 3,
        tts_max_queue_global: parseInt(val('tts-max-global'), 10) || 20,
        tts_aws_region: val('tts-aws-region') || 'us-east-1',
    };
    // Credentials go only from the owner's form (Chat ignores them from anyone else, and never stores a masked value).
    if (!document.getElementById('tts-aws-secret').disabled) {
        Object.assign(settings, {
            tts_google_api_key: val('tts-google-api-key'),
            tts_google_service_account: val('tts-google-sa'),
            tts_aws_access_key_id: val('tts-aws-key'),
            tts_aws_secret_access_key: val('tts-aws-secret'),
        });
    }
    try {
        await api('/api/admin/streamer-tts/admin/settings', { method: 'PUT', body: { settings } });
        toast('TTS settings saved', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

// The test clip plays through Web Audio: this page's Content-Security-Policy (media-src 'self') refuses blob:
// and data: audio, and the clip URL Chat returns is on Live's origin.
let _ttsAudioCtx = null;
async function testTTSVoice() {
    try {
        const voiceId = document.getElementById('tts-default-voice').value;
        const result = await api('/api/admin/streamer-tts/admin/test', {
            method: 'POST',
            body: { voiceId, text: 'Hello, this is a voice test from the OpenVibe admin panel.' },
        });
        if (!result.audio) {
            toast('No audio returned from the provider', 'warning');
            return;
        }
        const binary = atob(result.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) { toast('This browser cannot play the test clip', 'warning'); return; }
        _ttsAudioCtx = _ttsAudioCtx || new Ctx();
        if (_ttsAudioCtx.state === 'suspended') await _ttsAudioCtx.resume();
        const buffer = await _ttsAudioCtx.decodeAudioData(bytes.buffer);
        const src = _ttsAudioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(_ttsAudioCtx.destination);
        src.start();
        toast(`Testing ${result.voiceName || voiceId}`, 'info');
    } catch (e) { toast(e.message || 'Could not play the test clip', 'error'); }
}
