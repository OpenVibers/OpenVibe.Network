'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — Main Server Entry Point
// Pure identity/account service for the OpenVibe network:
// SSO provider (OAuth2/OIDC), accounts, themes, notifications,
// admin, url-registry, OpenCoins wallet, and /shared assets.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
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

function ensureAdminUser(db, config) {
    const adminExists = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
    if (adminExists) return;
    const username = config.admin.username || (config.nodeEnv !== 'production' ? 'admin' : null);
    const password = config.admin.password || (config.nodeEnv !== 'production' ? 'admin' : null);
    if (!username || !password) {
        console.warn('[Setup] No admin user exists and ADMIN_USERNAME/PASSWORD are not configured. Setup routes remain available to complete bootstrap.');
        return;
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    db.prepare(`
        INSERT INTO users (username, email, password_hash, display_name, role, profile_color, subject_id)
        VALUES (?, ?, ?, ?, 'admin', '#8b5cf6', ?)
        ON CONFLICT(username) DO UPDATE SET role = 'admin', password_hash = excluded.password_hash
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
                upstreamToken = signToken(req.user, req.app.locals.privateKey, req.app.locals.config);
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
            scriptSrc: ["'self'", "'unsafe-inline'", "https://openvibe.network", "https://openvibe.live", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"],
            fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: [
                "'self'",
                "https://openvibe.network",
                "https://openvibe.live",
                "https://openvibe.tools", "https://*.openvibe.tools",
                "https://openvibe.games", "https://play.openvibe.games",
                "https://openvibe.media",
                "https://openvibe.community",
                "https://openvibe.blog",
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
app.use(express.json({ limit: '1mb' }));
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
const db = initDb(config.db.path);
urlRegistry.initializeUrlRegistry(db);
urlRegistry.seedBootstrapRegistry(db, process.env, config.bootstrapProfile);
ensureAdminUser(db, config);
const resolvedRegistry = urlRegistry.getResolvedRegistry(db, process.env);

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
// openvibe-shared/analytics; same tables in network.db, on a connection of the tracker's own
// (server/analytics/network.js). Raw rows: route template, rotating session id, user-agent class,
// referer origin; never an IP or a user id. A Sec-GPC: 1 / DNT: 1 request is not recorded. Pruned after
// 30 days by the analytics-prune job below; rollups are kept.
const analytics = networkAnalytics.openAnalytics(config.db.path);
app.locals.analytics = analytics;
app.use(analytics.middleware());

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
app.locals.publicKey = publicKey;
app.locals.config = config;

// Provider secrets: environment first, database fallback (server/secrets.js). Names and sources only.
console.log(`[Secrets] ${require('./secrets').summary(db)}`);

// ── Initialize Services ──────────────────────────────────────
const notificationService = new NotificationService(db);
const emailService = new EmailService(db);
app.locals.notificationService = notificationService;
app.locals.emailService = emailService;
// live.stream.started: the followers are read from Live (its follow graph) with Network's own service token.
const liveFollowers = privateKey.includes('BEGIN')
    ? require('./notifications/live-followers').createLiveFollowers({ privateKey, issuer: config.jwt.issuer, liveUrl: config.services.live.internalUrl })
    : null;
// The moderation audit log (ADR-022): staff actions every service reports, readable by staff.
const moderationAudit = require('./admin/moderation-audit').createModerationAudit(db);
eventsConsumer = require('./notifications/events-consumer').createEventsConsumer({
    db, notifications: notificationService, secrets: config.eventsWebhookSecrets,
    liveFollowers, discord: () => app.locals.discordService || null, moderationAudit,
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
app.get('/api/v1/users/names/:name', rateLimit({ windowMs: 60_000, max: 240 }), (req, res) => {
    const rec = require('./identity/usernames').lookup(db, req.params.name);
    res.set('Cache-Control', 'public, max-age=120');
    if (!rec) return res.status(404).json({ error: 'not_found' });
    res.json(rec);
});
// The GitHub token (admin → Settings → GitHub, or GITHUB_TOKEN): owner-only admin, and Blog's changelog reads it.
app.use('/api/admin/integrations/github', requireAuth, require('./integrations/github').adminRouter(db));
app.get('/internal/integrations/github-token', require('./identity/principals').guard('network.integration.github.read', { legacy: false }), require('./integrations/github').internalHandler(db));
// Platform blocks (WS-E task 5): a person's own list, and who blocked whom for Chat and Community
// (network.blocks.read, service token only). Every change is network.block.changed (server/identity/blocks.js).
app.use('/api/v1/me/blocks', rateLimit({ windowMs: 60_000, max: 60 }), require('./identity/blocks').userRouter(requireAuth));
app.get('/internal/blocks', require('./identity/principals').guard('network.blocks.read', { legacy: false }), require('./identity/blocks').internalHandler(db));

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
require('./registry/deploy-drift').createDeployDrift({
    services: () => ecosystem.releases().services.filter((r) => r.release).map((r) => ({ id: r.id, release: r.release, repository: ((require('openvibe-contracts').services.manifests.find((m) => m.id === r.id)) || {}).repository })),
    token: () => process.env.GITHUB_TOKEN || require('./integrations/github').tokenOf(db) || '',
}).start();
app.use(ecosystem.router());
ecosystem.start();
// The released libraries' latest published tags (not the versions Network installs) for the registry.
require('./registry/library-tags').createLibraryTags({ onUpdate: require('./registry/exposure').setLibraryReleases, token: () => require('./integrations/github').tokenOf(db) }).start();
// Operator status: GET /status (server-rendered, noindex), /api/v1/status, /api/v1/status/slo.
app.use(require('./status/routes').createStatusRoutes({ ecosystem }));
// What shipped network-wide: the changelog proxy every site's widget reads, and /updates.
app.use(require('./updates/routes').createUpdatesRoutes({ blogUrl: process.env.OV_BLOG_INTERNAL_URL || 'http://127.0.0.1:4810' }).router);

app.get('/api/.well-known/jwks', (_req, res) => {
    const out = { public_key: publicKey, algorithm: privateKey === publicKey ? 'HS256' : 'RS256' };
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
// Their network.app.* / credential / grant events go to OpenVibe.Events through an outbox when
// OV_EVENTS_INTERNAL_URL is set (server/developer/event-relay.js); off otherwise.
require('./developer/event-relay').startRelay(db, { eventsUrl: config.eventsInternalUrl, privateKey, issuer: config.jwt.issuer });
// network.user.updated (WS-B task 2): profile, role and ban changes, recorded by triggers on users and relayed
// through the same outbox (server/identity/profile-events.js).
require('./identity/profile-events').start(db);
require('./identity/grants-admin').start(db);

// Notification API (authenticated users)
app.use('/api/notifications', createNotificationRoutes(db, notificationService, requireAuth));

// Push Notifications API
const pushService = require('./push/push-service');
pushService.initVapid(db);
app.use('/api/push', requireAuth, require('./push/routes'));

// Cross-site history (what the account touched anywhere on the network)
app.use('/api/history', rateLimit({ windowMs: 60_000, max: 60 }), require('./history/routes').createHistoryRoutes(db, requireAuth));

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
const avatarService = require('./profile/avatar').createAvatarService({ db, config, requireAuth });
app.use('/api/profile/avatar', rateLimit({ windowMs: 60_000, max: 20 }), avatarService.api);
app.use('/avatar', rateLimit({ windowMs: 60_000, max: 600 }), avatarService.pub);
app.locals.avatarService = avatarService;

// The OpenVibe Frame: analytics-ranked navigation + footer copy for every site (server/frame).
// /api/chrome is the old name, kept for copies of openvibe-shared older than 1.11.0.
const frameService = require('./frame/service').createFrameService(db, config, analytics, { privateKey, issuer: config.jwt.issuer });
const frameLimit = rateLimit({ windowMs: 60_000, max: 240 });
app.use('/api/frame', frameLimit, frameService.router);
app.use('/api/chrome', frameLimit, frameService.router);
frameService.start();
// /api/v1/registry/featured follows the navigation's usage ranking.
ecosystem.setRanking(() => frameService.ranking());

// Tool domains: public list for the Tools gateway, owner-only management (docs/shared-contracts.md §1).
const toolDomains = require('./domains/routes').createDomainRoutes(db, requireAuth);
app.use('/api/domains', rateLimit({ windowMs: 60_000, max: 120 }), toolDomains.publicRouter);
app.use('/api/admin/domains', toolDomains.adminRouter);
app.use('/api/admin/discord', createDiscordRoutes(db, discordService, requireAuth, requireAdmin));

// Deploy (TLS / Nginx / Infrastructure) admin API
app.use('/api/admin/deploy', createDeployRoutes(db, requireAuth));

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
app.use('/api/admin', createAdminRoutes(db, notificationService, emailService, requireAuth));

// Analytics admin API
const createAnalyticsRoutes = require('./admin/analytics-routes');
app.use('/api/admin/analytics', createAnalyticsRoutes(analytics, requireAuth, config));

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
    return proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/admin${req.url}`, 'Streamer proxy error');
});

