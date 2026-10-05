/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): Approvals (plan T2 WS-Z2).
   The owner's confirmation inbox: an agent acting for this person asks before
   a sensitive capability runs (server/developer/confirmations.js). Lists the
   pending requests from GET /api/v1/confirmations; Approve and Deny post to
   /:id/approve and /:id/deny. Built from DOM nodes: summaries, names and
   resources come from agents, so nothing here is parsed as HTML.
   Classic script, global scope; relies on my/core.js (apiFetch, toast).
   ═══════════════════════════════════════════════════════════════ */
let approvalsState = { loading: false, items: [], agents: {} };

function approvalsEl(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
}

// "in 4 min", "in 1 h 5 min", "expired": the request lapses by itself (expires_at), so the owner sees how long is left.
function approvalsLeft(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return 'expired';
    const m = Math.ceil(ms / 60000);
    return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`;
}

function setApprovalsBadge(n) {
    const btn = [...document.querySelectorAll('.section-tabs button')].find((b) => b.getAttribute('onclick')?.includes("'approvals'"));
    if (!btn) return;
    let badge = btn.querySelector('.tab-badge');
    if (!n) { badge?.remove(); return; }
    if (!badge) { badge = approvalsEl('span', { class: 'tab-badge', 'aria-label': 'waiting for you' }); btn.append(' ', badge); }
    badge.textContent = String(n);
}

function renderApprovals(error) {
    const list = document.getElementById('approvals-list');
    if (!list) return;
    list.replaceChildren();
    if (error) {
        list.append(approvalsEl('div', { class: 'approvals-empty', role: 'alert' },
            approvalsEl('p', { text: `Could not load your approvals: ${error}` }),
            approvalsEl('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => loadApprovals() })));
        return;
    }
    const items = approvalsState.items.filter((c) => c.state === 'pending');
    setApprovalsBadge(items.length);
    if (!items.length) {
        list.append(approvalsEl('p', { class: 'approvals-empty', text: 'Nothing is waiting for you. When an agent asks to do something sensitive on your behalf, it shows up here.' }));
        return;
    }
    for (const c of items) list.append(approvalRow(c));
}

function approvalRow(c) {
    const agent = approvalsState.agents[c.requested_by && c.requested_by.id] || null;
    const who = agent ? agent.name : (c.requested_by && c.requested_by.id) || 'An agent';
    const row = approvalsEl('div', { class: 'approval', 'data-id': c.id });
    const meta = approvalsEl('div', { class: 'approval-meta' },
        approvalsEl('span', { class: 'approval-who', text: who }),
        agent && agent.host ? approvalsEl('span', { class: 'approval-host', text: ` on ${agent.host}` }) : null,
        approvalsEl('span', { class: 'approval-sep', text: ' · ' }),
        approvalsEl('code', { class: 'approval-cap', text: c.capability }),
        approvalsEl('span', { class: 'approval-sep', text: ' · ' }),
        approvalsEl('span', { class: 'approval-left', text: approvalsLeft(c.expires_at) }));
    const resources = Array.isArray(c.resources) && c.resources.length
        ? approvalsEl('ul', { class: 'approval-resources', 'aria-label': 'What it touches' },
            ...c.resources.slice(0, 8).map((r) => approvalsEl('li', { text: typeof r === 'string' ? r : [r.type, r.id || r.name].filter(Boolean).join(' ') })))
        : null;
    const approve = approvalsEl('button', { class: 'btn btn-primary', type: 'button', onclick: () => decideApproval(c.id, 'approve', row) },
        approvalsEl('i', { class: 'fa-solid fa-check', 'aria-hidden': 'true' }), ' Approve once');
    const deny = approvalsEl('button', { class: 'btn', type: 'button', onclick: () => decideApproval(c.id, 'deny', row) },
        approvalsEl('i', { class: 'fa-solid fa-xmark', 'aria-hidden': 'true' }), ' Deny');
    row.append(approvalsEl('p', { class: 'approval-summary', text: c.summary || c.capability }), meta, resources,
        approvalsEl('div', { class: 'btn-row' }, approve, deny));
    return row;
}

async function decideApproval(id, action, row) {
    for (const b of row.querySelectorAll('button')) b.disabled = true;
    try {
        await apiFetch(`/api/v1/confirmations/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'approve' ? { standing_rule: 'once' } : {}) });
        approvalsState.items = approvalsState.items.filter((c) => c.id !== id);
        renderApprovals();
        toast(action === 'approve' ? 'Approved: the agent can go ahead once' : 'Denied: the agent was told no', 'success');
    } catch (e) {
        for (const b of row.querySelectorAll('button')) b.disabled = false;
        // 409: it was decided elsewhere or lapsed meanwhile; reload so the list says what is true.
        if (e.status === 409) { toast('That request is no longer pending', 'info'); return loadApprovals(); }
        toast(`Could not ${action}: ${e.message}`, 'error');
    }
}

async function loadApprovals() {
    if (approvalsState.loading) return;
    approvalsState.loading = true;
    const list = document.getElementById('approvals-list');
    if (list && !approvalsState.items.length) list.replaceChildren(approvalsEl('p', { class: 'approvals-empty', text: 'Loading…' }));
    try {
        const r = await apiFetch('/api/v1/confirmations?state=pending&limit=100');
        approvalsState.items = r.confirmations || [];
        approvalsState.agents = r.agents || {};
        renderApprovals();
    } catch (e) {
        renderApprovals(e.message);
    } finally {
        approvalsState.loading = false;
    }
}

// The tab shows how many wait even before it is opened (a quiet read; a failure leaves the badge off).
async function refreshApprovalsBadge() {
    if (typeof isAnonSession === 'function' && isAnonSession()) return;
    try { const r = await apiFetch('/api/v1/confirmations?state=pending&limit=100'); setApprovalsBadge((r.confirmations || []).filter((c) => c.state === 'pending').length); } catch { /* signed out or offline: no badge */ }
}
