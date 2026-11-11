/**
 * login.js — the sign-in page (/login, /forgot-password, /reset-password): the saved-account
 * chooser, the login / register / reset forms and the safe post-sign-in redirect.
 * Moved verbatim out of login.html's inline <script>; the init IIFE at the end runs on load.
 */
const API_BASE = window.location.origin;
const params = new URLSearchParams(window.location.search);
const isOAuth = params.has('client_id') && params.has('redirect_uri');
// ?reauth=1 is the one real re-authentication path (deleting the account, merging, the owner's AI settings,
// Locker reset/forget). It always shows the password form, even when this browser has a saved session:
// add_account=1 reuses that session and leaves auth_time alone, which is what made "Sign in again" loop.
const isReauth = params.get('reauth') === '1';
/** The username the re-authentication form starts with: login_hint when given ('' means blank), else the active account. */
function reauthUsername(accounts) {
    if (params.has('login_hint')) return String(params.get('login_hint') || '').trim().replace(/^@/, '');
    let activeId = null;
    try { activeId = localStorage.getItem('openvibe_active_account'); } catch { /* private mode */ }
    const account = accounts.find((a) => String(a.id) === String(activeId)) || accounts[0];
    return account ? String(account.username || '') : '';
}
// The app's name comes from the Network (GET /oauth/client-info), never from this page's URL:
// a crafted link could otherwise claim to be any app. Until it answers, show nothing.
let clientName = '';
let clientHost = '';
if (isOAuth) {
    fetch(`${API_BASE}/oauth/client-info?${new URLSearchParams({ client_id: params.get('client_id'), redirect_uri: params.get('redirect_uri'),
        code_challenge: params.get('code_challenge') || '', code_challenge_method: params.get('code_challenge_method') || '',
        scope: params.get('scope') || '' })}`, { credentials: 'omit' })
        .then(r => (r.ok ? r.json() : null))
        .then((info) => {
            if (!info || !info.name) return;
            clientName = info.third_party ? `${info.name} (third-party app)` : info.name;
            clientHost = info.third_party ? info.redirect_host || '' : '';
            renderChooserSubtitle();
            renderConsent(info);
            maybeContinue(info);
        })
        .catch(() => {});
}

/**
 * The consent screen (plan T2, docs/t2-projects-and-grants.md §9): what a third-party app may do if you continue,
 * from the Network's own answer (the capability catalog's names and descriptions, sensitive ones marked), never from
 * this page's URL. A request that names nothing gets nothing: the app only learns which account you are. Built from
 * DOM nodes: names and descriptions come from the catalog, the app's name from its developer.
 */
function renderConsent(info) {
    const box = document.getElementById('oauth-consent');
    const purposes = info && Array.isArray(info.purposes) ? info.purposes : [];
    if (!box || !info || (!info.third_party && !info.act_as_you && !purposes.length)) return;
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    box.replaceChildren();
    // An app's permission questions (consent:<purpose>): named here, asked one by one after the account is chosen.
    const asks = () => {
        if (!purposes.length) return;
        const p = el('p', 'consent-purposes', 'It will also ask your permission for: ');
        purposes.forEach((x, i) => { if (i) p.append(', '); p.append(el('b', null, x.title || x.id)); });
        p.append('. Each one stays off unless you tick it.');
        box.append(p);
    };
    // An app that acts AS the person (OpenVibe Link on the phone) says so in the Network's own words, every time:
    // it is never signed in silently and is never shown as a plain first-party site.
    if (info.act_as_you) {
        const head = el('p', 'consent-head');
        head.append(el('b', null, info.name), ' ');
        head.append(el('span', null, info.consent_text || 'will act as you.'));
        box.append(head);
        asks();
        box.hidden = false;
        return;
    }
    if (!info.third_party) {
        const head = el('p', 'consent-head');
        head.append(el('b', null, info.name), ' asks for your permission after you choose an account.');
        box.append(head);
        asks();
        box.dataset.onlyPurposes = '1';
        box.hidden = false;
        return;
    }
    const head = el('p', 'consent-head');
    head.append(el('b', null, info.name), ' ');
    if (info.redirect_host) head.append(el('span', 'consent-host', `(${info.redirect_host})`), ' ');
    const caps = Array.isArray(info.capabilities) ? info.capabilities : [];
    head.append(caps.length ? 'is a third-party app. If you continue, it can:' : 'is a third-party app.');
    box.append(head);
    if (caps.length) {
        const list = el('ul');
        for (const c of caps) {
            const li = el('li', c.sensitive ? 'sensitive' : null);
            li.append(el('span', 'consent-name', c.name || c.id));
            if (c.sensitive) li.append(el('span', 'consent-badge', 'Sensitive'));
            if (c.description) li.append(el('small', null, c.description));
            list.append(li);
        }
        box.append(list);
    } else if (!purposes.length) {
        box.append(el('p', 'consent-none', 'It asks for nothing else: it will only learn which OpenVibe account you are.'));
    }
    asks();
    const refused = Array.isArray(info.refused) ? info.refused : [];
    if (refused.length) {
        const p = el('p', 'consent-refused', 'It also asked for what it cannot be given, so it will not get: ');
        refused.forEach((id, i) => { if (i) p.append(', '); p.append(el('code', null, id)); });
        box.append(p);
    }
    box.hidden = false;
}
let oauthConfirmInFlight = false;

// Generate particles
(function() {
    const container = document.getElementById('particles');
    for (let i = 0; i < 30; i++) {
        const p = document.createElement('div');
        p.className = 'p';
        p.style.left = Math.random() * 100 + '%';
        p.style.animationDuration = (8 + Math.random() * 12) + 's';
        p.style.animationDelay = -(Math.random() * 20) + 's';
        p.style.width = p.style.height = (1 + Math.random() * 2) + 'px';
        container.appendChild(p);
    }
})();

// ── Saved Accounts ──────────────────────────────────────────
// ov_token is host-only on openvibe.network — NO Domain attribute (CONTRACTS.md).
function clearAuthCookie() {
    document.cookie = 'ov_token=;path=/;max-age=0;SameSite=Lax';
}

