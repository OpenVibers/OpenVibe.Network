'use strict';
/**
 * Release health (roadmap WS-P task 15): what open tabs say about each service's releases, read from the
 * service's own /metrics on loopback during the ecosystem health poll (only for services whose
 * /release.json names a metrics_url, i.e. that collect release-watch reports; openvibe-shared ≥ 1.18.0).
 *
 *   sessions   release_client_sessions{generation}: tabs heard from in the last 12 minutes, on the
 *              release the service serves (current) or an older one
 *   updates    release_client_updates_total{outcome,reason}: prompts, in-place updates, reloads,
 *              deferrals and failures since the service's process started (so, for this release)
 *   drain      how long after a release went live the last older tab left. A tab beats every 5
 *              minutes and the counts live in the service's process, which a deploy restarts, so
 *              "no older tab" means something only once the process has been up WARM_MS; a release
 *              whose first such reading is already 0 drained "within" that time.
 *
 * In memory: Network's own restart starts the history again (the status page says since when).
 */
const WARM_MS = 6 * 60 * 1000;
const KEEP = 10;
const SESSIONS_RE = /^release_client_sessions\{generation="(current|older)"\} (\d+(?:\.\d+)?)$/;
const UPDATES_RE = /^release_client_updates_total\{outcome="([a-z]+)",reason="([a-z+-]+)"\} (\d+(?:\.\d+)?)$/;
const OUTCOMES = ['prompted', 'applied', 'reloaded', 'deferred', 'failed'];

/** The release-client series of a Prometheus text body: { sessions: { current, older } | null, updates: { outcome: { reason: n } } }. */
function parseClientMetrics(text) {
    let sessions = null;
    const updates = {};
    for (const line of String(text || '').split('\n')) {
        if (!line.startsWith('release_client_')) continue;
        let m = SESSIONS_RE.exec(line);
        if (m) { sessions = sessions || { current: 0, older: 0 }; sessions[m[1]] = Math.round(Number(m[2])); continue; }
        m = UPDATES_RE.exec(line);
        if (m && OUTCOMES.includes(m[1])) (updates[m[1]] = updates[m[1]] || {})[m[2]] = Math.round(Number(m[3]));
    }
    return { sessions, updates };
}

const total = (byReason) => Object.values(byReason || {}).reduce((a, b) => a + b, 0);

function createReleaseHealth({ now = () => Date.now(), warmMs = WARM_MS, keep = KEEP } = {}) {
    const state = new Map();
    const startedAt = new Date(now()).toISOString();
    const iso = (t) => new Date(t).toISOString();

    /** One poll's reading for a service: its release (id, released_at, booted_at) and parsed metrics, or null metrics. */
    function observe(id, release, metrics) {
        if (!release || !release.release) return;
        let s = state.get(id);
        if (!s || s.release !== release.release) {
            const history = s ? [summaryOf(s, 'superseded'), ...s.history].slice(0, keep) : [];
            const since = release.booted_at || release.released_at || iso(now());
            s = { release: release.release, since, booted_at: release.booted_at || null, sessions: null, updates: {}, measured_at: null, peak_older: 0, drained_at: null, drain_s: null, within: false, history };
            // First seen after its warm-up (Network restarted later): an older tab that left before now left unseen.
            s.late = now() - Date.parse(since) >= warmMs;
            state.set(id, s);
        } else if (release.booted_at && release.booted_at !== s.booted_at) {
            s.booted_at = release.booted_at;   // restarted on the same release: its counts start again, and so does the warm-up
        }
        if (!metrics) return;
        s.measured_at = iso(now());
        s.updates = metrics.updates || {};
        if (!metrics.sessions) return;
        s.sessions = metrics.sessions;
        s.peak_older = Math.max(s.peak_older, metrics.sessions.older);
        const up = now() - Date.parse(s.booted_at || s.since);
        if (!s.drained_at && up >= warmMs && metrics.sessions.older === 0) {
            s.drained_at = iso(now());
            const unseen = s.peak_older === 0;   // no older tab at the first warm reading: it drained within the warm-up
            s.drain_s = unseen && s.late ? null : Math.max(0, Math.round((now() - Date.parse(s.since)) / 1000));
            s.within = unseen && !s.late;
        }
    }

    function summaryOf(s, end) {
        return { release: s.release, since: s.since, drained_at: s.drained_at, drain_s: s.drain_s, within: s.within, peak_older: s.peak_older, end: s.drained_at ? 'drained' : end };
    }

    /** The view for one service, or null when nothing was read for it. */
    function view(id) {
        const s = state.get(id);
        if (!s) return null;
        const up = now() - Date.parse(s.booted_at || s.since);
        const drain = !s.sessions ? { state: 'unknown' }
            : s.drained_at ? { state: 'drained', drained_at: s.drained_at, seconds: s.drain_s, within: s.within, ...(s.drain_s === null ? { seen_late: true } : {}) }
                : up < warmMs ? { state: 'warming', ready_in_s: Math.round((warmMs - up) / 1000), older: s.sessions.older }
                    : { state: 'draining', older: s.sessions.older, for_s: Math.round((now() - Date.parse(s.since)) / 1000) };
        const u = s.updates;
        return {
            release: s.release,
            since: s.since,
            measured_at: s.measured_at,
            sessions: s.sessions,
            counts: Object.fromEntries(OUTCOMES.map((o) => [o, total(u[o])])),
            deferred: u.deferred || {},
            failed: u.failed || {},
            drain,
            history: s.history,
        };
    }

    return { observe, view, startedAt: () => startedAt, WARM_MS: warmMs };
}

module.exports = { createReleaseHealth, parseClientMetrics, WARM_MS };
