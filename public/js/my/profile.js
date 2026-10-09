/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): the account, profile, avatar, merge, export and deletion.
   Split out of my.html. Classic scripts, global scope: they rely on
   my/core.js's helpers (apiFetch, getAuthToken, showSection, API) and on
   my/boot.js (loaded last), which starts the page. No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// Load user data
async function loadUser() {
    // Hydrate localStorage from the host-only cookie if needed (e.g. cookie set by the login page)
    await _bootstrapFromCookie();
    const authToken = getAuthToken();
    const anonToken = getAnonToken();
    if (!authToken && !anonToken) { window.location.href = '/login'; return; }
    try {
        if (isAnonSession()) {
            const data = await anonFetch('/api/auth/anon/' + encodeURIComponent(anonToken));
            currentUser = {
                ...data.user,
                id: 'anon',
                role: 'anon',
                email: null,
                avatar_url: null,
                profile_color: '#8b5cf6',
                bio: '',
                is_anon: true,
            };
            renderHeader(currentUser);
            renderProfile(currentUser);
            applyAnonModeUI(currentUser);
            loadAccounts();
            loadAnonInfo();
            OpenVibeNavbar.init({ service: 'network', notificationsRealtime: true, token: null, user: currentUser });
        } else {
            const data = await apiFetch('/api/auth/me');
            currentUser = data.user;
            renderHeader(data.user);
            renderProfile(data.user);
            loadThemes(); loadThemeSubmissions();
            loadAccounts();
            renderMerge();
            renderExport(); renderDeletion();
            if (pendingMerge() && String(pendingMerge().into_id) !== String(currentUser.id)) showSection('accounts');
            loadNotifPrefs();
            loadLinked();
            loadSessions();
            loadBlocks();
            loadAnonInfo();
            loadEmailStatus();
            loadRecentTools();

            // Init navbar
            OpenVibeNavbar.init({ service: 'network', notificationsRealtime: true, token: authToken, user: currentUser });
            const bellMount = OpenVibeNavbar.getBellMount();
            if (bellMount && window.OpenVibeNotifications && authToken) {
                OpenVibeNotifications.init({ token: authToken, apiBase: API, swPath: '/openvibe-sw.js' });
                const bell = OpenVibeNotifications.createBell();
                bellMount.replaceChildren(bell);
            }
            renderNotifInbox();
        }
    } catch (err) {
        console.error(err);
        // A genuine auth failure → send them to log in. Everything else (offline, weak signal,
        // timeout, server hiccup) → show a clear reason + retry instead of a stuck "Loading…".
        if (err.status === 401 || /401|Authentication|not found|revoked|Unauthorized/i.test(err.message || '')) {
            // One refresh attempt before giving up on the session (a stale localStorage token
            // with a still-good cookie used to bounce people to the login page for nothing).
            if (!window._ovRefreshTried) {
                window._ovRefreshTried = true;
                try {
                    const r = await fetchWithTimeout(API + '/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(getAuthToken() ? { Authorization: 'Bearer ' + getAuthToken() } : {}) }, credentials: 'include' });
                    if (r.ok) { const d = await r.json(); if (d.token) { localStorage.setItem('ov_token', d.token); document.cookie = `ov_token=${d.token};path=/;max-age=${60*60*24*90};SameSite=Lax${location.protocol === 'https:' ? ';Secure' : ''}`; location.reload(); return; } }
                } catch { /* fall through */ }
            }
            window.location.href = '/login?return=' + encodeURIComponent(window.location.pathname);
            return;
        }
        showAccountLoadError(err);
    }
}

// Replace the stuck "Loading…" with a readable reason + a Retry button.
function showAccountLoadError(err) {
    const nameEl = document.getElementById('user-name');
    const subEl = document.getElementById('user-subtitle');
    if (nameEl) nameEl.textContent = "Couldn't load your account";
    if (subEl) {
        const offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
        subEl.textContent = (offline ? "You appear to be offline" : (err && err.message) ? err.message : 'Something went wrong') + ' · ';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'acct-retry-btn';
        btn.textContent = 'Retry';
        btn.onclick = () => { if (nameEl) nameEl.textContent = 'Loading…'; if (subEl) subEl.textContent = ''; loadUser(); };
        subEl.appendChild(btn);
    }
}

function renderHeader(user) {
    const avatar = document.getElementById('user-avatar');
    const fallback = avatarPlaceholder(user, 96);
    avatar.src = avatarSrc(user, 96);
    avatar.onerror = () => { avatar.src = fallback; };
    document.getElementById('user-name').textContent = user.display_name || user.username;
    document.getElementById('user-subtitle').textContent = user.is_anon
        ? `Anonymous identity${user.anon_number ? ' · #' + user.anon_number : ''}`
        : '@' + user.username + (user.email ? ' · ' + user.email : '');
    const badges = document.getElementById('user-badges');
    badges.innerHTML = user.is_anon
        ? `<span class="badge badge-anon">anonymous</span>`
        : `<span class="badge badge-${user.role}">${user.role}</span>`;
    if (user.anon_number) badges.innerHTML += `<span class="badge badge-anon">Anon #${user.anon_number}</span>`;
}

function renderProfile(user) {
    document.getElementById('pf-display-name').value = user.display_name || '';
    document.getElementById('pf-bio').value = user.bio || '';
    document.getElementById('pf-email').value = user.email || '';
    document.getElementById('pf-color').value = user.profile_color || '#8b5cf6';
    const pub = document.getElementById('pf-public');
    pub.checked = user.profile_public === undefined || Number(user.profile_public) !== 0;
    pub.disabled = !!user.is_anon;
    const link = document.getElementById('pf-public-link');
    if (user.username && !user.is_anon) { link.href = '/@' + encodeURIComponent(user.username); link.textContent = 'openvibe.network/@' + user.username; }
    if (!user.is_anon) {
        document.getElementById('pf-bio').disabled = false;
        document.getElementById('pf-email').disabled = false;
        document.getElementById('pf-color').disabled = false;
        const emailHint = document.querySelector('#sec-profile .hint');
        if (emailHint) emailHint.textContent = DEFAULT_EMAIL_HINT;
        const saveButton = document.querySelector('#profile-form .btn-primary');
        if (saveButton) saveButton.textContent = 'Save Changes';
    }
}

// Profile form

// ── Avatar: one picture for every site (PUT/DELETE /api/profile/avatar) ─────
(function () {
    const save = document.getElementById('avatar-save'), clear = document.getElementById('avatar-clear'), src = document.getElementById('avatar-source'), msg = document.getElementById('avatar-msg'), prev = document.getElementById('avatar-preview');
    if (!save) return;
    const paint = () => { if (typeof currentUser !== 'undefined' && currentUser) { prev.src = avatarSrc(currentUser, 96); prev.onerror = () => { prev.src = avatarPlaceholder(currentUser, 96); }; } };
    const apply = async (method, body) => {
        save.disabled = clear.disabled = true; msg.textContent = method === 'PUT' ? 'Checking the picture…' : '';
        try {
            const data = await apiFetch('/api/profile/avatar', { method, body: body ? JSON.stringify(body) : undefined });
            currentUser = Object.assign({}, currentUser, { avatar_url: data.avatar_url });
            renderHeader(currentUser); paint(); src.value = '';
            msg.textContent = data.avatar_url ? 'Saved. Every OpenVibe site will show it within a few minutes.' : 'Removed. Sites will show your initial.';
        } catch (err) { msg.textContent = err.message || 'That did not work'; }
        save.disabled = clear.disabled = false;
    };
    save.addEventListener('click', () => { if (src.value.trim()) apply('PUT', { source: src.value.trim() }); else msg.textContent = 'Paste a link first.'; });
    clear.addEventListener('click', () => apply('DELETE'));
    src.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
    document.addEventListener('ov:account-ready', paint); setTimeout(paint, 1500);
})();

document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        if (isAnonSession()) {
            const anonToken = getAnonToken();
            const data = await anonFetch('/api/auth/anon/' + encodeURIComponent(anonToken) + '/preferences', {
                method: 'PUT',
                body: JSON.stringify({
                    display_name: document.getElementById('pf-display-name').value,
                }),
            });
            currentUser = {
                ...currentUser,
                display_name: data.preferences?.display_name || document.getElementById('pf-display-name').value || currentUser.display_name,
            };
            const accounts = getStoredAccounts().filter(a => !a.is_anon);
            accounts.push({
                id: 'anon',
                username: currentUser.username,
                display_name: currentUser.display_name,
                avatar_url: null,
                email: null,
                is_anon: true,
                anon_number: currentUser.anon_number,
                token: getAnonToken(),
            });
            localStorage.setItem('openvibe_accounts', JSON.stringify(accounts));
            renderHeader(currentUser);
            alert('Anonymous preferences updated!');
            return;
        }

        // Display name may only re-case the username, not rename it.
        const _dn = (document.getElementById('pf-display-name').value || '').trim();
        if (currentUser?.username && _dn.toLowerCase() !== String(currentUser.username).toLowerCase()) {
            alert('Your display name can only change the capitalization of your username (e.g. "' + currentUser.username + '" → "' + currentUser.username.charAt(0).toUpperCase() + currentUser.username.slice(1) + '").');
            return;
        }
        const data = await apiFetch('/api/auth/profile', { method: 'PUT', body: JSON.stringify({
            display_name: _dn,
            bio: document.getElementById('pf-bio').value,
            email: document.getElementById('pf-email').value || undefined,
            profile_color: document.getElementById('pf-color').value,
            profile_public: document.getElementById('pf-public').checked,
        })});
        currentUser = data.user;
        renderHeader(data.user);
        alert('Profile updated!');
    } catch (err) { alert('Error: ' + err.message); }
});

