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
// OpenVibe.Bench moved into OpenVibe.Report's AI section (owner, 2026-11-08): its public pages are gone, so it is
// not a site of its own in the Frame. The service and its API stay; the entry below lists its AI pages under Report.
const HIDDEN_SITES = new Set(['bench']);
const COMPUTER_FALLBACK = { id: 'computer', name: 'Computer', icon: 'computer', service: 'computer', profile: 'hosting', tagline: 'A computer for you, your AI, or both', what: 'Start and manage computer sessions over OpenVibe.Run, with your own Link machines and cloud computers in one place.', host: 'openvibe.computer' };
const RAW_SITES = contracts.services.manifests.filter((m) => m.site && !HIDDEN_SITES.has(m.id)).sort((a, b) => (a.site.position ?? 999) - (b.site.position ?? 999)).map((m) => ({
    id: m.site.icon, name: m.site.name, icon: m.site.icon, service: m.id, profile: m.site.legalProfile, tagline: m.site.tagline, what: m.site.what,
    // A site's own footer-strip items (label, icon, link, and a number or a line), at most three. They are
    // validated again at the read (server/frame/service.js stripOf): text only, an https link on an OpenVibe domain.
    ...(Array.isArray(m.site.strip) ? { strip: m.site.strip } : {}),
    ...(m.site.host ? { host: m.site.host } : {}),
})).concat(contracts.services.get('computer') ? [] : [COMPUTER_FALLBACK]);
function manifestHost(service) {
    const m = contracts.services.get(service);
    try { return m && m.publicOrigin ? new URL(m.publicOrigin).hostname : null; } catch { return null; }
}
// Play is the game-services API behind OpenVibe.Games, not a destination of its own: its pages moved to
// openvibe.games (achievements, leaderboards, developers) and the menu lists Games once. The service stays live and
// exposed in the registry (so a game can still call it); the frame, footer, home, llms.txt and JSON-LD drop the entry.
// The owner, 2026-11-08: "it should just be part of openvibe.games".
const HIDDEN_SITE = new Set(['play']);
const ALL_SITES = RAW_SITES.map((s) => {
    const e = exposureOf(s.service);
    const host = manifestHost(s.service) || s.host;
    if (!host) throw new Error(`site ${s.id}: no host (its manifest has no publicOrigin and the entry names none)`);
    return { ...s, host, ...(s.service === 'inventory' ? { url: 'https://openvibe.my/inventory' } : {}),
        // The navigation moves first; the service/API manifest keeps its working Website origin during rollout.
        ...(s.service === 'connect' ? { url: 'https://connect.openvibe.link/' } : {}), status: e.state === 'live' && e.public_site === 'service' ? 'open' : 'soon', state: e.state };
});
// The menu, footer, home and llms.txt list SITES; siteForHost still knows Play so a Play-host page (or a token
// consent screen) keeps its own name, without the site being offered as a destination.
const SITES = ALL_SITES.filter((s) => !HIDDEN_SITE.has(s.id));
const byHost = new Map(ALL_SITES.map(s => [s.host, s]));
// Connect lives on connect.openvibe.link (its manifest since Contracts 0.348.0); the old Website name still answers
// (page loads 302 to Link), so both hosts name Connect.
for (const h of ['connect.openvibe.link', 'connect.openvibe.website']) byHost.set(h, ALL_SITES.find(s => s.service === 'connect'));

/** A site's full name: its own when it is a brand already (OpenRestream), otherwise OpenVibe.<name> (OpenVibe.Live).
 *  "OpenVibe.OpenRestream" read wrong on the home page's cards (the owner, 2026-10-28). */
const fullName = (s) => (/^Open[A-Z]/.test(String(s && s.name)) ? s.name : `OpenVibe.${s && s.name}`);

