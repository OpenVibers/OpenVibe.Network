'use strict';

// ═══════════════════════════════════════════════════════════════
// Notification Service — Server-side notification management
// Creates, stores, queries, and cleans up notifications.
// Also handles cross-service push via internal API.
// ═══════════════════════════════════════════════════════════════

const { v4: uuidv4 } = require('uuid');
const { TYPES, PRIORITY, EMAIL_ELIGIBLE_CATEGORIES, EMAIL_DEFAULT_TYPES } = require('openvibe-shared/notifications');

class NotificationService {
    constructor(db) {
        this.db = db;
        this._prepareStatements();
    }

    _prepareStatements() {
        const db = this.db;

        this._insertNotif = db.prepare(`
            INSERT INTO notifications (id, user_id, type, category, priority, title, message, icon,
                sender_id, sender_name, sender_avatar, service, url, rich_content, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        this._getById = db.prepare('SELECT * FROM notifications WHERE id = ?');

        this._getForUser = db.prepare(`
            SELECT * FROM notifications
            WHERE user_id = ? AND is_dismissed = 0
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `);

        this._getUnreadForUser = db.prepare(`
            SELECT * FROM notifications
            WHERE user_id = ? AND is_read = 0 AND is_dismissed = 0
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `);

        this._getByCategory = db.prepare(`
            SELECT * FROM notifications
            WHERE user_id = ? AND category = ? AND is_dismissed = 0
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `);

        this._unreadCount = db.prepare(`
            SELECT COUNT(*) as count FROM notifications
            WHERE user_id = ? AND is_read = 0 AND is_dismissed = 0
        `);

        this._unreadCountByCategory = db.prepare(`
            SELECT category, COUNT(*) as count FROM notifications
            WHERE user_id = ? AND is_read = 0 AND is_dismissed = 0
            GROUP BY category
        `);

        this._markRead = db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?');
        this._markAllRead = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0');
        this._markReadByCategory = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND category = ? AND is_read = 0');
        this._markReadByType = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND type = ? AND is_read = 0');
        this._markReadByTypeAndUrl = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND type = ? AND url LIKE ? AND is_read = 0');
        this._dismiss = db.prepare('UPDATE notifications SET is_dismissed = 1 WHERE id = ? AND user_id = ?');
        this._dismissAll = db.prepare('UPDATE notifications SET is_dismissed = 1 WHERE user_id = ?');
        this._markEmailed = db.prepare('UPDATE notifications SET is_emailed = 1 WHERE id = ?');

        this._deleteExpired = db.prepare("DELETE FROM notifications WHERE expires_at IS NOT NULL AND expires_at < datetime('now')");
        this._deleteOld = db.prepare("DELETE FROM notifications WHERE created_at < datetime('now', ?)");

        this._getPrefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?');
        this._getPrefByCategory = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ? AND category = ?');
        this._upsertPref = db.prepare(`
            INSERT INTO notification_preferences (user_id, category, enabled, sound, toasts, email)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, category) DO UPDATE SET enabled = ?, sound = ?, toasts = ?, email = ?
        `);
        this._deletePrefs = db.prepare('DELETE FROM notification_preferences WHERE user_id = ? AND category = ?');

        this._getPendingEmails = db.prepare(`
            SELECT n.*, u.email, u.username, u.display_name, u.email_verified, u.email_bounced_at FROM notifications n
            JOIN users u ON u.id = n.user_id
            WHERE n.is_emailed = 0 AND n.is_dismissed = 0
            AND u.email IS NOT NULL AND u.email != ''
            ORDER BY n.created_at ASC
            LIMIT 200
        `);
        // Dedupe: an unread go-live from the same streamer within the hour means the viewer
        // already has the alert — reconnects/restarts must not stack ten of them.
        this._recentFromSender = db.prepare(`
            SELECT id FROM notifications
            WHERE user_id = ? AND type = ? AND sender_id = ?
              AND created_at > datetime('now', '-60 minutes')
            LIMIT 1
        `);
        this._recentEmailFromSender = db.prepare(`
            SELECT 1 FROM email_delivery_log l JOIN notifications n ON n.id = l.notification_id
            WHERE n.user_id = ? AND n.type = ? AND n.sender_id = ? AND l.status = 'sent'
              AND l.created_at > datetime('now', '-60 minutes')
            LIMIT 1
        `);
        this._emailsSentToUserToday = db.prepare(`
            SELECT COUNT(*) AS c FROM email_delivery_log WHERE user_id = ? AND status = 'sent' AND created_at > datetime('now', '-1 day')
        `);
        this._emailsSentToday = db.prepare(`
            SELECT COUNT(*) AS c FROM email_delivery_log WHERE status = 'sent' AND created_at > datetime('now', '-1 day')
        `);

        this._newestForUser = db.prepare(`
            SELECT * FROM notifications
            WHERE user_id = ? AND is_dismissed = 0
            ORDER BY created_at DESC
            LIMIT 1
        `);
    }

    // ─── Create ────────────────────────────────────────────────

    /**
     * Create a notification. Returns the created notification object.
     * @param {Object} data - { user_id, type, title, message, sender_id, sender_name, sender_avatar, service, url, rich_content, expires_at }
     */
    create(data) {
        const typeDef = TYPES[data.type] || {};
        const id = uuidv4();
        const category = data.category || typeDef.category || 'system';
        const priority = data.priority || typeDef.priority || PRIORITY.NORMAL;
        const icon = data.icon || typeDef.icon || '🔔';
        const title = data.title || typeDef.title || 'Notification';

        // Check user's preferences — skip if disabled
        const pref = this._getPrefByCategory.get(data.user_id, category);
        if (pref && !pref.enabled) return null;
        // Go-live dedupe (see _recentFromSender).
        if (data.type === 'STREAM_LIVE' && data.sender_id != null) {
            try { if (this._recentFromSender.get(data.user_id, 'STREAM_LIVE', data.sender_id)) return null; } catch { /* */ }
        }

        const richContent = data.rich_content ? JSON.stringify(data.rich_content) : null;

        this._insertNotif.run(
            id, data.user_id, data.type || 'GENERIC', category, priority,
            title, data.message || null, icon,
            data.sender_id || null, data.sender_name || null, data.sender_avatar || null,
            data.service || null, data.url || null, richContent,
            data.expires_at || null,
        );

        // Fire browser push notification (async, non-blocking)
        try {
            const pushService = require('../push/push-service');
            pushService.sendPush(data.user_id, {
                title,
                message: data.message,
                icon,
                url: data.url,
                type: data.type,
            }).catch(() => {});
        } catch (_) { /* push module not available */ }

        return { id, user_id: data.user_id, type: data.type, category, priority, title, message: data.message, icon, service: data.service, url: data.url, rich_content: data.rich_content, is_read: 0, created_at: new Date().toISOString() };
    }

    /**
     * Bulk-create notifications for multiple users (e.g., broadcast).
     */
    createBulk(userIds, data) {
        const results = [];
        const tx = this.db.transaction(() => {
            for (const uid of userIds) {
                const notif = this.create({ ...data, user_id: uid });
                if (notif) results.push(notif);
            }
        });
        tx();
        return results;
    }

    // ─── Read ──────────────────────────────────────────────────

    getById(id) {
        const n = this._getById.get(id);
        if (n && n.rich_content) n.rich_content = JSON.parse(n.rich_content);
        return n;
    }

    /**
     * List notifications with composable filters. Returns { notifications, has_more, total }.
     *  - category + unreadOnly combine (they used to be either/or)
     *  - q: case-insensitive substring over title/message/sender_name
     *  - since: ISO timestamp, only rows created after it (toasts)
     * Fetches limit+1 so the client knows whether another page exists.
     */
    getForUser(userId, { limit = 50, offset = 0, category = null, unreadOnly = false, q = null, since = null, type = null } = {}) {
        const where = ['user_id = ?', 'is_dismissed = 0'];
        const params = [userId];
        if (category) { where.push('category = ?'); params.push(category); }
        if (type) { where.push('type = ?'); params.push(type); }
        if (unreadOnly) where.push('is_read = 0');
        if (since) { where.push('created_at > ?'); params.push(String(since).replace('T', ' ').replace(/Z$/, '').slice(0, 19)); }
        if (q) {
            const like = `%${String(q).replace(/[%_\\]/g, c => '\\' + c).slice(0, 80)}%`;
            where.push("(title LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\' OR sender_name LIKE ? ESCAPE '\\')");
            params.push(like, like, like);
        }
        const sql = `SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
        const rows = this.db.prepare(sql).all(...params, limit + 1, offset);
        const has_more = rows.length > limit;
        if (has_more) rows.length = limit;
        const total = this.db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE ${where.join(' AND ')}`).get(...params)?.c || 0;
        const notifications = rows.map(n => {
            // Defensive: a single corrupt row must never 500 the whole dropdown.
            if (n.rich_content) {
                try { n.rich_content = JSON.parse(n.rich_content); }
                catch { n.rich_content = null; }
            }
            return n;
        });
        return { notifications, has_more, total };
    }

    markReadMany(ids, userId) {
        if (!Array.isArray(ids) || !ids.length) return 0;
        const stmt = this.db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ? AND is_read = 0');
        let n = 0;
        const tx = this.db.transaction(() => { for (const id of ids.slice(0, 500)) n += stmt.run(String(id), userId).changes; });
        tx();
        return n;
    }

    getUnreadCount(userId) {
        return this._unreadCount.get(userId)?.count || 0;
    }

    getUnreadByCategory(userId) {
        return this._unreadCountByCategory.all(userId);
    }

    getNewest(userId) {
        const n = this._newestForUser.get(userId);
        if (n && n.rich_content) n.rich_content = JSON.parse(n.rich_content);
        return n;
    }

    // ─── Update ────────────────────────────────────────────────

    markRead(id, userId) {
        return this._markRead.run(id, userId).changes > 0;
    }

    markAllRead(userId, category = null) {
        if (category) return this._markReadByCategory.run(userId, category).changes;
        return this._markAllRead.run(userId).changes;
    }

    dismiss(id, userId) {
        return this._dismiss.run(id, userId).changes > 0;
    }

    dismissAll(userId) {
        return this._dismissAll.run(userId).changes;
    }

    markReadByType(userId, type, urlPattern = null) {
        if (urlPattern) return this._markReadByTypeAndUrl.run(userId, type, urlPattern).changes;
        return this._markReadByType.run(userId, type).changes;
    }

    markEmailed(id) {
        return this._markEmailed.run(id).changes > 0;
    }

    // ─── Preferences ──────────────────────────────────────────

    getPreferences(userId) {
        return this._getPrefs.all(userId);
    }

    setPreference(userId, category, updates = {}) {
        const current = this._getPrefByCategory.get(userId, category) || {
            enabled: 1,
            sound: 1,
            toasts: 1,
            email: null,   // NULL = no explicit choice → shouldEmail() applies the defaults
        };
        const next = {
            enabled: updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : current.enabled,
            sound: updates.sound !== undefined ? (updates.sound ? 1 : 0) : current.sound,
            toasts: updates.toasts !== undefined ? (updates.toasts ? 1 : 0) : current.toasts,
            email: updates.email !== undefined ? (updates.email === null ? null : (updates.email ? 1 : 0)) : current.email,
        };
        this._upsertPref.run(
            userId,
            category,
            next.enabled,
            next.sound,
            next.toasts,
            next.email,
            next.enabled,
            next.sound,
            next.toasts,
            next.email,
        );
    }

    resetPreference(userId, category) {
        this._deletePrefs.run(userId, category);
    }

    // ─── Email Queue ──────────────────────────────────────────

    /**\n     * Get notifications that should be emailed.\n     * Now checks ALL un-emailed notifications (not just critical),\n     * because shouldEmail() will filter by user preference.\n     */
    getPendingEmails() {
        return this._getPendingEmails.all();
    }

    /**
     * Check if a notification should trigger an email.
     * Priority: user's per-category email preference > built-in rules.
     * Built-in: CRITICAL + system/moderation/admin always email.
     * User opt-in: any category the user explicitly enabled email for.
     */
    shouldEmail(notification) {
        const pref = this._getPrefByCategory.get(notification.user_id, notification.category);
        // If user disabled the whole category, no email
        if (pref && !pref.enabled) return false;
        // LOW priority never emails
        if (notification.priority === PRIORITY.LOW) return false;
        const critical = notification.priority === PRIORITY.CRITICAL && EMAIL_ELIGIBLE_CATEGORIES.has(notification.category);
        // Deliverability gate: a bouncing address never gets mail; an UNVERIFIED address
        // only gets critical security/moderation mail (password changed, ban) — never
        // opt-in style alerts, so nobody can point our sender at a stranger's inbox.
        if (notification.email_bounced_at) return false;
        if (!notification.email_verified && !critical) return false;
        // Explicit per-category choice wins (email column: NULL = no choice made).
        if (pref && pref.email != null) return !!pref.email;
        // Defaults: go-live alerts email unless turned off; critical eligible categories email.
        if (EMAIL_DEFAULT_TYPES.has(notification.type)) return true;
        return critical;
    }

    /**
     * Abuse/cost guards evaluated right before a send. Returns a reason string to skip, or null.
     *  - stale: a go-live alert older than 2h is useless in an inbox
     *  - dup: same streamer already emailed this user within the hour
     *  - user cap / global cap: site_settings email_user_daily_cap (default 30),
     *    email_daily_cap (default 2000)
     */
    emailGuard(notification) {
        try {
            if (notification.type === 'STREAM_LIVE') {
                const ageMs = Date.now() - new Date(String(notification.created_at).replace(' ', 'T') + 'Z').getTime();
                if (ageMs > 2 * 3600 * 1000) return 'stale';
                if (notification.sender_id != null && this._recentEmailFromSender.get(notification.user_id, 'STREAM_LIVE', notification.sender_id)) return 'dup';
            }
            const userCap = parseInt(this.db.getSetting?.('email_user_daily_cap'), 10) || 30;
            if ((this._emailsSentToUserToday.get(notification.user_id)?.c || 0) >= userCap) return 'user-cap';
            const globalCap = parseInt(this.db.getSetting?.('email_daily_cap'), 10) || 2000;
            if ((this._emailsSentToday.get()?.c || 0) >= globalCap) return 'global-cap';
        } catch { /* guards are best-effort */ }
        return null;
    }

    // ─── Cleanup ──────────────────────────────────────────────

    cleanExpired() {
        return this._deleteExpired.run().changes;
    }

    cleanOld(days = 90) {
        return this._deleteOld.run(`-${days} days`).changes;
    }

    /**
     * Run periodic maintenance (call from setInterval in main server).
     */
    maintenance() {
        const expired = this.cleanExpired();
        const maxAge = this.db.getSetting?.('notification_max_age_days') || 90;
        const old = this.cleanOld(maxAge);
        if (expired + old > 0) {
            console.log(`[Notifications] Cleaned ${expired} expired + ${old} old notifications`);
        }
    }
}

module.exports = { NotificationService };
