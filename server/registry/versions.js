'use strict';
/**
 * Version helpers for the registry's /releases view and scripts/contracts-drift.js.
 *
 * Network's packages are pinned as tarball tags
 * (https://codeload.github.com/OpenVibers/OpenVibe.Contracts/tar.gz/refs/tags/v0.30.1); a running
 * service reports the installed version ("0.30.1") in its /release.json. Both reduce to [major, minor, patch].
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** '0.30.1', 'v0.30.1', a codeload/github tag URL, or 'github:Org/Repo#v0.30.1' → { version, parts } or null. */
function parsePin(spec) {
    const s = String(spec == null ? '' : spec).trim();
    if (!s) return null;
    let tag = s;
    const m = s.match(/refs\/tags\/(v?\d+\.\d+\.\d+[^/?#]*)/) || s.match(/#(?:semver:)?[~^]?(v?\d+\.\d+\.\d+\S*)$/) || s.match(/\/archive\/(?:refs\/tags\/)?(v?\d+\.\d+\.\d+)\.tar\.gz$/);
    if (m) tag = m[1];
    else tag = s.replace(/^[~^=]+/, '');
    const v = tag.match(SEMVER);
    if (!v) return null;
    return { version: `${v[1]}.${v[2]}.${v[3]}`, tag: tag.startsWith('v') ? tag : `v${tag}`, parts: [Number(v[1]), Number(v[2]), Number(v[3])] };
}

function compare(a, b) {
    const x = typeof a === 'string' ? (parsePin(a) || {}).parts : a;
    const y = typeof b === 'string' ? (parsePin(b) || {}).parts : b;
    if (!x || !y) return NaN;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

/** The newest of a list of tags ('v0.30.1', ...), ignoring anything that is not x.y.z. */
function latestOf(tags) {
    let best = null;
    for (const t of tags || []) { const p = parsePin(t); if (p && (!best || compare(p.parts, best.parts) > 0)) best = p; }
    return best;
}

/** 'current' | 'behind' | 'ahead' | 'unknown' for a pinned/installed version against the latest release. */
function driftOf(pinned, latest) {
    const c = compare(pinned, latest);
    if (Number.isNaN(c)) return 'unknown';
    return c === 0 ? 'current' : c < 0 ? 'behind' : 'ahead';
}

module.exports = { parsePin, compare, latestOf, driftOf };
