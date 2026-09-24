'use strict';
/**
 * Every first-party origin the service manifests declare (openvibe-contracts manifests/services/*.json
 * `domains`): openvibe.blog, openvibe.wiki, openvibe.codes, search.openvibe.network, … The CORS
 * allow-list includes them, so a newly launched site's shared navbar can ask /api/auth/me, the
 * notifications and the wallet without anyone editing a hard-coded list (a site that was missing
 * from it showed "Sign In" to signed-in people: the navbar's cross-origin call was refused).
 * Only exact https origins from the manifests: never a wildcard, so tenant subdomains of a hosting
 * product can never become credentialed origins.
 */
const contracts = require('openvibe-contracts');

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
let cached = null;

function manifestOrigins() {
    if (cached) return cached;
    const out = new Set();
    for (const m of (contracts.services && contracts.services.manifests) || []) {
        for (const d of m.domains || []) {
            const host = String(d || '').trim().toLowerCase();
            if (HOST_RE.test(host)) out.add(`https://${host}`);
        }
    }
    cached = out;
    return out;
}

module.exports = { manifestOrigins };
