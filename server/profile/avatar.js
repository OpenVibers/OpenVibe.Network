'use strict';
// ═══════════════════════════════════════════════════════════════
// The avatar — one picture per account, for every OpenVibe site.
//
// Source of truth: users.avatar_url on the Network. A picture is always the person's own avatar object on
// openvibe.media: whatever is chosen (an upload, a paste screenshot, an openvibe.media address, a picture
// elsewhere on the web) is copied into a native avatar object owned by them, and the source is left untouched.
// A profile therefore never points at another product's object, so a Community cleanup or a deleted paste can
// no longer break someone's picture (incident 2026-11-06). Media records the reference, and refuses to delete
// an avatar that is still in use.
//
//   PUT    /api/profile/avatar   { source }   a paste link, a paste slug, or any https picture address
//   DELETE /api/profile/avatar                back to the generated initial
//   GET    /avatar/:username[?s=96]           public, cacheable: 302 to the picture, or an SVG initial.
//                                             Works in any <img> on any site with no API call. With ?s, a media
//                                             object picture is asked of openvibe.media at about that width as WebP
//                                             (Media's /o/:id?w=&fmt=, Fabric F4): a 32 px avatar is under 1 KB.
// Sync: every change is pushed to the sites that keep their own user row (Live), and Live pushes changes
// made there to POST /internal/user-avatar — so the last change wins everywhere.
// ═══════════════════════════════════════════════════════════════
const express = require('express');

const MEDIA_HOST = 'openvibe.media';
const PASTE_HOSTS = new Set(['openvibe.community', 'openvibe.live', 'openvibe.media', 'pastes.openvibe.tools']);
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,80}$/;

/**
 * '' → clear · a paste link or slug → its screenshot on openvibe.media · any https picture → itself.
 * Every non-empty answer is a *source*: Media copies it into the person's own avatar object before it is stored
 * (see media/ingest), so the address kept here is never the source's.
 */
function normalizeAvatar(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return { url: null };
    if (raw.length > 500) return { error: 'That link is too long' };
    if (SLUG_RE.test(raw)) return { url: `https://${MEDIA_HOST}/p/${raw}/screenshot`, paste: raw };
    let u; try { u = new URL(raw); } catch { return { error: 'Use a paste link or an https picture address' }; }
    if (u.protocol !== 'https:' || u.username || u.password) return { error: 'Avatars must be https addresses' };
    const host = u.hostname.toLowerCase();
    const m = /^\/p\/([A-Za-z0-9][A-Za-z0-9_-]{1,80})(?:\/(?:screenshot|raw)?)?\/?$/.exec(u.pathname);
    if (m && PASTE_HOSTS.has(host)) return { url: `https://${MEDIA_HOST}/p/${m[1]}/screenshot`, paste: m[1] };
    if (host === MEDIA_HOST) { u.hash = ''; }
    return { url: u.toString() };
}

/**
 * The picture's address for a requested size: an openvibe.media object (/o/med_…, no query of its own) gets
 * ?w=<2 × s>&fmt=webp (s is the size it is shown at; twice that stays sharp on a 2x screen), and Media answers a WebP
 * of about that width (it snaps to its ladder and never enlarges). Any other address, or a size outside 16–1024, is
 * the picture as stored.
 */
function sizedAvatar(url, s) {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 16 || n > 1024) return url;
    let u; try { u = new URL(url); } catch { return url; }
    if (u.hostname !== MEDIA_HOST || !/^\/o\/med_[0-9A-Za-z]{10,40}$/.test(u.pathname) || u.search) return url;
    u.search = `?w=${n * 2}&fmt=webp`;
    return u.toString();
}

