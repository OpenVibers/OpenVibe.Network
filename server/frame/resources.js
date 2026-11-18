'use strict';
/**
 * GET /api/frame/resources — everything an answer can run on, for the person, in one read (plan §AD.17: the route and
 * "Your AI" show every way with its state; the owner, 11-17: "a menu that brings them to set up their agents and their
 * harnesses and their API keys, or to enable billing"). One request with the person's own token, read as them, never
 * kept:
 *
 *   {
 *     allowance: { tier, unlimited, tokens, used, left, resets_at } | null       OpenVibe.AI's free tier today
 *     keys:      [{ provider, status, checked_at }]                               their own keys (names and states only)
 *     key_apps:  [{ service, providers }]                                          which services may use those keys
 *     balance:   { amount, scale, currency, purpose } | null                       Billing's Balance (USD, for AI)
 *     road:      { agent, chat, code }                                              what takes the next turn in each mode
 *     harnesses: [{ agent, name, machines, signed_in, windows: [{ name, pct, resets_at }] }]
 *                                                                                  the coding agents on their computers
 *     partial:   ['ai' | 'billing' | 'computers']                                  what did not answer
 *
 * harnesses (2026-11-17, the owner: "display usage stats and tokens and all that for each harness or API balances or
 * cost"): each coding agent on the person's computers with its limit windows, as their Links report them through Bot
 * (labels, a percentage and a time; the fullest reading of a window across machines wins). What their answers used is
 * Actor's own read (GET /api/v1/me/usage): AI's usage rows name the service that asked, not the person.
 *   }
 *
 * `road` is openvibe-sdk/agents/roads' answer over these facts and the person's computers (the order Actor's engine
 * walks: the free AI when the turn fits, then a key allowed for Actor, then an online computer, else why not), so the
 * composer's chip says what Actor will do instead of keeping its own copy of the order: { road, need, why, say, ladder,
 * provider?, machine?, left?, chat_only?, resets_at? }.
 *
 * `road.code` (2026-11-18, plan §AD.28 item 4; SDK 0.186's coding order) is what would run Code mode's next task: a coding
 * agent signed in with the person's own plan on an online computer of theirs with room in its windows (from the same
 * machines `harnesses` reads), then a key allowed for Codes, then the free AI when a coding turn fits, else why not. It
 * adds { harness, harness_name, plan } to the fields above. Codes answers the same over its own reading at
 * GET /api/v1/me/road.
 *
 * No key material, hint or account name passes: a provider's name, a state and a time. Signed out: 401.
 */

const roads = require('openvibe-sdk/agents/roads');

const PROVIDER = /^[a-z][a-z0-9_-]{0,40}$/;
// A key's state that lets it answer (Shared's chip reads the same: none, or ok/ready/active/valid).
const KEY_OK = (status) => !status || /^(ok|ready|active|valid)$/i.test(status);
const SERVICE = /^[a-z][a-z0-9.:-]{0,60}$/;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
// The account each coding agent signs in to (Codes' engine/logins.js CLIS): what "your plan" is on the plan road.
const PLAN_OF = { claude: 'Anthropic', 'claude-code': 'Anthropic', codex: 'OpenAI', opencode: 'OpenCode', 'command-code': 'Command Code', 'minimax-code': 'MiniMax' };
// A window this full has no room for a new task (Codes' FULL_PCT).
const FULL_PCT = 95;

