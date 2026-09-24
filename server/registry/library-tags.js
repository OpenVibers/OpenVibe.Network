'use strict';
/**
 * The released libraries' latest published tags (vX.Y.Z on GitHub), so the registry reports what a
 * consumer can pin today rather than the version Network happens to have installed (it said
 * openvibe-sdk v0.5.0 while v0.8.0 was out). Read at boot and hourly; a failure keeps the last
 * answer, and until there is one the installed version stands. GITHUB_TOKEN raises the rate limit.
 */
const REPOS = { 'openvibe-sdk': 'OpenVibe.SDK', 'openvibe-shared': 'OpenVibe.Shared', 'openvibe-contracts': 'OpenVibe.Contracts', 'openvibe-publishing': 'OpenVibe.Publishing' };
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The highest vX.Y.Z among tag names, or null. */
function latestOf(names) {
    let best = null;
    for (const n of names || []) {
        const m = SEMVER.exec(String(n));
        if (!m) continue;
        const v = m.slice(1).map(Number);
        if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && (v[1] > best.v[1] || (v[1] === best.v[1] && v[2] > best.v[2])))) best = { name: n, v };
    }
    return best ? best.name : null;
}

function createLibraryTags({ fetchImpl = globalThis.fetch, token = process.env.GITHUB_TOKEN || '', intervalMs = 3600e3, onUpdate = null, log = console } = {}) {
    const latest = new Map();   // package -> 'vX.Y.Z'
    let timer = null;
    async function refresh() {
        for (const [pkg, repo] of Object.entries(REPOS)) {
            try {
                const res = await fetchImpl(`https://api.github.com/repos/OpenVibers/${repo}/tags?per_page=100`, {
                    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenVibe.Network registry', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                    signal: AbortSignal.timeout(10000),
                });
                if (!res.ok) continue;
                const tag = latestOf((await res.json()).map((t) => t && t.name));
                if (tag) latest.set(pkg, tag);
            } catch (err) { if (log && log.warn) log.warn(`[registry] ${repo} tags: ${err.message}`); }
        }
        const out = Object.fromEntries(latest);
        if (onUpdate && latest.size) onUpdate(out);
        return out;
    }
    function start() {
        if (timer) return;
        const first = setTimeout(() => { refresh().catch(() => {}); }, 5000);
        if (first.unref) first.unref();
        timer = setInterval(() => { refresh().catch(() => {}); }, intervalMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { refresh, start, stop, get: (pkg) => latest.get(pkg) || null };
}

module.exports = { createLibraryTags, latestOf, REPOS };
