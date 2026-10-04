/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): payments, cashouts and verification keys.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ── Payments: configure PayPal / Stripe / CCBill / crypto + subscriptions ──
const PAYMENT_GROUPS = [
    { title: 'General', keys: ['payments_enabled', 'bucks_per_usd', 'bucks_min_purchase_usd', 'sub_price_usd', 'sub_streamer_share_pct'] },
    { title: 'PayPal', keys: ['paypal_enabled', 'paypal_mode', 'paypal_client_id', 'paypal_client_secret', 'paypal_webhook_id'] },
    { title: 'Stripe', keys: ['stripe_enabled', 'stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret'] },
    { title: 'CCBill', keys: ['ccbill_enabled', 'ccbill_client_account', 'ccbill_subaccount', 'ccbill_flexform_id', 'ccbill_salt', 'ccbill_webhook_secret'] },
    { title: 'Crypto (NOWPayments)', keys: ['crypto_enabled', 'crypto_provider', 'crypto_api_key', 'crypto_ipn_secret'] },
];
const PAYMENT_WEBHOOKS = {
    Stripe: 'https://openvibe.live/api/payments/webhook/stripe',
    PayPal: 'https://openvibe.live/api/payments/webhook/paypal',
    CCBill: 'https://openvibe.live/api/payments/webhook/ccbill?secret=YOUR_ccbill_webhook_secret',
    'Crypto (NOWPayments)': 'https://openvibe.live/api/payments/webhook/crypto',
};

