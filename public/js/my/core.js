/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): accounts and tokens, fetch helpers, section routing and anonymous mode.
   Split out of my.html. Classic scripts, global scope: they rely on
   my/core.js's helpers (apiFetch, getAuthToken, showSection, API) and on
   my/boot.js (loaded last), which starts the page. No ES modules.
   ═══════════════════════════════════════════════════════════════ */
const API = window.location.origin;
let currentUser = null;
let availableThemes = [];
let activeThemeId = 'vibe';
const DEFAULT_EMAIL_HINT = 'Used for password resets and any notification emails you enable below.';

const LOCAL_THEME_MAP = {
    '--bg': '--bg-primary',
    '--bg-secondary': '--bg-secondary',
    '--bg-card': '--bg-card',
    '--bg-input': '--bg-input',
    '--border': '--border',
    '--accent': '--accent',
    '--accent-light': '--accent-light',
    '--accent-dark': '--accent-dark',
    '--text': '--text-primary',
    '--text-secondary': '--text-secondary',
    '--text-muted': '--text-muted',
    '--on-accent': '--on-accent',
};

function getStoredAccounts() {
    try { return JSON.parse(localStorage.getItem('openvibe_accounts') || '[]'); }
    catch { return []; }
}

function getActiveAccount() {
    const activeId = localStorage.getItem('openvibe_active_account');
    const accounts = getStoredAccounts();
    if (activeId === 'anon') return accounts.find(a => a?.is_anon) || null;
    return accounts.find(a => String(a?.id) === String(activeId)) || null;
}

function isAnonSession() {
    return !!getActiveAccount()?.is_anon || localStorage.getItem('openvibe_active_account') === 'anon';
}

/** Read ov_token from the host-only cookie (no Domain attribute — CONTRACTS.md) */
function _getCookieToken() {
    const m = document.cookie.match(/(?:^|; )ov_token=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : null;
}

function getAuthToken() {
    if (isAnonSession()) return null;
    return localStorage.getItem('ov_token') || getActiveAccount()?.token || _getCookieToken() || null;
}

function getAnonToken() {
    return localStorage.getItem('openvibe_anon_token') || (getActiveAccount()?.is_anon ? getActiveAccount()?.token : null) || null;
}

/**
 * If localStorage has no token but the cross-domain cookie does,
 * hydrate localStorage so future getAuthToken() calls are instant.
 * Also bootstraps the account list from /api/auth/me.
 * If the token is expired, attempts a silent refresh.
 */
async function _bootstrapFromCookie() {
    if (localStorage.getItem('ov_token')) return; // already have it
    const cookieToken = _getCookieToken();
    if (!cookieToken) return;
    // Store the token in localStorage for this origin
    localStorage.setItem('ov_token', cookieToken);
    // Try to populate the account list
    try {
        const res = await fetchWithTimeout(API + '/api/auth/me', {
            headers: { Authorization: 'Bearer ' + cookieToken, 'Content-Type': 'application/json' },
            credentials: 'include',
        });
        if (res.ok) {
            const data = await res.json();
            const user = data.user || data;
            // Bootstrap openvibe_accounts + openvibe_active_account
            const accounts = [{ id: user.id, username: user.username, display_name: user.display_name || user.username, avatar_url: user.avatar_url || null, email: user.email || null, is_anon: false, token: cookieToken, added_at: Date.now() }];
            localStorage.setItem('openvibe_accounts', JSON.stringify(accounts));
            localStorage.setItem('openvibe_active_account', String(user.id));
        } else if (res.status === 401) {
            // Token expired — try refresh
            const refreshRes = await fetchWithTimeout(API + '/api/auth/refresh', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + cookieToken, 'Content-Type': 'application/json' },
                credentials: 'include',
            });
            if (refreshRes.ok) {
                const refreshData = await refreshRes.json();
                if (refreshData.token) {
                    localStorage.setItem('ov_token', refreshData.token);
                    document.cookie = `ov_token=${refreshData.token};path=/;max-age=${60*60*24*30};SameSite=Lax${location.protocol === 'https:' ? ';Secure' : ''}`;
                    const user = refreshData.user;
                    if (user) {
                        const accounts = [{ id: user.id, username: user.username, display_name: user.display_name || user.username, avatar_url: user.avatar_url || null, email: user.email || null, is_anon: false, token: refreshData.token, added_at: Date.now() }];
                        localStorage.setItem('openvibe_accounts', JSON.stringify(accounts));
                        localStorage.setItem('openvibe_active_account', String(user.id));
                    }
                }
            } else {
                // Refresh failed — clear stale cookie
                localStorage.removeItem('ov_token');
                document.cookie = 'ov_token=;path=/;max-age=0';
            }
        }
    } catch { /* cookie may be expired — loadUser will handle redirect */ }
}

