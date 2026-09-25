'use strict';
// The Events delivery operator view (WS-F task 3): owner-only; Network signs a 5-minute token with
// events.delivery.admin for openvibe.events; the dead-letter list passes through; a replay needs a
// subscription and exactly one of event_ids or from_seq, reaches Events, and is audited.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { initDb } = require('../server/db/database');
const { createEventsOps } = require('../server/admin/events-ops');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-eventsops-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'goosely', 'x', 'admin'), (2, 'adminb', 'x', 'admin')").run();
const SUB = 'sub_01M3D4CMQ6JX9ZR8SS34M1FTC4', EVT = 'evt_01M3D4GT16WXDXGZYRE97JRTKS';

(async () => {
    const seen = [];
    const events = express();
    events.use(express.json());
    events.use((req, res, next) => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: req.body }); next(); });
    events.get('/api/v1/deliveries', (req, res) => res.json({ deliveries: [{ event_id: EVT, subscription_id: SUB, seq: 9, status: 'dead', attempt: 8, last_status: 500, last_error: 'boom' }], counts: { dead: 1 } }));
    events.post('/api/v1/deliveries/replay', (req, res) => res.json({ subscription_id: req.body.subscription_id, queued: (req.body.event_ids || [1]).length }));
    const ev = await new Promise((r) => { const s = events.listen(0, '127.0.0.1', () => r(s)); });

    let as = 1;
    const app = express();
    app.use((req, res, next) => { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(as); next(); });
    app.use('/api/admin/events', createEventsOps({ db, eventsUrl: `http://127.0.0.1:${ev.address().port}`, privateKey, issuer: 'https://openvibe.network' }));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };

    let r = await call('GET', '/api/admin/events/deliveries');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.deliveries.map((d) => d.event_id), [EVT]);
    assert.ok(seen[0].url.startsWith('/api/v1/deliveries?status=dead'));
    const claims = JSON.parse(Buffer.from(seen[0].auth.split('.')[1], 'base64url').toString());
    assert.deepStrictEqual([claims.sub, claims.aud, claims.cap], ['svc:network', ['openvibe.events'], ['events.delivery.admin']]);
    assert.ok(claims.exp - claims.iat <= 300);
    assert.ok(require('jsonwebtoken').verify(seen[0].auth.slice(7), publicKey, { algorithms: ['RS256'] }), 'signed with Network\'s key');

    assert.strictEqual((await call('POST', '/api/admin/events/replay', { subscription_id: SUB })).status, 400, 'event_ids or from_seq');
    assert.strictEqual((await call('POST', '/api/admin/events/replay', { subscription_id: SUB, event_ids: [EVT], from_seq: 1 })).status, 400, 'not both');
    assert.strictEqual((await call('POST', '/api/admin/events/replay', { subscription_id: SUB, event_ids: ['nope'] })).status, 400);
    r = await call('POST', '/api/admin/events/replay', { subscription_id: SUB, event_ids: [EVT] });
    assert.deepStrictEqual(r.body, { ok: true, queued: 1 });
    assert.deepStrictEqual(seen.at(-1).body, { subscription_id: SUB, event_ids: [EVT] });
    const audit = db.prepare("SELECT user_id, details FROM audit_log WHERE action = 'events_replay'").all();
    assert.strictEqual(audit.length, 1); assert.strictEqual(audit[0].user_id, 1);
    assert.deepStrictEqual(JSON.parse(audit[0].details).event_ids, [EVT]);

    as = 2;
    const n = seen.length;
    assert.strictEqual((await call('GET', '/api/admin/events/deliveries')).status, 403, 'another admin is not the owner');
    assert.strictEqual(seen.length, n, 'and nothing reached Events');

    srv.close(); ev.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('events ops: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
