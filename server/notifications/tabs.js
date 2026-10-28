'use strict';

// ═══════════════════════════════════════════════════════════════
// The bell's tabs (Notifications 2.0, plan 2026-10-28 §3.10): All · Mentions · Live · Deals & alerts · System · Agents.
// One definition serves the list's filter (GET /api/notifications?tab=) and the counts on the tabs
// (GET /api/notifications/unread-by-tab), so the Shared bell knows only the ids. A tab is a set of categories, a set of
// types, and type prefixes for kinds that land later (agent work from Actor and Run); All is no filter, and an unknown
// tab is All.
// ═══════════════════════════════════════════════════════════════

const TABS = {
    // What people said to you or about you.
    mentions: { types: ['MENTION', 'CONTENT_REPLY', 'CONTENT_COMMENT', 'DIRECT_MESSAGE', 'WHISPER'] },
    live: { categories: ['stream'] },
    // Deal, coupon, trade and watch alerts: the service category.
    alerts: { categories: ['service'] },
    // Your account's security notices, announcements, moderation, and (for staff) operator alerts.
    system: { categories: ['system', 'admin', 'moderation'] },
    // Approvals an agent waits on, and agent tasks finishing or failing.
    agents: { types: ['CONFIRMATION_REQUESTED'], prefixes: ['AGENT_', 'RUN_'] },
};
const IDS = ['all', ...Object.keys(TABS)];

/** The SQL condition for a tab ({ sql, params }), or null for All and unknown tabs. */
function tabWhere(id) {
    const t = TABS[id];
    if (!t) return null;
    const parts = [];
    const params = [];
    if (t.categories) { parts.push(`category IN (${t.categories.map(() => '?').join(', ')})`); params.push(...t.categories); }
    if (t.types) { parts.push(`type IN (${t.types.map(() => '?').join(', ')})`); params.push(...t.types); }
    for (const p of t.prefixes || []) { parts.push("type LIKE ? ESCAPE '\\'"); params.push(`${p.replace(/[%_\\]/g, (c) => '\\' + c)}%`); }
    return { sql: `(${parts.join(' OR ')})`, params };
}

/** Whether a notification of this category and type is under the tab. */
function inTab(id, category, type) {
    if (id === 'all') return true;
    const t = TABS[id];
    if (!t) return false;
    type = String(type || '');
    return (t.categories || []).includes(category) || (t.types || []).includes(type) || (t.prefixes || []).some((p) => type.startsWith(p));
}

/** Unread counts per tab from rows of { category, type, count }. */
function countsByTab(rows) {
    const out = Object.fromEntries(IDS.map((id) => [id, 0]));
    for (const r of rows || []) {
        const n = Number(r.count) || 0;
        for (const id of IDS) if (inTab(id, r.category, r.type)) out[id] += n;
    }
    return out;
}

module.exports = { TABS, IDS, tabWhere, inTab, countsByTab };
