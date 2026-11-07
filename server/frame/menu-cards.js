'use strict';
/**
 * The menu's network cards: every open site publishes /.well-known/openvibe-menu.json (frame.menu-cards@1),
 * Network fetches them every five minutes and GET /api/frame carries the best cards as `cards` (at most twelve).
 *
 * A card is frame.menu-card@1: a rail, rows or chips of up to six items. The fetch is small and strict —
 * a five-second timeout, 64 KB at most, no redirects, JSON only — and every card is checked against the contract
 * after unknown fields are dropped and its text is stripped of markup and cut to the schema's limits. An item's
 * URL and its optional image `src` must be https on the publishing site's own host or an openvibe.* host (an image
 * from anywhere else is dropped and the item stays), and the card's `site` must be the site that served it. A site that fails keeps its last good cards for 30 minutes, then contributes none. The
 * result is kept in frame_cache, so a restart starts from the last good set rather than an empty menu.
 *
 * Ranking: cards with items only; Live's card first while anyone is live, then the site's place in the Frame's
 * own ranking. At most twelve cards.
 */
const contracts = require('openvibe-contracts');

const REFRESH_MS = 5 * 60_000;
const KEEP_MS = 30 * 60_000;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;
const MAX_CARDS = 12;
const PATH = '/.well-known/openvibe-menu.json';
const KINDS = new Set(['rail', 'rows', 'chips']);
const CARD_FIELDS = ['id', 'site', 'title', 'kind', 'items', 'more', 'updated_at', 'ttl_s'];

/** Plain words for a card: no markup, no control characters, one line, cut to the schema's limit. */
function text(value, max) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** An https URL on the site's own host or an openvibe.* host, or null. */
function cardUrl(value, site) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw || raw.length > 400) return null;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const own = String(site.host || '').toLowerCase().replace(/^www\./, '');
    if (host !== own && !host.startsWith('openvibe.')) return null;
    return raw;
}

/**
 * One item image ({ src, w?, h?, alt? }), or null. A picture's src follows the item url's rule (https on the
 * site's own host or an openvibe.* host); an image from anywhere else is dropped and the item stays. A width or
 * height the schema would refuse is dropped on its own, and alt is plain text cut to its limit.
 */
function imageOf(raw, site) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const src = cardUrl(raw.src, site);
    if (!src) return null;
    const image = { src };
    for (const k of ['w', 'h']) {
        const n = Number(raw[k]);
        if (raw[k] !== undefined && Number.isInteger(n) && n >= 16 && n <= 1920) image[k] = n;
    }
    if (raw.alt !== undefined) image.alt = text(raw.alt, 120);
    return image;
}

/** One item ({ title, meta?, url, image? }), or null. */
function itemOf(raw, site) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const title = text(raw.title, 80);
    const url = cardUrl(raw.url, site);
    if (!title || !url) return null;
    const item = { title, url };
    const meta = text(raw.meta, 120);
    if (raw.meta !== undefined) item.meta = meta;
    const image = imageOf(raw.image, site);
    if (image) item.image = image;
    return item;
}

/** One card of the site, sanitized and schema-checked, or null. Unknown fields never reach the output. */
function cardOf(raw, site) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.site !== site.id || !KINDS.has(raw.kind)) return null;
    const id = text(raw.id, 40);
    const title = text(raw.title, 60);
    const ttl = Math.round(Number(raw.ttl_s));
    const at = Date.parse(String(raw.updated_at || ''));
    if (!id || !title || !Number.isFinite(ttl) || !Number.isFinite(at)) return null;
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 6).map((it) => itemOf(it, site)).filter(Boolean);
    if (!Array.isArray(raw.items)) return null;
    const card = { id, site: site.id, title, kind: raw.kind, items, updated_at: new Date(at).toISOString(), ttl_s: ttl };
    if (raw.more && typeof raw.more === 'object' && !Array.isArray(raw.more)) {
        const label = text(raw.more.label, 24);
        const url = cardUrl(raw.more.url, site);
        if (label && url) card.more = { label, url };
    }
    // Keep the contract's key order; the check below refuses anything a sanitize step left out of bounds.
    const ordered = {};
    for (const k of CARD_FIELDS) if (card[k] !== undefined) ordered[k] = card[k];
    const check = contracts.validate('frame.menu-card@1', ordered);
    return check.valid ? ordered : null;
}

/** The array a site served, sanitized, or null when the file is not a valid frame.menu-cards@1. */
function cardsOf(raw, site) {
    if (!Array.isArray(raw)) return null;
    const seen = new Set();
    const cards = [];
    for (const item of raw.slice(0, 3)) {
        const card = cardOf(item, site);
        if (card && !seen.has(card.id)) { seen.add(card.id); cards.push(card); }
    }
    if (!contracts.validate('frame.menu-cards@1', cards).valid) return null;
    return cards;
}

