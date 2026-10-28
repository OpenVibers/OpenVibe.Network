'use strict';
// The zones OpenVibe owns. Cross-site trust (sso/check framing, FedCM relying parties, sign-in
// handoff targets) is limited to these — never to openvibe.<anything>, which anyone can register.
const OWNED_ZONES = [
    'openvibe.network', 'openvibe.live', 'openvibe.tools', 'openvibe.media', 'openvibe.games', 'openvibe.community', 'openvibe.space',
    'openvibe.chat', 'openvibe.codes', 'openvibe.blog', 'openvibe.wiki', 'openvibe.news', 'openvibe.reviews',
    'openvibe.tips', 'openvibe.vip', 'openvibe.trade', 'openvibe.host', 'openvibe.deals', 'openvibe.coupons',
    'openre.stream',
    'open.shoes', 'openvibe.today', 'openvibe.vision', 'openvibe.domains', 'openvibe.report', 'openvibe.meme', 'openvibe.casino', 'openvibe.surf', 'openvibe.fun', 'openvibe.tours', 'openvibe.exchange', 'openvibe.cam', 'openvibe.design',
];
// Zones whose subdomains are people's own content (OpenVibe.Host tenant sites, <site>.openvibe.host,
// which run the tenant's JS): only the apex is OpenVibe's. Domain validation still refuses them as
// tool hosts through OWNED_ZONES; trust checks go through isTrustedHost.
const USER_CONTENT_ZONES = ['openvibe.host'];

// Every exact host a service manifest lists (openvibe-contracts manifests' `domains`). The zones above were written by
// hand and the sites added since were never on them (openvibe.video, .download, .pics, .quest, .food, .rent, .work,
// .help, .bot, .actor …), so /sso/check refused their hidden check and none of them signed a network-signed-in
// browser in by itself (2026-10-20). Exact hosts only: no subdomain of one is trusted unless its zone is above.
const MANIFEST_HOSTS = (() => {
    try {
        const { services } = require('openvibe-contracts');
        return new Set(services.manifests.flatMap((m) => (m.domains || []).map((d) => String((d && d.domain) || d).toLowerCase())));
    } catch { return new Set(); }
})();

/** Is `hostname` an OpenVibe site we trust across sites (an owned zone, minus tenant subdomains, or a manifest's host)? */
function isTrustedHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return MANIFEST_HOSTS.has(h) || OWNED_ZONES.some(z => h === z || (h.endsWith('.' + z) && !USER_CONTENT_ZONES.includes(z)));
}

/** A bare https origin (no port, no path) on a trusted host: a site that may use cross-site sign-in. */
function isTrustedOrigin(origin) {
    try {
        const u = new URL(String(origin || ''));
        return u.protocol === 'https:' && !u.port && u.origin === String(origin) && isTrustedHost(u.hostname);
    } catch { return false; }
}

/** Which RP origins an OAuth client may exchange FedCM assertions for. */
function clientOriginMatcher(client) {
    const id = String(client?.client_id || '');
    const zoneOf = { live: 'openvibe.live', tools: 'openvibe.tools', games: 'openvibe.games', media: 'openvibe.media', community: 'openvibe.community', space: 'openvibe.space', network: 'openvibe.network' }[id];
    let uris = [];
    try { uris = JSON.parse(client?.redirect_uris || '[]'); } catch { /* */ }
    const registered = new Set(uris.map(u => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean));
    return (origin) => {
        if (registered.has(origin)) return true;
        if (!zoneOf) return false;
        try { const h = new URL(origin).hostname; return h === zoneOf || h.endsWith('.' + zoneOf); } catch { return false; }
    };
}

module.exports = { OWNED_ZONES, USER_CONTENT_ZONES, MANIFEST_HOSTS, isTrustedHost, isTrustedOrigin, clientOriginMatcher };
