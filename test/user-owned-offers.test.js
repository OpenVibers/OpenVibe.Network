'use strict';
// A person's own machine in the resource registry (plan T14/T16, contracts 0.161.0): Bot reports a user-owned worker
// offer that names its owner; the public offers list and the public single read leave it out (404), while placement
// reads it whole from /internal/resources with network.registry.read (Run) or network.resource.report (a reporter).
// The grants that wire the chain exist: Bot reports, Run reads, Codes submits, reads, streams and cancels Run jobs.
//   node test/user-owned-offers.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const offers = require('../server/registry/offers');

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    for (const id of ['bot', 'run', 'tools']) {
        await db.prepare(`INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, ?, ?, '[]', 1)
            ON CONFLICT (client_id) DO UPDATE SET client_secret = EXCLUDED.client_secret`).run(id, `${id}-secret`, id);
    }
    await principals.ensureSchema(db); // the default grants of the clients just added
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.locals.db = db;
    app.locals.config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    app.locals.privateKey = keys.privateKey;
    app.locals.publicKey = keys.publicKey;
    app.use('/oauth', require('../server/auth/oauth-routes'));
    const r = offers.routers({
        guard: principals.guard('network.resource.report'),
        readGuard: principals.guardAny(['network.resource.report', 'network.registry.read']),
    });
    app.use('/api/v1/offers', r.pub);
    app.use('/internal/resources', r.internal);
    const server = http.createServer(app);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = async (id) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: `${id}-secret`, audience: 'openvibe.network' }) })).json()).access_token;
    const get = (path, tok) => fetch(`${base}${path}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
    const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';
    const mine = {
        offer_id: 'node:dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', kind: 'node', node_id: 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', provider: 'self',
        region: 'home', cell: 'wnam-1', trust: 'user-owned', owner: OWNER, capabilities: ['worker:code'],
        health: { status: 'up' }, pricing: { model: 'free-allowance', marginal_usd_per_unit: 0 }, updated_at: '2026-10-14T12:00:00Z',
    };
    const ours = { ...mine, offer_id: 'node:first-party-1', node_id: 'first-party-1', provider: 'ovh', region: 'us-west', trust: 'first-party', owner: undefined };
    try {
        const bot = await token('bot');
        const run = await token('run');
        const tools = await token('tools');
        assert.ok(bot && run && tools, `the three services mint tokens: ${[bot, run, tools].map(Boolean)}`);
        const report = await fetch(`${base}/internal/resources/report`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bot}` }, body: JSON.stringify({ source: 'bot', offers: [mine, ours] }) });
        assert.strictEqual(report.status, 200, 'Bot holds network.resource.report and its user-owned offer validates with its owner');

        const pub = await get('/api/v1/offers?kind=node');
        assert.deepStrictEqual(pub.body.offers.map((o) => o.offer_id), ['node:first-party-1'], 'the public list leaves the person’s machine out');
        assert.strictEqual(JSON.stringify(pub.body).includes(OWNER), false, 'and never shows its owner');
        assert.strictEqual((await get(`/api/v1/offers/${encodeURIComponent(mine.offer_id)}`)).status, 404, 'a public single read is 404');
        assert.strictEqual((await get('/api/v1/offers/node:first-party-1')).status, 200);

        const internal = await get('/internal/resources?kind=node', run);
        assert.strictEqual(internal.status, 200, 'Run reads the internal list with network.registry.read');
        const got = internal.body.offers.find((o) => o.offer_id === mine.offer_id);
        assert.strictEqual(got && got.owner, OWNER, 'with the owner, for placement');
        assert.strictEqual((await get('/internal/resources?kind=node', bot)).status, 200, 'the reporter still reads it');
        assert.strictEqual((await get('/internal/resources?kind=node', tools)).status, 403, 'a service with neither capability does not');
        assert.strictEqual((await get('/internal/resources?kind=node')).status, 403, 'nor does anyone without a token');
        const runReport = await fetch(`${base}/internal/resources/report`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${run}` }, body: JSON.stringify({ source: 'run', offers: [] }) });
        assert.strictEqual(runReport.status, 403, 'Run reads but never reports');

        const has = (svc, cap, aud) => principals.DEFAULT_GRANTS.some(([s, c, a]) => s === svc && c === cap && a === aud);
        assert.ok(has('bot', 'network.resource.report', 'openvibe.network'));
        assert.ok(has('run', 'network.registry.read', 'openvibe.network'));
        for (const cap of ['run.job.submit', 'run.job.read', 'run.job.stream', 'run.job.cancel']) assert.ok(has('codes', cap, 'openvibe.run'), cap);
        console.log('user-owned-offers: ok');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
