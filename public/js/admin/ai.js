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

// Live's AI settings in plain words; the machine key is shown small and grey after each title, never instead of it.
const AI_KEY_TITLES = {
    ai_enabled: 'AI on OpenVibe.Live',
    ai_paste_analysis_enabled: 'Describe new pastes',
    ai_stream_memory_enabled: 'Remember what happens on streams',
    ai_stream_capture_interval_sec: 'Seconds between stream snapshots',
    ai_transcription_enabled: 'Write down what streamers say',
    ai_timeline_enabled: 'Build a timeline of each stream',
    ai_max_cost_usd_per_day: 'Most Live may spend on AI in a day (dollars)',
    ai_viewers_enabled: 'AI chat viewers',
    ai_viewers_max_roster: 'Most AI viewers in one channel',
    ai_viewers_max_lines_per_min: 'Most AI viewer messages a minute',
    ai_viewers_global_cap_usd_per_day: 'Most AI viewers may spend in a day on OpenVibe\'s key (dollars)',
    ai_viewers_default_settings_json: 'AI viewers\' starting settings (advanced)',
};
const aiKeyTitle = (key) => AI_KEY_TITLES[key] || (typeof paiHumanize === 'function' ? paiHumanize(key) : key);

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
                    <label><strong>${esc(aiKeyTitle(key))}</strong> <code class="pai-mkey">${esc(key)}</code> <span style="color:var(--muted);font-size:11px;font-weight:600">🔒 Owner only</span><br><small>${esc(s.description||'')}</small></label>
                    <input type="text" value="${esc(s.value)}" disabled data-redacted="1"
                        style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:13px;opacity:0.65"></div>`;
            if (s.type === 'boolean') return `
                <div class="setting-row"><label><strong>${esc(aiKeyTitle(key))}</strong> <code class="pai-mkey">${esc(key)}</code><br><small>${esc(s.description||'')}</small></label>
                <input type="checkbox" data-key="${esc(key)}" data-type="boolean" ${s.value==='true'?'checked':''} style="width:18px;height:18px;cursor:pointer"></div>`;
            if (s.type === 'json' || /_json$/.test(key)) return `<div class="setting-row" style="flex-direction:column;align-items:stretch">
                <label><strong>${esc(aiKeyTitle(key))}</strong> <code class="pai-mkey">${esc(key)}</code><br><small>${esc(s.description||'')}</small></label>
                <textarea data-key="${esc(key)}" data-type="json" rows="4" spellcheck="false" style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;font-family:ui-monospace,monospace">${esc((() => { try { return JSON.stringify(JSON.parse(s.value), null, 2); } catch { return s.value; } })())}</textarea></div>`;
            const type = s.type === 'number' ? 'number' : (sensitive ? 'password' : 'text');
            return `<div class="setting-row" style="flex-direction:column;align-items:stretch">
                <label><strong>${esc(aiKeyTitle(key))}</strong> <code class="pai-mkey">${esc(key)}</code><br><small>${esc(s.description||'')}</small></label>
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
                <p class="muted" style="margin-bottom:12px">What OpenVibe.Live does with AI: describing pastes, remembering streams and the AI chat viewers. Every request goes through OpenVibe.AI, which holds the provider keys, models and prices (its console is at ai.openvibe.services/console). Nothing runs until <strong>${esc(aiKeyTitle('ai_enabled'))}</strong> is on, and <strong>${esc(aiKeyTitle('ai_max_cost_usd_per_day'))}</strong> caps Live's spending.</p>
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
                <fieldset id="rundown-pictures-admin" style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:16px">
                    <legend style="padding:0 8px;font-weight:700">The Rundown's episode pictures</legend>
                    <div id="rundown-pictures-body"><span class="muted">Loading…</span></div>
                </fieldset>
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
        loadRundownPictures();
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

// ── The Rundown's episode pictures (Live, owner only) ─────────
// One AI illustration per episode, from the episode's own words; the stream thumbnail is the fallback. The settings,
// the month's spend and "Remake" are Live's /api/admin/rundown, reached through the admin proxy.
async function loadRundownPictures() {
    const el = document.getElementById('rundown-pictures-body'); if (!el) return;
    if (!currentUser || !currentUser.is_owner) { el.innerHTML = '<p class="muted" style="margin:0"><i class="fa-solid fa-lock"></i> Owner only: these settings decide where the picture money goes.</p>'; return; }
    try {
        const d = await api('/api/admin/streamer/rundown');
        const s = d.settings || {}, money = (n) => '$' + (Number(n || 0)).toFixed(2);
        const cap = s.monthly_cap_usd == null ? 'no cap' : money(s.monthly_cap_usd);
        const spend = d.spend || {};
        const badge = { done: 'Made', pending: 'Queued', working: 'Making', refused: 'Refused', failed: 'Failed' };
        const rows = (d.pictures || []).slice(0, 12).map((p) => `<tr>
            <td style="padding:4px 6px">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" style="width:64px;height:34px;object-fit:cover;border-radius:4px">` : '<span class="muted">—</span>'}</td>
            <td style="padding:4px 6px">${esc(p.title || ('stream ' + p.stream_id))}<br><small class="muted">${esc(p.username ? '@' + p.username : '')} · ${esc(p.model || '')} ${p.size ? '· ' + esc(p.size) : ''}</small></td>
            <td style="padding:4px 6px;white-space:nowrap">${esc(badge[p.status] || p.status)}${p.cost_usd ? `<br><small class="muted">${money(p.cost_usd)}</small>` : ''}</td>
            <td style="padding:4px 6px;max-width:280px"><small class="muted">${esc(p.error || '')}</small></td>
            <td style="padding:4px 6px;white-space:nowrap"><button type="button" class="btn btn-sm" onclick="remakeRundownPicture(${Number(p.stream_id)})">Remake</button></td>
        </tr>`).join('');
        el.innerHTML = `
            <p class="muted" style="margin:0 0 10px">Every Rundown episode gets one editorial illustration made from its title, topics, takes and recap, stored in Media at 1200×630. Explicit words (sex acts, or anything involving a minor) are refused before a prompt leaves Live; the stream thumbnail stays the fallback. This month: <b>${money(spend.usd || 0)}</b> of ${esc(cap)} · ${Number(spend.pictures || 0)} picture${Number(spend.pictures || 0) === 1 ? '' : 's'} · ${Number((d.counts || {}).pending || 0)} queued, ${Number((d.counts || {}).refused || 0)} refused.</p>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:10px">
                <label class="muted" style="font-size:12px"><input id="rp-enabled" type="checkbox" ${s.enabled ? 'checked' : ''} style="width:16px;height:16px;vertical-align:-3px"> On</label>
                <label class="muted" style="font-size:12px">Model<br><input id="rp-model" value="${esc(s.model || '')}" spellcheck="false" style="width:100%;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)"></label>
                <label class="muted" style="font-size:12px">Size<br><input id="rp-size" value="${esc(s.size || '')}" spellcheck="false" style="width:100%;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)"></label>
                <label class="muted" style="font-size:12px">Monthly cap (USD)<br><input id="rp-cap" type="number" min="0" max="1000" step="0.01" value="${s.monthly_cap_usd == null ? '' : esc(s.monthly_cap_usd)}" style="width:100%;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)"></label>
                <label class="muted" style="font-size:12px;grid-column:1/-1">Style line<br><input id="rp-style" value="${esc(s.style || '')}" style="width:100%;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)"></label>
            </div>
            <button type="button" class="btn btn-primary" onclick="saveRundownPictures()"><i class="fa-solid fa-floppy-disk"></i> Save picture settings</button>
            ${rows ? `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:12px"><thead><tr><th style="text-align:left">Picture</th><th style="text-align:left">Episode</th><th style="text-align:left">State</th><th style="text-align:left">Why</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted" style="margin:10px 0 0">No episode pictures yet.</p>'}`;
    } catch (e) {
        el.innerHTML = `<p class="muted" style="margin:0">${e && e.status === 403 ? 'Owner only.' : 'Live did not answer: ' + esc(e.message)}</p>`;
    }
}

