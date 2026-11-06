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
    loadPlatformAi();
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

// ═══════════════════════════════════════════════════════════════
// Platform AI (AI Exchange D11 S3, owner only): every service's openvibe-shared/config namespaces and AI's provider
// registry, in one long stacked page (no inner tabs, nothing display:none) with a sticky in-page index. The server
// proxy is /api/admin/ai/config (server/admin/ai-config-proxy.js); it holds no value, and neither does this page:
// a secret is only ever written, never rendered. Network's admin helpers (api, esc, toast, timeAgo) are above.
// ═══════════════════════════════════════════════════════════════
const PAI_NAMES = {
    network: 'OpenVibe.Network', ai: 'OpenVibe.AI', billing: 'OpenVibe.Billing', services: 'OpenVibe.Services', watch: 'OpenVibe.Watch',
    bench: 'OpenVibe.Bench', report: 'OpenVibe.Report', host: 'OpenVibe.Host', codes: 'OpenVibe.Codes',
    actor: 'OpenVibe.Actor',
};
const PAI_ACCESS = ['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED'];
const PAI_BILLING_LABEL = { metered: 'Metered', subscription: 'Subscription', payg: 'Pay as you go', free: 'Free', byok: 'Customer BYOK' };
const PAI_ACCESS_LABEL = {
    OWN_DEPLOYMENT: 'Own deployment', AUTHORIZED_WHOLESALE: 'Authorized wholesale', CUSTOMER_BYOK: 'Customer BYOK',
    RESTRICTED: 'Restricted', UNVERIFIED: 'Unverified',
};
// An integer's x-unit, as the owner form labels it. A unit this page does not know is left off so the
// input is a plain number: the page then works with a newer openvibe-shared before its pin moves.
const PAI_UNIT_LABEL = { ms: 'ms', seconds: 's', bps: 'bps' };
const PAI = {
    providers: [], services: [], namespaces: [], warnings: [], vault: {}, serviceState: {}, loading: false, addProviderError: null,
};

function paiUnitLabel(unit) {
    return Object.prototype.hasOwnProperty.call(PAI_UNIT_LABEL, unit) ? PAI_UNIT_LABEL[unit] : '';
}

function paiLabel(service) {
    return PAI_NAMES[service] || ('OpenVibe.' + String(service || '').replace(/^./, (c) => c.toUpperCase()));
}

function paiApi(path, opts = {}) {
    return api('/api/admin/ai/config' + path, opts).catch((err) => {
        if (err && err.status === 403 && err.body && err.body.code === 'config.fresh_required') {
            paiShowFresh(err.body.sign_in_url);
            err.freshRequired = true;
        }
        throw err;
    });
}

function paiShowFresh(url) {
    const el = document.getElementById('pai-fresh');
    if (!el) return;
    const link = el.querySelector('a');
    if (link && url) link.href = url;
    el.hidden = false;
}

function paiFriendly(service, err) {
    if (err && err.freshRequired) return "Confirm it's you to change keys and money settings.";
    if (err && (err.status === 502 || err.status === 503 || /did not answer|not configured/i.test(err.message || ''))) {
        return paiLabel(service) + ' did not answer.';
    }
    const message = String((err && err.message) || 'The request failed').split('\n')[0];
    return message.length > 240 ? message.slice(0, 240) + '…' : message;
}

