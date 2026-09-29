'use strict';
/**
 * OpenVibe.Network's wiring of the ADR-021 analytics module, openvibe-shared/analytics (the one module
 * Live, Tools and Network use). Only what is Network-specific lives here:
 *
 *   openAnalytics(db)        the tracker for service 'openvibe-network' on the service's own PostgreSQL
 *                            handle (analyticsSchema() is migrations/0002_analytics.sql). The request
 *                            path never waits for the database: the tracker buffers and flushes every
 *                            5 s (and at 100 rows); reads and rollups are async.
 *   schedulePrune(tracker)   ADR-021's raw-event retention (pruneRawEventsPg): raw events older than 30
 *                            days go, in batches; rollups stay. The tracker schedules this itself at boot,
 *                            so this is the on-demand form for operator scripts.
 *   PATH_OPTS                { paramPrefixes, pathRules }: the path options the tracker uses.
 *
 * A request with `Sec-GPC: 1` or `DNT: 1` is not recorded (openvibe-shared v1.4.0).
 */

const { AnalyticsTrackerPg, analyticsSchema, pruneRawEventsPg } = require('openvibe-shared/analytics/pg');

const SERVICE = 'openvibe-network';

/**
 * Words whose next path segment is a parameter on Network (on top of the package's default prefixes).
 * They matter when no Express route matched (a rate-limited or rejected request is templated from
 * its raw path), and to the one-time scrub of rows the old tracker stored raw: /avatar/<username>,
 * /api/auth/anon/<token>, /api/v1/projects/<slug>.
 */
const PARAM_PREFIXES = ['avatar', 'anon', 'projects'];

/**
 * A parameter behind two fixed words, which the shared normaliser cannot see: it turns `users` into a
 * prefix, so `/users/by-username/alex` would keep `alex`. Applied to the raw path before it.
 */
const PATH_RULES = [[/\/by-username\/[^/?#]+/gi, '/by-username/:username']];

const PATH_OPTS = { paramPrefixes: PARAM_PREFIXES, pathRules: PATH_RULES };

function openAnalytics(db, opts = {}) {
    return new AnalyticsTrackerPg(db, SERVICE, { paramPrefixes: PARAM_PREFIXES, pathRules: PATH_RULES, ...opts });
}

/** ADR-021 raw-event retention on demand (the tracker also schedules it at boot, after 5 minutes). */
function schedulePrune(tracker, opts = {}) {
    return pruneRawEventsPg(tracker.db, opts);
}

module.exports = { SERVICE, PARAM_PREFIXES, PATH_RULES, PATH_OPTS, analyticsSchema, openAnalytics, schedulePrune };
