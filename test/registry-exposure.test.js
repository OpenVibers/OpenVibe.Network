'use strict';
// Exposure overlay (server/registry/exposure.js): every service has one honest state, and the
// registry, the status page and the Frame's nav all say the same thing. A service that runs on
// loopback while its public domain still serves a placeholder is never "up" at that domain.
//   node test/registry-exposure.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');
const exposure = require('../server/registry/exposure');
const { createEcosystemRegistry } = require('../server/registry/ecosystem');
const { createStatusRoutes } = require('../server/status/routes');
const { SITES, DOORS } = require('../server/frame/sites');

// Observed 2026-09-23 with curl against every public domain. Change a row only after the domain
// stops answering "this page is a placeholder" (or a library ships a new release).
const PINNED = {
    network: 'live', live: 'live', tools: 'live', media: 'live', games: 'live', community: 'live', connect: 'live', events: 'live',
    billing: 'live', codes: 'live', blog: 'live', wiki: 'live', sites: 'retired',   // Sites retired 2026-10-14 (contracts 0.181.0)
    news: 'live', reviews: 'live', deals: 'live', coupons: 'live', trade: 'live', host: 'live', domains: 'live', report: 'live', design: 'live', today: 'live', surf: 'live', meme: 'live', vision: 'live', exchange: 'live', fun: 'live', cam: 'live', bench: 'live', casino: 'live', tours: 'live', shoes: 'live',   // News, Reviews, Coupons, Trade live since contracts 0.125.0; Domains since 0.226.0, Report 0.227.0, Design 0.228.0, Meme since 0.234.0, Vision and Exchange since 0.235.0, Fun since 0.236.0, Cam since 0.237.0, Bench since 0.238.0, Casino since 0.264.0
    tips: 'live', vip: 'live', openre: 'live', search: 'live', sources: 'internal', chat: 'live', 'media-hub': 'live', space: 'live',   // a home and redirects since the forum returned to Community (contracts 0.118.0)
    // tips, vip: their own sites at openvibe.tips and openvibe.vip since contracts 0.200.0 (2026-10-17)
    ai: 'live',   // the public API at ai.openvibe.services since 2026-10-07; its human pages moved to Exchange 2026-11-07
    // openvibe-contracts v0.86-v0.90: Bot runs (its own exposure row). Zone: storage zones at openvibe.zone since 0.173.0.
    bot: 'live', zone: 'live',
    actor: 'live',   // OpenVibe's own agent and the router for agent work at openvibe.actor since 2026-10-08 (contracts 0.115.0)
    computer: 'live', locker: 'live',   // launched 2026-11-08 (contracts 0.347.0)
    directory: 'live',   // OpenVibe.Directory catalogued as a live service (contracts 0.406.0, #445)
    compare: 'live',     // OpenVibe.Compare catalogued in contracts 0.409.0 (its manifest is alpha, its domain answers the service)
    studio: 'live',   // launched 2026-11-08 (contracts 0.348.0)
    food: 'live', help: 'live', work: 'live',   // services since contracts 0.116.0 (plan T19, 2026-10-08)
    quest: 'live', rent: 'live',   // services since contracts 0.117.0
    inventory: 'live',   // the network-wide inventory at inventory.openvibe.network since contracts 0.122.0 (ADR-054)
    play: 'live',   // achievements and leaderboards at play.openvibe.network since contracts 0.172.0 (Games ADR-0007)
    run: 'live',        // OpenVibe.Run's own site at openvibe.run since 2026-10-11 (contracts 0.141.0; loopback service since 0.109.0)
    services: 'live',   // OpenVibe.Services: the developer platform at openvibe.services since 2026-10-08 (contracts 0.113.0; the portal moved from Codes)
    // openvibe-contracts v0.102.0: OpenVibe.Watch is a charter only (plan T18).
    watch: 'live',   // OpenVibe.Watch's public site since contracts 0.117.0 (loopback service since 0.108.0)
    sdk: 'library', shared: 'library', contracts: 'library', publishing: 'library',
    examples: 'repository',
};
// Email (OpenVibe.Mail) is live in the release that adds its manifest. Until Network pins that release the installed
// Contracts has no `mail`, so the pinned map follows what is actually installed and gains it the day the pin moves.
const HAS_MAIL = !!contracts.services.get('mail');
if (HAS_MAIL) PINNED.mail = 'live';
// Git (OpenVibe.Git) is live in the release that adds its manifest (contracts 0.373.0).
const HAS_GIT = !!contracts.services.get('git');
if (HAS_GIT) PINNED.git = 'live';
const PLACEHOLDER_DOMAINS = [];   // none left: tips and vip live since contracts 0.200.0; deals since 0.118.0; news, reviews, coupons, trade, openre since 0.125.0