/** Dollar text ↔ nano-USD, exactly: BigInt integer maths, no float, at most 9 decimals. */
function paiUsd(nano) {
    let n;
    try { n = BigInt(String(nano == null ? 0 : nano)); } catch { return '0'; }
    const negative = n < 0n;
    if (negative) n = -n;
    const whole = n / 1000000000n;
    const frac = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
    return (negative ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

function paiParseUsd(text) {
    const value = String(text == null ? '' : text).trim();
    if (!/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{0,9})?$/.test(value)) return { error: 'Enter dollars with at most 9 decimals, e.g. 12.50' };
    const [whole, frac = ''] = value.split('.');
    const nano = BigInt(whole) * 1000000000n + BigInt((frac + '000000000').slice(0, 9));
    if (nano > BigInt(Number.MAX_SAFE_INTEGER)) return { error: 'That amount is too large' };
    return { nano: Number(nano) };
}

function paiHost(url) {
    try { return new URL(url).host; } catch { return String(url || '—'); }
}

function paiWhen(iso) {
    if (!iso) return '';
    try { return timeAgo(iso); } catch { return ''; }
}

function paiMarker(value) {
    return value && typeof value === 'object' && value.redacted === true ? value : null;
}

function paiFold(items, render) {
    const head = items.slice(0, 8).map(render).join('');
    if (items.length <= 8) return '<div class="pai-rows">' + head + '</div>';
    return '<div class="pai-rows">' + head + '</div><details class="pai-more"><summary>More (' + (items.length - 8) + ')</summary><div class="pai-rows">' + items.slice(8).map(render).join('') + '</div></details>';
}

async function loadPlatformAi() {
    const root = document.getElementById('platform-ai');
    if (!root) return;
    if (!currentUser || !currentUser.is_owner) { root.hidden = true; return; }
    root.hidden = false;
    if (PAI.loading) return;
    PAI.loading = true;
    try {
        const [servicesRes, providersRes] = await Promise.all([
            paiApi('/services'),
            paiApi('/providers').catch((err) => ({ error: err })),
        ]);
        PAI.services = servicesRes.services || [];
        PAI.providers = (providersRes && providersRes.providers) || [];
        PAI.addProviderError = providersRes && providersRes.error ? paiFriendly('ai', providersRes.error) : null;
        const answers = await Promise.all(PAI.services.map((s) => paiApi('/service/' + encodeURIComponent(s.service)).then((r) => ({ service: s.service, ...r })).catch((err) => ({ service: s.service, error: err }))));
        PAI.namespaces = [];
        PAI.warnings = [];
        PAI.vault = {};
        PAI.serviceState = {};
        for (const answer of answers) {
            if (answer.error) {
                PAI.warnings.push({ service: answer.service, namespace: null, reason: 'unavailable', detail: paiFriendly(answer.service, answer.error) });
                PAI.vault[answer.service] = { sealed: null, kek: null };
                PAI.serviceState[answer.service] = { answered: false, sealed: null, kek: null };
                continue;
            }
            PAI.namespaces.push(...(answer.namespaces || []));
            PAI.warnings.push(...(answer.warnings || []));
            PAI.vault[answer.service] = answer.vault || { sealed: null, kek: null };
            PAI.serviceState[answer.service] = { answered: true, sealed: answer.vault ? answer.vault.sealed : null, kek: answer.vault ? answer.vault.kek : null };
        }
        paiRender(root);
    } catch (err) {
        root.innerHTML = paiShell('<p class="pai-error">' + esc(paiFriendly('network', err)) + '</p>');
    } finally {
        PAI.loading = false;
    }
}

function paiShell(inner) {
    return '<div class="pai-head"><h2><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Platform AI</h2>'
        + '<p class="muted">Every service\'s AI settings in one place. Keys are sealed and write-only: once saved, nothing here can show one again. Money and key changes ask you to confirm it is you.</p></div>'
        + '<div id="pai-fresh" class="pai-fresh" hidden><i class="fa-solid fa-lock" aria-hidden="true"></i> <span>Confirm it\'s you to change keys and money settings.</span> <a class="btn btn-primary" href="/login?reauth=1&return=%2Fadmin%23ai">Sign in again</a></div>'
        + inner;
}

function paiRender(root) {
    const exchange = PAI.namespaces.filter((n) => n.service === 'ai' && !n.namespace.endsWith('.provider_keys'));
    const money = PAI.namespaces.filter((n) => n.service === 'billing');
    const rest = PAI.namespaces.filter((n) => n.service !== 'ai' && n.service !== 'billing' && !n.namespace.endsWith('.provider_keys'));
    const count = (n) => n ? ' <span class="pai-count">' + n + '</span>' : '';
    root.innerHTML = paiShell(
        '<nav class="pai-index" aria-label="Platform AI sections">'
        + '<a href="#pai-providers">Providers and accounts' + count(PAI.providers.length) + '</a>'
        + '<a href="#pai-exchange">AI Exchange' + count(exchange.length) + '</a>'
        + '<a href="#pai-money">Money' + count(money.length) + '</a>'
        + '<a href="#pai-services">Services' + count(rest.length) + '</a>'
        + '<a href="#pai-vault">Vault' + count(PAI.services.length) + '</a>'
        + '</nav>'
        + '<div id="pai-warnings"></div>'
        + '<section id="pai-providers" class="pai-section"><div class="pai-section-head"><h3>Providers and accounts</h3><p class="muted">The providers OpenVibe.AI may call, their billing profile and their key. A subscription account runs on a shared pool; a metered one spends Credits.</p></div>'
        + '<div class="pai-toolbar"><button type="button" class="btn btn-primary" id="pai-add-provider"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add provider</button></div>'
        + '<div id="pai-providers-list"></div></section>'
        + '<section id="pai-exchange" class="pai-section"><h3>AI Exchange</h3><p class="muted">What OpenVibe.AI routes, which models it offers and what it may spend.</p><div id="pai-cards-exchange" data-pai-cards></div></section>'
        + '<section id="pai-money" class="pai-section"><h3>Money</h3><p class="muted">Credits, top-ups and the sandbox. Every money switch says exactly what it turns on.</p><div id="pai-cards-money" data-pai-cards></div></section>'
        + '<section id="pai-services" class="pai-section"><h3>Services</h3><p class="muted">The settings of every other service, drawn from each namespace\'s schema.</p><div id="pai-cards-services" data-pai-cards></div></section>'
        + '<section id="pai-vault" class="pai-section"><h3>Vault</h3><p class="muted">Secrets are sealed with the service\'s own key-encryption key (KEK); without one the store keeps its pre-D11 plaintext behaviour and says so.</p><div id="pai-vault-list"></div></section>'
    );
    paiRenderWarnings();
    paiRenderProviders();
    paiRenderCards();
    paiRenderVault();
    const add = document.getElementById('pai-add-provider');
    if (add) add.addEventListener('click', () => paiProviderDialog(null));
    const list = document.getElementById('pai-providers-list');
    if (list) {
        list.addEventListener('click', paiProviderClick);
        list.addEventListener('change', paiProviderSwitch);
    }
    for (const box of document.querySelectorAll('#platform-ai [data-pai-cards]')) {
        box.addEventListener('click', paiCardClick);
        box.addEventListener('change', (ev) => {
            const input = ev.target.closest('input[data-pai-control][data-type="boolean"]');
            if (!input) return;
            const text = input.closest('.pai-switch') && input.closest('.pai-switch').querySelector('.pai-switch-text');
            if (text) text.textContent = input.checked ? 'On' : 'Off';
        });
    }
    if (window.OVForms && window.OVForms.enhance) window.OVForms.enhance(root);
}

function paiRenderWarnings() {
    const box = document.getElementById('pai-warnings');
    if (!box) return;
    if (!PAI.warnings.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="pai-warning"><strong>Some answers were dropped.</strong> The service answered with something that is not a settings summary, so it is not shown.'
        + PAI.warnings.map((w) => '<div class="pai-warning-row">' + esc(paiLabel(w.service)) + (w.namespace ? ' · <code>' + esc(w.namespace) + '</code>' : '') + ' — ' + esc(w.reason === 'invalid-summary' ? 'not a settings summary' : (w.reason || 'not available')) + '</div>').join('')
        + '</div>';
}

function paiKeyState(p) {
    const ref = String(p.secret_ref || '');
    const vault = ref.startsWith('vault:');
    const env = ref.startsWith('env:');
    const hint = p.key_hint || p.hint || p.secret_hint || '';
    const bound = p.bound_to || paiHost(p.base_url);
    const required = p.auth_mode !== 'none' && p.credentials !== 'not_required';
    if (!required) return { tone: 'muted', text: 'Not required', required: false };
    if (vault && p.credentials !== 'missing') return { tone: 'ok', text: 'Sealed' + (hint ? ' ••••' + esc(hint) : '') + ' · bound to ' + esc(paiHost(bound)), required: true };
    if (env) return { tone: 'muted', text: 'From env ' + esc(ref.slice(4)), env: ref.slice(4), required: true };
    if (p.credentials === 'missing' || !ref) return { tone: 'bad', text: 'No key', required: true };
    return { tone: 'ok', text: 'Sealed · bound to ' + esc(paiHost(bound)), required: true };
}

function paiProviderRow(p) {
    const access = PAI_ACCESS.includes(String(p.provider_access || '').toUpperCase()) ? String(p.provider_access).toUpperCase() : 'UNVERIFIED';
    const billing = p.billing_profile === 'subscription' ? 'Subscription · ' + esc(p.pool_key || p.key) : esc(PAI_BILLING_LABEL[p.billing_profile] || PAI_BILLING_LABEL.metered);
    const key = paiKeyState(p);
    const sealed = String(p.secret_ref || '').startsWith('vault:') && p.credentials !== 'missing';
    const actions = '<button type="button" class="btn btn-sm pai-quiet" data-act="edit">Edit</button> '
        + (key.required && key.env ? '<button type="button" class="btn btn-sm pai-quiet" data-act="key">Move into the vault</button> ' : '')
        + (key.required ? '<button type="button" class="btn btn-sm pai-quiet" data-act="key">' + (sealed ? 'Replace key' : 'Add key') + '</button> ' : '')
        + (key.required && sealed ? '<button type="button" class="btn btn-sm pai-quiet pai-quiet-danger" data-act="remove-key">Remove key</button>' : '');
    return '<div class="pai-provider" data-pai-provider="' + esc(p.key) + '">'
        + '<div class="pai-provider-main"><div class="pai-provider-name">' + esc(p.display_name || p.key) + ' <span class="pai-kind">' + esc(p.kind || '—') + '</span></div>'
        + '<div class="pai-provider-meta"><code>' + esc(paiHost(p.base_url)) + '</code> <span class="pai-access is-' + access.toLowerCase() + '">' + esc(PAI_ACCESS_LABEL[access]) + '</span> <span class="pai-billing">' + billing + '</span></div>'
        + '<div class="pai-keystate is-' + key.tone + '">' + key.text + '</div></div>'
        + '<div class="pai-provider-actions"><label class="pai-switch"><input type="checkbox" role="switch" data-pai-enabled data-ov-native ' + (p.status === 'active' ? 'checked' : '') + '><span class="pai-track" aria-hidden="true"><span class="pai-knob"></span></span><span class="pai-switch-text">' + (p.status === 'active' ? 'Enabled' : 'Disabled') + '</span></label>' + actions + '</div></div>';
}

function paiRenderProviders() {
    const box = document.getElementById('pai-providers-list');
    if (!box) return;
    if (PAI.addProviderError) {
        box.innerHTML = '<p class="pai-error">' + esc(PAI.addProviderError) + '</p>';
        return;
    }
    if (!PAI.providers.length) {
        box.innerHTML = '<p class="muted">No provider is configured yet. Add one to let OpenVibe.AI answer.</p>';
        return;
    }
    const subscription = PAI.providers.filter((p) => p.billing_profile === 'subscription');
    const other = PAI.providers.filter((p) => p.billing_profile !== 'subscription');
    box.innerHTML = paiFold(other, paiProviderRow)
        + (subscription.length ? '<h4 class="pai-subhead">Subscription accounts (Claude, Codex, …)</h4>' + paiFold(subscription, paiProviderRow) : '');
}

function paiProviderClick(ev) {
    const button = ev.target.closest('button[data-act]');
    if (!button) return;
    const row = button.closest('[data-pai-provider]');
    if (!row) return;
    const provider = PAI.providers.find((p) => p.key === row.dataset.paiProvider);
    if (!provider) return;
    if (button.dataset.act === 'edit') paiProviderDialog(provider);
    if (button.dataset.act === 'key') paiKeyDialog(provider);
    if (button.dataset.act === 'remove-key') paiRemoveKey(provider);
}

async function paiProviderSwitch(ev) {
    const input = ev.target.closest('input[data-pai-enabled]');
    if (!input) return;
    const row = input.closest('[data-pai-provider]');
    const provider = PAI.providers.find((p) => p.key === row.dataset.paiProvider);
    if (!provider) return;
    input.disabled = true;
    try {
        await paiApi('/providers/' + encodeURIComponent(provider.key), { method: 'PATCH', body: { status: input.checked ? 'active' : 'disabled' } });
        provider.status = input.checked ? 'active' : 'disabled';
        const label = input.closest('.pai-switch').querySelector('.pai-switch-text');
        if (label) label.textContent = input.checked ? 'Enabled' : 'Disabled';
        toast(provider.display_name + (input.checked ? ' enabled' : ' disabled'), 'success');
    } catch (err) {
        input.checked = !input.checked;
        const label = input.closest('.pai-switch').querySelector('.pai-switch-text');
        if (label) label.textContent = input.checked ? 'Enabled' : 'Disabled';
        if (!err.freshRequired) toast(paiFriendly('ai', err), 'error');
    } finally {
        input.disabled = false;
    }
}

function paiProviderDialog(provider) {
    const editing = !!provider;
    const p = provider || { billing_profile: 'metered', kind: 'openai', priority: 100, provider_access: 'UNVERIFIED' };
    const access = PAI_ACCESS.includes(String(p.provider_access || '').toUpperCase()) ? String(p.provider_access).toUpperCase() : 'UNVERIFIED';
    const kind = p.kind || 'openai';
    const billing = p.billing_profile || 'metered';
    const dlg = document.createElement('dialog');
    dlg.className = 'pai-dialog';
    const options = (items, current) => items.map((item) => '<option value="' + esc(item.value) + '"' + (item.value === current ? ' selected' : '') + ' data-desc="' + esc(item.desc || '') + '" data-state="' + (item.state || 'off') + '">' + esc(item.label) + '</option>').join('');
    const kindOptions = [
        { value: 'openai', label: 'OpenAI-compatible', desc: 'Chat/completions with a bearer key', state: 'ok' },
        { value: 'anthropic', label: 'Anthropic Messages', desc: 'Claude\'s own messages API', state: 'ok' },
        { value: 'http', label: 'Plain HTTP seam', desc: 'A custom endpoint that speaks JSON', state: 'off' },
        { value: 'stub', label: 'Deterministic stub', desc: 'Synthetic answers for tests', state: 'off' },
        { value: 'whisper', label: 'whisper.cpp', desc: 'Local speech-to-text', state: 'off' },
    ];
    const billingOptions = [
        { value: 'metered', label: 'Metered', desc: 'Every request spends Credits', state: 'ok' },
        { value: 'subscription', label: 'Subscription', desc: 'Runs on a shared plan pool', state: 'ok' },
        { value: 'payg', label: 'Pay as you go', desc: 'A prepaid provider balance', state: 'off' },
        { value: 'free', label: 'Free', desc: 'No provider charge', state: 'off' },
        { value: 'byok', label: 'Customer BYOK', desc: 'A customer\'s own key pays the provider', state: 'new' },
    ];
    dlg.innerHTML = '<form method="dialog" class="pai-form">'
        + '<h3>' + (editing ? 'Edit provider' : 'Add provider') + '</h3>'
        + '<div class="ov-field"><label for="pai-p-key">Key</label><input id="pai-p-key" name="key" required pattern="[a-z][a-z0-9_-]*([.][a-z0-9_-]+)*" ' + (editing ? 'readonly' : '') + ' value="' + esc(p.key || '') + '"><p class="ov-field-hint">Lowercase, dotted or dashed: deepseek, claude, codex. It cannot be renamed.</p></div>'
        + '<div class="ov-field"><label for="pai-p-name">Display name</label><input id="pai-p-name" name="display_name" value="' + esc(p.display_name || '') + '"></div>'
        + '<div class="ov-field"><label for="pai-p-kind">Kind</label><select id="pai-p-kind" name="kind">'
        + options(kindOptions, kind)
        + '</select></div>'
        + '<div class="ov-field"><label for="pai-p-url">Base URL</label><input id="pai-p-url" name="base_url" type="url" placeholder="https://api.example.com" value="' + esc(p.base_url || '') + '"><p class="ov-field-hint">A sealed key is bound to this address: changing it means entering the key again.</p></div>'
        + '<div class="ov-field"><label for="pai-p-access">Provider access</label><select id="pai-p-access" name="provider_access" data-ov-title="Provider access">'
        + PAI_ACCESS.map((a) => '<option value="' + a + '"' + (a === access ? ' selected' : '') + ' data-badge="' + esc(PAI_ACCESS_LABEL[a]) + '" data-desc="' + esc(paiAccessDesc(a)) + '" data-state="' + (a === 'OWN_DEPLOYMENT' || a === 'AUTHORIZED_WHOLESALE' ? 'ok' : a === 'RESTRICTED' ? 'warn' : a === 'UNVERIFIED' ? 'off' : 'new') + '">' + esc(PAI_ACCESS_LABEL[a]) + '</option>').join('')
        + '</select></div>'
        + '<div class="pai-form-row"><div class="ov-field"><label for="pai-p-billing">Billing profile</label><select id="pai-p-billing" name="billing_profile">'
        + options(billingOptions, billing)
        + '</select></div><div class="ov-field"><label for="pai-p-pool">Pool</label><input id="pai-p-pool" name="pool_key" placeholder="claude-max" value="' + esc(p.pool_key || '') + '"><p class="ov-field-hint">Subscription pools only; a name, never a secret.</p></div></div>'
        + '<div class="pai-form-row"><div class="ov-field"><label for="pai-p-priority">Priority</label><input id="pai-p-priority" name="priority" type="number" step="1" value="' + esc(p.priority == null ? 100 : p.priority) + '"></div>'
        + '<div class="ov-field"><label for="pai-p-model">Default model</label><input id="pai-p-model" name="default_model" value="' + esc(p.default_model || '') + '"></div></div>'
        + '<div id="pai-p-key-field"></div>'
        + '<div class="pai-dialog-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-act="save">' + (editing ? 'Save' : 'Add provider') + '</button></div>'
        + '</form>';
    // The key field is built as a DOM node and is never part of an innerHTML string.
    const keyField = document.createElement('div');
    keyField.className = 'ov-field';
    const keyLabel = document.createElement('label');
    keyLabel.htmlFor = 'pai-p-value';
    keyLabel.textContent = editing ? 'Replace key (write-only)' : 'Key (write-only)';
    const keyInput = document.createElement('input');
    keyInput.id = 'pai-p-value';
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.spellcheck = false;
    keyInput.placeholder = editing ? 'Leave empty to keep the key' : 'Paste the provider key';
    const keyHint = document.createElement('p');
    keyHint.className = 'ov-field-hint';
    keyHint.textContent = 'Sent once and sealed by OpenVibe.AI; it is never shown again.';
    keyField.append(keyLabel, keyInput, keyHint);
    dlg.querySelector('#pai-p-key-field').append(keyField);
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="cancel"]')) { dlg.close(); dlg.remove(); } });
    dlg.addEventListener('close', () => dlg.remove());
    const form = dlg.querySelector('form');
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const data = new FormData(form);
        const body = {
            key: String(data.get('key') || '').trim(),
            display_name: String(data.get('display_name') || '').trim() || null,
            kind: data.get('kind'),
            base_url: String(data.get('base_url') || '').trim() || null,
            auth_mode: data.get('kind') === 'anthropic' ? 'x-api-key' : (data.get('kind') === 'stub' || data.get('kind') === 'whisper' ? 'none' : 'bearer'),
            billing_profile: data.get('billing_profile'),
            pool_key: String(data.get('pool_key') || '').trim() || null,
            priority: Number(data.get('priority') || 100),
            default_model: String(data.get('default_model') || '').trim() || null,
            metadata: { ...(p.metadata || {}), provider_access: data.get('provider_access') },
        };
        if (editing && p.base_url && body.base_url !== p.base_url && String(p.secret_ref || '').startsWith('vault:')) {
            const ok = await paiConfirm('Change the base URL?', ['Its sealed key is bound to the old address and will stop working until you enter it again.']);
            if (!ok) return;
        }
        const save = form.querySelector('[data-act="save"]');
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
            let created;
            if (editing) created = await paiApi('/providers/' + encodeURIComponent(p.key), { method: 'PATCH', body });
            else created = await paiApi('/providers', { method: 'POST', body });
            const key = body.key || p.key;
            if (keyInput.value) {
                await paiApi('/providers/' + encodeURIComponent(key) + '/key', { method: 'PUT', body: { value: keyInput.value, reason: editing ? 'Replaced from the admin panel' : 'Added from the admin panel' } });
            }
            keyInput.value = '';
            dlg.close();
            toast(editing ? 'Provider saved' : 'Provider added', 'success');
            await loadPlatformAi();
        } catch (err) {
            if (!err.freshRequired) toast(paiFriendly('ai', err), 'error');
            save.disabled = false;
            save.textContent = editing ? 'Save' : 'Add provider';
        } finally {
            keyInput.value = '';
        }
    });
    dlg.showModal();
    if (window.OVForms && window.OVForms.enhance) window.OVForms.enhance(dlg);
}

