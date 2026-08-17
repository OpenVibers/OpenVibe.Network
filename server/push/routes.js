'use strict';

const express = require('express');
const router = express.Router();
const pushService = require('./push-service');

// All routes require auth (middleware applied by parent)

/** GET /api/push/vapid-key — return the public VAPID key for client subscription */
router.get('/vapid-key', (req, res) => {
    const key = pushService.getPublicKey();
    if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
    res.json({ publicKey: key });
});

/** POST /api/push/subscribe — save a PushSubscription */
router.post('/subscribe', (req, res) => {
    try {
        const { subscription } = req.body;
        if (!subscription) return res.status(400).json({ error: 'Missing subscription' });
        pushService.subscribe(req.user.id, subscription);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/** POST /api/push/unsubscribe — remove a PushSubscription */
router.post('/unsubscribe', (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    pushService.unsubscribe(req.user.id, endpoint);
    res.json({ success: true });
});

/** GET /api/push/status — check subscription + live notification preferences */
router.get('/status', (req, res) => {
    const db = req.app.locals.db;
    const subs = db.prepare('SELECT id, endpoint, created_at FROM push_subscriptions WHERE user_id = ?').all(req.user.id);
    const notifService = req.app.locals.notificationService;
    const streamPref = notifService
        ? notifService._getPrefByCategory.get(req.user.id, 'stream') || { enabled: 1, sound: 1, toasts: 1 }
        : { enabled: 1, sound: 1, toasts: 1 };
    const allLivePref = notifService
        ? notifService._getPrefByCategory.get(req.user.id, 'stream_live_all') || { enabled: 0 }
        : { enabled: 0 };

    res.json({
        ok: true,
        subscribed: subs.length > 0,
        subscription_count: subs.length,
        preferences: {
            stream_enabled: !!streamPref.enabled,
            stream_live_all: !!allLivePref.enabled,
        },
    });
});

/** PUT /api/push/live-preferences — toggle live notification mode */
router.put('/live-preferences', (req, res) => {
    const { stream_live_all } = req.body;
    const notifService = req.app.locals.notificationService;
    if (!notifService) return res.status(503).json({ error: 'Notification service unavailable' });

    if (stream_live_all !== undefined) {
        notifService.setPreference(req.user.id, 'stream_live_all', {
            enabled: !!stream_live_all,
            sound: 1,
            toasts: 1,
        });
    }

    res.json({ ok: true });
});

module.exports = router;
