'use strict';
// The registry reports each library's latest published tag, not the version Network has installed.
const assert = require('assert');
const { createLibraryTags, latestOf } = require('../server/registry/library-tags');
const exposure = require('../server/registry/exposure');

assert.strictEqual(latestOf(['v0.5.0', 'v0.10.0', 'v0.9.3', 'latest', 'v0.10.0-rc1']), 'v0.10.0');
assert.strictEqual(latestOf([]), null);

(async () => {
    const tags = { 'OpenVibe.SDK': ['v0.7.0', 'v0.8.0'], 'OpenVibe.Shared': ['v1.11.1', 'v1.9.0'], 'OpenVibe.Contracts': null, 'OpenVibe.Publishing': ['v0.3.2'] };
    const fetchImpl = async (url) => {
        const repo = /repos\/OpenVibers\/([^/]+)\/tags/.exec(url)[1];
        if (!tags[repo]) return { ok: false, status: 403, json: async () => ({}) };
        return { ok: true, json: async () => tags[repo].map((name) => ({ name })) };
    };
    const lt = createLibraryTags({ fetchImpl, onUpdate: exposure.setLibraryReleases, log: null });
    await lt.refresh();
    const libs = Object.fromEntries(exposure.libraries().map((l) => [l.package, l]));
    assert.strictEqual(libs['openvibe-sdk'].release, 'v0.8.0');
    assert.strictEqual(libs['openvibe-sdk'].distribution, 'https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v0.8.0');
    assert.strictEqual(libs['openvibe-shared'].release, 'v1.11.1');
    assert.strictEqual(libs['openvibe-contracts'].release, `v${require('openvibe-contracts/package.json').version}`, 'a refused lookup keeps the installed version');
    console.log('library tags: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