// Accounts
function loadAccounts() {
    const accounts = JSON.parse(localStorage.getItem('openvibe_accounts') || '[]');
    const activeId = localStorage.getItem('openvibe_active_account');
    const list = document.getElementById('account-list');
    list.innerHTML = accounts.map(a => `
        <div class="account-item ${String(a.id) === String(activeId) ? 'active' : ''}">
            <img src="${avatarSrc(a, 64)}" alt="${a.display_name || a.username}" onerror="this.onerror=null;this.src='${avatarPlaceholder({ display_name: a.display_name, username: a.username, profile_color: a.profile_color }, 64)}'">
            <div>
                <div class="name">${a.display_name || a.username}${a.is_anon ? ' <i class="fa-solid fa-user-secret" style="font-size:12px"></i>' : ''}</div>
                <div class="meta">${a.is_anon ? 'Anonymous #' + (a.anon_number || '?') : '@' + a.username}</div>
            </div>
            <div class="actions">
                ${String(a.id) !== String(activeId) ? `<button class="btn btn-outline" onclick="switchAccount('${a.id}')">Switch</button>` : '<span style="font-size:11px;color:var(--success);font-weight:600">Active</span>'}
                ${String(a.id) !== String(activeId) ? `<button class="btn btn-danger" onclick="removeAccount('${a.id}')"><i class="fa-solid fa-xmark"></i></button>` : ''}
            </div>
        </div>
    `).join('');
}

