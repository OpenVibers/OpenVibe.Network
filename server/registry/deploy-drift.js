'use strict';
/**
 * Production drift (roadmap WS-S task 7): how far each running service's deployed commit (its
 * /release.json `release`) is behind its repository's main branch on GitHub, and since when.
 *
 *   state   current   the deployed commit is main's head (or main is not ahead of it)
 *           behind    main has commits that are not deployed: behind_by, since (the first of them)
 *           diverged  the deployed commit is not an ancestor of main (a local or force-pushed build)
 *           unknown   GitHub did not answer, or the commit is not on GitHub
 *
 * Read hourly with GitHub's compare API (GET /repos/{repo}/compare/{deployed}...main, one call per
 * running service; GITHUB_TOKEN or the admin GitHub token raises the rate limit). A failure keeps the
 * last answer. `since` is the committer date of the oldest undeployed commit, so the drift age is how
 * long main has had something production does not run. Shown on /status and in
 * /api/v1/registry/releases; openvibe_deploy_drift_seconds{service} feeds the Prometheus alert
 * OpenVibeDeployDrift (24 hours; OpenVibe.Host deploy/prometheus/openvibe-rules.yml).
 */
const SHA_RE = /^[0-9a-f]{7,40}$/;
const REPO_RE = /^OpenVibers\/[A-Za-z0-9._-]{1,100}$/;

const state = new Map();   // service id -> { repo, deployed, state, behind_by, since, main, checked_at, error }
let timer = null;

function current(id) { return state.get(id) || null; }
function all() { return Object.fromEntries(state); }

/** Seconds main has been ahead of production, per service (0 when current; nothing when unknown). */
function driftSeconds(now = Date.now()) {
    const out = [];
    for (const [id, d] of state) {
        if (d.state === 'current') out.push({ labels: { service: id }, value: 0 });
        else if (d.state === 'behind' && d.since) out.push({ labels: { service: id }, value: Math.max(0, Math.round((now - Date.parse(d.since)) / 1000)) });
    }
    return out;
}

/**
 * services(): [{ id, release, repository }] for what runs now (the registry's releases view).
 */
function createDeployDrift({ services, fetchImpl = globalThis.fetch, token = () => process.env.GITHUB_TOKEN || '', intervalMs = 3600e3, now = () => Date.now(), log = console } = {}) {
    const tokenNow = () => (typeof token === 'function' ? token() : token) || '';
    async function checkOne({ id, release, repository }) {
        const at = new Date(now()).toISOString();
        if (!SHA_RE.test(String(release || '')) || !REPO_RE.test(String(repository || ''))) { state.delete(id); return null; }
        const prev = state.get(id);
        try {
            const res = await fetchImpl(`https://api.github.com/repos/${repository}/compare/${release}...main`, {
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenVibe.Network registry', ...(tokenNow() ? { Authorization: `Bearer ${tokenNow()}` } : {}) },
                signal: AbortSignal.timeout(10000),
            });
            if (res.status === 404) { state.set(id, { repo: repository, deployed: release, state: 'unknown', error: 'commit not on GitHub', checked_at: at }); return state.get(id); }
            if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
            const body = await res.json();
            const ahead = Number(body.ahead_by) || 0;
            const behind = Number(body.behind_by) || 0;
            const commits = Array.isArray(body.commits) ? body.commits : [];
            const main = commits.length ? String(commits[commits.length - 1].sha || '').slice(0, 12) : String(release).slice(0, 12);
            let row;
            if (behind > 0 && ahead === 0) row = { state: 'diverged', behind_by: 0 };
            else if (ahead === 0) row = { state: 'current', behind_by: 0 };
            else {
                const first = commits[0] && commits[0].commit && (commits[0].commit.committer || commits[0].commit.author);
                row = { state: 'behind', behind_by: ahead, since: first && first.date ? new Date(first.date).toISOString() : null };
            }
            state.set(id, { repo: repository, deployed: release, main, checked_at: at, ...row });
        } catch (err) {
            // Keep the last answer; say it is stale.
            state.set(id, prev ? { ...prev, stale: true, error: err.message } : { repo: repository, deployed: release, state: 'unknown', error: err.message, checked_at: at });
            if (log && log.warn) log.warn(`[drift] ${id}: ${err.message}`);
        }
        return state.get(id);
    }
    async function refresh() {
        const list = (typeof services === 'function' ? services() : services) || [];
        const seen = new Set();
        for (const s of list) { seen.add(s.id); await checkOne(s); }
        for (const id of [...state.keys()]) if (!seen.has(id)) state.delete(id);
        return all();
    }
    function start() {
        if (timer) return;
        const first = setTimeout(() => { refresh().catch(() => {}); }, 60 * 1000);
        if (first.unref) first.unref();
        timer = setInterval(() => { refresh().catch(() => {}); }, intervalMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { refresh, checkOne, start, stop };
}

function _reset() { state.clear(); if (timer) clearInterval(timer); timer = null; }

module.exports = { createDeployDrift, current, all, driftSeconds, _reset };
