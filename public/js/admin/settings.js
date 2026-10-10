/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): settings sub-tabs, URL registry, streamer settings, Discord and GitHub.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════
// Settings (dual: openvibe-network + OpenVibe.Live)
// ═══════════════════════════════════════════════════════════════
let currentSettingsSub = 'tools';
function showSettingsSub(sub, btn) {
    currentSettingsSub = sub;
    document.querySelectorAll('#settings-sub-tabs button').forEach(b => b.classList.remove('active'));
    btn?.classList.add('active');
    document.getElementById('settings-tools').style.display = sub === 'tools' ? 'block' : 'none';
    document.getElementById('settings-streamer').style.display = sub === 'streamer' ? 'block' : 'none';
    document.getElementById('settings-media').style.display = sub === 'media' ? 'block' : 'none';
    document.getElementById('settings-urls').style.display = sub === 'urls' ? 'block' : 'none';
    document.getElementById('settings-discord').style.display = sub === 'discord' ? 'block' : 'none';
    document.getElementById('settings-github').style.display = sub === 'github' ? 'block' : 'none';
    if (sub === 'tools') loadToolsSettings();
    else if (sub === 'streamer') loadStreamerSettings();
    else if (sub === 'media') loadStreamerMediaTools();
    else if (sub === 'urls') loadUrlRegistry();
    else if (sub === 'discord') loadDiscordSettings();
    else if (sub === 'github') loadGithubSettings();
}

async function loadSettings() {
    loadToolsSettings();
}

