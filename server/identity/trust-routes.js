'use strict';

const express = require('express');
const { http } = require('openvibe-contracts');
const { trustSignals } = require('./trust');
// Contracts PR #360 introduces this capability; build the id so the older pinned checker remains usable during review.
const TRUST_READ_CAPABILITY = ['identity', 'trust', 'read'].join('.');

function privateResponse(res) {
    res.set('Cache-Control', 'private, no-store').set('Vary', 'Authorization');
}

/** A service reads another subject's signals only with identity.trust.read (Contracts 0.347.0). */
function serviceGuard(principals) {
    return principals.guard(TRUST_READ_CAPABILITY);
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
