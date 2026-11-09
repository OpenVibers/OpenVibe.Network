'use strict';

/**
 * The five things people do now, for the signed-out front door (plan L43, 2026-11-09): OpenVibe.Report ranks the
 * destinations from its own numbers (opens today and over seven days, growth, and the distinct signed-in people
 * Network counts). Network never derives the order; it reads Report's public answer, holds it five minutes, and
 * replaces it with a fixed starter list only when Report does not answer. The answer says which one it is:
 *
 *   { source: 'report' | 'fallback', reason, generated_at, fetched_at, stale, items: [...] }
 *
 * Every item is a destination with the shape both lists use: id, kind (site | tool), name, url, icon id, reason,
 * and the numbers behind it. The fixed list is markdown-free and hand-written on purpose: it is the floor, not a
 * second ranking.
 */
const FALLBACK = Object.freeze([
    { id: 'live', kind: 'site', name: 'OpenVibe.Live', url: 'https://openvibe.live/', icon: 'live', reason: 'Go live or watch, from a browser tab' },
    { id: 'tools', kind: 'site', name: 'OpenVibe.Tools', url: 'https://openvibe.tools/', icon: 'tools', reason: 'Free tools that just open' },
    { id: 'chat', kind: 'site', name: 'OpenVibe.Chat', url: 'https://openvibe.chat/', icon: 'chat', reason: 'Group chats, servers and DMs' },
    { id: 'community', kind: 'site', name: 'OpenVibe.Community', url: 'https://openvibe.community/', icon: 'community', reason: 'Pastes and posts behind one link' },
    { id: 'games', kind: 'site', name: 'OpenVibe.Games', url: 'https://openvibe.games/', icon: 'games', reason: 'Browser games that already know you' },
]);

const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 2000;
const LIMIT = 5;

const text = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const integer = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const idOf = (v) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(v || '')) ? String(v) : null);
function httpsUrl(v) {
    try { const u = new URL(String(v || '')); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

/** Only the fields both lists promise; an item without a real https address or an icon id is dropped, not guessed. */
function validItems(input, limit = LIMIT) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(input) ? input : []) {
        if (!raw || typeof raw !== 'object') continue;
        const kind = raw.kind === 'site' || raw.kind === 'tool' ? raw.kind : null;
        const id = idOf(raw.id);
        const name = text(raw.name, 80);
        const reason = text(raw.reason, 80);
        const url = httpsUrl(raw.url);
        const icon = idOf(raw.icon) || id;
        if (!kind || !id || !name || !reason || !url || !icon) continue;
        const key = `${kind}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const item = { id, kind, name, url, icon, reason };
        for (const k of ['score', 'opens_24h', 'opens_7d', 'opens_prev_7d', 'growth_7d_pct', 'uses_24h', 'uses_7d']) {
            const n = integer(raw[k]);
            if (n != null) item[k] = n;
        }
        out.push(item);
        if (out.length >= limit) break;
    }
    return out;
}

function validCoUsage(body, minPeople = 3) {
    if (!body || typeof body !== 'object') return null;
    const pairs = [];
    const seen = new Set();
    for (const raw of Array.isArray(body.pairs) ? body.pairs : []) {
        if (!raw || typeof raw !== 'object') continue;
        const a = idOf(raw.a);
        const b = idOf(raw.b);
        const people = integer(raw.people);
        if (!a || !b || a === b || people == null || people < minPeople) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ a, b, people });
    }
    return {
        source: 'report',
        generated_at: body.generated_at || null,
        sample_people: integer(body.sample_people) || 0,
        min_people: integer(body.min_people) || minPeople,
        pairs,
    };
}

function createHomePopularity({ reportUrl = '', fetchImpl = globalThis.fetch, now = () => Date.now(), ttlMs = TTL_MS, timeoutMs = TIMEOUT_MS, limit = LIMIT, fallback = FALLBACK } = {}) {
    const base = String(reportUrl || '').replace(/\/+$/, '');
    const clock = typeof now === 'function' ? now : () => Date.now();
    const starter = fallback.slice(0, limit);
    let state = { at: 0, version: 0, source: 'fallback', reason: 'cold', generated_at: null, items: starter, stale: false, error: null };
    let inflight = null;
    let coState = { at: 0, value: null, error: null };
    let coInflight = null;

    function view() {
        return {
            source: state.source,
            reason: state.reason,
            generated_at: state.generated_at || (state.at ? new Date(state.at).toISOString() : null),
            fetched_at: state.at ? new Date(state.at).toISOString() : null,
            stale: !!state.stale,
            items: state.items.map((item) => ({ ...item })),
            ...(state.error ? { error: state.error } : {}),
        };
    }

    function fallbackState(reason, error = null) {
        return {
            at: clock(), version: state.version + 1, source: 'fallback', reason,
            generated_at: null, items: starter.map((item) => ({ ...item })), stale: false, error,
        };
    }

    async function refresh() {
        if (inflight) return inflight;
        inflight = (async () => {
            if (!base) { state = fallbackState('no_report'); return view(); }
            try {
                const r = await fetchImpl(`${base}/api/v1/popular?limit=${limit}`, {
                    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
                });
                if (!r.ok) throw new Error(`Report answered ${r.status}`);
                const body = await r.json();
                const items = validItems(body && body.items, limit);
                if (!items.length) { state = fallbackState('report_empty'); return view(); }
                state = {
                    at: clock(), version: state.version + 1, source: 'report', reason: 'report',
                    generated_at: (body && body.generated_at) || new Date(clock()).toISOString(), items, stale: false, error: null,
                };
            } catch (err) {
                const message = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 160);
                // A last good Report answer is still Report's answer: keep it, marked stale, until a new one arrives.
                if (state.source === 'report' && state.items.length) state = { ...state, at: clock(), stale: true, error: message };
                else state = fallbackState('report_error', message);
            }
            return view();
        })().finally(() => { inflight = null; });
        return inflight;
    }

    function peek() {
        if (clock() - state.at > ttlMs && !inflight) refresh().catch(() => {});   // floating-ok: refresh catches its own read
        return view();
    }

    async function coUsage() {
        if (coState.value && clock() - coState.at < ttlMs) return coState.value;
        if (coInflight) return coInflight;
        if (!base) return null;
        coInflight = (async () => {
            try {
                const r = await fetchImpl(`${base}/api/v1/popular/co-usage`, {
                    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
                });
                if (!r.ok) throw new Error(`Report answered ${r.status}`);
                const value = validCoUsage(await r.json());
                if (value) coState = { at: clock(), value, error: null };
                return coState.value;
            } catch (err) {
                coState = { ...coState, at: clock(), error: String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 160) };
                return coState.value;   // null when there has never been a good answer: Try next has its own fallback
            } finally { coInflight = null; }
        })();
        return coInflight;
    }

    return { peek, refresh, coUsage, view, ttlMs, limit, fallback: starter };
}

// The one instance the home renderer uses; server/index.js configures it once at boot, tests may leave it unset.
let instance = null;
function configure(popularity) { instance = popularity || null; }
function peek() {
    if (instance) return instance.peek();
    return { source: 'fallback', reason: 'not_configured', generated_at: null, fetched_at: null, stale: false, items: FALLBACK.slice(0, LIMIT).map((item) => ({ ...item })) };
}

module.exports = { createHomePopularity, configure, peek, validItems, validCoUsage, FALLBACK, TTL_MS };
