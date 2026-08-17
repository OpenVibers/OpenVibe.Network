'use strict';

// ═══════════════════════════════════════════════════════════════
// Deploy Routes — Admin API for TLS / Nginx / Infrastructure
// Mounted at /api/admin/deploy. Requires admin role.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const certManager = require('./cert-manager');
const nginxGenerator = require('./nginx-generator');
const urlRegistry = require('../url-registry');
const { URL_DEFINITIONS } = require('openvibe-shared/url-resolver');

module.exports = function createDeployRoutes(db, requireAuth) {
    const router = express.Router();

    // Deploy touches TLS, nginx and live infrastructure — owner-only.
    const OWNER = (process.env.OWNER_USERNAME || 'goosely').toLowerCase();
    function requireAdmin(req, res, next) {
        const isOwner = req.user && req.user.username && req.user.username.toLowerCase() === OWNER;
        if (!req.user || req.user.role !== 'admin' || !isOwner) {
            return res.status(403).json({ ok: false, error: 'Owner access required' });
        }
        next();
    }

    function auditLog(req, action, details) {
        try {
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, action, JSON.stringify(details)
            );
        } catch (err) {
            console.error('[Deploy] Audit log error:', err.message);
        }
    }

    function getDeployConfig() {
        const resolved = urlRegistry.getResolvedRegistry(db, process.env);
        return {
            acmeEmail: resolved.DEPLOY_ACME_EMAIL?.value || '',
            certMode: resolved.DEPLOY_CERT_MODE?.value || 'manual',
            cloudflareToken: resolved.DEPLOY_CLOUDFLARE_TOKEN?.value || '',
            domains: resolved.DEPLOY_DOMAINS?.value || [],
            nginxMode: resolved.DEPLOY_NGINX_MODE?.value || 'preview',
            nginxSitesPath: resolved.DEPLOY_NGINX_SITES_PATH?.value || '/etc/nginx/sites-enabled',
            nginxBackupPath: resolved.DEPLOY_NGINX_BACKUP_PATH?.value || '/etc/nginx/sites-backup',
            serviceMap: resolved.DEPLOY_SERVICE_MAP?.value || null,
        };
    }

    router.use(requireAuth, requireAdmin);

    // ═══════════════════════════════════════════════════════
    // System Prerequisites
    // ═══════════════════════════════════════════════════════

    router.get('/prerequisites', (req, res) => {
        try {
            const prereqs = certManager.checkPrerequisites();
            const config = getDeployConfig();
            res.json({
                ok: true,
                prerequisites: prereqs,
                config: {
                    acmeEmail: config.acmeEmail,
                    certMode: config.certMode,
                    hasCloudflareToken: !!config.cloudflareToken,
                    nginxMode: config.nginxMode,
                    domainsConfigured: config.domains.length,
                },
            });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Deploy Configuration
    // ═══════════════════════════════════════════════════════

    router.get('/config', (req, res) => {
        try {
            const config = getDeployConfig();
            // Mask the Cloudflare token
            const masked = { ...config };
            if (masked.cloudflareToken && masked.cloudflareToken.length > 4) {
                masked.cloudflareToken = '••••' + masked.cloudflareToken.slice(-4);
            }
            res.json({ ok: true, config: masked });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.put('/config', (req, res) => {
        try {
            const allowedKeys = {
                acmeEmail: 'DEPLOY_ACME_EMAIL',
                certMode: 'DEPLOY_CERT_MODE',
                cloudflareToken: 'DEPLOY_CLOUDFLARE_TOKEN',
                domains: 'DEPLOY_DOMAINS',
                nginxMode: 'DEPLOY_NGINX_MODE',
                nginxSitesPath: 'DEPLOY_NGINX_SITES_PATH',
                nginxBackupPath: 'DEPLOY_NGINX_BACKUP_PATH',
                serviceMap: 'DEPLOY_SERVICE_MAP',
            };

            const updated = {};
            for (const [bodyKey, registryKey] of Object.entries(allowedKeys)) {
                if (!(bodyKey in req.body)) continue;
                const value = req.body[bodyKey];
                // Skip masked secrets
                if (registryKey === 'DEPLOY_CLOUDFLARE_TOKEN' && typeof value === 'string' && value.startsWith('••••')) {
                    continue;
                }
                // Validate cert mode
                if (registryKey === 'DEPLOY_CERT_MODE' && !['cloudflare', 'manual', 'none'].includes(value)) {
                    return res.status(400).json({ ok: false, error: 'certMode must be "cloudflare", "manual", or "none"' });
                }
                // Validate nginx mode
                if (registryKey === 'DEPLOY_NGINX_MODE' && !['preview', 'apply', 'disabled'].includes(value)) {
                    return res.status(400).json({ ok: false, error: 'nginxMode must be "preview", "apply", or "disabled"' });
                }
                const entry = urlRegistry.setRegistryEntry(db, registryKey, value, req.user.id);
                updated[bodyKey] = registryKey === 'DEPLOY_CLOUDFLARE_TOKEN' ? '(saved)' : entry.value;
            }

            auditLog(req, 'deploy_config_update', { keys: Object.keys(updated) });
            res.json({ ok: true, updated });
        } catch (err) {
            res.status(400).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Certificate Status
    // ═══════════════════════════════════════════════════════

    router.get('/certs', async (req, res) => {
        try {
            const status = await certManager.getCertificateStatus();
            const config = getDeployConfig();

            // Annotate certs with domain config
            for (const cert of status.certs) {
                const matchingDomain = config.domains.find(d =>
                    cert.domains?.includes(d.domain) || cert.domains?.includes(`*.${d.domain}`)
                );
                if (matchingDomain) {
                    cert.managedDomain = matchingDomain;
                }
            }

            res.json({ ok: true, ...status });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Certificate Issuance — Cloudflare Mode
    // ═══════════════════════════════════════════════════════

    router.post('/certs/issue-cloudflare', async (req, res) => {
        try {
            const { domain } = req.body;
            if (!domain) return res.status(400).json({ ok: false, error: 'domain is required' });

            const config = getDeployConfig();
            if (!config.acmeEmail) {
                return res.status(400).json({ ok: false, error: 'ACME email not configured. Set it in Deploy Config.' });
            }
            if (!config.cloudflareToken) {
                return res.status(400).json({ ok: false, error: 'Cloudflare token not configured. Set it in Deploy Config.' });
            }

            auditLog(req, 'cert_issue_cloudflare_start', { domain });

            const result = await certManager.issueWildcardCloudflare({
                domain,
                email: config.acmeEmail,
                cloudflareToken: config.cloudflareToken,
            });

            auditLog(req, 'cert_issue_cloudflare_result', {
                domain,
                ok: result.ok,
                certName: result.certName,
                error: result.error,
            });

            if (result.ok) {
                // Update domain config with cert name
                const domains = config.domains.map(d => {
                    if (d.domain === domain) return { ...d, certName: result.certName };
                    return d;
                });
                // If domain not in list, add it
                if (!domains.find(d => d.domain === domain)) {
                    domains.push({ domain, wildcard: true, certName: result.certName, services: [] });
                }
                urlRegistry.setRegistryEntry(db, 'DEPLOY_DOMAINS', domains, req.user.id);
            }

            res.json({ ok: result.ok, ...result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Certificate Issuance — Manual DNS Mode
    // ═══════════════════════════════════════════════════════

    router.post('/certs/manual-info', async (req, res) => {
        try {
            const { domain } = req.body;
            if (!domain) return res.status(400).json({ ok: false, error: 'domain is required' });

            const config = getDeployConfig();
            if (!config.acmeEmail) {
                return res.status(400).json({ ok: false, error: 'ACME email not configured' });
            }

            const result = await certManager.getManualChallengeInfo({
                domain,
                email: config.acmeEmail,
            });

            res.json({ ok: true, ...result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.post('/certs/issue-manual', async (req, res) => {
        try {
            const { domain } = req.body;
            if (!domain) return res.status(400).json({ ok: false, error: 'domain is required' });

            const config = getDeployConfig();
            if (!config.acmeEmail) {
                return res.status(400).json({ ok: false, error: 'ACME email not configured' });
            }

            auditLog(req, 'cert_issue_manual_start', { domain });

            const result = await certManager.issueWildcardManual({
                domain,
                email: config.acmeEmail,
            });

            auditLog(req, 'cert_issue_manual_result', {
                domain,
                ok: result.ok,
                certName: result.certName,
                error: result.error,
            });

            if (result.ok) {
                const domains = config.domains.map(d => {
                    if (d.domain === domain) return { ...d, certName: result.certName };
                    return d;
                });
                if (!domains.find(d => d.domain === domain)) {
                    domains.push({ domain, wildcard: true, certName: result.certName, services: [] });
                }
                urlRegistry.setRegistryEntry(db, 'DEPLOY_DOMAINS', domains, req.user.id);
            }

            res.json({ ok: result.ok, ...result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Certificate Renewal
    // ═══════════════════════════════════════════════════════

    router.post('/certs/renew', async (req, res) => {
        try {
            auditLog(req, 'cert_renew_start', {});
            const result = await certManager.renewCertificates();
            auditLog(req, 'cert_renew_result', { ok: result.ok, error: result.error });
            res.json({ ok: result.ok, ...result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Nginx Config Preview
    // ═══════════════════════════════════════════════════════

    router.get('/nginx/preview', (req, res) => {
        try {
            const resolved = urlRegistry.getResolvedRegistry(db, process.env);
            const configs = nginxGenerator.generateAllConfigs(resolved);
            res.json({
                ok: true,
                configs: configs.map(c => ({
                    serviceId: c.serviceId,
                    filename: c.filename,
                    content: c.content,
                    certFound: c.certFound,
                })),
            });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.get('/nginx/preview/:serviceId', (req, res) => {
        try {
            const resolved = urlRegistry.getResolvedRegistry(db, process.env);
            const configs = nginxGenerator.generateAllConfigs(resolved);
            const cfg = configs.find(c => c.serviceId === req.params.serviceId);
            if (!cfg) return res.status(404).json({ ok: false, error: 'Service not found' });
            res.json({ ok: true, ...cfg });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Nginx Validate
    // ═══════════════════════════════════════════════════════

    router.post('/nginx/validate', async (req, res) => {
        try {
            const result = await nginxGenerator.testNginxConfig();
            res.json({ ok: result.ok, ...result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Nginx Apply (write + validate + optional reload)
    // ═══════════════════════════════════════════════════════

    router.post('/nginx/apply', async (req, res) => {
        try {
            const config = getDeployConfig();
            if (config.nginxMode === 'disabled') {
                return res.status(400).json({ ok: false, error: 'Nginx management is disabled' });
            }

            const dryRun = config.nginxMode === 'preview' || req.body.dryRun === true;
            const reload = req.body.reload !== false && !dryRun;

            auditLog(req, 'nginx_apply_start', { dryRun, reload });

            const resolved = urlRegistry.getResolvedRegistry(db, process.env);
            const configs = nginxGenerator.generateAllConfigs(resolved);

            const result = await nginxGenerator.applyConfigs(configs, {
                sitesPath: config.nginxSitesPath,
                backupPath: config.nginxBackupPath,
                reload,
                dryRun,
            });

            auditLog(req, 'nginx_apply_result', {
                ok: result.ok,
                dryRun: result.dryRun,
                applied: result.applied,
                errors: result.errors,
            });

            res.json({ ok: result.ok, ...result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Nginx Reload (standalone)
    // ═══════════════════════════════════════════════════════

    router.post('/nginx/reload', async (req, res) => {
        try {
            // Validate first
            const validation = await nginxGenerator.testNginxConfig();
            if (!validation.ok) {
                return res.status(400).json({
                    ok: false,
                    error: 'Nginx config validation failed — will not reload',
                    validation,
                });
            }

            auditLog(req, 'nginx_reload', {});
            const result = await nginxGenerator.reloadNginx();
            res.json({ ok: result.ok, ...result, validation });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Managed Domains CRUD
    // ═══════════════════════════════════════════════════════

    router.get('/domains', (req, res) => {
        try {
            const config = getDeployConfig();
            // Annotate each domain with cert status
            const domains = (config.domains || []).map(d => {
                const cert = certManager.findBestCert(d.certName || d.domain);
                return {
                    ...d,
                    certExists: !!cert,
                    certPath: cert?.fullchain || null,
                    keyPath: cert?.privkey || null,
                    certName: cert?.certName || d.certName || d.domain,
                };
            });
            res.json({ ok: true, domains });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.put('/domains', (req, res) => {
        try {
            const { domains } = req.body;
            if (!Array.isArray(domains)) {
                return res.status(400).json({ ok: false, error: 'domains must be an array' });
            }
            // Validate each domain entry
            for (const d of domains) {
                if (!d.domain || typeof d.domain !== 'string') {
                    return res.status(400).json({ ok: false, error: 'Each domain entry must have a "domain" string' });
                }
                if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d.domain)) {
                    return res.status(400).json({ ok: false, error: `Invalid domain: ${d.domain}` });
                }
            }
            const entry = urlRegistry.setRegistryEntry(db, 'DEPLOY_DOMAINS', domains, req.user.id);
            auditLog(req, 'deploy_domains_update', { count: domains.length });
            res.json({ ok: true, domains: entry.value });
        } catch (err) {
            res.status(400).json({ ok: false, error: err.message });
        }
    });

    return router;
};