function paiAccessDesc(access) {
    return {
        OWN_DEPLOYMENT: 'A model on OpenVibe\'s own machine: no provider terms limit it.',
        AUTHORIZED_WHOLESALE: 'A wholesale agreement permits resale; check the agreement covers this model.',
        CUSTOMER_BYOK: 'The customer\'s own key: they pay the provider and the terms are theirs.',
        RESTRICTED: 'The provider\'s terms do not permit resale: do not sell this capacity.',
        UNVERIFIED: 'Not reviewed yet: treat it as restricted until someone checks the terms.',
    }[access] || '';
}

async function paiKeyDialog(provider) {
    const dlg = document.createElement('dialog');
    dlg.className = 'pai-dialog';
    const state = paiKeyState(provider);
    dlg.innerHTML = '<form method="dialog" class="pai-form"><h3>Key for ' + esc(provider.display_name || provider.key) + '</h3>'
        + '<p class="muted">' + state.text + '</p>'
        + '<div id="pai-key-field"></div>'
        + '<div class="pai-dialog-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-act="save">Save key</button></div></form>';
    const field = document.createElement('div');
    field.className = 'ov-field';
    const label = document.createElement('label');
    label.htmlFor = 'pai-key-value';
    label.textContent = 'Provider key (write-only)';
    const input = document.createElement('input');
    input.id = 'pai-key-value';
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.required = true;
    const hint = document.createElement('p');
    hint.className = 'ov-field-hint';
    hint.textContent = 'Sent once, sealed by OpenVibe.AI; the box is cleared and removed right after saving.';
    field.append(label, input, hint);
    dlg.querySelector('#pai-key-field').append(field);
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="cancel"]')) { dlg.close(); dlg.remove(); } });
    dlg.addEventListener('close', () => { input.value = ''; dlg.remove(); });
    const form = dlg.querySelector('form');
    let saving = false;
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (saving) return;
        saving = true;
        const value = input.value;
        const save = form.querySelector('[data-act="save"]');
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
            await paiApi('/providers/' + encodeURIComponent(provider.key) + '/key', { method: 'PUT', body: { value, reason: 'Replaced from the admin panel' } });
            toast('Key sealed', 'success');
            dlg.close();
            await loadPlatformAi();
        } catch (err) {
            if (!err.freshRequired) toast(paiFriendly('ai', err), 'error');
            save.disabled = false;
            save.textContent = 'Save key';
        } finally {
            // Clear and remove the input even when the request failed: a secret must not stay in the page.
            input.value = '';
            input.remove();
            if (dlg.open) dlg.close();
            saving = false;
        }
    });
    dlg.showModal();
    if (window.OVForms && window.OVForms.enhance) window.OVForms.enhance(dlg);
}

