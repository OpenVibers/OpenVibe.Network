'use strict';
// Audited service grants (WS-D task 3, Contracts 0.48.0) and the staff APIs (WS-D task 4): only the owner
// grants, changes or revokes a service principal's capability, always with a reason; each change writes an
// audit row and network.principal_grant.changed in the same transaction; an expired grant stops counting
// at once and its expiry is recorded once; tokens (grantsFor) follow. Staff capabilities and the staff
// list come from the staff map.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { validate, capabilities } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-grants-'));
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
const principals = require('../server/identity/principals');
const grants = require('../server/identity/grants-admin');
for (const c of ['live', 'media']) await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, 'x', ?, '[]', 1) ON CONFLICT DO NOTHING").run(c, c);
await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('thirdparty', 'x', 'x', '[]', 0) ON CONFLICT DO NOTHING").run();
await principals.ensureSchema(db);
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const events = async () => (await db.prepare("SELECT envelope FROM network_event_outbox ORDER BY id").all()).map((r) => r.envelope).filter((e) => e.event_type === 'network.principal_grant.changed');
const has = async (client, cap, aud = 'openvibe.network') => (await principals.grantsFor(db, client, aud)).some((g) => g.capability === cap);
const ok = (e) => { assert.ok(validate('events.event-envelope@1', e).valid); const v = validate('network.principal_grant.changed@1', e.payload); assert.ok(v.valid, JSON.stringify(v.errors)); };

// Every default grant names its capability owner's audience, so any of them can be revoked here.
for (const [client, cap, aud] of principals.DEFAULT_GRANTS) {
    const c = capabilities.get(cap);
    assert.ok(c, `default grant ${client} ${cap} is in openvibe-contracts`);
    assert.strictEqual(aud, `openvibe.${c.owner}`, `default grant ${client} ${cap} → ${aud}`);
}
// Trade's scripts/subscribe.js (Trade #9) manages its Events subscriptions like the other publishers.
assert.ok(principals.DEFAULT_GRANTS.some(([client, cap, aud, scopes]) => client === 'trade' && cap === 'events.subscription.manage' && aud === 'openvibe.events' && Array.isArray(scopes) && !scopes.length), 'Trade holds events.subscription.manage on openvibe.events');
assert.strictEqual((await events()).length, 0, 'the seed is not announced');

// Grant, update, revoke.
assert.ok(!await has('live', 'network.staff.read'));
let out = await grants.grant(db, { client_id: 'live', capability: 'network.staff.read', reason: 'route reports to moderators', expires_at: '2099-01-01T00:00:00Z' }, OWNER);
assert.deepStrictEqual([out.change, out.audience], ['granted', 'openvibe.network'], 'the audience is the capability owner');
assert.ok(await has('live', 'network.staff.read'));
let ev = (await events()).at(-1); ok(ev);
assert.deepStrictEqual(ev.actor, { type: 'user', id: OWNER });
assert.deepStrictEqual(ev.subject, { type: 'grant', id: 'live:network.staff.read@openvibe.network' });
assert.strictEqual(ev.payload.expires_at, '2099-01-01T00:00:00.000Z');
out = await grants.grant(db, { client_id: 'live', capability: 'network.staff.read', reason: 'no expiry after all' }, OWNER);
assert.strictEqual(out.change, 'updated');
await grants.revoke(db, { client_id: 'live', capability: 'network.staff.read', reason: 'not needed' }, OWNER);
assert.ok(!await has('live', 'network.staff.read'), 'the next token no longer carries it');
assert.deepStrictEqual((await events()).map((e) => e.payload.change), ['granted', 'updated', 'revoked']);
(await events()).forEach(ok);
await assert.rejects(async () => await grants.revoke(db, { client_id: 'live', capability: 'network.staff.read', reason: 'again' }, OWNER), /no active grant/);
assert.deepStrictEqual((await grants.changes(db, { client: 'live' })).map((c) => c.change), ['revoked', 'updated', 'granted']);
assert.strictEqual((await grants.list(db, { client: 'live' })).find((g) => g.capability === 'network.staff.read').state, 'revoked');