// ── Account merge (ADR-029): 1) the account you keep opens a 10-minute request, 2) you sign in to the other
// account ("Add another account"), 3) it confirms and folds itself in. Both sign-ins within 10 minutes.
const MERGE_KEY = 'ov_merge_intent';
function pendingMerge() {
    try { const m = JSON.parse(localStorage.getItem(MERGE_KEY) || 'null'); return m && Date.parse(m.expires_at) > Date.now() ? m : null; } catch { return null; }
}
function renderMerge() {
    const body = document.getElementById('merge-body');
    if (!body || !currentUser) return;
    body.textContent = '';
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
    const row = el('div', '', 'btn-row');
    const pending = pendingMerge();
    if (currentUser.is_anon) { body.appendChild(el('p', 'Guests convert by signing up; merging is for two accounts.')); return; }
    if (!pending) {
        const b = el('button', `Keep @${currentUser.username} and merge another account into it`, 'btn btn-primary');
        b.type = 'button';
        b.onclick = async () => {
            try {
                const r = await apiFetch('/api/v1/account/merge/intents', { method: 'POST', body: '{}' });
                localStorage.setItem(MERGE_KEY, JSON.stringify({ intent: r.intent, expires_at: r.expires_at, into_id: currentUser.id, into_username: currentUser.username }));
                addAccount();
            } catch (err) { toast('Could not start the merge: ' + err.message, 'error'); }
        };
        row.appendChild(b); body.appendChild(row); return;
    }
    const mins = Math.max(1, Math.round((Date.parse(pending.expires_at) - Date.now()) / 60000));
    const cancel = el('button', 'Cancel', 'btn btn-outline');
    cancel.type = 'button';
    cancel.onclick = () => { localStorage.removeItem(MERGE_KEY); renderMerge(); };
    if (String(currentUser.id) === String(pending.into_id)) {
        body.appendChild(el('p', `Now sign in to the account you want to fold into @${pending.into_username} (within ${mins} min).`));
        const go = el('button', 'Sign in to the other account', 'btn btn-primary');
        go.type = 'button'; go.onclick = addAccount;
        row.append(go, cancel); body.appendChild(row); return;
    }
    body.appendChild(el('p', `Fold @${currentUser.username} into @${pending.into_username}? Everything above moves to @${pending.into_username}; @${currentUser.username} then signs in as @${pending.into_username}.`));
    const doIt = el('button', `Merge @${currentUser.username} into @${pending.into_username}`, 'btn btn-danger');
    doIt.type = 'button';
    doIt.onclick = async () => {
        doIt.disabled = true;
        try {
            const r = await apiFetch('/api/v1/account/merge', { method: 'POST', body: JSON.stringify({ intent: pending.intent }) });
            localStorage.removeItem(MERGE_KEY);
            toast(`Merged: @${currentUser.username} is now part of @${pending.into_username} (${r.moved.coins} OpenCoins moved).`, 'success');
            const folded = currentUser.id;
            try { OpenVibeAccountSwitcher.removeAccount(folded); } catch { /* */ }
            OpenVibeAccountSwitcher.switchTo(pending.into_id);
        } catch (err) {
            doIt.disabled = false;
            if (err.status === 401) toast(`Sign in to @${currentUser.username} again (a fresh sign-in is needed), then merge.`, 'error');
            else if (err.status === 410) { localStorage.removeItem(MERGE_KEY); toast('That merge request expired. Start again from the account you keep.', 'error'); renderMerge(); }
            else toast('The merge did not happen: ' + err.message, 'error');
        }
    };
    row.append(doIt, cancel); body.appendChild(row);
}

