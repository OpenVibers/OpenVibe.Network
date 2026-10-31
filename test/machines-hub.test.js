'use strict';
// The machines hub (plan L34, step M2): Network fronts Bot for a person, and for the apps that person consented
// to. What this proves:
//   - a person sees their own machines, and the hub calls Bot as them (X-OV-Subject);
//   - an app without the capability, or without the person's consent, is refused;
//   - rename, roles and revoke reach Bot as the person, and a role outside the catalogue never reaches it;
//   - a pairing code works once and expires;
//   - each change is published once: network.machine.roles_changed, .revoked, .paired, .online and .offline.
//   node --import ./test/helpers/pg-preload.mjs test/machines-hub.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { ids, serviceAuth } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const machines = require('../server/registry/machines');
const nodePrincipals = require('../server/registry/node-principals');

(async () => {
const db = getDb();
await principals.ensureSchema(db);

const keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };

const mk = async (name) => {
    const subject = `usr_${ids.ulid()}`;
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash, subject_id) VALUES (?, ?, ?, ?) RETURNING id')
        .run(name, `${name}@example.test`, 'x', subject)).lastInsertRowid;
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const ana = await mk('hubana');
const bob = await mk('hubbob');

// ── The fake Bot: the registry underneath. It answers per person, and it records every call. ──
const calls = [];
const owned = new Map();       // subject → [machine]
const machineOf = (id) => ({ id, name: 'garage-pi', kind: 'onboard', online: true, roles: [], running: [], node_id: null });
const botServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : null;
    const subject = req.headers['x-ov-subject'] || null;
    calls.push({ method: req.method, url: req.url, subject, body, auth: String(req.headers.authorization || '') });
    const answer = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const list = () => (owned.get(subject) || []).map(machineOf);
    if (req.method === 'GET' && req.url === '/api/v1/machines') return answer(200, { machines: list() });
    if (req.method === 'GET' && req.url.startsWith('/api/v1/machines/')) {
        const id = decodeURIComponent(req.url.slice('/api/v1/machines/'.length));
        const mine = list().find((m) => m.id === id);
        return mine ? answer(200, { machine: machineOf(id) }) : answer(404, { code: 'bot.device_not_found' });
    }
    if (req.method === 'POST' && req.url === '/api/v1/machines/pairings') {
        return answer(201, { pairing: { code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 600000).toISOString(), pairing_id: `pair_${ids.ulid()}`, installer: 'curl -fsSL https://openvibe.bot/install | sh -s -- --pairing pair_1 --code ABCD-EFGH --worker' } });
    }
    if (req.method === 'PATCH' && req.url.startsWith('/api/v1/machines/')) {
        const id = decodeURIComponent(req.url.slice('/api/v1/machines/'.length));
        const m = machineOf(id); m.name = body.name; return answer(200, { machine: m });
    }
    if (req.method === 'PUT' && req.url.endsWith('/roles')) {
        const id = decodeURIComponent(req.url.slice('/api/v1/machines/'.length, -'/roles'.length));
        const m = machineOf(id); m.roles = body.roles; return answer(200, { machine: m });
    }
    if (req.method === 'POST' && req.url.endsWith('/revoke')) {
        const id = decodeURIComponent(req.url.slice('/api/v1/machines/'.length, -'/revoke'.length));
        const m = machineOf(id); m.online = false; return answer(200, { machine: m });
    }
    answer(404, { code: 'bot.not_found' });
});
await new Promise((r) => botServer.listen(0, '127.0.0.1', r));
const botUrl = `http://127.0.0.1:${botServer.address().port}`;

const anaMachine = `dev_${ids.ulid()}`;
const bobMachine = `dev_${ids.ulid()}`;
owned.set(ana.subject_id, [anaMachine]);
owned.set(bob.subject_id, [bobMachine]);

const bot = machines.createBotClient({ baseUrl: botUrl, privateKey: keys.privateKey, issuer: config.jwt.issuer });

