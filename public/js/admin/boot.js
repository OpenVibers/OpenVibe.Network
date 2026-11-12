/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): the tabLoaders map, sign-in bootstrap and init() (loaded last).
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// Network's own page list: the shared navbar's fallback (Home, My Account, Themes) is not this host's list.
const OV_PAGE_LINKS = [{"label":"Network","href":"/"},{"label":"Link","href":"https://openvibe.link/","icon":"fa-desktop","featured":true},{"label":"My Account","href":"https://openvibe.my/"},{"label":"Wallet","href":"/wallet"},{"label":"Themes","href":"/themes"}];
const tabLoaders = {
    setup: loadSetup,
    glossary: loadGlossary,
    dashboard: loadDashboard,
    users: loadUsers,
    streams: loadStreams,
    lineage: () => loadLineage(),
    bans: loadBans,
    'chat-logs': () => {}, // manual search
    moderators: loadModerators,
    settings: loadSettings,
    tts: loadTTS,
    cashouts: () => {}, // a pointer to OpenVibe.Billing's console
    payments: loadPayments,
    ai: loadAi,
    'ai-setup': loadAiSetup,
    guide: loadGuide,
    pastes: loadPastesAdmin,
    storage: loadStorage,
    notifications: () => {},
    email: loadEmail,
    vkeys: loadVKeys,
    audit: loadAudit,
    modlog: () => loadModLog(true),
    grants: () => loadGrants(),
    themes: () => loadThemeReview(),
    checklist: () => loadOperatorChecklist(),
    eventsops: () => loadDeliveries(),
    analytics: loadAnalytics,
    deploy: loadDeployOverview,
    domains: loadDomains,
    ssh: loadSSH,
};

// ═══════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════
function _adminLoginRedirect() {
    window.location.href = '/login?return=' + encodeURIComponent(window.location.href);
}

// Silent sliding refresh: exchange the current (possibly just-expired) token for a
// fresh one, same as index.html/my.html. Returns true if a new token was stored.
async function _adminTryRefresh() {
    try {
        const res = await fetch(API + '/api/auth/refresh', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + (token || ''), 'Content-Type': 'application/json' },
            credentials: 'include',
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => ({}));
        if (data && data.token) { token = data.token; localStorage.setItem('ov_token', data.token); return true; }
        return false;
    } catch { return false; }
}

async function _bootAdmin() {
    const data = await api('/api/auth/me');
    currentUser = data.user || data;
    if (currentUser.role !== 'admin') {
        document.querySelector('.page').innerHTML = '<div class="card" style="text-align:center;padding:60px"><h3 style="color:var(--live-red-text, var(--live-red))"><i class="fa-solid fa-lock"></i> Access Denied</h3><p class="muted" style="margin-top:8px">Admin privileges required.</p></div>';
        return;
    }
    // Owner-only UI (Deploy tab, etc.) — hide for plain admins.
    if (!currentUser.is_owner) {
        document.querySelectorAll('.owner-only').forEach(el => { el.style.display = 'none'; });
    }
    // Init navbar
    if (window.OpenVibeNavbar) {
        OpenVibeNavbar.init({ service: 'network', token, user: currentUser, links: OV_PAGE_LINKS });
        const bellMount = OpenVibeNavbar.getBellMount();
        if (bellMount && window.OpenVibeNotifications) {
            OpenVibeNotifications.init({ mountEl: bellMount, apiBase: API, token });
        }
    }
    initMainTabsOverflow();
    // Open the tab from the URL slug (or restore the last-visited location).
    routeFromUrl();
}

async function init() {
    if (!token) { _adminLoginRedirect(); return; }
    try {
        await _bootAdmin();
    } catch (e) {
        // Invalid/expired token → try one silent refresh, then retry; if that fails,
        // send the user through the OAuth login instead of showing a dead-end error.
        if (await _adminTryRefresh()) {
            try { await _bootAdmin(); return; } catch { /* fall through to login */ }
        }
        _adminLoginRedirect();
    }
}

init();
