'use strict';
// The registry reports each library's latest published tag, not the version Network has installed.
const assert = require('assert');
const { createLibraryTags, latestOf } = require('../server/registry/library-tags');
const exposure = require('../server/registry/exposure');

assert.strictEqual(latestOf(['v0.5.0', 'v0.10.0', 'v0.9.3', 'latest', 'v0.10.0-rc1']), 'v0.10.0');
assert.strictEqual(latestOf([]), null);

(async () => {
    const tags = { 'OpenVibe.SDK': ['v0.7.0', 'v0.8.0'], 'OpenVibe.Shared': ['v1.11.1', 'v1.9.0'], 'OpenVibe.Contracts': null, 'OpenVibe.Publishing': ['v0.3.2'] };
    // OpenVibe.Git's mirror (11-18): what it answers when GitHub refuses; null = it refuses too.
    let mirror = { 'openvibe.contracts': ['v0.447.0', 'v0.448.0', 'v0.10.0'] };
    const fetchImpl = async (url) => {
        const f = /^https:\/\/git\.openvibe\.codes\/api\/v1\/repos\/openvibers\/([^/]+)\/tags$/.exec(url);
        if (f) return mirror[f[1]] ? { ok: true, status: 200, json: async () => ({ tags: mirror[f[1]].map((name) => ({ name })) }) } : { ok: false, status: 404, json: async () => ({}) };
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
    assert.strictEqual(libs['openvibe-contracts'].release, 'v0.448.0', 'GitHub refused (rate limit): the mirror\'s tags');
    // Refused by GitHub and the mirror: the installed version stands.
    mirror = {};
    const exposure2 = { set: null };
    const lt2 = createLibraryTags({ fetchImpl, onUpdate: (out) => { exposure2.set = out; }, log: null });
    await lt2.refresh();
    assert.strictEqual(lt2.get('openvibe-contracts'), null, 'nothing learned: the installed version stands');
    // An async token (server/index.js) is awaited, never sent as "[object Promise]".
    const auths = [];
    const mirrorAuths = [];
    await createLibraryTags({ fetchImpl: async (url, opts) => { (url.startsWith('https://api.github.com/') ? auths : mirrorAuths).push(opts.headers.Authorization); return fetchImpl(url); }, token: async () => 'ghp_async', log: null }).refresh();
    assert.ok(auths.length && auths.every((a) => a === 'Bearer ghp_async'), auths.join(','));
    assert.ok(mirrorAuths.every((a) => a === undefined), 'the GitHub token never goes to the mirror');
    console.log('library tags: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
