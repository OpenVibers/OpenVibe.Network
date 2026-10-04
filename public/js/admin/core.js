/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): state, helpers (api, esc, toast, fmtBytes), tabs and URL routing.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════
   OpenVibe — Unified Admin Panel
   ═══════════════════════════════════════════════════════════════ */

const API = window.location.origin;
let token = localStorage.getItem('ov_token');
let currentUser = null;

// ── Helpers ──────────────────────────────────────────────────
// Attribute-safe: also escapes quotes, otherwise any value containing '"' (e.g. JSON) is cut
// short inside value="..." — which is how JSON settings got rendered as '{' and saved back as '{'.
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function timeAgo(dateStr) {
    const d = new Date(dateStr);
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString();
}

function fmtBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec) {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function toast(msg, type = 'info') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3500);
}

async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (token) headers.Authorization = 'Bearer ' + token;
    const fetchOpts = { ...opts, headers, credentials: 'include' };
    if (opts.body && typeof opts.body === 'object') fetchOpts.body = JSON.stringify(opts.body);
    const res = await fetch(API + path, fetchOpts);
    const data = await res.json();
    if (!res.ok) {
        // Keep the payload: endpoints that reject with structured detail (e.g. the cookie
        // validator explaining WHICH check failed) are useless if only the message survives.
        const err = new Error(data.error || 'Request failed');
        err.body = data;
        err.status = res.status;
        throw err;
    }
    return data;
}

// Auth headers for raw fetch() calls (SSH tab, Deploy tab, etc.).
function authHeaders() {
    const h = {};
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
}

// ── Tab switching ────────────────────────────────────────────
let currentTab = 'dashboard';
// Tabs restricted to the network owner (API keys / money / infrastructure / core settings).
// NOTE: 'ai' is NOT here — admins may use its analytics/explorer tools; only the
// AI configuration form inside it is owner-gated (see loadAi).
const OWNER_ONLY_TABS = new Set(['deploy', 'domains', 'payments', 'cashouts', 'storage', 'email', 'settings', 'grants', 'eventsops']);

