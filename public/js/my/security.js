/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): email status, notifications, linked accounts, history, sessions, blocks, anonymous identities and password.
   Split out of my.html. Classic scripts, global scope: they rely on
   my/core.js's helpers (apiFetch, getAuthToken, showSection, API) and on
   my/boot.js (loaded last), which starts the page. No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ── Email verification status (gates opt-in email like go-live alerts) ──
async function loadEmailStatus() {
    if (isAnonSession()) return;
    const card = document.getElementById('notif-verify-card'), body = document.getElementById('notif-verify-body');
    if (!card || !body) return;
    try {
        const st = await apiFetch('/api/auth/email/status');
        card.style.display = '';
        if (!st.email) {
            body.innerHTML = `<p>No email address on your account, so you can't receive go-live emails. Add one in <a href="#" onclick="showSection('profile');return false">Profile</a> — we'll send a confirmation link.</p>`;
        } else if (st.bounced) {
            body.innerHTML = `<p><span style="color:var(--danger-text, var(--danger,#ef4444))"><i class="fa-solid fa-triangle-exclamation"></i> Mail to <strong>${esc(st.email)}</strong> is bouncing</span>${st.bounce_reason ? ` (${esc(st.bounce_reason)})` : ''}. Emails are paused until you update the address in <a href="#" onclick="showSection('profile');return false">Profile</a> and confirm it.</p>`;
        } else if (st.verified) {
            body.innerHTML = `<p><span style="color:var(--success-text, var(--success,#22c55e))"><i class="fa-solid fa-circle-check"></i> <strong>${esc(st.email)}</strong> is verified.</span> You'll get an email when a streamer you follow goes live (turn this off under Streams → Email below).</p>`;
        } else {
            body.innerHTML = `<p><i class="fa-solid fa-envelope"></i> <strong>${esc(st.email)}</strong> isn't confirmed yet — go-live and other opt-in emails stay off until it is.</p>
                <button class="btn btn-primary" id="notif-verify-btn" onclick="resendVerification(this)" ${st.can_resend && st.email_enabled ? '' : 'disabled'}><i class="fa-solid fa-paper-plane"></i> ${st.email_enabled ? 'Send verification email' : 'Email delivery not configured'}</button>
                ${!st.can_resend && st.email_enabled ? '<div class="muted" style="font-size:12px;margin-top:6px">A link was sent moments ago — check your inbox and spam folder.</div>' : ''}`;
        }
    } catch (e) { card.style.display = 'none'; }
}
async function resendVerification(btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…'; }
    try { const r = await apiFetch('/api/auth/email/send-verification', { method: 'POST' }); toast(r.message || 'Sent', 'success'); }
    catch (e) { toast(e.message, 'error'); }
    loadEmailStatus();
}
async function handleVerifyEmailToken() {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) return;
    history.replaceState(null, '', '/notifications');
    try {
        const r = await fetchWithTimeout(API + '/api/auth/email/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        const data = await r.json().catch(() => ({}));
        if (r.ok) toast(`${data.email || 'Your email'} is verified — go-live alerts will reach your inbox.`, 'success');
        else toast(data.error || 'Verification failed', 'error');
    } catch { toast('Verification failed — try again from your account page.', 'error'); }
    loadEmailStatus();
}
let _inboxRendered = false;
function renderNotifInbox() {
    if (_inboxRendered || isAnonSession() || !window.OpenVibeNotifications) return;
    const el = document.getElementById('notif-inbox'); if (!el) return;
    _inboxRendered = true;
    OpenVibeNotifications.renderInbox(el, { tab: 'all' });
}

// Notification preferences
const CATEGORIES = ['social','chat','game','stream','economy','achievement','moderation','system','service','admin'];

async function loadNotifPrefs() {
    if (isAnonSession()) return;
    try {
        const data = await apiFetch('/api/notifications/preferences');
        const prefsMap = {};
        for (const p of data.preferences) prefsMap[p.category] = p;
        const grid = document.getElementById('notif-prefs');
        // Clear existing rows
        grid.querySelectorAll('.pref-row').forEach(r => r.remove());
        for (const cat of CATEGORIES) {
            const p = prefsMap[cat] || { enabled: 1, sound: 1, toasts: 1, email: null };
            // email NULL = no explicit choice: go-live (stream) alerts email by default.
            const emailOn = (p.email === null || p.email === undefined) ? cat === 'stream' : !!p.email;
            p.email = emailOn ? 1 : 0;
            const label = { social: 'Social', chat: 'Chat', game: 'Game', stream: 'Streams (go-live)', economy: 'Economy', achievement: 'Achievements', moderation: 'Moderation', system: 'System', service: 'Services', admin: 'Announcements' }[cat] || cat;
            const digest = ['hourly', 'daily', 'weekly'].includes(p.digest) ? p.digest : 'off';
            const opt = (v, l) => `<option value="${v}"${digest === v ? ' selected' : ''}>${l}</option>`;
            const html = `
                <div class="cat pref-row" title="${cat}">${label}</div>
                <button class="toggle pref-row ${p.enabled ? 'on' : 'off'}" data-cat="${cat}" data-field="enabled" onclick="togglePref(this)"></button>
                <button class="toggle pref-row ${p.sound ? 'on' : 'off'}" data-cat="${cat}" data-field="sound" onclick="togglePref(this)"></button>
                <button class="toggle pref-row col-toast ${p.toasts ? 'on' : 'off'}" data-cat="${cat}" data-field="toasts" onclick="togglePref(this)"></button>
                <button class="toggle pref-row col-email ${p.email ? 'on' : 'off'}" data-cat="${cat}" data-field="email" onclick="togglePref(this)"></button>
                <select class="digest pref-row col-digest" data-cat="${cat}" data-was="${digest}" aria-label="${label}: how emails come" onchange="setDigest(this)">${opt('off', 'Each one')}${opt('hourly', 'Hourly')}${opt('daily', 'Daily')}${opt('weekly', 'Weekly')}</select>
            `;
            grid.insertAdjacentHTML('beforeend', html);
        }
    } catch (err) { console.error('Failed to load notif prefs:', err); }
}

