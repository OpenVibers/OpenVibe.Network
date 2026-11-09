'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const { routers } = require('../server/registry/machines');

(async () => {
    const owner = `usr_${'A'.repeat(26)}`;
    const id = `dev_${'A'.repeat(26)}`;
    const records = [{ id, name: 'Studio', online: true, roles: ['codes.worker'], running: [] }];
    const bot = { list: async (subject) => ({ machines: subject === owner ? records : [] }) };
    const requireAuth = (req, _res, next) => { req.user = { subject_id: owner }; next(); };
    const app = express();
    app.use('/api/v1/link/compute', routers({ bot, requireAuth, publicKey: '', issuer: '' }).compute);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const list = await fetch(`${base}/api/v1/link/compute`).then((r) => r.json());
        assert.deepEqual(list.sources.map((s) => s.kind), ['personal', 'cloud', 'exchange', 'community']);
        assert.deepEqual(list.candidates.map((c) => c.id), [id]);
        assert.equal(list.candidates[0].status, 'ready');
        assert.equal(list.sources[2].price, null, 'a rental has no invented price');
        const pick = async (body) => {
            const response = await fetch(`${base}/api/v1/link/compute/pick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            return { status: response.status, body: await response.json() };
        };
        assert.equal((await pick({ id })).body.choice.id, id);
        assert.equal((await pick({ kind: 'exchange' })).status, 409, 'a placeholder cannot start a rental');
        records[0].online = false;
        const offline = await pick({ id });
        assert.equal(offline.status, 409);
        assert.match(offline.body.detail, /offline/);
        console.log('link-compute: four sources, owner machine selection and unavailable reasons ok');
    } finally { server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
