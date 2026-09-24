'use strict';
// Ecosystem registry (server/registry/ecosystem.js): descriptor, services with timestamped health,
// capability/namespace/contract listings, and schemas served at their $id URLs.
const assert = require('assert');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');
const { createEcosystemRegistry } = require('../server/registry/ecosystem');

(async () => {
    const up = http.createServer((req, res) => { res.statusCode = req.url === '/api/health' ? 200 : 404; res.end('{}'); });
    await new Promise(r => up.listen(0, '127.0.0.1', r));
    const upUrl = `http://127.0.0.1:${up.address().port}`;
    const eco = createEcosystemRegistry({ issuer: 'https://openvibe.network', internalOverrides: { network: upUrl, live: 'http://127.0.0.1:1', media: upUrl } });
    await eco.pollAll();
    const app = express();
    app.use(eco.router());
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = (p) => fetch(base + p).then(async r => ({ status: r.status, type: r.headers.get('content-type'), cors: r.headers.get('access-control-allow-origin'), body: await r.json() }));

    let r = await get('/.well-known/openvibe');
    assert.strictEqual(r.body.jwks_uri, 'https://openvibe.network/api/.well-known/jwks');
    assert.ok(r.body.services.some(s => s.id === 'community'));
    assert.strictEqual(r.cors, '*');

    r = await get('/api/v1/registry/services');
    const byId = Object.fromEntries(r.body.services.map(s => [s.id, s]));
    assert.strictEqual(byId.network.runtime.status, 'up');
    assert.ok(byId.network.runtime.checked_at, 'every health value says when it was checked');
    assert.strictEqual(byId.live.runtime.status, 'down', 'unreachable is reported, not hidden');
    assert.strictEqual(byId.realtime.runtime.status, 'not-running', 'placeholders are never shown as running');
    assert.ok(r.body.services.every(s => contracts.validate('registry.service-manifest@1', Object.fromEntries(Object.entries(s).filter(([k]) => !['runtime', 'exposure', 'observed'].includes(k)))).valid));
    r = await get('/api/v1/registry/services?status=placeholder');
    // openvibe-contracts 0.30: realtime is the only placeholder manifest left (AI, SDK, Shared, Examples are alpha).
    assert.ok(r.body.services.length >= 1 && r.body.services.every(s => s.status === 'placeholder'));
    assert.ok(r.body.services.some(s => s.id === 'realtime'));

    r = await get('/api/v1/registry/services/network');
    assert.ok(r.body.capability_details.some(c => c.id === 'network.coins.credit'));
    r = await get('/api/v1/registry/services/nope');
    assert.strictEqual(r.status, 404); assert.strictEqual(r.body.code, 'registry.unknown_service');
    r = await get('/api/v1/registry/domains/openvibe.community');
    assert.strictEqual(r.body.service.id, 'community');
    r = await get('/api/v1/registry/capabilities?owner=community');
    assert.ok(r.body.capabilities.length >= 3 && r.body.capabilities.every(c => c.owner === 'community'));
    r = await get('/api/v1/registry/namespaces');
    assert.ok(r.body.namespaces.some(n => n.namespace === 'chat.tts_defaults'));

    r = await get('/api/v1/registry/contracts');
    const sub = r.body.contracts.find(c => c.id === 'identity.subject-ref');
    const path = new URL(sub.$id).pathname;
    r = await get(path);
    assert.strictEqual(r.status, 200); assert.ok(r.type.startsWith('application/schema+json'));
    assert.strictEqual(r.body.$id, sub.$id, 'the schema is served at its own $id');
    r = await get('/contracts/identity/nope.v1.json');
    assert.strictEqual(r.status, 404);

    // ── Categories: every manifest in exactly one, by the stated rule ──
    r = await get('/api/v1/registry/categories');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.cors, '*');
    const cats = Object.fromEntries(r.body.categories.map(c => [c.id, c]));
    assert.deepStrictEqual(Object.keys(cats), ['site', 'platform', 'library', 'repository', 'planned']);
    for (const c of r.body.categories) assert.ok(c.rule && c.count === c.services.length, `${c.id} states its rule and count`);
    const listed = r.body.categories.flatMap(c => c.services.map(x => x.id)).sort();
    assert.deepStrictEqual(listed, contracts.services.manifests.map(m => m.id).sort(), 'every service in exactly one category');
    const inCat = (id) => r.body.categories.find(c => c.services.some(x => x.id === id)).id;
    assert.strictEqual(inCat('live'), 'site'); assert.strictEqual(inCat('network'), 'site'); assert.strictEqual(inCat('tips'), 'site', 'a site whose domain is still a placeholder is a site, not open yet');
    assert.strictEqual(inCat('events'), 'platform'); assert.strictEqual(inCat('ai'), 'platform'); assert.strictEqual(inCat('sources'), 'platform');
    assert.strictEqual(inCat('sdk'), 'library'); assert.strictEqual(inCat('contracts'), 'library');
    assert.strictEqual(inCat('examples'), 'repository'); assert.strictEqual(inCat('realtime'), 'planned');
    const liveRow = cats.site.services.find(x => x.id === 'live');
    assert.strictEqual(liveRow.runtime, 'down'); assert.ok(liveRow.checked_at, 'rows carry the last check');
    r = await get('/api/v1/registry/categories/library');
    assert.strictEqual(r.status, 200); assert.ok(r.body.services.some(x => x.id === 'shared'));
    r = await get('/api/v1/registry/categories/nope');
    assert.strictEqual(r.status, 404); assert.strictEqual(r.body.code, 'registry.unknown_category');

    // ── Featured: open sites that are up, in the navigation's usage order; stale or cold start says so ──
    eco.health.set('media', { status: 'up', checked_at: new Date().toISOString() });
    r = await get('/api/v1/registry/featured');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.cors, '*');
    assert.ok(r.body.derivation.includes('7 days'), 'the rule is stated');
    assert.strictEqual(r.body.ordered_by, 'site list order (no use counted yet)'); assert.strictEqual(r.body.stale, true);
    assert.deepStrictEqual(r.body.featured.map(f => f.id), ['media'], 'only a site that is up (media), never network itself or a down one (live)');
    assert.strictEqual(r.body.featured[0].rank, 1); assert.strictEqual(r.body.featured[0].origin, 'https://openvibe.media');
    // With a usage ranking: its order, and when it was counted.
    eco.health.set('live', { status: 'degraded', checked_at: new Date().toISOString() });
    eco.health.set('tools', { status: 'up', checked_at: new Date().toISOString() });
    eco.health.set('tips', { status: 'up', checked_at: new Date().toISOString() });
    eco.setRanking(() => ({ at: Date.now() - 60_000, order: ['tools', 'network', 'media', 'live', 'tips'], everyMs: 30 * 60_000 }));
    r = await get('/api/v1/registry/featured');
    assert.deepStrictEqual(r.body.featured.map(f => f.id), ['tools', 'media', 'live'], 'usage order; a site that is not open (tips) is never featured');
    assert.deepStrictEqual(r.body.featured.map(f => f.rank), [1, 2, 3]);
    assert.strictEqual(r.body.ordered_by, 'usage'); assert.strictEqual(r.body.stale, false); assert.ok(r.body.ranked_at);
    eco.setRanking(() => ({ at: Date.now() - 3 * 3600_000, order: ['tools'], everyMs: 30 * 60_000 }));
    assert.strictEqual((await get('/api/v1/registry/featured')).body.stale, true, 'a ranking four refreshes old is stale');
    r = await get('/api/v1/registry');
    assert.strictEqual(r.body.categories, '/api/v1/registry/categories'); assert.strictEqual(r.body.featured, '/api/v1/registry/featured');

    // ── Hand-kept maps only where the manifests have nothing ──
    const { READY_PATHS, internalFromEnv } = require('../server/registry/ecosystem');
    for (const id of Object.keys(READY_PATHS)) assert.ok(!contracts.services.get(id).ready, `READY_PATHS.${id}: its manifest has no ready path (drop the entry once it does)`);
    const env = internalFromEnv({ OV_EVENTS_INTERNAL_URL: 'http://127.0.0.1:4300/', OV_AI_INTERNAL_URL: 'http://localhost:4700', OV_LIVE_INTERNAL_URL: 'https://live.example.com', OV_NOPE_INTERNAL_URL: 'http://127.0.0.1:1' });
    assert.deepStrictEqual(env.overrides, { events: 'http://127.0.0.1:4300', ai: 'http://localhost:4700' }, 'loopback URLs of known services override');
    assert.deepStrictEqual(env.ignored, ['OV_LIVE_INTERNAL_URL'], 'a non-loopback address is ignored and reported');
    const { SITES } = require('../server/chrome/sites');
    for (const site of SITES) {
        const m = contracts.services.get(site.service);
        if (m && m.publicOrigin) assert.strictEqual(site.host, new URL(m.publicOrigin).hostname, `${site.id}: host from the manifest`);
    }

    eco.stop(); srv.close(); up.close();
    console.log('ecosystem registry: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
