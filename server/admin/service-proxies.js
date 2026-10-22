'use strict';
/**
 * The admin panel's service proxies (public/js/admin/*): each forwards to the service that owns the job, as the
 * signed-in staff member. The token sent on is re-minted from their current record, so a role granted a moment ago
 * counts upstream too; every service checks the person's role again.
 *
 *   /api/admin/streamer/*         → Live  /api/admin/*    admin
 *   /api/admin/streamer-mod/*     → Live  /api/mod/*      admin or global mod
 *   /api/admin/streamer-tts/*     → Chat  /api/tts/*      admin (Chat serves TTS since the chat cutover; it keeps the
 *                                                          provider credentials owner-only)
 *   /api/admin/streamer-pastes/*  → Live  /api/pastes/*   admin (Live forwards to OpenVibe.Community, which owns pastes)
 *   /api/admin/streamer-funds/*   410: cashouts are decided in OpenVibe.Billing's console, not here
 *
 * test/admin-service-proxies.test.js
 */
const express = require('express');

const BILLING_CONSOLE = 'https://billing.openvibe.network';

/** The JSON (or problem+json) types passed through as they are; anything else goes back as plain text. */
const JSON_TYPE = /^application\/([a-z.+-]+\+)?json\b/i;

/**
 * Forward the request to `targetUrl` with the staff member's token and send back the upstream status and body.
 * `service` names the upstream in the 502 when it cannot be reached.
 */
async function proxyJsonRequest(req, res, targetUrl, { label, service, signToken }) {
    try {
        let upstreamToken = req.token;
        try {
            if (req.user && req.app.locals.privateKey && typeof signToken === 'function') {
                upstreamToken = signToken(req.user, req.app.locals.privateKey, req.app.locals.config, { renew: req.tokenClaims || {} });
            }
        } catch (e) {
            console.error('[AdminProxy] token re-mint failed, forwarding original:', e.message);
        }
        const fetchOpts = {
            method: req.method,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamToken}` },
        };
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) fetchOpts.body = JSON.stringify(req.body);

        const upstream = await fetch(targetUrl, fetchOpts);
        const contentType = upstream.headers.get('content-type') || '';
        const raw = await upstream.text();
        res.status(upstream.status);
        if (JSON_TYPE.test(contentType)) return res.type(contentType).send(raw || '{}');
        return res.type('text/plain').send(raw);
    } catch (err) {
        console.error(`[AdminProxy] ${label}:`, err.message);
        return res.status(502).json({ error: `Could not reach ${service}` });
    }
}

const allow = (roles, error) => (req, res, next) => (req.user && roles.includes(req.user.role) ? next() : res.status(403).json({ error }));

/**
 * The proxies as one router, mounted at /api/admin. `services` is config.services (each service's internalUrl, read
 * on every request); `signToken` is auth/routes' (it re-mints the staff member's token).
 */
function createServiceProxies({ requireAuth, signToken, services }) {
    const r = express.Router();
    const admin = allow(['admin'], 'Admin access required');
    const staff = allow(['admin', 'global_mod'], 'Staff access required');
    const to = (base, prefix, service, label) => async (req, res) => await proxyJsonRequest(req, res, `${base()}${prefix}${req.url}`, { label, service, signToken });
    const live = () => services.live.internalUrl;
    const chat = () => services.chat.internalUrl;

    r.use('/streamer', requireAuth, admin, to(live, '/api/admin', 'OpenVibe.Live', 'Streamer proxy error'));
    r.use('/streamer-mod', requireAuth, staff, to(live, '/api/mod', 'OpenVibe.Live', 'Mod proxy error'));
    r.use('/streamer-tts', requireAuth, admin, to(chat, '/api/tts', 'OpenVibe.Chat', 'TTS proxy error'));
    r.use('/streamer-pastes', requireAuth, admin, to(live, '/api/pastes', 'OpenVibe.Live', 'Pastes proxy error'));
    // Live's /api/funds cashout admin is gone (Billing is the only money ledger since 2026-10-17).
    r.use('/streamer-funds', requireAuth, admin, (req, res) => res.status(410).json({
        error: 'Cashouts are decided in OpenVibe.Billing\'s console now',
        console: `${BILLING_CONSOLE}/cashouts`,
    }));
    return r;
}

module.exports = { createServiceProxies, proxyJsonRequest, BILLING_CONSOLE };
