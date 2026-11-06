'use strict';
// node.openvibe.network: the Node's own front door, served by Network. The Host header decides: on that host '/'
// is the Node's page, '/install' answers with the installer of the latest release, and the page has its Markdown
// twin and its llms.txt, like Network's other pages.
//   node test/node-home.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');

const page = require('../server/node/page');
const release = require('../server/node/release');
const { createNodeRoutes, llmsTxt } = require('../server/node/routes');

// ── The release answer: cached for ten minutes, with a fallback when GitHub cannot be reached ──
const FIXTURE = {
    tag_name: 'v9.9.9',
    published_at: '2026-11-06T12:00:00Z',
    html_url: 'https://github.com/OpenVibers/OpenVibe.Node/releases/tag/v9.9.9',
    assets: [
        { name: 'install.sh', browser_download_url: 'https://github.com/OpenVibers/OpenVibe.Node/releases/download/v9.9.9/install.sh' },
        { name: 'SHA256SUMS', browser_download_url: 'https://github.com/OpenVibers/OpenVibe.Node/releases/download/v9.9.9/SHA256SUMS' },
    ],
};

(async () => {
    // The cache: one call to GitHub, then the same answer for ten minutes.
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => FIXTURE }; };
    let now = 1000;
    const clock = () => now;
    const first = await release.latest({ fetchImpl, now: clock });
    assert.strictEqual(first.version, 'v9.9.9', 'the release is read from GitHub');
    assert.strictEqual(first.installUrl, 'https://github.com/OpenVibers/OpenVibe.Node/releases/download/v9.9.9/install.sh');
    assert.strictEqual(first.checksumsUrl, 'https://github.com/OpenVibers/OpenVibe.Node/releases/download/v9.9.9/SHA256SUMS');
    const second = await release.latest({ fetchImpl, now: clock });
    assert.strictEqual(calls, 1, 'the second call is answered from the cache');
    assert.strictEqual(second.version, 'v9.9.9');

    // Past ten minutes, GitHub is asked again.
    now += release.TTL_MS + 1;
    await release.latest({ fetchImpl, now: clock });
    assert.strictEqual(calls, 2, 'after ten minutes GitHub is asked again');

    // GitHub unreachable: the page still works, and says so. (Past the ten minutes, so the cache cannot answer.)
    now += release.TTL_MS + 1;
    const broken = await release.latest({ fetchImpl: async () => { throw new Error('no GitHub'); }, now: clock });
    assert.ok(broken.version, 'a release is still named');
    assert.strictEqual(broken.stale, true, 'and it is marked as the last one read');
    assert.ok(broken.installUrl.startsWith('https://github.com/OpenVibers/OpenVibe.Node/releases/download/'), 'the installer link still works');

    // ── The page ──
    const html = page.render({ release: first, releaseId: 'rel_test' });
    assert.ok(html.includes('Your computer on the network'), 'the page says what the Node is');
    assert.ok(html.includes('curl -fsSL https://node.openvibe.network/install | sh'), 'the one-line installer is on the page');
    assert.ok(html.includes('v9.9.9'), 'the version is on the page');
    assert.ok(html.includes('2026-11-06'), 'the release date is on the page');
    assert.ok(html.includes('releases/download/v9.9.9/SHA256SUMS'), 'the checksums are on the page');
    assert.ok(html.includes('releases/tag/v9.9.9'), 'the release page is on the page');
    assert.ok(html.includes('openvibe-node-windows-amd64.exe'), 'Windows has its own way in');
    assert.ok(html.includes('openvibe.bot/install'), 'the installer also lives at openvibe.bot/install');
    for (const [what, needle] of [
        ['run your agents and code', 'openvibe.codes/run'],
        ['offer your models and earn credits', 'openvibe.exchange/sell'],
        ['drive robots', 'openvibe.bot'],
        ['stream an agent\u2019s desk', 'openvibe.live'],
        ['your memory, read-only', 'memory.md'],
    ]) assert.ok(html.includes(needle), `the page says it ${what}`);
    // What it never does.
    assert.ok(html.includes('without your pairing'), 'the page says the Node needs your pairing');
    assert.ok(html.includes('Nothing runs that you did not turn on'), 'and that nothing runs on its own');
    // The docs.
    assert.ok(html.includes('docs/install.md'), 'the install guide is linked');
    // Network's chrome.
    assert.ok(html.includes('/shared/navbar.js'), 'the shared navbar is on the page');
    assert.ok(html.includes('https://node.openvibe.network'), 'the page names its own address');
    assert.ok(html.includes('<link rel="canonical" href="https://node.openvibe.network/">'), 'and claims it as its own');

    // The llms.txt says the same thing in plain lines.
    const txt = llmsTxt();
    assert.ok(txt.startsWith('# OpenVibe Node'), 'the llms.txt names the site');
    assert.ok(txt.includes('https://node.openvibe.network/'), 'and links the page');
    assert.ok(txt.includes('curl -fsSL https://node.openvibe.network/install | sh'), 'and the install command');

    // ── The routes: the Host header decides ──
    const app = express();
    app.use(createNodeRoutes({ releaseId: 'rel_test' }));
    app.get('/', (_req, res) => res.type('html').send('<p>network home</p>'));
    const server = http.createServer(app).listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const get = (path, host, headers = {}) => new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host, ...headers } }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.end();
    });

    try {
        const home = await get('/', 'openvibe.network');
        assert.ok(home.body.includes('network home'), 'on the apex, Network\u2019s own home answers');

        const node = await get('/', 'node.openvibe.network');
        assert.strictEqual(node.status, 200);
        assert.ok(node.body.includes('Your computer on the network'), 'on the Node\u2019s host, the Node\u2019s page answers');
        assert.ok(!node.body.includes('network home'), 'and not Network\u2019s home');
        assert.ok(String(node.headers.link || '').includes('text/markdown'), 'the page offers its Markdown twin');

        const twin = await get('/index.md', 'node.openvibe.network');
        assert.strictEqual(twin.status, 200);
        assert.ok(String(twin.headers['content-type'] || '').includes('text/markdown'), 'the twin is Markdown');
        assert.ok(twin.body.includes('# OpenVibe Node'), 'and it says what the Node is');
        assert.ok(twin.body.includes('openvibe.network/install'), 'with the install command');

        const install = await get('/install', 'node.openvibe.network');
        assert.strictEqual(install.status, 302, '/install redirects');
        assert.ok(String(install.headers.location || '').includes('releases/download/'), 'to the release\u2019s own installer');
        assert.ok(String(install.headers.location || '').endsWith('/install.sh'), 'the install script');

        const llms = await get('/llms.txt', 'node.openvibe.network');
        assert.strictEqual(llms.status, 200);
        assert.ok(llms.body.startsWith('# OpenVibe Node'), 'the Node\u2019s own llms.txt answers');

        // Network\u2019s own paths are untouched on the apex.
        const apex = await get('/llms.txt', 'openvibe.network');
        assert.notStrictEqual(apex.status, 200, 'the apex keeps its own llms.txt');
    } finally {
        server.close();
    }

    // ── The navbar: the Node is the piece the Network is built around ──
    const index = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(/links: \[\{ label: 'Node', href: 'https:\/\/node\.openvibe\.network', icon: 'fa-house', featured: true \}/.test(index), 'the home page\u2019s navbar leads with the Node, as the accent');
    assert.ok(index.indexOf("label: 'Node'") < index.indexOf("label: 'My Account'"), 'and the Node comes first');

    // The Node's own origin is allowed to ask the network's API (the account's look, the navbar's frame, the)
    // shared font): without it, the Node\u2019s page loses its own chrome in the browser.
    const serverSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.ok(serverSrc.includes("'https://node.openvibe.network',"), 'the CORS allow-list knows the Node\u2019s own origin');

    console.log('node-home: the Node\u2019s page, its installer, its twin and the navbar item ok');
})().catch((e) => { console.error(e); process.exit(1); });