async function setDigest(sel) {
    const before = sel.dataset.was || 'off';
    try {
        await apiFetch('/api/notifications/preferences', { method: 'PUT', body: JSON.stringify({ category: sel.dataset.cat, digest: sel.value }) });
        sel.dataset.was = sel.value;
    } catch (err) { sel.value = before; }
}

// Quiet hours: the person's window in their own time zone (Network keeps it; the bell and email follow it).
async function loadQuietHours() {
    if (isAnonSession()) return;
    const form = document.getElementById('quiet-form');
    if (!form || form.dataset.ready) return;
    const tzSel = document.getElementById('quiet-tz');
    const device = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) { zones = [device, 'UTC']; }
    if (!zones.includes('UTC')) zones.unshift('UTC');
    let q = null;
    try { q = await apiFetch('/api/notifications/quiet-hours'); } catch (e) { q = null; }
    const tz = q && q.enabled ? q.tz : device;
    if (!zones.includes(tz)) zones.unshift(tz);
    tzSel.textContent = '';
    for (const z of zones) { const o = document.createElement('option'); o.value = z; o.textContent = z.replace(/_/g, ' '); if (z === tz) o.selected = true; tzSel.appendChild(o); }
    document.getElementById('quiet-on').checked = !!(q && q.enabled);
    if (q && q.start) document.getElementById('quiet-start').value = q.start;
    if (q && q.end) document.getElementById('quiet-end').value = q.end;
    showQuietStatus(q);
    form.dataset.ready = '1';
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('quiet-status');
        status.textContent = 'Saving…';
        try {
            const saved = await apiFetch('/api/notifications/quiet-hours', { method: 'PUT', body: JSON.stringify({
                enabled: document.getElementById('quiet-on').checked, start: document.getElementById('quiet-start').value,
                end: document.getElementById('quiet-end').value, tz: tzSel.value }) });
            showQuietStatus(saved, 'Saved. ');
        } catch (err) { status.textContent = 'Not saved: ' + (err && err.message ? err.message : 'try again'); }
    });
}
function showQuietStatus(q, prefix = '') {
    const status = document.getElementById('quiet-status');
    if (!status) return;
    if (!q || !q.enabled) { status.textContent = prefix + 'Off: notices pop up whenever they arrive.'; return; }
    status.textContent = prefix + (q.in_quiet ? `Quiet now, until ${q.end} (${q.tz.replace(/_/g, ' ')}).` : `Quiet from ${q.start} to ${q.end} (${q.tz.replace(/_/g, ' ')}).`);
}

async function togglePref(btn) {
    const cat = btn.dataset.cat;
    const field = btn.dataset.field;
    const isOn = btn.classList.contains('on');
    btn.classList.toggle('on');
    btn.classList.toggle('off');
    try {
        await apiFetch('/api/notifications/preferences', { method: 'PUT', body: JSON.stringify({ category: cat, [field]: !isOn }) });
    } catch (err) { btn.classList.toggle('on'); btn.classList.toggle('off'); }
}