function setAuthCookie(token) {
    const secure = location.protocol === 'https:' ? ';Secure' : '';
    document.cookie = `ov_token=${token};path=/;max-age=${60*60*24*90};SameSite=Lax${secure}`;
}

function clearLocalAuthState() {
    clearAuthCookie();
    localStorage.removeItem('ov_token');
    localStorage.removeItem('openvibe_active_account');
}

function isLoginLikeRedirect(target) {
    try {
        const parsed = new URL(target, window.location.origin);
        const pathname = (parsed.pathname || '/').toLowerCase();
        return pathname === '/login' || pathname === '/login.html' || pathname === '/auth/login';
    } catch {
        return true;
    }
}

function getSavedAccounts() {
    try { return JSON.parse(localStorage.getItem('openvibe_accounts') || '[]').filter(a => a && a.token && !a.is_anon); }
    catch { return []; }
}

function getAllAccounts() {
    try { return JSON.parse(localStorage.getItem('openvibe_accounts') || '[]').filter(a => a && a.token); }
    catch { return []; }
}

function saveAccount(user, token) {
    const accounts = getAllAccounts().filter(a => !a.is_anon);
    const idx = accounts.findIndex(a => a.id === user.id);
    const entry = {
        id: user.id,
        username: user.username,
        display_name: user.display_name || user.username,
        avatar_url: user.avatar_url || null,
        email: user.email || null,
        token,
        is_anon: false,
    };
    if (idx !== -1) accounts[idx] = entry;
    else accounts.push(entry);
    localStorage.setItem('openvibe_accounts', JSON.stringify(accounts));
    localStorage.setItem('openvibe_active_account', user.id);
    return entry;
}

function saveAnonAccount(user, token) {
    const accounts = getAllAccounts().filter(a => !a.is_anon);
    const entry = {
        id: 'anon',
        username: user.username,
        display_name: user.display_name || user.username,
        avatar_url: null,
        email: null,
        token,
        is_anon: true,
        anon_number: user.anon_number || null,
    };
    accounts.push(entry);
    localStorage.setItem('openvibe_accounts', JSON.stringify(accounts));
    localStorage.setItem('openvibe_anon_token', token);
    localStorage.setItem('openvibe_active_account', 'anon');
    return entry;
}

function prefillAccount(account, msg) {
    try {
        if (typeof switchTab === 'function') { try { switchTab('login'); } catch { /* */ } }
        const u = document.querySelector('form input[name="username"]');
        const pw = document.querySelector('form input[name="password"]');
        if (u) u.value = account.username || '';
        if (pw) { pw.value = ''; pw.focus(); }
    } catch { /* */ }
    toast(msg || 'Enter your password to continue.', 'info');
}
function removeAccount(id) {
    const accounts = getSavedAccounts().filter(a => a.id !== id);
    localStorage.setItem('openvibe_accounts', JSON.stringify(accounts));
    renderChooser();
    if (accounts.length === 0) showAuthForm('login');
}

// ── View Management ─────────────────────────────────────────
let hasAccounts = false;

function setPrimaryExtrasVisible(visible) {
    const display = visible ? '' : 'none';
    document.querySelectorAll('.login-card > .divider').forEach(d => d.style.display = display);
    const anonBtn = document.querySelector('.anon-btn');
    if (anonBtn) anonBtn.style.display = display;
}

function setActivePanel(panelId, { showTabs = true, activeTab = null, showExtras = true } = {}) {
    document.querySelectorAll('.form-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-bar button').forEach(b => b.classList.remove('active'));
    document.getElementById('auth-tabs').style.display = showTabs ? '' : 'none';
    document.getElementById(panelId).classList.add('active');
    setPrimaryExtrasVisible(showExtras);
    if (activeTab) {
        const buttons = document.querySelectorAll('.tab-bar button');
        const idx = activeTab === 'register' ? 1 : 0;
        buttons[idx]?.classList.add('active');
    }
}

function showChooser() {
    setActivePanel('panel-chooser', { showTabs: false, showExtras: true });
}

function showAuthForm(tab) {
    setActivePanel('panel-' + tab, { showTabs: true, activeTab: tab, showExtras: true });
    // Show "back" links if we have saved accounts
    if (hasAccounts) {
        document.getElementById('login-back').style.display = '';
        document.getElementById('register-back').style.display = '';
    }
}

function switchTab(tab, evt) {
    if (evt?.preventDefault) evt.preventDefault();
    showAuthForm(tab);
}

function showForgotForm() {
    const forgotBack = document.getElementById('forgot-back');
    forgotBack.textContent = hasAccounts ? '← Back to saved accounts' : '← Back to sign in';
    setActivePanel('panel-forgot', { showTabs: false, showExtras: false });
}

function returnFromRecovery() {
    if (hasAccounts) return showChooser();
    showAuthForm('login');
}

function showResetForm(token) {
    document.getElementById('reset-token').value = token || '';
    setActivePanel('panel-reset', { showTabs: false, showExtras: false });
}

// ── Continue as the account just chosen ─────────────────────
// An app's sign-in shows the chooser, the way Google's does (the owner, 2026-10-26: signing out and back in "immediately
// logs you in and doesn't allow you to choose"). Seamless sign-in across sites is the sites' silent one (prompt=none,
// answered by /oauth/authorize without this page). The chooser continues by itself only for an account the person chose
// a moment ago in this tab (a site menu's switch or "add another account": rememberChoice before going back through the
// site's sign-in) or one the site names (login_hint, OpenID Connect). Never for a third-party app (its consent), never
// when the site asks for the chooser (prompt=select_account | login), never as an anonymous account.
const CONTINUE_KEY = 'ov_continue_as';
const CONTINUE_MS = 2 * 60 * 1000;
function rememberChoice(id) {
    try { sessionStorage.setItem(CONTINUE_KEY, JSON.stringify({ id: String(id), at: Date.now() })); } catch { /* this tab only */ }
}
function takeChoice() {
    try {
        const raw = sessionStorage.getItem(CONTINUE_KEY);
        sessionStorage.removeItem(CONTINUE_KEY);
        const c = raw ? JSON.parse(raw) : null;
        return c && c.id && Date.now() - Number(c.at) < CONTINUE_MS ? String(c.id) : null;
    } catch { return null; }
}
let autoContinued = false;
function maybeContinue(info) {
    if (autoContinued || !isOAuth || !info) return;
    // An app that acts as the person is chosen by the person, in this tab: its sentence is read before any code.
    if (info.third_party || info.act_as_you) return;
    const chosen = takeChoice();
    if (['select_account', 'login'].includes(params.get('prompt') || '')) return;
    const hint = String(params.get('login_hint') || '').trim().replace(/^@/, '').toLowerCase();
    const accounts = getSavedAccounts().filter(a => !a.is_anon);
    const account = (chosen && accounts.find(a => String(a.id) === chosen))
        || (hint && accounts.find(a => String(a.username || '').toLowerCase() === hint || String(a.id) === hint));
    if (!account) return;
    autoContinued = true;
    const subtitle = document.getElementById('chooser-subtitle');
    if (subtitle) subtitle.textContent = `Continuing to ${info.name} as ${account.display_name || account.username}…`;
    selectAccount(account);
}

