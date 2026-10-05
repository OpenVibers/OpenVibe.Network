'use strict';

const cache = require('openvibe-shared/cache-policy');

// ═══════════════════════════════════════════════════════════════
// openvibe.network — Main Server Entry Point
// Pure identity/account service for the OpenVibe network:
// SSO provider (OAuth2/OIDC), accounts, themes, notifications,
// admin, url-registry, OpenCoins wallet, and /shared assets.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
// Async route handlers: a rejection reaches Express's error handling, as a throw did (server/async-routes.js, plan T2).
require('./async-routes');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const config = require('./config');
const { initDb } = require('./db/database');
const urlRegistry = require('./url-registry');
const { BRAND } = require('openvibe-shared/brand');
const { NotificationService } = require('./notifications/notification-service');
const { EmailService } = require('./notifications/email-service');
const createNotificationRoutes = require('./notifications/routes');
const createAdminRoutes = require('./admin/routes');
const createSetupRoutes = require('./setup/routes');
const networkAnalytics = require('./analytics/network'); // ADR-021: no IP/user id, route templates, 30-day raw retention
const { DiscordService } = require('./discord/discord-service');
const createDiscordRoutes = require('./discord/routes');
const createDeployRoutes = require('./deploy/routes');
const createCoinsRoutes = require('./coins/routes');
const { signToken } = require('./auth/routes');

// The boot runs asynchronously: opening PostgreSQL (migrations, seeds) is async (plan T2, ADR-035).
const ready = (async () => {

const app = express();

// What this server is running (ADR-016, registry.release-manifest@1); open tabs poll it through
// /shared/release-watch.js and are prompted, or reloaded when safe, after a deploy.
const release = require('openvibe-shared/release').createRelease({ service: 'network', root: path.join(__dirname, '..') });

// Metrics first, so every request is measured: HTTP golden signals by route template, process
// metrics, release_info, and GET /metrics for direct loopback callers only (server/observability.js).
const observability = require('./observability');
require('openvibe-shared/metrics').instrument(app, {
    service: 'network', release: release.release, registry: observability.registry,
    normalize: (req) => (req.route ? null : /^\/shared\//.test(req.originalUrl) ? '/shared/*' : /^\/data\/avatars\//.test(req.originalUrl) ? '/data/avatars/*' : null),
});

function getRequestHost(req) {
    return String(req.headers.host || '').split(':')[0].toLowerCase();
}

async function ensureAdminUser(db, config) {
    const adminExists = await db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
    if (adminExists) return;
    const username = config.admin.username || (config.nodeEnv !== 'production' ? 'admin' : null);
    const password = config.admin.password || (config.nodeEnv !== 'production' ? 'admin' : null);
    if (!username || !password) {
        console.warn('[Setup] No admin user exists and ADMIN_USERNAME/PASSWORD are not configured. Setup routes remain available to complete bootstrap.');
        return;
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    await db.prepare(`
        INSERT INTO users (username, email, password_hash, display_name, role, profile_color, subject_id)
        VALUES (?, ?, ?, ?, 'admin', '#8b5cf6', ?)
        ON CONFLICT (lower(username)) DO UPDATE SET role = 'admin', password_hash = excluded.password_hash
    `).run(username, null, passwordHash, username, require('./identity/subjects').newUserSubjectId());
    console.log(`[Setup] Admin user created or elevated: ${username}`);
}

function redirectWithoutHtml(req, res, targetPath) {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect(302, `${targetPath}${query}`);
}

function sendMyAccountApp(res) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'my.html'));
}

function sendLandingPage(res) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
}