// Linked services
async function loadLinked() {
    if (isAnonSession()) return;
    const list = document.getElementById('linked-list');
    const SITES = {
        live: { name: 'OpenVibe.Live', icon: 'fa-tower-broadcast', url: 'https://openvibe.live', color: '#ef4444' },
        tools: { name: 'OpenVibe.Tools', icon: 'fa-screwdriver-wrench', url: 'https://openvibe.tools', color: '#8b5cf6' },
        games: { name: 'OpenVibe.Games', icon: 'fa-gamepad', url: 'https://openvibe.games', color: '#22c55e' },
        media: { name: 'OpenVibe.Media', icon: 'fa-photo-film', url: 'https://openvibe.media', color: '#22d3ee' },
        community: { name: 'OpenVibe.Community', icon: 'fa-people-group', url: 'https://openvibe.community', color: '#f59e0b' },
        space: { name: 'OpenVibe.Space', icon: 'fa-comments', url: 'https://openvibe.space', color: '#818cf8' },
        discord: { name: 'Discord', icon: 'fa-brands fa-discord', url: 'https://discord.gg/M6MuRUaeJj', color: '#5865f2' },
        network: { name: 'OpenVibe.Network', icon: 'fa-circle-nodes', url: '/', color: '#3b82f6' },
    };
    const ago = (iso) => { if (!iso) return ''; const d = (Date.now() - new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z')).getTime()) / 1000; if (d < 90) return 'just now'; if (d < 3600) return Math.round(d / 60) + 'm ago'; if (d < 86400) return Math.round(d / 3600) + 'h ago'; return Math.round(d / 86400) + 'd ago'; };
    try {
        const card = await apiFetch('/api/auth/users/' + currentUser.id + '/card');
        const linked = card.user?.linked_services || [];
        const known = new Set(linked.map(l => l.service));
        const rows = linked.map(l => {
            const site = SITES[l.service] || { name: l.service, icon: 'fa-link', url: null };
            const who = l.service_username && !String(l.service_user_id || '').startsWith('network:') ? '@' + l.service_username : (l.service_username ? '@' + l.service_username : 'this account');
            const inner = `<span class="svc-icon" style="color:${site.color || 'var(--accent-light)'}"><i class="fa-solid ${site.icon}"></i></span>
                    <div><div class="svc-name">${esc(site.name)}</div><div class="svc-user">${esc(who)}</div></div>
                    <div class="svc-meta">${l.last_used_at ? 'used ' + ago(l.last_used_at) : (l.linked_at ? 'linked ' + ago(l.linked_at) : '')}<br><span class="svc-status" style="color:var(--success-text, var(--success))"><i class="fa-solid fa-check"></i> Linked</span></div>`;
            return site.url ? `<a class="linked-item" href="${site.url}" target="_blank" rel="noopener">${inner}</a>` : `<div class="linked-item">${inner}</div>`;
        }).join('');
        const rest = Object.entries(SITES).filter(([id]) => !known.has(id) && id !== 'network' && id !== 'discord');
        list.innerHTML = (rows || '<p style="color:var(--text-muted);font-size:13px">Nothing linked yet — the first sign-in on any OpenVibe site links it here automatically.</p>') +
            (rest.length ? `<div class="linked-grid">${rest.map(([id, site]) => `<a href="${site.url}" target="_blank" rel="noopener" title="Open ${site.name}"><i class="fa-solid ${site.icon}" style="color:${site.color}"></i> ${esc(site.name.replace('OpenVibe.', ''))}<span style="margin-left:auto;font-size:10px;opacity:.7">not yet</span></a>`).join('')}</div>` : '');
    } catch (err) { console.error('Failed to load linked:', err); }
}

// ── History across the network ──
let _histOffset = 0, _histService = '', _histTimer = null, _histLoaded = false;
function histDebounce() { clearTimeout(_histTimer); _histTimer = setTimeout(() => loadHistory(false), 250); }
function histFilter(svc, btn) { _histService = svc; document.querySelectorAll('#hist-chips button').forEach(b => b.classList.toggle('active', b === btn)); loadHistory(false); }
async function loadHistory(more) {
    if (isAnonSession()) { document.getElementById('hist-list').innerHTML = '<div class="hist-empty">History is only kept for signed-in accounts.</div>'; return; }
    if (!more) _histOffset = 0;
    const listEl = document.getElementById('hist-list');
    if (!more) listEl.innerHTML = '<div class="loading-spinner">Loading history…</div>';
    try {
        const q = new URLSearchParams({ limit: '40', offset: String(_histOffset) });
        if (_histService) q.set('service', _histService);
        const term = document.getElementById('hist-q').value.trim(); if (term) q.set('q', term);
        const data = await apiFetch('/api/history?' + q);
        document.getElementById('hist-pause').checked = !!data.paused;
        if (!_histLoaded || !more) {
            const chips = document.getElementById('hist-chips');
            chips.innerHTML = `<button class="${_histService ? '' : 'active'}" onclick="histFilter('', this)">All</button>` + (data.services || []).map(s => `<button class="${_histService === s.service ? 'active' : ''}" onclick="histFilter('${esc(s.service)}', this)">${esc(s.label || s.service)} <span style="opacity:.6">${s.count}</span></button>`).join('');
            _histLoaded = true;
        }
        const items = data.items || [];
        if (!more && !items.length) { listEl.innerHTML = `<div class="hist-empty"><i class="fa-solid fa-clock-rotate-left" style="font-size:22px;display:block;margin-bottom:8px;opacity:.5"></i>${term || _histService ? 'Nothing matches.' : 'Nothing yet — open a tool, watch a stream or read a paste and it shows up here.'}</div>`; document.getElementById('hist-more-row').style.display = 'none'; return; }
        const dayOf = (iso) => { const d = new Date(String(iso).replace(' ', 'T') + 'Z'); const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1); if (d.toDateString() === today.toDateString()) return 'Today'; if (d.toDateString() === y.toDateString()) return 'Yesterday'; return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
        const timeOf = (iso) => new Date(String(iso).replace(' ', 'T') + 'Z').toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        let html = '', lastDay = more ? (listEl.dataset.lastDay || '') : '';
        for (const h of items) {
            const day = dayOf(h.updated_at);
            if (day !== lastDay) { html += `<div class="hist-day">${esc(day)}</div>`; lastDay = day; }
            let host = ''; try { host = new URL(h.url).hostname; } catch {}
            html += `<a class="hist-item" href="${esc(h.url)}" data-id="${h.id}"><span class="hi"><i class="fa-solid ${esc(h.icon || 'fa-file-lines')}"></i></span><div style="min-width:0"><div class="ht">${esc(h.title)}</div><div class="hs">${esc(h.service_label || host)} · ${esc(host)}${h.hits > 1 ? ` · ${h.hits}×` : ''}</div></div><div class="hx"><span>${esc(timeOf(h.updated_at))}</span><button title="Remove" onclick="removeHistoryItem(event, ${h.id})"><i class="fa-solid fa-xmark"></i></button></div></a>`;
        }
        listEl.dataset.lastDay = lastDay;
        if (more) listEl.insertAdjacentHTML('beforeend', html); else listEl.innerHTML = html;
        _histOffset += items.length;
        document.getElementById('hist-more-row').style.display = _histOffset < (data.total || 0) ? '' : 'none';
    } catch (err) { listEl.innerHTML = `<div class="hist-empty">Could not load history: ${esc(err.message)}</div>`; }
}
async function toggleHistoryPause(cb) {
    try { await apiFetch('/api/history/settings', { method: 'PUT', body: JSON.stringify({ paused: cb.checked }) }); toast(cb.checked ? 'History paused — nothing new is recorded.' : 'History recording resumed.'); }
    catch (e) { cb.checked = !cb.checked; toast(e.message, 'error'); }
}
async function clearHistory() {
    if (!confirm('Delete your whole OpenVibe history? This cannot be undone.')) return;
    try { await apiFetch('/api/history', { method: 'DELETE' }); _histLoaded = false; loadHistory(false); toast('History cleared.', 'success'); } catch (e) { toast(e.message, 'error'); }
}
async function removeHistoryItem(ev, id) {
    ev.preventDefault(); ev.stopPropagation();
    const el = document.querySelector(`.hist-item[data-id="${id}"]`);
    try { await apiFetch('/api/history/' + id, { method: 'DELETE' }); if (el) { el.style.transition = 'opacity .2s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 200); } } catch (e) { toast(e.message, 'error'); }
}

// Sessions
async function loadSessions() {
    if (isAnonSession()) {
        document.getElementById('sessions-list').innerHTML = '<p style="color:var(--text-muted);font-size:13px">Anonymous mode does not create device sessions.</p>';
        return;
    }
    try {
        const data = await apiFetch('/api/auth/sessions');
        const list = document.getElementById('sessions-list');
        if (data.sessions.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No active sessions.</p>';
        } else {
            list.innerHTML = data.sessions.map(s => `
                <div class="linked-item">
                    <span class="svc-icon"><i class="fa-solid fa-mobile-screen"></i></span>
                    <div>
                        <div class="svc-name">${s.device_name || 'Unknown Device'}</div>
                        <div class="svc-user">IP: ${s.ip || '?'} · Last used: ${new Date(s.last_used).toLocaleDateString()}</div>
                    </div>
                    <button class="btn btn-danger" onclick="revokeSession(${s.id})">Revoke</button>
                </div>
            `).join('');
        }
    } catch (err) { document.getElementById('sessions-list').innerHTML = '<p style="color:var(--text-muted)">Unable to load sessions.</p>'; }
}

// Blocked people (platform blocks: /api/v1/me/blocks), built from DOM nodes.
async function loadBlocks() {
    const box = document.getElementById('blocks-list');
    if (!box) return;
    if (isAnonSession()) { box.textContent = 'Anonymous identities cannot block people.'; return; }
    try {
        const data = await apiFetch('/api/v1/me/blocks');
        box.replaceChildren();
        if (!(data.blocks || []).length) {
            const p = document.createElement('p'); p.style.cssText = 'color:var(--text-muted);font-size:13px'; p.textContent = 'You have not blocked anyone.';
            box.appendChild(p); return;
        }
        for (const b of data.blocks) {
            const row = document.createElement('div'); row.className = 'module-row';
            const main = document.createElement('div'); main.className = 'module-row-main';
            const title = document.createElement('strong'); title.textContent = b.display_name || b.username || 'Deleted account';
            const info = document.createElement('small');
            info.textContent = `${b.username ? '@' + b.username + ' · ' : ''}blocked ${b.blocked_at ? new Date(b.blocked_at).toLocaleDateString() : 'recently'}`;
            main.append(title, info);
            const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-small';
            btn.textContent = 'Unblock'; btn.setAttribute('aria-label', 'Unblock ' + (b.username || b.subject));
            btn.addEventListener('click', () => unblockPerson(b, btn));
            row.append(main, btn);
            box.appendChild(row);
        }
    } catch { box.textContent = 'Could not load the people you blocked. Try again later.'; }
}
async function blockPerson(e) {
    e.preventDefault();
    const input = document.getElementById('block-username');
    const status = document.getElementById('blocks-status');
    const name = input.value.trim().replace(/^@/, '');
    if (!name) return;
    try {
        await apiFetch('/api/v1/me/blocks/' + encodeURIComponent(name), { method: 'PUT' });
        if (status) status.textContent = `Blocked @${name}.`;
        input.value = '';
    } catch (err) {
        if (status) status.textContent = err.status === 404 ? 'Nobody has that username.' : err.status === 400 ? 'You cannot block that account.' : 'Could not block. Try again.';
    }
    loadBlocks();
}
async function unblockPerson(b, btn) {
    const status = document.getElementById('blocks-status');
    btn.disabled = true;
    try {
        await apiFetch('/api/v1/me/blocks/' + encodeURIComponent(b.subject), { method: 'DELETE' });
        if (status) status.textContent = `Unblocked ${b.username ? '@' + b.username : 'that account'}.`;
    } catch (e) {
        if (status) status.textContent = e.status === 404 ? 'Already unblocked.' : 'Could not unblock. Try again.';
    }
    loadBlocks();
}

async function revokeSession(id) {
    try { await apiFetch('/api/auth/sessions/' + id, { method: 'DELETE' }); loadSessions(); }
    catch (err) { alert('Error: ' + err.message); }
}

async function revokeAllSessions() {
    if (!confirm('Sign out every other device? They will need to sign in again. You stay signed in here.')) return;
    try {
        const data = await apiFetch('/api/auth/sessions', { method: 'DELETE' });
        if (data.token) {
            localStorage.setItem('ov_token', data.token);
            document.cookie = `ov_token=${data.token};path=/;max-age=${60*60*24*30};SameSite=Lax${location.protocol === 'https:' ? ';Secure' : ''}`;
        }
        loadSessions();
        alert('Signed out everywhere else.');
    } catch (err) { alert('Error: ' + err.message); }
}

// Signed-in apps (public OAuth clients; the extension's Dock sign-in)
async function loadApps() {
    const list = document.getElementById('apps-list');
    if (!list) return;
    if (isAnonSession()) { list.textContent = 'Anonymous mode has no app sign-ins.'; return; }
    try {
        const data = await apiFetch('/api/auth/apps');
        list.replaceChildren();
        const apps = data.apps || [];
        if (!apps.length) {
            const p = document.createElement('p');
            p.style.cssText = 'color:var(--text-muted);font-size:13px';
            p.textContent = 'No apps are signed in.';
            list.appendChild(p);
            return;
        }
        const fmt = (v) => {
            if (!v) return '';
            const t = new Date(String(v).replace(' ', 'T') + (String(v).endsWith('Z') ? '' : 'Z'));
            return Number.isFinite(t.getTime()) ? t.toLocaleDateString() : '';
        };
        for (const app of apps) {
            const row = document.createElement('div'); row.className = 'linked-item';
            const icon = document.createElement('span'); icon.className = 'svc-icon';
            const i = document.createElement('i'); i.className = 'fa-solid fa-plug'; icon.appendChild(i);
            const main = document.createElement('div');
            const name = document.createElement('div'); name.className = 'svc-name'; name.textContent = app.name || app.client_id;
            const meta = document.createElement('div'); meta.className = 'svc-user';
            const scopes = String(app.scope || '').split(/\s+/).filter(Boolean).join(', ');
            meta.textContent = `Signed in ${fmt(app.first_seen) || 'recently'} · last used ${fmt(app.last_refresh) || 'recently'}${scopes ? ' · ' + scopes : ''}`;
            main.append(name, meta);
            const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-danger';
            btn.textContent = 'Revoke'; btn.setAttribute('aria-label', `Revoke ${app.name || app.client_id}`);
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try { await apiFetch('/api/auth/apps/' + encodeURIComponent(app.family_id), { method: 'DELETE' }); }
                catch { /* the list reload says what is left */ }
                loadApps();
            });
            row.append(icon, main, btn);
            list.appendChild(row);
        }
    } catch {
        list.textContent = 'Unable to load signed-in apps.';
    }
}

async function signOutEverywhere() {
    if (!confirm('Sign out on every device and every OpenVibe site, this one included?')) return;
    try { await apiFetch('/api/auth/sign-out-everywhere', { method: 'POST' }); }
    catch (err) { alert('Error: ' + err.message); return; }
    try { localStorage.removeItem('ov_token'); } catch { /* storage may be blocked */ }
    location.href = '/sso/fanout?action=logout&next=%2Flogin';
}

// Anon info
async function loadAnonInfo() {
    const anonToken = localStorage.getItem('openvibe_anon_token');
    const container = document.getElementById('anon-info');
    if (!anonToken && !currentUser?.anon_number) {
        container.innerHTML = `
            <p style="color:var(--text-muted);font-size:14px"><i class="fa-solid fa-user-secret"></i></p>
            <p style="color:var(--text-muted);font-size:13px;margin-top:8px">You don't have an anonymous identity yet.</p>
            <button class="btn btn-outline" onclick="createAnon()" style="margin-top:12px">Create Anonymous Identity</button>
        `;
        return;
    }

    if (currentUser?.is_anon) {
        container.innerHTML = `
            <p style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px">Current Anonymous Session</p>
            <div class="number">#${currentUser.anon_number}</div>
            <p style="font-size:12px;color:var(--text-muted)">You're currently browsing as an anonymous identity.</p>
        `;
        return;
    }

    if (currentUser?.anon_number) {
        container.innerHTML = `
            <p style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px">Your Anonymous Number</p>
            <div class="number">#${currentUser.anon_number}</div>
            <p style="font-size:12px;color:var(--text-muted)">This number is permanently linked to your account.</p>
        `;
        return;
    }

    try {
        const data = await fetch(API + '/api/auth/anon/' + anonToken).then(r => r.json());
        if (data.user) {
            container.innerHTML = `
                <p style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px">Your Anonymous Number</p>
                <div class="number">#${data.user.anon_number}</div>
                <div class="label">First seen ${new Date(data.user.first_seen).toLocaleDateString()}</div>
                <div class="stats">
                    <div class="stat"><div class="val">${data.user.total_messages}</div><div class="key">Messages</div></div>
                    <div class="stat"><div class="val">${data.user.total_commands}</div><div class="key">Commands</div></div>
                </div>
            `;
        }
    } catch (err) {
        container.innerHTML = '<p style="color:var(--text-muted)">Unable to load anonymous info.</p>';
    }
}

async function createAnon() {
    try {
        const res = await fetch(API + '/api/auth/anon-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        localStorage.setItem('openvibe_anon_token', data.token);
        const accounts = getStoredAccounts().filter(a => !a.is_anon);
        accounts.push({ id: 'anon', username: data.user.username, display_name: data.user.display_name, is_anon: true, anon_number: data.user.anon_number, token: data.token, avatar_url: null, email: null });
        localStorage.setItem('openvibe_accounts', JSON.stringify(accounts));
        loadAnonInfo();
    } catch (err) { alert('Error: ' + err.message); }
}

async function linkAnon() {
    if (currentUser?.is_anon) { alert('Switch to a real account before linking this anonymous identity.'); return; }
    const anonToken = localStorage.getItem('openvibe_anon_token');
    if (!anonToken) { alert('No anonymous session to link.'); return; }
    try {
        await apiFetch('/api/auth/anon/' + anonToken + '/link', { method: 'POST' });
        alert('Anonymous identity linked!');
        location.reload();
    } catch (err) { alert('Error: ' + err.message); }
}

// Password form
document.getElementById('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isAnonSession()) { alert('Anonymous identities do not have passwords.'); return; }
    const newPw = document.getElementById('sec-new-pw').value;
    if (newPw !== document.getElementById('sec-confirm-pw').value) { alert('Passwords do not match'); return; }
    try {
        const data = await apiFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify({
            current_password: document.getElementById('sec-current-pw').value,
            new_password: newPw,
        })});
        localStorage.setItem('ov_token', data.token);
        document.cookie = `ov_token=${data.token};path=/;max-age=${60*60*24*30};SameSite=Lax${location.protocol === 'https:' ? ';Secure' : ''}`;
        alert(data.message || 'Password changed!');
        document.getElementById('password-form').reset();
    } catch (err) { alert('Error: ' + err.message); }
});