/** The sign-in form with a username filled in (login_hint, or a saved account that needs its password again). */
function prefillUsername(name) {
    const v = String(name || '').trim().replace(/^@/, '');
    const u = document.querySelector('#login-form input[name="username"]');
    if (!v || !u || u.value) return;
    u.value = v;
    const pw = document.querySelector('#login-form input[name="password"]');
    if (pw) pw.focus();
}

// ── Render Account Chooser ──────────────────────────────────
function renderChooserSubtitle() {
    const subtitle = document.getElementById('chooser-subtitle');
    if (!subtitle) return;
    if (isOAuth && clientName) {
        subtitle.innerHTML = `Choose an account to continue to <span class="app-name">${escapeHtml(clientName)}</span>`
            + (clientHost ? ` <span class="app-host">(${escapeHtml(clientHost)})</span>` : '');
    } else {
        subtitle.textContent = 'Choose an account to continue';
    }
}

function renderChooser() {
    const accounts = getSavedAccounts();
    const list = document.getElementById('account-list');
    const activeId = localStorage.getItem('openvibe_active_account');
    list.innerHTML = '';

    renderChooserSubtitle();

    accounts.forEach(account => {
        const item = document.createElement('div');
        item.className = 'account-item' + (String(account.id) === String(activeId) ? ' active-account' : '');
        // The picture by username (/avatar/<name> answers the current one): a remembered avatar_url goes stale when the
        // person changes it, and showed as a broken image. If none loads, the initial.
        const avatarSrc = account.username ? `${API_BASE}/avatar/${encodeURIComponent(account.username)}` : account.avatar_url;
        const initial = escapeHtml(String(account.display_name || account.username || '?').trim().charAt(0).toUpperCase() || '?');
        const avatarContent = avatarSrc
            ? `<img src="${escapeHtml(avatarSrc)}" alt="">`
            : '<span class="ov-mark" data-size="28" data-static="1"></span>';
        item.innerHTML = `
            <div class="avatar">${avatarContent}</div>
            <div class="info">
                <div class="name">${escapeHtml(account.display_name || account.username)}</div>
                <div class="detail">${escapeHtml(account.username)}${account.email ? ' · ' + escapeHtml(account.email) : ''}</div>
            </div>
            <span class="arrow">→</span>
            <button class="remove-btn" title="Remove this saved account" onclick="event.stopPropagation(); removeAccount(${account.id})"><i class="fa-solid fa-xmark"></i></button>
        `;
        const img = item.querySelector('.avatar img');
        if (img) img.addEventListener('error', () => { img.parentElement.innerHTML = `<span class="avatar-initial">${initial}</span>`; }, { once: true });
        item.addEventListener('click', () => selectAccount(account));
        list.appendChild(item);
    });
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ── /oauth/confirm, and the purposes step ───────────────────
/** POST /oauth/confirm for this sign-in. `consent` is the person's answer on the purposes step, when there was one. */
async function postConfirm(token, consent, emailAddressId) {
    const res = await fetch(API_BASE + '/oauth/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            token,
            client_id: params.get('client_id'),
            redirect_uri: params.get('redirect_uri'),
            scope: params.get('scope') || 'profile theme',
            state: params.get('state') || '',
            code_challenge: params.get('code_challenge') || undefined,
            code_challenge_method: params.get('code_challenge_method') || undefined,
            nonce: params.get('nonce') || undefined,
            ...(consent ? { consent } : {}),
            ...(emailAddressId ? { email_address_id: emailAddressId } : {}),
        }),
    });
    let data = {};
    try { data = await res.json(); } catch { /* an empty answer is an error below */ }
    return { res, data };
}

/** Confirm the sign-in; when the app asks for permission (consent:<purpose>), the person answers first. */
async function confirmWithPurposes(token) {
    let out, consent, emailAddressId;
    const before = (document.querySelector('.form-panel.active') || {}).id || 'panel-chooser';
    for (let step = 0; step < 3; step++) {
        out = await postConfirm(token, consent, emailAddressId);
        if (!out.res.ok || !out.data) break;
        if (out.data.email_choice) {
            oauthConfirmInFlight = false;
            emailAddressId = await askEmailAddress(out.data.email_choice);
            oauthConfirmInFlight = true;
            if (!emailAddressId) return out;
            continue;
        }
        if (out.data.consent) {
            oauthConfirmInFlight = false;
            consent = await askPurposes(out.data.consent);
            oauthConfirmInFlight = true;
            continue;
        }
        break;
    }
    if (!out?.res.ok) setActivePanel(before, { showTabs: before === 'panel-login' || before === 'panel-register', showExtras: true });
    return out;
}

