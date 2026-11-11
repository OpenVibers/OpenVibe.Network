/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): the Receipts card (plan OpenVibe_Seven_Domains_Plan R2 item 13).
   The latest five receipt-category summaries Inbox AI keeps on openvibe.email, each a link to its thread,
   then a counted fold for the rest (never a tab). With Inbox AI off, or no mailbox, one quiet line links to
   the switch on openvibe.email; with it on and nothing triaged yet, a quiet "No receipts yet." No sample
   receipt is ever drawn. Classic script, global scope: my/core.js's apiFetch and my/boot.js starts it.
   ═══════════════════════════════════════════════════════════════ */
const RC_MAIL = 'https://openvibe.email';
const RC_SETTING = `${RC_MAIL}/inbox#inbox-ai`;
const RC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RC_SHOWN = 5;

function rcEl(tag, cls, kids, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => { if (c != null) n.append(c); });
    return n;
}

function rcText(value, max) {
    const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The date a receipt arrived, as "Nov 8", or "" when it has none. */
function rcDate(at) {
    if (!at) return '';
    let t = Date.parse(at);
    if (!Number.isFinite(t)) t = Date.parse(`${String(at).replace(' ', 'T')}Z`);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
}

/** The thread on openvibe.email. Mail's inbox opens a message by its message id; thread_id is the fallback. */
function rcHref(item) {
    const id = String((item && (item.message_id || item.thread_id)) || '');
    return RC_ID.test(id) ? `${RC_MAIL}/inbox/${encodeURIComponent(id)}` : null;
}

function rcRow(item) {
    const merchant = rcText(item && item.merchant, 160);
    const summary = rcText(item && item.summary, 240) || rcText(item && item.subject, 200);
    if (!merchant && !summary) return null;
    const href = rcHref(item);
    const row = rcEl(href ? 'a' : 'div', 'rc-row', [
        rcEl('span', 'rc-mer', [merchant || 'Receipt']),
        rcEl('span', 'rc-sum', [summary || 'Receipt']),
        rcEl('span', 'rc-date', [rcDate(item && item.received_at)]),
    ], href ? { href } : {});
    if (href) {
        row.setAttribute('target', '_blank');
        row.setAttribute('rel', 'noopener');
    }
    row.setAttribute('title', summary ? `${merchant || 'Receipt'}: ${summary}` : (merchant || 'Receipt'));
    return row;
}

function renderReceipts(doc) {
    const box = document.getElementById('receipts');
    const body = document.getElementById('receipts-body');
    if (!box || !body) return;
    const enabled = !!(doc && doc.enabled === true);
    const rows = (doc && Array.isArray(doc.receipts) ? doc.receipts : []).map(rcRow).filter(Boolean);
    body.replaceChildren();
    if (!enabled) {
        box.hidden = true;
        const fold = document.getElementById('setup-fold');
        if (fold) { fold.hidden = false; fold.querySelector('summary').textContent = 'Set up more (1)'; fold.querySelector('.setup-items').replaceChildren(rcEl('a', 'rc-quiet', ['Set up receipts with Inbox AI'], { href: RC_SETTING })); }
        return;
    }
    const fold = document.getElementById('setup-fold');
    if (fold) fold.hidden = true;
    if (!rows.length) {
        body.append(rcEl('p', 'rc-quiet', ['No receipts yet.']));
        box.hidden = true;
        return;
    }
    body.append(...rows.slice(0, RC_SHOWN));
    const rest = rows.slice(RC_SHOWN);
    if (rest.length) {
        const hidden = rcEl('div', 'rc-rest', rest, { role: 'group' });
        hidden.id = 'receipts-rest';
        hidden.hidden = true;
        const more = rcEl('button', 'rc-more', [`More (${rest.length})`], {
            type: 'button', 'aria-expanded': 'false', 'aria-controls': 'receipts-rest',
        });
        more.addEventListener('click', () => {
            const opening = hidden.hidden;
            hidden.hidden = !opening;
            more.textContent = opening ? 'Show less' : `More (${rest.length})`;
            more.setAttribute('aria-expanded', String(opening));
        });
        body.append(hidden, more);
    }
    box.hidden = false;
}

async function loadReceipts() {
    if (!document.getElementById('receipts')) return;
    if (typeof isAnonSession === 'function' && isAnonSession()) return;
    try {
        renderReceipts(await apiFetch('/api/v1/me/receipts'));
    } catch {
        const box = document.getElementById('receipts');
        if (box) box.hidden = true;   // Mail away: the card stays out rather than inventing a receipt
    }
}