/* ── Sign in on another device ──────────────────────────────────────────────────────────────
   The source-device half of server/auth/qr-signin.js: start a transfer, show the QR for 120 s, poll
   every 2 s, then approve the two-digit number the target device shows. The target opens /q; nothing
   here holds the QR's secret after the start response. */
const QR_PHONE_ICON = '<svg viewBox="0 0 24 24" fill="none"><rect x="7" y="2.5" width="10" height="19" rx="2.6" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const QR_LAPTOP_ICON = '<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="5" width="17" height="11" rx="1.6" stroke="currentColor" stroke-width="1.8"/><path d="M2 18.5h20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
let qrTransfer = null;
let qrPollTimer = null;
let qrTickTimer = null;
let qrExpireTimer = null;

function loadQrSignin(features) {
    const card = document.getElementById('qr-signin-card');
    if (card) card.hidden = !(features && features.qr_signin);
}

function qrPost(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getAuthToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(API + path, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body || {}) })
        .then(async (res) => {
            let data = {};
            try { data = await res.json(); } catch { /* empty answer */ }
            return { ok: res.ok, status: res.status, data };
        });
}

function qrSetView(which) {
    const scan = document.getElementById('qr-scan-view');
    const confirm = document.getElementById('qr-confirm-view');
    const done = document.getElementById('qr-done-view');
    if (!scan || !confirm || !done) return;
    scan.hidden = which !== 'scan';
    confirm.hidden = which !== 'confirm';
    done.hidden = which !== 'done';
    qrSetSteps(which);
}

