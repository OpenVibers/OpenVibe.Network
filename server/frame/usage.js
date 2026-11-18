'use strict';
/**
 * GET /api/frame/usage?days=1..30 — what the person's answers used, for the session's Usage sheet (2026-11-17, the
 * owner on the Vibe session: "display usage stats and tokens and all that for each harness or API balances or cost").
 * Read as the person from Actor's GET /api/v1/me/usage, never kept, and passed on with numbers and names only:
 *
 *   {
 *     days, since,
 *     today:  { usd, tokens, tasks, by: { allowance|key|plan|machine|credits: { usd, tokens, tasks } } },
 *     period: { the same over the days },
 *     models: [{ id, provider, usd, tokens, tasks }],
 *     limit:  { per_day_usd, tasks_per_day }
 *   }
 *
 * The coding agents' windows, the free AI left, the keys and the Balance are /resources (one read the road chip
 * already makes); this is the part only Actor knows. Signed out: 401. Actor not answering: 502, nothing made up.
 */

const RUNGS = ['allowance', 'key', 'plan', 'machine', 'credits'];
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,40}$/;

const num = (v) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
const r6 = (x) => Math.round(num(x) * 1e6) / 1e6;

function spanOf(t) {
    const x = t && typeof t === 'object' ? t : {};
    const by = {};
    for (const k of RUNGS) {
        const b = x.by && x.by[k];
        if (b && typeof b === 'object') by[k] = { usd: r6(b.usd), tokens: Math.round(num(b.tokens)), tasks: Math.round(num(b.tasks)) };
    }
    return { usd: r6(x.usd), tokens: Math.round(num(x.tokens)), tasks: Math.round(num(x.tasks)), by };
}

/** Actor's answer → the sheet's, with only the fields above. */
function slim(doc) {
    const d = doc && typeof doc === 'object' ? doc : {};
    const days = Math.max(1, Math.min(30, Math.round(num(d.days)) || 30));
    return {
        days,
        since: /^\d{4}-\d{2}-\d{2}$/.test(String(d.since || '')) ? String(d.since) : null,
        today: spanOf(d.today),
        period: spanOf(d.period),
        models: (Array.isArray(d.models) ? d.models : []).slice(0, 12)
            .filter((m) => m && MODEL.test(String(m.id || '')))
            .map((m) => ({ id: String(m.id), provider: PROVIDER.test(String(m.provider || '')) ? String(m.provider) : null, usd: r6(m.usd), tokens: Math.round(num(m.tokens)), tasks: Math.round(num(m.tasks)) })),
        limit: {
            per_day_usd: d.limit && Number(d.limit.per_day_usd) > 0 ? Number(d.limit.per_day_usd) : null,
            tasks_per_day: d.limit && Number(d.limit.tasks_per_day) > 0 ? Math.round(Number(d.limit.tasks_per_day)) : null,
        },
    };
}

function createUsage({ svcUrl = (n, f) => f, fetchImpl = globalThis.fetch, log = console } = {}) {
    /** { status, body } for the person's token and ?days=. */
    async function get({ auth, days }) {
        if (!auth) return { status: 401, body: { error: 'sign in to see what you used' } };
        const n = days == null || days === '' ? 30 : Number.parseInt(String(days), 10);
        if (!Number.isInteger(n) || n < 1 || n > 30) return { status: 400, body: { error: 'days is 1 to 30' } };
        let r;
        try {
            r = await fetchImpl(new URL(`/api/v1/me/usage?days=${n}`, svcUrl('actor', 'http://127.0.0.1:4950')).href, {
                headers: { Accept: 'application/json', Authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(6000),
            });
        } catch (err) {
            if (log.warn) log.warn(`[usage] Actor did not answer: ${err && err.message}`);
            return { status: 502, body: { error: 'Actor did not answer; try again in a moment' } };
        }
        if (r.status === 401 || r.status === 403) return { status: r.status, body: { error: 'sign in to see what you used' } };
        if (!r.ok) {
            if (log.warn) log.warn(`[usage] Actor answered ${r.status}`);
            return { status: 502, body: { error: 'Actor could not say what you used just now' } };
        }
        return { status: 200, body: slim(await r.json().catch(() => null)) };
    }
    return { get };
}

module.exports = { createUsage, slim };