async function paiRemoveKey(provider) {
    const ok = await paiConfirm('Remove the key?', [paiLabel('ai') + ' will stop calling ' + (provider.display_name || provider.key) + ' until a key is entered again.']);
    if (!ok) return;
    try {
        await paiApi('/providers/' + encodeURIComponent(provider.key) + '/key', { method: 'DELETE', body: { reason: 'Removed from the admin panel' } });
        toast('Key removed', 'success');
        await loadPlatformAi();
    } catch (err) {
        if (!err.freshRequired) toast(paiFriendly('ai', err), 'error');
    }
}

function paiRenderCards() {
    paiFillCards('exchange', PAI.namespaces.filter((n) => n.service === 'ai' && !n.namespace.endsWith('.provider_keys')), 'OpenVibe.AI has not published the ai.exchange namespace yet.', 'AI Exchange');
    paiFillCards('money', PAI.namespaces.filter((n) => n.service === 'billing'), 'OpenVibe.Billing has not published a settings namespace yet.', 'Money');
    paiFillCards('services', PAI.namespaces.filter((n) => n.service !== 'ai' && n.service !== 'billing' && !n.namespace.endsWith('.provider_keys')), 'No other service has published settings yet.', 'Services');
}

function paiFillCards(group, list, empty, sectionTitle) {
    const box = document.getElementById('pai-cards-' + group);
    if (!box) return;
    if (!list.length) { box.innerHTML = '<p class="muted">' + empty + '</p>'; return; }
    const groups = new Map();
    for (const n of list) {
        const name = (n.schema && n.schema['x-group']) || 'General';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(n);
    }
    // One group (or no x-group) needs no heading: the section's own title already says it.
    const showGroups = groups.size > 1;
    const single = list.length === 1;
    box.innerHTML = [...groups.entries()].map(([name, items]) => (showGroups ? '<h4 class="pai-group">' + esc(name) + '</h4>' : '') + items.map((n) => paiCard(n, { hideTitle: single && (n.schema && (n.schema.title || n.namespace)) === sectionTitle })).join('')).join('');
}

