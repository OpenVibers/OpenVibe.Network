'use strict';
// Confirmation decision events (plan T2 WS-Z2 slice 9, docs/t2-projects-and-grants.md section 5;
// server/developer/confirmations.js): every transition — created, approved, denied, used, cancelled (by the service
// or a cascade) and expired (lazily at a decision, or by the sweep) — writes one network.confirmation.changed@1
// envelope with its audit row, in the transaction of the change, into the Events outbox. Each change is emitted once:
// a second sweep, a repeated cancel and a refused transition write nothing. Payloads validate against the v0.90.0
// schema and never carry the summary, details, request digest or a label. An approved but expired confirmation
// cannot be cancelled (409 confirmation.not_pending) and stays as it was.
//   node test/confirmation-events.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const relay = require('../server/developer/event-relay');
const confirmations = require('../server/developer/confirmations');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (10, 'owner', 'x', 'user'), (14, 'staff', 'x', 'admin')`).run();
const owner = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 10').get());

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { sandboxAllowance: '' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);
const U = { owner: jwt.sign({ sub: 10, id: 10 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' }), staff: jwt.sign({ sub: 14, id: 14 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' }) };

(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: { authorization: `Bearer ${U[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    const ok = (r, status = 200) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); return r.body; };
    const quiet = { log() {}, warn() {} };
    const outbox = await relay.startRelay(db, { eventsUrl: 'http://127.0.0.1:1', privateKey: keys.privateKey, issuer: ISSUER, autoStart: false, log: quiet });
    try {
        const P = ok(await api('owner', 'POST', '', { name: 'Confirmation events' }), 201).id;
        ok(await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' }));
        ok(await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.delete'] }));
        const PR = ok(await api('owner', 'POST', `/${P}/apps`, { name: 'Bot', environment: 'production' }), 201).id;
        ok(await api('owner', 'POST', `/${P}/apps/${PR}/grants`, { capability: 'media.object.delete' }), 201);
        const A = ok(await api('owner', 'POST', `/${P}/agents`, { name: 'Helper', host: { type: 'app', id: PR } }), 201).id;
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/grants/media.object.delete`, {}));

        const D = crypto.createHash('sha256').update('DELETE /v1/objects/obj_1').digest('hex');
        const SUMMARY = 'Delete the photo "beach-secret.jpg"';
        const ask = (extra = {}) => confirmations.create(db, { agentId: A, capability: 'media.object.delete', audience: 'openvibe.media', summary: SUMMARY,
            details: { note: 'private-detail-text' }, requestDigest: D, sessionId: 'session-0001', ...extra });
        const actor = { subject: owner, label: `user:${owner}` };
        const decide = (c, action, body = {}) => confirmations.decide(db, actor, c.id, action, body);
        const spend = (c) => confirmations.consume(db, { id: c.id, audience: 'openvibe.media', requestDigest: D });
        const cancel = (c) => confirmations.cancel(db, { id: c.id, audience: 'openvibe.media' });
        const rejects = (p, status, code) => assert.rejects(p, (e) => { assert.deepStrictEqual([e.status, e.code], [status, code], e.message); return true; });
        const past = (c) => db.prepare("UPDATE dev_confirmations SET expires_at = '2001-01-01T00:00:00.000Z' WHERE id = ?").run(c.id);
        const envelopes = async (c) => (await db.prepare("SELECT event FROM dev_audit WHERE event_type = 'network.confirmation.changed' AND target = ? ORDER BY id").all(`confirmation:${c.id}`)).map((r) => JSON.parse(r.event));
        const changes = async (c) => (await envelopes(c)).map((e) => [e.payload.change, e.payload.state]);

        // created → approved → used, each once, each a valid payload in a valid envelope.
        const c1 = await ask();
        assert.deepStrictEqual(await changes(c1), [['created', 'pending']]);
        await decide(c1, 'approve');
        await rejects(decide(c1, 'approve'), 409, 'confirmation.not_pending');
        await spend(c1);
        await rejects(spend(c1), 409, 'confirmation.used');
        assert.deepStrictEqual(await changes(c1), [['created', 'pending'], ['approved', 'approved'], ['used', 'approved']]);
        const [created, approved, used] = await envelopes(c1);
        assert.deepStrictEqual(Object.keys(created.payload).sort(), ['agent_id', 'audience', 'capability', 'change', 'changed_at', 'confirmation_id', 'expires_at', 'project_id', 'state']);
        assert.deepStrictEqual(created.payload, { ...created.payload, confirmation_id: c1.id, agent_id: A, project_id: P, capability: 'media.object.delete', audience: 'openvibe.media' });
        assert.strictEqual(approved.payload.standing_rule, 'once');
        assert.ok(!('expires_at' in used.payload));
        assert.deepStrictEqual([created.actor, approved.actor, used.actor], [{ type: 'system', id: 'network' }, { type: 'user', id: owner }, { type: 'system', id: 'network' }]);
        for (const e of [created, approved, used]) {
            assert.deepStrictEqual([e.event_type, e.version, e.source, e.visibility, e.subject, e.on_behalf_of], ['network.confirmation.changed', 1, 'network', 'internal', { type: 'confirmation', id: c1.id }, { type: 'user', id: owner }]);
            assert.ok(validate('events.event-envelope@1', e).valid);
            const v = validate('network.confirmation.changed@1', e.payload);
            assert.ok(v.valid, JSON.stringify(v.errors));
            const text = JSON.stringify(e);
            for (const s of [SUMMARY, 'private-detail-text', D, 'session-0001', `user:${owner}`]) assert.ok(!text.includes(s), `never ${s}`);
        }

        // denied
        const c2 = await ask();
        await decide(c2, 'deny');
        await rejects(decide(c2, 'deny'), 409, 'confirmation.not_pending');
        assert.deepStrictEqual(await changes(c2), [['created', 'pending'], ['denied', 'denied']]);
        assert.deepStrictEqual((await envelopes(c2))[1].actor, { type: 'user', id: owner });

        // cancelled by the service: again is a no-op, and emits nothing
        const c3 = await ask();
        await cancel(c3);
        await cancel(c3);
        assert.deepStrictEqual(await changes(c3), [['created', 'pending'], ['cancelled', 'cancelled']]);
        assert.strictEqual((await envelopes(c3))[1].payload.cancel_reason, 'service');

        // expired by the sweep, once however often it runs; a decision afterwards changes nothing
        const c4 = await ask();
        await past(c4);
        assert.ok(await confirmations.expireDue(db) >= 1);
        assert.strictEqual(await confirmations.expireDue(db), 0);
        await rejects(decide(c4, 'approve'), 409, 'confirmation.not_pending');
        assert.deepStrictEqual(await changes(c4), [['created', 'pending'], ['expired', 'expired']]);

        // expired lazily at a decision, then the sweep finds nothing more
        const c5 = await ask();
        await past(c5);
        await rejects(decide(c5, 'approve'), 409, 'confirmation.expired');
        assert.strictEqual(await confirmations.expireDue(db), 0);
        assert.deepStrictEqual(await changes(c5), [['created', 'pending'], ['expired', 'expired']]);

        // An approved but unused confirmation past expires_at: cancel is 409 confirmation.not_pending, the row stays
        // approved and nothing is emitted; the sweep leaves it alone.
        const c6 = await ask();
        await decide(c6, 'approve');
        await past(c6);
        await rejects(cancel(c6), 409, 'confirmation.not_pending');
        assert.strictEqual(await confirmations.expireDue(db), 0);
        const r6 = await db.prepare('SELECT state, cancel_reason, used_at FROM dev_confirmations WHERE id = ?').get(c6.id);
        assert.deepStrictEqual([r6.state, r6.cancel_reason, r6.used_at], ['approved', null, null]);
        assert.strictEqual((await confirmations.read(db, { id: c6.id, audience: 'openvibe.media' })).confirmation.state, 'expired');
        assert.deepStrictEqual(await changes(c6), [['created', 'pending'], ['approved', 'approved']]);

        // A standing rule: the approval names it; the next request is one `created` event, approved, with its rule_id.
        const c7 = await ask();
        const { rule } = await decide(c7, 'approve', { standing_rule: 'session' });
        assert.deepStrictEqual([(await envelopes(c7))[1].payload.standing_rule, (await envelopes(c7))[1].payload.rule_id], ['session', rule.id]);
        const c8 = await ask();
        assert.strictEqual(c8.state, 'approved');
        const e8 = await envelopes(c8);
        assert.deepStrictEqual(e8.map((e) => [e.payload.change, e.payload.state, e.payload.rule_id]), [['created', 'approved', rule.id]]);
        assert.deepStrictEqual(e8[0].actor, { type: 'system', id: 'network' });

        // A cascade (pausing the agent) cancels the pending and approved-unused ones, one event each, with the cause.
        const c9 = await confirmations.create(db, { agentId: A, capability: 'media.object.delete', audience: 'openvibe.media', summary: SUMMARY, requestDigest: D });
        ok(await api('owner', 'POST', `/${P}/agents/${A}/pause`));
        await api('owner', 'POST', `/${P}/agents/${A}/pause`);   // again: nothing more to cancel
        for (const c of [c8, c9]) {
            const e = await envelopes(c);
            assert.deepStrictEqual(e.slice(-1).map((x) => [x.payload.change, x.payload.state, x.payload.cancel_reason, x.actor.type]), [['cancelled', 'cancelled', 'agent_paused', 'system']]);
            assert.strictEqual(e.filter((x) => x.payload.change === 'cancelled').length, 1);
        }
        for (const c of [c1, c2, c4, c5, c6]) assert.ok(!(await changes(c)).some(([ch]) => ch === 'cancelled'), 'spent, decided and expired rows are left alone');

        // Every event is in the outbox, written in the transaction of its change.
        const all = (await db.prepare("SELECT event FROM dev_audit WHERE event_type = 'network.confirmation.changed' ORDER BY id").all()).map((r) => JSON.parse(r.event).event_id);
        const queued = (await db.prepare(`SELECT event_id FROM ${relay.TABLE}`).all()).map((r) => r.event_id);
        assert.ok(all.length >= 20, `${all.length} events`);
        for (const id of all) assert.ok(queued.includes(id), `outbox has ${id}`);
        assert.ok(await outbox.pending() >= all.length);
        console.log('confirmation-events: all tests passed');
    } finally {
        await relay.stopRelay(db);
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