// ── The server under test: Network's own app, with the hub's routes on it. ──
const authRoutes = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const tokenOf = (u) => authRoutes.signToken(u, keys.privateKey, config);
const app = express();
app.use(express.json());
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/api/v1/machines', machines.routers({ bot, requireAuth, publicKey: keys.publicKey, issuer: config.jwt.issuer }).hub);
// Bot's report of a machine's state (network.node.manage, the capability Bot already holds).
app.use('/internal', machines.internalRouters({ guard: principals.guard('network.node.manage') }).internal);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, p, { user = null, token = null, body, headers = {} } = {}) => {
    const h = { 'content-type': 'application/json', ...(user ? { authorization: `Bearer ${tokenOf(user)}` } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
};
const outbox = async (type) => (await db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all())
    .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope))
    .filter((e) => e.event_type === type);

// An app: a developer app with a grant the person approved (the consent), and a token that names them.
const projectId = `prj_${ids.ulid()}`;
const appId = `app_${ids.ulid()}`;
await db.prepare('INSERT INTO dev_projects (id, owner_subject, name, environment_policy, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(projectId, ana.subject_id, 'Hub app', 'sandbox+production', new Date().toISOString(), ana.subject_id);
await db.prepare('INSERT INTO dev_apps (id, project_id, name, environment, oauth_client_id, client_type, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(appId, projectId, 'Hub app', 'production', `client_${ids.ulid()}`, 'confidential', new Date().toISOString(), ana.subject_id);
const grant = (capability, status) => db.prepare('INSERT INTO dev_grants (app_id, capability, audience, status, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(appId, capability, 'openvibe.network', status, ana.subject_id, new Date().toISOString());
const appToken = (capability, person = ana.subject_id) => serviceAuth.signServiceToken({
    iss: config.jwt.issuer, sub: `app:${appId}`, actor_type: 'app', aud: ['openvibe.network'], cap: [capability],
    project_id: projectId, env: 'production', on_behalf_of: person,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: `tok_${ids.ulid()}`,
}, keys.privateKey);
// A run token: a service token that acts for a person (Codes C3), holding the capability and naming them.
const runToken = (capability, person = ana.subject_id) => serviceAuth.signServiceToken({
    iss: config.jwt.issuer, sub: 'svc:codes', actor_type: 'service', aud: ['openvibe.network'], cap: [capability],
    on_behalf_of: person,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: `tok_${ids.ulid()}`,
}, keys.privateKey);

try {
    // ── A person sees their own machines, and the hub calls Bot as them. ──
    const mine = await call('GET', '/api/v1/machines', { user: ana });
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
    assert.deepStrictEqual(mine.body.machines.map((m) => m.id), [anaMachine]);
    assert.strictEqual(mine.body.machines[0].kind, 'onboard');
    assert.deepStrictEqual(mine.body.machines[0].roles, []);
    assert.deepStrictEqual(mine.body.machines[0].running, []);
    const last = calls[calls.length - 1];
    assert.strictEqual(last.subject, ana.subject_id, 'Bot is called as the person');
    assert.ok(String(last.auth).startsWith('Bearer '), 'the hub carries a service token');
    const theirs = await call('GET', '/api/v1/machines', { user: bob });
    assert.deepStrictEqual(theirs.body.machines.map((m) => m.id), [bobMachine], 'nobody else\'s machine is in it');

    // ── An app without the capability, or without the consent, is refused. ──
    const noCap = await call('GET', '/api/v1/machines', { token: appToken('network.something.else') });
    assert.strictEqual(noCap.status, 403, JSON.stringify(noCap.body));
    assert.strictEqual(noCap.body.code, 'capability.denied');
    await grant('network.machines.read', 'requested');
    const notApproved = await call('GET', '/api/v1/machines', { token: appToken('network.machines.read') });
    assert.strictEqual(notApproved.status, 403, JSON.stringify(notApproved.body));
    assert.strictEqual(notApproved.body.code, 'capability.owner_denied');
    await db.prepare("UPDATE dev_grants SET status = 'approved' WHERE app_id = ? AND capability = ?").run(appId, 'network.machines.read');
    const approved = await call('GET', '/api/v1/machines', { token: appToken('network.machines.read') });
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
    assert.deepStrictEqual(approved.body.machines.map((m) => m.id), [anaMachine], 'the app sees the person\'s machines');
    assert.strictEqual(calls[calls.length - 1].subject, ana.subject_id, 'the app acts for the person');

    // ── Rename, roles and revoke reach Bot as the person. ──
    await grant('network.machines.manage', 'approved');
    const renamed = await call('PATCH', `/api/v1/machines/${anaMachine}`, { user: ana, body: { name: 'Studio' } });
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
    assert.strictEqual(renamed.body.machine.name, 'Studio');
    const roles = await call('PUT', `/api/v1/machines/${anaMachine}/roles`, { user: ana, body: { roles: ['codes.worker', 'desks.host'] } });
    assert.strictEqual(roles.status, 200, JSON.stringify(roles.body));
    assert.deepStrictEqual(roles.body.machine.roles, ['codes.worker', 'desks.host']);
    const revoke = await call('POST', `/api/v1/machines/${anaMachine}/revoke`, { user: ana, body: {} });
    assert.strictEqual(revoke.status, 200, JSON.stringify(revoke.body));
    const botCalls = calls.filter((c) => c.method !== 'GET');
    for (const c of botCalls) assert.strictEqual(c.subject, ana.subject_id, 'every change reaches Bot as the person');

    // ── A role outside the catalogue is refused, and Bot never sees it. ──
    const before = calls.length;
    const bad = await call('PUT', `/api/v1/machines/${bobMachine}/roles`, { user: ana, body: { roles: ['nope.nope'] } });
    assert.strictEqual(bad.status, 422, JSON.stringify(bad.body));
    assert.strictEqual(bad.body.code, 'registry.unknown_role');
    assert.strictEqual(calls.length, before, 'Bot was not called');

    // ── The catalogue: the four roles the products declare. ──
    const cat = await call('GET', '/api/v1/machines/roles', { user: ana });
    assert.strictEqual(cat.status, 200);
    assert.deepStrictEqual(cat.body.roles.map((r) => r.id), ['codes.worker', 'desks.host', 'ai.host', 'bot.robot']);
    for (const r of cat.body.roles) {
        assert.ok(r.name && r.installs && r.shows, `the role ${r.id} says what it is`);
    }

    // ── The events: one each. ──
    const changed = await outbox('network.machine.roles_changed');
    assert.strictEqual(changed.length, 1, 'the roles change is published once');
    assert.strictEqual(changed[0].payload.machine_id, anaMachine);
    assert.strictEqual(changed[0].payload.owner, ana.subject_id);
    assert.deepStrictEqual(changed[0].payload.roles, ['codes.worker', 'desks.host']);
    const revoked = await outbox('network.machine.revoked');
    assert.strictEqual(revoked.length, 1, 'the revoke is published once');
    assert.strictEqual(revoked[0].payload.machine_id, anaMachine);
    assert.strictEqual(revoked[0].payload.owner, ana.subject_id);

    // ── Pairing a machine and choosing its roles are the person's own session, and nothing else. ──
    // A token that acts for the person (an app's, or a run's) may read, rename and revoke; it may never add a
    // machine or a role: a machine paired that way would carry the person's jobs and their desks.
    const OWN_SESSION = 'pair a machine and choose its roles from your own session on openvibe.network';
    const beforeDelegated = calls.length;
    for (const [name, token] of [['an app', appToken('network.machines.manage')], ['a run', runToken('network.machines.manage')]]) {
        const pairing = await call('POST', '/api/v1/machines/pairings', { token, body: {} });
        assert.strictEqual(pairing.status, 403, `${name} may not pair a machine: ${JSON.stringify(pairing.body)}`);
        assert.strictEqual(pairing.body.code, 'capability.owner_denied');
        assert.strictEqual(pairing.body.detail, OWN_SESSION);
        const roles = await call('PUT', `/api/v1/machines/${anaMachine}/roles`, { token, body: { roles: ['codes.worker'] } });
        assert.strictEqual(roles.status, 403, `${name} may not choose the roles: ${JSON.stringify(roles.body)}`);
        assert.strictEqual(roles.body.code, 'capability.owner_denied');
        assert.strictEqual(roles.body.detail, OWN_SESSION);
    }
    assert.strictEqual(calls.length, beforeDelegated, 'Bot was not called for any of them');
    // The person, in their own session, may do both.
    const ownPairing = await call('POST', '/api/v1/machines/pairings', { user: ana, body: {} });
    assert.strictEqual(ownPairing.status, 201, JSON.stringify(ownPairing.body));
    assert.ok(ownPairing.body.pairing && ownPairing.body.pairing.code, 'the code is theirs');
    const ownRoles = await call('PUT', `/api/v1/machines/${anaMachine}/roles`, { user: ana, body: { roles: ['codes.worker'] } });
    assert.strictEqual(ownRoles.status, 200, JSON.stringify(ownRoles.body));
    assert.deepStrictEqual(ownRoles.body.machine.roles, ['codes.worker']);

    // ── Bot's report of a machine's state: one event per change. ──
    const serviceToken = await (async () => {
        await db.prepare("UPDATE oauth_clients SET client_secret = 'shh' WHERE client_id = 'bot'").run();
        const out = await principals.issueToken(db, { clientId: 'bot', clientSecret: 'shh', audience: 'openvibe.network', privateKey: keys.privateKey, issuer: config.jwt.issuer });
        assert.strictEqual(out.status, 200, JSON.stringify(out.body));
        return out.body.access_token;
    })();
    const report = await call('POST', '/internal/machines/status', {
        token: serviceToken,
        body: { machine_id: anaMachine, principal_id: null, owner: ana.subject_id, online: true, at: new Date().toISOString() },
    });
    assert.strictEqual(report.status, 202, JSON.stringify(report.body));
    const online = await outbox('network.machine.online');
    assert.strictEqual(online.length, 1, 'the machine is announced once');
    assert.strictEqual(online[0].payload.machine_id, anaMachine);
    assert.strictEqual(online[0].actor.type, 'service');
    const off = await call('POST', '/internal/machines/status', {
        token: serviceToken,
        body: { machine_id: anaMachine, owner: ana.subject_id, online: false, at: new Date().toISOString() },
    });
    assert.strictEqual(off.status, 202);
    assert.strictEqual((await outbox('network.machine.offline')).length, 1, 'and once when it goes');
    const noToken = await call('POST', '/internal/machines/status', { body: { machine_id: anaMachine, owner: ana.subject_id, online: true } });
    assert.strictEqual(noToken.status, 403, 'only a service with the capability may report');

    // ── A pairing code works once, and it expires. ──
    const pairing = await nodePrincipals.createPairing(db, 'bot', { owner: { kind: 'user', subject: ana.subject_id }, ref: `worker:${ana.subject_id}` });
    assert.ok(pairing.code && pairing.expires_at, 'a code and an expiry');
    const redeemed = await nodePrincipals.redeem(db, { code: pairing.code, pairing: pairing.pairing_id, name: 'garage-pi' });
    assert.ok(redeemed.principal && redeemed.credential, 'the machine gets its credential');
    const paired = await outbox('network.machine.paired');
    assert.strictEqual(paired.length, 1, 'the pairing is published once');
    assert.strictEqual(paired[0].payload.principal_id, redeemed.principal.id);
    assert.strictEqual(paired[0].payload.owner, ana.subject_id);
    let used = null;
    try { await nodePrincipals.redeem(db, { code: pairing.code, pairing: pairing.pairing_id }); } catch (e) { used = e; }
    assert.ok(used && used.code === 'registry.pairing_code_used', `the code works once: ${used && used.code}`);
    const expired = await nodePrincipals.createPairing(db, 'bot', { owner: { kind: 'user', subject: bob.subject_id }, ref: `worker:${bob.subject_id}` }, Date.now() - 20 * 60 * 1000);
    let dead = null;
    try { await nodePrincipals.redeem(db, { code: expired.code, pairing: expired.pairing_id }); } catch (e) { dead = e; }
    assert.ok(dead && dead.code === 'registry.pairing_code_expired', `the code expires: ${dead && dead.code}`);

    console.log('machines-hub: ok');
} catch (e) {
    console.error(e);
    process.exitCode = 1;
} finally {
    server.close();
    botServer.close();
}
})();
