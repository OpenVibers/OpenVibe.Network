'use strict';

// ═══════════════════════════════════════════════════════════════
// Notification API Routes
// REST endpoints for the notification UI client to interact with.
// Mounted at /api/notifications
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

module.exports = function createNotificationRoutes(db, notificationService, requireAuth) {

    // ─── GET /api/notifications ────────────────────────────
    // Query params: limit, offset, category, unread_only
    router.get('/', requireAuth, (req, res) => {
        try {
            const userId = req.user.id;
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const offset = parseInt(req.query.offset) || 0;
            const category = req.query.category || null;
            const unreadOnly = req.query.unread_only === '1' || req.query.unread_only === 'true';

            const notifications = notificationService.getForUser(userId, { limit, offset, category, unreadOnly });
            res.json({ ok: true, notifications });
        } catch (err) {
            console.error('[Notifications] GET / error:', err);
            res.status(500).json({ ok: false, error: 'Failed to fetch notifications' });
        }
    });

    // ─── GET /api/notifications/unread-count ───────────────
    router.get('/unread-count', requireAuth, (req, res) => {
        try {
            const count = notificationService.getUnreadCount(req.user.id);
            res.json({ ok: true, count });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to get count' });
        }
    });

    // ─── GET /api/notifications/unread-by-category ─────────
    router.get('/unread-by-category', requireAuth, (req, res) => {
        try {
            const categories = notificationService.getUnreadByCategory(req.user.id);
            res.json({ ok: true, categories });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to get counts' });
        }
    });

    // ─── GET /api/notifications/newest ─────────────────────
    router.get('/newest', requireAuth, (req, res) => {
        try {
            const newest = notificationService.getNewest(req.user.id);
            res.json({ ok: true, notification: newest || null });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to get newest' });
        }
    });

    // ─── POST /api/notifications/:id/read ──────────────────
    router.post('/:id/read', requireAuth, (req, res) => {
        try {
            const ok = notificationService.markRead(req.params.id, req.user.id);
            res.json({ ok });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to mark read' });
        }
    });

    // ─── POST /api/notifications/read-all ──────────────────
    router.post('/read-all', requireAuth, (req, res) => {
        try {
            const { category } = req.body || {};
            const changed = notificationService.markAllRead(req.user.id, category || null);
            res.json({ ok: true, changed });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to mark all read' });
        }
    });

    // ─── POST /api/notifications/:id/dismiss ───────────────
    router.post('/:id/dismiss', requireAuth, (req, res) => {
        try {
            const ok = notificationService.dismiss(req.params.id, req.user.id);
            res.json({ ok });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to dismiss' });
        }
    });

    // ─── DELETE /api/notifications ─────────────────────────
    // Dismiss all
    router.delete('/', requireAuth, (req, res) => {
        try {
            const changed = notificationService.dismissAll(req.user.id);
            res.json({ ok: true, changed });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to dismiss all' });
        }
    });

    // ─── GET /api/notifications/preferences ────────────────
    router.get('/preferences', requireAuth, (req, res) => {
        try {
            const prefs = notificationService.getPreferences(req.user.id);
            res.json({ ok: true, preferences: prefs });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to get preferences' });
        }
    });

    // ─── PUT /api/notifications/preferences ────────────────
    // Body: { category, enabled, sound, toasts, email }
    router.put('/preferences', requireAuth, (req, res) => {
        try {
            const { category, enabled, sound, toasts, email } = req.body;
            if (!category) return res.status(400).json({ ok: false, error: 'Category required' });
            notificationService.setPreference(req.user.id, category, {
                enabled,
                sound,
                toasts,
                email,
            });
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to update preferences' });
        }
    });

    // ─── DELETE /api/notifications/preferences/:category ───
    router.delete('/preferences/:category', requireAuth, (req, res) => {
        try {
            notificationService.resetPreference(req.user.id, req.params.category);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: 'Failed to reset preference' });
        }
    });

    return router;
};
