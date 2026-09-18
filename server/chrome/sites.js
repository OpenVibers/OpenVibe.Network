'use strict';
// Every OpenVibe property: what it is, whether it is open, and which legal documents apply.
//   legal.profile decides the wording of /terms, /privacy and /dmca on that site (openvibe-shared/legal):
//     streaming  user video + chat + payments        tools   files processed and discarded
//     ugc        user posts/pastes                    games   accounts + game state
//     hosting    stored user media                    account identity provider
//     info       read-only placeholder/editorial site
const SITES = [
    { id: 'live', name: 'Live', host: 'openvibe.live', icon: 'live', status: 'open', service: 'live', profile: 'streaming', tagline: 'Streams, clips and chat', what: 'Live streaming from a browser, OBS or a phone, with restreaming, clips, VODs, chat games and channel points.' },
    { id: 'tools', name: 'Tools', host: 'openvibe.tools', icon: 'tools', status: 'open', service: 'tools', profile: 'tools', tagline: 'Every online tool', what: 'More than 160 online tools: converters, downloaders, PDF and image tools, developer utilities and network diagnostics, each on its own address.' },
    { id: 'community', name: 'Community', host: 'openvibe.community', icon: 'community', status: 'open', service: 'community', profile: 'ugc', tagline: 'Pastes and posts', what: 'Share text and code with a link, comment, and follow what people on OpenVibe are making.' },
    { id: 'games', name: 'Games', host: 'openvibe.games', icon: 'games', status: 'open', service: 'games', profile: 'games', tagline: 'Browser games', what: 'Scraplandia, a shared pixel canvas and other games that run in a tab and know your OpenVibe account.' },
    { id: 'media', name: 'Media', host: 'openvibe.media', icon: 'media', status: 'open', service: 'media', profile: 'hosting', tagline: 'VODs, clips, files', what: 'The public media library behind every site: recorded streams, clips, images and uploads.' },
    { id: 'network', name: 'Network', host: 'openvibe.network', icon: 'network', status: 'open', service: 'network', profile: 'account', tagline: 'Account and themes', what: 'The account behind every site: one sign-in, themes, notifications, history and linked services.' },
    { id: 'chat', name: 'Chat', host: 'openvibe.chat', icon: 'chat', status: 'soon', profile: 'ugc', tagline: 'Rooms and direct messages', what: 'Community chat rooms and direct messages across the network.' },
    { id: 'codes', name: 'Codes', host: 'openvibe.codes', icon: 'codes', status: 'soon', profile: 'ugc', tagline: 'Snippets and open source', what: 'Code snippets, gists and the source of OpenVibe itself.' },
    { id: 'blog', name: 'Blog', host: 'openvibe.blog', icon: 'blog', status: 'soon', profile: 'info', tagline: 'Updates from the builders', what: 'Release notes and stories from the people building OpenVibe.' },
    { id: 'wiki', name: 'Wiki', host: 'openvibe.wiki', icon: 'wiki', status: 'soon', profile: 'ugc', tagline: 'Guides and how-tos', what: 'Guides for streaming, tools and everything else on the network.' },
    { id: 'news', name: 'News', host: 'openvibe.news', icon: 'news', status: 'soon', profile: 'info', tagline: 'What is happening', what: 'News from the network and the communities on it.' },
    { id: 'reviews', name: 'Reviews', host: 'openvibe.reviews', icon: 'reviews', status: 'soon', profile: 'ugc', tagline: 'Honest reviews', what: 'Community reviews of gear, software and services.' },
    { id: 'tips', name: 'Tips', host: 'openvibe.tips', icon: 'tips', status: 'soon', profile: 'streaming', tagline: 'Support creators', what: 'Send support to the streamers and makers you like.' },
    { id: 'vip', name: 'VIP', host: 'openvibe.vip', icon: 'vip', status: 'soon', profile: 'account', tagline: 'Supporter perks', what: 'Perks for people who support the network.' },
    { id: 'trade', name: 'Trade', host: 'openvibe.trade', icon: 'trade', status: 'soon', profile: 'ugc', tagline: 'Swap and sell', what: 'A community marketplace for trades and sales.' },
    { id: 'host', name: 'Host', host: 'openvibe.host', icon: 'host', status: 'soon', profile: 'hosting', tagline: 'Hosting for projects', what: 'Simple hosting for community projects.' },
    { id: 'deals', name: 'Deals', host: 'openvibe.deals', icon: 'deals', status: 'soon', profile: 'info', tagline: 'Deals worth sharing', what: 'Deals found and vetted by the community.' },
    { id: 'coupons', name: 'Coupons', host: 'openvibe.coupons', icon: 'coupons', status: 'soon', profile: 'info', tagline: 'Codes that work', what: 'Coupon codes checked by real people.' },
    { id: 'stream', name: 'OpenRe.Stream', host: 'openre.stream', icon: 'stream', status: 'soon', profile: 'streaming', tagline: 'Restream anywhere', what: 'Send one stream to every platform at once.' },
];
const byHost = new Map(SITES.map(s => [s.host, s]));

/** The site a hostname belongs to (subdomains included), or null. */
function siteForHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    if (byHost.has(h)) return byHost.get(h);
    for (const s of SITES) if (h.endsWith('.' + s.host)) return s;
    return null;
}

module.exports = { SITES, siteForHost };
