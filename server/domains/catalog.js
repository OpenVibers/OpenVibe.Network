'use strict';
// Server-side client for the Tools catalog (docs/shared-contracts.md §1).
// One cached copy per process: refreshed every 5 minutes, the last good copy kept when Tools is
// unreachable, and a built-in family list when there has never been a good copy.
const FALLBACK = require('./fallback-catalog');

const TTL_MS = 5 * 60_000;
const RETRY_MS = 30_000;          // after a failure, do not hammer Tools on every request
const TIMEOUT_MS = 4000;

let state = { catalog: null, fetchedAt: 0, failedAt: 0, error: null };
let inflight = null;
let fetchImpl = (...a) => fetch(...a);
const listeners = new Set();

function catalogUrl() {
    return `${(process.env.OV_TOOLS_INTERNAL_URL || 'http://127.0.0.1:4001').replace(/\/+$/, '')}/api/catalog.json`;
}

function normalise(raw) {
    if (!raw || !Array.isArray(raw.families) || !Array.isArray(raw.tools)) throw new Error('Catalog has no families/tools');
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const families = raw.families.filter(f => f && typeof f.id === 'string' && f.name).map(f => ({
        id: str(f.id, 40), name: str(f.name, 80), tagline: str(f.tagline, 160), description: str(f.description, 600),
        icon: str(f.icon, 40), url: str(f.url, 300), path: str(f.path, 120),
    }));
    const tools = raw.tools.filter(t => t && typeof t.id === 'string' && t.name).map(t => ({
        id: str(t.id, 40), family: str(t.family, 40), name: str(t.name, 80), tagline: str(t.tagline, 160),
        description: str(t.description, 600), icon: str(t.icon, 40),
        keywords: Array.isArray(t.keywords) ? t.keywords.filter(k => typeof k === 'string').slice(0, 20).map(k => k.slice(0, 60)) : [],
        hosts: {
            canonical: str(t.hosts && t.hosts.canonical, 253), short: str(t.hosts && t.hosts.short, 253),
            aliases: Array.isArray(t.hosts && t.hosts.aliases) ? t.hosts.aliases.filter(h => typeof h === 'string').slice(0, 20) : [],
        },
        url: str(t.url, 300),
    }));
    if (!families.length) throw new Error('Catalog has no families');
    return { updated: str(raw.updated, 40) || new Date().toISOString(), families, tools };
}

async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const res = await fetchImpl(catalogUrl(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) throw new Error(`Tools catalog answered ${res.status}`);
            const next = normalise(await res.json());
            const changed = !state.catalog || state.catalog.updated !== next.updated
                || state.catalog.tools.length !== next.tools.length || state.catalog.families.length !== next.families.length;
            state = { catalog: next, fetchedAt: Date.now(), failedAt: 0, error: null };
            if (changed) for (const fn of listeners) { try { fn(next); } catch { /* listener's problem */ } }
        } catch (err) {
            state = { ...state, failedAt: Date.now(), error: err.message };
        } finally { inflight = null; }
        return state;
    })();
    return inflight;
}

/**
 * The catalog to use right now.
 * @returns {Promise<{ catalog: object, source: 'live'|'stale'|'fallback', error: string|null }>}
 */
async function getCatalog() {
    const now = Date.now();
    const fresh = state.catalog && now - state.fetchedAt < TTL_MS;
    const backingOff = state.failedAt && now - state.failedAt < RETRY_MS;
    if (!fresh && !backingOff) await refresh();
    return peek();
}

/** Same answer without touching the network. */
function peek() {
    if (state.catalog) {
        const live = !state.failedAt && Date.now() - state.fetchedAt < TTL_MS * 2;
        return { catalog: state.catalog, source: live ? 'live' : 'stale', error: state.error };
    }
    return { catalog: FALLBACK, source: 'fallback', error: state.error };
}

/** fn(catalog) runs whenever a refresh brings a different catalog. Returns an unsubscribe. */
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Tests swap the transport and reset the cache.
function _setFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }
function _reset() { state = { catalog: null, fetchedAt: 0, failedAt: 0, error: null }; inflight = null; }

module.exports = { getCatalog, peek, refresh, onChange, catalogUrl, normalise, FALLBACK, _setFetch, _reset };