async function loadToolsSettings() {
    const c = document.getElementById('settings-tools');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/settings');
        const settings = data.settings || {};
        const keys = Object.keys(settings);
        if (!keys.length) { c.innerHTML = '<p class="muted">No settings configured</p>'; return; }
        _toolsSettingsOriginal = {};
        for (const key of keys) _toolsSettingsOriginal[key] = settings[key].type === 'boolean' ? (settings[key].value === 'true' ? 'true' : 'false') : String(settings[key].value ?? '');
        c.innerHTML = `
            <form id="tools-settings-form" style="max-width:700px">
                ${keys.map(key => {
                    const s = settings[key];
                    const isSensitive = /(password|secret|token|private|credential|api[_-]?key|bearer)/i.test(key);
                    if (s.source === 'env') return `
                        <div class="setting-row" style="flex-direction:column;align-items:stretch">
                            <label for="ts-${esc(key)}"><strong>${esc(key)}</strong></label>
                            <input type="password" id="ts-${esc(key)}" data-key="${esc(key)}" data-type="${esc(s.type||'string')}" value="" disabled placeholder="Set in the environment (${esc(s.env || '')})"
                                style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">
                        </div>`;
                    if (s.type === 'boolean') return `
                        <div class="setting-row">
                            <label for="ts-${esc(key)}"><strong>${esc(key)}</strong></label>
                            <input type="checkbox" id="ts-${esc(key)}" data-key="${esc(key)}" data-type="boolean" ${s.value==='true'?'checked':''} style="width:18px;height:18px;cursor:pointer">
                        </div>`;
                    return `
                        <div class="setting-row" style="flex-direction:column;align-items:stretch">
                            <label for="ts-${esc(key)}"><strong>${esc(key)}</strong></label>
                            <input type="${isSensitive?'password':'text'}" id="ts-${esc(key)}" data-key="${esc(key)}" data-type="${esc(s.type||'string')}" value="${esc(s.value)}"
                                style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">
                            ${s.source === 'database' && s.env && s.secret ? `<span class="muted" style="font-size:12px;margin-top:4px">Stored in the database; prefer <code>${esc(s.env)}</code> in the server's environment file.</span>` : ''}
                        </div>`;
                }).join('')}
                <div style="margin-top:16px"><button type="button" class="btn btn-primary" onclick="saveToolsSettings()"><i class="fa-solid fa-floppy-disk"></i> Save Settings</button></div>
            </form>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

let _toolsSettingsOriginal = {};
async function saveToolsSettings() {
    const inputs = document.querySelectorAll('#tools-settings-form [data-key]');
    const changed = [];
    for (const input of inputs) {
        if (input.disabled) continue;                                 // provided by the environment
        const key = input.dataset.key;
        const value = input.dataset.type === 'boolean' ? (input.checked ? 'true' : 'false') : input.value;
        if (value.startsWith('••••')) continue;                       // masked secret, untouched
        if (_toolsSettingsOriginal[key] !== undefined && _toolsSettingsOriginal[key] === value) continue;
        if (input.dataset.type === 'number' && !Number.isFinite(Number(value))) { toast(`${key}: must be a number`, 'error'); return; }
        changed.push({ key, value, type: input.dataset.type });
    }
    if (!changed.length) { toast('No changes to save', 'info'); return; }
    try {
        for (const { key, value, type } of changed) {
            await api('/api/admin/settings', { method: 'PUT', body: { key, value, type } });
            _toolsSettingsOriginal[key] = value;
        }
        toast(`Saved ${changed.length} setting${changed.length === 1 ? '' : 's'}: ${changed.map(c => c.key).join(', ')}`, 'success');
    } catch (e) { toast(e.message, 'error'); }
}

async function loadUrlRegistry() {
    const c = document.getElementById('settings-urls');
    c.innerHTML = '<div class="loading">Loading URL registry...</div>';
    try {
        const data = await api('/api/admin/url-registry');
        const entries = data.entries || [];
        if (!entries.length) {
            c.innerHTML = '<p class="muted">No URL registry overrides configured.</p>';
            return;
        }
        c.innerHTML = `
            <div style="max-width:900px;display:grid;gap:16px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
                    <div>
                        <strong>Network registry</strong>
                        <div class="muted" style="font-size:13px">Edit first-party networking values and push refresh to services.</div>
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                        <button class="btn btn-sm btn-primary" onclick="refreshAllUrlRegistry()"><i class="fa-solid fa-arrows-rotate"></i> Refresh all services</button>
                    </div>
                </div>
                <div id="url-registry-refresh-status" class="muted" style="font-size:13px"></div>
                ${entries.map(entry => `
                    <div class="card" style="padding:16px">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
                            <div>
                                <div style="font-weight:700">${esc(entry.key)}</div>
                                <div class="muted" style="font-size:13px">${esc(entry.label)} — ${esc(entry.type)}</div>
                            </div>
                            <div style="display:flex;gap:8px;flex-wrap:wrap">
                                <button class="btn btn-sm btn-outline" onclick="resetUrlRegistryEntry('${esc(entry.key)}')"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                                <button class="btn btn-sm btn-primary" onclick="saveUrlRegistryEntry('${esc(entry.key)}')"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                            </div>
                        </div>
                        <div class="form-field" style="margin-top:12px">
                            <label for="url-registry-${esc(entry.key)}">Value</label>
                            ${entry.type === 'boolean' ? `
                                <div style="display:flex;align-items:center;gap:8px">
                                    <input type="checkbox" id="url-registry-${esc(entry.key)}" ${entry.value ? 'checked' : ''}>
                                    <span>${esc(entry.label)}</span>
                                </div>
                            ` : `
                                <input type="text" id="url-registry-${esc(entry.key)}" value="${esc(entry.value || '')}" placeholder="${esc(entry.placeholder || '')}">
                            `}
                            <div class="muted" style="margin-top:4px">Source: ${esc(entry.source)}</div>
                            ${entry.key === 'WHIP_PUBLIC_URL' ? `<div class="badge badge-warning" style="margin-top:8px;display:inline-block">Note</div><div class="muted" style="margin-top:4px">A dedicated WHIP hostname also requires explicit enablement via WHIP_PUBLIC_URL_ENABLED, plus DNS/vhost/TLS support.</div>` : ''}
                            ${entry.warning ? `<div class="badge badge-warning" style="margin-top:8px;display:inline-block">Warning</div><div class="muted" style="margin-top:4px">${esc(entry.warning)}</div>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>`;
    } catch (e) {
        c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
    }
}

async function saveUrlRegistryEntry(key) {
    const input = document.getElementById(`url-registry-${key}`);
    if (!input) return toast('Missing registry field', 'error');
    const value = input.type === 'checkbox' ? input.checked : input.value.trim();
    try {
        await api(`/api/admin/url-registry/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } });
        toast('URL registry entry saved', 'success');
        loadUrlRegistry();
    } catch (e) { toast(e.message, 'error'); }
}

