'use strict';
// What people wear, relayed for Shared's OV.names (§Z.3 fix, 11-13): almost every site's CSP allows openvibe.network and
// not inventory.openvibe.network, so the names feature reads Inventory through Network's frame routes:
//   - GET /api/frame/items/equipped?subjects=… keeps only usr_ ids (1–100, deduplicated, sorted) and relays Inventory's
//     public equipped read; CORS open, public, cached 30 s (a second identical request does not reach Inventory);
//   - GET /api/frame/items/definitions?issuer=service:live&limit=… relays the definitions, cached 5 minutes;
//   - bad input is a 400; an Inventory that does not answer is a 502, never cached.
//   node --import ./test/helpers/pg-preload.mjs test/frame-items-relay.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

const A = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA', B = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';

(async () => {
    const db = getDb();
    await require('../server/identity/principals').ensureSchema(db);
    const seenPaths = [];
    let down = false;
    const inventory = http.createServer((req, res) => {
        seenPaths.push(req.url);
        if (down) { res.statusCode = 503; return res.end('{"error":"down"}'); }
        res.setHeader('content-type', 'application/json');
        if (req.url.startsWith('/api/v1/equipped')) {
            const subjects = new URL(req.url, 'http://x').searchParams.get('subjects').split(',');
            return res.end(JSON.stringify({ equipped: subjects.map((s) => ({ subject: s, slots: { name_effect: { definition_id: 'itd_x' } } })) }));
        }
        if (req.url.startsWith('/api/v1/definitions')) return res.end(JSON.stringify({ definitions: [{ id: 'itd_x', name: 'Glow' }] }));
        res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => inventory.listen(0, '127.0.0.1', r));
    const inventoryUrl = `http://127.0.0.1:${inventory.address().port}`;
    const svc = await createFrameService(db, { services: { inventory: { internalUrl: inventoryUrl }, report: { internalUrl: 'http://127.0.0.1:1' } } }, null, {});
    const app = express();
    app.use('/api/frame', svc.router);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame`;
    try {
        const r = await fetch(`${base}/items/equipped?subjects=${B},${A},not-a-subject,${A}`, { headers: { Origin: 'https://openvibe.locker' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
        assert.match(r.headers.get('cache-control'), /public, max-age=30/);
        const body = await r.json();
        assert.deepStrictEqual(body.equipped.map((e) => e.subject), [A, B], 'only usr_ ids, once each, in order');
        assert.strictEqual(seenPaths.length, 1);
        assert.strictEqual(seenPaths[0], `/api/v1/equipped?subjects=${A},${B}`);
        await fetch(`${base}/items/equipped?subjects=${A},${B}`);
        assert.strictEqual(seenPaths.length, 1, 'the same set within 30 s is served from the cache');

        const d = await fetch(`${base}/items/definitions?issuer=service:live&limit=900`);
        assert.strictEqual(d.status, 200);
        assert.match(d.headers.get('cache-control'), /max-age=300/);
        assert.strictEqual(seenPaths[1], '/api/v1/definitions?issuer=service%3Alive&limit=500', 'the limit is capped');

        assert.strictEqual((await fetch(`${base}/items/equipped?subjects=nobody`)).status, 400);
        assert.strictEqual((await fetch(`${base}/items/definitions?issuer=everyone`)).status, 400);
        const many = Array.from({ length: 130 }, (_, i) => `usr_01JAB2C3D4E5F6G7H8J9K0M${String(i).padStart(3, '0').replace(/[ILOU]/g, 'A')}`.slice(0, 30));
        await fetch(`${base}/items/equipped?subjects=${many.join(',')}`);
        const last = seenPaths[seenPaths.length - 1];
        assert.ok(new URL(last, 'http://x').searchParams.get('subjects').split(',').length <= 100, 'at most 100 people per relay');

        down = true;
        const before = seenPaths.length;
        const fail = await fetch(`${base}/items/equipped?subjects=${B}`);
        assert.strictEqual(fail.status, 502);
        assert.strictEqual(fail.headers.get('cache-control'), 'no-store');
        down = false;
        const again = await fetch(`${base}/items/equipped?subjects=${B}`);
        assert.strictEqual(again.status, 200, 'a failure is never cached');
        assert.ok(seenPaths.length >= before + 2);
        console.log('frame-items-relay: what people wear, through openvibe.network, cached and bounded');
    } finally {
        server.close(); inventory.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