/** The app's email scope shares one verified address; primary starts selected and the list stays in this consent step. */
function askEmailAddress(step) {
    const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const head = document.getElementById('purposes-head');
    head.replaceChildren(make('b', null, clientName || 'This app'), ' asks which one verified email address you want to share.');
    const list = document.getElementById('purposes-list');
    list.replaceChildren(make('legend', 'sr-only', 'Choose one email address'));
    let selected = '';
    (Array.isArray(step.addresses) ? step.addresses : []).forEach((address) => {
        const row = make('label', 'purpose-item');
        const radio = make('input', 'purpose-box'); radio.type = 'radio'; radio.name = 'email-address-choice'; radio.value = address.id;
        radio.checked = address.id === step.selected_id || (!step.selected_id && !!address.primary); if (radio.checked) selected = address.id;
        radio.addEventListener('change', () => { if (radio.checked) selected = radio.value; });
        row.append(radio, make('span', 'purpose-text', `${address.email}${address.primary ? ' (primary)' : ''}`));
        list.append(row);
    });
    document.getElementById('purposes-adult').hidden = true;
    document.getElementById('purposes-already').hidden = true;
    const btn = document.getElementById('purposes-continue');
    btn.textContent = 'Share this address and continue'; btn.disabled = !selected;
    list.onchange = () => { btn.disabled = !selected; };
    const intro = document.getElementById('oauth-consent'); if (intro) intro.hidden = true;
    setActivePanel('panel-purposes', { showTabs: false, showExtras: false });
    head.focus();
    return new Promise((resolve) => { document.getElementById('purposes-form').onsubmit = (event) => {
        event.preventDefault(); if (!selected) return; event.target.onsubmit = (ev) => ev.preventDefault(); btn.disabled = true; resolve(selected);
    }; });
}

/**
 * The purposes step (the consent plan's C4): the app asks for your permission, one purpose at a time, in the Network's
 * own words. Every box starts unticked, and Continue works with none ticked: the app then learns only "not granted".
 * A purpose marked 18+ asks for "I am 18 or older" unless the account already confirmed it. Built from DOM nodes.
 * Resolves with the answer /oauth/confirm records: { shown, allow, adult, text_version }.
 */
function askPurposes(step) {
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const ask = Array.isArray(step.ask) ? step.ask : [];
    const granted = Array.isArray(step.granted) ? step.granted : [];
    const head = document.getElementById('purposes-head');
    head.replaceChildren(el('b', null, clientName || 'This app'), ' asks for your permission. Tick only what you want to allow.');
    const list = document.getElementById('purposes-list');
    list.replaceChildren(el('legend', 'sr-only', 'What this app may do'));
    for (const p of ask) {
        const item = el('label', 'purpose-item');
        const box = el('input', 'purpose-box');
        box.type = 'checkbox';
        box.value = p.id;
        box.checked = false;
        const text = el('span', 'purpose-text');
        const title = el('span', 'purpose-title', p.title || p.id);
        if (p.adults_only) title.append(' ', el('span', 'purpose-badge', '18+'));
        text.append(title, el('small', null, p.allows || ''));
        if (p.cannot_undo) text.append(el('small', 'purpose-undo', `If you turn it off later: ${p.cannot_undo}`));
        item.append(box, text);
        list.append(item);
    }
    const needsAdult = !step.adult && ask.some((p) => p.adults_only);
    const adultRow = document.getElementById('purposes-adult');
    const adultBox = document.getElementById('purposes-adult-box');
    adultBox.checked = false;
    adultRow.hidden = !needsAdult;
    const already = document.getElementById('purposes-already');
    already.replaceChildren();
    if (granted.length) {
        already.append('You already allowed: ');
        granted.forEach((g, i) => { if (i) already.append(', '); already.append(el('b', null, g.title || g.id)); });
        already.append('.');
    }
    already.hidden = !granted.length;
    const btn = document.getElementById('purposes-continue');
    const label = () => {
        const n = list.querySelectorAll('.purpose-box:checked').length;
        btn.textContent = n ? `Allow ${n === 1 ? 'this' : `these ${n}`} and continue` : 'Continue without allowing any';
    };
    btn.disabled = false;
    label();
    list.onchange = label;
    // The box above said "it will also ask"; now it is asking, so that line (or a site's whole box) steps aside.
    const intro = document.getElementById('oauth-consent');
    if (intro && intro.dataset && intro.dataset.onlyPurposes) intro.hidden = true;
    else if (intro && intro.querySelector) { const line = intro.querySelector('.consent-purposes'); if (line) line.hidden = true; }
    setActivePanel('panel-purposes', { showTabs: false, showExtras: false });
    head.focus();
    return new Promise((resolve) => {
        document.getElementById('purposes-form').onsubmit = (e) => {
            e.preventDefault();
            const allow = [...list.querySelectorAll('.purpose-box:checked')].map((b) => b.value);
            const adultOnly = allow.some((id) => (ask.find((p) => p.id === id) || {}).adults_only);
            if (needsAdult && adultOnly && !adultBox.checked) {
                showMsg('purposes-msg', 'Tick "I am 18 or older" to allow the ones marked 18+, or untick them.', 'error');
                adultBox.focus();
                return;
            }
            e.target.onsubmit = (ev) => ev.preventDefault();
            btn.disabled = true;
            btn.textContent = 'Continuing…';
            resolve({ shown: ask.map((p) => p.id), allow, adult: adultBox.checked, text_version: step.text_version });
        };
    });
}

// ── Account Selection ───────────────────────────────────────
async function selectAccount(account) {
    if (oauthConfirmInFlight) return;
    // Validate the saved token first — refresh if expired (7-day grace)
    let validToken = account.token;
    try {
        const checkRes = await fetch(API_BASE + '/api/auth/me', {
            headers: { Authorization: 'Bearer ' + account.token },
        });
        if (!checkRes.ok) {
            // Token expired or invalid — try refresh
            const refreshRes = await fetch(API_BASE + '/api/auth/refresh', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': 'application/json' },
            });
            if (refreshRes.ok) {
                const refreshData = await refreshRes.json();
                validToken = refreshData.token;
                // Update the saved account with the new token
                account.token = validToken;
                saveAccount(refreshData.user || account, validToken);
            } else {
                // Refresh also failed — this account needs its password again. Keep it in the
                // list and prefill it instead of deleting it (deleting it is what made people
                // re-add their account over and over).
                prefillAccount(account, 'Welcome back, ' + (account.display_name || account.username) + ' — enter your password to continue.');
                return;
            }
        }
    } catch {
        // Network error — proceed with existing token and let the redirect handle it
    }

    // Set this as the active account
    localStorage.setItem('ov_token', validToken);
    localStorage.setItem('openvibe_active_account', account.id);
    setAuthCookie(validToken);

    await guardScheduledDeletion(validToken, () => continueAsAccount(account, validToken));
}

