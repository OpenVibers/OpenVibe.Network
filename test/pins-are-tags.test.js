'use strict';
// Every git-tarball dependency is pinned to a released tag, never a branch: a branch is deleted when its PR merges,
// and the next deploy's npm install then fails (2026-11-06: #577 pinned openvibe-sdk to refs/heads/feat/locker-core-sdk).
const assert = require('assert');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const bad = [];
for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })) {
    if (/codeload\.github\.com\/.+\/tar\.gz\/refs\/heads\//.test(String(spec)) || /github\.com\/.+#(?!v?\d)/.test(String(spec))) bad.push(`${name}: ${spec}`);
}
for (const [where, entry] of Object.entries(lock.packages || {})) {
    if (entry && /\/tar\.gz\/refs\/heads\//.test(String(entry.resolved || ''))) bad.push(`${where} resolved from a branch: ${entry.resolved}`);
}
assert.deepStrictEqual(bad, [], 'pin git tarballs to a tag (refs/tags/vX.Y.Z), never a branch');
console.log('pins-are-tags: every tarball dependency is a tag');
