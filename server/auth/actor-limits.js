/**
 * Per-actor limits on the account API's writes (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * The per-address limits in server/index.js stay (120 a minute on /api, the auth limiter, and the per-route ones).
 * This counts WRITES by the person whose session token makes them (user:<subject>, or user:<id> before a subject
 * exists). Reads are not counted per actor, and neither are signed-out writes, nor service or app tokens (a
 * first-party service speaks for many people): those keep the per-address limits.
 *
 * Every write takes NETWORK_LIMITS_MINUTE / NETWORK_LIMITS_HOUR (120 and 3000) as `network.api.write`; the table
 * below gives sensitive writes their own, tighter numbers on top. Past a limit the request answers 429 problem+json
 * `rate_limited` with Retry-After before any route runs; the refusal is logged by subject (never a token) and counted
 * in network_rate_limited_total{limit,window}. Counters live in this process.
 *
 * Never counted: /api/auth/* (sign-in has its own limiter), /api/webhooks (providers), /api/v1/realtime tickets.
 * /internal, /oauth, /api/health, /api/ready, /metrics and the JWKS are outside what this sees or are reads.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { createActorLimiter } = require('openvibe-sdk/limits');
const { isUserSessionClaims, requestToken } = require('./session');

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

const EXEMPT = [/^\/auth\//, /^\/webhooks(\/|$)/, /^\/v1\/realtime(\/|$)/];

/** [name, method regex, path regex (relative to /api), { minute, hour }]; the first match wins. */
const ROUTES = [
    // Export, deletion and merge start work in every service and send mail.
    // (a merge takes a few steps: start, confirm, maybe a retry)
    ['network.account', /^(POST|PUT|DELETE)$/, /^\/v1\/account(\/|$)/, { minute: 10, hour: 40 }],
    // Developer projects: creating apps and rotating credentials mint secrets.
    ['network.project.create', /^POST$/, /^\/v1\/projects\/?$/, { minute: 5, hour: 30 }],
    ['network.project.credentials', /^POST$/, /^\/v1\/projects\/[^/]+\/(apps(\/[^/]+)?\/credentials.*|apps\/?)$/, { minute: 10, hour: 60 }],
    // Theme submissions and imports land in the staff review queue.
    ['network.theme.submit', /^POST$/, /^\/themes\/?(import\/?)?$/, { minute: 10, hour: 60 }],
    ['network.avatar', /^(POST|PUT|DELETE)$/, /^\/profile\/avatar(\/|$)/, { minute: 10, hour: 60 }],
    ['network.follow', /^(PUT|POST|DELETE)$/, /^\/v1\/me\/follows(\/|$)/, { minute: 60, hour: 600 }],
    ['network.block', /^(PUT|POST|DELETE)$/, /^\/v1\/me\/blocks(\/|$)/, { minute: 30, hour: 300 }],
];

function createNetworkActorLimits({ env = process.env, publicKey, issuer, registry = null, now } = {}) {
    let refused = null;
    if (registry && typeof registry.counter === 'function') {
        refused = registry.counter({ name: 'network_rate_limited_total', help: 'API writes refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] });
    }
    const algorithm = String(publicKey || '').includes('BEGIN') ? 'RS256' : 'HS256';
    /** The person whose session makes the request; null for no session, a service or app token, or a bad token. */
    function actor(req) {
        const token = requestToken(req);
        if (!token || !publicKey) return null;
        try {
            const d = jwt.verify(token, publicKey, { algorithms: [algorithm], issuer, ignoreExpiration: true });
            if (!isUserSessionClaims(d)) return null;
            if (d.subject_id) return `user:${d.subject_id}`;
            return d.sub != null || d.id != null ? `user:${d.sub != null ? d.sub : d.id}` : null;
        } catch { return null; }
    }
    const limits = createActorLimiter({
        limits: { minute: num(env.NETWORK_LIMITS_MINUTE, 120), hour: num(env.NETWORK_LIMITS_HOUR, 3000) },
        actor,
        ...(now ? { now } : {}),
        onLimited(e) {
            console.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    const write = limits('network.api.write');
    const named = ROUTES.map(([name, method, pathRe, own]) => ({ method, pathRe, mw: limits(name, own) }));
    const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    function middleware(req, res, next) {
        if (!WRITE.has(req.method)) return next();
        const p = req.path;
        if (EXEMPT.some((re) => re.test(p))) return next();
        const own = named.find((r) => r.method.test(req.method) && r.pathRe.test(p));
        return write(req, res, (err) => (err ? next(err) : own ? own.mw(req, res, next) : next()));
    }
    middleware.limits = limits;
    return middleware;
}

module.exports = { createNetworkActorLimits, EXEMPT, ROUTES };
