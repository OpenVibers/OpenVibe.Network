'use strict';
// Hostname rules for the tool-domain registry (docs/shared-contracts.md §1).
const net = require('net');
const { OWNED_ZONES } = require('../auth/sso-owned');

const ROLES = ['canonical', 'short', 'alias'];
const TOOLS_ZONE = 'openvibe.tools';
// Hosts under openvibe.tools that are the platform itself, never a tool.
const RESERVED_TOOLS_SUBS = new Set(['www', 'api', 'admin', 'static', 'cdn', 'mail']);

/**
 * Normalise and validate a hostname. Input is what the owner typed: it is trimmed, lowercased
 * and a trailing dot dropped, but a scheme, path, port, wildcard or IP is an error rather than
 * something silently stripped — the row is what nginx and the gateway will match on.
 * @returns {{ ok: true, host: string } | { ok: false, error: string }}
 */
function validateHost(raw) {
    let host = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!host) return { ok: false, error: 'Hostname is required' };
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) return { ok: false, error: 'Enter the hostname only, without http:// or https://' };
    if (/[/?#@\s]/.test(host)) return { ok: false, error: 'Enter the hostname only, without a path, query or spaces' };
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (net.isIP(host) || net.isIP(host.replace(/^\[|\]$/g, '')) || /^\d+(\.\d+){3}$/.test(host)) return { ok: false, error: 'An IP address is not a domain' };
    if (host.includes(':')) return { ok: false, error: 'Enter the hostname only, without a port' };
    if (host.length > 253) return { ok: false, error: 'Hostname is longer than 253 characters' };
    const labels = host.split('.');
    if (labels.length < 2) return { ok: false, error: 'Hostname needs a domain and a TLD (example.com)' };
    for (const label of labels) {
        if (!label) return { ok: false, error: 'Hostname has an empty label (two dots in a row)' };
        if (label.length > 63) return { ok: false, error: 'A hostname label is longer than 63 characters' };
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return { ok: false, error: `"${label}" is not a valid hostname label (letters, digits and inner hyphens only)` };
    }
    const tld = labels[labels.length - 1];
    if (/^\d+$/.test(tld)) return { ok: false, error: 'The top-level domain cannot be numeric' };
    if (tld === 'localhost' || tld === 'local' || tld === 'internal' || tld === 'invalid' || tld === 'test') return { ok: false, error: 'That is not a public domain' };

    const core = coreHostReason(host);
    if (core) return { ok: false, error: core };
    return { ok: true, host };
}

/** Why a host is one of the network's own, or null when it is free to be a tool host. */
function coreHostReason(host) {
    for (const zone of OWNED_ZONES) {
        if (host === zone || host === 'www.' + zone) return `${host} is one of the network's own sites and cannot be a tool domain`;
        if (host.endsWith('.' + zone)) {
            if (zone !== TOOLS_ZONE) return `${host} is inside ${zone}, which belongs to another OpenVibe site`;
            const sub = host.slice(0, -(zone.length + 1));
            if (RESERVED_TOOLS_SUBS.has(sub)) return `${host} is reserved by the Tools platform`;
        }
    }
    return null;
}

function validToolIdSyntax(id) { return /^[a-z0-9-]{1,40}$/.test(String(id || '')); }

module.exports = { ROLES, validateHost, coreHostReason, validToolIdSyntax };
