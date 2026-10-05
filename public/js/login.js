/**
 * login.js — the sign-in page (/login, /forgot-password, /reset-password): the saved-account
 * chooser, the login / register / reset forms and the safe post-sign-in redirect.
 * Moved verbatim out of login.html's inline <script>; the init IIFE at the end runs on load.
 */
const API_BASE = window.location.origin;
const params = new URLSearchParams(window.location.search);
const isOAuth = params.has('client_id') && params.has('redirect_uri');
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
    if (!box || !info || !info.third_party) return;
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    box.replaceChildren();
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
    } else {
        box.append(el('p', 'consent-none', 'It asks for nothing else: it will only learn which OpenVibe account you are.'));
    }
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
        const avatarContent = account.avatar_url
            ? `<img src="${escapeHtml(account.avatar_url)}" alt="" onerror="this.parentElement.innerHTML='<i class=\'fa-solid fa-circle-nodes\'></i>'">`
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
        item.addEventListener('click', () => selectAccount(account));
        list.appendChild(item);
    });
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
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

    if (isOAuth) {
        // Call /oauth/confirm to get the redirect URL
        try {
            oauthConfirmInFlight = true;
            const res = await fetch(API_BASE + '/oauth/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: validToken,
                    client_id: params.get('client_id'),
                    redirect_uri: params.get('redirect_uri'),
                    scope: params.get('scope') || 'profile theme',
                    state: params.get('state') || '',
                    code_challenge: params.get('code_challenge') || undefined,
                    code_challenge_method: params.get('code_challenge_method') || undefined,
                    nonce: params.get('nonce') || undefined,
                }),
            });
            const data = await res.json();
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
                throw new Error(data.error || 'Authorization failed');
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
        // Not OAuth — just switch the active account and go home
        toast('Welcome back, ' + (account.display_name || account.username) + '! <span class="ov-mark" data-size="16" data-static="1"></span>', 'success');
        setTimeout(() => window.location.href = viaFanout(getReturnUrl()), 600);
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
const OV_OWNED_ZONES = ['openvibe.network', 'openvibe.live', 'openvibe.tools', 'openvibe.media', 'openvibe.games', 'openvibe.community', 'openvibe.chat', 'openvibe.codes', 'openvibe.blog', 'openvibe.wiki', 'openvibe.news', 'openvibe.reviews', 'openvibe.tips', 'openvibe.vip', 'openvibe.trade', 'openvibe.host', 'openvibe.deals', 'openvibe.coupons', 'openre.stream'];
const OV_USER_CONTENT_ZONES = ['openvibe.host']; // tenant sites: only the apex is ours
function safeReturnUrl(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s || /[\\\u0000-\u001f\u007f]/.test(s)) return '/';
    if (s.startsWith('/') && !s.startsWith('//')) return s;
    try {
        const u = new URL(s);
        if (u.username || u.password) return '/';
        if (u.origin === window.location.origin) return u.toString();
        const h = u.hostname.toLowerCase();
        if (u.protocol === 'https:' && OV_OWNED_ZONES.some(z => h === z || (h.endsWith('.' + z) && !OV_USER_CONTENT_ZONES.includes(z)))) return u.toString();
        const local = /^(localhost|127\.0\.0\.1)$/;
        if (u.protocol === 'http:' && local.test(h) && local.test(window.location.hostname)) return u.toString();
    } catch (e) { /* not a URL */ }
    return '/';
}
// safe-redirect:end

// Get return URL (non-OAuth)
function getReturnUrl() {
    return safeReturnUrl(params.get('return'));
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

        // Store token & save account
        localStorage.setItem('ov_token', data.token);
        setAuthCookie(data.token);
        saveAccount(data.user, data.token);

        if (isOAuth) {
            oauthConfirmInFlight = true;
            // Confirm OAuth with the new token
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
            toast('Welcome back, ' + (data.user.display_name || data.user.username) + '! <span class="ov-mark" data-size="16" data-static="1"></span>');
            setTimeout(() => window.location.href = viaFanout(confirmData.redirect, oauthClientId()), 800);
        } else {
            toast('Welcome back, ' + (data.user.display_name || data.user.username) + '! <span class="ov-mark" data-size="16" data-static="1"></span>');
            setTimeout(() => window.location.href = viaFanout(getReturnUrl()), 800);
        }
    } catch (err) {
        showMsg('login-msg', err.message, 'error');
        btn.textContent = 'Sign In →';
        btn.classList.remove('loading');
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

    if (hasAccounts) {
        // Show account chooser
        renderChooser();
        showChooser();
    } else {
        // No saved accounts — show login form directly
        document.getElementById('panel-chooser').classList.remove('active');
        document.getElementById('auth-tabs').style.display = '';
        document.getElementById('panel-login').classList.add('active');
    }
})();