// ── A scheduled deletion is offered before any sign-in continues ─────────────
// Every sign-in path (a saved account, or the password form) asks the API whether a deletion is scheduled.
// If it is, the person sees the same "Keep my account" choice as the banner before being sent on; the choice
// cancels it through DELETE /api/v1/account/deletion and then continues the sign-in.
let keepNext = null;
function offerKeep(token, deletion, next) {
    keepNext = next;
    const note = document.getElementById('keep-note');
    const when = window.OpenVibeDeletion ? window.OpenVibeDeletion.bannerText(deletion.delete_after) : `Your account will be deleted on ${new Date(deletion.delete_after).toLocaleString()}.`;
    if (note) note.textContent = `${when} It stays usable until then.`;
    const keep = document.getElementById('keep-account-btn');
    const cont = document.getElementById('keep-continue');
    if (keep) {
        keep.disabled = false;
        keep.textContent = 'Keep my account';
        keep.onclick = async () => {
            keep.disabled = true;
            keep.textContent = 'Keeping…';
            let result = { ok: false, body: {} };
            try {
                result = window.OpenVibeDeletion ? await window.OpenVibeDeletion.cancelDeletion(token) : result;
            } catch { /* offline */ }
            if (!result.ok && result.status !== 404) {
                keep.disabled = false;
                keep.textContent = 'Keep my account';
                toast((result.body && result.body.detail) || 'Could not keep the account. Try again.', 'error');
                return;
            }
            keep.textContent = 'Kept. Your account stays.';
            const go = keepNext;
            keepNext = null;
            setTimeout(() => { if (go) go(); }, 650);
        };
    }
    if (cont) cont.onclick = (e) => {
        if (e) e.preventDefault();
        const go = keepNext;
        keepNext = null;
        if (go) go();
    };
    setActivePanel('panel-keep', { showTabs: false, showExtras: false });
}

async function guardScheduledDeletion(token, next) {
    if (!token || !window.OpenVibeDeletion || typeof window.OpenVibeDeletion.deletionStatus !== 'function') return next();
    let deletion = null;
    try { deletion = await window.OpenVibeDeletion.deletionStatus(token); } catch { /* offline: the sign-in still goes on */ }
    if (!deletion) return next();
    offerKeep(token, deletion, next);
}

/** The part of a saved-account sign-in that leaves this page (an OAuth app, or back to the site). */
async function continueAsAccount(account, validToken) {
    if (isOAuth) {
        // Call /oauth/confirm to get the redirect URL (after the purposes step, when the app asks for permission)
        try {
            oauthConfirmInFlight = true;
            const { res, data } = await confirmWithPurposes(validToken);
            if (!res.ok) {
                if (res.status === 401) {
                    prefillAccount(account, 'Welcome back, ' + (account.display_name || account.username) + ' — enter your password to continue.');
                    return;
                }
                if (res.status === 403) {
                    clearLocalAuthState();
                    toast('Authorization denied for this account. Please sign in again.', 'error');
                    removeAccount(account.id);
                    return;
                }
                throw new Error(data.error_description || data.error || 'Authorization failed');
            }
            if (!data.redirect || isLoginLikeRedirect(data.redirect)) {
                throw new Error('Invalid redirect target returned by OAuth server');
            }
            toast('Redirecting as ' + (account.display_name || account.username) + '...', 'success');
            setTimeout(() => window.location.href = viaFanout(data.redirect, oauthClientId()), 400);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            oauthConfirmInFlight = false;
        }
    } else {
        // Not an app sign-in: this account is the active one now. Back where the person came from: a site's sign-in
        // (its account menu) continues as it there (rememberChoice).
        rememberChoice(account.id);
        toast('Switched to ' + escapeHtml(account.display_name || account.username), 'success');
        goBack(300);
    }
}

// Password toggle
function togglePw(btn) {
    const input = btn.previousElementSibling;
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.innerHTML = input.type === 'password' ? '<i class="fa-solid fa-eye" aria-hidden="true"></i>' : '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i>';
    btn.setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
}

function getRegisterUsernameError(username) {
    if (!username) return 'Username is required';
    if (typeof username !== 'string') return 'Username must be a valid string';
    if (username.length < 3 || username.length > 24) return 'Username must be 3-24 characters long';
    if (/^anon/i.test(username)) return 'Username cannot start with "anon" — this prefix is reserved for anonymous identities';
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return 'Username can only contain letters, numbers, and underscores';
    return '';
}

// Show message
function showMsg(id, text, type) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'message visible ' + type;
    setTimeout(() => el.classList.remove('visible'), 5000);
}

// Toast
function toast(text, type = 'success') {
    const el = document.getElementById('toast');
    el.innerHTML = text;
    el.className = 'login-toast ' + type + ' show';
    setTimeout(() => el.classList.remove('show'), 3000);
}

// Button ripple
function ripple(btn, e) {
    const r = document.createElement('span');
    r.className = 'ripple';
    const rect = btn.getBoundingClientRect();
    r.style.left = (e.clientX - rect.left - 10) + 'px';
    r.style.top = (e.clientY - rect.top - 10) + 'px';
    r.style.width = r.style.height = '20px';
    btn.appendChild(r);
    setTimeout(() => r.remove(), 600);
}

