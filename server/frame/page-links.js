'use strict';
// The page list each host gives the shared navbar's "Pages on <site>" menu. Every page of a host sends the same
// list, and each row is a page of that host or a door named for where it goes (the owner, 2026-11-12:
// "Pages on OpenVibe.Link: Home, My Account, Themes" was Network's list on Link's menu, not Link's).
//
// Network serves four hosts. openvibe.network, openvibe.link and openvibe.my read these lists here; Computer has
// its own server. A page that passes no links gets the shared navbar's fallback (Home, My Account, Themes), which
// is why every Network page passes the host's list explicitly.
const NETWORK = Object.freeze([
    { label: 'Network', href: '/' },
    { label: 'Link', href: 'https://openvibe.link/', icon: 'fa-desktop', featured: true },
    { label: 'My Account', href: 'https://openvibe.my/' },
    { label: 'Wallet', href: '/wallet' },
    { label: 'Themes', href: '/themes' },
]);

const LINK = Object.freeze([
    { label: 'Link', href: '/', icon: 'fa-desktop', featured: true },
    { label: 'Machines', href: '/machines', icon: 'fa-laptop' },
    { label: 'Network', href: 'https://openvibe.network/' },
    { label: 'My Account', href: 'https://openvibe.my/' },
]);

const MY = Object.freeze([
    { label: 'My Account', href: '/' },
    { label: 'Profile', href: '/profile' },
    { label: 'Themes', href: '/themes' },
    { label: 'Security', href: '/security' },
]);

const HOSTS = new Set(['openvibe.network', 'www.openvibe.network', 'openvibe.link', 'www.openvibe.link', 'openvibe.my', 'www.openvibe.my']);

/** This request's host, lowercased, no port, no www. */
function hostOf(req) {
    return String((req && (req.hostname || (req.headers && req.headers.host))) || '').split(':')[0].toLowerCase().replace(/^www\./, '');
}

/** The page list of the host Network is answering: Link and My have their own; everything else is Network's. */
function forHost(host) {
    const h = String(host || '').split(':')[0].toLowerCase().replace(/^www\./, '');
    if (h === 'openvibe.link') return LINK;
    if (h === 'openvibe.my') return MY;
    return NETWORK;
}

/** A JS expression for a page that is cached across hosts: the same choice, made in the browser. */
function browserList() {
    const host = "location.hostname.replace(/^www\\./, '')";
    return `(${host} === 'openvibe.link' ? ${JSON.stringify(LINK)} : ${host} === 'openvibe.my' ? ${JSON.stringify(MY)} : ${JSON.stringify(NETWORK)})`;
}

module.exports = { NETWORK, LINK, MY, HOSTS, hostOf, forHost, browserList };
