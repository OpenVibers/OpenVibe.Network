'use strict';

// ═══════════════════════════════════════════════════════════════
// Admin Panel — API Routes
// Mounted at /api/admin. Requires admin role.
// Manages email config, site settings, user management, bulk
// notifications, and system health.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const urlRegistry = require('../url-registry');
const { URL_DEFINITIONS } = require('openvibe-shared/url-resolver');
const { isOwner, requireOwner, isSensitiveSettingKey, maskSecret } = require('../auth/owner-guard');
const { checkAdminLimit, recordAdminAction } = require('../auth/admin-limits');

const LOCAL_REFRESH_SERVICES = new Set(['network']);

function getServiceRefreshInfo(req, serviceName) {
    const servicesCfg = req.app.locals.config?.services || {};
    const serviceCfg = servicesCfg[serviceName];

    if (serviceName === 'network') {
        return {
            service: serviceName,
            configured: true,
            mode: 'local',
            target: null,
            description: 'Local OpenVibe.Network registry refresh',
        };
    }

    if (!serviceCfg || !serviceCfg.internalUrl) {
        return {
            service: serviceName,
            configured: false,
            mode: 'not_configured',
            target: null,
            description: 'Service is not configured for refresh',
        };
    }

    return {
        service: serviceName,
        configured: true,
        mode: 'remote',
        target: serviceCfg.internalUrl.replace(/\/?$/, '') + '/internal/url-registry/refresh',
        description: `Remote refresh target for ${serviceName}`,
    };
}

function applyResolvedRegistryToConfig(config, resolved) {
    if (!resolved || typeof resolved !== 'object') return;
    if (resolved.OV_NETWORK_URL?.value) {
        config.networkUrl = resolved.OV_NETWORK_URL.value;
        config.jwt.issuer = resolved.OV_NETWORK_URL.value;
        if (!process.env.BASE_URL) config.baseUrl = resolved.OV_NETWORK_URL.value;
    }
    if (resolved.OV_NETWORK_LOGIN_URL?.value) {
        config.loginUrl = resolved.OV_NETWORK_LOGIN_URL.value;
    }
    if (resolved.OV_NETWORK_INTERNAL_URL?.value) {
        config.internalUrl = resolved.OV_NETWORK_INTERNAL_URL.value;
    }
    if (resolved.OV_LIVE_INTERNAL_URL?.value && config.services.live) config.services.live.internalUrl = resolved.OV_LIVE_INTERNAL_URL.value;
    if (resolved.OV_TOOLS_INTERNAL_URL?.value && config.services.tools) config.services.tools.internalUrl = resolved.OV_TOOLS_INTERNAL_URL.value;
    if (resolved.OV_GAMES_INTERNAL_URL?.value && config.services.games) config.services.games.internalUrl = resolved.OV_GAMES_INTERNAL_URL.value;
    if (resolved.OV_MEDIA_INTERNAL_URL?.value && config.services.media) config.services.media.internalUrl = resolved.OV_MEDIA_INTERNAL_URL.value;
}

