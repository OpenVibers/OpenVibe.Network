'use strict';
// Size budgets for openvibe.network's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit a little above the
// 2026-09-26 measurement; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

const BUDGETS = {
    htmlRawKB: 132,       // measured 128.3 with Events, AI and Search added (31 sites, contracts 0.135.0); 122.3 (shared 2.21.0: a real glyph for every product card, where ten drew the 'V'); was 110.6 with 33 live sites (contracts 0.119.0). The home page lists every site, so it grows with the network
    htmlBrotliKB: 26,     // 25.1 (31 sites, contracts 0.135.0); 24.1 (shared 2.21.0, the same glyphs); 20.5 (contracts 0.116.0)
    jsFiles: 8,           // 7 with boost.js, was 6 (2026-10-13, plan T11 step 3: one more script on every boosted page; it loads route-transition.js on the first move only)
    jsRawKB: 266,         // 249.8 with boost.js (13.1); 228.3
    jsBrotliKB: 64,       // 60.3 with boost.js (3.8); 53.9
    cssFiles: 2,          // 1 (Font Awesome, cross-origin)
    externalFiles: 3,     // 1 locally; production adds Cloudflare's beacon
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-net-budget-'));
    // Node's fetch pools keep-alive sockets; the server closes an idle one after its default 5 s keepAliveTimeout, and a
    // slow asset walk under load can hit that window and fail with a transient connection error. This test measures
    // sizes, not connection reuse, so retry those.
    const RETRY = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT']);
    const retryFetch = async (url, init) => {
        for (let attempt = 0; ; attempt++) {
            try { return await fetch(url, init); }
            catch (e) {
                if (attempt >= 2 || !RETRY.has(e?.cause?.code)) throw e;
                await new Promise((r) => setTimeout(r, 250));
            }
        }
    };
    let child, exitInfo = null;
    try {
        // The server is a child on an ephemeral port: a fresh PGlite migrates and seeds before it answers, which with
        // test files in parallel is slower than the 60 s once allowed, and the port freePort() picked can be claimed in
        // the gap before the child binds. Boot again on a new port if the child dies before it answers.
        let base, stderr = '';
        for (let attempt = 0; ; attempt++) {
            const port = await freePort();
            exitInfo = null;
            stderr = '';
            child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
                env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PGLITE_DIR: path.join(dir, `pglite-${attempt}`), NODE_ENV: 'test' },
                stdio: ['ignore', 'ignore', 'pipe'],
            });
            child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
            child.once('exit', (code, signal) => { exitInfo = { code, signal, stderr }; });
            base = `http://127.0.0.1:${port}`;
            let up = false;
            const startupDeadline = Date.now() + 150000;   // a fresh PGlite database takes well over 10 s to migrate and seed
            while (!up && !exitInfo && Date.now() < startupDeadline) {
                up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
                if (!up) await new Promise((r) => setTimeout(r, 100));
            }
            if (up) break;
            child.kill();
            if (exitInfo && attempt < 2) continue;   // the port was taken, or another early boot failure: try a fresh one
            assert.ok(up, `the server did not start:\n${(exitInfo && exitInfo.stderr) || stderr}`);
        }
        const m = await measure({ base, fetch: retryFetch });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        if (child) child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
