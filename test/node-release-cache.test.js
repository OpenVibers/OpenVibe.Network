'use strict';
// server/link/release.js: the Node's latest release held for fifteen minutes, in memory and on disk, refreshed in
// the background, kept when GitHub cannot be read, with GITHUB_TOKEN sent when the environment has one.
//   node test/node-release-cache.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = require.resolve('../server/link/release');
const DAY = 24 * 60 * 60 * 1000;

const FIXTURE = (tag) => ({
    tag_name: tag,
    published_at: '2026-11-06T12:00:00Z',
    html_url: `https://github.com/OpenVibers/OpenVibe.Link/releases/tag/${tag}`,
    assets: [
        { name: 'install.sh', browser_download_url: `https://github.com/OpenVibers/OpenVibe.Link/releases/download/${tag}/install.sh` },
        { name: 'SHA256SUMS', browser_download_url: `https://github.com/OpenVibers/OpenVibe.Link/releases/download/${tag}/SHA256SUMS` },
    ],
});
const isGit = (url) => String(url).includes('.git/git-upload-pack');
const pkt = (text) => (text.length + 4).toString(16).padStart(4, '0') + text;
// An ls-refs answer: version line, a tag ref and its peeled copy (which must be ignored), then the flush.
const LS = (tags) => pkt('version 2\n') + tags.map((tag) => pkt(`${'a'.repeat(40)} refs/tags/${tag}\n`) + pkt(`${'a'.repeat(40)} refs/tags/${tag}^{}\n`)).join('') + '0000';
const ok = (tag, seen) => async (url, opts) => {
    if (seen) seen.push({ url, headers: (opts && opts.headers) || {} });
    if (isGit(url)) return { ok: true, status: 200, text: async () => LS([tag]) };
    return { ok: true, status: 200, json: async () => FIXTURE(tag) };
};
const fresh = () => {
    delete require.cache[MODULE];
    return require(MODULE);
};

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-node-release-'));
    let now = Date.now();

    try {
        // ── Fresh: the first answer is read once and held; the disk copy survives a restart ──
        const first = fresh();
        let calls = 0;
        const one = await first.latest({ fetchImpl: async (u, o) => { calls += 1; return ok('v1.2.3')(u, o); }, now: () => now, dataDir: dir });
        assert.strictEqual(one.version, 'v1.2.3');
        assert.strictEqual(one.cached, false);
        assert.strictEqual(one.stale, false);
        assert.strictEqual(calls, 1, 'the first answer is read from GitHub');

        const again = await first.latest({ fetchImpl: async () => { calls += 1; return ok('v9.9.9')(); }, now: () => now + 60e3, dataDir: dir });
        assert.strictEqual(calls, 1, 'a second visitor inside the fifteen minutes does not reach GitHub');
        assert.strictEqual(again.version, 'v1.2.3');
        assert.strictEqual(again.cached, true);

        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'node-release.json'), 'utf8'));
        assert.strictEqual(saved.data.version, 'v1.2.3', 'the answer is on disk');
        assert.ok(Number.isFinite(saved.at), 'with the time it was read');

        // A new process (module reload) answers from that file at once, and only asks GitHub in the background.
        const restarted = fresh();
        let afterRestart = 0;
        const fromDisk = await restarted.latest({
            fetchImpl: async (u, o) => { afterRestart += 1; return ok('v9.9.9')(u, o); },
            now: () => now + 120e3,
            dataDir: dir,
        });
        assert.strictEqual(fromDisk.version, 'v1.2.3', 'a restart serves the last good answer at once');
        assert.strictEqual(fromDisk.cached, true);
        assert.strictEqual(afterRestart, 0, 'and does not wait on GitHub for it');

        // ── Stale while GitHub is down: the last answer is kept, its age kept, nothing thrown ──
        now += 16 * 60e3;
        let tries = 0;
        const stale = await restarted.latest({
            fetchImpl: async () => { tries += 1; throw new Error('GitHub is down'); },
            now: () => now,
            dataDir: dir,
        });
        assert.strictEqual(stale.version, 'v1.2.3', 'the last good answer is still named');
        assert.strictEqual(stale.stale, true, 'and marked stale');
        assert.ok(stale.ageMs >= 15 * 60e3, 'its age comes with it');
        await restarted.whenIdle();
        assert.strictEqual(tries, 3, 'the refresh tried ls-refs, REST, then the public release redirect');

        const kept = await restarted.latest({
            fetchImpl: async () => { tries += 1; throw new Error('still down'); },
            now: () => now + 1000,
            dataDir: dir,
        });
        assert.strictEqual(kept.version, 'v1.2.3', 'the failure did not lose the answer');
        assert.strictEqual(tries, 3, 'and the cooldown kept the next visitor off GitHub');

        // ── Refresh: once GitHub is back, the next request gets the new release from the cache ──
        now += 16 * 60e3;
        let gitRefreshed = 0;
        let restRefreshed = 0;
        const whileExpired = await restarted.latest({
            fetchImpl: async (u, o) => {
                if (isGit(u)) { gitRefreshed += 1; return ok('v2.0.0')(u, o); }
                restRefreshed += 1;
                return ok('v2.0.0')(u, o);
            },
            now: () => now,
            dataDir: dir,
        });
        assert.strictEqual(whileExpired.version, 'v1.2.3', 'the expired answer is served without waiting');
        await restarted.whenIdle();
        assert.strictEqual(gitRefreshed, 1, 'and the refresh starts behind the request with ls-refs');
        assert.strictEqual(restRefreshed, 1, 'which reads the REST release once because the tag is new');
        const nowFresh = await restarted.latest({ fetchImpl: async () => { throw new Error('no call expected inside the hold'); }, now: () => now + 60e3, dataDir: dir });
        assert.strictEqual(nowFresh.version, 'v2.0.0', 'the refreshed answer is what the next visitor reads');
        assert.strictEqual(nowFresh.stale, false);
        assert.deepStrictEqual({ gitRefreshed, restRefreshed }, { gitRefreshed: 1, restRefreshed: 1 }, 'without another call to GitHub');

        // ── The tag check: REST only when the release is new; ls-refs down means REST every hold as before ──
        const tagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-node-tags-'));
        try {
            const tagsModule = fresh();
            let restCalls = 0;
            let gitCalls = 0;
            let tagsNow = ['v1.2.3', 'v1.2.2'];
            let restTag = 'v1.2.3';
            const fetchTags = async (url, opts) => {
                if (isGit(url)) { gitCalls += 1; return { ok: true, status: 200, text: async () => LS(tagsNow) }; }
                restCalls += 1;
                return { ok: true, status: 200, json: async () => FIXTURE(restTag) };
            };
            const cold = await tagsModule.latest({ fetchImpl: fetchTags, now: () => now, dataDir: tagDir });
            assert.strictEqual(cold.version, 'v1.2.3');
            assert.deepStrictEqual({ gitCalls, restCalls }, { gitCalls: 0, restCalls: 1 }, 'nothing cached: REST, no tag check');

            now += 16 * 60e3;
            await tagsModule.latest({ fetchImpl: fetchTags, now: () => now, dataDir: tagDir });
            await tagsModule.whenIdle();
            const held = await tagsModule.latest({ fetchImpl: fetchTags, now: () => now + 60e3, dataDir: tagDir });
            assert.strictEqual(held.version, 'v1.2.3');
            assert.strictEqual(held.stale, false, 'the same tag refreshes the cached timestamp');
            assert.deepStrictEqual({ gitCalls, restCalls }, { gitCalls: 1, restCalls: 1 }, 'same tag: one ls-refs, no REST');

            now += 16 * 60e3;
            await tagsModule.latest({ fetchImpl: fetchTags, now: () => now, dataDir: tagDir });
            await tagsModule.whenIdle();
            assert.deepStrictEqual({ gitCalls, restCalls }, { gitCalls: 2, restCalls: 1 }, 'same tag twice: still one REST call');

            now += 16 * 60e3;
            tagsNow = ['v10.0.0', 'v9.9.9', 'v1.2.3'];
            restTag = 'v10.0.0';
            await tagsModule.latest({ fetchImpl: fetchTags, now: () => now, dataDir: tagDir });
            await tagsModule.whenIdle();
            const bumped = await tagsModule.latest({ fetchImpl: fetchTags, now: () => now + 60e3, dataDir: tagDir });
            assert.strictEqual(bumped.version, 'v10.0.0', 'the highest semver tag is the release');
            assert.deepStrictEqual({ gitCalls, restCalls }, { gitCalls: 3, restCalls: 2 }, 'a new tag: one more REST call');

            now += 16 * 60e3;
            const downFetch = async (url, opts) => {
                if (isGit(url)) { gitCalls += 1; throw new Error('git is down'); }
                restCalls += 1;
                return { ok: true, status: 200, json: async () => FIXTURE(restTag) };
            };
            await tagsModule.latest({ fetchImpl: downFetch, now: () => now, dataDir: tagDir });
            await tagsModule.whenIdle();
            assert.deepStrictEqual({ gitCalls, restCalls }, { gitCalls: 4, restCalls: 3 }, 'ls-refs down: one REST call, as before');
        } finally {
            fs.rmSync(tagDir, { recursive: true, force: true });
        }

        // A host can exhaust the REST rate limit while GitHub's public release redirect still works.
        // The published release advances the page; a later REST success fills in its asset metadata.
        const limitedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-node-limited-'));
        try {
            const limited = fresh();
            await limited.latest({ fetchImpl: ok('v0.54.0'), now: () => now, dataDir: limitedDir });
            now += 16 * 60e3;
            let restCalls = 0;
            const limitedFetch = async (url) => {
                if (isGit(url)) return { ok: true, status: 200, text: async () => LS(['v0.56.0']) };
                if (url === limited.LATEST) return {
                    status: 302,
                    headers: { get: () => 'https://github.com/OpenVibers/OpenVibe.Link/releases/tag/v0.56.0' },
                };
                restCalls += 1;
                return { ok: false, status: 403 };
            };
            const expired = await limited.latest({ fetchImpl: limitedFetch, now: () => now, dataDir: limitedDir });
            assert.strictEqual(expired.version, 'v0.54.0', 'the first expired request is answered immediately');
            await limited.whenIdle();
            const advanced = await limited.latest({ fetchImpl: limitedFetch, now: () => now + 1000, dataDir: limitedDir });
            assert.strictEqual(restCalls, 1, 'the rate-limited API was tried once');
            assert.strictEqual(advanced.version, 'v0.56.0', 'the public redirect names the published release');
            assert.strictEqual(advanced.partial, true, 'asset metadata is marked incomplete');
            assert.deepStrictEqual(advanced.assets, []);
            assert.strictEqual(advanced.installUrl, 'https://github.com/OpenVibers/OpenVibe.Link/releases/download/v0.56.0/install.sh');

            now += 16 * 60e3;
            await limited.latest({ fetchImpl: ok('v0.56.0'), now: () => now, dataDir: limitedDir });
            await limited.whenIdle();
            const complete = await limited.latest({ fetchImpl: ok('v0.56.0'), now: () => now + 1000, dataDir: limitedDir });
            assert.ok(!complete.partial, 'a REST success replaces the incomplete answer');
            assert.ok(complete.assets.includes('install.sh'), 'and restores the asset list');
        } finally {
            fs.rmSync(limitedDir, { recursive: true, force: true });
        }

        // ── The token: GITHUB_TOKEN is sent when set, from the environment only ──
        const sent = [];
        const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-node-token-'));
        try {
            const tokenModule = fresh();
            process.env.GITHUB_TOKEN = 'ghp_test_only';
            await tokenModule.latest({ fetchImpl: ok('v3.0.0', sent), now: () => now, dataDir: tokenDir });
            assert.strictEqual(sent.length, 1);
            assert.strictEqual(sent[0].headers.authorization, 'Bearer ghp_test_only', 'the token rides along as a Bearer header');
            delete process.env.GITHUB_TOKEN;

            const bare = [];
            const bareModule = fresh();
            await bareModule.latest({ fetchImpl: ok('v3.0.0', bare), now: () => now, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ov-node-bare-')) });
            assert.ok(!('authorization' in bare[0].headers), 'no token, no Authorization header');
            assert.ok(!JSON.stringify(bare[0].headers).includes('ghp_'), 'and nothing leaks into the request');
        } finally {
            delete process.env.GITHUB_TOKEN;
            fs.rmSync(tokenDir, { recursive: true, force: true });
        }

        // ── The age is spoken only past a day ──
        assert.strictEqual(restarted.ageDays({ ageMs: 60e3 }), 0);
        assert.strictEqual(restarted.ageDays({ ageMs: DAY + 1 }), 1);
        assert.strictEqual(restarted.ageDays({ ageMs: 3 * DAY }), 3);
        assert.strictEqual(restarted.ageDays({}), 0);

        console.log('node-release-cache: fresh, restart from disk, stale while down, background refresh and token ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
