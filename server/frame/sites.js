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
// host comes from the service's manifest (openvibe-contracts publicOrigin); an entry names its host only
// while its manifest has no public origin. TODO(plan §5.1/§5.3): name, icon, tagline, what and the
// legal profile are presentation with no manifest field yet; they move when the manifest schema has them.
const RAW_SITES = [
    { id: 'live', name: 'Live', icon: 'live', service: 'live', profile: 'streaming', tagline: 'Streams, clips and chat', what: 'Live streaming from a browser, OBS or a phone, with restreaming, clips, VODs, chat games and channel points.' },
    { id: 'tools', name: 'Tools', icon: 'tools', service: 'tools', profile: 'tools', tagline: 'Every online tool', what: 'More than 160 online tools: converters, downloaders, PDF and image tools, developer utilities and network diagnostics, each on its own address.' },
    { id: 'community', name: 'Community', icon: 'community', service: 'community', profile: 'ugc', tagline: 'Pastes and posts', what: 'Share text and code with a link, comment, and follow what people on OpenVibe are making.' },
    { id: 'games', name: 'Games', icon: 'games', service: 'games', profile: 'games', tagline: 'Browser games', what: 'Scraplandia, a shared pixel canvas and other games that run in a tab and know your OpenVibe account.' },
    { id: 'media', name: 'Media', icon: 'media', service: 'media', profile: 'hosting', tagline: 'VODs, clips, files', what: 'The public media library behind every site: recorded streams, clips, images and uploads.' },
    { id: 'network', name: 'Network', icon: 'network', service: 'network', profile: 'account', tagline: 'Account and themes', what: 'The account behind every site: one sign-in, themes, notifications, history and linked services.' },
    { id: 'chat', name: 'Chat', icon: 'chat', service: 'chat', profile: 'ugc', tagline: 'One chat for the network', what: 'Rooms, stream chat, direct messages, calls and text-to-speech under one identity.' },
    { id: 'codes', name: 'Codes', icon: 'codes', service: 'codes', profile: 'ugc', tagline: 'Build on OpenVibe', what: 'The developer portal: API and SDK docs, the service and capability registry, event schemas, credentials, playgrounds and mod publishing.' },
    { id: 'blog', name: 'Blog', icon: 'blog', service: 'blog', profile: 'info', tagline: 'Long-form, yours to keep', what: 'The official OpenVibe blog and a blog for every member: drafts, scheduling, media, comments and feeds.' },
    { id: 'wiki', name: 'Wiki', icon: 'wiki', service: 'wiki', profile: 'ugc', tagline: 'Knowledge, with sources', what: 'Wiki spaces with page trees, revision history, citations and discussion, editable together.' },
    { id: 'news', name: 'News', icon: 'news', service: 'news', profile: 'info', tagline: 'Sourced, not spun', what: 'Source-backed stories: clustered coverage, cited summaries, multiple perspectives and timelines.' },
    { id: 'reviews', name: 'Reviews', icon: 'reviews', service: 'reviews', profile: 'ugc', tagline: 'Reviews with receipts', what: 'Review signals gathered across sources with provenance, pros and cons, and community discussion. No invented ratings.' },
    { id: 'tips', name: 'Tips', icon: 'tips', service: 'tips', profile: 'streaming', tagline: 'Support creators', what: 'Tips, goals, paid messages and alerts for creators, settled by the network\'s billing ledger.' },
    { id: 'vip', name: 'VIP', icon: 'vip', service: 'vip', profile: 'account', tagline: 'Memberships and perks', what: 'Creator and network memberships: plans, perks and benefits recognised on every OpenVibe site.' },
    { id: 'trade', name: 'Trade', icon: 'trade', service: 'trade', profile: 'ugc', tagline: 'Watchlists and alerts', what: 'Informational watchlists, sourced market context and alerts. No custody, no order execution.' },
    { id: 'host', name: 'Host', icon: 'host', service: 'host', profile: 'hosting', tagline: 'Deploy and host', what: 'The network\'s deployment plane first, then simple hosting for community sites, bots and mods.' },
    { id: 'deals', name: 'Deals', icon: 'deals', service: 'deals', profile: 'info', tagline: 'Deals worth sharing', what: 'Deals submitted and voted on by the community, with source, price and freshness always shown.' },
    { id: 'coupons', name: 'Coupons', icon: 'coupons', service: 'coupons', profile: 'info', tagline: 'Codes that work', what: 'Coupon codes with merchant matching, restrictions, expiry and real-people validity reports.' },
    { id: 'stream', name: 'OpenRe.Stream', icon: 'stream', service: 'openre', profile: 'streaming', tagline: 'Restream anywhere', what: 'Ingest once and send the stream to every platform at once; keys, destinations and output health in one place.' },
];
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

/** The site a hostname belongs to (subdomains included), or null. */
function siteForHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    if (byHost.has(h)) return byHost.get(h);
    for (const s of SITES) if (h.endsWith('.' + s.host)) return s;
    return null;
}

module.exports = { SITES, siteForHost };