// ── Your data (ADR-033): the export job (each service adds its part; ready within 30 minutes, kept 7 days) and
// the scheduled deletion (30 days of grace, cancellable; scheduling it needs a fresh sign-in and the username).
async function accountApi(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = getAuthToken();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetchWithTimeout(API + path, { ...opts, headers, credentials: 'include' });
    let body = {};
    try { body = await res.json(); } catch { /* */ }
    return { status: res.status, ok: res.ok, body };
}
const ovEl = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
const whenText = (s) => new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
let exportPoll = null;
async function renderExport() {
    const body = document.getElementById('export-body');
    if (!body || !currentUser) return;
    clearTimeout(exportPoll);
    body.textContent = '';
    if (currentUser.is_anon) { body.appendChild(ovEl('p', 'Guests have no account to export.')); return; }
    const r = await accountApi('/api/v1/account/export');
    const latest = ((r.body && r.body.exports) || [])[0];
    const row = ovEl('div', '', 'btn-row');
    if (latest && latest.status === 'pending') {
        const waiting = latest.services.filter((s) => s.status === 'waiting').map((s) => s.service);
        body.appendChild(ovEl('p', `Gathering your data since ${whenText(latest.requested_at)}${waiting.length ? `; waiting for ${waiting.join(', ')}` : ''}. It is ready by ${whenText(latest.deadline)} at the latest, and you get a notification.`));
        exportPoll = setTimeout(renderExport, 15000);
        return;
    }
    if (latest && (latest.status === 'ready' || latest.status === 'partial')) {
        const missing = latest.services.filter((s) => s.status === 'missing').map((s) => s.service);
        body.appendChild(ovEl('p', `Ready since ${whenText(latest.ready_at)} (${sizeText(latest.size_bytes || 0)}), until ${whenText(latest.expires_at)}.${missing.length ? ` Not included, because they did not answer in time: ${missing.join(', ')}. Ask again tomorrow for a complete copy.` : ''}`));
        const dl = ovEl('button', 'Download (.zip)', 'btn btn-primary');
        dl.type = 'button';
        dl.onclick = () => downloadExport(latest.export_id, dl);
        row.appendChild(dl);
    } else if (latest && latest.status === 'failed') {
        body.appendChild(ovEl('p', 'The last export could not be built. Ask again.'));
    }
    const since = latest && latest.status !== 'failed' ? Date.now() - Date.parse(latest.requested_at) : Infinity;
    if (since >= 86400000) {
        const start = ovEl('button', latest ? 'Request a new copy' : 'Request my data', latest ? 'btn btn-outline' : 'btn btn-primary');
        start.type = 'button';
        start.onclick = async () => {
            start.disabled = true;
            const s = await accountApi('/api/v1/account/export', { method: 'POST', body: '{}' });
            if (!s.ok) { start.disabled = false; toast(s.body.detail || 'Could not start the export', 'error'); return; }
            toast('Gathering your data. You get a notification when it is ready.', 'success');
            renderExport();
        };
        row.appendChild(start);
    } else if (latest) {
        body.appendChild(ovEl('p', `You can ask for a new copy from ${whenText(Date.parse(latest.requested_at) + 86400000)}.`));
    }
    if (row.children.length) body.appendChild(row);
}
async function downloadExport(id, btn) {
    btn.disabled = true;
    try {
        const headers = {};
        const t = getAuthToken();
        if (t) headers.Authorization = 'Bearer ' + t;
        const res = await fetch(API + `/api/v1/account/export/${encodeURIComponent(id)}/download`, { headers, credentials: 'include' });
        if (!res.ok) { toast('That copy is no longer available.', 'error'); renderExport(); return; }
        const blob = await res.blob();
        const name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'openvibe-data.zip';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch { toast('The download failed. Try again.', 'error'); } finally { btn.disabled = false; }
}
async function renderDeletion() {
    const body = document.getElementById('delete-body');
    if (!body || !currentUser) return;
    body.textContent = '';
    if (currentUser.is_anon) { body.appendChild(ovEl('p', 'Guests have no account to delete.')); return; }
    const r = await accountApi('/api/v1/account/deletion');
    const d = r.body && r.body.deletion;
    const row = ovEl('div', '', 'btn-row');
    if (d) {
        body.appendChild(ovEl('p', `Your account will be deleted on ${whenText(d.delete_after)}. Download your data before then if you want a copy.`));
        const keep = ovEl('button', 'Keep my account', 'btn btn-primary');
        keep.type = 'button';
        keep.onclick = async () => {
            keep.disabled = true;
            const c = await accountApi('/api/v1/account/deletion', { method: 'DELETE' });
            if (c.ok) toast('Deletion cancelled. Your account stays.', 'success');
            renderDeletion();
        };
        row.appendChild(keep); body.appendChild(row);
        return;
    }
    const field = ovEl('div', '', 'form-field');
    const label = ovEl('label', `Type your username, ${currentUser.username}, to confirm`);
    const input = ovEl('input');
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.id = 'delete-confirm';
    label.htmlFor = 'delete-confirm';
    field.append(label, input);
    const go = ovEl('button', 'Delete my account in 30 days', 'btn btn-danger');
    go.type = 'button';
    go.onclick = async () => {
        go.disabled = true;
        const s = await accountApi('/api/v1/account/deletion', { method: 'POST', body: JSON.stringify({ confirm_username: input.value }) });
        go.disabled = false;
        if (s.status === 401 && s.body.error === 'deletion.sign_in_again') {
            toast('To make sure it is you, sign in again, then come back here and confirm.', 'error');
            const again = ovEl('button', 'Sign in again', 'btn btn-outline');
            again.type = 'button'; again.onclick = addAccount;
            if (!row.querySelector('.btn-outline')) row.appendChild(again);
            return;
        }
        if (!s.ok) { toast(s.body.detail || 'That did not work', 'error'); return; }
        toast(`Scheduled: your account will be deleted on ${whenText(s.body.delete_after)}. You can cancel until then.`, 'success');
        renderDeletion();
    };
    row.appendChild(go);
    body.append(field, row);
}

function switchAccount(id) { OpenVibeAccountSwitcher.switchTo(id); }
function removeAccount(id) { OpenVibeAccountSwitcher.removeAccount(id); loadAccounts(); }
function addAccount() { window.location.href = '/login?add_account=1&return=' + encodeURIComponent(window.location.pathname); }
function signOutAll() { OpenVibeAccountSwitcher.logoutAll(); }