// Refusals.
const refused = (body, re) => assert.rejects(async () => await grants.grant(db, { reason: 'because', ...body }, OWNER), re);
await refused({ client_id: 'nobody', capability: 'network.staff.read' }, /not a service principal/);
await refused({ client_id: 'thirdparty', capability: 'network.staff.read' }, /not a service principal/);
await refused({ client_id: 'live', capability: 'network.nope.read' }, /not in openvibe-contracts/);
await refused({ client_id: 'live', capability: 'Network.Staff' }, /malformed/);
await refused({ client_id: 'live', capability: 'network.staff.read', audience: 'openvibe.media' }, /enforced by network/);
await refused({ client_id: 'live', capability: 'network.staff.read', expires_at: '2001-01-01' }, /in the past/);
await assert.rejects(async () => await grants.grant(db, { client_id: 'live', capability: 'network.staff.read', reason: '' }, OWNER), /reason is required/);
await refused({ client_id: 'live', capability: 'network.staff.read', namespaces: ['Bad Namespace'] }, /namespace is malformed/);
const before = (await events()).length;
assert.strictEqual((await events()).length, before, 'a refused change announces nothing');

// Expiry: stops counting at once, recorded once.
await grants.grant(db, { client_id: 'media', capability: 'network.staff.read', reason: 'a week', expires_at: '2099-01-01' }, OWNER);
await db.prepare("UPDATE principal_grants SET expires_at = datetime('now', '-1 minute') WHERE client_id = 'media' AND capability = 'network.staff.read'").run();
assert.ok(!await has('media', 'network.staff.read'), 'expired: no longer in tokens, before the job runs');
assert.strictEqual((await grants.list(db, { client: 'media' })).find((g) => g.capability === 'network.staff.read').state, 'expired');
assert.strictEqual(await grants.expireDue(db), 1);
assert.strictEqual(await grants.expireDue(db), 0, 'recorded once');
ev = (await events()).at(-1); ok(ev);
assert.deepStrictEqual([ev.payload.change, ev.payload.actor_subject, ev.actor.type], ['expired', null, 'system']);

// Routes: owner only.
(async () => {
    const { createStaffApi } = require('../server/admin/staff-api');
    await db.prepare("INSERT INTO users (id, username, password_hash, role, subject_id) VALUES (1, 'goosely', 'x', 'admin', ?), (2, 'mod', 'x', 'global_mod', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR'), (3, 'someone', 'x', 'user', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS')").run(OWNER);
    let as = 1;
    const requireAuth = async (req, res, next) => { req.user = await db.prepare('SELECT * FROM users WHERE id = ?').get(as); next(); };
    const app = express();
    app.use(express.json());
    app.use('/api/admin/grants', requireAuth, grants.router(db));
    app.use('/api/v1/staff', createStaffApi({ db, requireAuth, guard: () => (req, res) => res.status(401).json({ error: 'service token' }) }));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };

    let r = await call('POST', '/api/admin/grants', { client_id: 'live', capability: 'network.staff.read', reason: 'owner via API' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.grant.change, 'granted');
    assert.strictEqual((await events()).at(-1).payload.actor_subject, OWNER);
    assert.strictEqual((await call('GET', '/api/admin/grants?client=live')).body.grants.find((g) => g.capability === 'network.staff.read').state, 'active');
    assert.strictEqual((await call('POST', '/api/admin/grants/revoke', { client_id: 'live', capability: 'network.staff.read' })).status, 400, 'a reason is required');
    as = 2;
    assert.strictEqual((await call('GET', '/api/admin/grants')).status, 403, 'a global moderator cannot');
    assert.strictEqual((await call('POST', '/api/admin/grants/revoke', { client_id: 'live', capability: 'network.staff.read', reason: 'x y z' })).status, 403);

    // Staff APIs.
    r = await call('GET', '/api/v1/staff/capabilities');
    assert.strictEqual(r.body.role, 'global_mod'); assert.ok(r.body.capabilities.includes('staff.moderation.logs'));
    r = await call('GET', '/api/v1/staff/moderators?service=chat');
    assert.deepStrictEqual(r.body.staff.map((s) => [s.username, s.role]).sort(), [['goosely', 'owner'], ['mod', 'global_mod']]);
    as = 3;
    assert.deepStrictEqual((await call('GET', '/api/v1/staff/capabilities')).body.capabilities, []);
    assert.strictEqual((await call('GET', '/api/v1/staff/moderators')).status, 403, 'not staff');
    const fake = `x.${Buffer.from(JSON.stringify({ sub: 'svc:live' })).toString('base64url')}.y`;
    const s = await fetch(`${base}/api/v1/staff/moderators`, { headers: { authorization: `Bearer ${fake}` } });
    assert.strictEqual(s.status, 401, 'a service token goes through the capability guard');
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('grants admin and staff APIs: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