async function loadPayments() {
    const c = document.getElementById('payments-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/streamer/settings');
        const byKey = {}; (data.settings || []).forEach(s => { byKey[s.key] = s; });
        const field = (s) => {
            if (!s) return '';
            const sensitive = /(secret|salt|api[_-]?key|client_secret|ipn)/i.test(s.key);
            if (s.type === 'boolean') return `
                <div class="setting-row">
                    <label><strong>${esc(s.key)}</strong><br><small>${esc(s.description||'')}</small></label>
                    <input type="checkbox" data-key="${esc(s.key)}" data-type="boolean" ${s.value==='true'?'checked':''} style="width:18px;height:18px;cursor:pointer">
                </div>`;
            const type = s.type === 'number' ? 'number' : (sensitive ? 'password' : 'text');
            return `
                <div class="setting-row" style="flex-direction:column;align-items:stretch">
                    <label><strong>${esc(s.key)}</strong><br><small>${esc(s.description||'')}</small></label>
                    <input type="${type}" data-key="${esc(s.key)}" data-type="${esc(s.type||'string')}" value="${esc(s.value)}"
                        style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">
                </div>`;
        };
        const groups = PAYMENT_GROUPS.map(g => `
            <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:16px">
                <legend style="padding:0 8px;font-weight:700">${esc(g.title)}</legend>
                ${g.keys.map(k => field(byKey[k])).join('')}
                ${PAYMENT_WEBHOOKS[g.title] ? `<p class="muted" style="font-size:12px;margin-top:8px"><i class="fa-solid fa-link"></i> Webhook URL: <code>${esc(PAYMENT_WEBHOOKS[g.title])}</code></p>` : ''}
            </fieldset>`).join('');
        c.innerHTML = `
            <div style="max-width:760px">
                <p class="muted" style="margin-bottom:12px">Configure real-money payments for Vibes &amp; channel subscriptions. Nothing goes live until <strong>payments_enabled</strong> is on and the provider is enabled with valid keys. Set each provider's webhook to the URL shown, and add the redirect/return URLs from OpenVibe.Live.</p>
                <form id="payments-form">${groups}
                    <button type="button" class="btn btn-primary" onclick="savePayments()"><i class="fa-solid fa-floppy-disk"></i> Save Payment Settings</button>
                </form>
            </div>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function savePayments() {
    const inputs = document.querySelectorAll('#payments-form [data-key]');
    const settings = {};
    inputs.forEach(input => {
        settings[input.dataset.key] = input.dataset.type === 'boolean' ? (input.checked ? 'true' : 'false') : input.value;
    });
    try {
        await api('/api/admin/streamer/settings', { method: 'PUT', body: { settings } });
        toast('Payment settings saved', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Cashouts (via funds proxy)
// ═══════════════════════════════════════════════════════════════
async function loadCashouts() {
    const c = document.getElementById('cashouts-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/streamer-funds/cashouts/pending');
        const cashouts = data.cashouts || [];
        if (!cashouts.length) { c.innerHTML = '<p class="muted">No pending cashouts</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr><th>User</th><th>Amount</th><th>USD</th><th>PayPal</th><th>Requested</th><th>Actions</th></tr></thead>
                <tbody>${cashouts.map(co => `
                    <tr>
                        <td><strong>${esc(co.username || '-')}</strong></td>
                        <td>${Number(co.amount || 0).toLocaleString()} CF</td>
                        <td>$${((Number(co.amount) || 0) * 0.01).toFixed(2)}</td>
                        <td>${esc(co.paypal_email || '-')}</td>
                        <td>${co.created_at ? timeAgo(co.created_at) : '-'}</td>
                        <td style="display:flex;gap:6px">
                            <button class="btn btn-sm btn-success" onclick="approveCashout('${co.id}')"><i class="fa-solid fa-check"></i> Approve</button>
                            <button class="btn btn-sm btn-danger" onclick="denyCashout('${co.id}')"><i class="fa-solid fa-xmark"></i> Deny</button>
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

async function approveCashout(id) {
    try {
        await api(`/api/admin/streamer-funds/cashout/${id}/approve`, { method: 'POST' });
        toast('Cashout approved', 'success');
        loadCashouts();
    } catch (e) { toast(e.message, 'error'); }
}

async function denyCashout(id) {
    const reason = prompt('Denial reason:');
    if (reason === null) return;
    try {
        await api(`/api/admin/streamer-funds/cashout/${id}/deny`, { method: 'POST', body: { reason } });
        toast('Cashout denied', 'info');
        loadCashouts();
    } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Verification Keys
// ═══════════════════════════════════════════════════════════════
const secretStore = {};
async function loadVKeys() {
    const c = document.getElementById('vkeys-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/verification-keys');
        const keys = data.keys || [];
        keys.forEach(k => { if (k.key) secretStore[`vk-${k.id}`] = k.key; });
        if (!keys.length) { c.innerHTML = '<p class="muted">No verification keys generated yet</p>'; return; }
        c.innerHTML = `
            <table class="admin-table">
                <thead><tr><th>Key</th><th>Reserved Username</th><th>Status</th><th>Note</th><th>Created</th><th>Actions</th></tr></thead>
                <tbody>${keys.map(k => `
                    <tr>
                        <td><code id="vk-${k.id}" style="font-size:12px;color:var(--text-muted)">••••••••</code></td>
                        <td><strong>${esc(k.target_username)}</strong></td>
                        <td><span class="badge badge-${k.status==='active'?'success':k.status==='used'?'info':'danger'}">${esc(k.status)}</span></td>
                        <td style="font-size:12px">${esc(k.note || '-')}</td>
                        <td style="font-size:11px">${k.created_at ? new Date(k.created_at).toLocaleDateString() : '-'}</td>
                        <td style="display:flex;gap:4px">
                            ${k.status === 'active' ? `
                                <button class="btn btn-sm btn-outline" onclick="revealVKey('vk-${k.id}')"><i class="fa-solid fa-eye"></i></button>
                                <button class="btn btn-sm btn-outline" onclick="copyVKey('vk-${k.id}')"><i class="fa-solid fa-copy"></i></button>
                                <button class="btn btn-sm btn-danger" onclick="revokeVKey('${k.id}')"><i class="fa-solid fa-trash"></i></button>
                            ` : k.status === 'used' ? `<span class="muted">Used by ${esc(k.used_by_name || '?')}</span>` : '<span class="muted">Revoked</span>'}
                        </td>
                    </tr>
                `).join('')}</tbody>
            </table>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

function revealVKey(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const revealed = el.dataset.revealed === 'true';
    el.textContent = revealed ? '••••••••' : (secretStore[id] || '••••••••');
    el.dataset.revealed = revealed ? 'false' : 'true';
    el.style.color = revealed ? 'var(--text-muted)' : 'var(--accent-light)';
}

function copyVKey(id) {
    const val = secretStore[id];
    if (!val) return toast('No key to copy', 'error');
    navigator.clipboard.writeText(val).then(() => toast('Key copied', 'success')).catch(() => toast('Copy failed', 'error'));
}

async function generateVKey() {
    const username = document.getElementById('vkey-username')?.value.trim();
    const note = document.getElementById('vkey-note')?.value.trim();
    if (!username) return toast('Enter a username', 'error');
    try {
        const data = await api('/api/admin/verification-keys', { method: 'POST', body: { target_username: username, note } });
        const key = data.key;
        if (key?.id && key?.key) secretStore[`vk-${key.id}`] = key.key;
        toast('Verification key generated', 'success');
        document.getElementById('vkey-username').value = '';
        document.getElementById('vkey-note').value = '';
        loadVKeys();
    } catch (e) { toast(e.message, 'error'); }
}

async function revokeVKey(id) {
    if (!confirm('Revoke this verification key?')) return;
    try {
        await api(`/api/admin/verification-keys/${id}`, { method: 'DELETE' });
        toast('Key revoked', 'success');
        loadVKeys();
    } catch (e) { toast(e.message, 'error'); }
}
