'use strict';
// The node registry (roadmap WS-X1, ADR-034 §12; Contracts network.node@1): POST /internal/nodes/report takes
// Host's token only and the request contract; a node missing from the same source's next report is marked down,
// not deleted; GET /api/v1/nodes is public, cacheable, filterable and answers network.node-list-result@1.
//   node test/nodes.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const nodes = require('../server/registry/nodes');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-nodes-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
db.prepare("UPDATE oauth_clients SET client_secret = 'host-secret' WHERE client_id = 'host'").run();
db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const app = express();
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
const r = nodes.routers({ guard: principals.guard('network.node.report', { legacy: false }) });
app.use('/api/v1/nodes', r.pub);
app.use('/internal/nodes', r.internal);
const server = http.createServer(app);

const node = (id, extra = {}) => ({ id, name: id, roles: ['web', 'app'], location: { region: 'us-west', country: 'US' }, provider: 'ovh', beacon: `https://openvibe.network/api/v1/nodes/${id}/beacon`, health: { status: 'up', checked_at: '2026-09-28T12:00:00Z' }, updated_at: '2026-09-28T12:00:00Z', ...extra });

(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = async (id, secret) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network' }) })).json()).access_token;
    const post = (body, headers) => fetch(`${base}/internal/nodes/report`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
        .then(async (x) => ({ status: x.status, headers: x.headers, body: await x.json().catch(() => null) }));
    const get = (q = '') => fetch(`${base}/api/v1/nodes${q}`).then(async (x) => ({ status: x.status, headers: x.headers, body: await x.json() }));
    try {
        const auth = { authorization: `Bearer ${await token('host', 'host-secret')}` };
        assert.strictEqual((await post({ source: 'oregon', nodes: [] })).status, 403, 'nobody');
        assert.ok([401, 403].includes((await post({ source: 'oregon', nodes: [] }, { 'x-internal-key': 'legacy-key' })).status), 'not the shared key');
        assert.strictEqual((await post({ source: 'oregon', nodes: [] }, { authorization: `Bearer ${await token('live', 'live-secret')}` })).status, 403, 'Live lacks network.node.report');
        assert.strictEqual((await post({ source: 'oregon', nodes: [node('a', { address: '10.0.0.1' })] }, auth)).status, 400, 'no address field: the contract refuses it');

        let x = await post({ source: 'oregon', nodes: [node('oregon-1', { roles: ['web', 'app', 'data'] }), node('oregon-2', { roles: ['edge-probe'], location: { region: 'us-east', country: 'US' } })] }, auth);
        assert.strictEqual(x.status, 200, JSON.stringify(x.body));
        assert.ok(validate('network.node-list-result@1', x.body).valid);
        assert.strictEqual(x.body.nodes.length, 2);

        x = await get();
        assert.strictEqual(x.status, 200);
        assert.ok(validate('network.node-list-result@1', x.body).valid);
        assert.match(x.headers.get('cache-control'), /public, max-age=60/);
        assert.strictEqual(x.headers.get('access-control-allow-origin'), '*');
        assert.deepStrictEqual((await get('?role=edge-probe')).body.nodes.map((n) => n.id), ['oregon-2']);
        assert.deepStrictEqual((await get('?region=us-west')).body.nodes.map((n) => n.id), ['oregon-1']);

        // oregon-2 leaves the inventory: marked down, still listed; another source's nodes are untouched.
        await post({ source: 'frankfurt', nodes: [node('fra-1', { location: { region: 'eu-central', country: 'DE' } })] }, auth);
        x = await post({ source: 'oregon', nodes: [node('oregon-1')] }, auth);
        assert.strictEqual(x.headers.get('x-nodes-marked-down'), '1');
        const all = (await get()).body.nodes;
        assert.deepStrictEqual(all.map((n) => [n.id, n.health.status]), [['fra-1', 'up'], ['oregon-1', 'up'], ['oregon-2', 'down']]);
        assert.ok(validate('network.node-list-result@1', { nodes: all, generated_at: new Date().toISOString() }).valid, 'a down node still matches the contract');

        const b = await fetch(`${base}/api/v1/nodes/oregon-1/beacon`);
        assert.deepStrictEqual([b.status, b.headers.get('cache-control'), b.headers.get('timing-allow-origin')], [204, 'no-store', '*']);
        console.log('nodes: all tests passed');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
