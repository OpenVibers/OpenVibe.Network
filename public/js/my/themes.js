/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): themes, the theme customizer and theme submissions.
   Split out of my.html. Classic scripts, global scope: they rely on
   my/core.js's helpers (apiFetch, getAuthToken, showSection, API) and on
   my/boot.js (loaded last), which starts the page. No ES modules.
   ═══════════════════════════════════════════════════════════════ */
function avatarPlaceholder(user, size = 96) {
    const label = (user?.display_name || user?.username || 'H').trim();
    const initial = label.charAt(0).toUpperCase() || 'H';
    const bg = user?.profile_color || '#8b5cf6';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="100%" height="100%" rx="${Math.round(size / 2)}" fill="${bg}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${Math.round(size * 0.42)}" font-weight="700" fill="#fff">${initial}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function avatarSrc(user, size = 96) {
    return user?.avatar_url || avatarPlaceholder(user, size);
}

function themePreviewColors(theme) {
    const vars = theme?.variables || {};
    const preview = Array.isArray(theme?.preview_colors) && theme.preview_colors.length
        ? theme.preview_colors
        : [vars['--bg-primary'], vars['--accent'], vars['--bg-card']].filter(Boolean);
    return [preview[0] || '#202331', preview[1] || '#8b5cf6', preview[2] || '#181a24'];
}

function applyThemeToPage(theme) {
    const vars = theme?.variables || {};
    // The shared loader applies every token (the canvas behind the page, --on-accent, the browser UI);
    // this page's own short names follow below.
    if (typeof OpenVibeThemeLoader !== 'undefined' && OpenVibeThemeLoader.applyVars) OpenVibeThemeLoader.applyVars(vars);
    Object.entries(LOCAL_THEME_MAP).forEach(([localVar, themeVar]) => {
        const value = vars[themeVar];
        if (value) document.documentElement.style.setProperty(localVar, value);
    });
}

function updateThemeSummary(theme) {
    const currentName = document.getElementById('theme-current-name');
    const swatches = document.querySelectorAll('#theme-current-swatch span');
    if (!currentName || swatches.length < 3) return;
    currentName.textContent = theme?.name || 'Vibe';
    themePreviewColors(theme).forEach((color, index) => {
        if (swatches[index]) swatches[index].style.background = color;
    });
}

function renderThemes() {
    const grid = document.getElementById('theme-grid');
    if (!grid) return;
    if (!availableThemes.length) {
        grid.innerHTML = '<div class="theme-empty">No themes available right now.</div>';
        return;
    }
    grid.innerHTML = availableThemes.map((theme) => {
        const [bg1, accent, bg2] = themePreviewColors(theme);
        const isActive = String(theme.id) === String(activeThemeId) || String(theme.slug) === String(activeThemeId);
        return `
            <article class="theme-card ${isActive ? 'active' : ''}">
                <div class="theme-preview" style="--theme-bg-1:${bg1};--theme-bg-2:${bg2}">
                    <div class="theme-preview-top">
                        <div class="theme-preview-swatch"><span style="background:${bg1}"></span><span style="background:${accent}"></span><span style="background:${bg2}"></span></div>
                        <span class="theme-preview-chip">${theme.mode || 'dark'}</span>
                    </div>
                    <div class="theme-preview-bars"><span style="background:${accent}"></span><span></span></div>
                </div>
                <div>
                    <h4>${theme.name}</h4>
                    <p>${theme.description || 'A synced network theme.'}</p>
                </div>
                <div class="theme-card-footer">
                    <div class="theme-badges">
                        ${theme.is_builtin ? '<span class="theme-badge">Built-in</span>' : '<span class="theme-badge">Community</span>'}
                    </div>
                    <button class="btn ${isActive ? 'btn-outline' : 'btn-primary'}" onclick="setTheme('${theme.id}')">${isActive ? 'Active' : 'Use theme'}</button>
                </div>
            </article>
        `;
    }).join('');
    updateThemeSummary(availableThemes.find((theme) => String(theme.id) === String(activeThemeId) || String(theme.slug) === String(activeThemeId)) || availableThemes[0]);
}

async function loadThemes() {
    const grid = document.getElementById('theme-grid');
    if (!grid) return;
    try {
        const [themesData, activeData] = await Promise.all([
            apiFetch('/api/themes?limit=100'),
            apiFetch('/api/themes/me/active'),
        ]);
        availableThemes = themesData.themes || [];
        activeThemeId = activeData.theme_id || 'vibe';
        activeCustomVars = (activeData.custom_variables && typeof activeData.custom_variables === 'object') ? activeData.custom_variables : {};
        const activeTheme = availableThemes.find((theme) => String(theme.id) === String(activeThemeId) || String(theme.slug) === String(activeThemeId));
        activeThemeVars = (activeTheme && activeTheme.variables) || {};
        if (activeTheme) applyThemeToPage(activeTheme);
        if (Object.keys(activeCustomVars).length) applyThemeToPage({ variables: Object.assign({}, activeThemeVars, activeCustomVars) });
        renderThemes();
        renderThemeCustomizer();
    } catch (err) {
        console.error('Failed to load themes:', err);
        grid.innerHTML = '<div class="theme-empty">Unable to load themes right now.</div>';
    }
}

async function setTheme(themeId) {
    try {
        await apiFetch('/api/themes/me', { method: 'PUT', body: JSON.stringify({ theme_id: themeId }) });
        activeThemeId = themeId;
        activeCustomVars = {}; // picking a preset clears custom overrides
        const activeTheme = availableThemes.find((theme) => String(theme.id) === String(themeId) || String(theme.slug) === String(themeId));
        if (activeTheme) {
            activeThemeVars = activeTheme.variables || {};
            renderThemeCustomizer();
            applyThemeToPage(activeTheme);
            localStorage.setItem('ov_theme', JSON.stringify({ id: activeTheme.id, slug: activeTheme.slug, name: activeTheme.name, variables: activeTheme.variables || {} }));
            // Sync theme choice via cookie + OpenVibeThemeLoader (host-only cookie here)
            if (typeof OpenVibeThemeLoader !== 'undefined') OpenVibeThemeLoader.save(activeTheme.slug || activeTheme.id, activeTheme.variables);
            else document.cookie = `ov_theme_id=${encodeURIComponent(activeTheme.slug || activeTheme.id)};path=/;max-age=${365*24*60*60};SameSite=Lax${location.protocol === 'https:' ? ';Secure' : ''}`;
        }
        renderThemes();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ── Custom color editor ──────────────────────────────────────
let activeCustomVars = {};
let activeThemeVars = {};
const THEME_EDITABLE = [
    ['--bg-primary', 'Background'], ['--bg-secondary', 'Surface'], ['--bg-card', 'Card'],
    ['--bg-hover', 'Hover'], ['--accent', 'Accent'], ['--accent-light', 'Accent light'],
    ['--text-primary', 'Text'], ['--text-secondary', 'Muted text'], ['--border', 'Border'],
];
function _hexOrDefault(v) {
    if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim())) return v.trim();
    if (typeof v === 'string' && /^#[0-9a-fA-F]{3}$/.test(v.trim())) {
        const h = v.trim().slice(1); return '#' + h.split('').map(c => c + c).join('');
    }
    return '#888888';
}
function renderThemeCustomizer() {
    const grid = document.getElementById('theme-custom-grid');
    if (!grid) return;
    grid.innerHTML = THEME_EDITABLE.map(([varName, label]) => {
        const val = _hexOrDefault(activeCustomVars[varName] || activeThemeVars[varName]);
        return `<label class="theme-custom-row">
            <input type="color" value="${val}" data-var="${varName}" oninput="_onCustomColorInput(this)">
            <span>${label}</span>
        </label>`;
    }).join('');
}
function toggleThemeCustomizer() {
    const box = document.getElementById('theme-customizer');
    const btn = document.getElementById('theme-custom-toggle');
    if (!box) return;
    const show = box.style.display === 'none';
    box.style.display = show ? '' : 'none';
    if (btn) btn.innerHTML = show ? '<i class="fa-solid fa-chevron-up"></i> Hide' : '<i class="fa-solid fa-pen"></i> Customize';
    if (show) renderThemeCustomizer();
}
function _onCustomColorInput(input) {
    const v = input.getAttribute('data-var');
    activeCustomVars[v] = input.value;
    // Live preview on this page.
    applyThemeToPage({ variables: Object.assign({}, activeThemeVars, activeCustomVars) });
}
async function saveCustomColors(btn) {
    if (btn) btn.disabled = true;
    try {
        await apiFetch('/api/themes/me', { method: 'PUT', body: JSON.stringify({ theme_id: activeThemeId, custom_variables: activeCustomVars }) });
        const merged = Object.assign({}, activeThemeVars, activeCustomVars);
        try { localStorage.setItem('ov_theme', JSON.stringify({ id: activeThemeId, variables: merged })); } catch {}
        if (typeof OpenVibeThemeLoader !== 'undefined') OpenVibeThemeLoader.save(activeThemeId, merged);
        alert('Custom theme saved — it will sync across the network.');
    } catch (err) { alert('Error: ' + err.message); }
    finally { if (btn) btn.disabled = false; }
}
// ── Share a theme (export, import, submit for review; WS-E task 2) ──
async function exportActiveTheme(btn) {
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/themes/' + encodeURIComponent(activeThemeId) + '/export', { credentials: 'include' });
        if (!res.ok) throw new Error('This theme cannot be exported');
        const file = await res.json();
        if (activeCustomVars && Object.keys(activeCustomVars).length) file.variables = Object.assign({}, file.variables, activeCustomVars);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
        a.download = (file.slug || 'theme') + '.openvibe-theme.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) { alert('Error: ' + err.message); }
    finally { if (btn) btn.disabled = false; }
}
async function importThemeFile(input) {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    try {
        const file = JSON.parse(await f.text());
        const out = await apiFetch('/api/themes/import', { method: 'POST', body: JSON.stringify(file) });
        alert('Imported "' + out.theme.name + '". It is waiting for review; you can use it now from your submissions.');
        loadThemeSubmissions();
    } catch (err) { alert('Import failed: ' + err.message); }
}
async function submitMyTheme(ev) {
    ev.preventDefault();
    const name = document.getElementById('theme-submit-name').value.trim();
    const slug = document.getElementById('theme-submit-slug').value.trim();
    const variables = Object.assign({}, activeThemeVars, activeCustomVars);
    try {
        await apiFetch('/api/themes', { method: 'POST', body: JSON.stringify({ name, slug, variables, mode: document.documentElement.dataset.mode === 'light' ? 'light' : 'dark' }) });
        ev.target.reset();
        loadThemeSubmissions();
    } catch (err) { alert('Not submitted: ' + err.message); }
}
async function loadThemeSubmissions() {
    const box = document.getElementById('theme-submissions');
    if (!box) return;
    let list = [];
    try { list = (await apiFetch('/api/themes/me/submissions')).themes || []; } catch { return; }
    box.replaceChildren();
    if (!list.length) return;
    const h = document.createElement('div');
    h.textContent = 'Your submissions';
    h.style.cssText = 'font-weight:600;margin-bottom:6px';
    box.appendChild(h);
    const labels = { pending: 'Waiting for review', approved: 'Approved', rejected: 'Not accepted' };
    for (const t of list) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--border)';
        const n = document.createElement('strong'); n.textContent = t.name;
        const st = document.createElement('span'); st.textContent = labels[t.review_status] || t.review_status;
        st.style.cssText = 'font-size:0.8rem;color:var(--text-secondary)';
        row.append(n, st);
        if (t.review_note) { const note = document.createElement('span'); note.textContent = '— ' + t.review_note; note.style.cssText = 'font-size:0.8rem;color:var(--text-muted)'; row.appendChild(note); }
        if (t.review_status !== 'rejected') {
            const use = document.createElement('button'); use.type = 'button'; use.className = 'btn btn-outline'; use.textContent = 'Use';
            use.onclick = async () => { try { await apiFetch('/api/themes/me', { method: 'PUT', body: JSON.stringify({ theme_id: t.id }) }); location.reload(); } catch (err) { alert('Error: ' + err.message); } };
            row.appendChild(use);
        }
        box.appendChild(row);
    }
}
async function resetCustomColors(btn) {
    if (btn) btn.disabled = true;
    try {
        await apiFetch('/api/themes/me', { method: 'PUT', body: JSON.stringify({ theme_id: activeThemeId, custom_variables: null }) });
        activeCustomVars = {};
        applyThemeToPage({ variables: activeThemeVars });
        renderThemeCustomizer();
    } catch (err) { alert('Error: ' + err.message); }
    finally { if (btn) btn.disabled = false; }
}
