'use strict';
// Registry completeness (roadmap Wave 2, D4): /topics from the manifests, payload contracts and what
// Network observed; /releases from each service's /release.json with library drift; /health; /search;
// payload schemas at their $id; and scripts/contracts-drift.js, which warns and never fails.
//   node test/registry-topics.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');
const { createEcosystemRegistry } = require('../server/registry/ecosystem');
const { buildTopics, OBSERVED } = require('../server/registry/topics');
const { parsePin, compare, latestOf, driftOf } = require('../server/registry/versions');
const { TOPICS } = require('../server/notifications/events-consumer');
const drift = require('../scripts/contracts-drift');

function fakeService(routes) {
    const srv = http.createServer((req, res) => {
        const h = routes[req.url];
        if (!h) { res.statusCode = 404; return res.end('{}'); }
        res.statusCode = h[0]; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(h[1]));
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
const ready = [200, { ready: true, status: 'ready', failed: [], degraded: [], checks: { db: { status: 'ok', required: true } } }];
const rel = (contractsVersion, packages) => [200, { service: 'x', release: 'abcdef123456', released_at: '2026-09-23T00:00:00.000Z', booted_at: '2026-09-23T01:00:00.000Z', contracts_version: contractsVersion, packages }];

(async () => {
    // 1. versions
    assert.deepStrictEqual(parsePin('https://codeload.github.com/OpenVibers/OpenVibe.Contracts/tar.gz/refs/tags/v0.30.1').parts, [0, 30, 1]);
    assert.strictEqual(parsePin('0.5.1').tag, 'v0.5.1');
    assert.strictEqual(parsePin('github:OpenVibers/OpenVibe.Contracts#v0.13.0').version, '0.13.0');
    assert.strictEqual(parsePin('file:../x'), null);
    assert.strictEqual(compare('v0.9.0', '0.30.1'), -1, 'numeric, not string, order');
    assert.strictEqual(latestOf(['v0.9.0', 'v0.30.1', 'v0.30.0', 'nightly']).tag, 'v0.30.1');
    assert.strictEqual(driftOf('0.28.0', 'v0.30.1'), 'behind');
    assert.strictEqual(driftOf('0.30.1', 'v0.30.1'), 'current');

    // 2. topics: every produced type, payload contract and consumer; Live and Media from their manifests.
    const built = buildTopics();
    const by = Object.fromEntries(built.topics.map(t => [t.topic, t]));
    const produced = new Set(contracts.services.manifests.flatMap(m => m.eventsProduced || []));
    for (const t of produced) assert.ok(by[t], `${t} is listed`);
    for (const c of contracts.catalog.filter(c => c.schema.startsWith('events/payloads/'))) assert.strictEqual(by[c.id].payload_contract.id, `${c.id}@1`);
    for (const id of ['live', 'media']) for (const t of contracts.services.get(id).eventsProduced) {
        assert.deepStrictEqual(by[t].producers, [{ service: id, declared: 'manifest' }]);
    }
    for (const [id, o] of Object.entries(OBSERVED)) for (const t of o.produced) {
        assert.ok(!(contracts.services.get(id).eventsProduced || []).includes(t), `${id}'s manifest lists ${t}: delete it from OBSERVED`);
    }
    for (const t of TOPICS) assert.ok(by[t].consumers.some(c => c.service === 'network'), `Network consumes ${t}`);
    assert.ok(by['wiki.index_document.upserted'].consumers.some(c => c.service === 'search' && c.pattern === '*.index_document.upserted'), 'a consumer pattern is listed on each topic it matches');
    assert.ok(!by['wiki.page.published'].consumers.some(c => c.service === 'search'));
    assert.strictEqual(by['ai.run.queued'].status, 'planned', 'a planned payload contract says so');
    assert.strictEqual(by['deals.watch.matched'].payload_contract.$id, 'https://openvibe.network/contracts/events/payloads/deals.watch.matched.v1.json');

    // 3. over HTTP
    // The libraries' current release is the version Network installs (server/registry/exposure.js).
    const INSTALLED = { shared: require('openvibe-shared/package.json').version, sdk: require('openvibe-sdk/package.json').version, contracts: require('openvibe-contracts/package.json').version };
    const svc = await fakeService({ '/api/ready': ready, '/ready': ready, '/api/health': [200, {}], '/health': [200, {}], '/healthz': [200, {}], '/release.json': rel('0.28.0', { 'openvibe-shared': INSTALLED.shared, 'openvibe-sdk': '0.3.1', 'evil-pkg': '9.9.9' }) });
    const cur = await fakeService({ '/api/ready': ready, '/api/health': [200, {}], '/release.json': rel(INSTALLED.contracts, { 'openvibe-shared': INSTALLED.shared, 'openvibe-sdk': INSTALLED.sdk }) });
    const eco = createEcosystemRegistry({ issuer: 'https://openvibe.network', internalOverrides: { network: cur.url, live: svc.url, media: 'http://127.0.0.1:1', events: svc.url } });
    await eco.pollAll();
    const app = express();
    app.use(eco.router());
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = (p) => fetch(base + p).then(async r => ({ status: r.status, type: r.headers.get('content-type'), body: await r.json() }));

    let r = await get('/api/v1/registry/topics');
    assert.ok(r.body.topics.length >= produced.size, 'no longer empty');
    r = await get('/api/v1/registry/topics?producer=live');
    assert.deepStrictEqual(r.body.topics.map(t => t.topic).sort(), ['live.index_document.deleted', 'live.index_document.upserted', 'live.release.deployed', 'live.stream.ended', 'live.stream.started']);
    r = await get('/api/v1/registry/topics?consumer=network');
    assert.deepStrictEqual(r.body.topics.map(t => t.topic).sort(), [...TOPICS].sort());
    r = await get('/api/v1/registry/topics?prefix=media.vod.');
    assert.deepStrictEqual(r.body.topics.map(t => t.topic).sort(), ['media.vod.failed', 'media.vod.ready']);
    r = await get('/api/v1/registry/topics/live.stream.started');
    assert.strictEqual(r.body.producers[0].service, 'live');
    r = await get('/api/v1/registry/topics/nope.nope');
    assert.strictEqual(r.status, 404); assert.strictEqual(r.body.code, 'registry.unknown_topic');

    // The services listing carries the merged event lists and says which were observed, not declared.
    r = await get('/api/v1/registry/services/live');
    assert.ok(r.body.eventsProduced.includes('live.stream.started'));
    if (!(contracts.services.get('live').eventsProduced || []).includes('live.stream.started')) assert.ok(r.body.observed.eventsProduced.includes('live.stream.started'));
    r = await get('/api/v1/registry/services/network');
    for (const t of TOPICS) assert.ok(r.body.eventsConsumed.includes(t));
    r = await get('/api/v1/registry/services');
    for (const s of r.body.services) {
        const bare = Object.fromEntries(Object.entries(s).filter(([k]) => !['runtime', 'exposure', 'observed'].includes(k)));
        assert.ok(contracts.validate('registry.service-manifest@1', bare).valid, `${s.id} still validates as a manifest`);
    }

    // Payload schemas are served at their $id.
    r = await get('/contracts/events/payloads/deals.watch.matched.v1.json');
    assert.strictEqual(r.status, 200); assert.ok(r.type.startsWith('application/schema+json'));
    assert.strictEqual(r.body.$id, 'https://openvibe.network/contracts/events/payloads/deals.watch.matched.v1.json');
    assert.strictEqual((await get('/contracts/events/payloads/nope.v1.json')).status, 404);

    // /releases: running releases from /release.json, drift against the libraries' current releases.
    r = await get('/api/v1/registry/releases');
    const rel2 = Object.fromEntries(r.body.services.map(s => [s.id, s]));
    assert.ok(r.body.checked_at);
    assert.deepStrictEqual(r.body.libraries.map(l => l.id).sort(), ['contracts', 'publishing', 'sdk', 'shared']);
    assert.ok(!rel2.sdk && !rel2.contracts, 'libraries are not services');
    assert.strictEqual(rel2.live.release, 'abcdef123456');
    assert.strictEqual(rel2.live.contracts_version, '0.28.0');
    assert.strictEqual(rel2.live.drift['openvibe-contracts'].state, 'behind');
    assert.strictEqual(rel2.live.drift['openvibe-sdk'].state, 'behind');
    assert.strictEqual(rel2.live.drift['openvibe-shared'].state, 'current');
    assert.ok(!('evil-pkg' in rel2.live.packages), 'only openvibe-* packages are repeated');
    assert.strictEqual(rel2.network.drift['openvibe-contracts'].state, 'current');
    assert.ok(r.body.behind.includes('live') && !r.body.behind.includes('network'));
    assert.strictEqual(rel2.media.release, null); assert.ok(rel2.media.error);
    assert.strictEqual(rel2.realtime.release, null, 'a placeholder has no release');

    r = await get('/api/v1/registry/health');
    const h = Object.fromEntries(r.body.services.map(s => [s.id, s]));
    assert.strictEqual(h.network.status, 'up'); assert.strictEqual(h.media.status, 'down'); assert.strictEqual(h.realtime.status, 'not-running');
    assert.ok(h.network.checked_at);
    assert.strictEqual(Object.values(r.body.summary).reduce((a, b) => a + b, 0), contracts.services.manifests.length);

    r = await get('/api/v1/registry/search?q=stream.started');
    assert.deepStrictEqual(r.body.topics.map(t => t.topic), ['live.stream.started']);
    r = await get('/api/v1/registry/search?q=openvibe.community');
    assert.ok(r.body.services.some(s => s.id === 'community'));
    assert.strictEqual((await get('/api/v1/registry/search?q=a')).status, 400);
    r = await get('/api/v1/registry');
    for (const k of ['topics', 'releases', 'health', 'search']) assert.ok(r.body[k]);

    // 4. scripts/contracts-drift.js: warns, never fails; reports an unpublished pin.
    const tags = ['v0.28.0', 'v0.29.0', 'v0.30.0', 'v0.30.1'];
    // What GitHub lists in the CLI checks below: up to the contracts Network installs.
    const LATEST = `v${INSTALLED.contracts}`;
    const ghTags = [...new Set([...tags, LATEST])];
    const found = drift.assess([
        { service: 'a', repo: 'O/A', package: 'openvibe-contracts', spec: 'https://codeload.github.com/OpenVibers/OpenVibe.Contracts/tar.gz/refs/tags/v0.28.0' },
        { service: 'b', repo: 'O/B', package: 'openvibe-contracts', spec: 'https://codeload.github.com/OpenVibers/OpenVibe.Contracts/tar.gz/refs/tags/v0.30.1' },
        { service: 'c', repo: 'O/C', package: 'openvibe-contracts', spec: 'https://codeload.github.com/OpenVibers/OpenVibe.Contracts/tar.gz/refs/tags/v0.27.5' },
        { service: 'd', repo: 'O/D', package: 'openvibe-contracts', spec: null },
        { service: 'e', repo: 'O/E', package: 'openvibe-contracts', spec: null, error: 'no local checkout' },
    ], { 'openvibe-contracts': tags });
    assert.deepStrictEqual(found.map(f => f.state), ['behind', 'current', 'unpublished', 'not-pinned', 'unknown']);
    assert.strictEqual(drift.assess([{ service: 'x', package: 'openvibe-contracts', spec: '0.29.0' }], { 'openvibe-contracts': { tags: ['v0.30.1'], complete: false } })[0].state, 'behind', '--latest never calls a pin unpublished');

    const lines = [];
    const out = { log: (s) => lines.push(s) };
    const fakeGithub = async (url) => {
        const u = String(url);
        if (u.startsWith('https://api.github.com/repos/OpenVibers/OpenVibe.Contracts/tags')) return new Response(JSON.stringify(ghTags.map(name => ({ name }))), { status: 200 });
        if (u.includes('/OpenVibers/OpenVibe.Live/HEAD/package.json')) return new Response(JSON.stringify({ dependencies: { 'openvibe-contracts': 'https://codeload.github.com/OpenVibers/OpenVibe.Contracts/tar.gz/refs/tags/v0.28.0' } }), { status: 200 });
        if (u.includes('raw.githubusercontent.com')) return new Response(JSON.stringify({ dependencies: { 'openvibe-contracts': `https://codeload.github.com/OpenVibers/OpenVibe.Contracts/tar.gz/refs/tags/${LATEST}` } }), { status: 200 });
        return new Response('{}', { status: 404 });
    };
    let code = await drift.main([], { fetchImpl: fakeGithub, env: { GITHUB_ACTIONS: 'true' }, out });
    assert.strictEqual(code, 0, 'drift is a warning, not a failure');
    assert.ok(lines.some(l => l.startsWith(`::warning title=openvibe-contracts drift::live (OpenVibers/OpenVibe.Live) pins v0.28.0, latest is ${LATEST}`)), lines.join('\n'));
    assert.ok(!lines.some(l => l.includes('::warning') && l.includes('OpenVibe.Media')));
    lines.length = 0;
    code = await drift.main(['--strict'], { fetchImpl: fakeGithub, env: {}, out });
    assert.strictEqual(code, 1, '--strict fails on a warning');
    assert.ok(!lines.some(l => l.startsWith('::warning')), 'annotations only under GitHub Actions');
    lines.length = 0;
    code = await drift.main(['--registry', base], { fetchImpl: (u, o) => (String(u).startsWith(base) ? fetch(u, o) : fakeGithub(u, o)), env: {}, out });
    assert.strictEqual(code, 0);
    assert.ok(lines.some(l => l.startsWith(`WARN openvibe-contracts live: pins v0.28.0, latest is ${LATEST}`)), lines.join('\n'));
    assert.ok(lines.some(l => l.includes(`network: pins ${LATEST} (latest)`)), lines.join('\n'));

    eco.stop(); srv.close(); svc.srv.close(); cur.srv.close();
    console.log('registry topics, releases and drift: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
