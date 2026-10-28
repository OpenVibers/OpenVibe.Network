'use strict';
// GET /api/coins/me?with=vibes: OpenCoins and Vibes in one request. Every site's connect-src allows openvibe.network and
// none allowed billing.openvibe.network, so Vibes never showed beside OpenCoins in the navbar (2026-10-28).
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const createCoinsRoutes = require('../server/coins/routes');

(async () => {
    const asked = [];
    let mode = 'ok';
    const billing = http.createServer((req, res) => {
        asked.push({ url: req.url, auth: req.headers.authorization });
        if (mode === 'down') { res.statusCode = 503; return res.end('{}'); }
        if (mode === 'slow') return setTimeout(() => res.end('{"credit":1}'), 2600);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ credit: 1250, currency: 'vibes' }));
    });
    await new Promise((r) => billing.listen(0, '127.0.0.1', r));
    const requireAuth = (req, res, next) => { req.user = { id: 987654 }; next(); };
    const app = express();
    app.use('/api/coins', createCoinsRoutes(getDb(), requireAuth, { billingUrl: `http://127.0.0.1:${billing.address().port}/` }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/coins/me`;
    const get = async (qs, headers = { Authorization: 'Bearer user-token' }) => { const r = await fetch(`${base}${qs}`, { headers }); return { r, d: await r.json() }; };

    let { r, d } = await get('');
    assert.deepStrictEqual(Object.keys(d), ['balance'], 'without with=vibes: the balance only, Billing not asked');
    assert.strictEqual(asked.length, 0);

    ({ r, d } = await get('?with=vibes'));
    assert.strictEqual(typeof d.balance, 'number');
    assert.strictEqual(d.vibes, 1250);
    assert.deepStrictEqual(asked[0], { url: '/api/me/vibes', auth: 'Bearer user-token' }, "Billing is asked with the person's own token");
    assert.match(r.headers.get('cache-control'), /private, no-store/);

    mode = 'down';
    ({ d } = await get('?with=vibes'));
    assert.strictEqual(d.vibes, null, 'Billing down: no Vibes, the coins still answer');

    ({ d } = await get('?with=vibes', {}));
    assert.strictEqual(d.vibes, null, 'no bearer token (a cookie session): Billing is not asked');
    assert.strictEqual(asked.length, 2);

    mode = 'slow';
    const t0 = Date.now();
    ({ d } = await get('?with=vibes'));
    assert.strictEqual(d.vibes, null);
    assert.ok(Date.now() - t0 < 2500, 'a slow Billing is given two seconds');

    server.close(); billing.close();
    console.log('coins-vibes: both balances in one request; Billing down, slow or no token gives vibes null ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
