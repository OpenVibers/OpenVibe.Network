/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): the dashboard showcase, your tools, data and modules.
   Split out of my.html. Classic scripts, global scope: they rely on
   my/core.js's helpers (apiFetch, getAuthToken, showSection, API) and on
   my/boot.js (loaded last), which starts the page. No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// Build dashboard showcase
function buildDashboardShowcase() {
    const grid = document.getElementById('my-showcase-grid');
    const quickAccess = document.getElementById('my-quick-access');
    if (!grid || !quickAccess) return;
    const popular = [
        { name: 'Live', icon: 'fa-tower-broadcast', url: 'https://openvibe.live' },
        { name: 'Tools', icon: 'fa-screwdriver-wrench', url: 'https://openvibe.tools' },
        { name: 'Games', icon: 'fa-gamepad', url: 'https://openvibe.games' },
        { name: 'Media', icon: 'fa-photo-film', url: 'https://openvibe.media' },
    ];
    grid.innerHTML = popular.map(t => `<a href="${t.url}" class="showcase-card" title="${t.name}" target="_blank" rel="noopener"><i class="fa-solid ${t.icon} showcase-card-icon"></i><span class="showcase-card-label">${t.name}</span></a>`).join('');
    const quickLinks = [
        { label: 'Themes', icon: 'fa-palette', onclick: "showSection('themes')" },
        { label: 'Profile', icon: 'fa-user', onclick: "showSection('profile')" },
        { label: 'Accounts', icon: 'fa-arrows-rotate', onclick: "showSection('accounts')" },
        { label: 'Linked', icon: 'fa-link', onclick: "showSection('linked')" },
        { label: 'Security', icon: 'fa-lock', onclick: "showSection('security')" },
        { label: 'Notifications', icon: 'fa-bell', onclick: "showSection('notifications')" },
    ];
    quickAccess.innerHTML = quickLinks.map(l => `<a class="quick-link" onclick="${l.onclick}"><i class="fa-solid ${l.icon}"></i>${l.label}</a>`).join('');
}

// Your tools: the tools.usage module (contracts 0.41.0, v2). OpenVibe.Tools keeps `recent`; `favorites`
// is the person's own (starred here or in the Tools launcher). Names come from the public Tools
// registry; a tool that is gone from it is skipped. Writes name the revision read (If-Match).
let toolsUsage = null, toolsRegistry = null;
async function saveToolFavorites(next) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const data = { ...(toolsUsage ? toolsUsage.data : {}), favorites: next };
        try {
            toolsUsage = await apiFetch('/api/modules/tools.usage', { method: 'PUT', headers: { 'If-Match': String(toolsUsage ? toolsUsage.revision : 0) }, body: JSON.stringify({ data }) });
            return true;
        } catch (e) {
            if (e.status !== 412) return false;
            toolsUsage = await apiFetch('/api/modules/tools.usage').catch(() => null);   // moved: read again, then retry
        }
    }
    return false;
}
function renderYourTools() {
    const box = document.getElementById('my-recent-tools');
    const list = document.getElementById('my-recent-tools-list');
    if (!box || !list || !toolsRegistry) return;
    const data = toolsUsage && toolsUsage.data ? toolsUsage.data : {};
    const favorites = Array.isArray(data.favorites) ? data.favorites : [];
    const recent = Array.isArray(data.recent) ? data.recent : [];
    const entries = [...favorites.map(tool => ({ tool, fav: true })), ...recent.filter(e => !favorites.includes(e.tool)).map(e => ({ ...e, fav: false }))];
    list.replaceChildren();
    for (const e of entries) {
        const t = toolsRegistry.get(e.tool);
        if (!t || list.childElementCount >= 16) continue;
        const item = document.createElement('span');
        item.className = 'recent-tool-item';
        const a = document.createElement('a');
        a.className = 'recent-tool';
        a.href = t.hosts && t.hosts[0] ? 'https://' + t.hosts[0] : 'https://openvibe.tools/tool/' + encodeURIComponent(t.id);
        a.target = '_blank'; a.rel = 'noopener';
        a.textContent = t.name;
        if (e.at) a.title = 'Last used ' + new Date(e.at).toLocaleString();
        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'recent-tool-star';
        star.setAttribute('aria-pressed', String(e.fav));
        star.setAttribute('aria-label', (e.fav ? 'Remove ' : 'Add ') + t.name + (e.fav ? ' from favourites' : ' to favourites'));
        star.innerHTML = `<i class="fa-${e.fav ? 'solid' : 'regular'} fa-star"></i>`;
        star.addEventListener('click', async () => {
            star.disabled = true;
            const next = e.fav ? favorites.filter(id => id !== e.tool) : [e.tool, ...favorites].slice(0, 24);
            const ok = await saveToolFavorites(next);
            const status = document.getElementById('my-recent-tools-status');
            if (status) status.textContent = ok ? '' : 'Could not save your favourites. Try again.';
            renderYourTools();
        });
        item.append(a, star);
        list.appendChild(item);
    }
    box.hidden = list.childElementCount === 0;
}
async function loadRecentTools() {
    try {
        toolsUsage = await apiFetch('/api/modules/tools.usage').catch(() => null);
        const d = toolsUsage && toolsUsage.data ? toolsUsage.data : {};
        if (!(d.recent || []).length && !(d.favorites || []).length) return;
        const reg = await fetchWithTimeout('https://openvibe.tools/api/v1/tools', {}, 8000).then(r => (r.ok ? r.json() : { tools: [] }));
        toolsRegistry = new Map((reg.tools || []).map(t => [t.id, t]));
        renderYourTools();
    } catch { /* optional */ }
}