// safe-redirect:begin
// Where a sign-in may send the browser: a path on this site, this origin, or https on a zone
// OpenVibe owns (server/auth/sso-owned.js). Never javascript:/data:, never another host.
const OV_OWNED_ZONES = ['openvibe.network', 'openvibe.live', 'openvibe.tools', 'openvibe.media', 'openvibe.games', 'openvibe.community', 'openvibe.space', 'openvibe.chat', 'openvibe.codes', 'openvibe.blog', 'openvibe.wiki', 'openvibe.news', 'openvibe.reviews', 'openvibe.tips', 'openvibe.vip', 'openvibe.trade', 'openvibe.host', 'openvibe.deals', 'openvibe.coupons', 'openre.stream', 'open.shoes', 'openvibe.today', 'openvibe.vision', 'openvibe.domains', 'openvibe.report', 'openvibe.meme', 'openvibe.casino', 'openvibe.surf', 'openvibe.fun', 'openvibe.tours', 'openvibe.exchange', 'openvibe.cam', 'openvibe.design', 'openvibe.computer', 'openvibe.email', 'openvibe.link', 'openvibe.locker', 'openvibe.my', 'openvibe.party', 'openvibe.studio', 'openvibe.compare', 'openvibe.directory'];
const OV_USER_CONTENT_ZONES = ['openvibe.host', 'openvibe.link']; // tenant sites: only the apex is ours
function safeReturnUrl(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s || /[\\\u0000-\u001f\u007f]/.test(s)) return '/';
    if (s.startsWith('/') && !s.startsWith('//')) return s;
    try {
        const u = new URL(s);
        if (u.username || u.password) return '/';
        if (u.origin === window.location.origin) return u.toString();
        const h = u.hostname.toLowerCase();
        if (u.protocol === 'https:' && (['connect.openvibe.website', 'connect.openvibe.link'].includes(h) || OV_OWNED_ZONES.some(z => h === z || (h.endsWith('.' + z) && !OV_USER_CONTENT_ZONES.includes(z))))) return u.toString();
        const local = /^(localhost|127\.0\.0\.1)$/;
        if (u.protocol === 'http:' && local.test(h) && local.test(window.location.hostname)) return u.toString();
    } catch (e) { /* not a URL */ }
    return '/';
}
// safe-redirect:end

// The first-party sites this page may send people back to (?return=): the manifests' and the admin list's origins
// (GET /api/auth/return-origins). The owned zones above stay the floor when that cannot be read.
let returnOrigins = new Set();
const returnOriginsReady = fetch(`${API_BASE}/api/auth/return-origins`, { credentials: 'omit' })
    .then(r => (r.ok ? r.json() : null))
    .then((d) => { if (d && Array.isArray(d.origins)) returnOrigins = new Set(d.origins.map(String)); })
    .catch(() => {});

// Get return URL (non-OAuth)
function getReturnUrl() {
    const raw = params.get('return');
    const safe = safeReturnUrl(raw);
    if (safe !== '/' || !raw || /[\\\u0000-\u001f\u007f]/.test(String(raw))) return safe;
    try {
        const u = new URL(String(raw));
        if (u.protocol === 'https:' && !u.username && !u.password && returnOrigins.has(u.origin)) return u.toString();
    } catch { /* not a URL */ }
    return '/';
}
/** Leave for the return URL once the list of sites is known (at most a short wait). */
function goBack(delayMs) {
    const wait = new Promise(r => setTimeout(r, 1500));
    Promise.race([returnOriginsReady, wait]).then(() => setTimeout(() => { window.location.href = viaFanout(getReturnUrl()); }, delayMs || 0));
}

// After any successful sign-in the browser runs the sign-in-everywhere chain (/sso/fanout):
// one silent hop through each first-party site so the account is signed in on all of them,
// then on to where the user was going. An OAuth client that just got its code is skipped
// (it is about to sign in with that code).
function viaFanout(url, skipClient) {
    // Sites now pick the session up on their own (hidden /sso/check + silent sign-in when they
    // are opened), so the chain only runs when explicitly asked for.
    if (params.get('everywhere') !== '1') return url;
    if (!url || /[?&]error=/.test(String(url))) return url;
    const u = new URL('/sso/fanout', window.location.origin);
    u.searchParams.set('next', String(url));
    if (skipClient) u.searchParams.set('skip', skipClient);
    return u.toString();
}
function oauthClientId() { return params.get('client_id') || ''; }

// ── Login Handler ───────────────────────────────────────────
async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('login-submit');
    btn.classList.add('loading');
    btn.textContent = 'Signing in...';
    ripple(btn, e);

    const form = new FormData(e.target);
    try {
        const res = await fetch(API_BASE + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');

        if (data.mfa_required) {
            e.target.reset();
            showMfaChallenge();
            return;
        }

        // Store token & save account
        localStorage.setItem('ov_token', data.token);
        setAuthCookie(data.token);
        saveAccount(data.user, data.token);

        // If a deletion is scheduled, the same "Keep my account" choice comes before this sign-in continues.
        await guardScheduledDeletion(data.token, () => finishSignIn(data));
    } catch (err) {
        showMsg('login-msg', err.message, 'error');
        btn.textContent = isReauth ? 'Sign In Again →' : 'Sign In →';
        btn.classList.remove('loading');
    } finally {
        oauthConfirmInFlight = false;
    }
}

/** Leave the sign-in page for an OAuth app, or back where the person came from (after the password form). */
async function finishSignIn(data) {
    try {
        if (isOAuth) {
            oauthConfirmInFlight = true;
            // Confirm OAuth with the new token (after the purposes step, when the app asks for permission)
            const { res: confirmRes, data: confirmData } = await confirmWithPurposes(data.token);
            if (!confirmRes.ok) {
                if (confirmRes.status === 401 || confirmRes.status === 403) {
                    clearLocalAuthState();
                    throw new Error('Session invalid during redirect. Please sign in again.');
                }
                throw new Error(confirmData.error_description || confirmData.error || 'Authorization failed');
            }
            if (!confirmData.redirect || isLoginLikeRedirect(confirmData.redirect)) {
                throw new Error('Invalid redirect target returned by OAuth server');
            }
            toast('Welcome back, ' + (data.user.display_name || data.user.username) + '! <span class="ov-mark" data-size="16" data-static="1"></span>');
            setTimeout(() => window.location.href = viaFanout(confirmData.redirect, oauthClientId()), 800);
        } else {
            rememberChoice(data.user.id);
            toast('Welcome back, ' + escapeHtml(data.user.display_name || data.user.username) + '! <span class="ov-mark" data-size="16" data-static="1"></span>');
            goBack(800);
        }
    } catch (err) {
        showMsg('login-msg', err.message, 'error');
        const btn = document.getElementById('login-submit');
        if (btn) {
            btn.textContent = isReauth ? 'Sign In Again →' : 'Sign In →';
            btn.classList.remove('loading');
        }
    } finally {
        oauthConfirmInFlight = false;
    }
}

