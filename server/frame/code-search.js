'use strict';
/**
 * GET /api/frame/code/search?q=&limit= — repositories for the composer's GitHub tool (Shared 4.225.0), from
 * OpenVibe.Exchange's public code search, through the Frame: every site's connect-src reaches openvibe.network and
 * not openvibe.exchange, and Exchange's search sends no CORS header.
 *
 * Only what a card needs leaves here: the repository's owner/name, its GitHub address, a short description, its
 * language, stars, licence, the owner's picture (GitHub's avatar host only) and when it was last pushed. Answers are
 * kept ten minutes per query (public data, as Exchange keeps them), at most `max` queries.
 *
 * Exchange limits searches per person (or per address, signed out), so the person's address and token go along, as
 * every Frame relay does: through the Frame they would otherwise all count as Network's one address. A fresh query
 * asks GitHub and can take several seconds (measured 5 to 10 s); a limit from Exchange or GitHub is a 429 with its
 * Retry-After, anything else a 502 that says so.
 */

const NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function createFrameCodeSearch({ exchangeUrl = 'http://127.0.0.1:5150', fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 600000, max = 300, timeoutMs = 9000 } = {}) {
    const base = String(exchangeUrl || '').replace(/\/+$/, '');
    const cache = new Map();
    const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
    const httpsOn = (u, host) => { try { const x = new URL(String(u)); return x.protocol === 'https:' && (!host || x.hostname === host) ? x.href : null; } catch { return null; } };

    function shape(it) {
        if (!it || !NAME.test(String(it.full_name || ''))) return null;
        const url = httpsOn(it.url, 'github.com');
        if (!url) return null;
        const out = { full_name: it.full_name, url };
        const d = clip(it.description, 300); if (d) out.description = d;
        const l = clip(it.language, 40); if (l) out.language = l;
        if (Number.isFinite(Number(it.stars))) out.stars = Math.max(0, Math.round(Number(it.stars)));
        const lic = clip(it.license, 60); if (lic) out.license = lic;
        const av = httpsOn(it.owner_avatar_url, 'avatars.githubusercontent.com'); if (av) out.owner_avatar_url = av;
        if (it.pushed && Number.isFinite(Date.parse(it.pushed))) out.pushed = new Date(Date.parse(it.pushed)).toISOString();
        return out;
    }

    async function handle(req, res) {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Type': 'application/json; charset=utf-8' });
        const q = clip(req.query && req.query.q, 120);
        const limit = Math.min(Math.max(parseInt(req.query && req.query.limit, 10) || 8, 1), 10);
        if (q.length < 2) return res.set('Cache-Control', 'public, max-age=300').json({ items: [] });
        const key = `${q.toLowerCase()}|${limit}`;
        const hit = cache.get(key);
        if (hit && now() - hit.at < ttlMs) return res.set('Cache-Control', 'public, max-age=300').json({ items: hit.items, source: 'exchange' });
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const auth = String((req.get && req.get('authorization')) || '');
            const headers = { accept: 'application/json', ...(req.ip ? { 'X-Forwarded-For': req.ip } : {}), ...(/^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/.test(auth) ? { Authorization: auth } : {}) };
            const r = await fetchImpl(`${base}/api/v1/code/search?q=${encodeURIComponent(q)}&limit=${limit}`, { headers, redirect: 'error', signal: ctl.signal });
            if (r.status === 429) {
                const wait = Math.min(Math.max(parseInt((r.headers && r.headers.get && r.headers.get('retry-after')) || '60', 10) || 60, 1), 600);
                return res.status(429).set({ 'Retry-After': String(wait), 'Cache-Control': 'no-store' }).json({ error: `Too many searches just now: try again in ${wait < 90 ? `${wait} seconds` : `${Math.round(wait / 60)} minutes`}`, code: 'code.rate_limited' });
            }
            if (!r.ok) throw new Error(`exchange ${r.status}`);
            const j = await r.json();
            const items = (Array.isArray(j && j.items) ? j.items : []).map(shape).filter(Boolean).slice(0, limit);
            cache.set(key, { at: now(), items });
            if (cache.size > max) cache.delete(cache.keys().next().value);
            return res.set('Cache-Control', 'public, max-age=300').json({ items, source: 'exchange' });
        } catch {
            return res.status(502).set('Cache-Control', 'no-store').json({ error: 'Code search is unavailable right now', code: 'code.unavailable' });
        } finally { clearTimeout(timer); }
    }

    return { handle, shape };
}

module.exports = { createFrameCodeSearch };