async function refreshService(req, serviceName) {
    const info = getServiceRefreshInfo(req, serviceName);
    if (info.mode === 'local') {
        try {
            const db = req.app.locals.db;
            const config = req.app.locals.config;
            const resolved = urlRegistry.getResolvedRegistry(db, process.env);
            req.app.locals.urlRegistry = resolved;
            applyResolvedRegistryToConfig(config, resolved);
            return {
                ok: true,
                service: serviceName,
                mode: 'local',
                status: 200,
                target: null,
                message: 'Local registry refresh completed',
            };
        } catch (err) {
            return {
                ok: false,
                service: serviceName,
                mode: 'local',
                status: 500,
                target: null,
                error: err.message,
            };
        }
    }

    if (info.mode === 'not_configured') {
        return {
            ok: false,
            service: serviceName,
            mode: 'not_configured',
            status: null,
            target: null,
            error: 'Service is not configured for refresh',
        };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
        const r = await fetch(info.target, {
            method: 'POST',
            headers: { 'X-Internal-Key': req.app.locals.config?.internalKey || '' },
            signal: controller.signal,
        });
        const baseResult = {
            ok: r.ok,
            service: serviceName,
            mode: 'remote',
            status: r.status,
            target: info.target,
        };
        if (r.ok) return baseResult;
        if (r.status === 404) {
            return {
                ...baseResult,
                ok: false,
                mode: 'unsupported',
                error: 'Refresh endpoint not supported',
            };
        }
        return {
            ...baseResult,
            ok: false,
            error: `Refresh failed with status ${r.status}`,
        };
    } catch (err) {
        return {
            ok: false,
            service: serviceName,
            mode: 'failed',
            status: null,
            target: info.target,
            error: err.message,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function refreshServiceByKey(req, key) {
    const def = URL_DEFINITIONS[key];
    const serviceName = def?.service;
    if (!serviceName) {
        return { ok: false, service: null, mode: 'unknown', error: `No service defined for key ${key}` };
    }
    return refreshService(req, serviceName);
}

function createAdminRoutes(db, notificationService, emailService, requireAuth) {

    function getEmailMetrics() {
        const summary = {
            total: db.prepare('SELECT COUNT(*) AS count FROM email_delivery_log').get().count,
            sent: db.prepare("SELECT COUNT(*) AS count FROM email_delivery_log WHERE status = 'sent'").get().count,
            failed: db.prepare("SELECT COUNT(*) AS count FROM email_delivery_log WHERE status = 'failed'").get().count,
            sent_24h: db.prepare("SELECT COUNT(*) AS count FROM email_delivery_log WHERE status = 'sent' AND created_at >= datetime('now', '-1 day')").get().count,
            failed_24h: db.prepare("SELECT COUNT(*) AS count FROM email_delivery_log WHERE status = 'failed' AND created_at >= datetime('now', '-1 day')").get().count,
            password_resets_24h: db.prepare("SELECT COUNT(*) AS count FROM email_delivery_log WHERE email_type = 'password_reset' AND created_at >= datetime('now', '-1 day')").get().count,
            notifications_24h: db.prepare("SELECT COUNT(*) AS count FROM email_delivery_log WHERE email_type LIKE 'notification:%' AND created_at >= datetime('now', '-1 day')").get().count,
            tests_24h: db.prepare("SELECT COUNT(*) AS count FROM email_delivery_log WHERE email_type = 'test' AND created_at >= datetime('now', '-1 day')").get().count,
            last_sent_at: db.prepare("SELECT created_at FROM email_delivery_log WHERE status = 'sent' ORDER BY created_at DESC LIMIT 1").get()?.created_at || null,
            last_failed_at: db.prepare("SELECT created_at FROM email_delivery_log WHERE status = 'failed' ORDER BY created_at DESC LIMIT 1").get()?.created_at || null,
        };

        const byType = db.prepare(`
            SELECT email_type, status, COUNT(*) AS count
            FROM email_delivery_log
            WHERE created_at >= datetime('now', '-30 day')
            GROUP BY email_type, status
            ORDER BY count DESC, email_type ASC
            LIMIT 20
        `).all();

        const recent = db.prepare(`
            SELECT id, email_type, recipient, subject, status, error_message, created_at
            FROM email_delivery_log
            ORDER BY created_at DESC
            LIMIT 20
        `).all();

        return { summary, by_type: byType, recent };
    }

    // ─── Admin middleware ──────────────────────────────────
    function requireAdmin(req, res, next) {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ ok: false, error: 'Admin access required' });
        }
        next();
    }

    async function notifyServiceRefresh(req, key) {
        return refreshServiceByKey(req, key);
    }

    // Push an authoritative role change to OpenVibe.Live so it takes effect
    // immediately (chat Staff badge, moderation powers) instead of waiting on the
    // user's next SSO token. Fire-and-forget — never blocks the admin response.
    function pushRoleToStreamer(user, role) {
        try {
            const base = (process.env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
            const key = process.env.INTERNAL_API_KEY || process.env.OV_INTERNAL_KEY;
            if (!key || !user) return;
            fetch(`${base}/internal/user-role`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Internal-Key': key },
                body: JSON.stringify({ openvibenetwork_id: user.id, username: user.username, role }),
            }).then(r => { if (!r.ok) console.warn('[AdminRole] streamer role push HTTP', r.status); })
              .catch(e => console.warn('[AdminRole] streamer role push failed:', e.message));
        } catch (e) {
            console.warn('[AdminRole] streamer role push error:', e.message);
        }
    }

    router.use(requireAuth, requireAdmin);

    // ═══════════════════════════════════════════════════════
    // Email Configuration (Resend)
    // ═══════════════════════════════════════════════════════

    // GET /api/admin/email — get current email config (owner-only: exposes key metadata)
    router.get('/email', requireOwner, (req, res) => {
        try {
            const status = emailService.getStatus();
            res.json({ ok: true, email: status, metrics: getEmailMetrics() });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // PUT /api/admin/email — update email config (owner-only: writes resend_api_key)
    router.put('/email', requireOwner, (req, res) => {
        try {
            const { enabled, api_key, from_email, from_name,
                    from_email_openvibelive, from_email_openvibegames, from_email_openvibenetwork } = req.body;
            const setSetting = db.prepare('INSERT OR REPLACE INTO site_settings (key, value, type) VALUES (?, ?, ?)');

            const tx = db.transaction(() => {
                if (enabled !== undefined) setSetting.run('email_enabled', String(enabled), 'boolean');
                // Only update API key if it's not a masked placeholder
                if (api_key && !/\u2022/.test(api_key)) setSetting.run('resend_api_key', api_key, 'string');
                if (from_email) setSetting.run('email_from_address', from_email, 'string');
                if (from_name !== undefined) setSetting.run('email_from_name', from_name || 'OpenVibe', 'string');
                // Per-service from addresses
                if (from_email_openvibelive !== undefined) setSetting.run('email_from_openvibelive', from_email_openvibelive, 'string');
                if (from_email_openvibegames !== undefined) setSetting.run('email_from_openvibegames', from_email_openvibegames, 'string');
                if (from_email_openvibenetwork !== undefined) setSetting.run('email_from_openvibenetwork', from_email_openvibenetwork, 'string');
            });
            tx();

            emailService.reload();

            // Audit
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'email_config_update', JSON.stringify({ from_email })
            );

            res.json({ ok: true, email: emailService.getStatus() });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /api/admin/email/test — send test email (owner-only, part of email config)
    router.post('/email/test', requireOwner, async (req, res) => {
        try {
            const { email } = req.body;
            if (!email) return res.status(400).json({ ok: false, error: 'Email required' });
            await emailService.sendTestEmail(email);
            res.json({ ok: true, sent: true });
        } catch (err) {
            // sendTestEmail throws with descriptive errors — surface them
            res.status(400).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Site Settings
    // ═══════════════════════════════════════════════════════

    // Core site settings are owner-only (off-limits to admins).
    router.get('/settings', requireOwner, (req, res) => {
        try {
            const rows = db.prepare('SELECT * FROM site_settings').all();
            const settings = {};
            // Keys managed exclusively by the Email tab — hide from generic settings
            const EMAIL_MANAGED_KEYS = new Set([
                'ses_enabled', 'ses_region', 'ses_access_key_id', 'ses_secret_access_key',
                'ses_from_email', 'ses_from_name',
                'ses_from_email_openvibelive', 'ses_from_email_openvibegames', 'ses_from_email_openvibenetwork',
                'email_enabled', 'resend_api_key', 'email_from_address', 'email_from_name',
                'email_from_openvibelive', 'email_from_openvibegames', 'email_from_openvibenetwork',
            ]);
            const owner = isOwner(req.user);
            for (const r of rows) {
                if (EMAIL_MANAGED_KEYS.has(r.key)) continue;
                // Secrets (API keys / tokens / credentials) are owner-only — mask for admins.
                if (!owner && (r.type === 'secret' || isSensitiveSettingKey(r.key))) {
                    settings[r.key] = { value: maskSecret(r.value), type: r.type, redacted: true };
                } else {
                    settings[r.key] = { value: r.value, type: r.type };
                }
            }
            res.json({ ok: true, settings });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.put('/settings', requireOwner, (req, res) => {
        try {
            const { key, value, type } = req.body;
            if (!key) return res.status(400).json({ ok: false, error: 'Key required' });
            // Secrets are owner-only — an admin cannot create or overwrite them.
            if ((type === 'secret' || isSensitiveSettingKey(key)) && !isOwner(req.user)) {
                return res.status(403).json({ ok: false, error: 'Owner access required to change this setting' });
            }
            // Prevent overwriting secrets with masked values
            if (typeof value === 'string' && /^••••/.test(value)) {
                return res.json({ ok: true, skipped: true });
            }
            db.prepare('INSERT OR REPLACE INTO site_settings (key, value, type) VALUES (?, ?, ?)').run(key, String(value), type || 'string');
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'setting_update', JSON.stringify({ key })
            );
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // URL Registry

    router.get('/url-registry', (req, res) => {
        try {
            let entries = urlRegistry.getAllRegistryEntries(db);
            // Mask secret-typed registry values (e.g. DEPLOY_CLOUDFLARE_TOKEN) for non-owners.
            if (!isOwner(req.user) && Array.isArray(entries)) {
                entries = entries.map((e) => {
                    if (e && (e.type === 'secret' || isSensitiveSettingKey(e.key))) {
                        return { ...e, value: maskSecret(e.value), redacted: true };
                    }
                    return e;
                });
            }
            res.json({ ok: true, entries });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // Reject secret-registry writes/clears from non-owners (Cloudflare token, etc.).
    function guardRegistryKey(req, res, key) {
        if (isSensitiveSettingKey(key) && !isOwner(req.user)) {
            res.status(403).json({ ok: false, error: 'Owner access required to change this key' });
            return false;
        }
        return true;
    }

    router.put('/url-registry', async (req, res) => {
        try {
            const { key, value } = req.body;
            if (!key) return res.status(400).json({ ok: false, error: 'Key required' });
            if (value === undefined || value === null) return res.status(400).json({ ok: false, error: 'Value required' });
            if (!guardRegistryKey(req, res, key)) return;
            const entry = urlRegistry.setRegistryEntry(db, key, value, req.user.id);
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'url_registry_update', JSON.stringify({ key })
            );

            const refreshResult = await notifyServiceRefresh(req, key);
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'url_registry_refresh_request', JSON.stringify(refreshResult)
            );
            res.json({ ok: true, entry, refresh: refreshResult });
        } catch (err) {
            res.status(400).json({ ok: false, error: err.message });
        }
    });

    router.put('/url-registry/:key', async (req, res) => {
        try {
            const { key } = req.params;
            const { value } = req.body;
            if (!key) return res.status(400).json({ ok: false, error: 'Key required' });
            if (value === undefined || value === null) return res.status(400).json({ ok: false, error: 'Value required' });
            if (!guardRegistryKey(req, res, key)) return;
            const entry = urlRegistry.setRegistryEntry(db, key, value, req.user.id);
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'url_registry_update', JSON.stringify({ key })
            );

            const refreshResult = await notifyServiceRefresh(req, key);
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'url_registry_refresh_request', JSON.stringify(refreshResult)
            );
            res.json({ ok: true, entry, refresh: refreshResult });
        } catch (err) {
            res.status(400).json({ ok: false, error: err.message });
        }
    });

    router.delete('/url-registry/:key', (req, res) => {
        try {
            const { key } = req.params;
            if (!key) return res.status(400).json({ ok: false, error: 'Key required' });
            if (!guardRegistryKey(req, res, key)) return;
            urlRegistry.resetRegistryEntry(db, key);
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'url_registry_reset', JSON.stringify({ key })
            );
            res.json({ ok: true, key });
        } catch (err) {
            res.status(400).json({ ok: false, error: err.message });
        }
    });

    router.post('/url-registry/refresh-all', async (req, res) => {
        try {
            const uniqueServices = new Set(Object.values(URL_DEFINITIONS)
                .filter(def => !!def.service)
                .map(def => def.service)
            );
            const refreshResults = [];
            for (const serviceName of uniqueServices) {
                const result = await refreshService(req, serviceName);
                refreshResults.push({ service: serviceName, results: [result] });
            }
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'url_registry_refresh_all', JSON.stringify(refreshResults)
            );
            res.json({ ok: true, refreshResults });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.post('/url-registry/:key/reset', (req, res) => {
        try {
            const { key } = req.params;
            if (!key) return res.status(400).json({ ok: false, error: 'Key required' });
            if (!guardRegistryKey(req, res, key)) return;
            urlRegistry.resetRegistryEntry(db, key);
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'url_registry_reset', JSON.stringify({ key })
            );
            res.json({ ok: true, key });
        } catch (err) {
            res.status(400).json({ ok: false, error: err.message });
        }
    });

    router.post('/reset-db', requireOwner, (req, res) => {
        try {
            const serviceRoot = path.resolve(__dirname, '..');
            const scriptPath = path.join(serviceRoot, 'server', 'reset-db.js');
            if (!fs.existsSync(scriptPath)) {
                return res.status(404).json({ ok: false, error: 'Reset script not found' });
            }
            const result = childProcess.spawnSync(process.execPath, [scriptPath], {
                cwd: serviceRoot,
                env: process.env,
                encoding: 'utf8',
                timeout: 30000,
            });
            if (result.error) throw result.error;
            if (result.status !== 0) {
                return res.status(500).json({ ok: false, error: result.stderr || result.stdout || `Exit code ${result.status}` });
            }
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
                .run(req.user.id, 'reset_db', JSON.stringify({ output: result.stdout.trim() }));
            res.json({ ok: true, message: result.stdout.trim() });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // Only the owner may grant admin — otherwise an admin could self-escalate here,
    // bypassing the owner gate on PUT /users/:id/role.
    router.post('/users/grant-admin', requireOwner, (req, res) => {
        try {
            const { id, username, email } = req.body;
            if (!id && !username && !email) {
                return res.status(400).json({ ok: false, error: 'id, username, or email is required' });
            }

            let user;
            if (id) {
                user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(id);
            } else if (username) {
                user = db.prepare('SELECT id, username, email FROM users WHERE LOWER(username) = LOWER(?)').get(username);
            } else {
                user = db.prepare('SELECT id, username, email FROM users WHERE LOWER(email) = LOWER(?)').get(email);
            }
            if (!user) {
                return res.status(404).json({ ok: false, error: 'User not found' });
            }

            db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', user.id);
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id,
                'grant_admin',
                JSON.stringify({ targetId: user.id, targetUsername: user.username, targetEmail: user.email }),
            );
            pushRoleToStreamer(user, 'admin');
            res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email, role: 'admin' } });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // User Management
    // ═══════════════════════════════════════════════════════

    router.get('/users', (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const offset = parseInt(req.query.offset) || 0;
            const search = req.query.search || '';

            let users;
            if (search) {
                users = db.prepare(`
                    SELECT id, username, display_name, email, role, is_banned, created_at, last_seen
                    FROM users WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ?
                    ORDER BY created_at DESC LIMIT ? OFFSET ?
                `).all(`%${search}%`, `%${search}%`, `%${search}%`, limit, offset);
            } else {
                users = db.prepare(`
                    SELECT id, username, display_name, email, role, is_banned, created_at, last_seen
                    FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?
                `).all(limit, offset);
            }

            const total = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
            res.json({ ok: true, users, total });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.put('/users/:id/role', (req, res) => {
        try {
            const { role } = req.body;
            const validRoles = ['user', 'streamer', 'global_mod', 'admin'];
            if (!validRoles.includes(role)) return res.status(400).json({ ok: false, error: 'Invalid role' });
            // Only the network owner may grant/revoke the ADMIN role. Regular admins can
            // still manage streamers / global mods / users, but not other admins.
            const OWNER = (process.env.OWNER_USERNAME || 'goosely').toLowerCase();
            const isOwner = req.user && String(req.user.username || '').toLowerCase() === OWNER;
            const target = db.prepare('SELECT role FROM users WHERE id = ?').get(req.params.id);
            if (!isOwner && (role === 'admin' || (target && target.role === 'admin'))) {
                return res.status(403).json({ ok: false, error: 'Only the owner can grant or change the admin role' });
            }
            db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'user_role_change', JSON.stringify({ targetId: req.params.id, role })
            );
            const changed = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
            if (changed) pushRoleToStreamer(changed, role);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.put('/users/:id/ban', (req, res) => {
        try {
            const { banned, reason } = req.body;
            db.prepare('UPDATE users SET is_banned = ?, ban_reason = ? WHERE id = ?').run(banned ? 1 : 0, reason || null, req.params.id);
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, banned ? 'user_ban' : 'user_unban', JSON.stringify({ targetId: req.params.id, reason })
            );

            // Notify the user
            if (banned) {
                notificationService.create({
                    user_id: parseInt(req.params.id),
                    type: 'BAN',
                    title: 'Account Suspended',
                    message: reason ? `Reason: ${reason}` : 'Your account has been suspended.',
                    priority: 'critical',
                    category: 'moderation',
                });
            }

            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Broadcast Notifications
    // ═══════════════════════════════════════════════════════

    router.post('/broadcast', (req, res) => {
        try {
            const { title, message, icon, url, priority, category } = req.body;
            if (!title) return res.status(400).json({ ok: false, error: 'Title required' });

            // Abusable at volume — admins get one global notification per 6h; owners are exempt.
            const limit = checkAdminLimit(db, req.user, 'broadcast');
            if (!limit.ok) {
                return res.status(429).json({
                    ok: false,
                    error: `Rate limited — you can send another global notification in ${limit.retryHuman}.`,
                    retryMs: limit.retryMs,
                });
            }

            // Get all non-banned user IDs
            const userIds = db.prepare('SELECT id FROM users WHERE is_banned = 0').all().map(u => u.id);
            const results = notificationService.createBulk(userIds, {
                type: 'ADMIN_BROADCAST',
                title,
                message,
                icon: icon || '📢',
                url,
                priority: priority || 'normal',
                category: category || 'admin',
                sender_id: req.user.id,
                sender_name: req.user.display_name || req.user.username,
                service: 'network',
            });

            recordAdminAction(db, req.user, 'broadcast');
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'broadcast_notification', JSON.stringify({ title, recipients: results.length })
            );

            res.json({ ok: true, sent: results.length });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // System Health
    // ═══════════════════════════════════════════════════════

    router.get('/health', (req, res) => {
        try {
            const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
            const notifCount = db.prepare('SELECT COUNT(*) as cnt FROM notifications').get().cnt;
            const unreadCount = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE is_read = 0').get().cnt;
            const anonCount = db.prepare('SELECT COUNT(*) as cnt FROM anon_users').get().cnt;
            const sessionCount = db.prepare('SELECT COUNT(*) as cnt FROM user_sessions WHERE is_active = 1').get().cnt;
            const emailStatus = emailService.getStatus();

            res.json({
                ok: true,
                health: {
                    users: userCount,
                    anon_users: anonCount,
                    active_sessions: sessionCount,
                    total_notifications: notifCount,
                    unread_notifications: unreadCount,
                    email_enabled: emailStatus.enabled,
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                },
            });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Audit Log
    // ═══════════════════════════════════════════════════════

    router.get('/audit', (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 50, 500);
            const offset = parseInt(req.query.offset) || 0;
            const rows = db.prepare(`
                SELECT a.*, u.username FROM audit_log a
                LEFT JOIN users u ON u.id = a.user_id
                ORDER BY a.created_at DESC LIMIT ? OFFSET ?
            `).all(limit, offset);
            // Historical rows may hold secret values in `details` (older registry/
            // config writes logged the raw value). Scrub those for non-owners.
            if (!isOwner(req.user)) {
                const SECRET_ACTIONS = /(registry|setting|config|email|discord|net_|deploy)/i;
                for (const r of rows) {
                    if (r.details && SECRET_ACTIONS.test(r.action || '')) r.details = '"[redacted]"';
                }
            }
            res.json({ ok: true, entries: rows });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Verification Keys (reserved username claims)
    // ═══════════════════════════════════════════════════════

    router.get('/verification-keys', (req, res) => {
        try {
            const keys = db.getAllVerificationKeys();
            res.json({ ok: true, keys });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.post('/verification-keys', (req, res) => {
        try {
            const { target_username, note } = req.body;
            if (!target_username) {
                return res.status(400).json({ ok: false, error: 'Target username is required' });
            }
            if (!/^[a-zA-Z0-9_]+$/.test(target_username) || target_username.length < 3 || target_username.length > 24) {
                return res.status(400).json({ ok: false, error: 'Invalid username format (3-24 chars, alphanumeric + underscore)' });
            }

            // Check if username already taken
            const existingUser = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(target_username);
            if (existingUser) {
                return res.status(409).json({ ok: false, error: `Username "${target_username}" is already registered` });
            }

            // Check for duplicate active key
            const existingKey = db.getVerificationKeyByUsername(target_username);
            if (existingKey) {
                return res.status(409).json({ ok: false, error: `Active key already exists for "${target_username}"` });
            }

            // Generate OPENVIBE-XXXX-XXXX-XXXX
            const crypto = require('crypto');
            const key = 'OPENVIBE-' + [4, 4, 4].map(() =>
                crypto.randomBytes(2).toString('hex').toUpperCase()
            ).join('-');

            db.createVerificationKey({
                key,
                target_username,
                note: note || '',
                created_by: req.user.id,
            });

            const created = db.getVerificationKeyByKey(key);

            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'verification_key_create', JSON.stringify({ key, target_username })
            );

            res.status(201).json({ ok: true, key: created });
        } catch (err) {
            console.error('[Admin] Verification key error:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to generate key' });
        }
    });

    router.delete('/verification-keys/:id', (req, res) => {
        try {
            const result = db.revokeVerificationKey(req.params.id);
            if (result.changes === 0) {
                return res.status(404).json({ ok: false, error: 'Key not found or already used/revoked' });
            }

            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'verification_key_revoke', JSON.stringify({ keyId: req.params.id })
            );

            res.json({ ok: true, message: 'Verification key revoked' });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to revoke key' });
        }
    });

    // ═══════════════════════════════════════════════════════
    // Net.OpenVibe — Network Tools Config
    // ═══════════════════════════════════════════════════════

    const NET_SETTING_KEYS = [
        'net.ipinfo_token',          // ipinfo.io API token (optional, 50k/month free)
        'net.globalping_token',      // Globalping API token (optional, 100 credits/hr free)
    ];

    router.get('/net-config', requireOwner, (req, res) => {
        try {
            const config = {};
            for (const key of NET_SETTING_KEYS) {
                const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
                config[key] = row ? row.value : '';
            }
            // Mask tokens for display
            for (const key of NET_SETTING_KEYS) {
                if (config[key] && config[key].length > 4) {
                    config[key] = '••••' + config[key].slice(-4);
                }
            }
            res.json({ ok: true, config, keys: NET_SETTING_KEYS });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.put('/net-config', requireOwner, (req, res) => {
        try {
            const { key, value } = req.body;
            if (!key || !NET_SETTING_KEYS.includes(key)) {
                return res.status(400).json({ ok: false, error: 'Invalid setting key' });
            }
            // Skip if masked
            if (value?.startsWith('••••')) return res.json({ ok: true, skipped: true });
            db.prepare('INSERT OR REPLACE INTO site_settings (key, value, type) VALUES (?, ?, ?)').run(key, String(value), 'secret');
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'net_config_update', JSON.stringify({ key })
            );
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    return router;
};

module.exports = createAdminRoutes;
module.exports._getServiceRefreshInfo = getServiceRefreshInfo;
module.exports._refreshService = refreshService;
module.exports._refreshServiceByKey = refreshServiceByKey;
