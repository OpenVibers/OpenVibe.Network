'use strict';
// The Node's latest release, read from GitHub (OpenVibers/OpenVibe.Link). The page shows the version and the
// checksums; /install answers with the same release's installer.
//
// The answer is held for fifteen minutes in memory and on disk (under DATA_DIR), so a restart serves the last
// good answer at once instead of waiting on GitHub. When the hold is over the visitor still gets the last
// answer immediately and a refresh runs in the background; when GitHub cannot be reached the last good answer
// is kept, and the page says how old it is only once it is more than a day old. A cold start without GitHub
// falls back to the release links that always resolve (the "latest" ones).
//
// GitHub allows 60 unauthenticated calls an hour per IP. GITHUB_TOKEN, when set, raises that limit. The token
// is read from the environment at request time and is never logged.

const fs = require('fs');
const path = require('path');

const REPO = 'OpenVibers/OpenVibe.Link';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const TTL_MS = 15 * 60 * 1000; // fifteen minutes
const TIMEOUT_MS = 8000;
const FAIL_COOLDOWN_MS = 60 * 1000; // a cold failure waits a minute before asking GitHub again
const DAY_MS = 24 * 60 * 60 * 1000;
const LATEST = `https://github.com/${REPO}/releases/latest`;
const CACHE_FILE = 'node-release.json';

// What the page says when GitHub cannot be reached and nothing was cached: no version (the page says "the latest
// release" instead of naming one that may be old), and the links that always resolve to the newest release.
const FALLBACK = {
    version: '',
    publishedAt: '',
    url: LATEST,
    installUrl: `https://github.com/${REPO}/releases/latest/download/install.sh`,
    checksumsUrl: `https://github.com/${REPO}/releases/latest/download/SHA256SUMS`,
};

let cached = null;       // { at, data } — at is when GitHub was read, epoch ms
let inflight = null;     // one fetch at a time
let diskFile = null;     // the file this process reads and writes
let failedAt = 0;        // a cold failure, so the next visitor does not wait 8 s too

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

/** GITHUB_TOKEN from the environment, or no Authorization at all. Never read from anywhere else, never logged. */
function authorization() {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Point the process at a data directory's copy, once per directory, and load what a previous process left.
 * `null` (or an empty string) turns the disk cache off, which is what tests with an injected clock and fetch use.
 */
function useDisk(dataDir) {
    if (dataDir === null || dataDir === '') return;
    const dir = dataDir === undefined ? (process.env.DATA_DIR || 'data') : String(dataDir);
    const file = path.join(path.resolve(dir), CACHE_FILE);
    if (file === diskFile) return;
    diskFile = file;
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!saved || !Number.isFinite(saved.at) || !saved.data || !String(saved.data.version || '').trim()) return;
        if (!cached || saved.at > cached.at) cached = { at: saved.at, data: saved.data };
    } catch {
        // No copy yet, or an unreadable one: the first fetch writes a fresh one.
    }
}

/** Keep the answer for the next process. A read-only data dir costs a restart's cache, never the page. */
function saveDisk(entry) {
    if (!diskFile) return;
    try {
        fs.mkdirSync(path.dirname(diskFile), { recursive: true });
        const tmp = `${diskFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entry));
        fs.renameSync(tmp, diskFile);
    } catch {
        // The page still works from memory.
    }
}

/** Ask GitHub once and keep the answer. Resolves to the shaped release; rejects when GitHub could not be read. */
async function fetchLatest({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
    try {
        let res;
        try {
            res = await fetchImpl(API, {
                signal: controller ? controller.signal : undefined,
                headers: { accept: 'application/vnd.github+json', 'user-agent': 'openvibe-network', ...authorization() },
            });
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (!res || !res.ok) throw new Error(`GitHub releases API answered ${res && res.status}`);
        const data = shape(await res.json());
        if (!data.version) throw new Error('GitHub releases API answered without a tag');
        cached = { at: now(), data };
        failedAt = 0;
        saveDisk(cached);
        return { ...data, cached: false, stale: false, ageMs: 0 };
    } catch (err) {
        failedAt = now();
        throw err;
    }
}

/** The one background refresh that may be running. */
function refresh(options) {
    if (inflight) return inflight;
    inflight = fetchLatest(options)
        .catch(() => null)
        .finally(() => { inflight = null; });
    return inflight;
}

/**
 * The latest release. Returns the fresh answer, or the last good answer at once while a refresh runs in the
 * background; when a refresh fails the last good answer is kept and marked stale with its age. Never throws.
 */
async function latest({ fetchImpl = globalThis.fetch, now = Date.now, dataDir } = {}) {
    useDisk(dataDir);
    if (cached) {
        const ageMs = Math.max(0, now() - cached.at);
        if (ageMs < TTL_MS) return { ...cached.data, cached: true, stale: false, ageMs };
        // Serving the last answer immediately and refreshing behind the request keeps the visitor off GitHub's
        // clock. A failed refresh waits out the cooldown, so a long outage does not spend the hour's calls.
        const cooling = failedAt && now() - failedAt < FAIL_COOLDOWN_MS;
        if (!inflight && !cooling) refresh({ fetchImpl, now });
        return { ...cached.data, cached: true, stale: true, ageMs };
    }
    if (failedAt && now() - failedAt < FAIL_COOLDOWN_MS) {
        return { ...FALLBACK, cached: false, stale: true, ageMs: 0 };
    }
    try {
        return await fetchLatest({ fetchImpl, now });
    } catch {
        return { ...FALLBACK, cached: false, stale: true, ageMs: 0 };
    }
}

/** Resolves when no background refresh is running (tests use it instead of sleeping). */
function whenIdle() {
    return inflight || Promise.resolve();
}

/** How many whole days old the answer is; 0 while it is younger than a day. */
function ageDays(release) {
    const ms = Number((release && release.ageMs) || 0);
    return ms >= DAY_MS ? Math.floor(ms / DAY_MS) : 0;
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

module.exports = { latest, refresh, whenIdle, ageDays, versionLabel, dateLabel, REPO, API, TTL_MS, TIMEOUT_MS, FAIL_COOLDOWN_MS, DAY_MS, FALLBACK, LATEST };