async function proxyJsonRequest(req, res, targetUrl, errorLabel) {
    try {
        // Re-mint a fresh token from the user's CURRENT server-side record so that
        // a just-granted role (e.g. admin) propagates to upstream services
        // immediately, instead of relying on the client's possibly-stale token.
        let upstreamToken = req.token;
        try {
            if (req.user && req.app.locals.privateKey) {
                upstreamToken = signToken(req.user, req.app.locals.privateKey, req.app.locals.config, { renew: req.tokenClaims || {} });
            }
        } catch (e) {
            console.error('[AdminProxy] token re-mint failed, forwarding original:', e.message);
        }
        const fetchOpts = {
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${upstreamToken}`,
            },
        };
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
            fetchOpts.body = JSON.stringify(req.body);
        }

        const upstream = await fetch(targetUrl, fetchOpts);
        const contentType = upstream.headers.get('content-type') || '';
        const raw = await upstream.text();

        res.status(upstream.status);
        if (contentType.includes('application/json')) {
            return res.json(raw ? JSON.parse(raw) : {});
        }
        return res.send(raw);
    } catch (err) {
        console.error(`[AdminProxy] ${errorLabel}:`, err.message);
        return res.status(502).json({ error: 'Could not reach OpenVibe.Live service' });
    }
}

// ── Security ─────────────────────────────────────────────────
app.set('trust proxy', 2); // Cloudflare → Nginx → Node

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // Cloudflare Web Analytics: Cloudflare injects its beacon at the edge and the privacy text says it may
            // measure performance; script-src loads the beacon, connect-src is where it reports.
            scriptSrc: ["'self'", "'unsafe-inline'", "https://openvibe.network", "https://openvibe.live", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "https://static.cloudflareinsights.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"],
            fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://openvibe.media", "https://openvibe.live"],   // avatars and media live on openvibe.media; live-stream thumbnails on the home page come from openvibe.live
            connectSrc: [
                "'self'",
                "https://openvibe.network",
                "https://openvibe.live",
                "https://openvibe.tools", "https://*.openvibe.tools",
                "https://openvibe.games", "https://play.openvibe.games",
                "https://openvibe.media",
                "https://openvibe.community",
                "https://openvibe.blog",
                "https://cloudflareinsights.com", // Cloudflare Web Analytics reports here (see script-src)
                // Release notifications: release-watch's EventSource on the Events realtime stream (openvibe-shared 1.17)
                "https://events.openvibe.network",
            ],
            frameSrc: ["'none'"],
            scriptSrcAttr: ["'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
// Provider webhooks (Resend bounces/complaints) — mounted BEFORE the JSON body parser so
// the route sees the raw bytes it must verify the Svix signature over.
app.use('/api/webhooks', require('./notifications/resend-webhook')());
// OpenVibe.Events deliveries → notifications (server/notifications/events-consumer.js), also before the
// JSON parser (the v2 signature covers the raw body). Built once the database and the notification
// service exist (below); inert (503) until NETWORK_EVENTS_SECRET is set.
let eventsConsumer = null;
app.use('/internal/events', (req, res, next) => (eventsConsumer ? eventsConsumer.router(req, res, next) : res.status(503).json({ error: 'starting' })));
// Export parts (ADR-033) carry up to 20 MB and are parsed by their own route.
const jsonBody = express.json({ limit: '1mb' });
app.use((req, res, next) => (req.method === 'POST' && /^\/internal\/account-exports\/[^/]+\/parts$/.test(req.path) ? next() : jsonBody(req, res, next)));
app.use(express.urlencoded({ extended: true }));

// ── CORS ─────────────────────────────────────────────────────
// Origins are derived dynamically from the URL registry at request time.
// OpenVibe defaults are seeded values — white-label installs override via admin.
//
// A request origin is allowed when ANY of the following is true:
//  1. It exactly matches a configured first-party URL (network, live, tools, games, media)
//  2. It matches a wildcard subdomain of TOOLS_SUBDOMAIN_BASE (e.g. *.openvibe.tools)
//  3. It is listed in ALLOWED_EXTRA_ORIGINS (admin-configurable JSON array)
//  4. It is a localhost/127.0.0.1 origin in non-production environments

function normalizeOriginForCors(origin) {
    if (!origin || typeof origin !== 'string') return null;
    try {
        const url = new URL(origin.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
    } catch {
        return null;
    }
}

function buildAllowedOriginsSet() {
    const registry = app.locals.urlRegistry || {};
    const origins = new Set();

    // All configured public first-party URLs are always allowed
    const publicUrlKeys = [
        'OV_NETWORK_URL', 'OV_NETWORK_LOGIN_URL',
        'OV_LIVE_URL', 'OV_TOOLS_URL', 'OV_GAMES_URL', 'OV_MEDIA_URL',
        'WEBRTC_PUBLIC_URL', 'JSMPEG_PUBLIC_URL', 'WHIP_PUBLIC_URL',
    ];
    for (const key of publicUrlKeys) {
        const v = registry[key]?.value;
        if (!v) continue;
        const norm = normalizeOriginForCors(v);
        if (!norm) continue;
        origins.add(norm);
        // Auto-add www/non-www variant
        try {
            const u = new URL(norm);
            if (u.hostname.startsWith('www.')) {
                origins.add(`${u.protocol}//${u.hostname.slice(4)}${u.port ? ':' + u.port : ''}`);
            } else {
                origins.add(`${u.protocol}//www.${u.hostname}${u.port ? ':' + u.port : ''}`);
            }
        } catch { /* ignore */ }
    }

    // Extra origins from admin-configurable list
    const extra = registry.ALLOWED_EXTRA_ORIGINS?.value;
    if (Array.isArray(extra)) {
        for (const o of extra) {
            const norm = normalizeOriginForCors(o);
            if (norm) origins.add(norm);
        }
    }

    // Every first-party domain the service manifests declare (openvibe.blog, openvibe.wiki, …)
    for (const o of require('./first-party-origins').manifestOrigins()) origins.add(o);

    // Hard-coded OpenVibe defaults as baseline (survive registry reset/failure)
    for (const o of [
        'https://openvibe.network',
        'https://openvibe.live', 'https://www.openvibe.live',
        'https://openvibe.tools',
        'https://openvibe.games', 'https://www.openvibe.games', 'https://play.openvibe.games',
        'https://openvibe.media',
        'https://openvibe.community',
    ]) {
        origins.add(o);
    }

    if (process.env.NODE_ENV !== 'production') {
        for (const o of [
            'http://localhost:3000',            // live
            'http://localhost:4000', 'http://127.0.0.1:4000', // network
            'http://localhost:4001',            // tools gateway
            'http://localhost:4100',            // media
            'http://localhost:8000',            // games
            'http://localhost:5173',            // games vite dev
        ]) {
            origins.add(o);
        }
    }

    return origins;
}

function getToolsSubdomainBase() {
    const registry = app.locals.urlRegistry || {};
    // Use registry value if explicitly set by admin; fall back to OpenVibe default
    return registry.TOOLS_SUBDOMAIN_BASE?.value || 'openvibe.tools';
}

function isAllowedOrigin(origin) {
    if (!origin) return true; // non-browser requests (curl, server-to-server)
    const norm = normalizeOriginForCors(origin);
    if (!norm) return false;
    if (buildAllowedOriginsSet().has(norm)) return true;

    // Wildcard subdomain match for TOOLS_SUBDOMAIN_BASE (e.g. *.openvibe.tools)
    const subdomainBase = getToolsSubdomainBase();
    if (subdomainBase) {
        try {
            const u = new URL(norm);
            // Only trust https:// subdomains in production
            if (u.protocol === 'https:' && u.hostname.endsWith('.' + subdomainBase)) return true;
            // In dev, allow http as well
            if (process.env.NODE_ENV !== 'production' && u.hostname.endsWith('.' + subdomainBase)) return true;
        } catch { /* ignore */ }
    }

    return false;
}

// Public discovery (/.well-known/openvibe, /api/v1/registry/*, /contracts/*.json) answers any
// origin, preflight included; every other route keeps this allow-list (server/public-cors.js).
const corsGuard = require('./public-cors').originGuard(isAllowedOrigin);
app.use(require('./public-cors').gate(cors({ origin: corsGuard.origin, credentials: true })));
app.use(corsGuard.denied);

// ── Rate Limiting ────────────────────────────────────────────
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60_000, max: 30, skipSuccessfulRequests: true }));

// ── Database ─────────────────────────────────────────────────
const db = await initDb();
await urlRegistry.initializeUrlRegistry(db);
await urlRegistry.seedBootstrapRegistry(db, process.env, config.bootstrapProfile);
await ensureAdminUser(db, config);
const resolvedRegistry = await urlRegistry.getResolvedRegistry(db, process.env);

// Apply resolved network registry values to runtime config
if (resolvedRegistry.OV_NETWORK_URL?.value) {
    config.networkUrl = resolvedRegistry.OV_NETWORK_URL.value;
    config.jwt.issuer = resolvedRegistry.OV_NETWORK_URL.value;
    if (!process.env.BASE_URL) config.baseUrl = resolvedRegistry.OV_NETWORK_URL.value;
}
if (resolvedRegistry.OV_NETWORK_LOGIN_URL?.value) {
    config.loginUrl = resolvedRegistry.OV_NETWORK_LOGIN_URL.value;
} else {
    config.loginUrl = config.loginUrl || config.networkUrl;
}
if (resolvedRegistry.OV_NETWORK_INTERNAL_URL?.value) config.internalUrl = resolvedRegistry.OV_NETWORK_INTERNAL_URL.value;
if (resolvedRegistry.OV_LIVE_INTERNAL_URL?.value) config.services.live.internalUrl = resolvedRegistry.OV_LIVE_INTERNAL_URL.value;
if (resolvedRegistry.OV_TOOLS_INTERNAL_URL?.value) config.services.tools.internalUrl = resolvedRegistry.OV_TOOLS_INTERNAL_URL.value;
if (resolvedRegistry.OV_GAMES_INTERNAL_URL?.value) config.services.games.internalUrl = resolvedRegistry.OV_GAMES_INTERNAL_URL.value;
if (resolvedRegistry.OV_MEDIA_INTERNAL_URL?.value) config.services.media.internalUrl = resolvedRegistry.OV_MEDIA_INTERNAL_URL.value;