function paiCard(n, opts = {}) {
    const schema = n.schema || {};
    const props = schema.properties || {};
    const pins = Array.isArray(n.pins) ? n.pins : (n.pins && typeof n.pins === 'object' ? Object.keys(n.pins) : []);
    const pinEnv = n.pin_env || {};
    const fields = Object.entries(props).map(([key, prop]) => paiField(n, key, prop, pins.includes(key), pinEnv[key])).join('');
    const actor = n.active && n.active.activated_by && n.active.activated_by.id ? n.active.activated_by.id : (n.active && n.active.created_by && n.active.created_by.id ? n.active.created_by.id : null);
    const who = actor ? (currentUser && actor === currentUser.subject_id ? '@' + currentUser.username : actor) : '';
    const at = n.active && (n.active.activated_at || n.active.created_at);
    const revised = n.revision == null ? 'Not published' : 'Revision ' + esc(n.revision);
    const title = opts.hideTitle ? '' : '<h5>' + esc(schema.title || n.namespace) + '</h5>';
    const description = schema.description ? '<p class="muted">' + esc(schema.description) + '</p>' : '';
    const head = title || description ? '<header class="pai-card-head">' + title + description + '</header>' : '';
    return '<article class="pai-card" data-pai-card data-service="' + esc(n.service) + '" data-namespace="' + esc(n.namespace) + '">'
        + head
        + '<div class="pai-fields">' + fields + '</div>'
        + '<footer class="pai-card-foot"><span class="pai-revision">' + revised + (who ? ' · ' + esc(who) : '') + (at ? ' · ' + esc(paiWhen(at)) : '') + '</span>'
        + '<span class="pai-card-actions"><button type="button" class="btn btn-sm pai-quiet" data-act="history">History</button><button type="button" class="btn btn-sm btn-primary" data-act="save">Save</button></span></footer>'
        + '</article>';
}

