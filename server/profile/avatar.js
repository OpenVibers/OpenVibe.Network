'use strict';
// ═══════════════════════════════════════════════════════════════
// The avatar — one picture per account, for every OpenVibe site.
//
// Source of truth: users.avatar_url on the Network. A picture is always a file on openvibe.media, usually
// the screenshot of one of your pastes; nothing else is accepted, so an avatar can never be a tracking
// pixel on someone else's server, a javascript: URL, or a file that disappears with a third party.
//
//   PUT    /api/profile/avatar   { source }   a paste link, a paste slug, or an https://openvibe.media/… image
//   DELETE /api/profile/avatar                back to the generated initial
//   GET    /avatar/:username[?s=96]           public, cacheable: 302 to the picture, or an SVG initial.
//                                             Works in any <img> on any site with no API call.
// Sync: every change is pushed to the sites that keep their own user row (Live), and Live pushes changes
// made there to POST /internal/user-avatar — so the last change wins everywhere.
// ═══════════════════════════════════════════════════════════════
const express = require('express');

const MEDIA_HOST = 'openvibe.media';
const PASTE_HOSTS = new Set(['openvibe.community', 'openvibe.live', 'openvibe.media', 'pastes.openvibe.tools']);
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,80}$/;

/** '' → clear · a paste link or slug → its screenshot on openvibe.media · an openvibe.media https URL → itself · else null */
function normalizeAvatar(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return { url: null };
    if (raw.length > 500) return { error: 'That link is too long' };
    if (SLUG_RE.test(raw)) return { url: `https://${MEDIA_HOST}/p/${raw}/screenshot`, paste: raw };
    let u; try { u = new URL(raw); } catch { return { error: 'Use a paste link or an openvibe.media image address' }; }
    if (u.protocol !== 'https:' || u.username || u.password) return { error: 'Avatars must be https addresses' };
    const host = u.hostname.toLowerCase();
    const m = /^\/p\/([A-Za-z0-9][A-Za-z0-9_-]{1,80})(?:\/(?:screenshot|raw)?)?\/?$/.exec(u.pathname);
    if (m && PASTE_HOSTS.has(host)) return { url: `https://${MEDIA_HOST}/p/${m[1]}/screenshot`, paste: m[1] };
    if (host === MEDIA_HOST) { u.hash = ''; return { url: u.toString() }; }
    return { error: 'Avatars live on openvibe.media: use one of your pastes, or an image hosted there' };
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

const initialSvg = (name, size) => {
    const s = Math.max(16, Math.min(512, parseInt(size, 10) || 96));
    const ch = (String(name || '?').match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase();
    let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 96 96"><rect width="96" height="96" fill="hsl(${h} 45% 42%)"/><text x="48" y="50" font-family="system-ui,sans-serif" font-size="46" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle">${ch}</text></svg>`;
};

function createAvatarService({ db, config, requireAuth, log = console }) {
    const getUrl = db.prepare('SELECT avatar_url FROM users WHERE id = ?');
    const byName = db.prepare('SELECT username, avatar_url FROM users WHERE lower(username) = lower(?)');
    const setUrl = db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?');

    /** Tell the sites that keep their own copy. Fire and forget: they also pick it up at the next sign-in. */
    function pushToSites(userId, username, url) {
        const live = config.services && config.services.live && config.services.live.internalUrl || 'http://127.0.0.1:3000';
        if (!config.internalKey || config.internalKey === 'change-me-in-production') return;
        fetch(`${live.replace(/\/$/, '')}/internal/user-avatar`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Key': config.internalKey },
            body: JSON.stringify({ openvibenetwork_id: userId, username, avatar_url: url }), signal: AbortSignal.timeout(5000) }).catch(() => {});
    }

    /** The one place an avatar changes. `origin` names who asked ('network', 'live'), so we never echo a push back. */
    function apply(userId, username, url, origin) {
        const before = (getUrl.get(userId) || {}).avatar_url || null;
        if (before === url) return false;
        setUrl.run(url, userId);
        try { db.prepare('INSERT INTO audit_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)').run(userId, 'avatar_change', JSON.stringify({ from: before, to: url, origin }), null); } catch { /* audit is best effort */ }
        if (origin !== 'live') pushToSites(userId, username, url);
        return true;
    }

    const api = express.Router();
    api.put('/', requireAuth, async (req, res) => {
        const n = normalizeAvatar(req.body && (req.body.source ?? req.body.avatar_url ?? req.body.url));
        if (n.error) return res.status(400).json({ error: n.error });
        if (n.url) { const v = await verifyImage(n.url); if (!v.ok) return res.status(422).json({ error: v.error }); }
        apply(req.user.id, req.user.username, n.url, 'network');
        res.json({ ok: true, avatar_url: n.url, paste: n.paste || null });
    });
    api.delete('/', requireAuth, (req, res) => { apply(req.user.id, req.user.username, null, 'network'); res.json({ ok: true, avatar_url: null }); });

    const pub = express.Router();
    pub.get('/:username', (req, res) => {
        const name = String(req.params.username || '').replace(/\.(png|jpg|svg)$/i, '').slice(0, 64);
        const row = byName.get(name);
        res.set({ 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
        const ok = row && row.avatar_url && !normalizeAvatar(row.avatar_url).error;
        if (ok) return res.redirect(302, row.avatar_url);
        res.type('image/svg+xml').send(initialSvg(row ? row.username : name, req.query.s));
    });

    /** Live changed someone's picture: adopt it (same rules, no verification round trip for our own media host). */
    function fromSite(body) {
        const id = parseInt(body && body.user_id, 10); if (!id) return { status: 400, error: 'user_id required' };
        const n = normalizeAvatar(body.avatar_url); if (n.error) return { status: 422, error: n.error };
        const u = db.prepare('SELECT username FROM users WHERE id = ?').get(id); if (!u) return { status: 404, error: 'user not found' };
        return { status: 200, changed: apply(id, u.username, n.url, String(body.origin || 'live')) };
    }

    return { api, pub, fromSite, apply, log };
}

module.exports = { createAvatarService, normalizeAvatar, verifyImage, initialSvg };
