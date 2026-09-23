'use strict';
// The zones OpenVibe owns. Cross-site trust (sso/check framing, FedCM relying parties, sign-in
// handoff targets) is limited to these — never to openvibe.<anything>, which anyone can register.
const OWNED_ZONES = [
    'openvibe.network', 'openvibe.live', 'openvibe.tools', 'openvibe.media', 'openvibe.games', 'openvibe.community',
    'openvibe.chat', 'openvibe.codes', 'openvibe.blog', 'openvibe.wiki', 'openvibe.news', 'openvibe.reviews',
    'openvibe.tips', 'openvibe.vip', 'openvibe.trade', 'openvibe.host', 'openvibe.deals', 'openvibe.coupons',
    'openre.stream',
];
// Zones whose subdomains are people's own content (OpenVibe.Host tenant sites, <site>.openvibe.host,
// which run the tenant's JS): only the apex is OpenVibe's. Domain validation still refuses them as
// tool hosts through OWNED_ZONES; trust checks go through isTrustedHost.
const USER_CONTENT_ZONES = ['openvibe.host'];

/** Is `hostname` an OpenVibe site we trust across sites (an owned zone, minus tenant subdomains)? */
function isTrustedHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return OWNED_ZONES.some(z => h === z || (h.endsWith('.' + z) && !USER_CONTENT_ZONES.includes(z)));
}

/** Which RP origins an OAuth client may exchange FedCM assertions for. */
function clientOriginMatcher(client) {
    const id = String(client?.client_id || '');
    const zoneOf = { live: 'openvibe.live', tools: 'openvibe.tools', games: 'openvibe.games', media: 'openvibe.media', community: 'openvibe.community', network: 'openvibe.network' }[id];
    let uris = [];
    try { uris = JSON.parse(client?.redirect_uris || '[]'); } catch { /* */ }
    const registered = new Set(uris.map(u => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean));
    return (origin) => {
        if (registered.has(origin)) return true;
        if (!zoneOf) return false;
        try { const h = new URL(origin).hostname; return h === zoneOf || h.endsWith('.' + zoneOf); } catch { return false; }
    };
}

module.exports = { OWNED_ZONES, USER_CONTENT_ZONES, isTrustedHost, clientOriginMatcher };
