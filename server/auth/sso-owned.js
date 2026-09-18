'use strict';
// The zones OpenVibe owns. Cross-site trust (sso/check framing, FedCM relying parties, sign-in
// handoff targets) is limited to these — never to openvibe.<anything>, which anyone can register.
const OWNED_ZONES = [
    'openvibe.network', 'openvibe.live', 'openvibe.tools', 'openvibe.media', 'openvibe.games', 'openvibe.community',
    'openvibe.chat', 'openvibe.codes', 'openvibe.blog', 'openvibe.wiki', 'openvibe.news', 'openvibe.reviews',
    'openvibe.tips', 'openvibe.vip', 'openvibe.trade', 'openvibe.host', 'openvibe.deals', 'openvibe.coupons',
    'openre.stream',
];

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

module.exports = { OWNED_ZONES, clientOriginMatcher };