function qrSetSteps(phase) {
    document.querySelectorAll('#qr-steps li').forEach((li, index) => {
        const n = index + 1;
        const done = phase === 'done' || (phase === 'confirm' && n < 3);
        const current = (phase === 'scan' && n === 1) || (phase === 'confirm' && n === 3);
        li.classList.toggle('is-done', done);
        li.classList.toggle('is-current', current);
        const marker = li.querySelector('.qr-step-n');
        if (marker) { marker.textContent = done ? '✓' : String(n); marker.setAttribute('aria-hidden', 'true'); }
    });
}

function qrSetDevice(device) {
    const label = device || 'Your other device';
    const name = document.getElementById('qr-device-name');
    if (name) name.textContent = label;
    const target = String(label).split(' · ')[0];
    const phone = /iPhone|Android|Phone/i.test(target) && !/iPad|Tablet/i.test(target);
    const icon = document.getElementById('qr-device-icon');
    if (icon) icon.innerHTML = phone ? QR_PHONE_ICON : QR_LAPTOP_ICON;
}

function qrStopTimers() {
    if (qrPollTimer) { clearTimeout(qrPollTimer); qrPollTimer = null; }
    if (qrTickTimer) { clearInterval(qrTickTimer); qrTickTimer = null; }
    if (qrExpireTimer) { clearTimeout(qrExpireTimer); qrExpireTimer = null; }
}