// Expose a canonical registry payload for admin/internal consumers
app.locals.urlRegistry = resolvedRegistry;
// Make registry accessible to signToken via config._registry
config._registry = resolvedRegistry;

// ── Analytics Tracking (ADR-021) ──────────────────────────────
// openvibe-shared/analytics on PostgreSQL (server/analytics/network.js; migrations/0002_analytics.sql).
// Raw rows: route template, rotating session id, user-agent class, referer origin; never an IP or a
// user id. A Sec-GPC: 1 / DNT: 1 request is not recorded. Pruned after 30 days by the tracker itself;
// rollups are kept.
const analytics = networkAnalytics.openAnalytics(db);
app.locals.analytics = analytics;
app.use(analytics.middleware());
// Universal telemetry (plan T1, server/telemetry.js): one platform.telemetry-sample@1 per request plus
// the HTTP autoscaling signals, into the same analytics store. Wired before any route runs; flushed once
// by gracefulStop's stop array below.
const telemetry = require('./telemetry');
telemetry.init({ analytics });
app.use(observability.telemetryMiddleware);

// ── Extract bearer token (available as req.token for optional-auth proxies) ─
app.use((req, _res, next) => {
    const ah = req.headers.authorization;
    req.token = ah?.startsWith('Bearer ') ? ah.slice(7) : req.cookies?.ov_token || null;
    next();
});

// ── Load RSA Keys ────────────────────────────────────────────
let privateKey, publicKey;
try {
    privateKey = fs.readFileSync(path.resolve(config.jwt.privateKeyPath), 'utf8');
    publicKey = fs.readFileSync(path.resolve(config.jwt.publicKeyPath), 'utf8');
    console.log('[Auth] RS256 keypair loaded');
} catch (err) {
    console.warn('[Auth] RSA keypair not found — generating ephemeral keys for development');
    console.warn('[Auth] Run: openssl genrsa -out data/keys/private.pem 2048');
    console.warn('[Auth]      openssl rsa -in data/keys/private.pem -pubout -out data/keys/public.pem');
    // Fall back to HS256 with a random secret for development
    const crypto = require('crypto');
    privateKey = crypto.randomBytes(64).toString('hex');
    publicKey = privateKey;
    console.warn('[Auth] Using ephemeral HS256 key — DO NOT use in production');
}

// Make keys available to route modules
app.locals.db = db;
app.locals.privateKey = privateKey;
// Network's own service tokens for its calls to Live, Media and Tools (identity/self-token.js).
const selfToken = require('./identity/self-token').createSelfTokens({ privateKey, issuer: config.jwt.issuer });
app.locals.selfToken = selfToken;
app.locals.publicKey = publicKey;
app.locals.config = config;

// Shared counters on Valkey when VALKEY_URL is set (ADR-035, plan T2): every process and host counts one
// actor together. Unset — or unreachable — the limits fall back to this process's own counters (never 500).
const valkey = config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix }) : null;
app.locals.valkey = valkey;

// Per-actor limits on API writes, by the person whose session makes them (server/auth/actor-limits.js; WS-R task 4).
app.use('/api/', require('./auth/actor-limits').createNetworkActorLimits({
    publicKey, issuer: config.jwt.issuer, registry: observability.registry,
    store: valkey ? require('openvibe-sdk/limits').createValkeyLimitStore(valkey) : null,
}));

// Provider secrets: environment first, database fallback (server/secrets.js). Names and sources only.
console.log(`[Secrets] ${await require('./secrets').summary(db)}`);

// ── Initialize Services ──────────────────────────────────────
const notificationService = new NotificationService(db);
const emailService = new EmailService(db);
await emailService.ready;   // its settings are read from the database before the first request
app.locals.notificationService = notificationService;
app.locals.emailService = emailService;
// The moderation audit log (ADR-022): staff actions every service reports, readable by staff.
const moderationAudit = require('./admin/moderation-audit').createModerationAudit(db);
// Developer projects' usage (WS-N task 4): the services' hourly rollups, per project and day.
const projectUsage = require('./developer/usage').createProjectUsage(db);
eventsConsumer = await require('./notifications/events-consumer').createEventsConsumer({
    db, notifications: notificationService, secrets: config.eventsWebhookSecrets,
    discord: () => app.locals.discordService || null, moderationAudit, projectUsage,
});
console.log(`[Events consumer] ${eventsConsumer.enabled ? 'on' : 'off (NETWORK_EVENTS_SECRET unset)'}: POST /internal/events`);

// Discord bot service
const discordService = new DiscordService(db);
app.locals.discordService = discordService;
discordService.init().catch(err => console.error('[Discord] Init error:', err.message));