async function resetUrlRegistryEntry(key) {
    if (!confirm('Reset this URL registry entry to its default?')) return;
    try {
        await api(`/api/admin/url-registry/${encodeURIComponent(key)}/reset`, { method: 'POST' });
        toast('URL registry entry reset', 'success');
        loadUrlRegistry();
    } catch (e) { toast(e.message, 'error'); }
}

async function refreshAllUrlRegistry() {
    const statusEl = document.getElementById('url-registry-refresh-status');
    statusEl.textContent = 'Refreshing all services...';
    try {
        const data = await api('/api/admin/url-registry/refresh-all', { method: 'POST' });
        if (!data.ok) throw new Error(data.error || 'Refresh failed');
        const results = data.refreshResults || [];
        statusEl.innerHTML = results.map(service => {
            const result = (service.results && service.results[0]) || {};
            const mode = result.mode || (result.ok ? 'success' : 'failed');
            const badge = result.mode === 'local'
                ? '<span class="badge badge-info">Local</span>'
                : result.mode === 'not_configured'
                    ? '<span class="badge badge-warning">Not configured</span>'
                    : result.mode === 'unsupported'
                        ? '<span class="badge badge-warning">Unsupported</span>'
                        : result.ok
                            ? '<span class="badge badge-success">Success</span>'
                            : '<span class="badge badge-danger">Failed</span>';
            const message = result.error ? ` <span class="muted">${esc(result.error)}</span>` : (result.message ? ` <span class="muted">${esc(result.message)}</span>` : '');
            return `<div><strong>${esc(service.service)}</strong>: ${badge}${message}</div>`;
        }).join('');
        toast('Refresh command sent to services', 'success');
    } catch (e) {
        statusEl.textContent = `Refresh failed: ${esc(e.message)}`;
        toast(e.message, 'error');
    }
}

// Grouped, icon'd sections for the (otherwise huge) OpenVibe.Live settings list.
const STREAMER_SETTINGS_GROUPS = [
    { title: 'Site & General', icon: 'fa-sliders', test: k => /^(site_|motd$|registration_open$|require_email$|nsfw_enabled$)/.test(k) },
    { title: 'Payment Processors', icon: 'fa-credit-card', test: k => /^(payments_|bucks_|sub_|paypal_|stripe_|ccbill_|crypto_|min_cashout)/.test(k) },
    { title: 'Kick / Twitch / YouTube', icon: 'fa-plug', test: k => /^(twitch_|kick_|google_client)/.test(k) },
    { title: 'AI Config', icon: 'fa-robot', test: k => /^ai_/.test(k) },
    { title: 'Cloud TTS', icon: 'fa-volume-high', test: k => /^tts_/.test(k) },
    { title: 'Media & Uploads', icon: 'fa-photo-film', test: k => /^(gif_|soundboard_|paste_|storage_tier|max_emotes|max_clip|max_video|max_audio|max_vod)/.test(k) },
    { title: 'Chat & Rewards', icon: 'fa-comments', test: k => /^(chat_|coins_per)/.test(k) },
    { title: 'Other', icon: 'fa-ellipsis', test: () => true },
];