function paiField(n, key, prop, pinned, pinName) {
    const value = n.values ? n.values[key] : undefined;
    const cls = (n.classification && n.classification[key]) || 'internal';
    const danger = !!prop['x-danger'];
    const title = prop.title || key;
    const description = prop.description || '';
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    const type = types.find((t) => t !== 'null') || 'string';
    const nullable = types.includes('null');
    const chips = (pinned ? '<span class="pai-chip-lock">🔒 Pinned</span>' : '') + (danger ? '<span class="pai-chip-danger">' + esc(/money|credit|spend|pay|price|usd/i.test(title + ' ' + description + ' ' + key) ? 'Money' : 'Danger') + '</span>' : '') + (cls === 'secret' ? '<span class="pai-chip-secret">Secret</span>' : '');
    const dis = pinned ? ' disabled' : '';
    let control;
    if (cls === 'secret') {
        const marker = paiMarker(value);
        control = '<div class="pai-secret"><span class="pai-marker">' + (marker ? 'Sealed ••••' + esc(marker.hint || '') : 'Not set') + '</span>'
            + (pinned ? '' : ' <button type="button" class="btn btn-sm pai-quiet" data-act="secret" data-key="' + esc(key) + '">' + (marker ? 'Replace key' : 'Set key') + '</button>')
            + (!pinned && marker ? ' <button type="button" class="btn btn-sm pai-quiet pai-quiet-danger" data-act="secret-remove" data-key="' + esc(key) + '">Remove</button>' : '') + '</div>';
    } else if (prop.enum && Array.isArray(prop.enum)) {
        control = '<select data-pai-control data-type="enum" data-key="' + esc(key) + '" aria-label="' + esc(title) + '"' + (pinned ? ' data-ov-native' : '') + dis + '>' + prop.enum.map((v) => '<option value="' + esc(v) + '"' + (String(value) === String(v) ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select>';
    } else if (type === 'boolean') {
        control = '<label class="pai-switch"><input type="checkbox" role="switch" data-ov-native data-pai-control data-type="boolean" data-key="' + esc(key) + '"' + (value ? ' checked' : '') + dis + '><span class="pai-track" aria-hidden="true"><span class="pai-knob"></span></span><span class="pai-switch-text">' + (value ? 'On' : 'Off') + '</span></label>';
    } else if (type === 'array') {
        const items = Array.isArray(value) ? value : [];
        control = '<div class="pai-chips" data-pai-chips>' + items.map((it) => paiChip(it, !pinned)).join('') + '</div>'
            + (pinned ? '' : '<span class="pai-list-add"><input data-pai-list-input placeholder="Add…" aria-label="Add to ' + esc(title) + '"><button type="button" class="btn btn-sm pai-quiet" data-act="list-add">Add</button></span>');
    } else if (type === 'object') {
        control = '<textarea data-pai-control data-type="object" data-key="' + esc(key) + '" rows="3" spellcheck="false" aria-label="' + esc(title) + '"' + dis + '>' + esc(JSON.stringify(value == null ? {} : value, null, 2)) + '</textarea>';
    } else if (prop['x-unit'] === 'nano_usd') {
        control = '<span class="pai-money-input"><span class="pai-prefix">$</span><input data-pai-control data-type="nano_usd" data-key="' + esc(key) + '" inputmode="decimal" value="' + esc(paiUsd(value)) + '" aria-label="' + esc(title) + '"' + dis + '></span>';
    } else if (type === 'integer') {
        const unit = paiUnitLabel(prop['x-unit']);
        const input = '<input data-pai-control data-type="integer" data-key="' + esc(key) + '"' + (nullable ? ' data-nullable="1"' : '') + ' type="number" step="1" value="' + esc(value == null ? '' : value) + '" aria-label="' + esc(title) + '"' + dis + '>';
        control = unit ? '<span class="pai-unit-input">' + input + '<span class="pai-unit">' + esc(unit) + '</span></span>' : input;
    } else if (type === 'number') {
        control = '<input data-pai-control data-type="number" data-key="' + esc(key) + '"' + (nullable ? ' data-nullable="1"' : '') + ' type="number" step="any" value="' + esc(value == null ? '' : value) + '" aria-label="' + esc(title) + '"' + dis + '>';
    } else {
        control = '<input data-pai-control data-type="string" data-key="' + esc(key) + '"' + (nullable ? ' data-nullable="1"' : '') + ' value="' + esc(value == null ? '' : value) + '" aria-label="' + esc(title) + '"' + dis + '>';
    }
    const pinLine = pinned ? '<p class="pai-pin-line">Pinned by ' + esc(pinName || (prop['x-env'] || 'the environment')) + ' in the env file</p>' : '';
    return '<div class="pai-field" data-pai-field data-key="' + esc(key) + '" data-secret="' + (cls === 'secret' ? '1' : '0') + '" data-pinned="' + (pinned ? '1' : '0') + '">'
        + '<div class="pai-field-label"><label>' + esc(title) + ' <code>' + esc(key) + '</code></label>' + chips + '</div>'
        + (description ? '<p class="pai-field-desc muted">' + esc(description) + '</p>' : '')
        + '<div class="pai-control">' + control + pinLine + '</div></div>';
}

function paiChip(value, removable = true) {
    const label = typeof value === 'string' ? value : JSON.stringify(value);
    return '<span class="pai-chip" data-value="' + esc(JSON.stringify(value)) + '"><span>' + esc(label) + '</span>' + (removable ? '<button type="button" data-act="list-remove" aria-label="Remove ' + esc(label) + '">×</button>' : '') + '</span>';
}

async function paiCardClick(ev) {
    const button = ev.target.closest('button[data-act]');
    if (!button) return;
    const card = button.closest('[data-pai-card]');
    if (!card) return;
    const n = PAI.namespaces.find((x) => x.service === card.dataset.service && x.namespace === card.dataset.namespace);
    if (!n) return;
    const act = button.dataset.act;
    if (act === 'save') return await paiSaveCard(card, n);
    if (act === 'history') return await paiHistoryDialog(n);
    if (act === 'secret') return paiSecretDialog(n, button.dataset.key);
    if (act === 'secret-remove') return paiRemoveSecret(n, button.dataset.key);
    if (act === 'list-add') {
        const field = button.closest('[data-pai-field]');
        const input = field.querySelector('[data-pai-list-input]');
        const text = String(input.value || '').trim();
        if (!text) return;
        const chips = field.querySelector('[data-pai-chips]');
        chips.insertAdjacentHTML('beforeend', paiChip(text));
        input.value = '';
        return;
    }
    if (act === 'list-remove') {
        const chip = button.closest('.pai-chip');
        if (chip) chip.remove();
    }
}

function paiCollect(card) {
    const values = {};
    for (const field of card.querySelectorAll('[data-pai-field]')) {
        if (field.dataset.pinned === '1' || field.dataset.secret === '1') continue;
        const control = field.querySelector('[data-pai-control]');
        if (!control) continue;
        const key = field.dataset.key;
        if (!key) continue;
        if (control.dataset.type === 'boolean') values[key] = control.checked;
        else if (control.dataset.nullable === '1' && control.value === '') values[key] = null;
        else if (control.dataset.type === 'nano_usd') {
            const parsed = paiParseUsd(control.value);
            if (parsed.error) return { error: control.dataset.key + ': ' + parsed.error };
            values[key] = parsed.nano;
        } else if (control.dataset.type === 'integer') {
            const number = Number(control.value);
            if (!Number.isInteger(number)) return { error: key + ': enter a whole number' };
            values[key] = number;
        } else if (control.dataset.type === 'number') {
            const number = Number(control.value);
            if (!Number.isFinite(number)) return { error: key + ': enter a number' };
            values[key] = number;
        } else if (control.dataset.type === 'enum' || control.dataset.type === 'string') values[key] = control.value;
        else if (control.dataset.type === 'object') {
            try { values[key] = JSON.parse(control.value); } catch { return { error: key + ': the JSON is not valid' }; }
        }
    }
    for (const field of card.querySelectorAll('[data-pai-field]')) {
        if (field.querySelector('[data-pai-chips]')) {
            values[field.dataset.key] = [...field.querySelectorAll('.pai-chip')].map((chip) => JSON.parse(chip.dataset.value));
        }
    }
    return { values };
}

async function paiSaveCard(card, n) {
    const collected = paiCollect(card);
    if (collected.error) return toast(collected.error, 'error');
    const changed = {};
    for (const [key, value] of Object.entries(collected.values)) {
        if (JSON.stringify(value) !== JSON.stringify(n.values ? n.values[key] : undefined)) changed[key] = value;
    }
    if (!Object.keys(changed).length) return toast('Nothing to save', 'info');
    const props = (n.schema && n.schema.properties) || {};
    const danger = Object.keys(changed).filter((key) => props[key] && props[key]['x-danger']);
    if (danger.length) {
        const lines = danger.map((key) => (props[key].title || key) + ': ' + (props[key].description || 'This change takes effect at once.') + ' Now: ' + (changed[key] ? 'on' : 'off') + '.');
        const ok = await paiConfirm('Save this money setting?', lines);
        if (!ok) return;
    }
    const save = card.querySelector('[data-act="save"]');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
        await paiApi('/' + encodeURIComponent(n.service) + '/' + encodeURIComponent(n.namespace), { method: 'POST', body: { values: changed, reason: 'Changed in the admin panel', merge: true } });
        toast('Saved', 'success');
        await loadPlatformAi();
    } catch (err) {
        if (!err.freshRequired) toast(paiFriendly(n.service, err), 'error');
    } finally {
        save.disabled = false;
        save.textContent = 'Save';
    }
}

function paiSecretDialog(n, key) {
    const dlg = document.createElement('dialog');
    dlg.className = 'pai-dialog';
    dlg.innerHTML = '<form method="dialog" class="pai-form"><h3>' + esc(key) + '</h3><p class="muted">The value is written once, sealed by ' + esc(paiLabel(n.service)) + '; it is never shown again.</p>'
        + '<div id="pai-secret-field"></div><div class="pai-dialog-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-act="save">Save key</button></div></form>';
    const field = document.createElement('div');
    field.className = 'ov-field';
    const label = document.createElement('label');
    label.htmlFor = 'pai-secret-value';
    label.textContent = 'New value (write-only)';
    const input = document.createElement('input');
    input.id = 'pai-secret-value';
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.required = true;
    const hint = document.createElement('p');
    hint.className = 'ov-field-hint';
    hint.textContent = 'Cleared and removed from the page right after saving.';
    field.append(label, input, hint);
    dlg.querySelector('#pai-secret-field').append(field);
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="cancel"]')) { dlg.close(); dlg.remove(); } });
    dlg.addEventListener('close', () => { input.value = ''; dlg.remove(); });
    const form = dlg.querySelector('form');
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const save = form.querySelector('[data-act="save"]');
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
            await paiApi('/' + encodeURIComponent(n.service) + '/' + encodeURIComponent(n.namespace) + '/secrets/' + encodeURIComponent(key), { method: 'PUT', body: { value: input.value, reason: 'Changed in the admin panel' } });
            toast('Key saved', 'success');
            dlg.close();
            await loadPlatformAi();
        } catch (err) {
            if (!err.freshRequired) toast(paiFriendly(n.service, err), 'error');
            save.disabled = false;
            save.textContent = 'Save key';
        } finally {
            input.value = '';
            input.remove();
            if (dlg.open) dlg.close();
        }
    });
    dlg.showModal();
    if (window.OVForms && window.OVForms.enhance) window.OVForms.enhance(dlg);
}