// fetch with an abort timeout so a weak connection can't hang the page forever.
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
        const err = new Error(e && e.name === 'AbortError'
            ? 'Request timed out — check your connection'
            : 'Network error — check your connection');
        err.network = true;
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function apiFetch(path, opts = {}) {
    const headers = { 'Content-Type':'application/json', ...opts.headers };
    const authToken = getAuthToken();
    if (authToken) headers.Authorization = 'Bearer ' + authToken;
    const res = await fetchWithTimeout(API + path, { ...opts, headers, credentials: 'include' });
    // Sliding sessions: the server hands back a renewed token when the old one is due.
    try { const fresh = res.headers.get('X-OV-Token'); if (fresh) { localStorage.setItem('ov_token', fresh); document.cookie = `ov_token=${fresh};path=/;max-age=${60*60*24*90};SameSite=Lax${location.protocol === 'https:' ? ';Secure' : ''}`; } } catch { /* */ }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON (e.g. proxy error page) */ }
    if (!res.ok) { const err = new Error(data.error || res.statusText || 'Request failed'); err.status = res.status; throw err; }
    return data;
}

async function anonFetch(path, opts = {}) {
    const headers = { 'Content-Type':'application/json', ...opts.headers };
    const res = await fetchWithTimeout(API + path, { ...opts, headers, credentials: 'include' });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) { const err = new Error(data.error || res.statusText || 'Request failed'); err.status = res.status; throw err; }
    return data;
}

// Section switching
function showSection(id, btn) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.section-tabs button').forEach(b => b.classList.remove('active'));
    document.getElementById('sec-' + id).classList.add('active');
    const targetBtn = btn || [...document.querySelectorAll('.section-tabs button')].find((button) => button.getAttribute('onclick')?.includes(`'${id}'`));
    targetBtn?.classList.add('active');
    history.replaceState(null, '', id === 'profile' ? window.location.pathname : `${window.location.pathname}#${id}`);
    if (id === 'history' && typeof loadHistory === 'function') loadHistory();
    if (id === 'data') loadDataSection();
}

function openInitialSection() {
    const pathSection = { '/themes': 'themes', '/notifications': 'notifications', '/verify-email': 'notifications', '/linked': 'linked', '/security': 'security', '/profile': 'profile', '/history': 'history' }[window.location.pathname];
    const routeSection = pathSection || window.location.hash.replace(/^#/, '') || 'profile';
    if (window.location.pathname === '/verify-email') setTimeout(handleVerifyEmailToken, 50);
    if (isAnonSession() && ['notifications','linked','security','data'].includes(routeSection)) {
        return showSection('anon');
    }
    if (document.getElementById('sec-' + routeSection)) {
        showSection(routeSection);
    }
}

function setSectionDisabled(sectionId, message) {
    const section = document.getElementById('sec-' + sectionId);
    if (!section) return;
    section.innerHTML = `
        <div class="card">
            <h3><span class="icon"><i class="fa-solid fa-user-secret"></i></span> Anonymous Mode</h3>
            <p>${message}</p>
        </div>
    `;
}

function applyAnonModeUI(user) {
    document.getElementById('pf-bio').disabled = true;
    document.getElementById('pf-email').disabled = true;
    document.getElementById('pf-color').disabled = true;
    document.getElementById('pf-bio').value = '';
    document.getElementById('pf-email').value = '';
    document.getElementById('pf-bio').placeholder = 'Anonymous mode does not store bios.';
    document.getElementById('pf-email').placeholder = 'Anonymous mode does not use email addresses';
    const emailHint = document.querySelector('#sec-profile .hint');
    if (emailHint) emailHint.textContent = 'Anonymous mode only stores lightweight preferences like your display name.';
    const saveButton = document.querySelector('#profile-form .btn-primary');
    if (saveButton) saveButton.textContent = 'Save Anon Preferences';

    const notifTab = [...document.querySelectorAll('.section-tabs button')].find((button) => button.getAttribute('onclick')?.includes("'notifications'"));
    const linkedTab = [...document.querySelectorAll('.section-tabs button')].find((button) => button.getAttribute('onclick')?.includes("'linked'"));
    const securityTab = [...document.querySelectorAll('.section-tabs button')].find((button) => button.getAttribute('onclick')?.includes("'security'"));
    [notifTab, linkedTab, securityTab].forEach((button) => {
        if (!button) return;
        button.style.opacity = '.45';
        button.title = 'Unavailable in anonymous mode';
    });

    setSectionDisabled('notifications', 'Notification inbox, email preferences, and alert delivery are only available for full accounts.');
    setSectionDisabled('linked', 'Linked services are only available once you sign in with a full OpenVibe account.');
    setSectionDisabled('security', 'Anonymous identities do not have passwords or device sessions to manage.');

    const themeGrid = document.getElementById('theme-grid');
    if (themeGrid) {
        themeGrid.innerHTML = '<div class="theme-empty">Theme syncing is unavailable for anonymous sessions right now.</div>';
    }
    const currentName = document.getElementById('theme-current-name');
    if (currentName) currentName.textContent = 'Anon sessions do not sync themes';
}

// Small helpers (my.html has no global toast/esc of its own).
if (typeof window.esc !== 'function') window.esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
if (typeof window.toast !== 'function') window.toast = (msg, type = 'info') => {
    let c = document.getElementById('my-toasts');
    if (!c) { c = document.createElement('div'); c.id = 'my-toasts'; c.style.cssText = 'position:fixed;top:78px;right:16px;z-index:100001;display:flex;flex-direction:column;gap:8px;max-width:360px'; document.body.appendChild(c); }
    const t = document.createElement('div');
    t.style.cssText = `padding:10px 14px;border-radius:10px;font-size:13px;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.35);background:${type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#4c4c5e'}`;
    t.textContent = msg; c.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4500);
};
