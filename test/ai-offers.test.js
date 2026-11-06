'use strict';
// Community AI offers in Network (plan E4, the design's "Offer to the network"): Bot reports one machine's models,
// hours, concurrency, credit price and audience; Network validates the offer strictly, keeps it with user-owned
// offers, and lets only a service holding network.registry.read (AI) read the whole set. The offers are never public.
//   node test/ai-offers.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const aiOffers = require('../server/registry/ai-offers');

const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';
const DEVICE = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1';
const ID = `ai:${DEVICE}`;
const offer = () => ({
    offer_id: ID, machine_id: DEVICE, owner: OWNER,
    models: ['llama3.1:8b', 'qwen2.5:7b'], hours: { start: '09:00', end: '23:00', tz: 'Europe/Lisbon' },
    concurrency: 2, price: { in_per_million: 10, out_per_million: 30 }, audience: 'followers', group: null,
    ready: true, health: { status: 'up' },
});

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    for (const id of ['bot', 'ai', 'tools']) {
        await db.prepare(`INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, ?, ?, '[]', 1)
            ON CONFLICT (client_id) DO UPDATE SET client_secret = EXCLUDED.client_secret`).run(id, `${id}-secret`, id);
    }
    await principals.ensureSchema(db);
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.locals.db = db;
    app.locals.config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    app.locals.privateKey = keys.privateKey;
    app.locals.publicKey = keys.publicKey;
    app.use('/oauth', require('../server/auth/oauth-routes'));
    app.use('/internal/ai/offers', aiOffers.routers({
        guard: principals.guard('network.resource.report'),
        readGuard: principals.guard('network.registry.read'),
    }).internal);
    const server = http.createServer(app);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = async (id) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: `${id}-secret`, audience: 'openvibe.network' }) })).json()).access_token;
    const get = (path, tok) => fetch(`${base}${path}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
    try {
        const good = offer();
        assert.strictEqual(aiOffers.check({ source: 'bot', offers: [good] }), null, 'a complete AI offer passes');
        const bad = [
            ['id', (o) => { o.offer_id = 'nope'; }, 'registry.ai_offer_id'],
            ['machine', (o) => { o.machine_id = 'dev_nope'; }, 'registry.ai_offer_machine'],
            ['owner', (o) => { o.owner = 'nobody'; }, 'registry.ai_offer_owner'],
            ['models', (o) => { o.models = []; }, 'registry.ai_offer_models'],
            ['hours', (o) => { o.hours.start = '25:00'; }, 'registry.ai_offer_hours'],
            ['tz', (o) => { o.hours.tz = ''; }, 'registry.ai_offer_hours'],
            ['concurrency', (o) => { o.concurrency = 9; }, 'registry.ai_offer_concurrency'],
            ['price', (o) => { o.price.out_per_million = -1; }, 'registry.ai_offer_price'],
            ['price-number', (o) => { o.price.in_per_million = 'free'; }, 'registry.ai_offer_price'],
            ['audience', (o) => { o.audience = 'friends'; }, 'registry.ai_offer_audience'],
            ['group', (o) => { o.audience = 'group'; o.group = null; }, 'registry.ai_offer_group'],
            ['ready', (o) => { delete o.ready; }, 'registry.ai_offer_ready'],
            ['health', (o) => { o.health = { status: 'sick' }; }, 'registry.ai_offer_health'],
        ];
        for (const [name, mutate, code] of bad) {
            const o = offer(); mutate(o);
            const c = aiOffers.check({ source: 'bot', offers: [o] });
            assert.ok(c && c.error === code, `${name}: ${JSON.stringify(c)}`);
        }

        const bot = await token('bot');
        const ai = await token('ai');
        const tools = await token('tools');
        const posted = await fetch(`${base}/internal/ai/offers/report`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bot}` },
            body: JSON.stringify({ source: 'bot', offers: [good] }) });
        assert.strictEqual(posted.status, 200, await posted.text());
        const read = await get('/internal/ai/offers', ai);
        assert.strictEqual(read.status, 200, 'AI reads the offers with network.registry.read');
        assert.strictEqual(read.body.offers[0].owner, OWNER);
        assert.deepStrictEqual(read.body.offers[0].models, ['llama3.1:8b', 'qwen2.5:7b']);
        assert.strictEqual((await get('/internal/ai/offers', tools)).status, 403, 'a service without the read does not');
        assert.strictEqual((await get('/internal/ai/offers')).status, 403, 'nor does anyone without a token');
        const reportByAi = await fetch(`${base}/internal/ai/offers/report`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ai}` },
            body: JSON.stringify({ source: 'bot', offers: [good] }) });
        assert.strictEqual(reportByAi.status, 403, 'AI reads but never reports');
        // A later report without the offer marks it down; it is kept, not deleted.
        const empty = await fetch(`${base}/internal/ai/offers/report`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bot}` },
            body: JSON.stringify({ source: 'bot', offers: [] }) });
        assert.strictEqual(empty.status, 200);
        assert.strictEqual((await empty.json()).marked_down, 1);
        const down = await get('/internal/ai/offers', ai);
        assert.strictEqual(down.body.offers[0].health.status, 'down');
        assert.strictEqual(down.body.offers[0].ready, false);
        const has = (svc, cap) => principals.DEFAULT_GRANTS.some(([s, c, a]) => s === svc && c === cap && a === 'openvibe.network');
        assert.ok(has('ai', 'network.registry.read'), 'AI holds the internal read');
        assert.ok(has('ai', 'network.follows.read'), 'AI can resolve the followers audience');
        assert.ok(has('ai', 'identity.subject.resolve'), 'AI resolves merged subjects for self-dealing');
        assert.ok(has('bot', 'network.resource.report'), 'Bot reports');
        console.log('ai-offers: ok');
    } finally {
        await db.prepare('DELETE FROM platform_ai_offers WHERE id = ?').run(ID);
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