/** The address must answer with an image (redirects to object storage are followed). */
async function verifyImage(url, fetchImpl = fetch) {
    try {
        const r = await fetchImpl(url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-0', Accept: 'image/*' }, signal: AbortSignal.timeout(6000) });
        const type = String(r.headers.get('content-type') || '');
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch { /* */ }
        if (!(r.ok || r.status === 206)) return { ok: false, error: 'That picture could not be loaded' };
        if (!/^image\/(png|jpe?g|webp|gif|avif)/i.test(type)) return { ok: false, error: 'That paste has no picture to use (it needs an image or a screenshot)' };
        return { ok: true };
    } catch { return { ok: false, error: 'openvibe.media did not answer in time; try again' }; }
}

/** Only our own picture host is ever served, whatever an old row holds (a legacy off-network address is never redirected to). */
function isMediaUrl(url) {
    try { return new URL(String(url)).hostname.toLowerCase() === MEDIA_HOST; } catch { return false; }
}

const initialSvg = (name, size) => {
    const s = Math.max(16, Math.min(512, parseInt(size, 10) || 96));
    const ch = (String(name || '?').match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase();
    let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 96 96"><rect width="96" height="96" fill="hsl(${h} 45% 42%)"/><text x="48" y="50" font-family="system-ui,sans-serif" font-size="46" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle">${ch}</text></svg>`;
};

function createAvatarService({ db, config, requireAuth, selfToken = () => null, log = console }) {
    // Network's own service token for the call (live.avatar.write / media.avatar.ingest).
    function authHeaders(audience, cap) {
        const t = selfToken(audience, [cap]);
        return t ? { Authorization: `Bearer ${t}` } : {};
    }
    const getUrl = db.prepare('SELECT avatar_url FROM users WHERE id = ?');
    const byName = db.prepare('SELECT username, avatar_url FROM users WHERE lower(username) = lower(?)');
    const setUrl = db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?');

    /** Tell the sites that keep their own copy. Fire and forget: they also pick it up at the next sign-in. */
    function pushToSites(userId, username, url) {
        const live = config.services && config.services.live && config.services.live.internalUrl || 'http://127.0.0.1:3000';
        const auth = authHeaders('openvibe.live', 'live.avatar.write');
        if (!Object.keys(auth).length) return;
        fetch(`${live.replace(/\/$/, '')}/internal/user-avatar`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
            body: JSON.stringify({ openvibenetwork_id: userId, username, avatar_url: url }), signal: AbortSignal.timeout(5000) }).catch(() => {});
    }

    const mediaUrl = () => ((config.services && config.services.media && config.services.media.internalUrl) || 'http://127.0.0.1:4100').replace(/\/$/, '');

    /**
     * Any picture becomes this person's own avatar object: Media reads an openvibe.media source from local storage
     * (reusing the person's own avatar as it is) and fetches anything else safely, re-encoding it. `product`/`ref`
     * record the profile reference, which is what stops a cleanup deleting the picture that is in use.
     */
    async function ingest(url, user) {
        const auth = authHeaders('openvibe.media', 'media.avatar.ingest');
        if (!Object.keys(auth).length) return { ok: false, status: 503, error: 'Picture import is not configured on this server' };
        try {
            const r = await fetch(`${mediaUrl()}/internal/avatar-ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
                // subject: the picture's owner on Media's object, in the network-wide id space (user_id is Network's own).
                body: JSON.stringify({ url, user_id: user.id, username: user.username, subject: user.subject_id || null, product: 'network', ref: String(user.id) }), signal: AbortSignal.timeout(20000) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.ok) return { ok: false, status: r.status === 404 ? 503 : 422, error: j.error || 'That picture could not be imported' };
            const back = normalizeAvatar(j.url);            // trust nothing: the answer must itself be an openvibe.media address
            if (!back.url || !/^\/o\/med_/.test(new URL(back.url).pathname)) return { ok: false, status: 502, error: 'Picture import returned an unexpected address' };
            return { ok: true, url: back.url, slug: j.slug, reused: !!j.reused };
        } catch { return { ok: false, status: 504, error: 'openvibe.media did not answer in time; try again' }; }
    }

    /** The profile no longer points at its picture: Media drops the reference so the object can be deleted normally. */
    async function release(userId) {
        const auth = authHeaders('openvibe.media', 'media.avatar.release');
        if (!Object.keys(auth).length) return;
        try {
            await fetch(`${mediaUrl()}/internal/avatar-release`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ product: 'network', ref: String(userId) }), signal: AbortSignal.timeout(5000) });
        } catch { /* best effort: the object stays protected rather than lost */ }
    }

    /**
     * The one place an avatar changes. `origin` names who asked ('network', 'live'), so we never echo a push back
     * — unless the stored address changed (a site sent a paste screenshot that is now its own avatar object, and
     * the site must learn the new address, or it would keep pointing at the source).
     */
    async function apply(userId, username, url, origin, { pushBack = false } = {}) {
        const before = (await getUrl.get(userId) || {}).avatar_url || null;
        if (before === url) return false;
        await setUrl.run(url, userId);
        try { await db.prepare('INSERT INTO audit_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)').run(userId, 'avatar_change', JSON.stringify({ from: before, to: url, origin }), null); } catch { /* audit is best effort */ }
        if (origin !== 'live' || pushBack) pushToSites(userId, username, url);
        return true;
    }

    const api = express.Router();
    api.put('/', requireAuth, async (req, res) => {
        const n = normalizeAvatar(req.body && (req.body.source ?? req.body.avatar_url ?? req.body.url));
        if (n.error) return res.status(400).json({ error: n.error });
        let url = n.url;
        if (url) {
            // Always a copy in the person's own avatar object, whatever the source (a paste screenshot, another
            // product's object, a picture elsewhere). Media reuses the picture when it is already theirs.
            const got = await ingest(url, req.user);
            if (!got.ok) return res.status(got.status || 422).json({ error: got.error });
            url = got.url; n.paste = got.slug || n.paste;
        }
        await apply(req.user.id, req.user.username, url, 'network');
        res.json({ ok: true, avatar_url: url, paste: n.paste || null });
    });
    api.delete('/', requireAuth, async (req, res) => {
        await apply(req.user.id, req.user.username, null, 'network');
        await release(req.user.id);
        res.json({ ok: true, avatar_url: null });
    });

    const pub = express.Router();
    pub.get('/:username', async (req, res) => {
        const name = String(req.params.username || '').replace(/\.(png|jpg|svg)$/i, '').slice(0, 64);
        const row = await byName.get(name);
        res.set({ 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
        const ok = row && row.avatar_url && isMediaUrl(row.avatar_url) && !!normalizeAvatar(row.avatar_url).url;
        if (ok) return res.redirect(302, sizedAvatar(row.avatar_url, req.query.s));
        res.type('image/svg+xml').send(initialSvg(row ? row.username : name, req.query.s));
    });

    /** Live changed someone's picture: adopt it into an avatar object, and tell that site the new address if it changed. */
    async function fromSite(body) {
        const id = parseInt(body && body.user_id, 10); if (!id) return { status: 400, error: 'user_id required' };
        const n = normalizeAvatar(body.avatar_url); if (n.error) return { status: 422, error: n.error };
        if (n.url && new URL(n.url).hostname !== MEDIA_HOST) return { status: 422, error: 'Sites report openvibe.media pictures only' };
        const u = await db.prepare('SELECT username, subject_id FROM users WHERE id = ?').get(id); if (!u) return { status: 404, error: 'user not found' };
        let url = n.url; let pushBack = false;
        if (url) {
            const got = await ingest(url, { id, username: u.username, subject_id: u.subject_id });
            if (!got.ok) return { status: got.status || 422, error: got.error };
            pushBack = got.url !== n.url;
            url = got.url;
        }
        return { status: 200, changed: await apply(id, u.username, url, String(body.origin || 'live'), { pushBack }), avatar_url: url };
    }

    return { api, pub, fromSite, apply, ingest, release, log };
}

module.exports = { createAvatarService, normalizeAvatar, verifyImage, initialSvg };
