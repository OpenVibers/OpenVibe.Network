'use strict';
(() => {
    const list = document.getElementById('account-emails-list');
    const form = document.getElementById('account-email-add');
    const message = document.getElementById('account-emails-message');
    if (!list || !form) return;
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    async function refresh() {
        try {
            const data = await apiFetch('/api/v1/me/emails');
            const rows = data.emails || [];
            // Each address says what it is beside it (the kit's badges) and carries its own actions (the kit's buttons).
            const btn = (kind, attr, id, label) => `<button type="button" class="ovk-btn ovk-btn--small ovk-btn--${kind}" ${attr}="${esc(id)}">${label}</button>`;
            list.innerHTML = rows.length ? rows.map((e) => {
                const acts = (e.verified ? '' : btn('primary', 'data-verify', e.id, 'Send verification link')) + (e.primary || !e.verified ? '' : btn('quiet', 'data-primary', e.id, 'Make primary')) + (e.primary ? '' : btn('quiet', 'data-remove', e.id, 'Remove'));
                return `<article class="my-email"><div class="my-email-top"><strong>${esc(e.email)}</strong><span class="ovk-badge ${e.verified ? 'ovk-badge--ok' : 'ovk-badge--warn'}">${e.verified ? 'Verified' : 'Not verified'}</span>${e.primary ? '<span class="ovk-badge ovk-badge--accent">Primary</span>' : ''}</div>${acts ? `<div class="my-email-acts">${acts}</div>` : ''}</article>`;
            }).join('') : 'No email addresses are attached to this account yet.';
        } catch { list.textContent = 'Could not load your email addresses.'; }
    }
    list.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        try {
            if (button.dataset.verify) await apiFetch(`/api/v1/me/emails/${encodeURIComponent(button.dataset.verify)}/verify`, { method: 'POST' });
            if (button.dataset.primary) await apiFetch(`/api/v1/me/emails/${encodeURIComponent(button.dataset.primary)}/primary`, { method: 'POST' });
            if (button.dataset.remove) await apiFetch(`/api/v1/me/emails/${encodeURIComponent(button.dataset.remove)}`, { method: 'DELETE' });
            message.textContent = 'Your request was received. Check your email for verification links.';
            await refresh();
        } catch (error) {
            if (error.status === 401 && error.code === 'auth.sign_in_again' && window.OpenVibeReauth) return window.OpenVibeReauth.go('/my#emails');
            message.textContent = error.message || 'Could not update your email addresses.';
        }
    });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('account-email-new');
        try {
            await apiFetch('/api/v1/me/emails', { method: 'POST', body: JSON.stringify({ email: input.value }) });
            input.value = '';
            message.textContent = 'If this address can be added, a verification email will arrive shortly.';
            await refresh();
        } catch (error) { message.textContent = error.message || 'Could not add this email address.'; }
    });
    refresh();
})();
