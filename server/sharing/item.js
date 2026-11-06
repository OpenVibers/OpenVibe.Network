'use strict';
/**
 * What a shared item is called, and where it lives (design 2026-11-06, SHARING-DESIGN-2026-11-06.md).
 *
 * The share events carry ids only, so Network asks the owning service for the item's own name and
 * link: GET <service>/api/v1/<kind>/<id>/share, the uniform share API of the SDK
 * (openvibe-sdk/share, in review). The service answers only for a viewer who may see the item, so
 * Network calls it as the person: with a short-lived token of that person's own session, minted for
 * the owning service alone (see mintViewerToken).
 *
 * When the service does not answer (it is down, the item was deleted, the contract does not carry a
 * title yet) the item is shown as its site and kind. Nothing is ever guessed.
 */
const jwt = require('jsonwebtoken');
const contracts = require('openvibe-contracts');
const { SITES, fullName } = require('../frame/sites');

const TIMEOUT_MS = 3500;
const TTL_SEC = 60;

/** The manifest of a service, or null when the service is not one of ours. */
function manifestOf(service) {
    try { return contracts.services.get(service) || null; } catch { return null; }
}

/** The audience a service expects of a person's token: its own host name (openvibe.community). */
function audienceOf(service) {
    const m = manifestOf(service);
    if (!m) return null;
    const origin = m.publicOrigin || (Array.isArray(m.domains) ? m.domains[0] : null);
    try { return new URL(String(origin)).hostname; } catch { return null; }
}

/** The hosts that belong to a service: its own domains, so a link to the item is kept only when it is on one of them. */
function hostsOf(service) {
    const m = manifestOf(service);
    const hosts = new Set();
    if (m) {
        for (const d of m.domains || []) hosts.add(String(d).toLowerCase());
        try { if (m.publicOrigin) hosts.add(new URL(m.publicOrigin).hostname.toLowerCase()); } catch { /* no origin */ }
    }
    for (const s of SITES) if (s.service === service && s.host) hosts.add(String(s.host).toLowerCase());
    return hosts;
}

/** The site's name and link, for the "which site is this on" column. */
function siteOf(service) {
    const s = SITES.find((x) => x.service === service) || null;
    const m = manifestOf(service);
    const host = s ? s.host : (m && m.domains && m.domains[0]) || null;
    return {
        id: s ? s.id : service,
        name: s ? s.name : (m && m.name) || service,
        full_name: s ? fullName(s) : (m && m.name) || service,
        host: host || null,
        url: host ? 'https://' + host : null,
    };
}

/**
 * A short-lived token of the person's own session for one service: the audience is that service
 * alone and it lives a minute. It is minted only for a service of our own manifests and only for a
 * person Network already knows may see the item. It is never stored and never logged.
 */
function mintViewerToken(ctx, user, audience) {
    if (!ctx || !ctx.privateKey || !audience || !user) return null;
    const key = String(ctx.privateKey);
    const algorithm = key.includes('BEGIN') ? 'RS256' : 'HS256';
    try {
        return jwt.sign({
            sub: user.id,
            id: user.id,
            subject_id: user.subject_id || undefined,
            username: user.username,
            display_name: user.display_name || user.username,
            role: user.role,
            avatar_url: user.avatar_url,
        }, key, { algorithm, issuer: ctx.issuer, audience: [audience], expiresIn: TTL_SEC });
    } catch { return null; }
}

/** The first string of a list of fields, cleaned. */
function pick(body, fields) {
    for (const f of fields) {
        const v = body && typeof body[f] === 'string' ? body[f] : null;
        if (v) { const c = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200); if (c) return c; }
    }
    return null;
}

/** The first link of a list of fields, kept only when it is https and on one of the service's hosts. */
function pickLink(body, service) {
    const allowed = hostsOf(service);
    for (const f of ['url', 'link', 'item_url', 'href']) {
        const v = body && typeof body[f] === 'string' ? body[f] : null;
        if (!v) continue;
        try {
            const u = new URL(String(v).trim());
            if (u.protocol !== 'https:' || !allowed.has(u.hostname.toLowerCase())) continue;
            return u.toString().slice(0, 500);
        } catch { /* not a link */ }
    }
    return null;
}

/**
 * The item's name and link, as the owning service sees them.
 * @returns {Promise<{title: string|null, url: string|null}>}
 */
async function resolveItem(ctx, ref, { token = null, timeoutMs = TIMEOUT_MS } = {}) {
    const out = { title: null, url: null };
    if (!ref) return out;
    const base = ctx.serviceBase ? ctx.serviceBase(ref.service) : defaultBase(ctx, ref.service);
    if (!base) return out;
    const path = '/api/v1/' + encodeURIComponent(ref.kind) + '/' + encodeURIComponent(ref.id) + '/share';
    try {
        const headers = { accept: 'application/json' };
        if (token) headers.authorization = 'Bearer ' + token;
        const r = await (ctx.fetchImpl || fetch)(String(base).replace(/\/+$/, '') + path, {
            headers,
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r || !r.ok) return out;
        const body = await r.json().catch(() => null);
        if (!body || typeof body !== 'object') return out;
        const item = body.item && typeof body.item === 'object' ? body.item : {};
        const share = body.share && typeof body.share === 'object' ? body.share : {};
        out.title = pick(body, ['title', 'item_title', 'name'])
            || pick(item, ['title', 'name'])
            || pick(share, ['title', 'name'])
            || null;
        out.url = pickLink(body, ref.service)
            || pickLink(item, ref.service)
            || pickLink(share, ref.service);
        return out;
    } catch { return out; }
}

/** Where a service is reached: its internal URL when Network knows one, else its public origin. */
function defaultBase(ctx, service) {
    const internal = ctx.config && ctx.config.services && ctx.config.services[service] && ctx.config.services[service].internalUrl;
    if (internal) return String(internal);
    const m = manifestOf(service);
    return m && m.publicOrigin ? String(m.publicOrigin) : null;
}

module.exports = { resolveItem, mintViewerToken, siteOf, audienceOf, manifestOf, hostsOf, TIMEOUT_MS };