async function saveRundownPictures() {
    const settings = {
        enabled: document.getElementById('rp-enabled').checked,
        model: document.getElementById('rp-model').value.trim(),
        size: document.getElementById('rp-size').value.trim(),
        style: document.getElementById('rp-style').value.trim(),
        monthly_cap_usd: document.getElementById('rp-cap').value === '' ? null : Number(document.getElementById('rp-cap').value),
    };
    try {
        const d = await api('/api/admin/streamer/rundown/settings', { method: 'PUT', body: { settings } });
        toast(`Picture settings saved (${Number((d && d.pictures || []).length)} recent)`, 'success');
        loadRundownPictures();
    } catch (e) { toast(e.message, 'error'); }
}

async function remakeRundownPicture(streamId) {
    try {
        const d = await api('/api/admin/streamer/rundown/episodes/' + Number(streamId) + '/remake', { method: 'POST', body: {} });
        toast(d.message || 'Picture queued', 'success');
        loadRundownPictures();
    } catch (e) { toast(e.message, 'error'); }
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
                <span class="muted" style="font-size:12px">The switch that silences them all is ${esc(aiKeyTitle('ai_viewers_enabled'))} in Configuration below.</span>
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
    if (el) el.innerHTML = '<div class="muted" style="margin-top:10px"><span class="ov-mark" data-state="busy" data-size="16" data-tone="ink" aria-hidden="true"></span> Validating and running a live extraction…</div>';
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
    if (el) el.innerHTML = '<div class="muted" style="margin-top:10px"><span class="ov-mark" data-state="busy" data-size="16" data-tone="ink" aria-hidden="true"></span> Validating and running a live extraction…</div>';
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
    results.innerHTML = '<p class="muted"><span class="ov-mark" data-state="busy" data-size="16" data-tone="ink" aria-hidden="true"></span> Testing live OpenVibe.Live extraction…</p>';
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
// The words are the clear admin panel's (OWNER-SETUP-AND-ADMIN-CLARITY-DESIGN, 2026-11-07, section 3): a title in
// plain words with the machine key small and grey after it, every choice in words, Advanced settings in a counted
// fold, status as a sentence. glossaryLink() (admin/glossary.js) is optional here, so the file also loads alone.
// ═══════════════════════════════════════════════════════════════
const PAI_NAMES = {
    network: 'OpenVibe.Network', ai: 'OpenVibe.AI', billing: 'OpenVibe.Billing', services: 'OpenVibe.Services', watch: 'OpenVibe.Watch',
    bench: 'OpenVibe.Bench', report: 'OpenVibe.Report', host: 'OpenVibe.Host', codes: 'OpenVibe.Codes',
    actor: 'OpenVibe.Actor', chat: 'OpenVibe.Chat', connect: 'OpenVibe Connect', deals: 'OpenVibe.Deals', work: 'OpenVibe.Work',
    sources: 'OpenVibe.Sources', design: 'OpenVibe.Design', domains: 'OpenVibe.Domains', media: 'OpenVibe.Media', run: 'OpenVibe.Run',
};
// The services whose settings are AI settings: their cards are on this tab. Every other service's owner inputs are
// on the Setup tab; the "Where keys are kept" list covers them all.
const PAI_AI_SERVICES = ['ai', 'billing', 'services', 'watch', 'bench', 'report', 'host', 'codes', 'actor', 'run'];
const PAI_ACCESS = ['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED'];
const PAI_BILLING_LABEL = {
    metered: 'Spends Credits per request', subscription: 'A plan with a monthly fee shared by everyone',
    payg: 'A prepaid balance at the provider', free: 'Free', byok: 'The person\'s own key pays',
};
const PAI_ACCESS_LABEL = {
    OWN_DEPLOYMENT: 'Runs on our own machine: no provider terms', AUTHORIZED_WHOLESALE: 'Our agreement allows reselling it',
    CUSTOMER_BYOK: 'Only with the person\'s own key', RESTRICTED: 'Do not sell: their terms forbid it',
    UNVERIFIED: 'Not checked yet: treated as Do not sell',
};
// An integer's x-unit, as the owner form labels it. A unit this page does not know is left off so the
// input is a plain number: the page then works with a newer openvibe-shared before its pin moves.
const PAI_UNIT_LABEL = { ms: 'ms', seconds: 's', bps: 'bps' };
const PAI_UNIT_WORDS = { ms: 'milliseconds', seconds: 'seconds', bps: 'bits per second' };
const PAI = {
    providers: [], services: [], namespaces: [], warnings: [], vault: {}, serviceState: {}, loading: false, addProviderError: null,
};

function paiUnitLabel(unit) {
    return Object.prototype.hasOwnProperty.call(PAI_UNIT_LABEL, unit) ? PAI_UNIT_LABEL[unit] : '';
}

function paiLabel(service) {
    return PAI_NAMES[service] || ('OpenVibe.' + String(service || '').replace(/^./, (c) => c.toUpperCase()));
}

/** A machine key in words when a schema gives no title: "min_samples" → "Min samples", "vast.key" → "Vast key". */
function paiHumanize(key) {
    const words = String(key || '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[._\-\s]+/).filter(Boolean).join(' ').toLowerCase();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(key || '');
}

/** "What does this mean?" when the glossary is on the page (admin/glossary.js), nothing otherwise. */
function paiWhat(id, label) {
    return typeof glossaryLink === 'function' ? glossaryLink(id, label) : '';
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
    const link = el.querySelector('a.btn');
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

function paiFold(items, render) {
    const head = items.slice(0, 8).map(render).join('');
    if (items.length <= 8) return '<div class="pai-rows">' + head + '</div>';
    return '<div class="pai-rows">' + head + '</div><details class="pai-more"><summary>More (' + (items.length - 8) + ')</summary><div class="pai-rows">' + items.slice(8).map(render).join('') + '</div></details>';
}

/**
 * Whether a key is a secret: the summary's classification (every schema property from openvibe-shared 4.125.0), or,
 * for an unset key of an older service, a bound or writeOnly key, or a key/token/secret/password name.
 */
function paiIsSecret(n, key, prop) {
    const cls = n.classification ? n.classification[key] : undefined;
    if (cls) return cls === 'secret';
    return !!(prop && (typeof prop['x-bind'] === 'string' || prop.writeOnly === true)) || /(^|[._-])(api_?key|key|token|secret|password)$/i.test(key);
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
                // Not a warning: a service that has not mounted its settings routes yet is said in plain words below.
                PAI.vault[answer.service] = { sealed: null, kek: null };
                PAI.serviceState[answer.service] = { answered: false, sealed: null, kek: null };
                continue;
            }
            PAI.namespaces.push(...(answer.namespaces || []));
            PAI.warnings.push(...(answer.warnings || []));
            PAI.vault[answer.service] = answer.vault || { sealed: null, kek: null };
            PAI.serviceState[answer.service] = { answered: true, published: (answer.namespaces || []).length, sealed: answer.vault ? answer.vault.sealed : null, kek: answer.vault ? answer.vault.kek : null };
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
        + '<p class="muted">Everything about OpenVibe\'s AI in one place: the providers and their keys, what the Exchange offers, the money switches and other services\' AI settings. Keys are locked and write-only, and a key or money change asks you to confirm it\'s you.</p></div>'
        + '<div id="pai-fresh" class="pai-fresh" hidden><i class="fa-solid fa-lock" aria-hidden="true"></i> <span>Confirm it\'s you to change keys and money settings.</span> <a class="btn btn-primary" href="/login?reauth=1&return=%2Fadmin%23ai">Sign in again</a> ' + paiWhat('fresh-sign-in') + '</div>'
        + inner;
}

// A namespace made only of owner inputs for something other than AI (publishing tokens, sign-in apps, data sources,
// chat apps…) is the Setup tab's, not this one's: Codes' publishing tokens read as "AI settings" here (2026-11-07).
const PAI_NOT_AI_GROUPS = new Set(['chat-apps', 'sign-in-apps', 'data-sources', 'design-publishing', 'domains', 'legal', 'voices']);
function paiSetupOnly(n) {
    const props = n && n.schema && n.schema.properties ? Object.values(n.schema.properties) : [];
    return props.length > 0 && props.every((p) => p && p['x-owner-input'] && PAI_NOT_AI_GROUPS.has(p['x-owner-input'].group));
}
const paiAiNamespaces = () => PAI.namespaces.filter((n) => PAI_AI_SERVICES.includes(n.service) && !n.namespace.endsWith('.provider_keys') && !paiSetupOnly(n));

function paiRender(root) {
    const all = paiAiNamespaces();
    const exchange = all.filter((n) => n.service === 'ai');
    const money = all.filter((n) => n.service === 'billing');
    const rest = all.filter((n) => n.service !== 'ai' && n.service !== 'billing');
    const count = (n) => n ? ' <span class="pai-count">' + n + '</span>' : '';
    root.innerHTML = paiShell(
        '<nav class="pai-index" aria-label="Platform AI sections">'
        + '<a href="#pai-providers">AI providers' + count(PAI.providers.length) + '</a>'
        + '<a href="#pai-inference">Who answers, and what it costs</a>'
        + '<a href="#pai-exchange">What the Exchange offers' + count(exchange.length) + '</a>'
        + '<a href="#pai-money">Money' + count(money.length) + '</a>'
        + '<a href="#pai-services">Other services\' AI settings' + count(rest.length) + '</a>'
        + '<a href="#pai-vault">Where keys are kept' + count(PAI.services.length) + '</a>'
        + '</nav>'
        + '<div id="pai-warnings"></div>'
        + '<section id="pai-providers" class="pai-section"><div class="pai-section-head"><h3>AI providers</h3><p class="muted">The companies whose models OpenVibe can use, and the key for each. Add one to make its models available; a provider with no working key is skipped.</p>'
        + '<p class="pai-words muted">Words used here: ' + [paiWhat('resale', 'reselling'), paiWhat('byok', 'the person\'s own key'), paiWhat('health', 'paused'), paiWhat('credits', 'Credits')].filter(Boolean).join(' · ') + '</p></div>'
        + '<div class="pai-toolbar"><button type="button" class="btn btn-primary" id="pai-add-provider"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add provider</button></div>'
        + '<div id="pai-providers-list"></div></section>'
        + '<section id="pai-inference" class="pai-section"><div class="pai-section-head"><h3>Who answers, and what it costs</h3><p class="muted">For each kind of work: which provider answers first, the most it may cost, the providers never to use and the ways of paying less; then a spending limit for each provider and what it all cost. Changes apply to the next call.</p></div><div id="oin-body"><p class="muted">Loading…</p></div></section>'
        + '<section id="pai-exchange" class="pai-section"><div class="pai-section-head"><h3>What the Exchange offers</h3><p class="muted">Which models people can pick on openvibe.exchange, the free tier, and the spending limits that protect your balance.</p></div><div id="pai-cards-exchange" data-pai-cards></div></section>'
        + '<section id="pai-money" class="pai-section"><div class="pai-section-head"><h3>Money</h3><p class="muted">Credits are what people spend on AI; these switches decide whether people can buy them, top up and pay sellers. Each switch says what it turns on before you change it. ' + paiWhat('credits') + '</p></div><div id="pai-cards-money" data-pai-cards></div></section>'
        + '<section><h3>Worker compute budgets</h3><p><a href="https://openvibe.exchange/compute">Compute prices on Exchange</a></p><div id="pai-compute-status">Loading…</div></section>'
        + '<section id="pai-services" class="pai-section"><div class="pai-section-head"><h3>Other services\' AI settings</h3><p class="muted">AI settings that live in other parts of OpenVibe (Codes, Actor, Bench…), one card per service. Their other keys (publishing, sign-in apps, data sources) are on the <a href="/admin/setup">Setup</a> tab.</p></div><div id="pai-cards-services" data-pai-cards></div></section>'
        + '<section id="pai-vault" class="pai-section"><div class="pai-section-head"><h3>Where keys are kept</h3><p class="muted">Every key you enter is locked with that service\'s own lock key and can never be read back, not even by you. A service without its lock key stores keys unlocked and says so here: fix that first. ' + paiWhat('lock-key') + '</p></div><div id="pai-vault-list"></div></section>'
    );
    paiRenderWarnings();
    paiRenderProviders();
    paiRenderCards();
    paiRenderVault();
    paiLoadCompute();
    if (typeof oinLoad === 'function') oinLoad();
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

async function paiLoadCompute() {
    const el = document.getElementById('pai-compute-status');
    if (!el) return;
    try {
        const { compute } = await paiApi('/compute/status');
        el.innerHTML = '<p>' + (compute.enabled ? 'Reconciler enabled' : 'Reconciler disabled') +
            (compute.dry_run ? ' · Dry run' : ' · Live') + '</p><ul>' + (compute.budgets || []).map(b =>
            '<li' + (b.near_cap ? ' role="alert"' : '') + '>' + esc(b.provider) + ': ' +
            esc((Number(b.committed_micros) / 1e6).toFixed(4)) + ' of ' + esc(b.cap) + ' ' + esc(b.currency) +
            ' committed' + (b.near_cap ? ' — at least 80% of the monthly cap' : '') + '</li>').join('') + '</ul>';
    } catch { el.textContent = 'Compute budgets are unavailable.'; }
}

function paiRenderWarnings() {
    const box = document.getElementById('pai-warnings');
    if (!box) return;
    if (!PAI.warnings.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="pai-warning"><strong>Some settings could not be shown.</strong> These services answered with something that is not a settings summary, so their cards are left out until they answer correctly.'
        + PAI.warnings.map((w) => '<div class="pai-warning-row">' + esc(paiLabel(w.service)) + (w.namespace ? ' · <code>' + esc(w.namespace) + '</code>' : '') + ' — ' + esc(w.reason === 'invalid-summary' ? 'not a settings summary' : (w.reason || 'not available')) + '</div>').join('')
        + '</div>';
}

/** Key: "Entered here, locked" / "From the server's settings file (NAME)" / "Not set". */
function paiKeyState(p) {
    const ref = String(p.secret_ref || '');
    const vault = ref.startsWith('vault:');
    const env = ref.startsWith('env:');
    const hint = p.key_hint || p.hint || p.secret_hint || '';
    const bound = p.bound_to || paiHost(p.base_url);
    const required = p.auth_mode !== 'none' && p.credentials !== 'not_required';
    if (!required) return { tone: 'muted', text: 'Key: not needed', required: false };
    if (vault && p.credentials !== 'missing') return { tone: 'ok', text: 'Key: Entered here, locked' + (hint ? ' · ••••' + esc(hint) : '') + ' · only sent to ' + esc(paiHost(bound)), required: true };
    if (env) return { tone: 'muted', text: 'Key: From the server\'s settings file (' + esc(ref.slice(4)) + ')', env: ref.slice(4), required: true };
    if (p.credentials === 'missing' || !ref) return { tone: 'bad', text: 'Key: Not set', required: true };
    return { tone: 'ok', text: 'Key: Entered here, locked · only sent to ' + esc(paiHost(bound)), required: true };
}

/** Health: "Working" / "Paused after N errors; tries again at HH:MM" / "Testing again" (AI's circuit, in words). */
function paiHealth(p) {
    const h = p && p.health;
    if (!h || !h.state) return null;
    if (h.state === 'closed') return { tone: 'ok', text: 'Health: Working' };
    if (h.state === 'half_open') return { tone: 'muted', text: 'Health: Testing again' };
    if (h.state === 'open') {
        const n = Number(h.consecutive_failures) || 0;
        const errors = n === 1 ? '1 error' : n + ' errors';
        let retry = h.retry_at ? Date.parse(h.retry_at) : NaN;
        const opened = typeof h.opened_at === 'number' ? h.opened_at : Date.parse(h.opened_at || '');
        // AI waits a minute after errors, and ten minutes when the provider's balance ran out.
        if (!Number.isFinite(retry) && Number.isFinite(opened)) retry = opened + (h.exhausted_at ? 10 * 60000 : 60000);
        const at = Number.isFinite(retry) ? new Date(retry).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
        return { tone: 'bad', text: 'Health: Paused after ' + errors + (h.exhausted_at ? ' (its balance ran out)' : '') + (at ? '; tries again at ' + at : '; it tries again shortly') };
    }
    return null;
}

function paiProviderRow(p) {
    const access = PAI_ACCESS.includes(String(p.provider_access || '').toUpperCase()) ? String(p.provider_access).toUpperCase() : 'UNVERIFIED';
    const billing = p.billing_profile === 'subscription' ? esc(PAI_BILLING_LABEL.subscription) + ' (' + esc(p.pool_key || p.key) + ')' : esc(PAI_BILLING_LABEL[p.billing_profile] || PAI_BILLING_LABEL.metered);
    const key = paiKeyState(p);
    const health = paiHealth(p);
    const sealed = String(p.secret_ref || '').startsWith('vault:') && p.credentials !== 'missing';
    const actions = '<button type="button" class="btn btn-sm pai-quiet" data-act="edit">Edit</button> '
        + (key.required && key.env ? '<button type="button" class="btn btn-sm pai-quiet" data-act="key" title="Enter the key here so it is locked by OpenVibe.AI instead of read from the server\'s settings file">Enter it here instead</button> ' : '')
        + (key.required && !key.env ? '<button type="button" class="btn btn-sm pai-quiet" data-act="key">' + (sealed ? 'Replace key' : 'Add key') + '</button> ' : '')
        + (key.required && sealed ? '<button type="button" class="btn btn-sm pai-quiet pai-quiet-danger" data-act="remove-key">Remove key</button>' : '');
    return '<div class="pai-provider" data-pai-provider="' + esc(p.key) + '">'
        + '<div class="pai-provider-main"><div class="pai-provider-name">' + esc(p.display_name || p.key) + ' <code class="pai-mkey">' + esc(p.key) + '</code></div>'
        + '<div class="pai-provider-meta"><code>' + esc(paiHost(p.base_url)) + '</code> <span class="pai-access is-' + access.toLowerCase() + '">' + esc(PAI_ACCESS_LABEL[access]) + '</span> <span class="pai-billing">' + billing + '</span></div>'
        + '<div class="pai-keystate is-' + key.tone + '">' + key.text + '</div>'
        + (health ? '<div class="pai-keystate is-' + health.tone + '">' + esc(health.text) + '</div>' : '') + '</div>'
        + '<div class="pai-provider-actions"><label class="pai-switch"><input type="checkbox" role="switch" data-pai-enabled data-ov-native ' + (p.status === 'active' ? 'checked' : '') + '><span class="pai-track" aria-hidden="true"><span class="pai-knob"></span></span><span class="pai-switch-text">' + (p.status === 'active' ? 'In use' : 'Not used') + '</span></label>' + actions + '</div></div>';
}

function paiRenderProviders() {
    const box = document.getElementById('pai-providers-list');
    if (!box) return;
    if (PAI.addProviderError) {
        box.innerHTML = '<p class="pai-error">' + esc(PAI.addProviderError) + '</p>';
        return;
    }
    if (!PAI.providers.length) {
        box.innerHTML = '<p class="muted">No providers yet. Add DeepSeek to start: press Add provider above.</p>';
        return;
    }
    const subscription = PAI.providers.filter((p) => p.billing_profile === 'subscription');
    const other = PAI.providers.filter((p) => p.billing_profile !== 'subscription');
    box.innerHTML = paiFold(other, paiProviderRow)
        + (subscription.length ? '<h4 class="pai-subhead">On a plan with a monthly fee (Claude, Codex, …)</h4>' + paiFold(subscription, paiProviderRow) : '');
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
        if (label) label.textContent = input.checked ? 'In use' : 'Not used';
        toast((provider.display_name || provider.key) + (input.checked ? ' is in use' : ' is no longer used'), 'success');
    } catch (err) {
        input.checked = !input.checked;
        const label = input.closest('.pai-switch').querySelector('.pai-switch-text');
        if (label) label.textContent = input.checked ? 'In use' : 'Not used';
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
        { value: 'openai', label: 'OpenAI-compatible', desc: 'Most providers: the chat API OpenAI made, with a key', state: 'ok' },
        { value: 'anthropic', label: 'Anthropic (Claude)', desc: 'Claude\'s own messages API', state: 'ok' },
        { value: 'http', label: 'Our own HTTP endpoint', desc: 'A custom address that speaks JSON', state: 'off' },
        { value: 'stub', label: 'Practice answers', desc: 'For testing only: canned answers, no provider', state: 'off' },
        { value: 'whisper', label: 'whisper.cpp (speech to text)', desc: 'Speech to text on our own machine', state: 'off' },
    ];
    const billingOptions = [
        { value: 'metered', label: PAI_BILLING_LABEL.metered, desc: 'Each request takes Credits from the person who asked', state: 'ok' },
        { value: 'subscription', label: PAI_BILLING_LABEL.subscription, desc: 'Name the plan below; requests share its allowance', state: 'ok' },
        { value: 'payg', label: PAI_BILLING_LABEL.payg, desc: 'You top it up on the provider\'s own site', state: 'off' },
        { value: 'free', label: PAI_BILLING_LABEL.free, desc: 'The provider charges nothing', state: 'off' },
        { value: 'byok', label: PAI_BILLING_LABEL.byok, desc: 'Each person enters their own key and pays the provider', state: 'new' },
    ];
    dlg.innerHTML = '<form method="dialog" class="pai-form">'
        + '<h3>' + (editing ? 'Edit provider' : 'Add provider') + '</h3>'
        + '<div class="ov-field"><label for="pai-p-key">Short name</label><input id="pai-p-key" name="key" required pattern="[a-z][a-z0-9_-]*([.][a-z0-9_-]+)*" ' + (editing ? 'readonly' : '') + ' value="' + esc(p.key || '') + '"><p class="ov-field-hint">Lowercase, with dots or dashes: deepseek, claude, codex. It cannot be renamed later.</p></div>'
        + '<div class="ov-field"><label for="pai-p-name">Name people see</label><input id="pai-p-name" name="display_name" value="' + esc(p.display_name || '') + '"></div>'
        + '<div class="ov-field"><label for="pai-p-kind">How OpenVibe talks to it</label><select id="pai-p-kind" name="kind">'
        + options(kindOptions, kind)
        + '</select></div>'
        + '<div class="ov-field"><label for="pai-p-url">Address (base URL)</label><input id="pai-p-url" name="base_url" type="url" placeholder="https://api.example.com" value="' + esc(p.base_url || '') + '"><p class="ov-field-hint">The key is only ever sent to this address. Changing it means entering the key again.</p></div>'
        + '<div class="ov-field"><label for="pai-p-access">May OpenVibe sell its use?</label><select id="pai-p-access" name="provider_access" data-ov-title="May OpenVibe sell its use?">'
        + PAI_ACCESS.map((a) => '<option value="' + a + '"' + (a === access ? ' selected' : '') + ' data-desc="' + esc(paiAccessDesc(a)) + '" data-state="' + (a === 'OWN_DEPLOYMENT' || a === 'AUTHORIZED_WHOLESALE' ? 'ok' : a === 'RESTRICTED' ? 'warn' : a === 'UNVERIFIED' ? 'off' : 'new') + '">' + esc(PAI_ACCESS_LABEL[a]) + '</option>').join('')
        + '</select><p class="ov-field-hint">Check the provider\'s terms. ' + paiWhat('resale') + '</p></div>'
        + '<div class="pai-form-row"><div class="ov-field"><label for="pai-p-billing">Who pays</label><select id="pai-p-billing" name="billing_profile">'
        + options(billingOptions, billing)
        + '</select></div><div class="ov-field"><label for="pai-p-pool">Shared plan name</label><input id="pai-p-pool" name="pool_key" placeholder="claude-max" value="' + esc(p.pool_key || '') + '"><p class="ov-field-hint">Only for a plan with a monthly fee; a name, never a key.</p></div></div>'
        + '<div class="pai-form-row"><div class="ov-field"><label for="pai-p-priority">Order</label><input id="pai-p-priority" name="priority" type="number" step="1" value="' + esc(p.priority == null ? 100 : p.priority) + '"><p class="ov-field-hint">A lower number is tried first.</p></div>'
        + '<div class="ov-field"><label for="pai-p-model">Model used when none is named</label><input id="pai-p-model" name="default_model" value="' + esc(p.default_model || '') + '"></div></div>'
        + '<div id="pai-p-key-field"></div>'
        + '<div class="pai-dialog-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-act="save">' + (editing ? 'Save' : 'Add provider') + '</button></div>'
        + '</form>';
    // The key field is built as a DOM node and is never part of an innerHTML string.
    const keyField = document.createElement('div');
    keyField.className = 'ov-field';
    const keyLabel = document.createElement('label');
    keyLabel.htmlFor = 'pai-p-value';
    keyLabel.textContent = editing ? 'Replace the API key (write-only)' : 'API key (write-only)';
    const keyInput = document.createElement('input');
    keyInput.id = 'pai-p-value';
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.spellcheck = false;
    keyInput.placeholder = editing ? 'Leave empty to keep the key' : 'Paste the provider\'s API key';
    const keyHint = document.createElement('p');
    keyHint.className = 'ov-field-hint';
    keyHint.textContent = 'Sent once and locked by OpenVibe.AI; it is never shown again.';
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
            const ok = await paiConfirm('Change the address?', ['Its locked key is only sent to the old address, so it stops working until you enter it again.', 'To undo it, put the old address back; the key works again.']);
            if (!ok) return;
        }
        const save = form.querySelector('[data-act="save"]');
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
            if (editing) await paiApi('/providers/' + encodeURIComponent(p.key), { method: 'PATCH', body });
            else await paiApi('/providers', { method: 'POST', body });
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
        OWN_DEPLOYMENT: 'A model on OpenVibe\'s own machine, so no provider\'s terms limit who may use it.',
        AUTHORIZED_WHOLESALE: 'An agreement with the provider lets OpenVibe sell its use; check that it covers this model.',
        CUSTOMER_BYOK: 'Only people who enter their own key for this provider can use it; they pay the provider.',
        RESTRICTED: 'The provider\'s terms forbid selling its use, so OpenVibe never does.',
        UNVERIFIED: 'Nobody has read the terms yet, so OpenVibe treats it as Do not sell until someone does.',
    }[access] || '';
}

async function paiKeyDialog(provider) {
    const dlg = document.createElement('dialog');
    dlg.className = 'pai-dialog';
    const state = paiKeyState(provider);
    dlg.innerHTML = '<form method="dialog" class="pai-form"><h3>API key for ' + esc(provider.display_name || provider.key) + '</h3>'
        + '<p class="muted">' + state.text + '</p>'
        + '<div id="pai-key-field"></div>'
        + '<div class="pai-dialog-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn btn-primary" data-act="save">Save key</button></div></form>';
    const field = document.createElement('div');
    field.className = 'ov-field';
    const label = document.createElement('label');
    label.htmlFor = 'pai-key-value';
    label.textContent = 'API key (write-only)';
    const input = document.createElement('input');
    input.id = 'pai-key-value';
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.required = true;
    const hint = document.createElement('p');
    hint.className = 'ov-field-hint';
    hint.textContent = 'Sent once and locked by OpenVibe.AI; the box is cleared and removed right after saving.';
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
            toast('Key locked', 'success');
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
    const ok = await paiConfirm('Remove the key?', [paiLabel('ai') + ' stops calling ' + (provider.display_name || provider.key) + ' until a key is entered again.', 'To undo it, enter the key again with Add key.']);
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
    const all = paiAiNamespaces();
    paiFillCards('exchange', all.filter((n) => n.service === 'ai'), 'OpenVibe.AI has not published what the Exchange offers yet.', 'What the Exchange offers');
    paiFillCards('money', all.filter((n) => n.service === 'billing'), 'OpenVibe.Billing has not published its money settings yet.', 'Money');
    paiFillCards('services', all.filter((n) => n.service !== 'ai' && n.service !== 'billing'), 'No other service has published AI settings yet.', 'Other services\' AI settings');
}

function paiFillCards(group, list, empty, sectionTitle) {
    const box = document.getElementById('pai-cards-' + group);
    if (!box) return;
    if (!list.length) { box.innerHTML = '<p class="muted">' + esc(empty) + '</p>'; return; }
    const groups = new Map();
    for (const n of list) {
        const name = (n.schema && n.schema['x-group']) || paiLabel(n.service);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(n);
    }
    // One group needs no heading: the section's own title already says it.
    const showGroups = groups.size > 1;
    const single = list.length === 1;
    box.innerHTML = [...groups.entries()].map(([name, items]) => (showGroups ? '<h4 class="pai-group">' + esc(name) + '</h4>' : '') + items.map((n) => paiCard(n, { hideTitle: single && (n.schema && n.schema.title) === sectionTitle })).join('')).join('');
}

/** A field folds under Advanced settings when its schema says x-advanced, or when it is raw JSON (an object with no
 * described properties): raw JSON is never in the main form. */
function paiAdvanced(prop) {
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    const type = types.find((t) => t !== 'null') || 'string';
    const raw = type === 'object' && !(prop.properties && typeof prop.properties === 'object' && Object.keys(prop.properties).length);
    return prop['x-advanced'] === true || raw;
}

/** Who saved a version, in words: you, a service by name, or another account (never a raw usr_ id). */
function paiWho(ref) {
    if (!ref || !ref.id) return '';
    if (currentUser && ref.id === currentUser.subject_id) return '@' + currentUser.username;
    if (ref.type === 'service' || ref.type === 'system') return paiLabel(ref.id);
    return 'another account';
}

function paiCard(n, opts = {}) {
    const schema = n.schema || {};
    const props = schema.properties || {};
    const pins = Array.isArray(n.pins) ? n.pins : (n.pins && typeof n.pins === 'object' ? Object.keys(n.pins) : []);
    const pinEnv = n.pin_env || {};
    const entries = Object.entries(props).filter(([, prop]) => prop && typeof prop === 'object');
    const main = entries.filter(([, prop]) => !paiAdvanced(prop));
    const advanced = entries.filter(([, prop]) => paiAdvanced(prop));
    const fieldOf = ([key, prop]) => paiField(n, key, prop, pins.includes(key), pinEnv[key]);
    const fields = main.map(fieldOf).join('');
    const fold = advanced.length
        ? '<details class="pai-advanced"><summary>Advanced settings (' + advanced.length + ')</summary><div class="pai-fields">' + advanced.map(fieldOf).join('') + '</div></details>'
        : '';
    const who = paiWho(n.active && (n.active.activated_by || n.active.created_by));
    const at = n.active && (n.active.activated_at || n.active.created_at);
    const revised = n.revision == null ? 'Never changed: these are the defaults' : 'Saved version ' + esc(n.revision);
    const title = opts.hideTitle ? '' : '<h5>' + esc(schema.title || paiHumanize(n.namespace.split('.').slice(1).join(' '))) + ' <code class="pai-mkey">' + esc(n.namespace) + '</code></h5>';
    const description = schema.description ? '<p class="muted">' + esc(schema.description) + '</p>' : '';
    const head = title || description ? '<header class="pai-card-head">' + title + description + '</header>' : '';
    return '<article class="pai-card" data-pai-card data-service="' + esc(n.service) + '" data-namespace="' + esc(n.namespace) + '">'
        + head
        + (fields ? '<div class="pai-fields">' + fields + '</div>' : '')
        + fold
        + '<footer class="pai-card-foot"><span class="pai-revision">' + revised + (who ? ' · by ' + esc(who) : '') + (at ? ' · ' + esc(paiWhen(at)) : '') + ' ' + paiWhat('version', 'What is a version?') + '</span>'
        + '<span class="pai-card-actions"><button type="button" class="btn btn-sm pai-quiet" data-act="history">History</button><button type="button" class="btn btn-sm btn-primary" data-act="save">Save</button></span></footer>'
        + '</article>';
}

/** One choice's options: the schema's x-enum-labels in words with their line, or the value in words when it has none. */
function paiOptions(prop, value) {
    const labels = prop['x-enum-labels'] && typeof prop['x-enum-labels'] === 'object' ? prop['x-enum-labels'] : {};
    return prop.enum.map((v) => {
        const k = typeof v === 'string' ? v : JSON.stringify(v);
        const l = labels[k] && typeof labels[k] === 'object' ? labels[k] : null;
        const text = l && l.label ? l.label : (v === null ? 'None' : paiHumanize(String(v)));
        return '<option value="' + esc(k) + '"' + (String(value) === k ? ' selected' : '') + (l && l.description ? ' data-desc="' + esc(l.description) + '"' : '') + '>' + esc(text) + '</option>';
    }).join('');
}

/** The input for one value. `path` is the key, or "parent.child" for a field of an object drawn as a form. */
function paiControl(path, prop, value, { pinned = false, title = '', nested = false } = {}) {
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    const type = types.find((t) => t !== 'null') || 'string';
    const nullable = types.includes('null');
    const dis = pinned ? ' disabled' : '';
    const nest = nested ? ' data-nested="1"' : '';
    const placeholder = ['string', 'number'].includes(typeof prop['x-example']) ? ' placeholder="' + esc(prop['x-example']) + '"' : '';
    if (prop.enum && Array.isArray(prop.enum)) {
        return '<select data-pai-control data-type="enum" data-key="' + esc(path) + '"' + nest + ' aria-label="' + esc(title) + '"' + (pinned ? ' data-ov-native' : '') + dis + '>' + paiOptions(prop, value) + '</select>';
    }
    if (type === 'boolean') {
        return '<label class="pai-switch"><input type="checkbox" role="switch" data-ov-native data-pai-control data-type="boolean" data-key="' + esc(path) + '"' + nest + (value ? ' checked' : '') + dis + ' aria-label="' + esc(title) + '"><span class="pai-track" aria-hidden="true"><span class="pai-knob"></span></span><span class="pai-switch-text">' + (value ? 'On' : 'Off') + '</span></label>';
    }
    if (type === 'array') {
        const items = Array.isArray(value) ? value : [];
        return '<div class="pai-chips" data-pai-chips>' + items.map((it) => paiChip(it, !pinned)).join('') + '</div>'
            + (pinned ? '' : '<span class="pai-list-add"><input data-pai-list-input placeholder="Add…" aria-label="Add to ' + esc(title) + '"><button type="button" class="btn btn-sm pai-quiet" data-act="list-add">Add</button></span>');
    }
    if (type === 'object') {
        // Raw JSON: only ever drawn inside Advanced settings (paiAdvanced).
        return '<textarea data-pai-control data-type="object" data-key="' + esc(path) + '"' + nest + ' rows="3" spellcheck="false" aria-label="' + esc(title) + '"' + dis + '>' + esc(JSON.stringify(value == null ? {} : value, null, 2)) + '</textarea>';
    }
    if (prop['x-unit'] === 'nano_usd') {
        return '<span class="pai-money-input"><span class="pai-prefix">$</span><input data-pai-control data-type="nano_usd" data-key="' + esc(path) + '"' + nest + ' inputmode="decimal" value="' + esc(paiUsd(value)) + '" aria-label="' + esc(title) + ' in dollars"' + dis + '></span>';
    }
    if (type === 'integer') {
        const unit = paiUnitLabel(prop['x-unit']);
        const input = '<input data-pai-control data-type="integer" data-key="' + esc(path) + '"' + nest + (nullable ? ' data-nullable="1"' : '') + ' type="number" step="1" value="' + esc(value == null ? '' : value) + '" aria-label="' + esc(title) + (unit ? ' in ' + esc(PAI_UNIT_WORDS[prop['x-unit']] || unit) : '') + '"' + placeholder + dis + '>';
        return unit ? '<span class="pai-unit-input">' + input + '<span class="pai-unit">' + esc(unit) + '</span></span>' : input;
    }
    if (type === 'number') {
        return '<input data-pai-control data-type="number" data-key="' + esc(path) + '"' + nest + (nullable ? ' data-nullable="1"' : '') + ' type="number" step="any" value="' + esc(value == null ? '' : value) + '" aria-label="' + esc(title) + '"' + placeholder + dis + '>';
    }
    return '<input data-pai-control data-type="string" data-key="' + esc(path) + '"' + nest + (nullable ? ' data-nullable="1"' : '') + ' value="' + esc(value == null ? '' : value) + '" aria-label="' + esc(title) + '"' + placeholder + dis + '>';
}

function paiField(n, key, prop, pinned, pinName) {
    const value = n.values ? n.values[key] : undefined;
    const secret = paiIsSecret(n, key, prop);
    const danger = !!prop['x-danger'];
    const title = prop.title || paiHumanize(key);
    const description = prop.description || '';
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    const type = types.find((t) => t !== 'null') || 'string';
    const money = /money|credit|spend|pay|price|usd|cost|cap/i.test(title + ' ' + description + ' ' + key) || prop['x-unit'] === 'nano_usd';
    const chips = (pinned ? '<span class="pai-chip-lock">From the settings file</span>' : '') + (danger ? '<span class="pai-chip-danger">' + (money ? 'Money' : 'Takes effect at once') + '</span>' : '') + (secret ? '<span class="pai-chip-secret">Key</span>' : '');
    let control;
    if (secret) {
        const m = (n.secret_markers && n.secret_markers[key]) || null;
        const set = !!(value && typeof value === 'object' && value.redacted === true);
        const shown = pinned ? 'From the server\'s settings file' + (pinName || prop['x-env'] ? ' (' + esc(pinName || prop['x-env']) + ')' : '')
            : set ? 'Entered here, locked' + (m && m.hint ? ' ••••' + esc(m.hint) : '') + (m && m.set_at ? ' · ' + esc(paiWhen(m.set_at)) : '') : 'Not set';
        control = '<div class="pai-secret"><span class="pai-marker">' + shown + '</span>'
            + (pinned ? '' : ' <button type="button" class="btn btn-sm pai-quiet" data-act="secret" data-key="' + esc(key) + '">' + (set ? 'Replace' : 'Enter it') + '</button>')
            + (!pinned && set ? ' <button type="button" class="btn btn-sm pai-quiet pai-quiet-danger" data-act="secret-remove" data-key="' + esc(key) + '">Remove</button>' : '') + '</div>';
    } else if (type === 'object' && prop.properties && typeof prop.properties === 'object' && Object.keys(prop.properties).length) {
        // An object whose fields the schema describes is a small form, not raw JSON.
        const inner = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        control = '<div class="pai-subform" data-pai-object data-key="' + esc(key) + '">' + Object.entries(prop.properties).map(([k, p]) => {
            const t = (p && p.title) || paiHumanize(k);
            return '<div class="pai-subfield"><span class="pai-subfield-label">' + esc(t) + ' <code>' + esc(k) + '</code></span>'
                + (p && p.description ? '<span class="pai-field-desc muted">' + esc(p.description) + '</span>' : '')
                + paiControl(key + '.' + k, p || {}, inner[k], { pinned, title: t, nested: true }) + '</div>';
        }).join('') + '</div>';
    } else {
        control = paiControl(key, prop, value, { pinned, title });
    }
    const unitWords = prop['x-unit'] && prop['x-unit'] !== 'nano_usd' && PAI_UNIT_WORDS[prop['x-unit']] ? '<p class="pai-unit-line muted">In ' + esc(PAI_UNIT_WORDS[prop['x-unit']]) + '.</p>' : '';
    const pinLine = pinned ? '<p class="pai-pin-line">Set in the server\'s settings file (' + esc(pinName || prop['x-env'] || 'its env file') + '); change it there. ' + paiWhat('settings-file') + '</p>' : '';
    return '<div class="pai-field" data-pai-field data-key="' + esc(key) + '" data-secret="' + (secret ? '1' : '0') + '" data-pinned="' + (pinned ? '1' : '0') + '">'
        + '<div class="pai-field-label"><label>' + esc(title) + ' <code>' + esc(key) + '</code></label>' + chips + '</div>'
        + (description ? '<p class="pai-field-desc muted">' + esc(description) + '</p>' : '')
        + '<div class="pai-control">' + control + unitWords + pinLine + '</div></div>';
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

/** One control's value, or { error }. */
function paiReadControl(control, label) {
    const type = control.dataset.type;
    if (type === 'boolean') return { value: control.checked };
    if (control.dataset.nullable === '1' && control.value === '') return { value: null };
    if (type === 'nano_usd') {
        const parsed = paiParseUsd(control.value);
        return parsed.error ? { error: label + ': ' + parsed.error } : { value: parsed.nano };
    }
    if (type === 'integer') {
        const number = Number(control.value);
        return Number.isInteger(number) && control.value !== '' ? { value: number } : { error: label + ': enter a whole number' };
    }
    if (type === 'number') {
        const number = Number(control.value);
        return Number.isFinite(number) && control.value !== '' ? { value: number } : { error: label + ': enter a number' };
    }
    if (type === 'object') {
        try { return { value: JSON.parse(control.value) }; } catch { return { error: label + ': the JSON is not valid' }; }
    }
    if (type === 'enum') {
        // An option's value is the enum value as text; a non-string one is its JSON.
        const select = control;
        try { const v = JSON.parse(select.value); if (typeof v !== 'string') return { value: v }; } catch { /* a plain string */ }
        return { value: select.value };
    }
    return { value: control.value };
}

function paiCollect(card) {
    const values = {};
    for (const field of card.querySelectorAll('[data-pai-field]')) {
        if (field.dataset.pinned === '1' || field.dataset.secret === '1') continue;
        const key = field.dataset.key;
        if (!key) continue;
        const label = (field.querySelector('.pai-field-label label') || {}).textContent || key;
        const object = field.querySelector('[data-pai-object]');
        if (object) {
            const out = {};
            for (const control of object.querySelectorAll('[data-pai-control][data-nested="1"]')) {
                const child = control.dataset.key.slice(key.length + 1);
                const read = paiReadControl(control, label.trim() + ' · ' + child);
                if (read.error) return { error: read.error };
                out[child] = read.value;
            }
            values[key] = out;
            continue;
        }
        if (field.querySelector('[data-pai-chips]')) {
            values[key] = [...field.querySelectorAll('.pai-chip')].map((chip) => JSON.parse(chip.dataset.value));
            continue;
        }
        const control = field.querySelector('[data-pai-control]');
        if (!control) continue;
        const read = paiReadControl(control, label.trim());
        if (read.error) return { error: read.error };
        values[key] = read.value;
    }
    return { values };
}

async function paiSaveCard(card, n) {
    const collected = paiCollect(card);
    if (collected.error) return toast(collected.error, 'error');
    const changed = {};
    for (const [key, value] of Object.entries(collected.values)) {
        const before = n.values ? n.values[key] : undefined;
        // An object drawn as a form keeps the members it did not draw.
        const next = value && typeof value === 'object' && !Array.isArray(value) && before && typeof before === 'object' && !Array.isArray(before) ? { ...before, ...value } : value;
        if (JSON.stringify(next) !== JSON.stringify(before)) changed[key] = next;
    }
    if (!Object.keys(changed).length) return toast('Nothing to save', 'info');
    const props = (n.schema && n.schema.properties) || {};
    const danger = Object.keys(changed).filter((key) => props[key] && props[key]['x-danger']);
    if (danger.length) {
        const lines = danger.map((key) => (props[key].title || paiHumanize(key)) + ': ' + (props[key].description || 'This takes effect at once.') + ' It will be ' + (typeof changed[key] === 'boolean' ? (changed[key] ? 'on' : 'off') : (props[key]['x-unit'] === 'nano_usd' ? '$' + paiUsd(changed[key]) : JSON.stringify(changed[key]))) + '.');
        lines.push('To undo it, change it back here, or roll back to the previous version under History.');
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
    const prop = (n.schema && n.schema.properties && n.schema.properties[key]) || {};
    const dlg = document.createElement('dialog');
    dlg.className = 'pai-dialog';
    dlg.innerHTML = '<form method="dialog" class="pai-form"><h3>' + esc(prop.title || paiHumanize(key)) + ' <code class="pai-mkey">' + esc(key) + '</code></h3><p class="muted">The value is written once and locked by ' + esc(paiLabel(n.service)) + '; it is never shown again.</p>'
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
    const prop = (n.schema && n.schema.properties && n.schema.properties[key]) || {};
    const ok = await paiConfirm('Remove ' + (prop.title || paiHumanize(key)) + '?', [paiLabel(n.service) + ' will not have this key until it is entered again; what uses it stops working.', 'It cannot be shown again, so keep a copy where you got it.']);
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
        const actor = paiWho(s.activated_by || s.created_by);
        const current = s.state === 'active' || s.revision === n.revision;
        return '<tr><td>' + esc(s.revision) + '</td><td>' + esc(paiWhen(s.activated_at || s.created_at)) + '</td><td>' + esc(actor || '—') + '</td><td>' + esc(s.reason || '—') + '</td><td>' + (current ? '<span class="muted">Current</span>' : '<button type="button" class="btn btn-sm" data-rollback="' + esc(s.revision) + '">Roll back</button>') + '</td></tr>';
    }).join('');
    dlg.innerHTML = '<div class="pai-form"><h3>History · ' + esc((n.schema && n.schema.title) || n.namespace) + ' <code class="pai-mkey">' + esc(n.namespace) + '</code></h3>'
        + '<p class="muted">Every saved version, newest first. Rolling back makes an older version current again, as a new version; nothing is deleted.</p>'
        + (snapshots.length ? '<div class="pai-table-wrap"><table class="pai-table"><thead><tr><th>Version</th><th>When</th><th>By</th><th>Why</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="muted">No saved versions yet: these are the defaults.</p>')
        + '<div class="pai-dialog-actions"><button type="button" class="btn" data-act="close">Close</button></div></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', async (ev) => {
        if (ev.target.closest('[data-act="close"]')) { dlg.close(); return; }
        const rollback = ev.target.closest('[data-rollback]');
        if (!rollback) return;
        const to = Number(rollback.dataset.rollback);
        const ok = await paiConfirm('Roll back to version ' + to + '?', ['These settings return to version ' + to + '. Nothing is deleted: the rollback is kept as a new version, so you can roll forward again.']);
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

/** Per service, in words: locked with its own lock key, not locked, or not published yet. */
function paiRenderVault() {
    const box = document.getElementById('pai-vault-list');
    if (!box) return;
    const rows = PAI.services.map((s) => {
        const state = PAI.serviceState[s.service] || { answered: false, sealed: null, kek: null };
        const name = esc(s.name || paiLabel(s.service));
        let status;
        let hint = '';
        if (state.answered && state.sealed === true) {
            status = '<span class="pai-state is-ok">Keys are locked</span>' + (state.kek ? ' <code class="pai-mkey">' + esc(state.kek) + '</code>' : '');
        } else if (state.answered && state.sealed === false) {
            status = '<span class="pai-state is-bad">Keys are stored unlocked</span>';
            hint = '<div class="pai-hint">Add its lock key (OV_CONFIG_KEKS and OV_CONFIG_KEK_CURRENT) to its settings file on the server, with openvibe-shared 4.110 or later.</div>';
        } else if (state.answered && !state.published) {
            status = '<span class="pai-state is-muted">' + name + ' has not published settings yet</span>';
        } else if (state.answered) {
            status = '<span class="pai-state is-muted">No keys yet</span>';
        } else {
            status = '<span class="pai-state is-muted">' + name + ' has not published settings yet</span>';
        }
        return '<div class="pai-vault-row"><span class="pai-vault-name">' + name + '</span>' + status + hint + '</div>';
    });
    box.innerHTML = paiFold(rows, (row) => row);
}
