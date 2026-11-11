'use strict';
// A paired machine, not a signed-in person, answers the requests addressed to it, ends a grant it is part of and
// reads the person's agent directory (Link holds a node token). The routes must refuse another machine's request,
// another machine's grant and show only the owner's agents.
//   node test/link-access-node-self.test.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const access = require('../server/link/access');
const agents = require('../server/link/agents');

(async () => {
    const db = getDb(), owner = `usr_${ids.ulid()}`, other = `usr_${ids.ulid()}`;
    for (const [subject, name] of [[owner, 'alex'], [other, 'sam']]) {
        await db.prepare(`INSERT INTO users (username, email, password_hash, role, subject_id)
            SELECT ?, ?, 'x', 'user', ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE subject_id = ?)`)
            .run(name, `${name}-${subject.slice(-8)}@example.test`, subject, subject);
    }
    const node = async (who) => {
        const principal = `lnk_${ids.ulid()}`;
        await db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, trust, owner_subject, credential_hash, created_by)
            VALUES (?, ?, 'wnam-1', 'user', 'community', ?, ?, ?)`)
            .run(principal, `n-${ids.ulid().toLowerCase()}`, who, crypto.createHash('sha256').update(principal).digest('hex'), who);
        return { id: principal, owner_subject: who };
    };
    const a = await node(owner), b = await node(other), c = await node(owner);

    const machines = { a, b, c };
    const app = express();
    app.locals.db = db;
    app.locals.privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
    app.locals.config = { jwt: { issuer: 'https://openvibe.network' } };
    app.use('/api/v1/link/self', access.routers({
        requireAuth: (req, res, next) => next(),
        nodeGuard: (req, res, next) => {
            const m = machines[String(req.headers['x-machine'] || '')];
            if (!m) return res.status(401).json({ code: 'link_access.machine_required' });
            req.principal = { sub: `link:${m.id}` };
            next();
        },
        relayGuard: (req, res, next) => next(),
    }).self);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, machine, body) => {
        const r = await fetch(base + path, {
            method, headers: { 'x-machine': machine, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    try {
        // Another machine of the same owner cannot settle a request addressed to this one.
        const forC = await access.ask(db, a, { to_principal: c.id, scopes: ['agent'], duration_seconds: 600 });
        const wrongMachine = await call('POST', `/api/v1/link/self/access-requests/${forC.id}/answer`, 'a', { approve: true });
        assert.deepEqual([wrongMachine.status, wrongMachine.body.code], [404, 'link_access.request_not_found']);
        const answered = await call('POST', `/api/v1/link/self/access-requests/${forC.id}/answer`, 'c', { approve: true, scopes: ['agent'] });
        assert.equal(answered.status, 200);
        assert.equal(answered.body.request.status, 'approved');
        assert.equal(answered.body.grant.to_principal, c.id);

        // Either machine in a grant ends it; a machine outside it cannot.
        const outsider = await call('POST', `/api/v1/link/self/access-grants/${answered.body.grant.id}/revoke`, 'b');
        assert.deepEqual([outsider.status, outsider.body.code], [404, 'link_access.grant_not_found']);
        const revoked = await call('POST', `/api/v1/link/self/access-grants/${answered.body.grant.id}/revoke`, 'a');
        assert.equal(revoked.status, 200);
        assert.ok(revoked.body.grant.revoked_at);
        assert.equal(await access.liveGrant(db, answered.body.grant.id), null);

        // The directory is the person's, seen from any of their paired machines, and no one else's.
        await access.putSettings(db, c.id, owner, { agents_talk: true });
        await access.putSettings(db, b.id, other, { agents_talk: true });
        const local = await agents.register(db, { type: 'node', id: c.id, owner }, { kind: 'link-local', name: 'Codex', skills: ['code'], status: 'online' });
        const foreign = await agents.register(db, { type: 'node', id: b.id, owner: other }, { kind: 'link-local', name: 'Muse', skills: [], status: 'online' });
        const mine = await call('GET', '/api/v1/link/self/agents', 'a');
        assert.equal(mine.status, 200);
        assert.ok(mine.body.agents.some((agent) => agent.id === local.id && agent.machine_id === c.id));
        assert.ok(!mine.body.agents.some((agent) => agent.id === foreign.id));
        const theirs = await call('GET', '/api/v1/link/self/agents', 'b');
        assert.ok(!theirs.body.agents.some((agent) => agent.id === local.id));
        console.log('link access machine self: answer, revoke and the agent directory are scoped to the paired machine');
    } finally {
        await new Promise((r) => server.close(r));
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
