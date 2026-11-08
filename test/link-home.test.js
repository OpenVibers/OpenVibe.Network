'use strict';
// openvibe.link: OpenVibe Link's front door (the Node renamed), served by Network. The Host header decides: on
// openvibe.link '/' is Link's page, '/install' answers with the installer of the latest release, and the page has
// its Markdown twin, its llms.txt and its crawl files, like Network's other pages. node.openvibe.network is the
// old name: it 301s to the same path on openvibe.link, except /install, which keeps serving.
//   node test/link-home.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
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
        { name: 'openvibe-link-v9.9.9.apk' },
    ],
};
const SHAPED = {
    version: 'v9.9.9',
    publishedAt: '2026-11-06T12:00:00Z',
    url: 'https://github.com/OpenVibers/OpenVibe.Node/releases/tag/v9.9.9',
    installUrl: 'https://github.com/OpenVibers/OpenVibe.Node/releases/download/v9.9.9/install.sh',
    checksumsUrl: 'https://github.com/OpenVibers/OpenVibe.Node/releases/download/v9.9.9/SHA256SUMS',
};

(async () => {
    // ── The release answer ──
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

    now += release.TTL_MS + 1;
    await release.latest({ fetchImpl, now: clock });
    assert.strictEqual(calls, 2, 'after ten minutes GitHub is asked again');

    now += release.TTL_MS + 1;
    const broken = await release.latest({ fetchImpl: async () => { throw new Error('no GitHub'); }, now: clock });
    assert.ok(broken.version, 'a release is still named');
    assert.strictEqual(broken.stale, true, 'and it is marked as the last one read');
    assert.ok(broken.installUrl.startsWith('https://github.com/OpenVibers/OpenVibe.Node/releases/download/'), 'the installer link still works');

    // The vhost must send /machines and /pair to the app (which signposts them), not the catch-all to Network.
    const vhost = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'parked-domains.conf'), 'utf8');
    assert.ok(/location ~ \^\/\(\|install\|machines\|pair\|/.test(vhost), 'the vhost proxies /machines and /pair to the Link app');
    // …and /auth/* to Link's own sign-in (Network#664), or openvibe.link never signs anyone in (11-08 audit).
    const linkBlock = vhost.slice(vhost.indexOf('    server_name openvibe.link;'));
    assert.ok(/location \^~ \/auth\/ \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:4000;/.test(linkBlock.slice(0, linkBlock.indexOf('\n}\n'))), 'the openvibe.link vhost proxies /auth/ to Network');

    // ── The page: OpenVibe Link, and every fact the Node page had ──
    const html = page.render({ release: first, releaseId: 'rel_test' });
    assert.ok(html.includes('<title>OpenVibe Link: your machines, connected</title>'), 'the title is Link\'s');
    assert.ok(html.includes('<h1>Your machines, connected</h1>'), 'the h1 is Link\'s');
    assert.ok(html.includes('<p class="np-kicker">OpenVibe Link</p>'), 'the kicker names Link');
    assert.ok(html.includes('Link runs on your computer, server or phone. Your agents use it only as far as you allow, and you choose what, if anything, it offers the network.'), 'the lead is the brief\'s, word for word');
    assert.ok(html.includes('>Install Link<'), 'the primary button installs Link');
    assert.ok(html.includes('>The install guide<'), 'and the guide keeps its name');
    assert.ok(html.includes('curl -fsSL https://openvibe.link/install | sh'), 'the one-line installer uses the new home');
    assert.ok(html.includes('The program is <code>openvibe-link</code>. <code>openvibe-node</code> is kept as an alias, so existing installs and scripts keep working.'), 'the rename and the alias are said plainly under the installer');
    assert.ok(html.includes('v9.9.9'), 'the version is on the page');
    assert.ok(html.includes('2026-11-06'), 'the release date is on the page');
    assert.ok(html.includes('releases/download/v9.9.9/SHA256SUMS'), 'the checksums are on the page');
    assert.ok(html.includes('releases/tag/v9.9.9'), 'the release page is on the page');
    assert.ok(html.includes('openvibe-link-windows-amd64.exe'), 'Windows has its own way in');
    assert.ok(html.includes('openvibe.bot/install'), 'the installer also lives at openvibe.bot/install');
    assert.ok(html.includes('id="install"'), 'the install section has an anchor the hero button uses');
    assert.ok(html.includes('href="#install"'), 'the Install button goes to the OS install block');
    for (const [what, needle] of [
        ['Windows x64', 'openvibe-link-windows-amd64.exe'],
        ['Windows ARM64', 'openvibe-link-windows-arm64.exe'],
        ['macOS Apple silicon', 'openvibe-link_9.9.9_darwin_arm64.tar.gz'],
        ['macOS Intel', 'openvibe-link_9.9.9_darwin_amd64.tar.gz'],
        ['Linux x64 .deb', 'openvibe-link_9.9.9_amd64.deb'],
        ['Linux ARM64 .deb', 'openvibe-link_9.9.9_arm64.deb'],
        ['Linux x64 .rpm', 'openvibe-link-9.9.9-1.x86_64.rpm'],
        ['Linux ARM64 .rpm', 'openvibe-link-9.9.9-1.aarch64.rpm'],
        ['Linux x64 tarball', 'openvibe-link_9.9.9_linux_amd64.tar.gz'],
        ['Linux ARM64 tarball', 'openvibe-link_9.9.9_linux_arm64.tar.gz'],
        ['Android APK', 'openvibe-link-v9.9.9.apk'],
        ['iOS home-screen web app', 'Add to Home Screen'],
        ['what iOS waits on', 'Apple Developer account'],
    ]) assert.ok(html.includes(needle), `the install block offers ${what}`);
    const debugOnly = page.render({ release: { ...first, assets: ['install.sh', 'openvibe-link-v9.9.9-debug.apk'] }, releaseId: 'rel_test' });
    assert.ok(debugOnly.includes('openvibe-link-v9.9.9-debug.apk'), 'an unsigned release offers the debug APK');
    assert.ok(debugOnly.includes('signed Android release waits'), 'and says why it is the debug build');
    const noApk = page.render({ release: { ...first, assets: ['install.sh'] }, releaseId: 'rel_test' });
    assert.ok(noApk.includes('releases/tag/v9.9.9'), 'a release without an APK sends the visitor to its page');
    for (const [ua, os] of [
        ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)', 'mac'],
        ['Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
        ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'android'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'ios'],
    ]) {
        const one = page.render({ release: first, releaseId: 'rel_test', userAgent: ua });
        assert.ok(one.includes(`data-os="${os}" open`), `a ${os} visitor gets the ${os} steps first`);
        for (const other of ['windows', 'mac', 'linux', 'android', 'ios'].filter((x) => x !== os)) {
            assert.ok(!one.includes(`data-os="${other}" open`), `a ${os} visitor does not open ${other}`);
        }
    }
    assert.ok(html.includes('id="machines"'), 'the page has a Your machines section');
    assert.ok(html.includes('Open your machines'), 'and links the signed-in machines hub');
    assert.ok(html.includes('Pair a machine'), 'and the pairing entry point');
    assert.ok(html.includes('What it does today'), 'the honest heading stays');
    for (const [what, needle] of [
        ['run your agents and code', 'openvibe.codes/run'],
        ['offer your models and earn credits', 'openvibe.exchange/sell'],
        ['drive robots', 'openvibe.bot'],
        ['stream an agent\u2019s desk', 'openvibe.live'],
        ['your memory, read-only', 'memory.md'],
    ]) assert.ok(html.includes(needle), `the page says it ${what}`);
    assert.ok(html.includes('without your pairing'), 'the page says Link needs your pairing');
    assert.ok(html.includes('Nothing runs that you did not turn on'), 'and that nothing runs on its own');
    assert.ok(html.includes('docs/install.md'), 'the install guide still links the Node docs');
    assert.ok(html.includes('github.com/OpenVibers/OpenVibe.Node'), 'the GitHub source keeps its URL');
    assert.ok(html.includes('/shared/navbar.js'), 'the shared navbar is on the page');
    assert.ok(html.includes("label:'Link'"), 'the navbar calls it Link');
    assert.ok(html.includes('<link rel="canonical" href="https://openvibe.link/">'), 'the canonical is openvibe.link');
    assert.ok(html.includes('<meta property="og:url" content="https://openvibe.link/">'), 'og:url is openvibe.link');
    assert.ok(html.includes('"name":"OpenVibe Link"'), 'the JSON-LD names OpenVibe Link');
    assert.ok(html.includes('"url":"https://openvibe.link"'), 'and its URL is openvibe.link');

    // The llms.txt says the same thing in plain lines.
    const txt = llmsTxt();
    assert.ok(txt.startsWith('# OpenVibe Link'), 'the llms.txt names the site');
    assert.ok(txt.includes('https://openvibe.link/'), 'and links the page');
    assert.ok(txt.includes('curl -fsSL https://openvibe.link/install | sh'), 'and the install command');
    assert.ok(txt.includes('docs/install.md'), 'and the docs');
    assert.ok(txt.includes('https://openvibe.link/machines'), 'and the machines page');

    // ── The routes: the Host header decides ──
    const releaseApi = { latest: async () => SHAPED };
    const app = express();
    app.use(createNodeRoutes({ releaseId: 'rel_test', releaseApi }));
    app.get('/', (_req, res) => res.type('html').send('<p>network home</p>'));
    app.get('/llms.txt', (_req, res) => res.type('text/plain').send('# OpenVibe Network'));
    app.get('/sitemap.xml', (_req, res) => res.type('application/xml').send('<urlset><url><loc>https://openvibe.network/</loc></url></urlset>'));
    app.get('/abcdef12.txt', (_req, res) => res.type('text/plain').send('indexnow-key'));
    const server = http.createServer(app).listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const get = (p, host, headers = {}) => new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { host, ...headers } }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.end();
    });

    try {
        const apex = await get('/', 'openvibe.network');
        assert.ok(apex.body.includes('network home'), 'on the apex, Network\u2019s own home answers');

        const link = await get('/', 'openvibe.link');
        assert.strictEqual(link.status, 200, 'openvibe.link answers the Link page');
        assert.ok(link.body.includes('<title>OpenVibe Link: your machines, connected</title>'), 'with Link\u2019s title');
        assert.ok(link.body.includes('<h1>Your machines, connected</h1>'), 'and Link\u2019s h1');
        assert.ok(!link.body.includes('network home'), 'and not Network\u2019s home');
        assert.ok(String(link.headers.link || '').includes('text/markdown'), 'the page offers its Markdown twin');

        const twin = await get('/index.md', 'openvibe.link');
        assert.strictEqual(twin.status, 200);
        assert.ok(String(twin.headers['content-type'] || '').includes('text/markdown'), 'the twin is Markdown');
        assert.ok(twin.body.includes('# OpenVibe Link'), 'and it says what Link is');
        assert.ok(twin.body.includes('openvibe.link/install'), 'with the install command');

        const nodeHome = await get('/', 'node.openvibe.network');
        assert.strictEqual(nodeHome.status, 301, 'the old host 301s its front page');
        assert.strictEqual(nodeHome.headers.location, 'https://openvibe.link/', 'to the same path on Link');

        const nodePath = await get('/robots.txt?from=notes', 'node.openvibe.network');
        assert.strictEqual(nodePath.status, 301, 'the old host 301s every other path');
        assert.strictEqual(nodePath.headers.location, 'https://openvibe.link/robots.txt?from=notes', 'keeping the path and the query');

        const nodeInstall = await get('/install', 'node.openvibe.network');
        assert.strictEqual(nodeInstall.status, 302, 'the old host keeps serving /install');
        assert.ok(String(nodeInstall.headers.location || '').endsWith('/install.sh'), 'with the release\u2019s own installer');
        const linkInstall = await get('/install', 'openvibe.link');
        assert.strictEqual(linkInstall.status, nodeInstall.status, '/install is the same answer on both hosts');
        assert.strictEqual(linkInstall.headers.location, nodeInstall.headers.location, 'the same release\u2019s installer, byte for byte');
        assert.strictEqual(linkInstall.headers['cache-control'], nodeInstall.headers['cache-control'], 'and the same cache contract');

        for (const p of ['/machines', '/pair']) {
            const hub = await get(p, 'openvibe.link');
            assert.strictEqual(hub.status, 302, `${p} sends a signed-out visitor to the machines hub`);
            assert.strictEqual(hub.headers.location, 'https://openvibe.my/machines', `${p} lands where pairing and the machine list live`);
            assert.strictEqual(hub.headers['cache-control'], 'no-store', `${p} is never cached`);
            const oldHub = await get(p, 'node.openvibe.network');
            assert.strictEqual(oldHub.status, 301, `the old host sends ${p} to Link`);
            assert.strictEqual(oldHub.headers.location, `https://openvibe.link${p}`, `keeping ${p}`);
        }

        const www = await get('/', 'www.openvibe.link');
        assert.strictEqual(www.status, 301, 'www 301s');
        assert.strictEqual(www.headers.location, 'https://openvibe.link/', 'to the apex');
        const wwwInstall = await get('/install', 'www.openvibe.link');
        assert.strictEqual(wwwInstall.status, 301, 'www 301s every path, including /install');
        assert.strictEqual(wwwInstall.headers.location, 'https://openvibe.link/install', 'to the same path on the apex');

        const llms = await get('/llms.txt', 'openvibe.link');
        assert.strictEqual(llms.status, 200);
        assert.ok(llms.body.startsWith('# OpenVibe Link'), 'Link\u2019s own llms.txt answers');
        const nodeLlms = await get('/llms.txt', 'node.openvibe.network');
        assert.strictEqual(nodeLlms.status, 301, 'the old host sends llms.txt to Link too');
        assert.strictEqual(nodeLlms.headers.location, 'https://openvibe.link/llms.txt');

        const sitemap = await get('/sitemap.xml', 'openvibe.link');
        assert.strictEqual(sitemap.status, 200);
        assert.ok(sitemap.body.includes('<loc>https://openvibe.link/</loc>'), 'the sitemap lists openvibe.link');
        assert.ok(!sitemap.body.includes('node.openvibe.network'), 'and not the old host');
        const robots = await get('/robots.txt', 'openvibe.link');
        assert.ok(robots.body.includes('Sitemap: https://openvibe.link/sitemap.xml'), 'robots.txt points at Link\u2019s sitemap');

        const key = await get('/abcdef12.txt', 'openvibe.link');
        assert.strictEqual(key.status, 200, 'an IndexNow key file on Link\u2019s host falls through to the app');
        assert.strictEqual(key.body, 'indexnow-key');

        // Network\u2019s own paths are untouched on the apex.
        const apexLlms = await get('/llms.txt', 'openvibe.network');
        assert.ok(apexLlms.body.startsWith('# OpenVibe Network'), 'the apex keeps its own llms.txt');
    } finally {
        server.close();
    }

    // ── The navbar and the home card point at the new name ──
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(index.includes("label: 'Link', href: 'https://openvibe.link', icon: 'fa-desktop', featured: true"), 'the home page\u2019s navbar leads with Link');
    assert.ok(index.indexOf("label: 'Link'") < index.indexOf("label: 'My Account'"), 'and Link comes first');
    const wallet = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'wallet', 'common.js'), 'utf8');
    assert.ok(wallet.includes("label: 'Link', href: 'https://openvibe.link'"), 'the wallet pages\u2019 navbar does too');
    const home = fs.readFileSync(path.join(__dirname, '..', 'server', 'home', 'render.js'), 'utf8');
    assert.ok(home.includes("'OpenVibe Link: your machines, connected', url: 'https://openvibe.link/'"), 'Network\u2019s home card names Link and links it');
    assert.ok(home.includes("'Install Link', url: 'https://openvibe.link/install'"), 'and its install card does too');

    // The Link origin may ask the network's API (the account's look, the navbar's frame, the shared font); the
    // old node origin stays listed for a cached page that still calls from it.
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.ok(serverSrc.includes("'https://openvibe.link',"), 'the CORS allow-list knows Link\u2019s own origin');
    assert.ok(serverSrc.includes("'https://node.openvibe.network',"), 'and keeps the old Node origin');

    // ── nginx: openvibe.link is a proxy to Network, not a redirect to the old host ──
    const nginx = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'parked-domains.conf'), 'utf8');
    assert.ok(/server_name openvibe\.link www\.openvibe\.link;/.test(nginx), 'the HTTP block claims both names');
    assert.ok(/server_name openvibe\.link;/.test(nginx), 'the HTTPS block claims openvibe.link');
    assert.ok(/server_name www\.openvibe\.link;/.test(nginx), 'and separate block 301s www');
    assert.ok(/proxy_pass http:\/\/127\.0\.0\.1:4000;/.test(nginx), 'the page proxies to Network');
    assert.ok(nginx.includes('/etc/letsencrypt/live/openvibe.link/fullchain.pem'), 'the name\u2019s own certificate');
    assert.ok(!nginx.includes('return 302 https://node.openvibe.network/;'), 'the old redirect is gone');

    console.log('link-home: Link\u2019s page, hosts, installer, twin, sitemap, navbar and nginx proxy ok');
})().catch((e) => { console.error(e); process.exit(1); });
