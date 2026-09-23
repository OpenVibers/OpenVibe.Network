'use strict';
/**
 * Developer-project policy (roadmap Wave 20, ADR-014): which capabilities a third-party app may ever
 * hold, which audience a capability belongs to, and whether a receiver accepts a sandbox token.
 *
 * Grantability comes from the capability's `visibility` in openvibe-contracts:
 *   public       grantable to apps (may appear in a project's allowance, including a default one)
 *   partner      (proposed; not in the contracts enum yet) grantable only when staff put it in one
 *                project's allowance by hand, never through the default allowance
 *   first-party  never grantable to apps: only first-party service principals hold these
 *   internal     never grantable to apps
 * A capability must also be `active` (not planned, deprecated or retired) to be granted.
 */
const { capabilities } = require('openvibe-contracts');

const GRANTABLE_VISIBILITIES = new Set(['public', 'partner']);
const DEFAULT_ALLOWANCE_VISIBILITIES = new Set(['public']);
const ENVIRONMENTS = ['sandbox', 'production'];
const ENVIRONMENT_POLICIES = { sandbox: ['sandbox'], 'sandbox+production': ['sandbox', 'production'] };

/** { grantable, code, reason } for one capability id. */
function grantability(id) {
    const cap = capabilities.get(String(id || ''));
    if (!cap) return { grantable: false, code: 'grant.unknown_capability', reason: `no capability ${id} in the catalog` };
    if (!GRANTABLE_VISIBILITIES.has(cap.visibility)) return { grantable: false, code: 'grant.not_grantable', reason: `${id} is ${cap.visibility}; only public capabilities are granted to apps` };
    if (cap.status !== 'active') return { grantable: false, code: 'grant.not_grantable', reason: `${id} is ${cap.status}` };
    return { grantable: true, code: null, reason: null, capability: cap };
}

const isGrantable = (id) => grantability(id).grantable;

/** The audience a capability is invoked at: its owning service (openvibe.<owner>). */
function audienceOf(id) {
    const cap = capabilities.get(String(id || ''));
    return cap ? `openvibe.${cap.owner}` : null;
}

/** Capabilities an app could ever be granted (the catalog view Codes shows). */
function grantableCatalog() {
    return capabilities.manifests.filter(c => isGrantable(c.id)).map(c => ({
        id: c.id, owner: c.owner, audience: `openvibe.${c.owner}`, visibility: c.visibility, description: c.description || '',
        resourceConstraints: c.resourceConstraints, quotaClass: c.quotaClass,
    }));
}

/** Developer settings with defaults (config.developer is optional so tests can omit it). */
function settings(config) {
    const d = (config && config.developer) || {};
    const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean);
    const num = (v, dflt, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : dflt; };
    return {
        sandboxAudiences: new Set(list(d.sandboxAudiences)),
        credentialOverlapS: num(d.credentialOverlapS, 86400, 0, 7 * 86400),
        defaultAllowance: list(d.defaultAllowance).filter(id => grantability(id).grantable && DEFAULT_ALLOWANCE_VISIBILITIES.has(capabilities.get(id).visibility)),
        maxProjectsPerOwner: num(d.maxProjectsPerOwner, 10, 1, 1000),
        maxAppsPerProject: num(d.maxAppsPerProject, 20, 1, 1000),
    };
}

/**
 * Receiver-side environment check. Tokens without `env` (first-party service principals) and
 * `env: production` pass; `env: sandbox` passes only when this audience opted in.
 * Returns { ok } or { ok: false, code, reason } (code token.sandbox_refused -> 401).
 */
function environmentDecision(claims, { acceptSandbox = false } = {}) {
    const env = claims ? claims.env : undefined;
    if (env === undefined || env === 'production') return { ok: true };
    if (env === 'sandbox') return acceptSandbox ? { ok: true } : { ok: false, code: 'token.sandbox_refused', reason: 'sandbox tokens are not accepted by this audience' };
    return { ok: false, code: 'token.invalid_claims', reason: `unknown env ${env}` };
}

/** Claims of a JWT whose signature the caller already verified. */
function unverifiedClaims(token) {
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

module.exports = {
    GRANTABLE_VISIBILITIES, ENVIRONMENTS, ENVIRONMENT_POLICIES,
    grantability, isGrantable, audienceOf, grantableCatalog, settings, environmentDecision, unverifiedClaims,
};
