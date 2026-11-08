'use strict';
// The Node's latest release, read from GitHub (OpenVibers/OpenVibe.Node). The page shows the version and the
// checksums; /install answers with the same release's installer. The answer is cached for ten minutes, so a
// visitor never waits on GitHub, and when GitHub cannot be reached the last good answer is used; a cold start
// without GitHub falls back to the release links that always resolve (the "latest" ones).

const REPO = 'OpenVibers/OpenVibe.Node';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const TTL_MS = 10 * 60 * 1000; // ten minutes
const TIMEOUT_MS = 8000;
const LATEST = `https://github.com/${REPO}/releases/latest`;

// What the page says when GitHub cannot be reached and nothing was cached: no version (the page says "the latest
// release" instead of naming one that may be old), and the links that always resolve to the newest release.
const FALLBACK = {
    version: '',
    publishedAt: '',
    url: LATEST,
    installUrl: `https://github.com/${REPO}/releases/latest/download/install.sh`,
    checksumsUrl: `https://github.com/${REPO}/releases/latest/download/SHA256SUMS`,
};

let cached = null;      // { at, data }
let inflight = null;    // one fetch at a time

/** The release fields the page and /install use. */
function shape(json) {
    const tag = String(json.tag_name || '').trim();
    const assets = Array.isArray(json.assets) ? json.assets : [];
    const asset = (name) => assets.find((a) => a && a.name === name);
    const install = asset('install.sh');
    const sums = asset('SHA256SUMS');
    return {
        version: tag,
        assets: assets.map((a) => String((a && a.name) || '')).filter(Boolean),
        publishedAt: String(json.published_at || ''),
        url: String(json.html_url || (tag ? `https://github.com/${REPO}/releases/tag/${tag}` : LATEST)),
        installUrl: String((install && install.browser_download_url) || (tag ? `https://github.com/${REPO}/releases/download/${tag}/install.sh` : FALLBACK.installUrl)),
        checksumsUrl: String((sums && sums.browser_download_url) || (tag ? `https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS` : FALLBACK.checksumsUrl)),
    };
}

/** Fetch the latest release. Returns the cached answer while it is fresh, and never throws. */
async function latest({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (cached && now() - cached.at < TTL_MS) return { ...cached.data, cached: true };
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
            let res;
            try {
                res = await fetchImpl(API, {
                    signal: controller ? controller.signal : undefined,
                    headers: { accept: 'application/vnd.github+json', 'user-agent': 'openvibe-network' },
                });
            } finally {
                if (timer) clearTimeout(timer);
            }
            if (!res || !res.ok) throw new Error(`GitHub releases API answered ${res && res.status}`);
            const data = shape(await res.json());
            if (!data.version) throw new Error('GitHub releases API answered without a tag');
            cached = { at: now(), data };
            return { ...data, cached: false };
        } catch {
            // GitHub is down or slow: the last good answer, or the written-down one. The page still works.
            return { ...(cached ? cached.data : FALLBACK), cached: true, stale: true };
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/** The version without the leading v, for a sentence. */
function versionLabel(release) {
    return String((release && release.version) || '').replace(/^v/, '');
}

/** The release date, the day it was published. */
function dateLabel(release) {
    const iso = String((release && release.publishedAt) || '');
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
}

module.exports = { latest, versionLabel, dateLabel, REPO, API, TTL_MS, FALLBACK, LATEST };