async function paiRemoveSecret(n, key) {
    const ok = await paiConfirm('Remove ' + key + '?', [paiLabel(n.service) + ' will not have this value until it is entered again.']);
    if (!ok) return;
    try {
        await paiApi('/' + encodeURIComponent(n.service) + '/' + encodeURIComponent(n.namespace) + '/secrets/' + encodeURIComponent(key), { method: 'DELETE', body: { reason: 'Removed from the admin panel' } });
        toast('Key removed', 'success');
        await loadPlatformAi();
    } catch (err) {
        if (!err.freshRequired) toast(paiFriendly(n.service, err), 'error');
    }
}

async function paiHistoryDialog(n) {
    let data;
    try {
        data = await paiApi('/' + encodeURIComponent(n.service) + '/' + encodeURIComponent(n.namespace) + '/history?limit=50');
    } catch (err) {
        return toast(paiFriendly(n.service, err), 'error');
    }
    const snapshots = (data && data.snapshots) || [];
    const dlg = document.createElement('dialog');
    dlg.className = 'pai-dialog pai-dialog-wide';
    const rows = snapshots.map((s) => {
        const actor = s.activated_by && s.activated_by.id ? s.activated_by.id : (s.created_by && s.created_by.id ? s.created_by.id : '');
        const current = s.state === 'active' || s.revision === n.revision;
        return '<tr><td>' + esc(s.revision) + '</td><td>' + esc(paiWhen(s.activated_at || s.created_at)) + '</td><td>' + esc(actor || '—') + '</td><td>' + esc(s.reason || '—') + '</td><td>' + (current ? '<span class="muted">Current</span>' : '<button type="button" class="btn btn-sm" data-rollback="' + esc(s.revision) + '">Roll back</button>') + '</td></tr>';
    }).join('');
    dlg.innerHTML = '<div class="pai-form"><h3>History · ' + esc(n.namespace) + '</h3>'
        + (snapshots.length ? '<div class="pai-table-wrap"><table class="pai-table"><thead><tr><th>Revision</th><th>When</th><th>By</th><th>Reason</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="muted">No revisions yet.</p>')
        + '<div class="pai-dialog-actions"><button type="button" class="btn" data-act="close">Close</button></div></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', async (ev) => {
        if (ev.target.closest('[data-act="close"]')) { dlg.close(); return; }
        const rollback = ev.target.closest('[data-rollback]');
        if (!rollback) return;
        const to = Number(rollback.dataset.rollback);
        const ok = await paiConfirm('Roll back to revision ' + to + '?', ['The namespace returns to that revision. Nothing is deleted; the rollback is recorded as a new revision.']);
        if (!ok) return;
        rollback.disabled = true;
        try {
            await paiApi('/' + encodeURIComponent(n.service) + '/' + encodeURIComponent(n.namespace) + '/rollback', { method: 'POST', body: { to, reason: 'Rolled back from the admin panel' } });
            dlg.close();
            toast('Rolled back', 'success');
            await loadPlatformAi();
        } catch (err) {
            rollback.disabled = false;
            if (!err.freshRequired) toast(paiFriendly(n.service, err), 'error');
        }
    });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
}