function qrReset() {
    qrStopTimers();
    qrTransfer = null;
    const code = document.getElementById('qr-code');
    if (code) code.replaceChildren();
    const expired = document.getElementById('qr-expired');
    if (expired) { expired.hidden = true; const p = expired.querySelector('p'); if (p) p.textContent = 'This code expired'; }
    document.getElementById('qr-tile')?.classList.remove('is-expired');
    const err = document.getElementById('qr-error');
    if (err) { err.hidden = true; err.textContent = ''; }
    for (const id of ['qr-digit-1', 'qr-digit-2']) { const el = document.getElementById(id); if (el) el.value = ''; }
    const fill = document.getElementById('qr-bar-fill');
    if (fill) { fill.style.transition = 'none'; fill.style.width = '100%'; }
    const timer = document.getElementById('qr-timer');
    if (timer) timer.textContent = 'Code expires in 2:00';
    qrSetView('scan');
}

function qrSigninClose() {
    const dialog = document.getElementById('qr-dialog');
    qrStopTimers();
    if (dialog && dialog.open) dialog.close();
}

function qrSigninOpen() {
    const dialog = document.getElementById('qr-dialog');
    if (!dialog) return;
    qrReset();
    if (!dialog.open) dialog.showModal();
    const title = document.getElementById('qr-title');
    if (title) title.focus({ preventScroll: true });
    qrSigninStart();
}

