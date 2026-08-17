'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const urlRegistry = require('../url-registry');
const { URL_DEFINITIONS } = require('openvibe-shared/url-resolver');
const certManager = require('../deploy/cert-manager');
const { isSensitiveSettingKey, maskSecret } = require('../auth/owner-guard');

// The setup status is served UNAUTHENTICATED — never leak secret registry
// values (e.g. DEPLOY_CLOUDFLARE_TOKEN) in it.
function redactResolvedRegistry(resolved) {
    if (!resolved || typeof resolved !== 'object') return resolved;
    const out = {};
    for (const [key, entry] of Object.entries(resolved)) {
        if (entry && typeof entry === 'object' && 'value' in entry &&
            (entry.type === 'secret' || isSensitiveSettingKey(key))) {
            out[key] = { ...entry, value: entry.value ? maskSecret(entry.value) : entry.value, redacted: true };
        } else {
            out[key] = entry;
        }
    }
    return out;
}

function createSetupRoutes(db, config) {
    const router = express.Router();

    function hasAdminUser() {
        return !!db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
    }

    function isValidSetupToken(req) {
        const token = req.headers['x-setup-token'] || req.body?.setup_token || req.query?.setup_token;
        return config.setupToken && token && token === config.setupToken;
    }

    function requireSetupMode(req, res, next) {
        if (!hasAdminUser()) return next();
        if (isValidSetupToken(req)) return next();
        return res.status(403).json({ ok: false, error: 'Setup locked. Provide a valid setup token or log in as an admin.' });
    }

    function getSetupWarnings(resolvedRegistry) {
        const warnings = [];
        const firstPartyUrl = resolvedRegistry.OV_NETWORK_URL?.value;
        if (config.nodeEnv === 'production') {
            if (!firstPartyUrl) {
                warnings.push('OV_NETWORK_URL is not configured. Public production hosts are required.');
            } else if (firstPartyUrl.startsWith('http://')) {
                warnings.push('OV_NETWORK_URL is using HTTP in production. Use HTTPS for public OpenVibe.Tools access.');
            }
            if (!resolvedRegistry.OV_NETWORK_INTERNAL_URL?.value) {
                warnings.push('OV_NETWORK_INTERNAL_URL is not configured. Services cannot reach the internal API.');
            }
            if (!resolvedRegistry.OV_LIVE_INTERNAL_URL?.value) {
                warnings.push('OV_LIVE_INTERNAL_URL is not configured. OpenVibe.Tools cannot notify OpenVibe.Live of config refreshes.');
            }
            if (resolvedRegistry.MEDIASOUP_ANNOUNCED_IP?.value && ['127.0.0.1', 'localhost'].includes(resolvedRegistry.MEDIASOUP_ANNOUNCED_IP.value)) {
                warnings.push('MEDIASOUP_ANNOUNCED_IP is set to a local address in production. External WebRTC clients may fail to connect.');
            }
            if (!config.internalKey || config.internalKey === 'change-me-in-production') {
                warnings.push('INTERNAL_API_KEY is not configured or using an insecure default. Internal service communication must be protected.');
            }
        }
        return warnings;
    }

    function getSetupIssues(resolvedRegistry) {
        const required = [
            'OV_NETWORK_URL',
            'OV_NETWORK_INTERNAL_URL',
            'OV_LIVE_INTERNAL_URL',
        ];
        return required.filter(key => !resolvedRegistry[key]?.value).map(key => `${key} is missing or invalid.`);
    }

    function buildSetupStatus() {
        const resolvedRegistry = urlRegistry.getResolvedRegistry(db, process.env);
        return {
            adminExists: hasAdminUser(),
            setupTokenConfigured: Boolean(config.setupToken),
            registrySeeded: urlRegistry.isRegistrySeeded(db),
            bootstrapProfile: config.bootstrapProfile,
            warnings: getSetupWarnings(resolvedRegistry),
            issues: getSetupIssues(resolvedRegistry),
            resolvedRegistry: redactResolvedRegistry(resolvedRegistry),
        };
    }

    router.get('/status', (req, res) => {
        try {
            res.json({ ok: true, status: buildSetupStatus() });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.post('/bootstrap', requireSetupMode, (req, res) => {
        try {
            const profile = String(req.body.profile || config.bootstrapProfile || 'local-dev');
            const validProfiles = ['local-dev', 'single-node-prod'];
            if (!validProfiles.includes(profile)) {
                return res.status(400).json({ ok: false, error: 'Invalid bootstrap profile' });
            }
            urlRegistry.seedBootstrapRegistry(db, process.env, profile);
            const status = buildSetupStatus();
            return res.json({ ok: true, message: 'Bootstrap completed', status });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.post('/admin', requireSetupMode, (req, res) => {
        try {
            const { username, password } = req.body;
            if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password are required' });
            if (hasAdminUser() && !isValidSetupToken(req)) {
                return res.status(403).json({ ok: false, error: 'Admin account already exists' });
            }
            const normalizedUsername = String(username).trim().toLowerCase();
            const passwordHash = bcrypt.hashSync(String(password), 10);
            db.prepare(`
                INSERT INTO users (username, email, password_hash, display_name, role, profile_color)
                VALUES (?, ?, ?, ?, 'admin', '#8b5cf6')
                ON CONFLICT(username) DO UPDATE SET
                    password_hash = excluded.password_hash,
                    role = 'admin'
            `).run(normalizedUsername, null, passwordHash, normalizedUsername);
            return res.json({ ok: true, message: 'Admin account created' });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ── Brand identity setup ─────────────────────────────────
    // POST /api/setup/identity — configure network/service names and subdomain base.
    // These drive white-label installs: CORS wildcard patterns, brand display names, etc.
    // Accepted fields (all optional, only provided fields are written):
    //   network_name       → NETWORK_NAME       (e.g. "OpenVibe")
    //   tools_service_name → TOOLS_SERVICE_NAME (e.g. "OpenVibe.Tools")
    //   streamer_service_name → STREAMER_SERVICE_NAME (e.g. "OpenVibe.Live")
    //   tools_subdomain_base  → TOOLS_SUBDOMAIN_BASE (e.g. "openvibe.tools")
    //   extra_origins      → ALLOWED_EXTRA_ORIGINS (array of additional CORS origins)
    const IDENTITY_FIELD_MAP = {
        network_name: 'NETWORK_NAME',
        tools_service_name: 'TOOLS_SERVICE_NAME',
        streamer_service_name: 'STREAMER_SERVICE_NAME',
        tools_subdomain_base: 'TOOLS_SUBDOMAIN_BASE',
        extra_origins: 'ALLOWED_EXTRA_ORIGINS',
    };
    router.post('/identity', requireSetupMode, (req, res) => {
        try {
            const updated = {};
            for (const [bodyKey, registryKey] of Object.entries(IDENTITY_FIELD_MAP)) {
                if (!(bodyKey in req.body)) continue;
                const raw = req.body[bodyKey];
                let value = raw;
                if (registryKey === 'ALLOWED_EXTRA_ORIGINS') {
                    const origins = Array.isArray(raw)
                        ? raw
                        : String(raw).split(',').map(s => s.trim()).filter(Boolean);
                    for (const o of origins) {
                        try { new URL(o); } catch {
                            return res.status(400).json({ ok: false, error: `Invalid origin URL: ${o}` });
                        }
                    }
                    value = origins;
                }
                if (registryKey === 'TOOLS_SUBDOMAIN_BASE' && value != null) {
                    const stringValue = String(value).trim();
                    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(stringValue)) {
                        return res.status(400).json({ ok: false, error: `Invalid subdomain base: ${stringValue}. Expected a bare hostname like "openvibe.tools"` });
                    }
                    value = stringValue;
                }
                if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
                    continue;
                }
                const entry = urlRegistry.setRegistryEntry(db, registryKey, value, null);
                updated[registryKey] = entry.value;
            }
            return res.json({ ok: true, updated, message: 'Identity config saved' });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ── URL config setup ─────────────────────────────────────
    // POST /api/setup/urls — configure network URLs during first-time setup.
    // Writes the provided values into the url_registry with source='admin'.
    // Only keys that exist in URL_DEFINITIONS are accepted.
    router.post('/urls', requireSetupMode, (req, res) => {
        try {
            const allowedKeys = new Set(Object.keys(URL_DEFINITIONS));
            const updated = {};
            const rejected = {};
            for (const [key, value] of Object.entries(req.body)) {
                if (!allowedKeys.has(key)) {
                    rejected[key] = 'unknown registry key';
                    continue;
                }
                try {
                    const entry = urlRegistry.setRegistryEntry(db, key, value, null);
                    updated[key] = entry.value;
                } catch (err) {
                    rejected[key] = err.message;
                }
            }
            const status = buildSetupStatus();
            return res.json({ ok: true, updated, rejected, status });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ── Deploy / Infrastructure Setup ────────────────────────
    // POST /api/setup/deploy — configure TLS, domain, and reverse-proxy settings.
    // Captures the deploy-level infrastructure state needed to provision
    // certificates and generate Nginx configs without manual SSH.
    //
    // Accepted fields:
    //   acme_email        → DEPLOY_ACME_EMAIL
    //   cert_mode         → DEPLOY_CERT_MODE ("cloudflare" | "manual" | "none")
    //   cloudflare_token  → DEPLOY_CLOUDFLARE_TOKEN
    //   domains           → DEPLOY_DOMAINS (array of domain objects)
    //   nginx_mode        → DEPLOY_NGINX_MODE ("preview" | "apply" | "disabled")
    //   service_map       → DEPLOY_SERVICE_MAP (override port/domain mappings)

    const DEPLOY_FIELD_MAP = {
        acme_email: 'DEPLOY_ACME_EMAIL',
        cert_mode: 'DEPLOY_CERT_MODE',
        cloudflare_token: 'DEPLOY_CLOUDFLARE_TOKEN',
        domains: 'DEPLOY_DOMAINS',
        nginx_mode: 'DEPLOY_NGINX_MODE',
        service_map: 'DEPLOY_SERVICE_MAP',
    };

    router.post('/deploy', requireSetupMode, (req, res) => {
        try {
            const updated = {};
            const errors = {};

            for (const [bodyKey, registryKey] of Object.entries(DEPLOY_FIELD_MAP)) {
                if (!(bodyKey in req.body)) continue;
                const value = req.body[bodyKey];

                // Validate cert_mode
                if (registryKey === 'DEPLOY_CERT_MODE' && !['cloudflare', 'manual', 'none'].includes(value)) {
                    errors[bodyKey] = 'Must be "cloudflare", "manual", or "none"';
                    continue;
                }

                // Validate nginx_mode
                if (registryKey === 'DEPLOY_NGINX_MODE' && !['preview', 'apply', 'disabled'].includes(value)) {
                    errors[bodyKey] = 'Must be "preview", "apply", or "disabled"';
                    continue;
                }

                // Validate domains array
                if (registryKey === 'DEPLOY_DOMAINS') {
                    if (!Array.isArray(value)) {
                        errors[bodyKey] = 'Must be an array of domain objects';
                        continue;
                    }
                    for (const d of value) {
                        if (!d.domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d.domain)) {
                            errors[bodyKey] = `Invalid domain: ${d.domain}`;
                            break;
                        }
                    }
                    if (errors[bodyKey]) continue;
                }

                // Validate ACME email
                if (registryKey === 'DEPLOY_ACME_EMAIL' && value) {
                    if (typeof value !== 'string' || !value.includes('@')) {
                        errors[bodyKey] = 'Must be a valid email address';
                        continue;
                    }
                }

                if (value === undefined || value === null) continue;

                try {
                    const entry = urlRegistry.setRegistryEntry(db, registryKey, value, null);
                    updated[registryKey] = registryKey === 'DEPLOY_CLOUDFLARE_TOKEN' ? '(saved)' : entry.value;
                } catch (err) {
                    errors[bodyKey] = err.message;
                }
            }

            // Return prerequisites check alongside the config save
            const prereqs = certManager.checkPrerequisites();

            return res.json({
                ok: Object.keys(errors).length === 0,
                updated,
                errors: Object.keys(errors).length > 0 ? errors : undefined,
                prerequisites: prereqs,
                message: 'Deploy config saved',
            });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // GET /api/setup/deploy-status — check deploy prerequisites and current config
    router.get('/deploy-status', (req, res) => {
        try {
            const resolved = urlRegistry.getResolvedRegistry(db, process.env);
            const prereqs = certManager.checkPrerequisites();

            res.json({
                ok: true,
                prerequisites: prereqs,
                config: {
                    acmeEmail: resolved.DEPLOY_ACME_EMAIL?.value || '',
                    certMode: resolved.DEPLOY_CERT_MODE?.value || 'manual',
                    hasCloudflareToken: !!(resolved.DEPLOY_CLOUDFLARE_TOKEN?.value),
                    domains: resolved.DEPLOY_DOMAINS?.value || [],
                    nginxMode: resolved.DEPLOY_NGINX_MODE?.value || 'preview',
                },
            });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    return router;
}

module.exports = createSetupRoutes;
