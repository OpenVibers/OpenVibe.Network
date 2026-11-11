'use strict';
/**
 * The origins a browser may use Network's passkeys from (WebAuthn Related Origin Requests,
 * https://openvibe.network/.well-known/webauthn). The list is generated from the service manifests:
 * a service that declares a public UI origin is an operator-owned product origin. Infrastructure
 * hosts (api., auth., ingest., s3., themes.) and the staff aliases are not public UI origins, and a
 * customer-controlled subdomain (a Website or Host tenant) is never added: the manifests carry the
 * product's own host, not its tenants. A small reviewed alias list adds the operator-owned UI hosts
 * that are product aliases rather than a manifest's publicOrigin.
 *
 * The rpID is openvibe.network and the credential store is unchanged. Listing an origin only lets a
 * browser run a ceremony there; the Network still verifies the exact origin and the OAuth client's
 * registered redirect origin before it issues or accepts a challenge.
 */
const contracts = require('openvibe-contracts');

// Operator-owned UI aliases that are not a manifest publicOrigin (reviewed 2026-11-11).
const ALIASES = Object.freeze([
    'https://openvibe.my',       // Inventory's mounted account pages
    'https://openvibe.link',     // Link's account pages
    'https://openvibe.party',    // Chat's party rooms
    'https://openvibe.download', // Media Hub's download site
    'https://openvibe.pics',     // Media Hub's pictures site
    'https://openvibe.homes',    // Rent's homes site
]);
const TENANT_SUFFIX = '.openvibe.website';
let cached = null;

function originOf(value) {
    let u;
    try { u = new URL(String(value || '')); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
    if (u.port && u.port !== '443') return null;
    return `https://${u.hostname}`;
}

function generatedOrigins(manifests) {
    const out = new Set();
    for (const m of manifests || []) {
        const exposure = (m && m.exposure) || {};
        if (exposure.state !== 'live' || exposure.publicSite !== 'service') continue;
        const origin = originOf(m.publicOrigin);
        if (!origin) continue;
        const host = new URL(origin).hostname;
        // Customer sites on the Website product are subdomains, and its own apex is cookie-free tenant content.
        if (host === 'openvibe.website' || host.endsWith(TENANT_SUFFIX)) continue;
        out.add(origin);
    }
    for (const alias of ALIASES) out.add(alias);
    return [...out].sort();
}

/** Every exact https origin allowed to run a Network passkey ceremony. Frozen for the process. */
function origins() {
    if (!cached) cached = Object.freeze(generatedOrigins(contracts.services && contracts.services.manifests));
    return cached;
}

function isApprovedOrigin(origin) {
    return typeof origin === 'string' && origins().includes(origin);
}

module.exports = { origins, isApprovedOrigin, originOf, generatedOrigins };
