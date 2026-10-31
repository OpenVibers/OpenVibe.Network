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
    htmlRawKB: 189,       // 189 with the look-boot script inline above the stylesheets on every page (L42, 2026-10-31: +1 KB); 188 with the agent layer's rel=alternate/describedby link tags on every public page (SEO-1/SEO-2, 2026-10-29: +0.2 KB); 187 with Bench open (contracts 0.238.0, 2026-10-28); 186 with Cam open (contracts 0.237.0, 2026-10-28); 184.4 with Fun open (contracts 0.236.0, 2026-10-28); 182.7 with Vision and Exchange open (contracts 0.235.0, 2026-10-28); 179 with Meme open (contracts 0.234.0, 2026-10-28); 174.1 with Domains, Report and Design open (contracts 0.226-0.228, 2026-10-28); 168.1 the hero's orbit and rich cards for live streams, recordings and screenshots (2026-10-28: the owner asked for animated visuals and YouTube-style cards); 152.4 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 147.9 with the home's FAQ (six questions and their FAQPage JSON-LD), the numbers panel and the service map's group headings (2026-10-22); 141.2 with Tips and VIP open (contracts 0.200.0, 37 sites; the Opening next section is gone); 134 with Play (contracts 0.172.1); 128.3 with Events, AI and Search added (31 sites, contracts 0.135.0); 122.3 (shared 2.21.0: a real glyph for every product card, where ten drew the 'V'); was 110.6 with 33 live sites (contracts 0.119.0). The home page lists every site, so it grows with the network
    htmlBrotliKB: 35.5,   // 35.1 with the look-boot script inline above the stylesheets on every page (L42, 2026-10-31: +0.6 KB); 34.2 with the lower half as one block of chips on phones (2026-10-30); 33.1 with Games granted its Bench match capabilities (BENCH-7, 2026-10-29: the home lists what each service may do); 32.0 with Fun, Vision and Exchange open (contracts 0.236.0, 2026-10-28); 31.2 with Domains, Report and Design open (2026-10-28); 30.1 with the Organization saying who OpenVibe is (description, other names, what it is not, 15 sites; 2026-10-28); 28.5 with the FAQ, numbers and groups (2026-10-22); 26.1 with Play; 25.1 (31 sites, contracts 0.135.0); 24.1 (shared 2.21.0, the same glyphs); 20.5 (contracts 0.116.0)
    jsFiles: 8,           // 7 with boost.js, was 6 (2026-10-13, plan T11 step 3: one more script on every boosted page; it loads route-transition.js on the first move only)
    jsRawKB: 334,   // 333.2 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 330.1 with openvibe-shared 4.52.0 (from 4.47.2): the seasonal fall, rich embeds, the Dock and its Chats tab (2026-10-30); 323.2 with openvibe-shared 4.47.2 (the comfort settings in theme-loader 4.45, touch targets 4.46, the grouped updates log 4.47.2); 313.7 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 306.4 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 298.9 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 293.1 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 279.1 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 269.3 with shared 4.11.0's seasonal navbar (Pumpkin Night and the season badge, +2.6); 249.8 with boost.js (13.1); 228.3
    jsBrotliKB: 84,   // 83.4 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 82.6 with openvibe-shared 4.52.0 (from 4.47.2): the seasonal fall, rich embeds, the Dock and its Chats tab (2026-10-30); 81.4 with openvibe-shared 4.47.2 (comfort settings, touch targets, the grouped updates log); 78.9 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 77 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 73.3 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 70.7 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 68.0 with shared 4.12.0 (light/dark switch, seasonal mark, theme pairs); 64.5 with shared 4.11.0's navbar; 60.3 with boost.js (3.8); 53.9
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
