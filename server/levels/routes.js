'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const store = require('./store');
const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.code, code: e.code }); next(e); } };
function publicRouter({ db, requireAuth }) {
    const router = express.Router();
    router.use(rateLimit({ windowMs: 60000, max: 240 }));
    router.use((req, res, next) => { res.set('Cache-Control', 'public, max-age=30'); next(); });
    router.get('/batch', handle(async (req, res) => res.json(await store.batch(db, String(req.query.subjects || '').split(',').filter(Boolean)))));
    router.get('/people/:username', handle(async (req, res) => res.json(await store.byUsername(db, req.params.username))));
    router.get('/board', (req, res, next) => {
        res.vary('Authorization'); res.vary('Cookie');
        if (req.headers.authorization || req.cookies?.ov_token) {
            res.set('Cache-Control', 'private, max-age=30');
            return requireAuth(req, res, next);
        }
        next();
    }, handle(async (req, res) => res.json(await store.board(db, req.user?.id))));
    return router;
}
function settingsRouter({ db, requireAuth }) {
    const router = express.Router();
    router.use(requireAuth, (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    router.get('/', handle(async (req, res) => {
        const row = await db.prepare('SELECT leaderboard FROM person_levels WHERE user_id = ?').get(req.user.id);
        res.json({ leaderboard: row?.leaderboard !== false });
    }));
    router.put('/', handle(async (req, res) => {
        if (typeof req.body?.leaderboard !== 'boolean') return res.status(400).json({ error: 'levels.invalid_setting' });
        await db.prepare('INSERT INTO person_levels(user_id, leaderboard) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET leaderboard = EXCLUDED.leaderboard').run(req.user.id, req.body.leaderboard);
        res.json({ leaderboard: req.body.leaderboard });
    }));
    return router;
}
function internalRoutes(router, principals) {
    router.post('/levels/award', principals.guard('network.levels.award'),
        rateLimit({ windowMs: 60000, max: 120, keyGenerator: req => req.principal.sub }),
        handle(async (req, res) => res.status(201).json(await store.award(req.app.locals.db, req.principal.sub.replace(/^svc:/, ''), req.body || {}))));
}
module.exports = { publicRouter, settingsRouter, internalRoutes };