// ── Register Handler ────────────────────────────────────────
async function handleRegister(e) {
    e.preventDefault();
    const btn = document.getElementById('register-submit');
    const form = new FormData(e.target);
    const username = form.get('username')?.trim();

    const usernameError = getRegisterUsernameError(username);
    if (usernameError) {
        showMsg('register-msg', usernameError, 'error');
        return;
    }

    if (form.get('password') !== form.get('password_confirm')) {
        showMsg('register-msg', 'Passwords do not match', 'error');
        return;
    }

    btn.classList.add('loading');
    btn.textContent = 'Creating...';
    ripple(btn, e);

    try {
        const res = await fetch(API_BASE + '/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: form.get('username'),
                email: form.get('email') || undefined,
                password: form.get('password'),
                verification_key: form.get('verification_key') || undefined,
            }),
        });
        const data = await res.json();
        // A reserved name: show the claim-code field only now (most people never need it).
        if (!res.ok && data.reserved) {
            const claim = document.getElementById('claim-field');
            if (claim) { claim.hidden = false; document.getElementById('claim-code').focus(); }
            throw new Error('This username is reserved. Enter its claim code, or choose another name.');
        }
        if (!res.ok) throw new Error(data.error || 'Registration failed');

        localStorage.setItem('ov_token', data.token);
        setAuthCookie(data.token);
        saveAccount(data.user, data.token);

        if (isOAuth) {
            oauthConfirmInFlight = true;
            const confirmRes = await fetch(API_BASE + '/oauth/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: data.token,
                    client_id: params.get('client_id'),
                    redirect_uri: params.get('redirect_uri'),
                    scope: params.get('scope') || 'profile theme',
                    state: params.get('state') || '',
                    code_challenge: params.get('code_challenge') || undefined,
                    code_challenge_method: params.get('code_challenge_method') || undefined,
                    nonce: params.get('nonce') || undefined,
                }),
            });
            const confirmData = await confirmRes.json();
            if (!confirmRes.ok) {
                if (confirmRes.status === 401 || confirmRes.status === 403) {
                    clearLocalAuthState();
                    throw new Error('Session invalid during redirect. Please sign in again.');
                }
                throw new Error(confirmData.error || 'Authorization failed');
            }
            if (!confirmData.redirect || isLoginLikeRedirect(confirmData.redirect)) {
                throw new Error('Invalid redirect target returned by OAuth server');
            }
            toast('Account created! Welcome to the network <span class="ov-mark" data-size="16" data-static="1"></span>');
            setTimeout(() => window.location.href = viaFanout(confirmData.redirect, oauthClientId()), 800);
        } else {
            toast('Account created! Welcome to the network <span class="ov-mark" data-size="16" data-static="1"></span>');
            setTimeout(() => window.location.href = viaFanout(getReturnUrl()), 800);
        }
    } catch (err) {
        showMsg('register-msg', err.message, 'error');
        btn.innerHTML = 'Create Account <span class="ov-mark" data-size="16" data-static="1"></span>';
        btn.classList.remove('loading');
    } finally {
        oauthConfirmInFlight = false;
    }
}

async function handleForgotPassword(e) {
    e.preventDefault();
    const btn = document.getElementById('forgot-submit');
    const form = new FormData(e.target);
    btn.classList.add('loading');
    btn.textContent = 'Sending...';
    ripple(btn, e);

    try {
        const res = await fetch(API_BASE + '/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: form.get('email') }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unable to send reset link');
        showMsg('forgot-msg', data.message || 'If that email exists, a reset link has been sent.', 'success');
        e.target.reset();
    } catch (err) {
        showMsg('forgot-msg', err.message, 'error');
    } finally {
        btn.innerHTML = 'Send Reset Link <i class="fa-solid fa-envelope"></i>';
        btn.classList.remove('loading');
    }
}

async function validateResetToken(token) {
    const res = await fetch(API_BASE + '/api/auth/reset-password/validate?token=' + encodeURIComponent(token));
    const data = await res.json();
    if (!res.ok || !data.valid) throw new Error(data.error || 'Invalid or expired reset link');
    return data;
}

async function handleResetPassword(e) {
    e.preventDefault();
    const btn = document.getElementById('reset-submit');
    const form = new FormData(e.target);

    if (form.get('new_password') !== form.get('confirm_password')) {
        showMsg('reset-msg', 'Passwords do not match', 'error');
        return;
    }

    btn.classList.add('loading');
    btn.textContent = 'Resetting...';
    ripple(btn, e);

    try {
        const res = await fetch(API_BASE + '/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: form.get('token'), new_password: form.get('new_password') }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Password reset failed');
        showMsg('reset-msg', data.message || 'Password reset complete. You can sign in now.', 'success');
        setTimeout(() => {
            params.delete('token');
            const cleanUrl = window.location.pathname === '/reset-password' ? '/login' : window.location.pathname;
            window.history.replaceState({}, '', cleanUrl);
            showAuthForm('login');
        }, 1200);
    } catch (err) {
        showMsg('reset-msg', err.message, 'error');
    } finally {
        btn.innerHTML = 'Reset Password <i class="fa-solid fa-lock"></i>';
        btn.classList.remove('loading');
    }
}

