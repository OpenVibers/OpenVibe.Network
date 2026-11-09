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
const ok = (tag, seen) => async (url, opts) => {
    if (seen) seen.push({ url, headers: (opts && opts.headers) || {} });
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
        assert.strictEqual(tries, 1, 'the refresh ran in the background');
        await restarted.whenIdle();

        const kept = await restarted.latest({
            fetchImpl: async () => { tries += 1; throw new Error('still down'); },
            now: () => now + 1000,
            dataDir: dir,
        });
        assert.strictEqual(kept.version, 'v1.2.3', 'the failure did not lose the answer');
        assert.strictEqual(tries, 1, 'and the cooldown kept the next visitor off GitHub');

        // ── Refresh: once GitHub is back, the next request gets the new release from the cache ──
        now += 16 * 60e3;
        let refreshed = 0;
        const whileExpired = await restarted.latest({
            fetchImpl: async (u, o) => { refreshed += 1; return ok('v2.0.0')(u, o); },
            now: () => now,
            dataDir: dir,
        });
        assert.strictEqual(whileExpired.version, 'v1.2.3', 'the expired answer is served without waiting');
        assert.strictEqual(refreshed, 1, 'and the refresh starts behind the request');
        await restarted.whenIdle();
        const nowFresh = await restarted.latest({ fetchImpl: async () => { refreshed += 1; return ok('v0.0.0')(); }, now: () => now + 60e3, dataDir: dir });
        assert.strictEqual(nowFresh.version, 'v2.0.0', 'the refreshed answer is what the next visitor reads');
        assert.strictEqual(nowFresh.stale, false);
        assert.strictEqual(refreshed, 1, 'without another call to GitHub');

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