const REDACTED_MASK = '••••';
function _looksJson(v) { return typeof v === 'string' && /^\s*[\[{]/.test(v); }
function _isMultiline(s) {
    return s.type === 'json' || _looksJson(s.value) || /\n/.test(String(s.value ?? '')) || String(s.value ?? '').length > 140;
}
function _streamerSettingField(s) {
    const isSensitive = /(password|secret|token|private|credential|api[_-]?key|bearer|salt)/i.test(s.key);
    const label = `<label for="ss-${esc(s.key)}"><strong>${esc(s.key)}</strong>${s.redacted ? ' <span class="badge badge-warning" style="font-size:10px">owner-only</span>' : ''}<br><small>${esc(s.description||'')}</small></label>`;
    const base = 'margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px';
    if (s.type === 'boolean') return `<div class="setting-row">${label}
        <input type="checkbox" id="ss-${esc(s.key)}" data-key="${esc(s.key)}" data-type="boolean" ${s.value==='true'?'checked':''} style="width:18px;height:18px;cursor:pointer"></div>`;
    if (!isSensitive && _isMultiline(s)) {
        const kind = (s.type === 'json' || _looksJson(s.value)) ? 'json' : 'text';
        let shown = String(s.value ?? '');
        if (kind === 'json') { try { shown = JSON.stringify(JSON.parse(shown), null, 2); } catch { /* show as-is; save validation will flag it */ } }
        const rows = Math.min(18, Math.max(3, shown.split('\n').length + 1));
        return `<div class="setting-row" style="flex-direction:column;align-items:stretch">${label}
        <textarea id="ss-${esc(s.key)}" data-key="${esc(s.key)}" data-type="${kind}" rows="${rows}" spellcheck="false"
            style="${base};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;white-space:pre;overflow:auto">${esc(shown)}</textarea>
        <div class="setting-err muted" data-err-for="${esc(s.key)}" style="display:none;color:var(--danger,#f87171);font-size:12px;margin-top:4px"></div></div>`;
    }
    const type = s.type === 'number' ? 'number' : (isSensitive ? 'password' : 'text');
    const width = s.type === 'number' ? 'width:200px;' : '';
    return `<div class="setting-row" style="flex-direction:column;align-items:stretch">${label}
        <input type="${type}" id="ss-${esc(s.key)}" data-key="${esc(s.key)}" data-type="${esc(s.type||'string')}" value="${esc(s.value)}" ${type === 'number' ? 'step="any"' : ''}
            style="${base};${width}">
        <div class="setting-err muted" data-err-for="${esc(s.key)}" style="display:none;color:var(--danger,#f87171);font-size:12px;margin-top:4px"></div></div>`;
}

// Snapshot of what the server sent (keyed by setting key) so Save only submits real changes.
let _streamerSettingsOriginal = {};
function _streamerFieldValue(input) {
    return input.dataset.type === 'boolean' ? (input.checked ? 'true' : 'false') : input.value;
}
// Normalize so cosmetic differences (pretty-printed JSON, trailing whitespace) don't count as edits.
function _streamerNormalize(input, raw) {
    if (input.dataset.type === 'json') { try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; } }
    if (input.dataset.type === 'number') return String(raw).trim();
    return raw;
}
function _markDirty(input) {
    const orig = _streamerSettingsOriginal[input.dataset.key];
    const dirty = orig !== undefined && _streamerNormalize(input, _streamerFieldValue(input)) !== _streamerNormalize(input, orig);
    input.style.borderColor = dirty ? 'var(--accent, #8b5cf6)' : '';
    const btn = document.getElementById('streamer-settings-save');
    if (btn) {
        const n = document.querySelectorAll('#streamer-settings-form [data-key][data-dirty="1"]').length + (dirty && input.dataset.dirty !== '1' ? 1 : (!dirty && input.dataset.dirty === '1' ? -1 : 0));
        input.dataset.dirty = dirty ? '1' : '0';
        btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save ${n ? n + ' change' + (n === 1 ? '' : 's') : 'Settings'}`;
    }
}

async function loadStreamerSettings() {
    const c = document.getElementById('settings-streamer');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/streamer/settings');
        const settings = data.settings || [];
        if (!settings.length) { c.innerHTML = '<p class="muted">No OpenVibe.Live settings found</p>'; return; }
        _streamerSettingsOriginal = {};
        for (const s of settings) _streamerSettingsOriginal[s.key] = s.value == null ? '' : String(s.value);
        // Bucket each setting into the first matching group.
        const buckets = STREAMER_SETTINGS_GROUPS.map(() => []);
        for (const s of settings) {
            const gi = STREAMER_SETTINGS_GROUPS.findIndex(g => g.test(s.key));
            buckets[gi === -1 ? buckets.length - 1 : gi].push(s);
        }
        const sections = STREAMER_SETTINGS_GROUPS.map((g, i) => {
            const items = buckets[i].sort((a, b) => a.key.localeCompare(b.key));
            if (!items.length) return '';
            return `<details class="settings-group" ${i < 2 ? 'open' : ''} style="border:1px solid var(--border);border-radius:8px;margin-bottom:10px">
                <summary style="cursor:pointer;padding:10px 14px;font-weight:700;list-style:none"><i class="fa-solid ${g.icon}"></i> ${esc(g.title)} <span style="opacity:.5;font-weight:400">(${items.length})</span></summary>
                <div style="padding:4px 14px 12px">${items.map(_streamerSettingField).join('')}</div>
            </details>`;
        }).join('');
        c.innerHTML = `
            <form id="streamer-settings-form" style="max-width:760px">
                ${sections}
                <div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                    <button type="button" id="streamer-settings-save" class="btn btn-primary" onclick="saveStreamerSettings()"><i class="fa-solid fa-floppy-disk"></i> Save Settings</button>
                    <button type="button" class="btn btn-outline" onclick="loadStreamerSettings()"><i class="fa-solid fa-rotate-left"></i> Discard changes</button>
                    <span class="muted" style="font-size:12px">Only fields you changed are sent. JSON and numeric fields are validated first.</span>
                </div>
            </form>`;
        c.querySelectorAll('#streamer-settings-form [data-key]').forEach(el => el.addEventListener('input', () => _markDirty(el)));
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

function _setFieldError(key, msg) {
    const el = document.querySelector(`#streamer-settings-form [data-err-for="${CSS.escape(key)}"]`);
    if (el) { el.textContent = msg || ''; el.style.display = msg ? '' : 'none'; }
    const input = document.getElementById(`ss-${key}`);
    if (input) input.style.borderColor = msg ? 'var(--danger, #f87171)' : (input.dataset.dirty === '1' ? 'var(--accent, #8b5cf6)' : '');
}

async function saveStreamerSettings() {
    const inputs = document.querySelectorAll('#streamer-settings-form [data-key]');
    const settings = {};
    const errors = [];
    inputs.forEach(input => {
        const key = input.dataset.key;
        const raw = _streamerFieldValue(input);
        _setFieldError(key, '');
        // Not in the snapshot (shouldn't happen) or redacted mask untouched → never send.
        const orig = _streamerSettingsOriginal[key];
        if (orig === undefined) return;
        if (raw.startsWith(REDACTED_MASK)) return;
        if (_streamerNormalize(input, raw) === _streamerNormalize(input, orig)) return;
        let value = raw;
        if (input.dataset.type === 'json') {
            try { value = JSON.stringify(JSON.parse(raw)); }
            catch (e) { errors.push(key); _setFieldError(key, `Invalid JSON: ${e.message}`); return; }
        } else if (input.dataset.type === 'number') {
            if (raw.trim() === '' || !Number.isFinite(Number(raw))) { errors.push(key); _setFieldError(key, 'Must be a number'); return; }
            value = String(Number(raw));
        } else if (_looksJson(orig) && !_looksJson(raw)) {
            // Previously JSON, now something that clearly isn't → almost certainly a truncation/mistake.
            errors.push(key); _setFieldError(key, 'This setting was JSON; the new value is not. Clear the field completely if you really mean to blank it.'); return;
        }
        settings[key] = value;
    });
    if (errors.length) {
        toast(`Not saved — fix ${errors.length} invalid field${errors.length === 1 ? '' : 's'}: ${errors.join(', ')}`, 'error');
        const first = document.getElementById(`ss-${errors[0]}`);
        if (first) { first.closest('details')?.setAttribute('open', ''); first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        return;
    }
    const keys = Object.keys(settings);
    if (!keys.length) { toast('No changes to save', 'info'); return; }
    try {
        const out = await api('/api/admin/streamer/settings', { method: 'PUT', body: { settings } });
        if (out && out.rejected && Object.keys(out.rejected).length) {
            for (const [k, msg] of Object.entries(out.rejected)) _setFieldError(k, msg);
            toast(`Server rejected: ${Object.keys(out.rejected).join(', ')}`, 'error');
            return;
        }
        for (const k of keys) _streamerSettingsOriginal[k] = settings[k];
        inputs.forEach(el => { el.dataset.dirty = '0'; el.style.borderColor = ''; });
        const btn = document.getElementById('streamer-settings-save');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Settings';
        toast(`Saved ${keys.length} setting${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}` + (out?.message && /skipped/.test(out.message) ? ` (${out.message})` : ''), 'success');
    } catch (e) {
        // Server-side validation failed: nothing was written; surface the per-field reasons.
        const rejected = e.body && e.body.rejected;
        if (rejected && Object.keys(rejected).length) for (const [k, msg] of Object.entries(rejected)) _setFieldError(k, msg);
        toast(e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════
// Discord Bot Settings
// ═══════════════════════════════════════════════════════════════
// A secret input for a provider secret: disabled when its environment variable provides it (server/secrets.js).
function envSecretInput(sources, key, value, placeholder, style) {
    // Provider secrets are environment-only (server/secrets.js): the field shows where it comes from and never edits it.
    const src = (sources || {})[key] || {};
    const env = esc(src.env || '');
    const label = src.source === 'env' ? `Set in the environment (${env})` : `Not set: add ${env} to /etc/openvibe/network.env and restart Network`;
    return `<input type="password" data-key="${esc(key)}" value="" placeholder="${label}" disabled style="${style}">`;
}

async function loadDiscordSettings() {
    const c = document.getElementById('settings-discord');
    c.innerHTML = '<p class="muted">Loading Discord settings...</p>';
    try {
        const data = await api('/api/admin/discord');
        const s = data.settings || {};
        const st = data.status || {};
        const statusBadge = st.connected
            ? `<span class="badge" style="background:var(--success-bg,#166534);color:var(--success-text,#4ade80)">● Connected as ${esc(st.botTag || '?')}</span>`
            : `<span class="badge" style="background:var(--danger-bg,#7f1d1d);color:var(--danger-text,#f87171)">● Disconnected</span>`;

        c.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
                <h3 style="margin:0"><i class="fa-brands fa-discord"></i> Discord Bot</h3>
                ${statusBadge}
            </div>
            <form id="discord-settings-form">
                <div class="setting-row">
                    <label>Bot Token</label>
                    ${envSecretInput(data.sources, 'discord_bot_token', s.discord_bot_token, 'Bot token from Discord Developer Portal', 'width:100%;max-width:500px')}
                </div>
                <div class="setting-row">
                    <label>Guild / Server ID</label>
                    <input type="text" data-key="discord_guild_id" value="${esc(s.discord_guild_id || '')}" placeholder="Right-click server → Copy Server ID" style="width:240px">
                </div>
                <div class="setting-row">
                    <label>Live Alerts Channel ID</label>
                    <input type="text" data-key="discord_alerts_channel_id" value="${esc(s.discord_alerts_channel_id || '')}" placeholder="Channel for go-live alerts" style="width:240px">
                </div>
                <div class="setting-row">
                    <label>System Alerts Channel ID</label>
                    <input type="text" data-key="discord_system_channel_id" value="${esc(s.discord_system_channel_id || '')}" placeholder="Channel for system/admin alerts (optional)" style="width:240px">
                </div>
                <div class="setting-row">
                    <label>Dedupe Cooldown (minutes)</label>
                    <input type="number" data-key="discord_dedupe_minutes" value="${esc(s.discord_dedupe_minutes || '15')}" min="1" max="1440" style="width:100px">
                    <span class="muted" style="margin-left:8px">Prevent spam if a streamer flaps live/offline</span>
                </div>
                <div class="setting-row">
                    <label>Custom Alert Message (optional)</label>
                    <input type="text" data-key="discord_alert_message" value="${esc(s.discord_alert_message || '')}" placeholder="{display_name} went live: {title}" style="width:100%;max-width:500px">
                    <div class="muted" style="font-size:12px;margin-top:4px">Placeholders: {username}, {display_name}, {title}, {url}</div>
                </div>
                <h4 style="margin-top:24px"><i class="fa-brands fa-discord"></i> Account Linking (OAuth2)</h4>
                <div class="setting-row">
                    <label>OAuth2 Client ID</label>
                    <input type="text" data-key="discord_oauth_client_id" value="${esc(s.discord_oauth_client_id || '')}" placeholder="Discord application client ID" style="width:300px">
                </div>
                <div class="setting-row">
                    <label>OAuth2 Client Secret</label>
                    ${envSecretInput(data.sources, 'discord_oauth_client_secret', s.discord_oauth_client_secret, 'Discord application client secret', 'width:300px')}
                </div>
                <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
                    <button type="button" class="btn btn-primary" onclick="saveDiscordSettings()"><i class="fa-solid fa-save"></i> Save Settings</button>
                    <button type="button" class="btn btn-outline" onclick="testDiscordAlert()"><i class="fa-solid fa-bell"></i> Test System Alert</button>
                    <button type="button" class="btn btn-outline" onclick="testDiscordLiveAlert()"><i class="fa-solid fa-broadcast-tower"></i> Test Live Alert</button>
                    <button type="button" class="btn btn-outline" onclick="reinitDiscordBot()"><i class="fa-solid fa-rotate"></i> Reconnect Bot</button>
                </div>
            </form>`;
    } catch (e) {
        c.innerHTML = `<p class="muted">Error loading Discord settings: ${esc(e.message)}</p>`;
    }
}

// ═══════════════════════════════════════════════════════════════
// GitHub integration (owner-only): the read-only token for the registry and Blog's changelog
// ═══════════════════════════════════════════════════════════════
async function loadGithubSettings() {
    const c = document.getElementById('settings-github');
    c.innerHTML = '<p class="muted">Loading…</p>';
    try {
        const g = (await api('/api/admin/integrations/github')).github || {};
        const env = esc(g.env || 'GITHUB_TOKEN');
        const badge = g.set ? `<span class="badge" style="background:var(--success-bg,#166534);color:var(--success-text,#4ade80)">● Token …${esc(g.last4 || '')} (set in the environment)</span>` : `<span class="badge badge-warning">● No token: anonymous, 60 requests an hour for the whole host</span>`;
        c.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
                <h3 style="margin:0"><i class="fa-brands fa-github"></i> GitHub</h3>${badge}
            </div>
            <p class="muted" style="max-width:720px">A read-only token for public repositories. With it, GitHub allows 5,000 requests an hour instead of the 60 an hour this host shares without one. Used by: ${(g.used_by || []).map(esc).join('; ')}.</p>
            <p class="muted" style="max-width:720px">Provider secrets live in the server's environment only, never in the database. ${g.set ? `This one comes from <code>${env}</code>; change it there.` : `To add one, create a fine-grained token with <b>public repositories, read-only</b> access and no other permissions, set <code>${env}</code> in <code>/etc/openvibe/network.env</code>, and restart Network.`}</p>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
                <button type="button" class="btn btn-outline" onclick="testGithubToken()"><i class="fa-solid fa-plug"></i> Test</button>
            </div>
            <div id="github-test-result" class="muted" style="margin-top:10px"></div>`;
    } catch (e) { c.innerHTML = `<p class="muted">GitHub settings could not be loaded: ${esc(e.message)}</p>`; }
}
async function testGithubToken() {
    const out = document.getElementById('github-test-result');
    if (out) out.textContent = 'Asking GitHub…';
    try {
        const t = (await api('/api/admin/integrations/github/test', { method: 'POST' })).test || {};
        if (out) out.innerHTML = t.ok ? `${t.authenticated ? '✅ Authenticated' : '⚠️ Anonymous'}: ${esc(String(t.remaining))} of ${esc(String(t.limit))} requests left this hour${t.reset ? ` (resets ${esc(new Date(t.reset).toLocaleTimeString())})` : ''}.` : `❌ GitHub refused it: ${esc(t.message || t.status)}`;
    } catch (e) { if (out) out.textContent = e.message; }
}

async function saveDiscordSettings() {
    try {
        const form = document.getElementById('discord-settings-form');
        const settings = {};
        form.querySelectorAll('[data-key]').forEach(el => {
            if (el.disabled) return;                               // provided by the environment
            settings[el.dataset.key] = el.value;
        });
        await api('/api/admin/discord', { method: 'PUT', body: JSON.stringify({ settings }) });
        toast('Discord settings saved');
        loadDiscordSettings();
    } catch (e) { toast(e.message, 'error'); }
}

async function testDiscordAlert() {
    try {
        const data = await api('/api/admin/discord/test', { method: 'POST' });
        toast(data.sent ? 'Test alert sent!' : `Alert not sent: ${data.reason || 'unknown'}`, data.sent ? 'success' : 'error');
    } catch (e) { toast(e.message, 'error'); }
}

async function testDiscordLiveAlert() {
    try {
        const data = await api('/api/admin/discord/test-live', { method: 'POST' });
        toast(data.sent ? 'Test live alert sent!' : `Alert not sent: ${data.reason || 'unknown'}`, data.sent ? 'success' : 'error');
    } catch (e) { toast(e.message, 'error'); }
}

async function reinitDiscordBot() {
    try {
        const data = await api('/api/admin/discord/reinit', { method: 'POST' });
        toast(data.status?.connected ? `Bot reconnected as ${data.status.botTag}` : 'Bot reconnected (not logged in)', data.status?.connected ? 'success' : 'warning');
        loadDiscordSettings();
    } catch (e) { toast(e.message, 'error'); }
}
