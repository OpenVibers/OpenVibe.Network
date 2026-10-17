'use strict';
const contracts = require('openvibe-contracts');
const { exposureOf } = require('../registry/exposure');
// Every OpenVibe property: what it is, whether it is open, and which legal documents apply.
//   legal.profile decides the wording of /terms, /privacy and /dmca on that site (openvibe-shared/legal):
//     streaming  user video + chat + payments        tools   files processed and discarded
//     ugc        user posts/pastes                    games   accounts + game state
//     hosting    stored user media                    account identity provider
//     info       read-only placeholder/editorial site
// A site is 'open' (in the nav) only when its service's public domain serves the service itself, per
// Network's exposure overlay (server/registry/exposure.js); every other site is 'soon' and says why
// (state: internal = runs on loopback only, placeholder = planned). The two lists cannot disagree.
// Since openvibe-contracts 0.42.0 (WS-C task 1) the list is the manifests' `site` blocks, in `position` order:
// name, icon, tagline, what, the legal profile, and a host only while the manifest has no publicOrigin. A
// site's id is its icon name (live, tools, …, stream for OpenRestream).
const RAW_SITES = contracts.services.manifests.filter((m) => m.site).sort((a, b) => (a.site.position ?? 999) - (b.site.position ?? 999)).map((m) => ({
    id: m.site.icon, name: m.site.name, icon: m.site.icon, service: m.id, profile: m.site.legalProfile, tagline: m.site.tagline, what: m.site.what,
    ...(m.site.host ? { host: m.site.host } : {}),
}));
function manifestHost(service) {
    const m = contracts.services.get(service);
    try { return m && m.publicOrigin ? new URL(m.publicOrigin).hostname : null; } catch { return null; }
}
const SITES = RAW_SITES.map((s) => {
    const e = exposureOf(s.service);
    const host = manifestHost(s.service) || s.host;
    if (!host) throw new Error(`site ${s.id}: no host (its manifest has no publicOrigin and the entry names none)`);
    return { ...s, host, status: e.state === 'live' && e.public_site === 'service' ? 'open' : 'soon', state: e.state };
});
const byHost = new Map(SITES.map(s => [s.host, s]));

// The launcher (openvibe-shared navbar) lists every open site under one of these groups, most used first within
// each. A site missing here lands in the last group, so a new manifest is never left out of the menu.
const GROUPS = [
    { id: 'watch', name: 'Watch & stream', sites: ['live', 'media-hub', 'pics', 'stream', 'tips', 'vip'] },
    { id: 'create', name: 'Create & play', sites: ['games', 'play', 'space', 'blog'] },
    { id: 'talk', name: 'Talk & learn', sites: ['chat', 'community', 'wiki', 'news'] },
    { id: 'everyday', name: 'Shop & everyday', sites: ['deals', 'coupons', 'reviews', 'food', 'rent', 'homes', 'trade', 'work', 'host'] },
    { id: 'build', name: 'Build & automate', sites: ['tools', 'codes', 'run', 'actor', 'ai', 'bot', 'services', 'events', 'watch', 'zone', 'media', 'download'] },
    { id: 'you', name: 'Your OpenVibe', sites: ['network', 'search', 'help', 'quest', 'inventory'] },
];
const groupOf = (id) => (GROUPS.find(g => g.sites.includes(id)) || GROUPS[GROUPS.length - 1]).id;

// Products with a domain of their own that another service serves (its manifest lists the domain): in the menu
// while that service's site is open, right after it. They are not sites of their own (no ranking, no legal profile).
const PRODUCTS = [
    { id: 'pics', name: 'Pics', host: 'openvibe.pics', icon: 'pics', of: 'media-hub', tagline: 'Share pictures, fast and open' },
    { id: 'download', name: 'Download', host: 'openvibe.download', icon: 'download', of: 'media-hub', tagline: 'Your files, shared on your terms' },
    { id: 'homes', name: 'Homes', host: 'openvibe.homes', icon: 'homes', of: 'rent', tagline: 'Every home-for-sale site, one search' },
].filter((p) => { const s = SITES.find(x => x.id === p.of); const m = s && contracts.services.get(s.service); return m && (m.domains || []).includes(p.host); });
// Manifest icon names the shared icon set draws differently.
const ICON_ALIAS = { 'media-hub': 'video' };

/** The site a hostname belongs to (subdomains included), or null. */
function siteForHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    if (byHost.has(h)) return byHost.get(h);
    for (const s of SITES) if (h.endsWith('.' + s.host)) return s;
    return null;
}

module.exports = { SITES, siteForHost, GROUPS, groupOf, PRODUCTS, ICON_ALIAS };
