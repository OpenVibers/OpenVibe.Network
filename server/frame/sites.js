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

/** A site's full name: its own when it is a brand already (OpenRestream), otherwise OpenVibe.<name> (OpenVibe.Live).
 *  "OpenVibe.OpenRestream" read wrong on the home page's cards (the owner, 2026-10-28). */
const fullName = (s) => (/^Open[A-Z]/.test(String(s && s.name)) ? s.name : `OpenVibe.${s && s.name}`);

// The launcher (openvibe-shared navbar) lists every open site under one of these groups, most used first within
// each. A site missing here lands in the last group, so a new manifest is never left out of the menu.
// The six neighbourhoods of the 2026-10-28 plan (§3.1): each label is two words, so it never collides with a site's own
// name, and they follow what a person came to do. Rooms not open yet (Cam, Tours, Surf, Fun, Meme, Casino, Today, Report,
// Vision, Website, Design, Domains, open.shoes, Exchange) are named here so they land in their neighbourhood the day
// their manifest opens. The building blocks stay last, "For developers" (the tail of Make & build).
const GROUPS = [
    { id: 'streams', name: 'Streams & places', sites: ['live', 'media-hub', 'stream', 'pics', 'download', 'cam', 'tours'] },
    { id: 'games', name: 'Games & laughs', sites: ['games', 'surf', 'fun', 'meme', 'casino', 'quest'] },
    { id: 'answers', name: 'News & answers', sites: ['today', 'report', 'news', 'search', 'wiki', 'blog', 'reviews', 'vision'] },
    { id: 'make', name: 'Make & build', sites: ['website', 'design', 'domains', 'codes', 'space', 'tools', 'host', 'bot'] },
    { id: 'shop', name: 'Shop & swap', sites: ['deals', 'coupons', 'shoes', 'exchange', 'rent', 'homes', 'work', 'food', 'trade'] },
    { id: 'people', name: 'People & you', sites: ['chat', 'community', 'tips', 'vip', 'help', 'network', 'inventory'] },
    // Actor is the engine behind every agent (Codes' Auto, Vibe, the Dock call it): a developer service, not a second
    // place to chat with an agent (plan L39, 2026-10-31).
    { id: 'build', name: 'For developers', sites: ['services', 'ai', 'actor', 'bench', 'run', 'zone', 'events', 'media', 'watch', 'play'] },
];
// What each site is, in a few words, for the menus (the launcher's rows are two to a line on a phone: about 22
// characters fit). The manifests' taglines stay the sites' own sentences everywhere else; a site missing here shows
// its tagline.
const MENU_LINE = {
    live: 'Go live, watch streams', 'media-hub': 'Clips and past streams', stream: 'Stream everywhere', pics: 'Share pictures',
    download: 'Your files', tips: 'Support streamers', vip: 'Back your creators',
    chat: 'Chat with anyone', community: 'Posts and pastes', blog: 'Write long-form', news: 'Sourced, not spun', wiki: 'Facts with sources',
    games: 'Play in your browser', quest: 'Earn badges', fun: 'Something to do',
    codes: 'Code with any agent', actor: 'The agent engine', space: 'Host a site or app', tools: 'Every online tool', bot: 'Drive a robot',
    deals: 'Deals people share', coupons: 'Codes that work', reviews: 'Honest reviews', work: 'Find a job', rent: 'Places to rent',
    homes: 'Homes for sale', food: 'Food near you', help: 'Help nearby', trade: 'Watch the markets', watch: 'Know when it changes',
    search: 'Search everything', host: 'Compare hosting', report: 'Your numbers, honest', vision: 'Ask a picture',
    exchange: 'Apps, skills, compute',
    network: 'Your account', inventory: 'Your items',
    services: 'APIs, SDK and keys', ai: 'AI router, your keys', bench: 'Which AI is best', run: 'Run jobs anywhere', zone: 'S3 storage', events: 'Event streams', media: 'Media API', play: 'Game services',
};

// A site's name in the menus, where the rows are short words (Pics, Download, VIP, Tips): the product keeps its full name
// everywhere else (its own site, page titles, sign-in). The owner, 2026-10-28: "label it simply Restream… it does look
// a little weird" next to the others.
const MENU_NAME = { stream: 'Restream' };

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

module.exports = { SITES, siteForHost, GROUPS, groupOf, PRODUCTS, ICON_ALIAS, MENU_LINE, MENU_NAME, fullName };