/** Read at most max bytes of a response body; null when it is bigger. */
async function readLimited(res, max) {
    const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > max) {
        if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
        return null;
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
        const body = await res.text();
        return Buffer.byteLength(body, 'utf8') > max ? null : body;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > max) { await reader.cancel().catch(() => {}); return null; }
            chunks.push(Buffer.from(value));
        }
    } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * `sites()` is the open sites, `rankOf()` their ids in Frame order, `load`/`save` the frame_cache accessors.
 * `onChange` bumps the payload version so the response's ETag and per-site cache notice new cards.
 */
function createMenuCards({ sites, rankOf, load, save, onChange = () => {}, fetchImpl = (...a) => fetch(...a), now = Date.now, log = console }) {
    let state = {};            // site id → { cards, goodAt }
    let loaded = false;
    let inflight = null;
    let timer = null;

    async function init() {
        if (loaded) return;
        loaded = true;
        const saved = await load();
        const value = saved && saved.value;
        if (value && value.sites && typeof value.sites === 'object') {
            for (const [id, entry] of Object.entries(value.sites)) {
                if (entry && Array.isArray(entry.cards) && Number.isFinite(Number(entry.goodAt))) {
                    state[id] = { cards: entry.cards, goodAt: Number(entry.goodAt) };
                }
            }
        }
    }

    async function fetchSite(site) {
        const url = `https://${site.host}${PATH}`;
        const res = await fetchImpl(url, {
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { accept: 'application/json' },
        });
        if (!res || res.status !== 200) {
            if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
            return { ok: false };
        }
        const body = await readLimited(res, MAX_BYTES);
        if (body == null) return { ok: false };
        let raw;
        try { raw = JSON.parse(body); } catch { return { ok: false }; }
        const cards = cardsOf(raw, site);
        return cards ? { ok: true, cards } : { ok: false };
    }

    /** Fetch every open site once; failures keep the site's last good card, which expires after 30 minutes. */
    async function refresh() {
        if (inflight) return inflight;
        inflight = (async () => {
            const at = now();
            const list = sites();
            const results = await Promise.all(list.map(async (site) => [site, await fetchSite(site).catch(() => ({ ok: false }))]));
            let changed = false;
            for (const [site, result] of results) {
                if (result.ok) {
                    state[site.id] = { cards: result.cards, goodAt: at };
                    changed = true;
                } else if (state[site.id] && at - state[site.id].goodAt > KEEP_MS) {
                    delete state[site.id];
                    changed = true;
                } else if (!state[site.id]) {
                    // Nothing to keep: remember that the site has no card, so the next pass does not save it again.
                    changed = changed || false;
                }
            }
            // Drop sites that are no longer open, and last-good sets past their window even if they were not fetched.
            const open = new Set(list.map((s) => s.id));
            for (const [id, entry] of Object.entries(state)) {
                if (!open.has(id) || at - entry.goodAt > KEEP_MS) { delete state[id]; changed = true; }
            }
            if (changed) {
                try { await save({ sites: state, at }); } catch (err) { log.warn && log.warn('[Frame] menu cards not saved:', err && err.message); }
                onChange();
            }
            return cards();
        })().finally(() => { inflight = null; });
        return inflight;
    }

    /** The cards GET /api/frame carries: cards with items, Live first while anyone is live, then the Frame rank. */
    function cards() {
        const at = now();
        const live = state.live;
        const liveNow = !!(live && at - live.goodAt <= KEEP_MS && live.cards.some((c) => c.items.length > 0));
        const ranked = rankOf();
        const order = liveNow ? ['live', ...ranked.filter((id) => id !== 'live')] : ranked;
        const out = [];
        for (const id of order) {
            const entry = state[id];
            if (!entry || at - entry.goodAt > KEEP_MS) continue;
            for (const card of entry.cards) {
                if (!card.items.length) continue;
                out.push(card);
                if (out.length >= MAX_CARDS) return out;
            }
        }
        return out;
    }

    /** Start the five-minute fetch (the first after two seconds so boot is not held up). */
    async function start() {
        await init();
        const kick = setTimeout(() => refresh().catch(() => {}), 2_000);
        kick.unref();
        timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
        timer.unref();
    }
    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { init, refresh, cards, start, stop, _state: () => state };
}

module.exports = { createMenuCards, cardOf, cardsOf, text, cardUrl, imageOf, MAX_CARDS, KEEP_MS, REFRESH_MS, PATH };
