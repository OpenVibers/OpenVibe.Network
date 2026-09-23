'use strict';
/**
 * OpenVibe.Network's wiring of the ADR-021 analytics module, openvibe-shared/analytics (the one module
 * Live, Tools and Network use). Only what is Network-specific lives here:
 *
 *   openAnalytics(dbPath)    the tracker for service 'openvibe-network'. Network's analytics tables
 *                            (analytics_events / _hourly / _daily …) live in network.db, as they always
 *                            have; the tracker gets a better-sqlite3 connection of its own so its
 *                            per-connection settings (busy_timeout 250, secure_delete) never apply to
 *                            the identity connection (busy_timeout 5000).
 *   schedulePrune(tracker)   the nightly `analytics-prune` job (retention.schedulePrune): raw events
 *                            older than 30 days are deleted in bounded batches; rollups are kept.
 *                            First run 5 minutes after boot, then every 24 hours; timers are unref'd.
 *   PATH_OPTS                { paramPrefixes, pathRules }: the path options the tracker and
 *                            scripts/analytics-prune.js (prune-cli, for the one-time scrub) both use.
 *
 * A request with `Sec-GPC: 1` or `DNT: 1` is not recorded (openvibe-shared v1.4.0).
 */

const path = require('path');
const Database = require('better-sqlite3');
const { AnalyticsTracker, retention } = require('openvibe-shared/analytics');

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

function openAnalytics(dbPath, opts = {}) {
    const db = new Database(path.resolve(dbPath));
    db.pragma('journal_mode = WAL');
    return new AnalyticsTracker(db, SERVICE, { retention: false, paramPrefixes: PARAM_PREFIXES, pathRules: PATH_RULES, ...opts });
}

function schedulePrune(tracker, opts = {}) {
    return retention.schedulePrune(tracker.db, { label: 'Analytics', ...opts });
}

module.exports = { SERVICE, PARAM_PREFIXES, PATH_RULES, PATH_OPTS, openAnalytics, schedulePrune };