// requireAuth helper (needed by route factories)
const authRoutes = require('./auth/routes');
const jwt = require('jsonwebtoken');
// Sliding session guard (server/auth/session.js): renewable tokens are accepted and renewed.
const requireAuth = require('./auth/session').makeRequireAuth(() => ({ db, publicKey, config }), authRoutes.signToken);
// The moderation audit log for staff (staff.moderation.logs): server/admin/moderation-audit.js.
app.use('/api/v1/staff/moderation-audit', requireAuth, moderationAudit.router());
// Staff capabilities and the staff list (WS-D task 4; services need network.staff.read).
app.use('/api/v1/staff', require('./admin/staff-api').createStaffApi({ db, requireAuth, guard: require('./identity/principals').guard }));
// Username history (WS-B task 6): who holds a name now, so sites redirect /@old → /@new and pick up a
// new name before they have seen it. Banned accounts and unknown names are 404.
app.get('/api/v1/users/names/:name', rateLimit({ windowMs: 60_000, max: 240 }), async (req, res) => {
    const rec = await require('./identity/usernames').lookup(db, req.params.name);
    res.set('Cache-Control', 'public, max-age=120');
    if (!rec) return res.status(404).json({ error: 'not_found' });
    res.json(rec);
});
// The GitHub token (admin → Settings → GitHub, or GITHUB_TOKEN): owner-only admin, and Blog's changelog reads it.
app.use('/api/admin/integrations/github', requireAuth, require('./integrations/github').adminRouter(db));
app.get('/internal/integrations/github-token', require('./identity/principals').guard('network.integration.github.read'), require('./integrations/github').internalHandler(db));
// Platform blocks (WS-E task 5): a person's own list, and who blocked whom for Chat and Community
// (network.blocks.read, service token only). Every change is network.block.changed (server/identity/blocks.js).
app.use('/api/v1/me/blocks', rateLimit({ windowMs: 60_000, max: 60 }), require('./identity/blocks').userRouter(requireAuth));
// Account merge (roadmap WS-B task 5, ADR-029): the person folds a second account into this one; staff
// (staff.identity.merge) for account recovery, with a reason.
{
    const accountMerge = require('./identity/account-merge');
    await accountMerge.ensureSchema(db);
    const mergeRouters = accountMerge.routers({ requireAuth, staffClaims: require('./auth/staff-claims').staffClaims });
    app.use('/api/v1/account', rateLimit({ windowMs: 60_000, max: 20 }), mergeRouters.me);
    app.use('/api/admin/account-merges', mergeRouters.admin);
}
// Mod principals (roadmap WS-M task 3, ADR-013): the runtime that installs a mod registers mod:<mod_id> and changes
// its grants (mods.grant.manage, service token only); staff (staff.games.manage) from /api/admin/mods.
{
    const modRouters = require('./identity/mod-principals').routers({
        guard: require('./identity/principals').guard('mods.grant.manage'), requireAuth, staffClaims: require('./auth/staff-claims').staffClaims,
    });
    require('./identity/mod-principals').ensureSchema(db);
    app.use('/internal/mods', modRouters.internal);
    app.use('/api/admin/mods', modRouters.admin);
}
// Account export and deletion (roadmap WS-B task 7, ADR-033): the person's export job and scheduled deletion;
// services push export parts and confirm deletions with service tokens; staff (staff.users.manage) see what is
// outstanding. Archives live under the data directory for 7 days.
const ACCOUNT_EXPORT_DIR = path.join(path.resolve(config.dataDir), 'account-exports');
const notifyAccountData = async (userId, n) => await notificationService.create({ user_id: userId, type: 'GENERIC', category: 'system', service: 'network', url: 'https://openvibe.network/my#accounts', ...n });
{
    const accountData = require('./identity/account-data');
    await accountData.ensureSchema(db);
    const guard = require('./identity/principals').guard;
    const dataRouters = accountData.routers({
        requireAuth, staffClaims: require('./auth/staff-claims').staffClaims, dir: ACCOUNT_EXPORT_DIR, notify: notifyAccountData,
        contributeGuard: guard('network.account.export.contribute'), confirmGuard: guard('network.account.deletion.confirm'),
    });
    app.use('/api/v1/account', rateLimit({ windowMs: 60_000, max: 20 }), dataRouters.me);
    app.use('/internal', dataRouters.internal);
    app.use('/api/admin/account-deletions', dataRouters.admin);
}
// The node registry (WS-X1, ADR-034 §12): public list for the geo API; Host reports its inventory's machines; services
// holding network.registry.read read the same list uncached at GET /internal/nodes.
{
    const { guard } = require('./identity/principals');
    const nodeRouters = require('./registry/nodes').routers({ guard: guard('network.node.report'), readGuard: guard('network.registry.read') });
    app.use('/api/v1/nodes', nodeRouters.pub);
    app.use('/internal/nodes', nodeRouters.internal);
}
// The resource registry (plan T2, docs/t2-resource-registry.md): node and provider offers. The public list leaves
// capacity out; the report and the full internal read take network.resource.report. The amended ADR-048 moved the
// public routes off /api/v1/resources (now Network's resource index, below) to /api/v1/offers.
{
    const offerRouters = require('./registry/offers').routers({ guard: require('./identity/principals').guard('network.resource.report') });
    app.use('/api/v1/offers', offerRouters.pub);
    app.use('/internal/resources', offerRouters.internal);
}
// Network's authority resource index (ADR-048 section 3, capability network.resource.read): common.resource-summary@1
// pages of the resources Network owns (projects, apps, node principals) for OpenVibe.Services' fan-out.
{
    app.use('/api/v1/resources', require('./registry/resource-index').router({ guard: require('./identity/principals').guard('network.resource.read') }));
}
// Service instances (plan T2, docs/t2-cells-and-node-principal.md section 4.1): Host reports what runs on its machines
// with network.node.report. Mounted before /internal/registry so the cells read does not swallow the report path.
{
    const instanceRouters = require('./registry/instances').routers({ guard: require('./identity/principals').guard('network.node.report') });
    app.use('/internal/registry/instances', instanceRouters.internal);
}
// Cells and node principals (plan T2, docs/t2-resource-registry.md section 9): the public cell list; a cell's nodes,
// instances and offers for services holding network.registry.read.
{
    const cellRouters = require('./registry/cells').routers({ readGuard: require('./identity/principals').guard('network.registry.read') });
    app.use('/api/v1/cells', cellRouters.pub);
    app.use('/internal/registry', cellRouters.internal);
}
// Pairing a person's machine (plan T2, docs/t2-cells-and-node-principal.md section 4.2): a service holding
// network.node.manage mints one-time codes and reads or revokes the principals it paired; the machine redeems its code
// with no other credential, so the redeem route has its own tight rate limit.
{
    const pairingRouters = require('./registry/node-principals').routers({ guard: require('./identity/principals').guard('network.node.manage') });
    app.use('/api/v1/node-pairing', rateLimit({ windowMs: 60_000, max: 10 }), pairingRouters.pairing);
    app.use('/internal', pairingRouters.internal);
    // The person's own machines (slice N5): list and revoke, session only, same limit as /api/v1/me/blocks.
    app.use('/api/v1/me/nodes', rateLimit({ windowMs: 60_000, max: 60 }), require('./registry/node-principals').userRouter(requireAuth));
    // The machine itself (slice N4c): its own capabilities and credential, resolved from its node token alone.
    app.use('/api/v1/node/self', require('./identity/principals').guard('network.node.self.manage'), require('./registry/node-principals').selfRouter());
}
app.get('/internal/blocks', require('./identity/principals').guard('network.blocks.read'), require('./identity/blocks').internalHandler(db));
// The follow graph (WS-E task 4, ADR-030): public counts, a person's own follows, and who follows a target
// (its owner, or network.follows.read, service token only). Every change is network.follow.* (server/identity/follows.js).
{
    const followRouters = require('./identity/follows').routers({ requireAuth, followsGuard: require('./identity/principals').guard('network.follows.read') });
    app.use('/api/v1/me/follows', rateLimit({ windowMs: 60_000, max: 120 }), followRouters.me);
    app.use('/api/v1/follows', rateLimit({ windowMs: 60_000, max: 300 }), followRouters.pub);
    // ADR-030 step 4: products record follows on a person's behalf (network.follows.write, service token only).
    app.use('/internal/follows', require('./identity/principals').guard('network.follows.write'), followRouters.internal);
    // A follow that starts notifies the followed person (FOLLOW), in the follow's transaction.
    require('./identity/follows').setNotifier(require('./notifications/follow-notify').followNotifier(notificationService));
}
// Realtime tickets (WS-E task 3, WS-F task 1; ADR-005 amendment 2): the notification badge on any site opens
// OpenVibe.Events' /realtime/stream as the signed-in person with a two-minute, single-use ticket
// (server/auth/realtime-ticket.js). REALTIME_TICKETS=off answers 503 and every badge stays on polling.
app.use('/api/v1/realtime', rateLimit({ windowMs: 60_000, max: 60 }), require('./auth/realtime-ticket').router({
    db, requireAuth, privateKey, issuer: config.jwt.issuer, streamUrl: process.env.OV_EVENTS_PUBLIC_URL,
}));