function showTab(id, btn) {
    if (!tabLoaders[id]) id = 'dashboard';
    // Owner-only tabs (secrets / money / infra) — bounce non-owners to dashboard.
    if (OWNER_ONLY_TABS.has(id) && currentUser && !currentUser.is_owner) id = 'dashboard';
    currentTab = id;
    btn = btn || _tabButton(id);
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('#main-tabs .admin-tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('sec-' + id)?.classList.add('active');
    btn?.classList.add('active');
    btn?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    setTimeout(checkMainTabsOverflow, 180);
    tabLoaders[id]?.();
    _syncAdminUrl();
}

/* ── Admin URL routing (History API + slugs + localStorage) ──────────
   /admin/<tab>[/<subtab>][?last=30d]  e.g. /admin/settings,
   /admin/analytics/openvibelive?last=12h. On load a slug wins; otherwise the
   last-visited location is restored from localStorage. */
let deployCurrentSubTab = 'overview';
let _applyingRoute = false;

function _tabButton(id) {
    return [...document.querySelectorAll('#main-tabs .admin-tab-btn')]
        .find(b => (b.getAttribute('onclick') || '').includes(`showTab('${id}'`)) || null;
}
function _subBtn(containerId, tab) {
    return [...document.querySelectorAll(`#${containerId} button`)]
        .find(b => (b.getAttribute('onclick') || '').includes(`('${tab}'`)) || null;
}

// Analytics period ↔ URL param. Day options become "<n>d"; hour/3d pass through.
function periodToUrlParam(v) {
    if (v == null) return '';
    v = String(v);
    return /^\d+$/.test(v) ? v + 'd' : v;   // 30 -> 30d ; 12h/3d stay
}
function urlParamToPeriod(p) {
    if (!p) return null;
    p = String(p).toLowerCase().trim();
    const alias = { '1y': '365', '365d': '365', '1d': '24h', '24': '24h' };
    if (alias[p]) return alias[p];
    if (/^\d+d$/.test(p)) return p.slice(0, -1);          // 30d -> 30
    const valid = ['1h', '12h', '24h', '3d', '7', '14', '30', '90', '365'];
    if (valid.includes(p)) return p;
    if (/^\d+$/.test(p)) return p;                        // bare day count
    return null;
}

function _adminPath() {
    if (currentTab === 'analytics') return '/admin/analytics/' + (analyticsCurrentSubTab || 'overview');
    if (currentTab === 'deploy') return '/admin/deploy/' + (deployCurrentSubTab || 'overview');
    if (currentTab && currentTab !== 'dashboard') return '/admin/' + currentTab;
    return '/admin';
}
function _syncAdminUrl(replace) {
    if (_applyingRoute) return;
    let url = _adminPath();
    if (currentTab === 'analytics') {
        const per = document.getElementById('analytics-period')?.value;
        if (per) url += '?last=' + periodToUrlParam(per);
    }
    try { history[replace ? 'replaceState' : 'pushState']({ adminTab: currentTab }, '', url); } catch { /* */ }
    try { localStorage.setItem('openvibe_admin_last_path', url); } catch { /* */ }
}

function routeFromUrl() {
    _applyingRoute = true;
    try {
        let rest = location.pathname.replace(/^\/admin\/?/, '');
        let parts = rest.split('/').filter(Boolean);
        let search = location.search;
        // Bare /admin → restore last-visited location (a real slug always wins).
        if (parts.length === 0) {
            const last = localStorage.getItem('openvibe_admin_last_path');
            if (last && last !== '/admin' && last.startsWith('/admin')) {
                try { history.replaceState({}, '', last); } catch { /* */ }
                const u = new URL(last, location.origin);
                parts = u.pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
                search = u.search;
            }
        }
        let tab = parts[0];
        const sub = parts[1] || null;
        if (!tab || !tabLoaders[tab]) tab = 'dashboard';
        const per = urlParamToPeriod(new URLSearchParams(search).get('last'));
        if (tab === 'analytics' && per) {
            const sel = document.getElementById('analytics-period'); if (sel) sel.value = per;
        }
        showTab(tab, _tabButton(tab));
        // Use the effective tab (showTab may bounce a non-owner off /admin/deploy).
        if (currentTab === 'analytics' && sub) showAnalyticsSubTab(sub, _subBtn('analytics-sub-tabs', sub));
        else if (currentTab === 'deploy' && sub) showDeploySubTab(sub, _subBtn('deploy-sub-tabs', sub));
    } finally {
        _applyingRoute = false;
        _syncAdminUrl(true); // normalize (e.g. /admin/analytics -> /admin/analytics/overview)
    }
}

window.addEventListener('popstate', () => routeFromUrl());

function checkMainTabsOverflow() {
    const tabs = document.getElementById('main-tabs');
    if (!tabs) return;
    const left = document.getElementById('main-tabs-left');
    const right = document.getElementById('main-tabs-right');
    const hasOverflow = tabs.scrollWidth > tabs.clientWidth + 2;
    const atStart = tabs.scrollLeft <= 1;
    const atEnd = tabs.scrollLeft >= tabs.scrollWidth - tabs.clientWidth - 1;
    left?.classList.toggle('visible', hasOverflow && !atStart);
    right?.classList.toggle('visible', hasOverflow && !atEnd);
}

function scrollMainTabs(dir) {
    const tabs = document.getElementById('main-tabs');
    if (!tabs) return;
    tabs.scrollBy({ left: dir * 180, behavior: 'smooth' });
    let checks = 0;
    let lastPos = tabs.scrollLeft;
    const poll = setInterval(() => {
        checkMainTabsOverflow();
        if (tabs.scrollLeft === lastPos || ++checks > 12) clearInterval(poll);
        lastPos = tabs.scrollLeft;
    }, 60);
}

function initMainTabsOverflow() {
    const tabs = document.getElementById('main-tabs');
    if (!tabs) return;
    tabs.addEventListener('scroll', checkMainTabsOverflow, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(checkMainTabsOverflow).observe(tabs);
    }
    window.addEventListener('resize', checkMainTabsOverflow);
    setTimeout(checkMainTabsOverflow, 100);
}
