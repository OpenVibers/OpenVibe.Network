'use strict';
// The service worker's kill switch exists (11-28: every site's worker asked GET /api/v1/sw-config and got a 404, so the
// switch the workers were built around could not be thrown): { enabled: true } by default, { enabled: false } with
// OV_SW_ENABLED=false, readable by a worker on any site, cached five minutes.
const assert = require('assert');
const express = require('express');
const { createSwConfigRoutes } = require('../server/sw/config');

(async () => {
    const serve = async (env) => {
        const app = express();
        app.use('/api/v1/sw-config', createSwConfigRoutes({ env }));
        const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/sw-config`, { headers: { Origin: 'https://openvibe.live' } });
        const out = { status: res.status, cors: res.headers.get('access-control-allow-origin'), cache: res.headers.get('cache-control'), body: await res.json() };
        server.close();
        return out;
    };
    const on = await serve({});
    assert.deepStrictEqual(on, { status: 200, cors: '*', cache: 'public, max-age=300', body: { enabled: true } });
    assert.deepStrictEqual((await serve({ OV_SW_ENABLED: 'false' })).body, { enabled: false }, 'thrown, every worker unregisters');
    assert.deepStrictEqual((await serve({ OV_SW_ENABLED: 'true' })).body, { enabled: true });
    console.log('sw-config: the kill switch answers every site, on by default, off with OV_SW_ENABLED=false');
})().catch((e) => { console.error(e); process.exit(1); });