// ── Routes ───────────────────────────────────────────────────
// Public key endpoint (services fetch this to verify JWTs).
// Serves BOTH the standard JWKS `keys` array (RFC 7517 — Media and other
// spec-compliant consumers) and the legacy `public_key` PEM shape that the
// inherited service clients read.
// Ecosystem registry: services, capabilities, namespaces and contracts from openvibe-contracts, with polled health.
// Loopback addresses: the built-in ports, overridden by OV_<ID>_INTERNAL_URL (loopback URLs only).
const ecosystemInternal = require('./registry/ecosystem').internalFromEnv(process.env);
if (ecosystemInternal.ignored.length) console.warn(`[Registry] ignored (not a loopback URL): ${ecosystemInternal.ignored.join(', ')}`);
const ecosystem = require('./registry/ecosystem').createEcosystemRegistry({ issuer: config.jwt.issuer, internalOverrides: ecosystemInternal.overrides });
// Production drift: each running service's deployed commit against its repository's main (WS-S task 7).
const deployDrift = require('./registry/deploy-drift').createDeployDrift({
    services: () => ecosystem.releases().services.filter((r) => r.release).map((r) => ({ id: r.id, release: r.release, repository: ((require('openvibe-contracts').services.manifests.find((m) => m.id === r.id)) || {}).repository })),
    token: async () => process.env.GITHUB_TOKEN || await require('./integrations/github').tokenOf(db) || '',
});
deployDrift.start();
app.use(ecosystem.router());
ecosystem.start();
// The released libraries' latest published tags (not the versions Network installs) for the registry.
const libraryTags = require('./registry/library-tags').createLibraryTags({ onUpdate: require('./registry/exposure').setLibraryReleases, token: async () => await require('./integrations/github').tokenOf(db) });
libraryTags.start();
// Operator status: GET /status (server-rendered, noindex), /api/v1/status, /api/v1/status/slo.
// Creator analytics (WS-E task 6): from live.stream.ended, counts only; the full figures for the creator or
// network.analytics.creator.read (Live's dashboards).
app.use('/api/v1/creators', rateLimit({ windowMs: 60_000, max: 300 }), require('./analytics/creators').router({ fullGuard: require('./identity/principals').guard('network.analytics.creator.read') }));
// Incidents and maintenance (WS-N task 12): public list; staff admins or network.status.incident (ovhost) write.
app.use('/api/v1/status/incidents', rateLimit({ windowMs: 60_000, max: 120 }), require('./status/incidents').router({ requireAuth, incidentGuard: require('./identity/principals').guard('network.status.incident') }));
app.use(require('./status/routes').createStatusRoutes({ ecosystem }));
// What shipped network-wide: the changelog proxy every site's widget reads, and /updates.
app.use(require('./updates/routes').createUpdatesRoutes({ blogUrl: process.env.OV_BLOG_INTERNAL_URL || 'http://127.0.0.1:4810' }).router);

app.get('/api/.well-known/jwks', (_req, res) => {
    // Without key files the ephemeral HS256 "key pair" is one shared secret: publishing it would let
    // anyone sign sessions. Only a real public key is ever served.
    if (privateKey === publicKey || !String(publicKey).includes('BEGIN')) return res.json({ algorithm: 'HS256', keys: [] });
    const out = { public_key: publicKey, algorithm: 'RS256' };
    if (publicKey.includes('BEGIN')) {
        try {
            const jwk = require('crypto').createPublicKey(publicKey).export({ format: 'jwk' });
            out.keys = [{ ...jwk, use: 'sig', alg: 'RS256', kid: 'ov-network-1' }];
        } catch { /* legacy shape still served */ }
    }
    res.json(out);
});

// Health check
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'openvibe-network', version: '1.0.0' });
});

// Readiness: named checks with status, latency and checked_at; 503 only when a required one fails.
{
    const ready = observability.createNetworkReadiness({
        db, release: release.release, ecosystem, discordService,
        getKeys: () => ({ privateKey: app.locals.privateKey, publicKey: app.locals.publicKey }),
    });
    app.get('/api/ready', ready.handler);
}

// Brand info (used by all frontends for consistent URLs/names)
app.get('/api/brand', (_req, res) => res.json(BRAND));

// Auth routes (SSO provider)
app.use('/api/auth', authRoutes);

// Email verification (status / resend / consume)
app.use('/api/auth', require('./auth/email-verify').routes(requireAuth));

// Discord account linking (OAuth2 flow)
app.use('/api/auth/discord', requireAuth, require('./auth/discord-link'));

// OAuth2 authorization endpoints (token issuance counted by grant type: server/observability.js)
app.use('/oauth/token', observability.tokenEndpointMetrics);
app.use('/oauth', require('./auth/oauth-routes'));

// Theme API
app.use('/api/themes', require('./themes/routes'));

// OpenCoins wallet API (user-facing, Bearer JWT)
app.use('/api/coins', createCoinsRoutes(db, requireAuth));
// Versioned user modules: portable per-person preferences and summaries (server/identity/modules.js).
app.use('/api/modules', require('./identity/modules').userRouter(requireAuth));

