'use strict';
(() => {
    const form = document.querySelector('[data-egress-settings]');
    if (!form) return;
    const status = form.querySelector('[data-egress-status]');
    const url = '/api/v1/me/nodes/egress';
    let loaded = false;
    fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(async r => {
        if (!r.ok) throw Error('Sign in to change your browsing settings.');
        const p = await r.json();
        form.elements.enabled.checked = p.egress_via_link;
        form.elements.offline.value = p.offline_choice;
        form.elements.cap.value = p.monthly_bytes / 1e9;
        form.elements.sites.value = p.excluded_sites.join(', ');
        loaded = true;
    }).catch(e => { status.textContent = e.message; });
    form.addEventListener('submit', async e => {
        e.preventDefault();
        if (!loaded) { status.textContent = 'Sign in to change your browsing settings.'; return; }
        try {
            const r = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ egress_via_link: form.elements.enabled.checked, offline_choice: form.elements.offline.value,
                    monthly_bytes: Math.round(Number(form.elements.cap.value) * 1e9),
                    excluded_sites: form.elements.sites.value.split(/[\s,]+/).filter(Boolean) }) });
            status.textContent = r.ok ? 'Browsing settings saved.' : 'Check the limit and site names, then try again.';
        } catch { status.textContent = 'Your settings could not be saved. Try again.'; }
    });
})();
