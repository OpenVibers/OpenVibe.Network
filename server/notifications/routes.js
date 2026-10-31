'use strict';

// ═══════════════════════════════════════════════════════════════
// Notification API Routes
// REST endpoints for the notification UI client to interact with.
// Mounted at /api/notifications
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

module.exports = function createNotificationRoutes(db, notificationService, requireAuth, requireDock = () => requireAuth) {

    // ─── GET /api/notifications ────────────────────────────
    // Query params: limit, offset, category, type, tab (the bell's tabs, ./tabs.js), unread_only, q, since
    router.get('/', requireDock('activity'), async (req, res) => {
        try {
            const userId = req.user.id;
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const offset = parseInt(req.query.offset) || 0;
            const category = req.query.category || null;
            const type = req.query.type || null;
            // Accept both spellings — the shared UI shipped `unread=1` for a while.
            const unreadOnly = ['1', 'true'].includes(String(req.query.unread_only ?? req.query.unread ?? ''));
            const q = req.query.q ? String(req.query.q).trim() : null;
            const since = req.query.since ? String(req.query.since) : null;
            const tab = typeof req.query.tab === 'string' ? req.query.tab : null;

            const out = await notificationService.getForUser(userId, { limit, offset, category, unreadOnly, q, since, type, tab });
            res.json({ ok: true, ...out, limit, offset });
        } catch (err) {
            console.error('[Notifications] GET / error:', err);
            res.status(500).json({ ok: false, error: 'Failed to fetch notifications' });
        }
    });

    // ─── GET /api/notifications/unread-count ───────────────
    router.get('/unread-count', requireDock('activity'), async (req, res) => {
        try {
            const count = await notificationService.getUnreadCount(req.user.id);
            res.json({ ok: true, count });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to get count' });
        }
    });

    // ─── GET /api/notifications/unread-by-tab ──────────────
    // The counts on the bell's tabs: { tabs: { all, mentions, live, alerts, system, agents } }.
    router.get('/unread-by-tab', requireDock('activity'), async (req, res) => {
        try {
            res.json({ ok: true, tabs: await notificationService.getUnreadByTab(req.user.id) });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to get counts' });
        }
    });

    // ─── GET /api/notifications/unread-by-category ─────────
    router.get('/unread-by-category', requireDock('activity'), async (req, res) => {
        try {
            const categories = await notificationService.getUnreadByCategory(req.user.id);
            res.json({ ok: true, categories });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to get counts' });
        }
    });

    // ─── GET /api/notifications/newest ─────────────────────
    router.get('/newest', requireDock('activity'), async (req, res) => {
        try {
            const newest = await notificationService.getNewest(req.user.id);
            res.json({ ok: true, notification: newest || null });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to get newest' });
        }
    });

    // ─── POST /api/notifications/:id/read ──────────────────
    router.post('/:id/read', requireDock('activity'), async (req, res) => {
        try {
            const ok = await notificationService.markRead(req.params.id, req.user.id);
            res.json({ ok, unread: await notificationService.getUnreadCount(req.user.id) });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to mark read' });
        }
    });

    // ─── POST /api/notifications/read-batch ────────────────
    // Body: { ids: [] } — the inbox marks everything it rendered as seen in one call.
    router.post('/read-batch', requireDock('activity'), async (req, res) => {
        try {
            const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
            const changed = await notificationService.markReadMany(ids, req.user.id);
            res.json({ ok: true, changed, unread: await notificationService.getUnreadCount(req.user.id) });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to mark read' });
        }
    });

    // ─── POST /api/notifications/read-all ──────────────────
    router.post('/read-all', requireDock('activity'), async (req, res) => {
        try {
            const { category } = req.body || {};
            const changed = await notificationService.markAllRead(req.user.id, category || null);
            res.json({ ok: true, changed });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to mark all read' });
        }
    });

    // ─── POST /api/notifications/:id/dismiss ───────────────
    router.post('/:id/dismiss', requireDock('activity'), async (req, res) => {
        try {
            const ok = await notificationService.dismiss(req.params.id, req.user.id);
            res.json({ ok });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to dismiss' });
        }
    });

    // ─── DELETE /api/notifications ─────────────────────────
    // Dismiss all
    router.delete('/', requireAuth, async (req, res) => {
        try {
            const changed = await notificationService.dismissAll(req.user.id);
            res.json({ ok: true, changed });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to dismiss all' });
        }
    });

    // ─── GET /api/notifications/quiet-hours ────────────────
    // The person's do-not-disturb window (default 22:00–07:00 UTC, off) and whether it is now.
    router.get('/quiet-hours', requireDock('activity'), async (req, res) => {
        try {
            const quiet = await notificationService.getQuietHours(req.user.id);
            const in_quiet = await notificationService.inQuietHours(req.user.id);
            res.json({ ok: true, ...quiet, in_quiet });
        } catch (err) {
            console.error('[Notifications] GET /quiet-hours error:', err);
            res.status(500).json({ ok: false, error: 'Failed to get quiet hours' });
        }
    });

    // ─── PUT /api/notifications/quiet-hours ────────────────
    // Body: { enabled, start: 'HH:MM', end: 'HH:MM', tz }
    router.put('/quiet-hours', requireAuth, async (req, res) => {
        try {
            const { enabled, start, end, tz } = req.body || {};
            const quiet = await notificationService.setQuietHours(req.user.id, { enabled, start, end, tz });
            const in_quiet = await notificationService.inQuietHours(req.user.id);
            res.json({ ok: true, ...quiet, in_quiet });
        } catch (err) {
            if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
            console.error('[Notifications] PUT /quiet-hours error:', err);
            res.status(500).json({ ok: false, error: 'Failed to save quiet hours' });
        }
    });

    // ─── GET /api/notifications/preferences ────────────────
    router.get('/preferences', requireAuth, async (req, res) => {
        try {
            const prefs = await notificationService.getPreferences(req.user.id);
            res.json({ ok: true, preferences: prefs });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to get preferences' });
        }
    });

    // ─── PUT /api/notifications/preferences ────────────────
    // Body: { category, enabled, sound, toasts, email, digest }
    router.put('/preferences', requireAuth, async (req, res) => {
        try {
            const { category, enabled, sound, toasts, email, digest } = req.body;
            if (!category) return res.status(400).json({ ok: false, error: 'Category required' });
            await notificationService.setPreference(req.user.id, category, {
                enabled,
                sound,
                toasts,
                email,
                digest,
            });
            res.json({ ok: true });
        } catch (err) {
            if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
            res.status(500).json({ ok: false, error: 'Failed to update preferences' });
        }
    });

    // ─── DELETE /api/notifications/preferences/:category ───
    router.delete('/preferences/:category', requireAuth, async (req, res) => {
        try {
            await notificationService.resetPreference(req.user.id, req.params.category);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to reset preference' });
        }
    });

    return router;
};
