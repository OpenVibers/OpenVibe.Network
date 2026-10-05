'use strict';
/**
 * Network's metrics and readiness (roadmap Track O, §15.19), on openvibe-shared/metrics and /ready.
 *
 *   GET /metrics     Prometheus text, direct loopback callers only (404 through nginx)
 *   GET /api/ready   named checks; 503 only when a required one fails
 *
 * Domain metrics: token issuance by grant type at /oauth/token (and failures by OAuth error code),
 * and service-token (principal) failures at Network's capability-guarded internal routes.
 * Labels are fixed vocabularies; a client id, subject or token never becomes a label.
 */
const jwt = require('jsonwebtoken');
const metrics = require('openvibe-shared/metrics');
const { createReadiness, skip } = require('openvibe-shared/ready');
const telemetry = require('./telemetry');

const registry = metrics.createRegistry();

const GRANTS = new Set(['authorization_code', 'refresh_token', 'client_credentials', 'urn:ietf:params:oauth:grant-type:jwt-bearer']);
const OAUTH_ERRORS = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable']);
const grantLabel = (g) => (g === 'urn:ietf:params:oauth:grant-type:jwt-bearer' ? 'jwt_bearer' : GRANTS.has(g) ? g : 'other');

const tokensIssued = registry.counter({ name: 'network_tokens_issued_total', help: 'Tokens issued by POST /oauth/token, by grant type', labelNames: ['grant_type'] });
const tokenFailures = registry.counter({ name: 'network_token_failures_total', help: 'POST /oauth/token requests refused, by grant type and OAuth error code', labelNames: ['grant_type', 'error'] });
// Seconds each service's main has been ahead of what runs (registry/deploy-drift.js); alert at 24 h.
registry.gauge({ name: 'openvibe_deploy_drift_seconds', help: 'Seconds since the oldest commit on main that the running service does not have (0 when current)', labelNames: ['service'], maxSeries: 60,
    collect: () => require('./registry/deploy-drift').driftSeconds() });
const principalFailures = registry.counter({ name: 'network_principal_token_failures_total', help: 'Service (principal) tokens refused at capability-guarded Network routes, by problem code', labelNames: ['code'], maxSeries: 50 });

/** Middleware for POST /oauth/token: counts the outcome without reading or logging any secret. */
function tokenEndpointMetrics(req, res, next) {
    if (req.method !== 'POST') return next();
    const grant = grantLabel(req.body && req.body.grant_type);
    let error = null;
    const json = res.json.bind(res);
    res.json = (body) => {
        if (body && typeof body === 'object' && typeof body.error === 'string') error = OAUTH_ERRORS.has(body.error) ? body.error : 'other';
        return json(body);
    };
    res.once('finish', () => {
        if (res.statusCode === 200 && !error) tokensIssued.inc({ grant_type: grant });
        else tokenFailures.inc({ grant_type: grant, error: error || `http_${res.statusCode}` });
    });
    next();
}

/** Called by identity/principals.js guard() for every denial; counts only bearer (service-token) callers. */
function principalDenied({ req, code }) {
    if (!String((req && req.headers && req.headers.authorization) || '').startsWith('Bearer ')) return;
    const c = /^[a-z0-9_.-]{1,64}$/i.test(String(code || '')) ? String(code) : 'other';
    principalFailures.inc({ code: c });
}

// ── Universal telemetry (plan T1, §15.19): one platform.telemetry-sample@1 per request + autoscaling ──
// The HTTP autoscaling signals are active requests, p95 and event-loop lag (CPU alone is never the metric).
// A sample carries the route template, method and status class — never a raw URL, client id or token.
const LATENCY_WINDOW = 512;
const loopMonitor = (() => {
    try {
        const m = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 });
        m.enable();
        return m;
    } catch { return null; }
})();
const recentLatencies = [];   // the last LATENCY_WINDOW request latencies, ms
let active = 0;
let loopResetAt = 0;          // the lag's sampling window: reset at most once per LAG_WINDOW_MS
const LAG_WINDOW_MS = 10000;

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const statusClass = (code) => (code ? `${Math.floor(code / 100)}xx` : 'aborted');

