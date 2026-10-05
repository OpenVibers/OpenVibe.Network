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
const path = require('path');
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

// ── Universal telemetry (plan T1, §15.19): aggregated platform.telemetry-sample@1 + autoscaling ──
// A request is not a row: the middleware hands each finished request to server/telemetry.js, which
// aggregates per route|method|status_class and emits one http.request sample per key per flush (plus the
// HTTP autoscaling gauges once per flush). A sample carries the route template, method and status class —
// never a raw URL, client id or token. Health, readiness, metrics, chrome and static/shared assets carry
// no product signal and are skipped before anything is counted.

// The event-loop monitor: created and enabled by startEventLoopMonitor (called from telemetry.init), and
// disabled by stopEventLoopMonitor (telemetry.stop). Nothing runs at module load.
let loopMonitor = null;
function startEventLoopMonitor() {
    if (loopMonitor) return;
    try {
        loopMonitor = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 });
        loopMonitor.enable();
    } catch { loopMonitor = null; }
}
function stopEventLoopMonitor() {
    if (!loopMonitor) return;
    try { loopMonitor.disable(); } catch { /* already gone */ }
    loopMonitor = null;
}
/** Whether the monitor is running (tests assert requiring the module starts nothing). */
function eventLoopMonitorEnabled() { return loopMonitor != null; }

/** The event-loop lag since the last flush, ms (mean includes the sampling interval: subtracted); null
 *  before the monitor has a sample. The monitor resets per read, so each gauge covers one flush interval. */
function eventLoopLagMs() {
    if (!loopMonitor || !(loopMonitor.count > 0 || loopMonitor.max > 0)) return null;
    const lag = Math.max(0, loopMonitor.mean / 1e6 - 20);
    loopMonitor.reset();
    return lag;
}

// server/telemetry.js owns the aggregation; it pulls the lag and calls these lifecycle hooks.
telemetry.registerSignals({ start: startEventLoopMonitor, stop: stopEventLoopMonitor, lag: eventLoopLagMs });

const SKIP_EXACT = new Set(['/api/health', '/ready', '/api/ready', '/metrics']);
const SKIP_PREFIXES = ['/shared', '/api/chrome'];
// Anything express.static serves: public/ files and /data/avatars images. JSON is deliberately not here
// (routes such as /release.json and /contracts/*.json are product/observability API, not static assets).
const STATIC_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.css', '.map', '.html', '.htm', '.txt', '.xml', '.webmanifest', '.wasm',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp',
    '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.webm', '.ogg', '.pdf',
]);
function telemetrySkipped(req) {
    const p = req.path || '';
    if (SKIP_EXACT.has(p)) return true;
    if (SKIP_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) return true;
    return STATIC_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/** Express middleware: hand the finished request to the aggregator; the in-flight peak is sampled at start. */
function telemetryMiddleware(req, res, next) {
    if (telemetrySkipped(req)) return next();
    telemetry.requestStarted();
    const t0 = process.hrtime.bigint();
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        try {
            const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
            const httpStatus = res.writableFinished || res.finished ? (res.statusCode || 0) : 0;
            telemetry.requestFinished({ route: metrics.routeLabel(req), method: req.method, httpStatus, latencyMs });
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

module.exports = { registry, tokenEndpointMetrics, principalDenied, telemetryMiddleware, telemetrySkipped, createNetworkReadiness, grantLabel, eventLoopMonitorEnabled };