function paiConfirm(title, lines) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.className = 'pai-dialog';
        dlg.innerHTML = '<div class="pai-form"><h3>' + esc(title) + '</h3>' + (lines || []).map((line) => '<p class="pai-confirm-line">' + esc(line) + '</p>').join('')
            + '<div class="pai-dialog-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="button" class="btn btn-primary" data-act="confirm">Confirm</button></div></div>';
        let answer = false;
        document.body.appendChild(dlg);
        dlg.addEventListener('click', (ev) => {
            if (ev.target.closest('[data-act="cancel"]')) { answer = false; dlg.close(); }
            if (ev.target.closest('[data-act="confirm"]')) { answer = true; dlg.close(); }
        });
        dlg.addEventListener('close', () => { dlg.remove(); resolve(answer); });
        dlg.showModal();
    });
}

function paiRenderVault() {
    const box = document.getElementById('pai-vault-list');
    if (!box) return;
    const rows = PAI.services.map((s) => {
        const state = PAI.serviceState[s.service] || { answered: false, sealed: null, kek: null };
        const name = esc(s.name || paiLabel(s.service));
        let status;
        let hint = '';
        if (state.answered && state.sealed === true) {
            status = '<span class="pai-state is-ok">Sealed' + (state.kek ? ' · ' + esc(state.kek) : '') + '</span>';
        } else if (state.answered && state.sealed === false) {
            status = '<span class="pai-state is-bad">Not sealed</span>';
            hint = '<div class="pai-hint">the service needs openvibe-shared 4.110 or later and OV_CONFIG_KEKS</div>';
        } else if (state.answered) {
            status = '<span class="pai-state is-muted">No settings yet</span>';
        } else {
            status = '<span class="pai-state is-muted">Did not answer</span>';
        }
        return '<div class="pai-vault-row"><span class="pai-vault-name">' + name + '</span>' + status + hint + '</div>';
    });
    box.innerHTML = paiFold(rows, (row) => row);
}