function fakeService(routes) {
    const srv = http.createServer((req, res) => {
        const h = routes[req.url];
        if (!h) { res.statusCode = 404; return res.end('{}'); }
        res.statusCode = h[0]; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(h[1]));
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
const ready = [200, { ready: true, status: 'ready', failed: [], degraded: [], checks: { db: { status: 'ok', required: true } } }];

(async () => {
    // 1. Every manifest is classified, and the classification is the pinned one.
    for (const m of contracts.services.manifests) assert.notStrictEqual(exposure.exposureOf(m.id).state, 'unknown', `${m.id} has no exposure state`);
    const actual = Object.fromEntries(contracts.services.manifests.map(m => [m.id, exposure.exposureOf(m.id).state]));
    assert.deepStrictEqual(actual, PINNED);
    assert.deepStrictEqual(Object.keys(exposure.EXPOSURE).sort(), Object.keys(PINNED).sort(), 'no stale rows for services that no longer exist');
    for (const id of PLACEHOLDER_DOMAINS) {
        assert.strictEqual(exposure.EXPOSURE[id].public_site, 'placeholder', `${id}'s domain serves a placeholder`);
        assert.strictEqual(exposure.publicOriginOf(contracts.services.get(id)), null, `${id} has no public origin`);
    }
    assert.strictEqual(exposure.exposureOf('sdk').release, `v${require('openvibe-sdk/package.json').version}`);
    assert.strictEqual(exposure.exposureOf('shared').release, `v${require('openvibe-shared/package.json').version}`, 'the release is the installed version');
    assert.strictEqual(exposure.exposureOf('nope').state, 'unknown', 'an unclassified id is unknown, not public');

    // 2. Registry and status over fake loopback services.
    const up = await fakeService({ '/api/ready': ready, '/ready': ready, '/api/health': [200, { status: 'ok' }], '/health': [200, {}], '/healthz': [200, {}] });
    const ai = await fakeService({ '/api/ready': ready, '/api/health': [200, { status: 'ok' }] });   // AI answers its manifest's /api/ready (contracts 0.30)
    const overrides = {};
    for (const id of Object.keys(exposure.EXPOSURE)) overrides[id] = up.url;
    overrides.ai = ai.url;
    const eco = createEcosystemRegistry({ issuer: 'https://openvibe.network', internalOverrides: overrides });
    await eco.pollAll();
    const app = express();
    app.use(createStatusRoutes({ ecosystem: eco }));
    app.use(eco.router());
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (p) => fetch(base + p).then(r => r.json());

    const d = await json('/.well-known/openvibe');
    const dBy = Object.fromEntries(d.services.map(s => [s.id, s]));
    assert.strictEqual(dBy.sources.state, 'internal');
    assert.strictEqual(dBy.sources.origin, null, 'clients never route to a service that is loopback only');
    assert.strictEqual(dBy.tips.state, 'live', 'Tips serves openvibe.tips since contracts 0.200.0');
    assert.strictEqual(dBy.tips.origin, 'https://openvibe.tips');
    assert.strictEqual(dBy.live.origin, 'https://openvibe.live');
    assert.strictEqual(dBy.live.state, 'live');
    for (const s of d.services) assert.strictEqual(s.state, PINNED[s.id]);

    let r = await json('/api/v1/registry/services');
    const by = Object.fromEntries(r.services.map(s => [s.id, s]));
    assert.strictEqual(by.sources.exposure.state, 'internal');
    assert.strictEqual(by.sources.runtime.status, 'up');
    assert.strictEqual(by.sources.runtime.scope, 'loopback');
    assert.match(by.sources.runtime.reason, /loopback only/);
    assert.strictEqual(by.tips.exposure.public_site, 'service');
    assert.strictEqual(by.tips.runtime.scope, 'public');
    assert.strictEqual(by.deals.exposure.state, 'live', 'Deals serves openvibe.deals since contracts 0.118.0');
    assert.strictEqual(by.ai.runtime.status, 'up', 'AI is polled on loopback although its pinned manifest says placeholder');
    assert.strictEqual(by.ai.runtime.basis, 'ready');
    assert.strictEqual(by.sdk.runtime.status, 'not-running');
    assert.strictEqual(by.sdk.runtime.reason, `library, released v${require('openvibe-sdk/package.json').version}`);
    // A library Network does not install (openvibe-publishing) says what it is, never "released undefined".
    if (by.publishing) assert.strictEqual(by.publishing.runtime.reason, 'library, installed by the services that use it');
    assert.strictEqual(by.examples.runtime.reason, 'repository, nothing to run');
    // openvibe-contracts 0.78.0 removed the realtime manifest (ADR-005 closed OpenVibe.Realtime, never built)
    assert.ok(!('realtime' in by), 'realtime is gone from the exposure map, not a stale row');
    assert.strictEqual(by.live.runtime.scope, 'public');
    r = await json('/api/v1/registry/services?state=internal');
    assert.deepStrictEqual(r.services.map(s => s.id).sort(), Object.keys(PINNED).filter(k => PINNED[k] === 'internal').sort());
    r = await json('/api/v1/registry/domains/openvibe.tips');
    assert.strictEqual(r.service.exposure.state, 'live');

    const st = await json('/api/v1/status');
    const sBy = Object.fromEntries(st.services.map(s => [s.id, s]));
    assert.strictEqual(sBy.sources.label, 'up (loopback only)');
    assert.strictEqual(sBy.sources.origin, null);
    assert.strictEqual(sBy.tips.origin, 'https://openvibe.tips');
    assert.strictEqual(sBy.live.label, 'up');
    assert.strictEqual(sBy.live.origin, 'https://openvibe.live');
    assert.strictEqual(sBy.shared.label, `not running (library, released v${require('openvibe-shared/package.json').version})`);
    // Contracts 0.83.0 added two placeholder services (media-hub, space), v0.86-v0.90 Bot (live) and two more (zone, run),
    // v0.95.0 Services; Space and AI went live in v0.110.0; Food, Help and Work in v0.116.0; Quest, Rent and Watch in v0.117.0;
    // Inventory in v0.122.0; none is retired
    // News, Reviews, Coupons, Trade and OpenRestream in v0.125.0; Run in v0.141.0
    assert.deepStrictEqual(st.exposure_summary, { live: 58 + (HAS_MAIL ? 1 : 0) + (HAS_GIT ? 1 : 0), internal: 1, library: 4, repository: 1, placeholder: 0, retired: 1 });   // Sites retired (contracts 0.181.0); Tips and VIP live (0.200.0); Design live (0.228.0); Meme live (0.234.0); Vision and Exchange live (0.235.0); Fun live (0.236.0); Cam live (0.237.0); Bench live (0.238.0); Email live with the release that adds its manifest; Git live (contracts 0.373.0); Directory live (contracts 0.406.0, #445); Compare live (contracts 0.409.0)

    // The page: no row for a service whose domain serves a placeholder shows a bare "Up".
    const html = await fetch(base + '/status').then(x => x.text());
    for (const id of PLACEHOLDER_DOMAINS) {
        const row = html.match(new RegExp(`<tr id="svc-${id}">[\\s\\S]*?</tr>`))[0];
        assert.ok(!/>Up<\/span>/.test(row), `${id} row must not read a bare Up`);
        assert.ok(row.includes('Up · loopback only'), `${id} row says loopback only`);
        assert.ok(row.includes('internal (loopback only)'), `${id} row names its exposure`);
    }
    assert.ok(/<tr id="svc-tips">[\s\S]*?>Up<\/span>/.test(html), 'Tips serves openvibe.tips since contracts 0.200.0');
    assert.ok(/<tr id="svc-live">[\s\S]*?>Up<\/span>/.test(html), 'a public service still reads Up');
    assert.ok(/<tr id="svc-ai">[\s\S]*?>Up<\/span>/.test(html), 'AI serves its own public origin since contracts 0.110.0');

    // 3. The Frame: the nav lists only sites whose domain serves the service; the rest are soon with a reason.
    // Play stays live in the exposure overlay (the API serves) but is part of Games now, so it is not a nav site.
    assert.ok(!SITES.some(s => s.id === 'play'), 'Play is part of Games, not a menu entry');
    const open = SITES.filter(s => s.status === 'open').map(s => s.id);
    const EXPECTED_OPEN = ['live', 'tools', 'community', 'games', 'media', 'network', 'chat', 'services', 'blog', 'wiki', 'news', 'reviews', 'tips', 'vip', 'trade', 'host', 'deals', 'coupons', 'stream', 'space', 'media-hub', 'bot', 'codes', 'actor', 'food', 'help', 'work', 'quest', 'rent', 'watch', 'inventory', 'events', 'search', 'run', 'zone', 'domains', 'report', 'design', 'today', 'surf', 'meme', 'vision', 'exchange', 'fun', 'cam', 'casino', 'tours', 'shoes', 'connect', 'computer', 'lock', 'image', 'compare', 'directory'];   // by site position; Email joins after Chat once its manifest is pinned; Directory (contracts 0.406.0) is last
    if (HAS_MAIL) EXPECTED_OPEN.splice(EXPECTED_OPEN.indexOf('chat') + 1, 0, 'mail');
    if (HAS_GIT) EXPECTED_OPEN.splice(EXPECTED_OPEN.indexOf('events') + 1, 0, 'git');
    // The three doors of 2026-11-13 (openvibe.expert, openvibe.markets, openvibe.finance): their own services come
    // later, their domains answer with a 302 to the service that holds their content today, so they are open.
    EXPECTED_OPEN.push('expert', 'markets', 'finance');
    assert.deepStrictEqual(open, EXPECTED_OPEN);
    for (const s of SITES) {
        if (s.id === 'computer' && !contracts.services.get('computer')) {
            assert.strictEqual(s.status, 'soon', 'Computer stays listed but not open until its service manifest is pinned');
            continue;
        }
        if (DOORS.some(d => d.id === s.id)) {
            assert.strictEqual(s.status, 'open', `${s.id} is a door: its domain answers, so it is open`);
            assert.strictEqual(s.state, 'live', `${s.id} is a door: its domain answers, so it is live`);
            assert.strictEqual(s.host, `openvibe.${s.id}`, `${s.id} names its own domain`);
            assert.ok(!PINNED[s.service], `${s.id} has no service of its own yet: no exposure row`);
            continue;
        }
        assert.ok(s.service && PINNED[s.service], `${s.id} names its service`);
        assert.strictEqual(s.status === 'open', PINNED[s.service] === 'live', `${s.id} nav status follows exposure`);
    }
    for (const id of ['tips', 'vip']) {
        const s = SITES.find(x => x.id === id);
        assert.strictEqual(s.status, 'open', `${id} is open since contracts 0.200.0`);
    }

    eco.stop(); srv.close(); up.srv.close(); ai.srv.close();
    console.log('registry exposure: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
