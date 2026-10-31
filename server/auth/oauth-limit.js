'use strict';
// OAuth endpoints are unauthenticated on purpose (a password check, a code exchange, a refresh), so
// they get their own limit rather than the general /api one. The key is the address AND the client:
// one developer app cannot spend the whole address's budget, and one address cannot hammer one app.
// Same shape as the nginx openvibenetwork_token zone (60 a minute, burst 30); nginx still does its own
// per-address check in front of this.
const rateLimit = require('express-rate-limit');

function oauthKey(req) {
    const client = String((req.body && req.body.client_id) || (req.query && req.query.client_id) || '').slice(0, 80);
    return `${req.ip}:${client || 'anonymous'}`;
}

function createOAuthLimiter({ windowMs = 60_000, max = 60 } = {}) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: oauthKey,
        message: { error: 'too_many_requests', error_description: 'Too many OAuth requests; wait a minute.' },
    });
}

module.exports = { createOAuthLimiter, oauthKey };