// AI & Data: the ai.preferences user module (read by OpenVibe.AI for runs made on your behalf) and the list
// of every module record kept with this account (GET /api/modules), each deletable, all downloadable.
let aiPrefsRecord = null, modulesExport = null;
async function loadDataSection() {
    const status = document.getElementById('ai-prefs-status');
    try {
        aiPrefsRecord = await apiFetch('/api/modules/ai.preferences').catch((e) => { if (e.status === 404) return { revision: 0, data: {} }; throw e; });
        const d = aiPrefsRecord.data || {};
        document.getElementById('ai-style').value = d.style || '';
        document.getElementById('ai-length').value = d.length || '';
        document.getElementById('ai-perspective').value = d.perspective || '';
        document.getElementById('ai-history').checked = d.history !== false;
    } catch { if (status) status.textContent = 'Could not load your AI preferences.'; }
    loadModules();
}
async function saveAiPrefs(event) {
    event.preventDefault();
    const status = document.getElementById('ai-prefs-status');
    const data = { ...((aiPrefsRecord && aiPrefsRecord.data) || {}) };
    for (const k of ['style', 'length', 'perspective']) {
        const v = document.getElementById('ai-' + k).value.trim();
        if (v) data[k] = v; else delete data[k];
    }
    if (document.getElementById('ai-history').checked) delete data.history; else data.history = false;
    try {
        aiPrefsRecord = await apiFetch('/api/modules/ai.preferences', { method: 'PUT', headers: { 'If-Match': String(aiPrefsRecord ? aiPrefsRecord.revision : 0) }, body: JSON.stringify({ data }) });
        status.textContent = 'Saved.';
        loadModules();
    } catch (e) {
        status.textContent = e.status === 412 ? 'Changed somewhere else: reloaded. Save again.' : 'Could not save. Try again.';
        if (e.status === 412) loadDataSection();
    }
}
async function loadModules() {
    const box = document.getElementById('modules-list');
    if (!box) return;
    try {
        modulesExport = await apiFetch('/api/modules');
        const about = new Map((modulesExport.namespaces || []).map((n) => [n.namespace, n]));
        box.replaceChildren();
        if (!(modulesExport.modules || []).length) { const p = document.createElement('p'); p.textContent = 'Nothing yet.'; box.appendChild(p); return; }
        for (const m of modulesExport.modules) {
            const row = document.createElement('div'); row.className = 'module-row';
            const main = document.createElement('div'); main.className = 'module-row-main';
            const title = document.createElement('strong'); title.textContent = m.namespace;
            const info = document.createElement('small');
            const n = about.get(m.namespace);
            const keeper = n && n.owner ? 'OpenVibe.' + n.owner.charAt(0).toUpperCase() + n.owner.slice(1) : 'OpenVibe';
            info.textContent = `${n && n.description ? n.description + ' ' : ''}Kept by ${keeper}; updated ${m.updated_at ? new Date(String(m.updated_at).replace(' ', 'T') + (String(m.updated_at).includes('Z') ? '' : 'Z')).toLocaleString() : 'recently'}.`;
            const code = document.createElement('code'); code.textContent = JSON.stringify(m.data);
            main.append(title, info, code);
            const del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn-small btn-danger';
            del.textContent = 'Delete'; del.setAttribute('aria-label', 'Delete ' + m.namespace);
            del.addEventListener('click', async () => {
                if (!confirm(`Delete ${m.namespace}? A site may write its summary again the next time you use it.`)) return;
                try { await apiFetch('/api/modules/' + encodeURIComponent(m.namespace), { method: 'DELETE' }); } catch { /* shown by the reload */ }
                if (m.namespace === 'ai.preferences') loadDataSection(); else loadModules();
            });
            row.append(main, del);
            box.appendChild(row);
        }
    } catch { box.textContent = 'Could not load your data. Try again later.'; }
}
function exportModules() {
    if (!modulesExport) return;
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), subject: modulesExport.subject, modules: modulesExport.modules }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'openvibe-account-modules.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
