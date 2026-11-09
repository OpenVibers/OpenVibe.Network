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
 * Read hourly. Main's head comes first through git's own protocol (ls-refs, as `git ls-remote` asks it), which is not
 * GitHub's REST API and spends none of its rate limit. Only when main or the deployed commit moved since the last check
 * does it ask GitHub's compare API (GET /repos/{repo}/compare/{deployed}...main; GITHUB_TOKEN or the admin GitHub token
 * raises the limit). Without a token the host's address gets 60 REST calls an hour, shared with ovhost's CI checks and
 * the Git service's mirrors; one compare per service per hour spent all of them (2026-11-09). A failure keeps the
 * last answer. Main ahead by documentation and tests only (README, STATUS.json, docs/*.md, tests, .github/) counts
 * as current: nothing that runs differs. `since` is the committer date of the oldest undeployed commit, so the drift age is how
 * long main has had something production does not run. Shown on /status and in
 * /api/v1/registry/releases; openvibe_deploy_drift_seconds{service} feeds the Prometheus alert
 * OpenVibeDeployDrift (24 hours; OpenVibe.Host deploy/prometheus/openvibe-rules.yml).
 */
const SHA_RE = /^[0-9a-f]{7,40}$/;
// Files that document or test a service and are not part of what it runs (OpenVibe.Host lib/reconcile.js, the
// deploy controller, does not deploy them either): main ahead by only these is not drift.
const DOCS_OR_TESTS = /^(README\.md|STATUS\.json|CHANGELOG\.md|SECURITY\.md|docs\/.*\.md|tests?\/|\.github\/)|\.test\.[cm]?[jt]s$/;
const REPO_RE = /^OpenVibers\/[A-Za-z0-9._-]{1,100}$/;
// ls-refs for refs/heads/main in git's protocol v2: three pkt-lines (length in hex, counting its own four) and a flush.
const LS_REFS_MAIN = '0014command=ls-refs\n0001001fref-prefix refs/heads/main\n0000';
const MAIN_REF_RE = /([0-9a-f]{40}) refs\/heads\/main(?:\n|$)/;

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
    // The token may come from an async source (server/index.js reads the integration's): awaited, or every call sent
    // "Bearer [object Promise]" and GitHub answered 401 (from 2026-09-25 until 10-23).
    const tokenNow = async () => String((await (typeof token === 'function' ? token() : token)) || '');
    /** Main's head commit, or null (a private repository, GitHub down, an answer that is not git's). */
    async function mainHead(repository) {
        try {
            const res = await fetchImpl(`https://github.com/${repository}.git/git-upload-pack`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result', 'Git-Protocol': 'version=2', 'User-Agent': 'git/2 OpenVibe.Network registry' },
                body: LS_REFS_MAIN,
                signal: AbortSignal.timeout(10000),
            });
            if (!res || !res.ok || typeof res.text !== 'function') return null;
            const m = MAIN_REF_RE.exec(String(await res.text()).slice(0, 4096));
            return m ? m[1] : null;
        } catch { return null; }
    }
    async function checkOne({ id, release, repository }) {
        const at = new Date(now()).toISOString();
        if (!SHA_RE.test(String(release || '')) || !REPO_RE.test(String(repository || ''))) { state.delete(id); return null; }
        const prev = state.get(id);
        const head = await mainHead(repository);
        if (head) {
            // Production runs main's head: current, and no REST call.
            if (head.startsWith(String(release).toLowerCase())) {
                state.set(id, { repo: repository, deployed: release, main: head.slice(0, 12), checked_at: at, state: 'current', behind_by: 0 });
                return state.get(id);
            }
            // Neither main nor the deployed commit moved since the last full answer: it still holds.
            if (prev && !prev.stale && prev.state !== 'unknown' && prev.deployed === release && prev.main === head.slice(0, 12)) {
                state.set(id, { ...prev, checked_at: at });
                return state.get(id);
            }
        }
        try {
            const auth = await tokenNow();
            const res = await fetchImpl(`https://api.github.com/repos/${repository}/compare/${release}...main`, {
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenVibe.Network registry', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
                signal: AbortSignal.timeout(10000),
            });
            if (res.status === 404) { state.set(id, { repo: repository, deployed: release, state: 'unknown', error: 'commit not on GitHub', checked_at: at }); return state.get(id); }
            if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
            const body = await res.json();
            const ahead = Number(body.ahead_by) || 0;
            const behind = Number(body.behind_by) || 0;
            const commits = Array.isArray(body.commits) ? body.commits : [];
            const main = head ? head.slice(0, 12) : commits.length ? String(commits[commits.length - 1].sha || '').slice(0, 12) : String(release).slice(0, 12);
            // GitHub's status (base = deployed, head = main): identical | ahead (main has more) | behind |
            // diverged (the deployed build has commits main lacks); the counts when it is missing.
            const st = body.status || (behind > 0 ? 'diverged' : ahead > 0 ? 'ahead' : 'identical');
            let row;
            if (st === 'behind' || st === 'diverged') row = { state: 'diverged', behind_by: ahead };
            else if (st === 'identical' || ahead === 0) row = { state: 'current', behind_by: 0 };
            else if (Array.isArray(body.files) && body.files.length && body.files.length < 300 && body.files.every((f) => DOCS_OR_TESTS.test(String(f.filename || '')))) {
                row = { state: 'current', behind_by: 0, docs_only_ahead: ahead };
            } else {
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
        const run = () => refresh().catch((err) => { if (log && log.warn) log.warn(`[drift] refresh failed: ${err.message}`); });
        const first = setTimeout(run, 60 * 1000);
        if (first.unref) first.unref();
        timer = setInterval(run, intervalMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { refresh, checkOne, start, stop };
}

function _reset() { state.clear(); if (timer) clearInterval(timer); timer = null; }

module.exports = { createDeployDrift, current, all, driftSeconds, _reset };
