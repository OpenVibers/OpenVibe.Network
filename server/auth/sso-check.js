'use strict';
// ═══════════════════════════════════════════════════════════════
// GET /sso/check?origin=https://openvibe.tools — the silent, invisible session check.
//
// A site that has no session of its own loads this page in a hidden <iframe>. It answers with one
// postMessage to the embedding site: { type: 'ov-sso', signedIn, username } — nothing more. If
// the browser is signed in here, the site then does its normal prompt=none sign-in (one quick
// redirect that comes straight back); if not, nothing visible happens at all. This replaces the
// "hop through every site after login" chain: sites pick the session up when they are opened.
//
// Safety: the target origin must be an OpenVibe origin (the message is addressed to it, so no
// other page can read it), the response may only be framed by that origin (frame-ancestors),
// it is never cached, and it carries no token — the site still has to complete OAuth itself.
// Browsers that partition third-party cookies see no ov_sso cookie and get signedIn: false.
// ═══════════════════════════════════════════════════════════════

// Only the zones OpenVibe owns — not openvibe.<anything>, which anyone could register.
const OWNED = ['openvibe.network', 'openvibe.live', 'openvibe.tools', 'openvibe.media', 'openvibe.games', 'openvibe.community', 'openvibe.chat', 'openvibe.codes', 'openvibe.blog', 'openvibe.wiki', 'openvibe.news', 'openvibe.reviews', 'openvibe.tips', 'openvibe.vip', 'openvibe.trade', 'openvibe.host', 'openvibe.deals', 'openvibe.coupons', 'openre.stream'];
const ORIGIN_RE = new RegExp(`^https://(?:[a-z0-9-]+\\.)*(?:${OWNED.map(d => d.replace(/\./g, '\\.')).join('|')})$`, 'i');
const LOCAL_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

function allowedOrigin(raw, env = process.env) {
    const o = String(raw || '').trim().replace(/\/$/, '');
    if (!o) return null;
    if (ORIGIN_RE.test(o)) return o;
    if (env.NODE_ENV !== 'production' && LOCAL_RE.test(o)) return o;
    return null;
}

function renderCheck(origin, state) {
    const payload = JSON.stringify({ type: 'ov-sso', signedIn: !!state.signedIn, username: state.username || null, at: Date.now() });
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>OpenVibe session</title></head><body><script>
(function(){try{window.parent.postMessage(${payload}, ${JSON.stringify(origin)});}catch(e){}})();
</script></body></html>`;
}

function createSsoCheckRoute(getCtx) {
    return function ssoCheck(req, res) {
        const origin = allowedOrigin(req.query.origin);
        if (!origin) return res.status(400).type('text').send('origin must be an OpenVibe origin');
        const { verifySession, requestToken } = require('./session');
        let signedIn = false, username = null;
        try {
            const out = verifySession(requestToken(req), getCtx(req));
            if (!out.error && out.user && !out.user.is_anon) { signedIn = true; username = out.user.username || null; }
        } catch { /* not signed in */ }
        res.removeHeader('X-Frame-Options');
        res.setHeader('Content-Security-Policy', `frame-ancestors ${origin}; default-src 'none'; script-src 'unsafe-inline'`);
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('Vary', 'Cookie');
        res.setHeader('X-Robots-Tag', 'noindex');
        res.type('html').send(renderCheck(origin, { signedIn, username }));
    };
}

module.exports = { createSsoCheckRoute, allowedOrigin, renderCheck };