// Developer projects, apps, credentials, grants and quotas (server/developer, ADR-014). Bearer user
// tokens only; never X-Internal-Key.
app.use('/api/v1/projects', rateLimit({ windowMs: 60_000, max: 60 }), require('./developer/routes').router());
// The owner's confirmation inbox (plan T2 WS-Z2 slice 4, server/developer/confirmations.js): the same Bearer-only rules.
app.use('/api/v1/confirmations', rateLimit({ windowMs: 60_000, max: 60 }), require('./developer/confirmations').router());
// Their network.app.* / credential / grant events go to OpenVibe.Events through an outbox when
// OV_EVENTS_INTERNAL_URL is set (server/developer/event-relay.js); off otherwise.
await require('./developer/event-relay').startRelay(db, { eventsUrl: config.eventsInternalUrl, privateKey, issuer: config.jwt.issuer });
// network.user.updated (WS-B task 2): profile, role and ban changes, recorded by triggers on users and relayed
// through the same outbox (server/identity/profile-events.js).
await require('./identity/profile-events').start(db);
require('./identity/grants-admin').start(db);
// Pending confirmations past expires_at are recorded expired every minute (reads report them expired before that).
require('./developer/confirmations').setNotifier(notificationService);
require('./developer/confirmations').start(db);

// Notification API (authenticated users)
app.use('/api/notifications', createNotificationRoutes(db, notificationService, requireAuth));

// Push Notifications API
const pushService = require('./push/push-service');
await pushService.initVapid(db);
app.use('/api/push', requireAuth, require('./push/routes'));

// Cross-site history (what the account touched anywhere on the network)
app.use('/api/history', rateLimit({ windowMs: 60_000, max: 60 }), await require('./history/routes').createHistoryRoutes(db, requireAuth));

// "Sign in everywhere" chain targets (public: the fanout page reads them before hopping)
app.get('/api/sso/targets', (req, res) => {
    const { ssoTargets } = require('./auth/sso-targets');
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ targets: ssoTargets() });
});

// Discord bot admin API
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}
// Terms, Privacy and DMCA for this domain (openvibe-shared/legal; every site serves its own).
{ const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'network', service: 'network', host: 'openvibe.network', name: 'OpenVibe.Network', profile: 'account' })); app.get('/tos', (_req, res) => res.redirect(301, '/terms')); }

// The tool catalog, re-served from here: every OpenVibe site's content-security policy already allows
// openvibe.network, so the navbar's search works on hosts that may not call openvibe.tools directly.
app.get('/api/catalog.json', async (req, res) => {
    const toolsCatalog = require('./domains/catalog');
    const { catalog } = await toolsCatalog.getCatalog().catch(() => toolsCatalog.peek());
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400' }).json(catalog);
});

// The avatar: one picture per account, hosted on openvibe.media, used by every site (server/profile/avatar.js).
const avatarService = require('./profile/avatar').createAvatarService({ db, config, requireAuth, selfToken });
app.use('/api/profile/avatar', rateLimit({ windowMs: 60_000, max: 20 }), avatarService.api);
app.use('/avatar', rateLimit({ windowMs: 60_000, max: 600 }), avatarService.pub);
app.locals.avatarService = avatarService;

// The OpenVibe Frame: analytics-ranked navigation + footer copy for every site (server/frame).
// /api/chrome is the old name, kept for copies of openvibe-shared older than 1.11.0.
const frameService = await require('./frame/service').createFrameService(db, config, analytics, { privateKey, issuer: config.jwt.issuer, selfToken });
const frameLimit = rateLimit({ windowMs: 60_000, max: 240 });
app.use('/api/frame', frameLimit, frameService.router);
app.use('/api/chrome', frameLimit, frameService.router);
frameService.start();
// /api/v1/registry/featured follows the navigation's usage ranking.
ecosystem.setRanking(() => frameService.ranking());

// Tool domains: public list for the Tools gateway, owner-only management (docs/shared-contracts.md §1).
const toolDomains = await require('./domains/routes').createDomainRoutes(db, requireAuth);
app.use('/api/domains', rateLimit({ windowMs: 60_000, max: 120 }), toolDomains.publicRouter);
app.use('/api/admin/domains', toolDomains.adminRouter);
app.use('/api/admin/discord', createDiscordRoutes(db, discordService, requireAuth, requireAdmin));

// Deploy (TLS / Nginx / Infrastructure) admin API
app.use('/api/admin/deploy', createDeployRoutes(db, requireAuth));
// Registry operators (plan T2): cell and instance route weights, draining, node principal status; staff session only.
app.use('/api/admin/registry', require('./registry/registry-admin').createRegistryAdmin(db, requireAuth, requireAdmin));

// SSH access provisioning info — powers the admin "SSH" tab.
// Returns non-secret connection context (host, project roots, services). The
// actual host lives in env (SSH_SERVER_HOST) so no infra detail is committed.
app.get('/api/admin/ssh-info', requireAuth, requireAdmin, (req, res) => {
    const OWNER = (process.env.OWNER_USERNAME || 'goosely').toLowerCase();
    res.json({
        ok: true,
        host: process.env.SSH_SERVER_HOST || '',
        ownerUsername: OWNER,
        projectsRoot: process.env.SSH_PROJECTS_ROOT || '/opt/openvibe.network /opt/openvibe.live',
        services: ['openvibe-network', 'openvibe-live'],
        is_owner: !!(req.user.username && req.user.username.toLowerCase() === OWNER),
    });
});

// Setup API for first-run bootstrapping and status checks
app.use('/api/setup', createSetupRoutes(db, config));

// Admin panel API
// OpenVibe.Events' dead-letter queue and replays, owner-only (WS-F task 3).
app.use('/api/admin/events', requireAuth, require('./admin/events-ops').createEventsOps({ db, eventsUrl: config.eventsInternalUrl, privateKey, issuer: config.jwt.issuer }));
// Service grants: owner-only, audited, network.principal_grant.changed (WS-D task 3).
app.use('/api/admin/grants', requireAuth, require('./identity/grants-admin').router(db));
// Community theme review queue (WS-E task 2): submissions stay private until an admin approves them.
app.use('/api/admin/themes', requireAuth, requireAdmin, require('./themes/routes').reviewRouter());
// Operator parity checklist (WS-D task 5): where each operator job is done now, with each service's readiness.
app.use('/api/admin/operator-checklist', requireAuth, requireAdmin, require('./admin/operator-checklist').router({ statusRows: () => require('./status/routes').rows(ecosystem) }));
app.use('/api/admin', createAdminRoutes(db, notificationService, emailService, requireAuth));

// Analytics admin API
const createAnalyticsRoutes = require('./admin/analytics-routes');
app.use('/api/admin/analytics', createAnalyticsRoutes(analytics, requireAuth, config, { selfToken }));

