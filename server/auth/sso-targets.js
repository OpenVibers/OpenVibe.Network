'use strict';
// ═══════════════════════════════════════════════════════════════
// "Sign in everywhere": the first-party sites a network sign-in is fanned out to.
//
// The sites are separate registrable domains (openvibe.live, openvibe.tools, …), so no cookie
// can be shared between them and third-party cookies are unreliable for hidden-frame SSO.
// What always works is a chain of top-level redirects: after signing in here, the browser
// visits each site's silent login (prompt=none → an authorization code with no chooser), the
// site sets its own first-party session cookie and hands the browser back to
// /sso/fanout for the next hop. Each hop is one quick round trip; the fanout page shows
// progress. The same chain with action=logout signs the browser out of every site.
//
// {next} is replaced with the URL-encoded fanout continuation. Sites must accept it when
// it points at https://openvibe.network/… .
// ═══════════════════════════════════════════════════════════════

const DEFAULT_TARGETS = [
    { id: 'live', name: 'OpenVibe.Live', origin: 'https://openvibe.live',
      login: 'https://openvibe.live/api/auth/sso/login?silent=1&next={next}',
      logout: 'https://openvibe.live/api/auth/logout?next={next}' },
    { id: 'tools', name: 'OpenVibe.Tools', origin: 'https://openvibe.tools',
      login: 'https://openvibe.tools/auth/login?silent=1&next={next}',
      logout: 'https://openvibe.tools/auth/logout?next={next}' },
    { id: 'games', name: 'OpenVibe.Games', origin: 'https://openvibe.games',
      login: 'https://openvibe.games/auth/login?silent=1&next={next}',
      logout: 'https://openvibe.games/auth/logout?next={next}' },
    { id: 'community', name: 'OpenVibe.Community', origin: 'https://openvibe.community',
      login: 'https://openvibe.community/auth/login?silent=1&next={next}',
      logout: 'https://openvibe.community/auth/logout?next={next}' },
];

/**
 * Targets for this deployment. OV_SSO_TARGETS (JSON array, same shape) replaces the list;
 * OV_SSO_TARGETS_DISABLED ("games,community") removes entries — for a site that is not
 * deployed yet, so the chain never sends a browser to an error page.
 */
function ssoTargets(env = process.env) {
    let list = DEFAULT_TARGETS;
    if (env.OV_SSO_TARGETS) {
        try { const parsed = JSON.parse(env.OV_SSO_TARGETS); if (Array.isArray(parsed)) list = parsed; } catch { /* keep defaults */ }
    }
    const disabled = new Set(String(env.OV_SSO_TARGETS_DISABLED || '').split(',').map(s => s.trim()).filter(Boolean));
    return list.filter(t => t && t.id && t.login && !disabled.has(t.id)).map(t => ({
        id: String(t.id), name: t.name || t.id, origin: t.origin || null, login: t.login, logout: t.logout || null,
    }));
}

/** Is `next` somewhere we are willing to send the browser after the chain? */
function safeNext(raw, env = process.env) {
    const s = String(raw || '');
    if (!s) return '/';
    if (s.startsWith('/') && !s.startsWith('//')) return s;
    try {
        const u = new URL(s);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return '/';
        const h = u.hostname.toLowerCase();
        if (/(^|\.)openvibe\.[a-z]+$/.test(h) || /(^|\.)openre\.stream$/.test(h) || /^(localhost|127\.0\.0\.1)$/.test(h)) return u.toString();
        for (const t of ssoTargets(env)) { try { if (t.origin && new URL(t.origin).hostname === h) return u.toString(); } catch { /* */ } }
    } catch { /* not a URL */ }
    return '/';
}

module.exports = { ssoTargets, safeNext, DEFAULT_TARGETS };
