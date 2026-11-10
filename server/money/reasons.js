'use strict';

/**
 * The plain words for an OpenCoins ledger row (`coin_transactions.reason`). The list and the
 * formatter live in openvibe-contracts (`billing.money-reason@1`, `lib/money-reasons.js`); Network
 * re-exports them when the installed package has them and otherwise answers from the same list
 * copied at 0.392.0. A page writes the amount before `text` and links it to `subject.url`.
 */
// The list is openvibe-contracts/lib/money-reasons.js; copied at 0.392.0 until Network's pin carries the module.
const reasons = require('./reasons-list');

const QUEST_TTL_MS = 10 * 60_000;
let questCache = { at: 0, names: new Map() };

/** Quest ids → their own names and addresses, from Quest's public catalog (cached, best-effort). */
async function questNames(fetchImpl = globalThis.fetch) {
    if (questCache.at && Date.now() - questCache.at < QUEST_TTL_MS) return questCache.names;
    const kind = reasons.KINDS.find((k) => k.subject === 'quest');
    const base = String(process.env.QUESTS_URL || (kind && kind.catalog) || 'https://openvibe.quest/api/v1/quests').replace(/\/+$/, '');
    const names = new Map();
    try {
        const r = await fetchImpl(/\/api\/v1\/quests$/.test(base) ? base : `${base}/api/v1/quests`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2500) });
        if (r.ok) {
            const body = await r.json();
            for (const site of (body && Array.isArray(body.sites) ? body.sites : [])) {
                for (const q of (Array.isArray(site.quests) ? site.quests : [])) {
                    if (!q || !q.id) continue;
                    const host = base.replace(/\/api\/v1\/quests$/, '');
                    names.set(String(q.id), { name: String(q.title || q.id).slice(0, 160), url: `${host}${String(q.url || `/quests/${encodeURIComponent(q.id)}`)}` });
                }
            }
        }
    } catch { /* the slug and the id still answer */ }
    questCache = { at: Date.now(), names };
    return names;
}

/** Log an undeclared key once per process: support can see it, a person never does. */
const unknown = new Set();
function describe(key, options) {
    const d = reasons.describe(key, options);
    if (!d.known && d.key && !unknown.has(d.key)) {
        unknown.add(d.key);
        console.warn(`[Money] undeclared reason key ${JSON.stringify(d.key.slice(0, 120))} — reads "${d.text}"`);
    }
    return d;
}

module.exports = { ...reasons, describe, questNames };
