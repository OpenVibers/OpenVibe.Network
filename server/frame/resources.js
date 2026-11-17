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
 *     partial:   ['ai' | 'billing']                                                what did not answer
 *   }
 *
 * No key material, hint or account name passes: a provider's name, a state and a time. Signed out: 401.
 */

const PROVIDER = /^[a-z][a-z0-9_-]{0,40}$/;
const SERVICE = /^[a-z][a-z0-9.:-]{0,60}$/;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function createResources({ svcUrl = (n, f) => f, fetchImpl = globalThis.fetch, log = console } = {}) {
    async function read(service, fallback, path, auth) {
        const r = await fetchImpl(new URL(path, svcUrl(service, fallback)).href, {
            headers: { Accept: 'application/json', Authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) throw Object.assign(new Error(`${service} ${path} answered ${r.status}`), { status: r.status });
        return r.json();
    }

    /** The person's resources, or { status: 401 } without a token. */
    async function get({ auth }) {
        if (!auth) return { status: 401, body: { error: 'sign in to see your AI' } };
        const partial = [];
        const [allowance, keys, apps, wallet] = await Promise.allSettled([
            read('ai', 'http://127.0.0.1:4700', '/api/v1/me/allowance', auth),
            read('ai', 'http://127.0.0.1:4700', '/api/v1/me/credentials', auth),
            read('ai', 'http://127.0.0.1:4700', '/api/v1/me/key-apps', auth),
            read('billing', 'http://127.0.0.1:4600', '/api/v1/me/wallet', auth),
        ]);
        if ([allowance, keys, apps].some((x) => x.status === 'rejected')) partial.push('ai');
        if (wallet.status === 'rejected') partial.push('billing');
        for (const x of [allowance, keys, apps, wallet]) if (x.status === 'rejected' && log.warn) log.warn(`[resources] ${x.reason && x.reason.message}`);

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
        const b = wallet.status === 'fulfilled' && wallet.value && wallet.value.balances && wallet.value.balances.balance;
        if (b) body.balance = { amount: clip(b.amount, 30), scale: num(b.scale) || 0, currency: clip(b.currency, 8) || 'USD', purpose: clip(b.purpose, 200) || null };
        return { status: 200, body };
    }
    return { get };
}

module.exports = { createResources };