function createResources({ svcUrl = (n, f) => f, fetchImpl = globalThis.fetch, computers = null, fleet = null, log = console } = {}) {
    async function read(service, fallback, path, auth) {
        const r = await fetchImpl(new URL(path, svcUrl(service, fallback)).href, {
            headers: { Accept: 'application/json', Authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) throw Object.assign(new Error(`${service} ${path} answered ${r.status}`), { status: r.status });
        return r.json();
    }

    /** The person's resources, or { status: 401 } without a token. */
    async function get({ auth, subject = null }) {
        if (!auth) return { status: 401, body: { error: 'sign in to see your AI' } };
        const partial = [];
        const [allowance, keys, apps, wallet, pcs, machines] = await Promise.allSettled([
            read('ai', 'http://127.0.0.1:4700', '/api/v1/me/allowance', auth),
            read('ai', 'http://127.0.0.1:4700', '/api/v1/me/credentials', auth),
            read('ai', 'http://127.0.0.1:4700', '/api/v1/me/key-apps', auth),
            read('billing', 'http://127.0.0.1:4600', '/api/v1/me/wallet', auth),
            typeof computers === 'function' && subject ? computers(subject) : Promise.resolve([]),
            typeof fleet === 'function' && subject ? fleet(subject) : Promise.resolve([]),
        ]);
        if ([allowance, keys, apps].some((x) => x.status === 'rejected')) partial.push('ai');
        if (wallet.status === 'rejected') partial.push('billing');
        if (pcs.status === 'rejected') partial.push('computers');
        for (const x of [allowance, keys, apps, wallet, pcs]) if (x.status === 'rejected' && log.warn) log.warn(`[resources] ${x.reason && x.reason.message}`);

        const a = allowance.status === 'fulfilled' && allowance.value && allowance.value.allowance;
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
        const body = {
            allowance: a ? { tier: clip(a.tier, 40), unlimited: a.unlimited === true, tokens: num(a.tokens), used: num(a.used), left: a.left == null ? null : num(a.left), resets_at: clip(a.resets_at, 40) || null } : null,
            keys: (keys.status === 'fulfilled' && Array.isArray(keys.value && keys.value.credentials) ? keys.value.credentials : [])
                .map((c) => ({ provider: String((c && (c.provider || c.id)) || ''), status: clip(c && c.status, 30) || null, checked_at: clip(c && c.checked_at, 40) || null }))
                .filter((c) => PROVIDER.test(c.provider)).slice(0, 30),
            // AI answers one row per service and provider ({ service, provider }): grouped here, one row per service.
            key_apps: (() => {
                const by = new Map();
                for (const x of (apps.status === 'fulfilled' && Array.isArray(apps.value && apps.value.apps) ? apps.value.apps : [])) {
                    const service = String((x && (x.service || x.id)) || '');
                    if (!SERVICE.test(service)) continue;
                    const list = by.get(service) || [];
                    for (const p of [x.provider, ...(Array.isArray(x.providers) ? x.providers : [])]) if (p && (p === '*' || PROVIDER.test(String(p))) && !list.includes(String(p))) list.push(String(p));
                    by.set(service, list);
                }
                return [...by.entries()].slice(0, 30).map(([service, providers]) => ({ service, providers: providers.slice(0, 30) }));
            })(),
            balance: null,
            partial,
        };
        body.harnesses = harnessesOf(machines.status === 'fulfilled' ? machines.value : []);
        const b = wallet.status === 'fulfilled' && wallet.value && wallet.value.balances && wallet.value.balances.balance;
        if (b) body.balance = { amount: clip(b.amount, 30), scale: num(b.scale) || 0, currency: clip(b.currency, 8) || 'USD', purpose: clip(b.purpose, 200) || null };
        // What takes the next turn, in the one order (openvibe-sdk/agents/roads): a key counts for the services AI says may
        // use it; a computer counts when it is online and may run something.
        const facts = {
            allowance: body.allowance, app: 'actor',
            keys: body.keys.map((k) => ({ provider: k.provider, ok: KEY_OK(k.status),
                apps: body.key_apps.filter((a) => a.providers.includes('*') || a.providers.includes(k.provider)).map((a) => a.service) })),
            machines: (pcs.status === 'fulfilled' && Array.isArray(pcs.value) ? pcs.value : [])
                .map((p) => ({ id: p.id == null ? null : clip(p.id, 80), name: clip(p.name, 60) || null, online: p.online === true, disabled: !!p.disabled })),
        };
        const slim = (r) => {
            const out = { road: r.road, need: r.need, why: clip(r.why, 300), say: clip(roads.say(r), 300), ladder: r.ladder.map((s) => ({ road: s.road, open: s.open, why: clip(s.why, 200) })) };
            for (const k of ['provider', 'machine', 'left', 'known', 'chat_only', 'resets_at', 'harness', 'harness_name', 'plan']) if (r[k] !== undefined) out[k] = r[k];
            return out;
        };
        body.road = { agent: slim(roads.pick({ ...facts, mode: 'agent' })), chat: slim(roads.pick({ ...facts, mode: 'chat' })),
            code: slim(roads.pick({ ...facts, mode: 'code', app: 'codes', fleet: codeFleetOf(machines.status === 'fulfilled' ? machines.value : []) })) };
        return { status: 200, body };
    }
    return { get };
}

/** A window's percentage used, from pct or used/limit; null when it says neither. */
function pctOf(w) {
    if (!w || typeof w !== 'object') return null;
    let pct = Number(w.pct);
    const used = Number(w.used ?? w.used_percent), limit = Number(w.limit ?? w.total);
    if (!Number.isFinite(pct) && Number.isFinite(used) && Number.isFinite(limit) && limit > 0) pct = (used / limit) * 100;
    return Number.isFinite(pct) ? pct : null;
}

/**
 * Bot's machines → roads' coding facts: each coding agent on each machine, with its account as the plan; online only when
 * the machine is and the agent is installed and signed in there; no room (window_left 0) when a window is full. The one
 * with the most room comes first.
 */
function codeFleetOf(machines) {
    const out = [];
    for (const m of Array.isArray(machines) ? machines : []) {
        if (!m || !Array.isArray(m.fleet)) continue;
        for (const e of m.fleet.slice(0, 20)) {
            const agent = String((e && e.agent) || '');
            if (!/^[a-z][a-z0-9-]{1,40}$/.test(agent)) continue;
            const pcts = (Array.isArray(e.windows) ? e.windows : []).slice(0, 10).map(pctOf).filter((p) => p != null);
            const most = pcts.length ? Math.max(...pcts) : 0;
            out.push({
                machine: m.id == null ? null : clip(m.id, 80), machine_name: clip(m.name || m.id, 60) || null, harness: agent,
                harness_name: clip(e.name || agent, 60), plan: PLAN_OF[agent] || null,
                online: m.online === true && e.installed !== false && e.signed_in === true, window_left: most >= FULL_PCT ? 0 : null, _most: most,
            });
        }
    }
    return out.sort((a, b) => a._most - b._most).map(({ _most, ...f }) => f);
}

/** Bot's machines (each with the fleet its Link reports) → each coding agent once: where it is, signed in, its windows. */
function harnessesOf(machines) {
    const by = new Map();
    for (const m of Array.isArray(machines) ? machines : []) {
        if (!m || !Array.isArray(m.fleet)) continue;
        for (const e of m.fleet.slice(0, 20)) {
            const agent = String((e && e.agent) || '');
            if (!/^[a-z][a-z0-9-]{1,40}$/.test(agent) || e.installed === false) continue;
            const h = by.get(agent) || { agent, name: clip(e.name || agent, 60), machines: [], signed_in: false, windows: new Map() };
            const where = clip(m.name || m.id, 60);
            if (where && !h.machines.includes(where)) h.machines.push(where);
            if (e.signed_in === true) h.signed_in = true;
            for (const w of (Array.isArray(e.windows) ? e.windows : []).slice(0, 10)) {
                if (!w || typeof w !== 'object') continue;
                const name = clip(w.name || w.label || 'window', 40);
                const used = Number(w.used ?? w.used_percent), limit = Number(w.limit ?? w.total);
                let pct = Number(w.pct);
                if (!Number.isFinite(pct) && Number.isFinite(used) && Number.isFinite(limit) && limit > 0) pct = (used / limit) * 100;
                const was = h.windows.get(name);
                const next = { name, pct: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null, resets_at: clip(w.resets_at || w.reset_at, 40) || null };
                if (!was || (next.pct != null && (was.pct == null || next.pct > was.pct))) h.windows.set(name, next);
            }
            by.set(agent, h);
        }
    }
    return [...by.values()].slice(0, 20).map((h) => ({ ...h, machines: h.machines.slice(0, 10), windows: [...h.windows.values()] }));
}

module.exports = { createResources, harnessesOf, codeFleetOf };