// ── Admin Proxy to OpenVibe.Live ──────────────────────────────
// Proxies /api/admin/streamer/* → openvibe.live /api/admin/*
// This lets the unified admin panel on openvibe.network manage OpenVibe.Live features.
const OPENVIBELIVE_INTERNAL = config.services.live.internalUrl;
app.use('/api/admin/streamer', requireAuth, (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}, async (req, res) => {
    return await proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/admin${req.url}`, 'Streamer proxy error');
});

// Proxy /api/mod/* for moderator routes
app.use('/api/admin/streamer-mod', requireAuth, (req, res, next) => {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'global_mod')) {
        return res.status(403).json({ error: 'Staff access required' });
    }
    next();
}, async (req, res) => {
    return await proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/mod${req.url}`, 'Mod proxy error');
});

app.use('/api/admin/streamer-tts', requireAuth, (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}, async (req, res) => {
    return await proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/tts${req.url}`, 'TTS proxy error');
});

app.use('/api/admin/streamer-funds', requireAuth, (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}, async (req, res) => {
    return await proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/funds${req.url}`, 'Funds proxy error');
});

// Pastes (retiring) — this proxy is a surviving caller of OpenVibe.Media's read-only paste API, so
// Media cannot retire that API's router and GET handlers while it exists. The chain reads
// Network → Live → Media: /api/admin/streamer-pastes/:rest → openvibe.live /api/pastes/:rest, whose
// GETs forward 1:1 to openvibe.media /api/v1/live/pastes/:rest. The admin panel's Pastes tab
// (public/admin.html) is the consumer: it still reads GET /config (the last live-called paste GET)
// and /admin/stats (whose Media route is already gone), and its DELETE /admin/forks answers Media's
// 410 pastes.moved. Retiring Media's paste GETs is conditional on this proxy being retired or
// repointed first — Live moves the whole chain to Community with PASTES_AUTHORITY=community, and
// this proxy should follow that move (or go with the tab) rather than keep reading the retired API.
app.use('/api/admin/streamer-pastes', requireAuth, (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}, async (req, res) => {
    return await proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/pastes${req.url}`, 'Pastes proxy error');
});

// Internal API (server-to-server, capability-scoped service tokens only)
app.use('/internal', require('./internal/routes'));

// ── Host Canonicalization ────────────────────────────────────
// my.openvibe.network is legacy — 301 to the apex (nginx will also do this).
app.use((req, res, next) => {
    if (getRequestHost(req) === 'my.openvibe.network') {
        const targetPath = (req.path === '/' || req.path === '/my' || req.path === '/my.html') ? '/my' : req.path;
        const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect(301, `https://openvibe.network${targetPath}${query}`);
    }
    next();
});

// ── Static Files ─────────────────────────────────────────────
app.get(['/login.html', '/admin.html'], (req, res) => {
    if (req.path === '/login.html') return redirectWithoutHtml(req, res, '/login');
    if (req.path === '/admin.html') return redirectWithoutHtml(req, res, '/admin');
    return res.status(404).end();
});

// Landing page at the apex root
app.get(['/', '/index.html'], (req, res) => {
    if (req.path === '/index.html') return redirectWithoutHtml(req, res, '/');
    return require('./home/render').sendHome(req, res);
});
app.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(require('./home/render').llmsTxt()));
app.get('/llms-full.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(require('./home/render').llmsFullTxt({ baseUrl: config.baseUrl })));
// The crawl files the front door owes crawlers, built from openvibe-shared/seo (plan T11 lane D), ahead
// of express.static below so they answer the generated copy rather than public/.
app.use(require('./seo/routes').createSeoRoutes({ release }));
// IndexNow key file (openvibe-shared/indexnow), from INDEXNOW_KEY; unset → off, nothing served. The
// public page set is the fixed seo/routes PAGES list, so no hook pings; the client stays for one that will.
const indexnow = require('openvibe-shared/indexnow').createIndexNow({ host: config.baseUrl, key: config.indexnow.key });
if (indexnow.enabled) app.use(indexnow.keyFile);

// Account hub (my.html) — the apex hosts the account hub under /my
// plus its client-routed sections.
app.get(require('./not-found').ACCOUNT_HUB_PATHS, (req, res) => {
    if (req.path === '/my.html') return redirectWithoutHtml(req, res, '/my');
    return sendMyAccountApp(res);
});

// Email verification lands here from the message itself — on whatever device the mail was
// opened, signed in or not — so it is its own page, not the signed-in account hub (which
// bounced to /login and dropped the token).
app.get('/verify-email', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.sendFile(path.join(__dirname, '..', 'public', 'verify-email.html'));
});

// FedCM identity provider (browser-native sign-in for the other OpenVibe sites) — server/auth/fedcm.js
{
    const fedcm = require('./auth/fedcm');
    const ctx = () => ({ db, publicKey, privateKey, config });
    app.get('/.well-known/web-identity', fedcm.wellKnown(ctx));
    // OpenID Connect discovery at the issuer's root (and RFC 8414's name for it): server/auth/oidc.js
    require('./auth/oidc').mount(app);
    app.use('/fedcm', fedcm.createFedcmRoutes(ctx));
}

// Silent cross-site session check (hidden iframe from any OpenVibe site) — see server/auth/sso-check.js
app.get('/sso/check', require('./auth/sso-check').createSsoCheckRoute(() => ({ db, publicKey, config })));

// Sign-in / sign-out everywhere: the redirect chain through every first-party site.
app.get(['/sso/fanout', '/sso/fanout.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.sendFile(path.join(__dirname, '..', 'public', 'sso-fanout.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: require('./static-headers').publicStaticHeaders }));

// openvibe-shared: the OpenVibe.Shared release package.json pins, from node_modules.
const sharedFiles = require('openvibe-shared/files');

// Web-push service worker: must be served from THIS origin (scope /), so each site
// exposes the shared worker at /openvibe-sw.js rather than loading it from Network.
app.get('/openvibe-sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(sharedFiles.path('openvibe-sw.js'));
});

// Serve openvibe-shared client-side libs (notification-ui.js, navbar.js, etc.) to every site at
// https://openvibe.network/shared/<file>, and the same release at /shared/v1/<file> (OpenVibe.Shared
// README, compatibility policy). Only the package's browser files: its server modules, tests and
// scripts are not served. A ?v= equal to the file's content hash (navbar.js asks for nav-icons.js
// that way) is cacheable forever; anything else gets five minutes.
const sharedRev = new Map();
function serveShared(req, res, next) {
    const name = req.path.slice(1);
    if (!sharedFiles.isBrowserFile(name)) return next();
    if (!sharedRev.has(name)) sharedRev.set(name, require('crypto').createHash('sha256').update(fs.readFileSync(sharedFiles.path(name))).digest('hex').slice(0, 12));
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Override helmet's same-origin policies so other domains can load these scripts
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.setHeader('Cache-Control', cache.assetHeaders(name, { hashed: req.query.v === sharedRev.get(name) }));
    res.sendFile(sharedFiles.path(name));
}
app.use('/shared/v1', serveShared);
app.use('/shared', serveShared);

