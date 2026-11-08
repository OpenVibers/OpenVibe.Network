'use strict';
// Link Send relays opaque Locker envelopes only between an owner's own machines.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const { router } = require('../server/node/send-relay');
const locker = require('openvibe-sdk/locker');

(async () => {
    const db = getDb();
    const alice = `usr_${ids.ulid()}`, bob = `usr_${ids.ulid()}`;
    await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id) VALUES
        (9311, 'sendalice', 'Alice', 'x', ?), (9312, 'sendbob', 'Bob', 'x', ?)`).run(alice, bob);
    const node = async (principal, owner, n) => db.prepare(`INSERT INTO platform_node_principals
        (id, node_id, home_cell, owner_kind, trust, owner_subject, credential_hash, created_by)
        VALUES (?, ?, 'wnam-1', 'user', 'community', ?, ?, ?)`).run(principal, `send-${n}`, owner, `${n}`.padStart(64, '0'), owner);
    const [from, target, stranger] = [`nod_${ids.ulid()}`, `nod_${ids.ulid()}`, `nod_${ids.ulid()}`];
    await node(from, alice, 1); await node(target, alice, 2); await node(stranger, bob, 3);
    const tokens = new Map([['from', from], ['target', target], ['stranger', stranger]]);
    const send = router({ nodeGuard: (req, res, next) => {
        const principal = tokens.get(req.headers.authorization);
        if (!principal) return res.status(401).end();
        req.principal = { sub: `node:${principal}` }; next();
    }, requireAuth: (_req, _res, next) => next() });
    const app = express(); app.use(express.json({ limit: '40mb' })); Object.assign(app.locals, { db });
    app.use('/send', send.self);
    const server = http.createServer(app);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}/send`;
    const call = (url, token, method = 'GET', body) => fetch(base + url, {
        method, headers: { authorization: token, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    try {
        const recipient = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const publicKey = recipient.publicKey.export({ format: 'jwk' });
        let res = await call('/key', 'target', 'PUT', { public_key: publicKey });
        assert.equal(res.status, 200, 'the target machine publishes its own receive key');
        assert.equal((await res.json()).key_thumbprint, await locker.jwkThumbprint(publicKey), 'Network registers the SDK Locker thumbprint');
        res = await call('/targets', 'from');
        assert.equal(res.status, 200);
        assert.deepEqual((await res.json()).machines[0].public_key, { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y });
        const subject = { type: 'node', id: target };
        const sealed = await locker.seal(new TextEncoder().encode('Locker round trip'), {
            lock: 'people', keys: [{ subject, publicKey }],
        });
        const envelope = Buffer.from(sealed.bytes).toString('base64');
        res = await call('/', 'from', 'POST', { target_node: stranger, envelope });
        assert.equal(res.status, 404, 'a sender cannot address another owner\'s machine');
        res = await call('/', 'from', 'POST', { target_node: from, envelope });
        assert.equal(res.status, 404, 'a machine cannot send to itself');
        res = await call('/', 'from', 'POST', { target_node: target, envelope });
        assert.equal(res.status, 201);
        const created = await res.json();
        res = await call('/inbox', 'target');
        assert.equal(res.status, 200);
        const inbox = await res.json();
        assert.equal(inbox.items.length, 1);
        assert.equal(inbox.items[0].envelope, envelope, 'the relay preserves the opaque ciphertext');
        res = await call(`/${created.id}/accept`, 'stranger', 'POST');
        assert.equal(res.status, 404, 'another machine cannot accept the recipient\'s item');
        res = await call(`/${created.id}/accept`, 'target', 'POST');
        assert.equal(res.status, 200);
        const delivered = await res.json();
        assert.equal(delivered.envelope, envelope);
        const opened = await locker.open(Buffer.from(delivered.envelope, 'base64'), {
            privateKey: recipient.privateKey.export({ format: 'jwk' }), subject,
        });
        assert.equal(new TextDecoder().decode(opened), 'Locker round trip', 'only the target private key opens the relay payload');
        assert.equal((await (await call('/inbox', 'target')).json()).items.length, 1, 'accept keeps the ciphertext until the receiver finishes opening it');
        res = await call(`/${created.id}/accept`, 'target', 'POST');
        assert.equal(res.status, 200, 'a receiver can retry an interrupted download before completion');
        assert.equal((await res.json()).envelope, envelope);
        res = await call(`/${created.id}/complete`, 'target', 'POST');
        assert.equal(res.status, 204);
        assert.equal((await (await call('/inbox', 'target')).json()).items.length, 0);
    } finally { await new Promise((ok) => server.close(ok)); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