// Proxy /api/mod/* for moderator routes
app.use('/api/admin/streamer-mod', requireAuth, (req, res, next) => {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'global_mod')) {
        return res.status(403).json({ error: 'Staff access required' });
    }
    next();
}, async (req, res) => {
    return proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/mod${req.url}`, 'Mod proxy error');
});

app.use('/api/admin/streamer-tts', requireAuth, (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}, async (req, res) => {
    return proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/tts${req.url}`, 'TTS proxy error');
});

app.use('/api/admin/streamer-funds', requireAuth, (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}, async (req, res) => {
    return proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/funds${req.url}`, 'Funds proxy error');
});

app.use('/api/admin/streamer-pastes', requireAuth, (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}, async (req, res) => {
    return proxyJsonRequest(req, res, `${OPENVIBELIVE_INTERNAL}/api/pastes${req.url}`, 'Pastes proxy error');
});

// Internal API (server-to-server, X-Internal-Key)
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
app.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(require('./home/render').llmsTxt()));

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
    res.setHeader('Cache-Control', req.query.v === sharedRev.get(name) ? 'public, max-age=31536000, immutable' : 'public, max-age=300, stale-while-revalidate=60');
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
app.listen(config.port, config.host, () => {
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
    setInterval(() => notificationService.maintenance(), 60 * 60 * 1000);

    // Process email queue every 2 minutes
    setInterval(() => emailService.processQueue(notificationService), 2 * 60 * 1000);

    // Raw analytics retention (ADR-021), job analytics-prune: events older than 30 days go, in
    // bounded batches; hourly/daily rollups stay. First run 5 minutes after boot, then every 24 h.
    networkAnalytics.schedulePrune(analytics);

    // User modules of a retired owning service (onOwnerRemoved, server/identity/modules.js): writes stop at
    // once; delete-after-retention records go retentionDays after Network first saw the retirement.
    const sweepModules = () => {
        try {
            const n = require('./identity/modules').sweepRetired(db);
            if (n) console.log(`[Modules] Deleted ${n} record(s) of retired namespace owners`);
        } catch (e) { console.warn('[Modules] retired-owner sweep:', e.message); }
    };
    setTimeout(sweepModules, 5 * 60 * 1000);
    setInterval(sweepModules, 24 * 60 * 60 * 1000);

    // Clean expired sessions daily
    setInterval(() => {
        const cleaned = db.prepare("DELETE FROM user_sessions WHERE expires_at < datetime('now') OR is_active = 0").run().changes;
        if (cleaned > 0) console.log(`[Sessions] Cleaned ${cleaned} expired sessions`);
    }, 24 * 60 * 60 * 1000);
});