// The launcher (openvibe-shared navbar) lists every open site under one of these groups, most used first within
// each. A site missing here lands in the last group, so a new manifest is never left out of the menu.
// The owner's regrouping (2026-11-10, plan ask 274): eight groups named for what a person came to do, in the order
// the menu, its folders, the footer and the home pages show them. Seven tiles a group, but Compare (Contracts 0.408.0)
// joined Read & ask as its eighth on 2026-11-11 while the owner's next regrouping decides; Video's two domains
// (Pics, Download) are list entries of their own, while Media, Homes and Bench are sections of Video, Rent and
// Report and keep their domains without a tile. Contracts' `site.neighbourhood` repeats these ids for every site.
const GROUPS = [
    { id: 'watch', name: 'Watch & stream', sites: ['live', 'media-hub', 'pics', 'download', 'stream', 'cam', 'tours'] },
    { id: 'talk', name: 'Talk & belong', sites: ['community', 'chat', 'tips', 'vip', 'mail', 'help', 'network'] },
    { id: 'play', name: 'Play', sites: ['games', 'quest', 'surf', 'fun', 'meme', 'casino', 'inventory'] },
    { id: 'read', name: 'Read & ask', sites: ['news', 'today', 'report', 'search', 'wiki', 'blog', 'vision', 'compare'] },
    { id: 'shop', name: 'Shop & money', sites: ['deals', 'coupons', 'shoes', 'reviews', 'trade', 'rent', 'work'] },
    { id: 'tools', name: 'Free tools', sites: ['tools', 'design', 'domains', 'host', 'image', 'lock', 'food'] },
    // Actor is the engine behind every agent (Codes' Auto, Vibe, the Dock call it): a developer service, not a second
    // place to chat with an agent (plan L39, 2026-10-31). It makes things with AI, beside the places that do.
    { id: 'make', name: 'Make with AI', sites: ['space', 'codes', 'bot', 'actor', 'computer', 'connect', 'directory'] },
    { id: 'build', name: 'For developers', sites: ['services', 'exchange', 'run', 'zone', 'events', 'watch', 'git'] },
];
// What each site is, in a few words, for the menus (the launcher's rows are two to a line on a phone: about 22
// characters fit). The manifests' taglines stay the sites' own sentences everywhere else; a site missing here shows
// its tagline.
const MENU_LINE = {
    live: 'Go live, watch streams', 'media-hub': 'Clips and past streams', stream: 'Stream everywhere', pics: 'Share pictures',
    download: 'Your files', cam: 'Your camera, in private', tours: 'Cities, routes, stays',
    community: 'Posts and pastes', chat: 'Chat with anyone', tips: 'Support streamers', vip: 'Back your creators', mail: 'Masks and inboxes', help: 'Help nearby', network: 'Your account',
    games: 'Play in your browser', quest: 'Earn badges', surf: 'Surf maps and the web', fun: 'Something to do', meme: 'Memes with receipts', casino: 'Odds shown, chips free', inventory: 'Your items',
    news: 'Sourced, not spun', today: 'Your schedule', report: 'Your numbers, honest', search: 'Search everything', wiki: 'Facts with sources', blog: 'Write long-form', vision: 'Ask a picture', compare: 'Weigh your options',
    deals: 'Deals people share', coupons: 'Codes that work', shoes: 'Every shoe, every price', reviews: 'Honest reviews', trade: 'Watch the markets', rent: 'Places to rent', work: 'Find a job',
    tools: 'Every online tool', design: 'Try themes live', domains: 'Names and prices', host: 'Compare hosting', image: 'Edit photos in your browser', lock: 'Files only you can open', food: 'Food near you',
    space: 'Host a site or app', codes: 'Code with any agent', bot: 'Drive a robot', actor: 'The agent engine', computer: 'Your computer, your way', connect: 'Share a port with Link', directory: 'Listings with sources',
    services: 'APIs, SDK and keys', exchange: 'AI models, one account', run: 'Run jobs anywhere', zone: 'S3 storage', events: 'Event streams', watch: 'Know when it changes', git: 'Host and browse code',
};

// A site's name in the menus, where the rows are short words (Pics, Download, VIP, Tips): the product keeps its full name
// everywhere else (its own site, page titles, sign-in). The owner, 2026-10-28: "label it simply Restream… it does look
// a little weird" next to the others.
const MENU_NAME = { stream: 'Restream' };

const groupOf = (id) => (GROUPS.find(g => g.sites.includes(id)) || GROUPS[GROUPS.length - 1]).id;

// Sites whose own domain keeps answering but that are a section of another site: in the menu, the footer, the home
// pages and /sites they are not a tile of their own (owner, 2026-11-10). siteForHost still knows them.
//   media → Video (openvibe.media stays the API and the embed host)
const MERGED_SITES = new Map([['media', 'media-hub']]);

// Products with a domain of their own that another service serves (its manifest lists the domain): in the menu
// while that service's site is open, right after it. They are not sites of their own (no ranking, no legal profile),
// but they are list entries: Pics and Download are what Video's drive shows on their own domains (owner, 2026-11-10).
const PRODUCTS = [
    { id: 'pics', name: 'Pics', host: 'openvibe.pics', icon: 'pics', of: 'media-hub', tagline: 'Share pictures, fast and open' },
    { id: 'download', name: 'Download', host: 'openvibe.download', icon: 'download', of: 'media-hub', tagline: 'Your files, shared on your terms' },
].filter((p) => {
    const s = SITES.find(x => x.id === p.of); const m = s && contracts.services.get(s.service);
    return m && (m.domains || []).includes(p.host);
});
// Domains of a merged section (no tile): Homes is Rent's for-sale search, Bench is Report's AI section (its host
// already redirects). They stay in the host map so a page or a sign-in return keeps naming its own place.
const MERGED_PRODUCTS = [
    { id: 'homes', name: 'Homes', host: 'openvibe.homes', icon: 'homes', of: 'rent' },
    { id: 'bench', name: 'AI', host: 'bench.openvibe.services', icon: 'bench', of: 'report' },
];

// The list the menu, the footer, the home pages and /sites show: every site except a merged section, plus the
// products above with a domain of their own (Pics, Download). Open sites in this list today: 55.
const LISTED_SITES = SITES.filter((s) => !MERGED_SITES.has(s.id));
const listed = (p) => {
    const owner = SITES.find((s) => s.id === p.of);
    return { ...p, service: p.of, what: p.tagline, status: owner ? owner.status : 'soon', state: owner ? owner.state : 'placeholder' };
};
const LISTED = LISTED_SITES.concat(PRODUCTS.map(listed));
// Manifest icon names the shared icon set draws differently.
const ICON_ALIAS = { 'media-hub': 'video' };

/** The site a hostname belongs to (subdomains included), or null. */
function siteForHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    // User-run shares are never an OpenVibe frame destination.
    if (/--[^.]+\.openvibe\.(?:link|website)$/.test(h)) return null;
    if (byHost.has(h)) return byHost.get(h);
    // A product on its own domain belongs to the site that serves it (Bench's host is Report's AI section now).
    // Before the subdomain pass, because services.openvibe.services would otherwise claim bench.openvibe.services.
    const product = PRODUCTS.concat(MERGED_PRODUCTS).find((p) => p.host === h || h.endsWith('.' + p.host));
    if (product) return SITES.find((s) => s.id === product.of) || null;
    for (const s of SITES) if (h.endsWith('.' + s.host)) return s;
    return null;
}

module.exports = { SITES, LISTED_SITES, LISTED, siteForHost, GROUPS, groupOf, PRODUCTS, MERGED_SITES, MERGED_PRODUCTS, ICON_ALIAS, MENU_LINE, MENU_NAME, fullName };
