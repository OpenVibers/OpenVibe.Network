'use strict';
/**
 * The service worker's kill switch (openvibe-shared openvibe-sw.js / sw.js; README "The kill switch"): every OpenVibe
 * site's worker asks GET /api/v1/sw-config, at most every five minutes, and { "enabled": false } makes every worker on
 * every site unregister itself and drop its caches, so a bad worker release is undone here, not with a deploy on every
 * site. A worker that cannot reach this keeps working. (11-28: the route was never built, so the switch did not exist:
 * every worker's ask was a 404, 60 an hour.)
 *
 *   GET /api/v1/sw-config → { enabled } (OV_SW_ENABLED=false turns the workers off), public, five minutes, any origin
 */
const express = require('express');

function createSwConfigRoutes({ env = process.env } = {}) {
    const router = express.Router();
    router.get('/', (_req, res) => {
        const enabled = String(env.OV_SW_ENABLED == null ? 'true' : env.OV_SW_ENABLED).trim().toLowerCase() !== 'false';
        res.set({ 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }).json({ enabled });
    });
    return router;
}

module.exports = { createSwConfigRoutes };
