'use strict';
/**
 * Network's own owner settings over the internal config protocol (openvibe-shared/config, plan §AB.20).
 *
 *   GET  /internal/config                     every namespace: network.signin here
 *   …    /internal/config/network.signin     the store's own routes (values, history, rollback, secrets, test)
 *
 * Network's admin proxy (server/admin/ai-config-proxy.js) reaches a *service* at its /internal/config; for Network's
 * own namespace the owner's panel needs no service token at all, because the panel and the store are one process. So
 * this mount is shape-only for the proxy contract, and the Setup tab reads Network's rows through
 * GET /api/admin/signin (server/admin/signin.js), which calls the same store directly.
 *
 * Everything here is owner only and loopback only: it holds Network's provider secrets' route surface.
 */
const express = require('express');
const configNs = require('./config');
const presets = require('./presets');
const { requireOwner } = require('../owner-guard');

function createInternalConfig({ log = console } = {}) {
    const r = express.Router();
    // Loopback only: a proxied request (any x-forwarded-* header) is not this Network talking to itself.
    r.use((req, res, next) => {
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) {
            return res.status(404).json({ code: 'config.not_found', error: 'no such route' });
        }
        next();
    });
    r.use(requireOwner);

    r.get('/', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const base = String((req.app.locals.config || {}).baseUrl || 'https://openvibe.network');
            const store = await configNs.forDb(db, base);
            res.json({ namespaces: [await store.summary()] });
        } catch (err) {
            log.error(`[SignIn] /internal/config: ${String(err && err.message).slice(0, 160)}`);
            res.status(500).json({ code: 'config.internal', error: 'the configuration request failed' });
        }
    });

    r.get('/:namespace', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const base = String((req.app.locals.config || {}).baseUrl || 'https://openvibe.network');
            const store = await configNs.forDb(db, base);
            if (req.params.namespace !== configNs.NAMESPACE) return res.status(404).json({ code: 'config.namespace_not_found', error: 'no such configuration namespace' });
            res.json(await store.summary());
        } catch (err) {
            log.error(`[SignIn] /internal/config: ${String(err && err.message).slice(0, 160)}`);
            res.status(500).json({ code: 'config.internal', error: 'the configuration request failed' });
        }
    });

    return r;
}

/** One line for the owner's Setup row: what the provider's own site answers with the stored keys. */
async function testProvider({ db, baseUrl, providerId, fetch: fetchImpl = globalThis.fetch }) {
    const p = presets.BY_ID.get(providerId);
    if (!p) return { ok: false, message: 'No such sign-in provider.' };
    const store = await configNs.forDb(db, baseUrl);
    if (!configNs.isEnabled(store, providerId)) {
        const missing = presets.fieldsOf(p).filter((f) => !(p.optionalFields || []).includes(f) && !(configNs.valuesOf(store, providerId)[f]));
        return { ok: false, message: missing.length ? `Not set up yet: still missing ${missing.map((f) => `${providerId}.${f}`).join(', ')}.` : `${p.name} is switched off.` };
    }
    try {
        if (p.kind === 'oidc' || p.kind === 'apple') {
            const res = await fetchImpl(`${p.issuer || p.discoveryIssuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000), redirect: 'error' });
            if (!res.ok) return { ok: false, message: `${p.name}'s discovery document answered HTTP ${res.status}.` };
            return { ok: true, message: `${p.name} answered: its sign-in service is reachable.` };
        }
        if (p.kind === 'oauth2') {
            const res = await fetchImpl(p.authorize, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000) });
            return res.status < 500 ? { ok: true, message: `${p.name}'s sign-in page answered HTTP ${res.status}.` } : { ok: false, message: `${p.name}'s sign-in page answered HTTP ${res.status}.` };
        }
        const res = await fetchImpl(p.endpoint, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000) });
        return res.status < 500 ? { ok: true, message: `Steam's OpenID endpoint answered HTTP ${res.status}.` } : { ok: false, message: `Steam's OpenID endpoint answered HTTP ${res.status}.` };
    } catch (err) {
        return { ok: false, message: `${p.name} did not answer: ${String(err && err.message || 'no response').slice(0, 160)}` };
    }
}

module.exports = { createInternalConfig, testProvider };
