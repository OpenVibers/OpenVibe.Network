'use strict';
/**
 * OpenVibe.Network's wiring of the ADR-021 analytics module. The other files in this directory are
 * the module shared with OpenVibe.Live (server/analytics/) and OpenVibe.Tools (apps/_shared/analytics/);
 * keep them identical to those copies and put anything Network-specific here.
 *
 *   openAnalytics(dbPath)    the tracker for service 'openvibe-network' (NetworkAnalyticsTracker).
 *                            Network's analytics tables (analytics_events / _hourly / _daily …) live
 *                            in network.db, as they always
 *                            have; the tracker gets a better-sqlite3 connection of its own so its
 *                            per-connection settings (busy_timeout 250, secure_delete) never apply to
 *                            the identity connection (busy_timeout 5000).
 *   schedulePrune(tracker)   the nightly `analytics-prune` job: raw events older than 30 days are
 *                            deleted in bounded batches (retention.pruneRawEvents); rollups are kept.
 *                            First run 5 minutes after boot, then every 24 hours; timers are unref'd.
 *   prescrub(db)             Network's part of the one-time scrub (scripts/analytics-prune.js --scrub):
 *                            the path rules below applied to legacy rows and rollup top lists, before
 *                            the shared scrub templates them.
 *   PATH_OPTS                the normaliser options (param prefixes) the CLI passes to the shared scrub.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { AnalyticsTracker } = require('./tracker');
const privacy = require('./privacy');
const retention = require('./retention');

const SERVICE = 'openvibe-network';

/**
 * Words whose next path segment is a parameter on Network (on top of privacy.DEFAULT_PARAM_PREFIXES).
 * They matter when no Express route matched (a rate-limited or rejected request is templated from
 * its raw path), and to the one-time scrub of rows the old tracker stored raw: /avatar/<username>,
 * /api/auth/anon/<token>, /api/v1/projects/<slug>.
 */
const PARAM_PREFIXES = ['avatar', 'anon', 'projects'];
const PATH_OPTS = { paramPrefixes: new Set([...privacy.DEFAULT_PARAM_PREFIXES, ...PARAM_PREFIXES]) };

/**
 * A parameter behind two fixed words, which the shared normaliser cannot see: it turns `users` into a
 * prefix, so `/users/by-username/alex` would keep `alex`. Applied to the raw path before it.
 */
const PATH_RULES = [[/\/by-username\/[^/?#]+/gi, '/by-username/:username']];
function preReducePath(p) {
    let s = String(p);
    for (const [re, to] of PATH_RULES) s = s.replace(re, to);
    return s;
}

class NetworkAnalyticsTracker extends AnalyticsTracker {
    /** The raw path is only used when no Express route matched (a request refused before routing). */
    record(req, res, entryPath, responseTimeMs) {
        return super.record(req, res, preReducePath(entryPath || ''), responseTimeMs);
    }
}

function openAnalytics(dbPath, opts = {}) {
    const db = new Database(path.resolve(dbPath));
    db.pragma('journal_mode = WAL');
    return new NetworkAnalyticsTracker(db, SERVICE, { retention: false, paramPrefixes: PARAM_PREFIXES, ...opts });
}

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const tick = () => new Promise((r) => setImmediate(r));

/** PATH_RULES over legacy raw rows (id-range batches) and rollup top lists. Returns { rows, hourly, daily }. */
async function prescrub(db, { batchSize = retention.DEFAULT_BATCH } = {}) {
    const out = { rows: 0, hourly: 0, daily: 0 };
    if (!tableExists(db, 'analytics_events')) return out;
    db.function('ov_network_path', { deterministic: true }, (p) => (p == null ? null : preReducePath(p)));
    const { lo, hi } = db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM analytics_events').get();
    const upd = db.prepare("UPDATE analytics_events SET path = ov_network_path(path) WHERE id >= ? AND id < ? AND path LIKE '%/by-username/%' AND path IS NOT ov_network_path(path)");
    for (let from = lo; lo != null && from <= hi; from += batchSize) {
        out.rows += upd.run(from, from + batchSize).changes;
        await tick();
    }
    for (const table of ['analytics_hourly', 'analytics_daily']) {
        if (!tableExists(db, table)) continue;
        const rows = db.prepare(`SELECT id, top_paths FROM ${table} WHERE top_paths LIKE '%/by-username/%'`).all();
        const set = db.prepare(`UPDATE ${table} SET top_paths = ? WHERE id = ?`);
        db.transaction(() => {
            for (const r of rows) {
                const next = retention.reduceTopList(r.top_paths, 'path', preReducePath);
                if (next != null) { set.run(next, r.id); out[table === 'analytics_hourly' ? 'hourly' : 'daily']++; }
            }
        })();
    }
    return out;
}

function schedulePrune(tracker, { initialDelayMs = 5 * 60 * 1000, intervalMs = 24 * 60 * 60 * 1000, log = console.log } = {}) {
    let running = false;
    const run = async () => {
        if (running) return null;
        running = true;
        try {
            const out = await retention.pruneRawEvents(tracker.db, { days: retention.MAX_DAYS });
            if (out.deleted) log(`[Analytics] pruned ${out.deleted} raw events older than ${out.cutoff}`);
            return out;
        } catch (err) {
            console.error('[Analytics] analytics-prune error:', err.message);
            return null;
        } finally {
            running = false;
        }
    };
    const first = setTimeout(run, initialDelayMs);
    const every = setInterval(run, intervalMs);
    first.unref();
    every.unref();
    return { run, stop() { clearTimeout(first); clearInterval(every); } };
}

module.exports = { SERVICE, PARAM_PREFIXES, PATH_OPTS, NetworkAnalyticsTracker, preReducePath, openAnalytics, schedulePrune, prescrub };
