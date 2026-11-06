/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): Apps (Compute plan E7).

   The apps this person's agents may act in, and the callers they may act
   as. It is a summary: the walkthrough, the paste box, the grants and the
   log live on the Apps page (/apps), which this section links to.

   Classic script, global scope; relies on my/core.js (apiFetch, toast).
   ═══════════════════════════════════════════════════════════════ */

function appsEl(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
}

async function loadApps() {
    const list = document.getElementById('apps-list');
    if (!list) return;
    if (typeof isAnonSession === 'function' && isAnonSession()) {
        list.replaceChildren(appsEl('p', { class: 'muted', style: 'font-size:13px', text: 'Apps are only available once you sign in with a full OpenVibe account.' }));
        return;
    }
    try {
        const [cat, creds] = await Promise.all([
            apiFetch('/api/v1/connect/catalogue'),
            apiFetch('/api/v1/connect/credentials'),
        ]);
        const apps = (cat && cat.apps) || [];
        const connected = (creds && creds.credentials) || [];
        if (!connected.length) {
            list.replaceChildren(appsEl('p', { class: 'muted', style: 'font-size:13px', text: 'No app is connected yet. Pick one from the catalogue and paste your own key.' }));
            return;
        }
        list.replaceChildren(...connected.map((c) => {
            const app = apps.find((a) => a.key === c.app);
            const when = c.last_used_at ? new Date(c.last_used_at).toLocaleDateString() : 'not used yet';
            return appsEl('div', { class: 'approval', style: 'padding:10px 12px' },
                appsEl('div', { class: 'approval-summary', text: (app && app.name) || c.app }),
                appsEl('div', { class: 'approval-meta', text: [c.label !== 'default' ? c.label : '', c.scopes && c.scopes.length ? c.scopes.join(', ') : '', when].filter(Boolean).join(' \u00b7 ') }));
        }));
    } catch (e) {
        list.replaceChildren(appsEl('p', { class: 'muted', style: 'font-size:13px', text: 'Could not load your apps: ' + e.message }));
    }
}
