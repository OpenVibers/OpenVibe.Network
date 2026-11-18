'use strict';

// ═══════════════════════════════════════════════════════════════
// The bell's tabs (Notifications 2.0, plan 2026-10-28 §3.10): All · People · Agents · Live · Deals · System.
// 2026-11-16 (the owner, an agent's "Your task did not finish" under both Deals & alerts and Agents: "why is it showing up
// in two tabs … make it actually filter this … categorize it in a way that makes cohesive sense"): every notification
// is under exactly one tab, the first in ORDER that claims it, so an agent's notice sent as a service is the Agents'.
// Mentions became People (follows, category social, were in All only) and Deals & alerts became Deals; the ids stay.
// One definition serves the list's filter (GET /api/notifications?tab=) and the counts on the tabs
// (GET /api/notifications/unread-by-tab), so the Shared bell knows only the ids. A tab is a set of categories, a set of
// types, and type prefixes for kinds that land later (agent work from Actor and Run); All is no filter, and an unknown
// tab is All.
// ═══════════════════════════════════════════════════════════════

const TABS = {
    // What people said to you or about you, and what they shared with you (the share kinds,
    // design 2026-11-06).
    mentions: { categories: ['social'], types: ['MENTION', 'CONTENT_REPLY', 'CONTENT_COMMENT', 'DIRECT_MESSAGE', 'WHISPER',
        'share.added', 'share.access_requested', 'share.transfer.requested', 'share.transfer.answered'] },
    live: { categories: ['stream'] },
    // Deal, coupon, trade and watch alerts: the service category.
    alerts: { categories: ['service'] },
    // Your account's security notices, announcements, moderation, and (for staff) operator alerts.
    system: { categories: ['system', 'admin', 'moderation'] },
    // Approvals an agent waits on, and agent tasks finishing or failing.
    agents: { types: ['CONFIRMATION_REQUESTED'], prefixes: ['AGENT_', 'RUN_'] },
};
const IDS = ['all', ...Object.keys(TABS)];
// Which tab claims a notification first: an agent's work before people, people before a stream, a stream before a deal.
const ORDER = ['agents', 'mentions', 'live', 'alerts', 'system'];

/** The SQL that a tab's own rule matches (before precedence), or null. */
function ruleWhere(t) {
    const parts = [];
    const params = [];
    if (t.categories) { parts.push(`category IN (${t.categories.map(() => '?').join(', ')})`); params.push(...t.categories); }
    if (t.types) { parts.push(`type IN (${t.types.map(() => '?').join(', ')})`); params.push(...t.types); }
    for (const p of t.prefixes || []) { parts.push("type LIKE ? ESCAPE '\\'"); params.push(`${p.replace(/[%_\\]/g, (c) => '\\' + c)}%`); }
    return { sql: `(${parts.join(' OR ')})`, params };
}

/** Whether a tab's own rule matches (before precedence). */
function ruleMatches(t, category, type) {
    return (t.categories || []).includes(category) || (t.types || []).includes(type) || (t.prefixes || []).some((p) => type.startsWith(p));
}

/** The one tab a notification of this category and type is under, or null when none claims it (All only). */
function tabOf(category, type) {
    type = String(type || '');
    return ORDER.find((id) => ruleMatches(TABS[id], category, type)) || null;
}

/** The SQL condition for a tab ({ sql, params }), or null for All and unknown tabs: its own rule, and no earlier tab's. */
function tabWhere(id) {
    const t = TABS[id];
    if (!t) return null;
    const own = ruleWhere(t);
    const earlier = ORDER.slice(0, ORDER.indexOf(id)).map((e) => ruleWhere(TABS[e]));
    return {
        sql: `(${[own.sql, ...earlier.map((e) => `NOT ${e.sql}`)].join(' AND ')})`,
        params: [...own.params, ...earlier.flatMap((e) => e.params)],
    };
}

/** Whether a notification of this category and type is under the tab: All always, else its one tab. */
function inTab(id, category, type) {
    if (id === 'all') return true;
    if (!TABS[id]) return false;
    return tabOf(category, type) === id;
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

module.exports = { TABS, IDS, ORDER, tabWhere, inTab, tabOf, countsByTab };