// GET /release.json, and POST /release-metrics: open tabs' update outcomes into /metrics
// (release_client_updates_total, openvibe-shared 1.5.0).
release.mount(app, { registry: observability.registry });

// Avatar serving
const avatarDir = path.resolve(config.avatars.path);
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
app.use('/data/avatars', express.static(avatarDir, { maxAge: '7d' }));

// Serve clean auth + recovery routes
// People type /register and /signup: the sign-in page's create-account view (WS-B task 10), query kept.
app.get(['/register', '/signup', '/sign-up'], (req, res) => {
    const q = new URLSearchParams(req.query);
    q.set('tab', 'register');
    res.redirect(302, `/login?${q}`);
});
app.get(['/login', '/forgot-password', '/reset-password'], (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// Admin panel — serve the SPA for /admin and any client-routed sub-path
// (e.g. /admin/settings, /admin/analytics/overview). Auth is checked client-side.
app.get(['/admin', '/admin/*'], (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Anything no route above answered is a 404: JSON under /api, /internal and /oauth, otherwise a small
// noindex page (server/not-found.js). The account hub is served only at its own paths.
app.use(require('./not-found').notFound);

// ── Start ────────────────────────────────────────────────────
const timers = [];   // the periodic maintenance below, cleared on stop
const server = app.listen(config.port, config.host, () => {
    // The home page renders the Tools catalog it already holds: fetch it now, not on the first visit.
    require('./domains/catalog').refresh().catch(() => {});
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║   OpenVibe.Network — Identity Service ║`);
    console.log(`╠═══════════════════════════════════════╣`);
    console.log(`║  Port: ${String(config.port).padEnd(30)}║`);
    console.log(`║  URL:  ${config.baseUrl.padEnd(30)}║`);
    console.log(`║  Auth: ${config.loginUrl.padEnd(30)}║`);
    console.log(`╚═══════════════════════════════════════╝\n`);

    // ── Periodic Maintenance ─────────────────────────────────
    // Clean expired notifications every hour
    timers.push(setInterval(() => notificationService.maintenance().catch((e) => console.warn('[Notifications] maintenance failed:', e.message)), 60 * 60 * 1000));

    // Process email queue every 2 minutes
    timers.push(setInterval(() => emailService.processQueue(notificationService).catch((e) => console.warn('[Email] queue failed:', e.message)), 2 * 60 * 1000));

    // Raw analytics retention (ADR-021) is scheduled by the PostgreSQL tracker itself: events older
    // than 30 days go, in bounded batches; hourly/daily rollups stay.

    // User modules of a retired owning service (onOwnerRemoved, server/identity/modules.js): writes stop at
    // once; delete-after-retention records go retentionDays after Network first saw the retirement.
    const sweepModules = async () => {
        try {
            const n = await require('./identity/modules').sweepRetired(db);
            if (n) console.log(`[Modules] Deleted ${n} record(s) of retired namespace owners`);
        } catch (e) { console.warn('[Modules] retired-owner sweep:', e.message); }
    };
    timers.push(setTimeout(sweepModules, 5 * 60 * 1000), setInterval(sweepModules, 24 * 60 * 60 * 1000));
    // Account merges older than 30 days keep only the alias facts (ADR-029).
    const reduceMerges = async () => { try { const n = await require('./identity/account-merge').reduceExpired(db); if (n) console.log(`[AccountMerge] reduced ${n} merge record(s) past 30 days`); } catch (e) { console.warn('[AccountMerge] reduce failed:', e.message); } };
    timers.push(setTimeout(reduceMerges, 6 * 60 * 1000), setInterval(reduceMerges, 24 * 60 * 60 * 1000));
    // Exports past their deadline are built, archives past 7 days deleted, deletions past their 30-day grace carried out (ADR-033).
    const sweepAccountData = async () => {
        try {
            const n = await require('./identity/account-data').sweep(db, { dir: ACCOUNT_EXPORT_DIR, notify: notifyAccountData });
            if (n.built || n.expired || n.deleted) console.log(`[AccountData] sweep: ${JSON.stringify(n)}`);
        } catch (e) { console.warn('[AccountData] sweep failed:', e.message); }
    };
    timers.push(setTimeout(sweepAccountData, 60 * 1000), setInterval(sweepAccountData, 2 * 60 * 1000));

    // Clean expired sessions daily
    timers.push(setInterval(async () => {
        try {
            const cleaned = (await db.prepare("DELETE FROM user_sessions WHERE expires_at < datetime('now') OR is_active = 0").run()).changes;
            if (cleaned > 0) console.log(`[Sessions] Cleaned ${cleaned} expired sessions`);
        } catch (e) { console.warn('[Sessions] cleanup failed:', e.message); }
    }, 24 * 60 * 60 * 1000));
});

// ── Stop (roadmap WS-P lifecycle; openvibe-sdk/service) ───────
// systemd sends SIGTERM on a restart or deploy. The maintenance timers, the registry, drift and library
// pollers, the frame refreshes, the profile-event and grant-expiry timers stop (nothing new starts); the
// server stops taking connections, closes idle keep-alive ones and lets requests in flight finish (8 s at
// most, Connection: close); then the developer/profile/grant event relay finishes its send in progress
// (unsent rows stay in the outbox), analytics flush and close, the database and the Valkey connection
// close, and the process exits 0, within 10 s (well inside the unit's stop timeout). The email queue
// resumes on the next start.
const { gracefulStop, within } = require('openvibe-sdk/service');
gracefulStop({
    name: 'Network', server, drainMs: 8000, deadlineMs: 10000, deadlineExitCode: 1,
    stop: [
        () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } },
        () => ecosystem.stop(),
        () => deployDrift.stop(),
        () => libraryTags.stop(),
        () => frameService.stop(),
        () => require('./identity/profile-events').stop(),
        () => require('./identity/grants-admin').stop(),
        () => require('./developer/confirmations').stop(),
        () => telemetry.stop(),
    ],
    close: [
        () => within(1500, require('./developer/event-relay').stopRelay(db)),
        () => analytics.destroy().catch(() => {}),
        () => db.close(),
        () => valkey && valkey.close().catch(() => {}),
    ],
});

return { app, server };
})();
ready.catch((err) => {
    console.error('[Network] failed to start:', err);
    process.exit(1);
});

module.exports = { ready };
