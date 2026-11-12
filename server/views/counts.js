'use strict';

/**
 * View counts for Feed cards, read from OpenVibe.Media's public GET /api/v1/views/counts.
 *
 * A Feed row names its source in one of two shapes:
 *   { source: { service, type, id }, counts }        the new cross-site Feed (source_service/source_type/source_id)
 *   { ref: { service, kind, id }, counts }           a client that already has the ref
 * One batched call per 50 cards, each item gets counts.views and counts.engaged (the source's own likes,
 * comments and watchers are kept). Media unreachable or a card without a ref leaves its counts as they were:
 * a Feed still renders.
 */
const config = require('../config');

const MAX_REFS = 50;
const TTL_MS = 30_000;
const cache = new Map();

function refOf(item) {
    if (!item || typeof item !== 'object') return null;
    const src = item.source && typeof item.source === 'object' ? item.source
        : (item.source_service ? { service: item.source_service, type: item.source_type, id: item.source_id } : null);
    const ref = item.ref && typeof item.ref === 'object' ? item.ref : src;
    if (!ref) return null;
    const service = String(ref.service || '');
    const kind = String(ref.kind || ref.type || '');
    const id = ref.id == null ? '' : String(ref.id);
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(service) || !/^[a-z][a-z0-9_]{1,39}$/.test(kind) || !id) return null;
    return { service, kind, id };
}

function mediaUrl() {
    const s = config.services && config.services.media;
    return String((s && s.internalUrl) || 'http://127.0.0.1:4100').replace(/\/+$/, '');
}

async function fetchCounts(refs, { fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
    const keys = refs.map((r) => `${r.service}:${r.kind}:${r.id}`);
    const key = keys.join('|');
    const kept = cache.get(key);
    if (kept && Date.now() - kept.at < TTL_MS) return kept.counts;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const url = `${mediaUrl()}/api/v1/views/counts?refs=${encodeURIComponent(JSON.stringify(refs))}`;
        const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
        if (!res.ok) return null;
        const body = await res.json();
        const counts = body && body.counts && typeof body.counts === 'object' ? body.counts : null;
        if (counts) {
            if (cache.size >= 500) cache.clear();
            cache.set(key, { at: Date.now(), counts });
        }
        return counts;
    } catch { return null; } finally { clearTimeout(timer); }
}

/** Attach views/engaged to each Feed item that names a source. → the same items. */
async function attachCounts(items, opts = {}) {
    if (!Array.isArray(items) || !items.length) return items;
    const unique = [...new Map(items.map((item) => refOf(item)).filter(Boolean).map((r) => [`${r.service}:${r.kind}:${r.id}`, r])).values()];
    const counts = {};
    for (let i = 0; i < unique.length; i += MAX_REFS) {
        const found = await fetchCounts(unique.slice(i, i + MAX_REFS), opts);
        if (found) Object.assign(counts, found);
    }
    for (const item of items) {
        const ref = refOf(item);
        if (!ref) continue;
        const found = counts[`${ref.service}:${ref.kind}:${ref.id}`];
        if (!found) continue;
        item.counts = { ...(item.counts && typeof item.counts === 'object' ? item.counts : {}), views: found.views, engaged: found.engaged };
    }
    return items;
}

module.exports = { attachCounts, refOf, fetchCounts, _cache: cache };
