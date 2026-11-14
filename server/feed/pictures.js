'use strict';
/**
 * A store's picture on a feed card, through Network (2026-11-14, the owner: "broken images" on the Deals card).
 *
 * Deals lists offers with the store's own product picture (m.media-amazon.com, images.footlocker.com, …). The menu
 * draws the feed on every OpenVibe site, and most sites allow pictures only from OpenVibe's own hosts (Live, Video and
 * Network's img-src), so those pictures never loaded: a big empty frame. A card's picture that is not on an OpenVibe
 * host is therefore served by Network, which every site already allows:
 *
 *   GET /api/v1/feed/picture?u=<the picture's address>&s=<signature>
 *
 * The signature is an HMAC of the address under a key derived from Network's signing key, so only an address a card
 * carried is fetched (never an open proxy). The fetch goes through openvibe-shared/egress (public addresses only, every
 * redirect hop checked again), takes at most PICTURE_MAX_BYTES and only an image type, and the answer is kept a day in
 * the browser and an hour in memory (a small LRU).
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const { isPublicAddress, normalizeHost, safeLookup } = require('openvibe-shared/egress');

const PICTURE_MAX_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8000;
const CACHE_ITEMS = 300;
const CACHE_BYTES = 48 * 1024 * 1024;
const CACHE_MS = 60 * 60 * 1000;
const TYPES = /^image\/(jpeg|png|webp|gif|avif)$/;
// OpenVibe's own hosts are drawn as they are: every site allows them already (or they are the site itself).
const OURS = /(^|\.)openvibe\.[a-z]{2,24}$/;

function ours(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && OURS.test(u.hostname.toLowerCase()); } catch { return false; }
}

function createPictures({ privateKey = '', baseUrl = 'https://openvibe.network', now = () => Date.now(), request = null } = {}) {
    const key = crypto.createHmac('sha256', String(privateKey || crypto.randomBytes(32).toString('hex'))).update('feed-picture@1').digest();
    const sign = (url) => crypto.createHmac('sha256', key).update(String(url)).digest('base64url').slice(0, 27);
    const base = String(baseUrl || '').replace(/\/+$/, '');

    /** The address a card shows for a picture: an OpenVibe host's own, anything else through Network. */
    function addressOf(url) {
        const s = String(url || '');
        if (!/^https:\/\//.test(s) || ours(s)) return s;
        return `${base}/api/v1/feed/picture?u=${encodeURIComponent(s)}&s=${sign(s)}`;
    }
    const media = (m) => (m && typeof m === 'object' && m.thumb ? { ...m, thumb: addressOf(m.thumb), ...(m.preview && !ours(m.preview) ? { preview: undefined } : {}) } : m);
    /** A card as the page sends it: its picture and its group's pictures on an address every site can show. */
    function card(c) {
        if (!c || typeof c !== 'object') return c;
        const out = { ...c };
        if (out.media) out.media = media(out.media);
        if (out.media && out.media.preview === undefined) delete out.media.preview;
        if (out.group && Array.isArray(out.group.items)) {
            out.group = { ...out.group, items: out.group.items.map((it) => (it && it.media ? { ...it, media: media(it.media) } : it)) };
            for (const it of out.group.items) if (it && it.media && it.media.preview === undefined) delete it.media.preview;
        }
        return out;
    }

    // ── The fetch ─────────────────────────────────────────────
    const cache = new Map();   // url → { at, type, body }
    let cacheBytes = 0;
    function remember(url, entry) {
        if (entry.body.length > CACHE_BYTES / 8) return;
        if (cache.has(url)) { cacheBytes -= cache.get(url).body.length; cache.delete(url); }
        cache.set(url, entry);
        cacheBytes += entry.body.length;
        while (cache.size > CACHE_ITEMS || cacheBytes > CACHE_BYTES) {
            const [k, v] = cache.entries().next().value;
            cache.delete(k); cacheBytes -= v.body.length;
        }
    }
    function recall(url) {
        const e = cache.get(url);
        if (!e) return null;
        if (now() - e.at > CACHE_MS) { cache.delete(url); cacheBytes -= e.body.length; return null; }
        cache.delete(url); cache.set(url, e);   // most recently used last
        return e;
    }

    /** One hop: a public host only (a literal is checked here, a name by safeLookup), the body capped. */
    function hop(url) {
        if (request) return request(url);
        return new Promise((resolve, reject) => {
            let u;
            try { u = new URL(url); } catch { return reject(Object.assign(new Error('bad address'), { status: 400 })); }
            if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(Object.assign(new Error('not http(s)'), { status: 400 }));
            const host = normalizeHost(u.hostname);
            if (!host || (net.isIP(host) && !isPublicAddress(host))) return reject(Object.assign(new Error('not a public address'), { status: 403 }));
            const lib = u.protocol === 'https:' ? https : http;
            const req = lib.get(u, { lookup: safeLookup, timeout: TIMEOUT_MS, headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8', 'user-agent': 'OpenVibeFeed/1 (+https://openvibe.network)' } }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    return resolve({ redirect: new URL(res.headers.location, u).toString() });
                }
                const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                if (res.statusCode !== 200 || !TYPES.test(type)) { res.resume(); return reject(Object.assign(new Error(`answered ${res.statusCode} ${type}`), { status: 502 })); }
                const len = Number(res.headers['content-length']);
                if (Number.isFinite(len) && len > PICTURE_MAX_BYTES) { res.destroy(); return reject(Object.assign(new Error('too large'), { status: 502 })); }
                const parts = []; let size = 0;
                res.on('data', (b) => { size += b.length; if (size > PICTURE_MAX_BYTES) { res.destroy(); reject(Object.assign(new Error('too large'), { status: 502 })); } else parts.push(b); });
                res.on('end', () => resolve({ type, body: Buffer.concat(parts) }));
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { status: 504 })));
            req.on('error', (err) => reject(Object.assign(err, { status: err.status || 502 })));
        });
    }
    async function fetchPicture(url) {
        let at = url;
        for (let i = 0; i <= MAX_REDIRECTS; i++) {
            const r = await hop(at);
            if (!r.redirect) return r;
            at = r.redirect;
        }
        throw Object.assign(new Error('too many redirects'), { status: 502 });
    }
    const inflight = new Map();

    async function handle(req, res) {
        const url = String(req.query.u || '');
        const sig = String(req.query.s || '');
        const good = url.length <= 2048 && /^https:\/\//.test(url) && !ours(url) && sig.length === 27
            && crypto.timingSafeEqual(Buffer.from(sig.padEnd(27).slice(0, 27)), Buffer.from(sign(url)));
        if (!good) return res.status(404).set('Cache-Control', 'no-store').end();
        try {
            let e = recall(url);
            if (!e) {
                if (!inflight.has(url)) inflight.set(url, fetchPicture(url).finally(() => inflight.delete(url)));
                const got = await inflight.get(url);
                e = { at: now(), type: got.type, body: got.body };
                remember(url, e);
            }
            res.set({
                'Content-Type': e.type,
                'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; sandbox",
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'Access-Control-Allow-Origin': '*',
            });
            return res.status(200).end(e.body);
        } catch (err) {
            // The store's picture is gone or refused: the card hides its frame (openvibe-shared draws the card without it).
            return res.status(err.status === 403 || err.status === 400 ? 404 : 502).set('Cache-Control', 'public, max-age=300').end();
        }
    }

    return { addressOf, card, handle, sign, ours };
}

module.exports = { createPictures, ours, PICTURE_MAX_BYTES };