// Anonymous mode
async function continueAnonymous() {
    try {
        const res = await fetch(API_BASE + '/api/auth/anon-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        clearAuthCookie();
        localStorage.removeItem('ov_token');
        saveAnonAccount(data.user, data.token);

        toast('Browsing as Anonymous #' + data.user.anon_number);
        setTimeout(() => window.location.href = viaFanout(getReturnUrl()), 600);
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ── Page Init ───────────────────────────────────────────────
(function init() {
    const accounts = getSavedAccounts();
    hasAccounts = accounts.length > 0;
    const resetToken = params.get('token');

    // A return into a page that only makes sense signed in (the machines hub): anonymous mode would
    // only land on a sign-in wall, so Continue Anonymously — and the divider above it — stays hidden.
    if (isSignedInOnlyReturn(params.get('return'))) {
        const anon = document.getElementById('anon-btn');
        if (anon) {
            anon.style.display = 'none';
            const prev = anon.previousElementSibling;
            if (prev && prev.classList && prev.classList.contains('divider')) prev.style.display = 'none';
        }
    }

    if (window.location.pathname === '/forgot-password') {
        showForgotForm();
        return;
    }

    if (window.location.pathname === '/reset-password' || resetToken) {
        showResetForm(resetToken || '');
        if (resetToken) {
            validateResetToken(resetToken)
                .then((data) => {
                    document.getElementById('reset-note').textContent = `Choose a new password for @${data.username}.`;
                })
                .catch((err) => {
                    showMsg('reset-msg', err.message, 'error');
                    document.getElementById('reset-submit').disabled = true;
                    document.getElementById('reset-submit').classList.add('loading');
                    document.getElementById('reset-submit').textContent = 'Reset Link Invalid';
                });
        } else {
            showMsg('reset-msg', 'Missing reset token. Request a new reset link to continue.', 'error');
            document.getElementById('reset-submit').disabled = true;
            document.getElementById('reset-submit').classList.add('loading');
            document.getElementById('reset-submit').textContent = 'Reset Link Required';
        }
        return;
    }

    // Direct link to the create-account tab (e.g. landing page CTA)
    if (params.get('tab') === 'register') {
        showAuthForm('register');
        return;
    }

    // A real re-authentication: the password form every time, even with saved accounts and even for an app's
    // silent continue. add_account=1 would hand back the existing session with its old auth_time.
    if (isReauth) {
        showAuthForm('login');
        const username = reauthUsername(accounts);
        if (username) prefillUsername(username);
        else {
            const field = document.querySelector('#login-form input[name="username"]');
            if (field) field.focus();
        }
        const tabs = document.getElementById('auth-tabs');
        if (tabs) tabs.style.display = 'none';
        const note = document.getElementById('reauth-note');
        if (note) note.hidden = false;
        const submit = document.getElementById('login-submit');
        if (submit) submit.textContent = 'Sign In Again →';
        const back = document.getElementById('login-back');
        if (back) back.style.display = 'none';
        return;
    }

    // A site's account menu (the shared navbar): switch to one of this browser's accounts, then back through the site's
    // sign-in, which continues as it. An account not saved here (or signed out) gets its sign-in, the name filled in.
    const switchTo = params.get('switch_to');
    if (switchTo && !isOAuth) {
        const account = accounts.find(a => String(a.id) === String(switchTo));
        if (account) {
            renderChooser();
            showChooser();
            const subtitle = document.getElementById('chooser-subtitle');
            if (subtitle) subtitle.textContent = `Switching to ${account.display_name || account.username}…`;
            selectAccount(account);
            return;
        }
        showAuthForm('login');
        prefillUsername(params.get('login_hint'));
        return;
    }
    // "Add another account" (a site's menu) and "use another account" (an app's prompt=login): the sign-in form.
    if (params.get('add_account') === '1' || params.get('prompt') === 'login') {
        showAuthForm('login');
        prefillUsername(params.get('login_hint'));
        return;
    }

    if (hasAccounts) {
        // Show account chooser
        renderChooser();
        showChooser();
    } else {
        // No saved accounts — show login form directly
        document.getElementById('panel-chooser').classList.remove('active');
        document.getElementById('auth-tabs').style.display = '';
        document.getElementById('panel-login').classList.add('active');
        prefillUsername(params.get('login_hint'));
    }
})();

// Pending sign-in lives only in the server's short-lived HttpOnly cookie.
function showMfaChallenge() {
    networkPasskeys.library().then(lib => lib.WebAuthnAbortService.cancelCeremony()).catch(() => {});
    const previous = document.getElementById('mfa-login');
    if (previous) previous.remove();
    const form = document.createElement('form');
    form.id = 'mfa-login';
    form.innerHTML = '<label>Authenticator or recovery code <input name="code" autocomplete="one-time-code" required maxlength="30"></label><label><input name="remember" type="checkbox"> Remember this browser for 30 days</label><button class="ovk-btn ovk-btn--primary" type="submit">Continue</button><p role="status"></p>';
    document.getElementById('login-form').hidden = true;
    document.getElementById('login-form').after(form);
    form.elements.code.focus();
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const button = form.querySelector('button');
        button.disabled = true;
        try {
            const res = await fetch(API_BASE + '/api/auth/mfa/verify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: form.elements.code.value, remember: form.elements.remember.checked }) });
            const data = await res.json();
            form.elements.code.value = '';
            if (!res.ok) throw new Error(data.error || 'Sign-in failed');
            localStorage.setItem('ov_token', data.token);
            setAuthCookie(data.token);
            saveAccount(data.user, data.token);
            await guardScheduledDeletion(data.token, () => finishSignIn(data));
        } catch (err) { form.querySelector('[role="status"]').textContent = err.message; }
        finally { button.disabled = false; }
    });
}

// Native conditional UI and the explicit button complete the existing SSO continuation.
async function signInWithPasskey(conditional = false) {
    const call = async (path, body) => {
        const res = await fetch(API_BASE + '/api/auth/passkeys/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Passkey sign-in failed');
        return data;
    };
    try {
        const data = await networkPasskeys.authenticate(call, 'login', conditional);
        localStorage.setItem('ov_token', data.token); setAuthCookie(data.token); saveAccount(data.user, data.token);
        await guardScheduledDeletion(data.token, () => finishSignIn(data));
    } catch (err) {
        if (!conditional) document.getElementById('login-msg').textContent = err.message;
    }
}
if (window.PublicKeyCredential) {
    const button = document.createElement('button'); button.type = 'button'; button.id = 'passkey-btn'; button.className = 'anon-btn'; button.textContent = 'Sign in with a passkey';
    button.onclick = () => signInWithPasskey();
    document.getElementById('login-form').after(button);
    PublicKeyCredential.isConditionalMediationAvailable?.().then(available => { if (available) signInWithPasskey(true); }).catch(() => {});
}

// Pages that only make sense signed in (the machines hub): Continue Anonymously would only land on a
// sign-in wall, so the button (and its divider) stays hidden when the return targets one of them.
function isSignedInOnlyReturn(raw) {
    const s = String(raw || '');
    if (!s) return false;
    if (s.startsWith('/') && !s.startsWith('//')) return /^\/machines(\/|\?|#|$)/.test(s);
    try {
        const u = new URL(s);
        return u.protocol === 'https:' && u.hostname.toLowerCase() === 'openvibe.link' && /^\/machines(\/|$)/.test(u.pathname);
    } catch { return false; }
}
