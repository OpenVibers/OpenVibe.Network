/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): the users tab.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════
// Users (from the openvibe.network central user DB)
// ═══════════════════════════════════════════════════════════════
let usersOffset = 0;
async function loadUsers() {
    const c = document.getElementById('users-content');
    const pager = document.getElementById('users-pager');
    const search = document.getElementById('user-search')?.value.trim() || '';
    c.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const params = new URLSearchParams({ limit: '50', offset: String(usersOffset) });
        if (search) params.set('search', search);
        const data = await api(`/api/admin/users?${params}`);
        const users = data.users || [];
        const total = data.total || 0;

        if (!users.length) { c.innerHTML = '<p class="muted">No accounts match. Clear the search or try a different username or email.</p>'; pager.innerHTML = ''; return; }

        c.innerHTML = `
            <table class="admin-table">
                <thead><tr>
                    <th>Username</th><th>Display Name</th><th>Email</th><th>Role</th><th>Created</th><th>Last Seen</th><th>Actions</th>
                </tr></thead>
                <tbody>${users.map(u => `
                    <tr>
                        <td data-label="Username"><strong>${esc(u.username)}</strong></td>
                        <td data-label="Display name">${esc(u.display_name || '-')}</td>
                        <td data-label="Email" style="font-size:11px">${esc(u.email || '-')}</td>
                        <td data-label="Access role"><span class="badge badge-${u.role}">${esc({user:'Member access',streamer:'Streamer access',global_mod:'Network moderator access',admin:'Administrator access'}[u.role] || adminWords(u.role))}</span></td>
                        <td data-label="Created" style="font-size:11px">${u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}</td>
                        <td data-label="Last seen" style="font-size:11px">${u.last_seen ? timeAgo(u.last_seen) : 'Never'}</td>
                        <td data-label="Account actions" style="display:flex;gap:4px;align-items:center">
                            <select aria-label="Account role; changes immediately, select the old role to undo" onchange="changeUserRole('${u.id}',this.value)" style="padding:4px 6px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:11px">
                                ${['user','streamer','global_mod','admin'].map(r =>
                                    `<option value="${r}" ${r===u.role?'selected':''}>${{user:'Member — standard account',streamer:'Streamer — broadcast access',global_mod:'Global moderator — moderate across channels',admin:'Administrator — manage the network'}[r]}</option>`
                                ).join('')}
                            </select>
                            ${u.is_banned ?
                                `<button class="btn btn-sm btn-success" title="Restore access; ban again to restrict it" aria-label="Unban account" onclick="toggleBan('${u.id}','${esc(u.username)}',false)"><i class="fa-solid fa-user-check" aria-hidden="true"></i> Restore access</button>` :
                                `<button class="btn btn-sm btn-danger" title="Block access; use Unban to restore it" aria-label="Ban account" onclick="toggleBan('${u.id}','${esc(u.username)}',true)"><i class="fa-solid fa-ban" aria-hidden="true"></i> Ban account</button>`
                            }
                            <button class="btn btn-sm btn-outline" title="Rename (the old name redirects on Live and stays reserved)" onclick="renameUser('${u.id}','${esc(u.username)}')"><i class="fa-solid fa-signature" aria-hidden="true"></i> Rename</button>
                            <button class="btn btn-sm btn-outline" title="Sign out on every device and site" onclick="signOutUser('${u.id}','${esc(u.username)}')"><i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i> Sign out</button>
                            ${currentUser?.is_owner ? `
                                <button class="btn btn-sm btn-outline" title="Edit email address"
                                        onclick="editUserEmail('${u.id}','${esc(u.username)}','${esc(u.email || '')}')"><i class="fa-solid fa-envelope" aria-hidden="true"></i> Edit email</button>
                                <button class="btn btn-sm btn-outline" title="${u.email ? 'Send a password reset link' : 'No email address on file'}"
                                        ${u.email ? '' : 'disabled'}
                                        onclick="sendUserReset('${u.id}','${esc(u.username)}')"><i class="fa-solid fa-key" aria-hidden="true"></i> Send reset email</button>
                            ` : ''}
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;

        const pages = Math.ceil(total / 50);
        const curPage = Math.floor(usersOffset / 50) + 1;
        pager.innerHTML = pages > 1 ? `
            <button class="btn btn-sm btn-outline" aria-label="Previous page" ${usersOffset <= 0 ? 'disabled' : ''} onclick="usersOffset=Math.max(0,usersOffset-50);loadUsers()"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="muted">Page ${curPage} / ${pages} (${total} total)</span>
            <button class="btn btn-sm btn-outline" aria-label="Next page" ${curPage >= pages ? 'disabled' : ''} onclick="usersOffset+=50;loadUsers()"><i class="fa-solid fa-chevron-right"></i></button>
        ` : `<span class="muted">${total} account${total === 1 ? '' : 's'}</span>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; pager.innerHTML = ''; }
}

async function changeUserRole(userId, role) {
    try {
        await api(`/api/admin/users/${userId}/role`, { method: 'PUT', body: { role } });
        toast(`Role updated to ${adminWords(role)}`, 'success');
    } catch (e) { toast(e.message, 'error'); loadUsers(); }
}

// ── Owner-only account recovery ──────────────────────────────────────────────
// The server enforces owner-only on both of these (requireOwner); hiding the buttons
// for non-owners is purely so admins are not shown controls they cannot use.
async function editUserEmail(userId, username, current) {
    const next = prompt(`Email address for @${username}\n\nLeave blank to remove it, which prevents email recovery. Enter the previous address again to undo.`, current || '');
    if (next === null) return;                       // cancelled
    const email = next.trim();
    if (email === (current || '').trim()) return;    // unchanged
    try {
        const r = await api(`/api/admin/users/${userId}/email`, { method: 'PUT', body: { email } });
        toast(r.email ? `Email for @${username} set to ${r.email}` : `Email removed from @${username}`, 'success');
        loadUsers();
    } catch (e) { toast(e.message, 'error'); }
}

async function sendUserReset(userId, username) {
    // The link is emailed to the account holder and never shown here — that is what keeps
    // this a recovery tool rather than a way to take over an account.
    if (!confirm(`Send a password reset link to @${username}?\n\nIt goes to their email address on file and expires in 1 hour. Any previous reset link for this account stops working.`)) return;
    try {
        const r = await api(`/api/admin/users/${userId}/send-reset`, { method: 'POST' });
        toast(`Reset link sent to ${r.sentTo} (expires in ${r.expiresMinutes} min)`, 'success');
    } catch (e) { toast(e.message, 'error'); }
}

async function renameUser(userId, username) {
    const next = prompt(`New username for ${username}? (3-24 letters, numbers, underscores. /@${username} will redirect to it on Live, and "${username}" stays reserved for them.)`, username);
    if (next === null || next.trim() === username) return;
    try {
        const r = await api(`/api/admin/users/${userId}/username`, { method: 'PUT', body: { username: next.trim() } });
        toast(`${r.from} is now ${r.to}`, 'success');
        loadUsers();
    } catch (e) { toast(e.message, 'error'); }
}

async function signOutUser(userId, username) {
    if (!confirm(`Sign ${username} out on every device and every OpenVibe site? Existing sessions stop working; they must sign in again to restore access.`)) return;
    try {
        await api(`/api/admin/users/${userId}/sign-out`, { method: 'POST' });
        toast(`${username} signed out everywhere`, 'success');
    } catch (e) { toast(e.message, 'error'); }
}

async function toggleBan(userId, username, ban) {
    if (ban) {
        const reason = prompt(`Ban ${username}? This blocks account access. Use Unban to restore access. Enter the reason:`);
        if (reason === null) return;
        try {
            await api(`/api/admin/users/${userId}/ban`, { method: 'PUT', body: { banned: true, reason } });
            toast(`${username} banned`, 'success');
            loadUsers();
        } catch (e) { toast(e.message, 'error'); }
    } else {
        try {
            await api(`/api/admin/users/${userId}/ban`, { method: 'PUT', body: { banned: false } });
            toast(`${username} unbanned`, 'success');
            loadUsers();
        } catch (e) { toast(e.message, 'error'); }
    }
}
