'use strict';

// ═══════════════════════════════════════════════════════════════
// Email Service (Resend)
// Sends transactional emails via Resend API.
// Only sends for CRITICAL priority + eligible categories.
// Configuration stored in site_settings and managed via admin UI.
// ═══════════════════════════════════════════════════════════════

const https = require('https');

/**
 * Send an email via the Resend REST API.
 * @param {string} apiKey - Resend API key (re_xxxx)
 * @param {Object} opts - { from, to, subject, html, text }
 * @returns {Promise<{id: string}>}
 */
function resendSend(apiKey, { from, to, subject, html, text }) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, text });
        const req = https.request({
            hostname: 'api.resend.com',
            path: '/emails',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        const msg = parsed.message || parsed.error?.message || body;
                        reject(new Error(`Resend API ${res.statusCode}: ${msg}`));
                    }
                } catch {
                    reject(new Error(`Resend API ${res.statusCode}: ${body}`));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

class EmailService {
    constructor(db) {
        this.db = db;
        this._enabled = false;
        this._apiKey = null;
        this._fromEmail = 'noreply@openvibe.network';
        this._fromName = 'OpenVibe';
        this._logDelivery = db.prepare(`
            INSERT INTO email_delivery_log (email_type, recipient, subject, status, error_message, user_id, notification_id, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this._migrateFromSES();
        this._loadConfig();
    }

    /**
     * One-time migration: copy legacy email settings to the new email_* keys if they exist
     * and the new keys haven't been set yet.
     */
    _migrateFromSES() {
        const migrations = [
            ['ses_enabled', 'email_enabled', 'boolean'],
            ['ses_from_email', 'email_from_address', 'string'],
            ['ses_from_name', 'email_from_name', 'string'],
            ['ses_from_email_openvibelive', 'email_from_openvibelive', 'string'],
            ['ses_from_email_openvibegames', 'email_from_openvibegames', 'string'],
            ['ses_from_email_openvibenetwork', 'email_from_openvibenetwork', 'string'],
        ];
        const setSetting = this.db.prepare('INSERT OR IGNORE INTO site_settings (key, value, type) VALUES (?, ?, ?)');
        for (const [oldKey, newKey, type] of migrations) {
            const oldVal = this.db.getSetting(oldKey);
            if (oldVal != null && oldVal !== '') {
                setSetting.run(newKey, String(oldVal), type);
            }
        }
    }

    _loadConfig() {
        this._enabled = this.db.getSetting('email_enabled') === true;
        this._apiKey = this.db.getSetting('resend_api_key') || null;
        this._fromEmail = this.db.getSetting('email_from_address') || 'noreply@openvibe.network';
        this._fromName = this.db.getSetting('email_from_name') || 'OpenVibe';

        if (this._enabled && this._apiKey) {
            console.log(`[Email] Resend initialized (from: ${this._fromName} <${this._fromEmail}>)`);
        } else if (this._enabled) {
            console.warn('[Email] Enabled but missing Resend API key — disabled');
            this._enabled = false;
        }
    }

    /** Reload config (call after admin changes settings). */
    reload() {
        this._apiKey = null;
        this._loadConfig();
    }

    get isEnabled() { return this._enabled && !!this._apiKey; }

    /**
     * Resolve the from-address for a given service.
     * Falls back to the global from-email if no per-service override.
     */
    getFromEmail(service) {
        if (service) {
            const key = `email_from_${service.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
            const override = this.db.getSetting(key);
            if (override) return override;
        }
        return this._fromEmail;
    }

    /**
     * Diagnose why the email service isn't ready.
     * Returns a user-friendly error string, or null if ready.
     */
    diagnose() {
        if (!this._enabled) {
            const dbEnabled = this.db.getSetting('email_enabled');
            if (dbEnabled !== true) return 'Email is disabled — enable the toggle in admin panel and save';
            return 'Email service failed to initialize after being enabled — check server logs';
        }
        if (!this._apiKey) return 'Resend API key is missing — enter your API key from resend.com/api-keys';
        return null;
    }

    async _sendEmail({ to, subject, htmlBody, textBody, emailType = 'generic', userId = null, notificationId = null, metadata = null, fromEmail = null }) {
        if (!to) return false;

        if (!this.isEnabled) {
            const reason = this.diagnose() || 'Email service is disabled or not configured';
            this._recordDelivery({
                emailType,
                recipient: to,
                subject,
                status: 'failed',
                errorMessage: reason,
                userId,
                notificationId,
                metadata,
            });
            return false;
        }

        try {
            const source = fromEmail || this._fromEmail;
            const from = `${this._fromName} <${source}>`;
            await resendSend(this._apiKey, {
                from,
                to,
                subject,
                html: htmlBody,
                text: textBody,
            });
            this._recordDelivery({
                emailType,
                recipient: to,
                subject,
                status: 'sent',
                userId,
                notificationId,
                metadata,
            });
            return true;
        } catch (err) {
            this._recordDelivery({
                emailType,
                recipient: to,
                subject,
                status: 'failed',
                errorMessage: err.message,
                userId,
                notificationId,
                metadata,
            });
            console.error(`[Email] Send failed (to: ${to}):`, err.message);
            return false;
        }
    }

    /**
     * Send a notification email.
     * @param {Object} opts - { to, username, subject, notification }
     * @returns {Promise<boolean>} true on success
     */
    async sendNotificationEmail({ to, username, subject, notification }) {
        const htmlBody = this._buildEmailHtml({ username, notification });
        const textBody = this._buildEmailText({ username, notification });
        const fromEmail = this.getFromEmail(notification.service);
        const sent = await this._sendEmail({
            to,
            subject: subject || notification.title || 'Notification',
            htmlBody,
            textBody,
            emailType: `notification:${notification.type || 'GENERIC'}`,
            userId: notification.user_id || null,
            notificationId: notification.id || null,
            fromEmail,
            metadata: {
                category: notification.category || null,
                priority: notification.priority || null,
                service: notification.service || null,
            },
        });
        if (sent) {
            console.log(`[Email] Sent to ${to}: ${subject || notification.title || 'Notification'}`);
        }
        return sent;
    }

    async sendPasswordResetEmail({ to, username, resetUrl, expiresMinutes = 60 }) {
        const htmlBody = this._buildPasswordResetHtml({ username, resetUrl, expiresMinutes });
        const textBody = this._buildPasswordResetText({ username, resetUrl, expiresMinutes });
        const subject = '🔥 OpenVibe — Reset Your Password';
        const sent = await this._sendEmail({
            to,
            subject,
            htmlBody,
            textBody,
            emailType: 'password_reset',
            metadata: { expiresMinutes },
        });
        if (sent) {
            console.log(`[Email] Password reset email sent to ${to}`);
        }
        return sent;
    }

    /**
     * Process the email queue — finds critical notifications not yet emailed.
     * @param {import('./notification-service').NotificationService} notifService
     */
    async processQueue(notifService) {
        if (!this.isEnabled) return;

        const pending = notifService.getPendingEmails();
        if (pending.length === 0) return;

        console.log(`[Email] Processing ${pending.length} pending email(s)...`);

        for (const notif of pending) {
            if (!notifService.shouldEmail(notif)) {
                notifService.markEmailed(notif.id);
                continue;
            }
            const sent = await this.sendNotificationEmail({
                to: notif.email,
                username: notif.display_name || notif.username,
                subject: `🔥 OpenVibe — ${notif.title}`,
                notification: notif,
            });
            if (sent) notifService.markEmailed(notif.id);
        }
    }

    // ─── Email Templates ───────────────────────────────────────

    _buildEmailHtml({ username, notification }) {
        const priorityColor = { low: '#888', normal: '#8b5cf6', high: '#f39c12', critical: '#e74c3c' };
        const color = priorityColor[notification.priority] || '#8b5cf6';

        return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { margin: 0; padding: 0; background: #1a1a24; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.container { max-width: 560px; margin: 0 auto; padding: 24px; }
.card { background: #22222c; border-radius: 12px; border: 1px solid #333340; overflow: hidden; }
.header { background: linear-gradient(135deg, #2a2a38, #1a1a24); padding: 24px; text-align: center; border-bottom: 2px solid ${color}; }
.header .flame { font-size: 32px; margin-bottom: 8px; }
.header h1 { margin: 0; color: #e0e0e0; font-size: 18px; font-weight: 700; }
.body { padding: 24px; color: #b0b0b8; font-size: 14px; line-height: 1.6; }
.body .greeting { color: #e0e0e0; font-weight: 600; margin-bottom: 12px; }
.notif-box { background: #1a1a24; border-radius: 8px; padding: 16px; margin: 16px 0; border-left: 3px solid ${color}; }
.notif-box .icon { font-size: 20px; margin-bottom: 6px; }
.notif-box .title { color: #e0e0e0; font-weight: 600; font-size: 15px; }
.notif-box .message { color: #b0b0b8; margin-top: 6px; }
.notif-box .meta { color: #707080; font-size: 11px; margin-top: 8px; }
.cta { display: inline-block; background: ${color}; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-weight: 600; margin: 16px 0; }
.footer { padding: 16px 24px; text-align: center; color: #505060; font-size: 11px; border-top: 1px solid #333340; }
.footer a { color: #8b5cf6; text-decoration: none; }
</style></head>
<body><div class="container"><div class="card">
<div class="header"><div class="flame">🔥</div><h1>OpenVibe</h1></div>
<div class="body">
<div class="greeting">Hey ${username || 'there'},</div>
<p>You have an important notification:</p>
<div class="notif-box">
<div class="icon">${notification.icon || '🔔'}</div>
<div class="title">${notification.title}</div>
${notification.message ? `<div class="message">${notification.message}</div>` : ''}
<div class="meta">${notification.service ? `From ${notification.service} · ` : ''}${notification.priority?.toUpperCase()} priority</div>
</div>
${notification.url ? `<a class="cta" href="${notification.url}">View Details →</a>` : ''}
</div>
<div class="footer">
<p>You're receiving this because it's a critical notification.</p>
<p><a href="https://openvibe.network/notifications">Manage notification preferences</a> · <a href="https://openvibe.network">openvibe.network</a></p>
</div>
</div></div></body></html>`;
    }

    _buildEmailText({ username, notification }) {
        return [
            `Hey ${username || 'there'},`,
            '',
            'You have an important notification from OpenVibe:',
            '',
            `${notification.icon || '🔔'} ${notification.title}`,
            notification.message || '',
            '',
            notification.url ? `View details: ${notification.url}` : '',
            '',
            '---',
            'Manage preferences: https://openvibe.network/notifications',
            'OpenVibe · https://openvibe.network',
        ].join('\n');
    }

    _buildPasswordResetHtml({ username, resetUrl, expiresMinutes }) {
        return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { margin: 0; padding: 0; background: #1a1a24; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.container { max-width: 560px; margin: 0 auto; padding: 24px; }
.card { background: #22222c; border-radius: 12px; border: 1px solid #333340; overflow: hidden; }
.header { background: linear-gradient(135deg, #2a2a38, #1a1a24); padding: 24px; text-align: center; border-bottom: 2px solid #8b5cf6; }
.header .flame { font-size: 32px; margin-bottom: 8px; }
.header h1 { margin: 0; color: #e0e0e0; font-size: 18px; font-weight: 700; }
.body { padding: 24px; color: #b0b0b8; font-size: 14px; line-height: 1.6; }
.body .greeting { color: #e0e0e0; font-weight: 600; margin-bottom: 12px; }
.notice { background: #1a1a24; border-radius: 8px; padding: 16px; margin: 16px 0; border-left: 3px solid #8b5cf6; }
.cta { display: inline-block; background: #8b5cf6; color: #fff !important; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 700; margin: 16px 0; }
.muted { color: #707080; font-size: 12px; }
.footer { padding: 16px 24px; text-align: center; color: #505060; font-size: 11px; border-top: 1px solid #333340; }
.footer a { color: #8b5cf6; text-decoration: none; }
</style></head>
<body><div class="container"><div class="card">
<div class="header"><div class="flame">🔥</div><h1>Reset Your Password</h1></div>
<div class="body">
<div class="greeting">Hey ${this._escapeHtml(username || 'there')},</div>
<p>We received a request to reset your OpenVibe password.</p>
<div class="notice">
<strong style="color:#e0e0e0">This link expires in ${expiresMinutes} minutes.</strong>
<div class="muted" style="margin-top:8px">If you did not request this, you can safely ignore this email.</div>
</div>
<a class="cta" href="${resetUrl}">Reset Password →</a>
<p class="muted">If the button does not work, paste this URL into your browser:</p>
<p class="muted" style="word-break:break-all">${resetUrl}</p>
</div>
<div class="footer">
<p>For your security, this link can only be used once.</p>
<p><a href="https://openvibe.network">openvibe.network</a></p>
</div>
</div></div></body></html>`;
    }

    _buildPasswordResetText({ username, resetUrl, expiresMinutes }) {
        return [
            `Hey ${username || 'there'},`,
            '',
            'We received a request to reset your OpenVibe password.',
            `This link expires in ${expiresMinutes} minutes.`,
            '',
            `Reset your password: ${resetUrl}`,
            '',
            'If you did not request this, you can safely ignore this email.',
            '',
            'OpenVibe · https://openvibe.network',
        ].join('\n');
    }

    _escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Get current email service configuration status (for admin panel).
     */
    getStatus() {
        const apiKey = this.db.getSetting('resend_api_key') || '';
        const issue = this.diagnose();
        return {
            enabled: this._enabled,
            ready: this.isEnabled,
            issue: issue || null,
            provider: 'resend',
            from_email: this._fromEmail,
            from_name: this._fromName,
            from_email_openvibelive: this.db.getSetting('email_from_openvibelive') || '',
            from_email_openvibegames: this.db.getSetting('email_from_openvibegames') || '',
            from_email_openvibenetwork: this.db.getSetting('email_from_openvibenetwork') || '',
            hasApiKey: !!apiKey,
            // Masked API key for display (show first 6 chars + last 4)
            api_key: apiKey ? apiKey.slice(0, 6) + '••••' + apiKey.slice(-4) : '',
        };
    }

    /**
     * Send a test email (admin only).
     * Throws with a descriptive error if email service is not ready.
     */
    async sendTestEmail(to) {
        const issue = this.diagnose();
        if (issue) throw new Error(issue);

        const subject = '🔥 OpenVibe — Test Email';
        const notification = {
            icon: '🧪',
            title: 'Test Email',
            message: 'If you received this, Resend email is configured correctly!',
            priority: 'normal',
            service: 'network',
            url: 'https://openvibe.network/admin',
        };
        const sent = await this._sendEmail({
            to,
            subject,
            htmlBody: this._buildEmailHtml({ username: 'Admin', notification }),
            textBody: this._buildEmailText({ username: 'Admin', notification }),
            emailType: 'test',
            metadata: { source: 'admin', provider: 'resend' },
        });
        if (!sent) throw new Error('Email send failed — check the delivery log below for details');
        return true;
    }

    _recordDelivery({ emailType, recipient, subject, status, errorMessage = null, userId = null, notificationId = null, metadata = null }) {
        try {
            this._logDelivery.run(
                emailType,
                recipient,
                subject || null,
                status,
                errorMessage,
                userId,
                notificationId,
                metadata ? JSON.stringify(metadata) : null,
            );
        } catch (err) {
            console.warn('[Email] Failed to record email delivery log:', err.message);
        }
    }
}

module.exports = { EmailService };
