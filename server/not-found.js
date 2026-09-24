'use strict';
// ═══════════════════════════════════════════════════════════════
// Unknown paths answer 404 (roadmap §2.5 crawlability, D44).
//
// The apex used to send the account hub (my.html) with 200 for ANY path, so
// openvibe.network/<anything> looked like a real page to crawlers and people. Every real page
// is now a route of its own in server/index.js (the account hub's sections are listed in
// ACCOUNT_HUB_PATHS below, /admin/* stays the admin SPA); everything else ends here:
//   /api/*, /internal/*, /oauth/*   404 JSON { error: 'Not found' }
//   anything else                   404, a small noindex page with links back in
// ═══════════════════════════════════════════════════════════════

// The account hub (public/my.html) and its client-routed sections. my.html maps each path to a
// section (pathSection in its script); a path it does not know is not a page.
const ACCOUNT_HUB_PATHS = ['/my', '/my.html', '/themes', '/notifications', '/linked', '/security', '/profile', '/billing', '/preferences', '/history'];

const JSON_PREFIXES = ['/api/', '/internal/', '/oauth/'];

let cached = null;
function page() {
    if (cached) return cached;
    let footer = '';
    let icons = '';
    let nav = '';
    try { footer = require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact' }); } catch { /* optional */ }
    try { icons = require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: '/assets' }); } catch { /* optional */ }
    try { nav = require('openvibe-shared/chrome-ssr').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Sign in', href: '/login' }] }); } catch { /* optional */ }
    cached = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found · OpenVibe.Network</title>
<meta name="robots" content="noindex">
${icons}
<meta name="color-scheme" content="dark light">
<script src="/shared/theme-loader.js" defer></script>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg-primary:#0a0f1c;--bg-secondary:#101828;--border:#1f2d47;--accent:#3b82f6;--text-primary:#e6edf7;--text-secondary:#96a7c2}
html,body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
a{color:var(--accent)}
.nf{max-width:640px;margin:0 auto;padding:72px 16px 56px}
.nf h1{font-size:clamp(26px,4vw,36px);letter-spacing:-.02em;margin:0 0 10px}
.nf p{color:var(--text-secondary);line-height:1.55;margin:0 0 22px}
.nf ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:10px}
.nf li a{display:inline-block;padding:9px 16px;border-radius:999px;border:1px solid var(--border);background:var(--bg-secondary);color:inherit;text-decoration:none;font-weight:600}
.nf li a:hover,.nf li a:focus-visible{border-color:var(--accent);outline:0}
</style>
</head>
<body>
<div id="navbar-mount"></div>
${nav}
<main class="nf" id="main">
<h1>Page not found</h1>
<p>There is no page at this address on openvibe.network. The link may be old or mistyped.</p>
<ul>
<li><a href="/">OpenVibe.Network home</a></li>
<li><a href="/my">Your account</a></li>
<li><a href="/login">Sign in</a></li>
<li><a href="/status">Service status</a></li>
</ul>
</main>
${footer}
<script src="/shared/navbar.js" defer></script>
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:location.origin});}catch(e){}});</script>
</body>
</html>`;
    return cached;
}

/** Last handler of the app: every method, every path nothing else answered. */
function notFound(req, res) {
    res.status(404);
    res.set('Cache-Control', 'no-cache');
    if (JSON_PREFIXES.some(p => req.path.startsWith(p))) return res.json({ error: 'Not found' });
    res.set('X-Robots-Tag', 'noindex');
    return res.type('html').send(page());
}

module.exports = { notFound, page, ACCOUNT_HUB_PATHS };
