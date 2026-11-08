'use strict';
// openvibe.link is a separate cookie origin. Its web session uses the SDK's confidential
// OAuth flow; the existing public `link` client belongs to the installed mobile app.
const express = require('express');
const { createSsoClient } = require('openvibe-sdk/sso');
const { HOST, SITE } = require('./page');
const { hostOf } = require('./routes');

async function createLinkAuthRoutes({ db, config, log = console } = {}) {
    const row = await db.prepare('SELECT client_secret FROM oauth_clients WHERE client_id = ?').get('link-web');
    const client = createSsoClient({
        site: 'link', siteName: 'OpenVibe Link', baseUrl: SITE,
        clientId: 'link-web', clientSecret: row?.client_secret || '',
        redirectUri: `${SITE}/auth/callback`, scope: 'profile theme',
        networkUrl: config.networkUrl, networkInternalUrl: config.internalUrl,
        issuer: config.jwt.issuer, audience: ['openvibe.network'],
        secureCookies: config.nodeEnv === 'production', log,
    });
    const auth = client.router(express);
    const router = express.Router();
    router.use('/auth', (req, res, next) => {
        if (hostOf(req) !== HOST) return next();
        res.set('Cache-Control', 'no-store');
        return auth(req, res, next);
    });
    return router;
}

module.exports = { createLinkAuthRoutes };