/** The event-loop lag over the current ~10 s window, ms (mean includes the sampling interval: subtracted). */
function eventLoopLagMs() {
    if (!loopMonitor || !(loopMonitor.count > 0 || loopMonitor.max > 0)) return null;
    const lag = Math.max(0, loopMonitor.mean / 1e6 - 20);
    const now = Date.now();
    if (now - loopResetAt >= LAG_WINDOW_MS) { loopMonitor.reset(); loopResetAt = now; }
    return lag;
}

/** The p95 of the recent request latencies, ms; null before any request. */
function latencyP95() {
    if (!recentLatencies.length) return null;
    const sorted = [...recentLatencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/** Express middleware: the request's own sample plus the HTTP autoscaling signals, emitted as samples. */
function telemetryMiddleware(req, res, next) {
    const t0 = process.hrtime.bigint();
    active += 1;
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        active -= 1;
        const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
        const httpStatus = res.writableFinished || res.finished ? (res.statusCode || 0) : 0;
        recentLatencies.push(latencyMs);
        if (recentLatencies.length > LATENCY_WINDOW) recentLatencies.shift();
        try {
            telemetry.record('http.request', latencyMs, {
                status: statusClass(httpStatus),
                resource: metrics.routeLabel(req),
                extra: { method: HTTP_METHODS.has(req.method) ? req.method : 'OTHER', http_status: httpStatus },
            });
            telemetry.gauge('http.active_requests', active);
            const p95 = latencyP95();
            if (p95 != null) telemetry.gauge('http.latency_p95_ms', p95);
            const lag = eventLoopLagMs();
            if (lag != null) telemetry.gauge('http.eventloop_lag_ms', lag);
        } catch { /* telemetry never breaks a request */ }
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
}

/**
 * Readiness with Network's real dependencies:
 *   db          (required) a query against the identity database
 *   signing_key (required in production) an RS256 keypair is loaded and signs a token its own public
 *               key verifies — the thing every service's offline verification depends on
 *   registry_poll (optional) the ecosystem health poll has run recently (status page freshness)
 *   discord_bot (optional) the bot is connected; skipped (never ok) while no bot token is configured
 */
function createNetworkReadiness({ db, getKeys, release, ecosystem = null, discordService = null, production = process.env.NODE_ENV === 'production', pollMs = 60000 }) {
    const checks = [
        { name: 'db', required: true, check: async () => { const r = await db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get(); return { detail: { oauth_clients: r.n } }; } },
        {
            name: 'signing_key', required: production, cacheMs: 60000,
            check: () => {
                const { privateKey, publicKey } = getKeys();
                if (!privateKey || !publicKey) return 'no signing key loaded';
                if (privateKey === publicKey || !String(publicKey).includes('BEGIN')) return 'ephemeral HS256 development key: other services cannot verify tokens';
                const probe = jwt.sign({ probe: true }, privateKey, { algorithm: 'RS256', expiresIn: 30 });
                jwt.verify(probe, publicKey, { algorithms: ['RS256'] });
                return { detail: { algorithm: 'RS256', kid: 'ov-network-1' } };
            },
        },
    ];
    if (ecosystem) {
        checks.push({
            name: 'registry_poll', required: false,
            check: () => {
                const at = ecosystem.lastPollAt();
                if (!at) return 'the ecosystem health poll has not completed yet';
                const age = Date.now() - at;
                return age > 3 * pollMs ? `last completed ${Math.round(age / 1000)}s ago` : { detail: { last_poll_at: new Date(at).toISOString() } };
            },
        });
    }
    if (discordService && typeof discordService.isReady === 'function') {
        checks.push({
            name: 'discord_bot', required: false,
            check: async () => {
                let configured = false;
                try { configured = !!(await discordService._getSetting('discord_bot_token')); } catch { configured = false; }
                if (!configured) return skip('not configured');   // verified nothing: skipped, never ok (WS-Q task 7)
                return discordService.isReady() || 'bot token configured but the bot is not connected';
            },
        });
    }
    return createReadiness({ service: 'network', release, checks });
}

module.exports = { registry, tokenEndpointMetrics, principalDenied, telemetryMiddleware, createNetworkReadiness, grantLabel };
