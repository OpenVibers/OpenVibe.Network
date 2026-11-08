'use strict';

const express = require('express');
const { http, capabilities } = require('openvibe-contracts');
const { trustSignals } = require('./trust');

function privateResponse(res) {
    res.set('Cache-Control', 'private, no-store').set('Vary', 'Authorization');
}

/**
 * During the Contracts PR window the pinned package does not yet know identity.trust.read. Keep the
 * route testable against that pin by accepting the existing identity guard plus the new claim; once
 * the capability is in the pin, use the normal grant-aware guard directly.
 */
function serviceGuard(principals) {
    if (capabilities.get('identity.trust.read')) return principals.guard('identity.trust.read');
    const resolveGuard = principals.guard('identity.subject.resolve');
    return (req, res, next) => resolveGuard(req, res, () => {
        if (!req.principal || !Array.isArray(req.principal.cap) || !req.principal.cap.includes('identity.trust.read')) {
            return http.sendProblem(res, 403, 'capability.denied', { detail: 'identity.trust.read is required', ctx: req.ov });
        }
        next();
    });
}

function serviceRouter(principals) {
    const router = express.Router();
    router.use(http.middleware());
    router.use((_req, res, next) => { privateResponse(res); next(); });
    router.get('/:subject', serviceGuard(principals), async (req, res) => {
        const signals = await trustSignals(req.app.locals.db, String(req.params.subject));
        if (!signals) return http.sendProblem(res, 404, 'identity.subject_not_found', { detail: 'no trust signals for that subject', ctx: req.ov });
        res.json(signals);
    });
    return router;
}

/** The caller's own account or raw anonymous-session token; never accepts a subject from the request. */
function meRouter() {
    const router = express.Router();
    router.use(http.middleware());
    router.get('/', async (req, res) => {
        privateResponse(res);
        const { sessionToken } = require('../auth/session');
        const token = sessionToken(req);
        if (!token) return http.sendProblem(res, 401, 'auth.required', { detail: 'a personal or guest token is required', ctx: req.ov });

        const db = req.app.locals.db;
        const session = await require('../auth/session').verifySession(token, {
            db, publicKey: req.app.locals.publicKey, config: req.app.locals.config,
        });
        let subjectId = session.user && session.user.subject_id;
        if (session.error) {
            const guest = await db.prepare('SELECT subject_id FROM anon_users WHERE session_token = ?').get(token);
            subjectId = guest && guest.subject_id;
        }
        if (!subjectId) return http.sendProblem(res, session.status || 401, session.error || 'identity.subject_not_found', { detail: 'the token has no live trust subject', ctx: req.ov });
        const signals = await trustSignals(db, subjectId);
        if (!signals) return http.sendProblem(res, 404, 'identity.subject_not_found', { detail: 'no trust signals for this token', ctx: req.ov });
        res.json(signals);
    });
    return router;
}

module.exports = { serviceRouter, meRouter, serviceGuard };