function qrSigninNewCode() { qrSigninStart(); }

async function qrSigninStart() {
    qrReset();
    const timer = document.getElementById('qr-timer');
    const started = await qrPost('/auth/qr/start', {});
    if (!started.ok) {
        if (started.status === 404) { // the flag is off after all: no entry point draws a code
            qrSigninClose();
            const card = document.getElementById('qr-signin-card');
            if (card) card.hidden = true;
            return;
        }
        if (timer) timer.textContent = started.status === 429
            ? 'Finish or cancel the code you already have first.'
            : 'Could not make a code. Try again.';
        return;
    }
    qrTransfer = { id: started.data.id, expiresAt: Date.parse(started.data.expires_at), device: null };
    document.getElementById('qr-code').innerHTML = started.data.qr_svg; // rendered by Network's qrcode, never a third party
    qrDrain(started.data.expires_at);
    qrPoll();
}

function qrDrain(expiresAt) {
    const left = Math.max(0, Date.parse(expiresAt) - Date.now());
    const fill = document.getElementById('qr-bar-fill');
    if (fill) {
        fill.style.transition = 'none';
        fill.style.width = '100%';
        void fill.offsetWidth; // start the drain from full
        fill.style.transition = `width ${left}ms linear`;
        fill.style.width = '0%';
    }
    const timer = document.getElementById('qr-timer');
    const tick = () => {
        if (!qrTransfer) return;
        const ms = Math.max(0, qrTransfer.expiresAt - Date.now());
        const total = Math.ceil(ms / 1000);
        if (timer) timer.textContent = ms > 0 ? `Code expires in ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}` : 'Code expired';
    };
    tick();
    qrTickTimer = setInterval(tick, 1000);
    qrExpireTimer = setTimeout(qrExpire, left);
}

function qrExpire() {
    if (!qrTransfer) return;
    qrStopTimers();
    qrSetView('scan');
    const expired = document.getElementById('qr-expired');
    if (expired) { expired.hidden = false; const p = expired.querySelector('p'); if (p) p.textContent = 'This code expired'; }
    document.getElementById('qr-tile')?.classList.add('is-expired');
    const timer = document.getElementById('qr-timer');
    if (timer) timer.textContent = 'Code expired';
}

