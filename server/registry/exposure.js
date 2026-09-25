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
 *
 * Since openvibe-contracts 0.42.0 (WS-C task 1) the states are the manifests' `exposure`: a service going
 * public is one manifest edit in Contracts (in the release that points its domain at it), no Network code.
 */

const contracts = require('openvibe-contracts');

const STATES = ['live', 'internal', 'library', 'repository', 'placeholder', 'retired'];
const LABEL = {
    live: 'live (public)',
    internal: 'internal (loopback only, no public site yet)',
    library: 'library (released)',
    repository: 'repository (code with CI, nothing released or running)',
    placeholder: 'placeholder (planned)',
    retired: 'retired',
};

// The libraries' release starts as the version Network itself installs (its pins move with every release)
// and becomes the latest published tag once library-tags.js has one (setLibraryReleases).
function libraryRelease(pkg, repo) {
    let version = null;
    try { version = require(`${pkg}/package.json`).version; } catch { /* not installed */ }
    const release = version ? `v${version}` : null;
    return { release, distribution: release && repo ? `https://codeload.github.com/OpenVibers/${repo}/tar.gz/refs/tags/${release}` : null };
}

/**
 * Each manifest's `exposure` (openvibe-contracts ≥ 0.42.0, WS-C task 1): { state, public_site, note } plus,
 * for libraries, package / release / distribution. A service going public is a manifest change in Contracts.
 */
const EXPOSURE = Object.fromEntries(contracts.services.manifests.filter((m) => m.exposure && STATES.includes(m.exposure.state)).map((m) => {
    const e = { state: m.exposure.state, public_site: m.exposure.publicSite == null ? null : m.exposure.publicSite };
    if (m.exposure.note) e.note = m.exposure.note;
    if (e.state === 'library') Object.assign(e, { package: m.exposure.package, ...libraryRelease(m.exposure.package, m.exposure.repo) });
    return [m.id, e];
}));

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

/**
 * The latest published tags (server/registry/library-tags.js) replace the installed versions once
 * known: { 'openvibe-sdk': 'v0.8.0', … }. Unknown packages keep the installed version.
 */
function setLibraryReleases(tags) {
    for (const e of Object.values(EXPOSURE)) {
        if (e.state !== 'library' || !e.package || !tags || !tags[e.package]) continue;
        const repo = e.distribution ? e.distribution.split('/')[4] : null;
        e.release = tags[e.package];
        if (repo) e.distribution = `https://codeload.github.com/OpenVibers/${repo}/tar.gz/refs/tags/${e.release}`;
    }
}

/** The released libraries (sdk, shared, contracts): { id, package, release, distribution }. */
function libraries() {
    return Object.entries(EXPOSURE).filter(([, e]) => e.state === 'library').map(([id, e]) => ({ id, package: e.package, release: e.release, distribution: e.distribution || null }));
}

module.exports = { STATES, LABEL, EXPOSURE, exposureOf, publicOriginOf, libraries, setLibraryReleases };
