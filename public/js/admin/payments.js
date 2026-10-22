/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): payment settings, the Billing pointer and verification keys.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ── Payments: the switches and prices OpenVibe.Live reads ──
// OpenVibe.Billing runs every checkout, webhook, subscription and cashout since the cutover of 2026-10-17. Live
// still reads these site settings to decide which ways to pay it offers and at what price (Live's
// server/monetization/payments.js). Provider credentials are Billing's environment variables, never settings here.
const PAYMENT_GROUPS = [
    { title: 'General', keys: ['payments_enabled', 'bucks_per_usd', 'bucks_min_purchase_bucks', 'sub_price_usd', 'sub_streamer_share_pct', 'sub_site_route_fee_pct'] },
    { title: 'PayPal', keys: ['paypal_enabled', 'paypal_client_id'] },
    { title: 'Stripe', keys: ['stripe_enabled', 'stripe_secret_key', 'stripe_publishable_key'] },
    { title: 'CCBill', keys: ['ccbill_enabled', 'ccbill_flexform_id'] },
    { title: 'Crypto (NOWPayments)', keys: ['crypto_enabled', 'crypto_api_key'] },
];
// Where providers send payments (OpenVibe.Billing server/api/webhooks.js) and the variables Billing reads
// (its server/config.js), set in /etc/openvibe/billing.env on the host.
const BILLING_URL = 'https://billing.openvibe.network';
const BILLING_PROVIDERS = [
    { name: 'Stripe', webhook: '/webhooks/stripe', env: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
    { name: 'PayPal', webhook: '/webhooks/paypal', env: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'PAYPAL_MODE'] },
    { name: 'CCBill', webhook: '/webhooks/ccbill?secret=<CCBILL_WEBHOOK_SECRET>', env: ['CCBILL_WEBHOOK_SECRET', 'CCBILL_CLIENT_ACCOUNT', 'CCBILL_SUBACCOUNT', 'CCBILL_FLEXFORM_ID', 'CCBILL_SALT'] },
    { name: 'Crypto (NOWPayments)', webhook: '/webhooks/nowpayments', env: ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET'] },
    { name: 'PowerChat', webhook: '/webhooks/powerchat', env: ['POWERCHAT_WEBHOOK_SECRET', 'POWERCHAT_SITE_USERNAME'] },
];

function billingProvidersCard() {
    const label = (t) => `<span class="muted" style="font-size:11px;display:block">${esc(t)}</span>`;
    const rows = BILLING_PROVIDERS.map(p => `
        <div class="setting-row" style="flex-wrap:wrap;align-items:flex-start;gap:6px 16px">
            <strong style="font-size:13px;flex:0 0 150px">${esc(p.name)}</strong>
            <div style="flex:1 1 300px;min-width:0;display:grid;gap:8px">
                <div>${label('Webhook URL')}<code>${esc(BILLING_URL + p.webhook)}</code></div>
                <div>${label('Billing environment variables')}${p.env.map(v => `<code>${esc(v)}</code>`).join(' ')}</div>
            </div>
        </div>`).join('');
    return `
        <div class="card">
            <h3><i class="fa-solid fa-link" aria-hidden="true"></i> Provider webhooks and credentials</h3>
            <p class="muted" style="margin-bottom:4px">Providers send payments to OpenVibe.Billing: set each provider's webhook to the URL below. Their keys and secrets go in Billing's environment file on the host, <code>/etc/openvibe/billing.env</code>, under these variable names; nothing on this page holds them.</p>
            ${rows}
            <p style="margin-top:14px"><a class="btn btn-outline" href="${BILLING_URL}/" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Open the Billing console</a></p>
        </div>`;
}

async function loadPayments() {
    const c = document.getElementById('payments-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/streamer/settings');
        const byKey = {}; (data.settings || []).forEach(s => { byKey[s.key] = s; });
        const field = (s) => {
            if (!s) return '';
            const sensitive = /(secret|api[_-]?key)/i.test(s.key);
            const id = `pay-${s.key}`;
            if (s.type === 'boolean') return `
                <div class="setting-row">
                    <label for="${esc(id)}"><strong>${esc(s.key)}</strong><br><small>${esc(s.description||'')}</small></label>
                    <input type="checkbox" id="${esc(id)}" data-key="${esc(s.key)}" data-type="boolean" ${s.value==='true'?'checked':''} style="width:18px;height:18px;cursor:pointer">
                </div>`;
            const type = s.type === 'number' ? 'number' : (sensitive ? 'password' : 'text');
            return `
                <div class="setting-row" style="flex-direction:column;align-items:stretch">
                    <label for="${esc(id)}"><strong>${esc(s.key)}</strong><br><small>${esc(s.description||'')}</small></label>
                    <input type="${type}" id="${esc(id)}" data-key="${esc(s.key)}" data-type="${esc(s.type||'string')}" value="${esc(s.value)}" ${sensitive ? 'autocomplete="off"' : ''}
                        style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">
                </div>`;
        };
        const groups = PAYMENT_GROUPS.map(g => `
            <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:16px">
                <legend style="padding:0 8px;font-weight:700">${esc(g.title)}</legend>
                ${g.keys.map(k => field(byKey[k])).join('')}
            </fieldset>`).join('');
        c.innerHTML = `
            <div style="max-width:860px">
                <p class="muted" style="margin-bottom:12px">OpenVibe.Billing runs every checkout, subscription and cashout. These are the switches and prices OpenVibe.Live reads to decide which ways to pay it offers: nothing is offered until <strong>payments_enabled</strong> and the provider are on. Live also checks that <strong>stripe_secret_key</strong> and <strong>crypto_api_key</strong> are filled in before it offers Stripe or crypto; the keys Billing charges with are in its environment (below).</p>
                <form id="payments-form">${groups}
                    <button type="button" class="btn btn-primary" onclick="savePayments()"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save payment settings</button>
                </form>
                <div style="margin-top:20px">${billingProvidersCard()}</div>
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

// Cashouts: the tab is a pointer to OpenVibe.Billing's console (admin.html #sec-cashouts); Live's old cashout queue
// (/api/funds) answers 409 since the Billing cutover.

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
