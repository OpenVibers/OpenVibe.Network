'use strict';
// Production drift (WS-S task 7): the deployed commit against main through GitHub's compare API —
// current, behind (how many commits and since the oldest undeployed one), diverged, unknown; a failed
// lookup keeps the last answer; the gauge gives seconds behind (0 when current); services that stop
// running are dropped; a non-commit release is skipped.
const assert = require('assert');
const drift = require('../server/registry/deploy-drift');

const NOW = Date.parse('2026-09-26T12:00:00Z');
const answers = {
    'OpenVibers/OpenVibe.Live/compare/aaaaaaa1...main': { status: 200, body: { ahead_by: 0, behind_by: 0, commits: [] } },
    'OpenVibers/OpenVibe.Chat/compare/bbbbbbb2...main': { status: 200, body: { ahead_by: 3, behind_by: 0, commits: [
        { sha: 'c1', commit: { committer: { date: '2026-09-25T10:00:00Z' } } },
        { sha: 'c2', commit: { committer: { date: '2026-09-25T11:00:00Z' } } },
        { sha: 'c3ffffffffffff', commit: { committer: { date: '2026-09-26T09:00:00Z' } } },
    ] } },
    'OpenVibers/OpenVibe.Media/compare/ccccccc3...main': { status: 200, body: { ahead_by: 0, behind_by: 2, commits: [] } },
    'OpenVibers/OpenVibe.Tools/compare/ddddddd4...main': { status: 404, body: { message: 'Not Found' } },
};
let failing = false;
const asked = [];
const fetchImpl = async (url, opts) => {
    const key = url.replace('https://api.github.com/repos/', '');
    asked.push({ key, auth: opts.headers.Authorization });
    if (failing) throw new Error('network down');
    const a = answers[key];
    return { ok: a.status === 200, status: a.status, json: async () => a.body };
};

(async () => {
    let running = [
        { id: 'live', release: 'aaaaaaa1', repository: 'OpenVibers/OpenVibe.Live' },
        { id: 'chat', release: 'bbbbbbb2', repository: 'OpenVibers/OpenVibe.Chat' },
        { id: 'media', release: 'ccccccc3', repository: 'OpenVibers/OpenVibe.Media' },
        { id: 'tools', release: 'ddddddd4', repository: 'OpenVibers/OpenVibe.Tools' },
        { id: 'sites', release: 'not-a-sha', repository: 'OpenVibers/OpenVibe.Sites' },
    ];
    const d = drift.createDeployDrift({ services: () => running, fetchImpl, token: 'ghp_test', now: () => NOW, log: null });
    await d.refresh();
    assert.strictEqual(asked.length, 4, 'a release that is not a commit is not looked up');
    assert.strictEqual(asked[0].auth, 'Bearer ghp_test');
    assert.strictEqual(drift.current('live').state, 'current');
    const chat = drift.current('chat');
    assert.deepStrictEqual([chat.state, chat.behind_by, chat.since, chat.main], ['behind', 3, '2026-09-25T10:00:00.000Z', 'c3ffffffffff']);
    assert.strictEqual(drift.current('media').state, 'diverged');
    assert.deepStrictEqual([drift.current('tools').state, drift.current('tools').error], ['unknown', 'commit not on GitHub']);
    assert.strictEqual(drift.current('sites'), null);
    const g = Object.fromEntries(drift.driftSeconds(NOW).map((x) => [x.labels.service, x.value]));
    assert.deepStrictEqual(g, { live: 0, chat: 26 * 3600 }, 'seconds since the oldest undeployed commit; unknown and diverged are not measured');

    failing = true;
    await d.refresh();
    assert.strictEqual(drift.current('chat').state, 'behind', 'a failed lookup keeps the last answer');
    assert.strictEqual(drift.current('chat').stale, true);
    failing = false;

    running = running.filter((r) => r.id !== 'media');
    await d.refresh();
    assert.strictEqual(drift.current('media'), null, 'a service that stopped running is dropped');
    drift._reset();
    // server/index.js feeds the checks from the registry's releases view.
    const eco = require('../server/registry/ecosystem').createEcosystemRegistry({ issuer: 'https://openvibe.network', fetchImpl: async () => { throw new Error('offline'); } });
    assert.strictEqual(typeof eco.releases, 'function', 'the registry exposes releases()');
    assert.ok(Array.isArray(eco.releases().services));
    console.log('deploy drift: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
