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
const { AnalyticsTracker } = require('openvibe-shared/analytics');
const { DiscordService } = require('./discord/discord-service');
const createDiscordRoutes = require('./discord/routes');
const createDeployRoutes = require('./deploy/routes');
const createCoinsRoutes = require('./coins/routes');
const { signToken } = require('./auth/routes');

const app = express();

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
        INSERT INTO users (username, email, password_hash, display_name, role, profile_color)
        VALUES (?, ?, ?, ?, 'admin', '#8b5cf6')
        ON CONFLICT(username) DO UPDATE SET role = 'admin', password_hash = excluded.password_hash
    `).run(username, null, passwordHash, username);
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
            ],
            frameSrc: ["'none'"],
            scriptSrcAttr: ["'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
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

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true); // non-browser / server-to-server
        if (isAllowedOrigin(origin)) return callback(null, true);
        console.warn(`[CORS] Rejected origin: "${origin}" | allowed set: ${[...buildAllowedOriginsSet()].join(', ')} | subdomainBase: ${getToolsSubdomainBase()}`);
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
}));

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

// ── Analytics Tracking ────────────────────────────────────────
const analytics = new AnalyticsTracker(db, 'openvibe-network');
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

// ── Initialize Services ──────────────────────────────────────
const notificationService = new NotificationService(db);
const emailService = new EmailService(db);
app.locals.notificationService = notificationService;
app.locals.emailService = emailService;

// Discord bot service
const discordService = new DiscordService(db);
app.locals.discordService = discordService;
discordService.init().catch(err => console.error('[Discord] Init error:', err.message));

// requireAuth helper (needed by route factories)
const authRoutes = require('./auth/routes');
const jwt = require('jsonwebtoken');
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.ov_token;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const algorithm = publicKey.includes('BEGIN') ? 'RS256' : 'HS256';
    try {
        const decoded = jwt.verify(token, publicKey, { algorithms: [algorithm], issuer: config.jwt.issuer });
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub || decoded.id);
        if (!user) return res.status(401).json({ error: 'User not found' });
        if (user.is_banned) return res.status(403).json({ error: 'Account banned', ban_reason: user.ban_reason });
        if (user.token_valid_after) {
            const tokenIat = decoded.iat * 1000;
            const validAfter = new Date(user.token_valid_after + (user.token_valid_after.includes('Z') ? '' : 'Z')).getTime();
            if (tokenIat < validAfter) return res.status(401).json({ error: 'Token revoked' });
        }
        req.user = user;
        req.token = token;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ── Routes ───────────────────────────────────────────────────
// Public key endpoint (services fetch this to verify JWTs).
// Serves BOTH the standard JWKS `keys` array (RFC 7517 — Media and other
// spec-compliant consumers) and the legacy `public_key` PEM shape that the
// inherited service clients read.
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

// Brand info (used by all frontends for consistent URLs/names)
app.get('/api/brand', (_req, res) => res.json(BRAND));

// Auth routes (SSO provider)
app.use('/api/auth', authRoutes);

// Discord account linking (OAuth2 flow)
app.use('/api/auth/discord', requireAuth, require('./auth/discord-link'));

// OAuth2 authorization endpoints
app.use('/oauth', require('./auth/oauth-routes'));

// Theme API
app.use('/api/themes', require('./themes/routes'));

// OpenCoins wallet API (user-facing, Bearer JWT)
app.use('/api/coins', createCoinsRoutes(db, requireAuth));

// Notification API (authenticated users)
app.use('/api/notifications', createNotificationRoutes(db, notificationService, requireAuth));

// Push Notifications API
const pushService = require('./push/push-service');
pushService.initVapid(db);
app.use('/api/push', requireAuth, require('./push/routes'));

// Discord bot admin API
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}
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
    return sendLandingPage(res);
});

// Account hub (my.html) — the apex hosts the account hub under /my
// plus its client-routed sections.
app.get(['/my', '/my.html', '/themes', '/notifications', '/linked', '/security', '/profile', '/billing', '/preferences'], (req, res) => {
    if (req.path === '/my.html') return redirectWithoutHtml(req, res, '/my');
    return sendMyAccountApp(res);
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    },
}));

// Serve openvibe-shared client-side libs (notification-ui.js, navbar.js, etc.)
// Accessible at https://openvibe.network/shared/notification-ui.js etc.
const sharedPath = path.resolve(__dirname, '..', 'packages', 'openvibe-shared');
app.use('/shared', express.static(sharedPath, {
    setHeaders(res, filePath) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        // Override helmet's same-origin policies so other domains can load these scripts
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
        res.setHeader('Cache-Control', 'public, max-age=300');
    },
}));

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

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    // Unknown paths fall through to the account hub SPA (apex is the account-hub host)
    return sendMyAccountApp(res);
});

// ── Start ────────────────────────────────────────────────────
app.listen(config.port, config.host, () => {
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

    // Clean expired sessions daily
    setInterval(() => {
        const cleaned = db.prepare("DELETE FROM user_sessions WHERE expires_at < datetime('now') OR is_active = 0").run().changes;
        if (cleaned > 0) console.log(`[Sessions] Cleaned ${cleaned} expired sessions`);
    }, 24 * 60 * 60 * 1000);
});
