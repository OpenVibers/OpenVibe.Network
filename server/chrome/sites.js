'use strict';
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
const RAW_SITES = [
    { id: 'live', name: 'Live', host: 'openvibe.live', icon: 'live', service: 'live', profile: 'streaming', tagline: 'Streams, clips and chat', what: 'Live streaming from a browser, OBS or a phone, with restreaming, clips, VODs, chat games and channel points.' },
    { id: 'tools', name: 'Tools', host: 'openvibe.tools', icon: 'tools', service: 'tools', profile: 'tools', tagline: 'Every online tool', what: 'More than 160 online tools: converters, downloaders, PDF and image tools, developer utilities and network diagnostics, each on its own address.' },
    { id: 'community', name: 'Community', host: 'openvibe.community', icon: 'community', service: 'community', profile: 'ugc', tagline: 'Pastes and posts', what: 'Share text and code with a link, comment, and follow what people on OpenVibe are making.' },
    { id: 'games', name: 'Games', host: 'openvibe.games', icon: 'games', service: 'games', profile: 'games', tagline: 'Browser games', what: 'Scraplandia, a shared pixel canvas and other games that run in a tab and know your OpenVibe account.' },
    { id: 'media', name: 'Media', host: 'openvibe.media', icon: 'media', service: 'media', profile: 'hosting', tagline: 'VODs, clips, files', what: 'The public media library behind every site: recorded streams, clips, images and uploads.' },
    { id: 'network', name: 'Network', host: 'openvibe.network', icon: 'network', service: 'network', profile: 'account', tagline: 'Account and themes', what: 'The account behind every site: one sign-in, themes, notifications, history and linked services.' },
    { id: 'chat', name: 'Chat', host: 'openvibe.chat', icon: 'chat', service: 'chat', profile: 'ugc', tagline: 'One chat for the network', what: 'Rooms, stream chat, direct messages, calls and text-to-speech under one identity.' },
    { id: 'codes', name: 'Codes', host: 'openvibe.codes', icon: 'codes', service: 'codes', profile: 'ugc', tagline: 'Build on OpenVibe', what: 'The developer portal: API and SDK docs, the service and capability registry, event schemas, credentials, playgrounds and mod publishing.' },
    { id: 'blog', name: 'Blog', host: 'openvibe.blog', icon: 'blog', service: 'blog', profile: 'info', tagline: 'Long-form, yours to keep', what: 'The official OpenVibe blog and a blog for every member: drafts, scheduling, media, comments and feeds.' },
    { id: 'wiki', name: 'Wiki', host: 'openvibe.wiki', icon: 'wiki', service: 'wiki', profile: 'ugc', tagline: 'Knowledge, with sources', what: 'Wiki spaces with page trees, revision history, citations and discussion, editable together.' },
    { id: 'news', name: 'News', host: 'openvibe.news', icon: 'news', service: 'news', profile: 'info', tagline: 'Sourced, not spun', what: 'Source-backed stories: clustered coverage, cited summaries, multiple perspectives and timelines.' },
    { id: 'reviews', name: 'Reviews', host: 'openvibe.reviews', icon: 'reviews', service: 'reviews', profile: 'ugc', tagline: 'Reviews with receipts', what: 'Review signals gathered across sources with provenance, pros and cons, and community discussion. No invented ratings.' },
    { id: 'tips', name: 'Tips', host: 'openvibe.tips', icon: 'tips', service: 'tips', profile: 'streaming', tagline: 'Support creators', what: 'Tips, goals, paid messages and alerts for creators, settled by the network\'s billing ledger.' },
    { id: 'vip', name: 'VIP', host: 'openvibe.vip', icon: 'vip', service: 'vip', profile: 'account', tagline: 'Memberships and perks', what: 'Creator and network memberships: plans, perks and benefits recognised on every OpenVibe site.' },
    { id: 'trade', name: 'Trade', host: 'openvibe.trade', icon: 'trade', service: 'trade', profile: 'ugc', tagline: 'Watchlists and alerts', what: 'Informational watchlists, sourced market context and alerts. No custody, no order execution.' },
    { id: 'host', name: 'Host', host: 'openvibe.host', icon: 'host', service: 'host', profile: 'hosting', tagline: 'Deploy and host', what: 'The network\'s deployment plane first, then simple hosting for community sites, bots and mods.' },
    { id: 'deals', name: 'Deals', host: 'openvibe.deals', icon: 'deals', service: 'deals', profile: 'info', tagline: 'Deals worth sharing', what: 'Deals submitted and voted on by the community, with source, price and freshness always shown.' },
    { id: 'coupons', name: 'Coupons', host: 'openvibe.coupons', icon: 'coupons', service: 'coupons', profile: 'info', tagline: 'Codes that work', what: 'Coupon codes with merchant matching, restrictions, expiry and real-people validity reports.' },
    { id: 'stream', name: 'OpenRe.Stream', host: 'openre.stream', icon: 'stream', service: 'openre', profile: 'streaming', tagline: 'Restream anywhere', what: 'Ingest once and send the stream to every platform at once; keys, destinations and output health in one place.' },
];
const SITES = RAW_SITES.map((s) => {
    const e = exposureOf(s.service);
    return { ...s, status: e.state === 'live' && e.public_site === 'service' ? 'open' : 'soon', state: e.state };
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
