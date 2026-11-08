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
            list.innerHTML = rows.length ? rows.map((e) => `<article style="padding:12px 0;border-bottom:1px solid var(--border,#ddd)"><strong>${esc(e.email)}</strong> · ${e.verified ? 'Verified' : 'Not verified'}${e.primary ? ' · Primary' : ''}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${e.verified ? '' : `<button type="button" data-verify="${esc(e.id)}">Send verification link</button>`}${e.primary || !e.verified ? '' : `<button type="button" data-primary="${esc(e.id)}">Make primary</button>`}${e.primary ? '' : `<button type="button" data-remove="${esc(e.id)}">Remove</button>`}</div></article>`).join('') : 'No email addresses are attached to this account yet.';
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
        } catch (error) { message.textContent = error.message || 'Could not update your email addresses.'; }
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
