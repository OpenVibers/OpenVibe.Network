'use strict';
// Incidents and maintenance on /status (roadmap WS-N task 12; Contracts 0.66.0): Host's token or a staff admin
// opens and updates them; others cannot; states follow the kind; closed ones refuse updates; the public list
// and /status show them.
//   node test/status-incidents.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-incidents-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
require('../server/identity/principals').ensureSchema(db);
for (const c of ['host', 'live']) db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(`${c}-secret`, c);
db.prepare("INSERT INTO users (id, username, password_hash, subject_id, role) VALUES (1, 'boss', 'x', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA', 'admin'), (2, 'pat', 'x', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB', 'user')").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const app = express();
app.use(require('cookie-parser')());
app.use(express.urlencoded({ extended: true }));
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/v1/status/incidents', require('../server/status/incidents').router({ requireAuth, incidentGuard: require('../server/identity/principals').guard('network.status.incident', { legacy: false }) }));
const ecosystem = { current: () => [], lastPollAt: () => null, pollMs: 60000, releaseHealthSince: () => null };
app.use(require('../server/status/routes').createStatusRoutes({ ecosystem }));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, text: await r.clone().text(), body: await r.json().catch(() => null) }));
    const svc = async (client) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: `${client}-secret`, audience: 'openvibe.network' }) })).json()).access_token;
    const as = (id) => ({ authorization: `Bearer ${signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config)}` });
    try {
        const host = { authorization: `Bearer ${await svc('host')}` };
        // Who may write.
        const open = { kind: 'incident', title: 'Live streams stall on start', severity: 'major', services: ['live'], message: 'New streams take a minute to start.' };
        assert.ok([401, 403].includes((await call('POST', '/api/v1/status/incidents', { body: open })).status), 'nobody');
        assert.strictEqual((await call('POST', '/api/v1/status/incidents', { body: open, headers: as(2) })).status, 403, 'a person who is not staff');
        assert.strictEqual((await call('POST', '/api/v1/status/incidents', { body: open, headers: { authorization: `Bearer ${await svc('live')}` } })).status, 403, 'a service without network.status.incident');
        let r = await call('POST', '/api/v1/status/incidents', { body: open, headers: host });
        assert.strictEqual(r.status, 201, r.text);
        assert.ok(validate('network.status-incident@1', r.body).valid, JSON.stringify(validate('network.status-incident@1', r.body).errors));
        assert.deepStrictEqual([r.body.state, r.body.severity, r.body.updates.length], ['investigating', 'major', 1]);
        const inc = r.body.id;
        assert.match(inc, /^inc_[0-9A-HJKMNP-TV-Z]{26}$/);

        // A staff admin updates it through its states; closed refuses more.
        r = await call('POST', `/api/v1/status/incidents/${inc}/updates`, { body: { state: 'identified', message: 'A restart left the ingest socket unbound.' }, headers: as(1) });
        assert.deepStrictEqual([r.status, r.body.state, r.body.updates.length], [200, 'identified', 2]);
        assert.strictEqual((await call('POST', `/api/v1/status/incidents/${inc}/updates`, { body: { state: 'completed', message: 'x' }, headers: host })).status, 400, 'a maintenance state on an incident');
        assert.strictEqual((await call('POST', `/api/v1/status/incidents/${inc}/updates`, { body: { state: 'resolved', message: 'ok', title: 'renamed' }, headers: host })).status, 400, 'the request contract');

        // A maintenance window.
        r = await call('POST', '/api/v1/status/incidents', { body: { kind: 'maintenance', title: 'Media storage move', services: ['media'], message: 'Uploads pause for up to an hour.', starts_at: '2026-09-28T03:00:00Z', ends_at: '2026-09-28T04:00:00Z' }, headers: host });
        assert.deepStrictEqual([r.status, r.body.state, r.body.ends_at], [201, 'scheduled', '2026-09-28T04:00:00.000Z']);
        const win = r.body.id;
        assert.strictEqual((await call('POST', '/api/v1/status/incidents', { body: { kind: 'maintenance', title: 'Backwards', services: ['media'], message: 'x', starts_at: '2026-09-28T04:00:00Z', ends_at: '2026-09-28T03:00:00Z' }, headers: host })).status, 400);
        assert.strictEqual((await call('POST', '/api/v1/status/incidents', { body: { kind: 'maintenance', severity: 'major', title: 'Sev', services: ['media'], message: 'x' }, headers: host })).status, 400, 'maintenance has no severity');

        // Public list and /status.
        r = await call('GET', '/api/v1/status/incidents');
        assert.strictEqual(r.status, 200);
        assert.ok(validate('network.status-incident-list@1', r.body).valid);
        assert.deepStrictEqual(r.body.active.map((i) => i.id).sort(), [inc, win].sort());
        r = await call('GET', '/status');
        assert.match(r.text, /Incidents and maintenance/);
        assert.match(r.text, /Live streams stall on start/);
        assert.match(r.text, /Identified/);
        assert.match(r.text, /A restart left the ingest socket unbound\./);

        // Resolve: closed, out of active, in recent; further updates refused.
        r = await call('POST', `/api/v1/status/incidents/${inc}/updates`, { body: { state: 'resolved', message: 'Rebound; streams start at once again.' }, headers: host });
        assert.deepStrictEqual([r.status, r.body.state, typeof r.body.ends_at], [200, 'resolved', 'string']);
        assert.strictEqual((await call('POST', `/api/v1/status/incidents/${inc}/updates`, { body: { state: 'monitoring', message: 'again' }, headers: host })).status, 409);
        r = await call('GET', '/api/v1/status/incidents');
        assert.deepStrictEqual([r.body.active.map((i) => i.id), r.body.recent.map((i) => i.id)], [[win], [inc]]);
        assert.strictEqual((await call('POST', '/api/v1/status/incidents/inc_01JAB2C3D4E5F6G7H8J9K0MNPQ/updates', { body: { state: 'resolved', message: 'x' }, headers: host })).status, 404);
        await call('POST', `/api/v1/status/incidents/${win}/updates`, { body: { state: 'completed', message: 'Done.' }, headers: host });
        assert.match((await call('GET', '/status')).text, /No open incidents or maintenance/);
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('status incidents: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
