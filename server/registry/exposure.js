'use strict';
/**
 * Where each OpenVibe service can actually be reached — Network's own, observed overlay on the
 * openvibe-contracts manifests.
 *
 * A manifest's `status` (alpha, beta, stable, placeholder) is maturity, and its `publicOrigin` is where
 * the service is meant to answer. Neither says whether that public domain serves the service today:
 * on 2026-09-23 openvibe.news, .reviews, .deals, .coupons, .trade, .host, .tips, .vip and openre.stream
 * served the OpenVibe.Sites "coming soon" placeholder, search. and sources.openvibe.network served the
 * admin placeholder, while each of those services ran on this host's loopback only. (Until
 * openvibe-contracts 0.30 the AI, SDK, Shared and Examples manifests said placeholder although all four
 * existed; since 0.30 they are alpha, and this overlay says how each one exists: AI runs on loopback,
 * SDK and Shared are released libraries, Examples is a repository.)
 *
 * Every manifest id has exactly one state here (test/registry-exposure.test.js pins them):
 *
 *   live         live (public)          its public domain serves the service itself
 *   internal     internal               runs on loopback only; no public site yet (the domain, if any,
 *                                       still serves a placeholder page)
 *   library      library (released)     a package other code installs; nothing to run
 *   repository   repository             code with CI, neither released nor run (examples)
 *   placeholder  placeholder (planned)  charter only; nothing runs
 *
 * When a service goes public, change its row here in the same commit that points its domain at it,
 * after checking the domain no longer answers with "this page is a placeholder".
 */

const STATES = ['live', 'internal', 'library', 'repository', 'placeholder'];
const LABEL = {
    live: 'live (public)',
    internal: 'internal (loopback only, no public site yet)',
    library: 'library (released)',
    repository: 'repository (code with CI, nothing released or running)',
    placeholder: 'placeholder (planned)',
};

// public_site: what the service's public domain(s) answer today — 'service' (the service itself),
// 'placeholder' (a Sites/admin placeholder page) or null (no public domain).
const SITE_PLACEHOLDER = 'the domain serves the OpenVibe.Sites placeholder page';
const ADMIN_PLACEHOLDER = 'the domain serves the admin.openvibe.network placeholder page';
const EXPOSURE = {
    network: { state: 'live', public_site: 'service' },
    live: { state: 'live', public_site: 'service' },
    tools: { state: 'live', public_site: 'service' },
    media: { state: 'live', public_site: 'service' },
    games: { state: 'live', public_site: 'service' },
    community: { state: 'live', public_site: 'service' },
    events: { state: 'live', public_site: 'service' },
    billing: { state: 'live', public_site: 'service', note: 'the public domain is the staff console; accounts pay through each product' },
    codes: { state: 'live', public_site: 'service' },
    blog: { state: 'live', public_site: 'service' },
    wiki: { state: 'live', public_site: 'service' },
    sites: { state: 'live', public_site: 'service', note: 'serves the placeholder pages of domains whose service is not public yet' },

    news: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER },
    reviews: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER },
    deals: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER },
    coupons: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER },
    trade: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER },
    host: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER },
    tips: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER },
    vip: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER },
    openre: { state: 'internal', public_site: 'placeholder', note: SITE_PLACEHOLDER },
    search: { state: 'live', public_site: 'service', note: 'public search page and query API at search.openvibe.network (since 2026-09-23)' },
    sources: { state: 'internal', public_site: null, note: 'internal ingestion service; sources.openvibe.network says so (its API is loopback-only)' },
    chat: { state: 'internal', public_site: null, note: 'serves Live\'s chat through Live; openvibe.chat serves the OpenVibe.Sites placeholder page' },
    ai: { state: 'internal', public_site: null, note: 'called by other services at 127.0.0.1:4700; ai.openvibe.network serves the OpenVibe.Sites placeholder page' },

    sdk: { state: 'library', public_site: null, package: 'openvibe-sdk', release: 'v0.4.0', distribution: 'https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v0.4.0' },
    shared: { state: 'library', public_site: null, package: 'openvibe-shared', release: 'v1.3.0', distribution: 'https://codeload.github.com/OpenVibers/OpenVibe.Shared/tar.gz/refs/tags/v1.3.0', note: 'also served at /shared/* by each site' },
    contracts: { state: 'library', public_site: null, package: 'openvibe-contracts', release: 'v0.30.1', distribution: 'https://codeload.github.com/OpenVibers/OpenVibe.Contracts/tar.gz/refs/tags/v0.30.1', note: 'schemas are also served by this registry at their $id URLs' },
    examples: { state: 'repository', public_site: null, note: 'example apps with CI in OpenVibers/OpenVibe.Examples; not published as a package' },

    realtime: { state: 'placeholder', public_site: null },
};

/** The exposure of one service id; an id nobody classified is 'unknown', never assumed public. */
function exposureOf(id) {
    const e = EXPOSURE[id];
    if (!e) return { state: 'unknown', label: 'unknown (not classified by Network)', public_site: null, note: null };
    return { state: e.state, label: LABEL[e.state], public_site: e.public_site, note: e.note || null, ...(e.release ? { package: e.package || null, release: e.release, distribution: e.distribution || null } : {}) };
}

/** A manifest's public origin only when its domain serves the service itself. */
function publicOriginOf(m) {
    const e = EXPOSURE[m.id];
    return e && e.state === 'live' && e.public_site === 'service' ? m.publicOrigin || null : null;
}

/** The released libraries (sdk, shared, contracts): { id, package, release, distribution }. */
function libraries() {
    return Object.entries(EXPOSURE).filter(([, e]) => e.state === 'library').map(([id, e]) => ({ id, package: e.package, release: e.release, distribution: e.distribution || null }));
}

module.exports = { STATES, LABEL, EXPOSURE, exposureOf, publicOriginOf, libraries };