function qrStopped(title) {
    qrStopTimers();
    qrSetView('scan');
    const expired = document.getElementById('qr-expired');
    if (expired) { expired.hidden = false; const p = expired.querySelector('p'); if (p) p.textContent = title; }
    document.getElementById('qr-tile')?.classList.add('is-expired');
    const timer = document.getElementById('qr-timer');
    if (timer) timer.textContent = 'Code closed';
}

async function qrPoll() {
    if (!qrTransfer) return;
    const dialog = document.getElementById('qr-dialog');
    if (!dialog || !dialog.open) return;
    try {
        const token = getAuthToken();
        const res = await fetch(`${API}/auth/qr/${encodeURIComponent(qrTransfer.id)}`, {
            credentials: 'include', cache: 'no-store', headers: token ? { Authorization: 'Bearer ' + token } : {},
        });
        if (res.status === 404) { qrExpire(); return; }
        if (res.status === 403) { qrSigninClose(); return; }
        if (!res.ok) throw new Error('poll');
        const data = await res.json();
        if (!qrTransfer) return;
        if (data.state === 'scanned') {
            qrTransfer.device = data.device || null;
            qrShowConfirm();
        } else if (data.state === 'approved') {
            const timer = document.getElementById('qr-timer');
            if (timer) timer.textContent = 'Approved — finishing on your other device…';
        } else if (data.state === 'denied') {
            qrStopped('This code was denied');
            return;
        } else if (data.state === 'used') {
            qrDone(data.device || qrTransfer.device);
            return;
        }
    } catch { /* one failed poll is fine; keep waiting */ }
    qrPollTimer = setTimeout(qrPoll, 2000);
}

function qrShowConfirm() {
    if (!qrTransfer) return;
    const confirm = document.getElementById('qr-confirm-view');
    if (!confirm.hidden) return;
    qrSetView('confirm');
    qrSetDevice(qrTransfer.device);
    const err = document.getElementById('qr-error');
    if (err) { err.hidden = true; err.textContent = ''; }
    setTimeout(() => document.getElementById('qr-digit-1')?.focus(), 30);
}

function qrWrongCode(left) {
    const box = document.getElementById('qr-confirm-view');
    if (box) {
        box.classList.remove('qr-shake');
        void box.offsetWidth;
        box.classList.add('qr-shake');
        setTimeout(() => box.classList.remove('qr-shake'), 420);
    }
    const err = document.getElementById('qr-error');
    if (err) {
        err.hidden = false;
        err.textContent = left > 0
            ? `That number doesn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.`
            : "That number doesn't match.";
    }
    const a = document.getElementById('qr-digit-1');
    const b = document.getElementById('qr-digit-2');
    if (a) a.value = '';
    if (b) b.value = '';
    if (a) a.focus();
}

async function qrSigninApprove() {
    if (!qrTransfer) return;
    const a = document.getElementById('qr-digit-1')?.value || '';
    const b = document.getElementById('qr-digit-2')?.value || '';
    if (!/^[0-9]$/.test(a) || !/^[0-9]$/.test(b)) { qrWrongCode(0); return; }
    const btn = document.getElementById('qr-approve');
    if (btn) btn.disabled = true;
    try {
        const res = await qrPost(`/auth/qr/${encodeURIComponent(qrTransfer.id)}/approve`, { code: a + b });
        if (res.ok) {
            const timer = document.getElementById('qr-timer');
            if (timer) timer.textContent = 'Approved — finishing on your other device…';
            return;
        }
        if (res.status === 400 && res.data.error === 'code_mismatch') { qrWrongCode(Number(res.data.attempts_left) || 0); return; }
        if (res.status === 403) { qrStopped('This code was denied'); return; }
        if (res.status === 404) { qrExpire(); return; }
        qrWrongCode(0);
    } catch {
        const err = document.getElementById('qr-error');
        if (err) { err.hidden = false; err.textContent = 'Could not check that number. Try again.'; }
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function qrSigninDeny() {
    if (qrTransfer) await qrPost(`/auth/qr/${encodeURIComponent(qrTransfer.id)}/deny`, {}).catch(() => {});
    qrSigninClose();
}

function qrDone(device) {
    qrStopTimers();
    const name = String(device || 'your other device').split(' · ')[0];
    const text = document.getElementById('qr-done-text');
    if (text) text.textContent = `Signed in on ${name}`;
    qrSetView('done');
}

function qrDigit(input, nextId) {
    const value = String(input.value || '').replace(/[^0-9]/g, '').slice(-1);
    input.value = value;
    if (value && nextId) document.getElementById(nextId)?.focus();
}

function qrDigitKey(event, input) {
    if (event.key === 'Backspace' && !input.value) {
        const previous = input.id === 'qr-digit-2' ? document.getElementById('qr-digit-1') : null;
        if (previous) { previous.focus(); previous.value = ''; event.preventDefault(); }
    }
}

loadQrSignin(null); // hidden until /api/auth/me says the feature is on (profile.js calls loadQrSignin)


document.getElementById('qr-dialog')?.addEventListener('close', qrStopTimers);
