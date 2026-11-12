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
const nodePrincipals = require('../server/registry/link-principals');

assert.deepStrictEqual(machines.machineOf({ id: 'dev_test', fleet: [
    { agent: 'muse', installed: true, signed_in: true, windows: [{ name: 'plan', used: 2, limit: 10 }], access_token: 'never-forward' },
], fleet_at: '2026-11-11T04:00:00Z' }).fleet, [
    { agent: 'muse', installed: true, signed_in: true },
], 'the owner gets Muse readiness, without usage or credentials');

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
const flags = new Map();       // machine id → the owner's switches and the screen state the fake Link reports
const stateOf = (id) => flags.get(id) || {};
const machineOf = (id) => {
    const s = stateOf(id);
    return {
        id, name: 'garage-pi', kind: 'onboard', online: true, roles: [], running: [], node_id: null,
        agent_computer: s.agent_computer === true, watch_probe: s.watch_probe === true, ai_models: s.ai_models === true, shared_desks: s.shared_desks === true,
        computer: {
            level: 'ask', terminal: { level: 'ask' }, files: { level: 'ask' }, screen: { level: 'ask', stream: true },
            probe: { level: 'observe' }, desk: { level: 'ask', max_desks: 2, kinds: ['browser'], isolation: 'sandbox', screen: true, named: true },
            waiting: 0, desks_running: 0, screen_stream: s.screen_live ? 'live' : 'off',
        },
    };
};
const botServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : null;
    const subject = req.headers['x-ov-subject'] || null;
    calls.push({ method: req.method, url: req.url, subject, body, auth: String(req.headers.authorization || '') });
    const answer = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const list = () => (owned.get(subject) || []).map(machineOf);
    const mineOf = (id) => list().find((m) => m.id === id);
    const setFlag = (id, key, value) => { flags.set(id, { ...stateOf(id), [key]: value }); return machineOf(id); };
    if (req.method === 'GET' && req.url === '/api/v1/machines') return answer(200, { machines: list() });
    if (req.method === 'POST' && req.url === '/api/v1/machines/pairings') {
        return answer(201, { pairing: { code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 600000).toISOString(), pairing_id: `pair_${ids.ulid()}`, installer: 'curl -fsSL https://openvibe.link/install | sh -s -- --pairing pair_1 --code ABCD-EFGH --worker' } });
    }
    // The owner's own controls (the card): each as Bot checks it, the machine's own or 404.
    let m;
    if (req.method === 'POST' && (m = /^\/api\/v1\/machines\/([^/]+)\/(agent-computer|watch-probe|ai-models|shared-desks)$/.exec(req.url))) {
        if (!mineOf(decodeURIComponent(m[1]))) return answer(404, { code: 'bot.device_not_found' });
        const key = { 'agent-computer': 'agent_computer', 'watch-probe': 'watch_probe', 'ai-models': 'ai_models', 'shared-desks': 'shared_desks' }[m[2]];
        if (typeof body.on !== 'boolean') return answer(422, { code: 'bot.invalid_input' });
        return answer(200, { machine: setFlag(decodeURIComponent(m[1]), key, body.on) });
    }
    if (req.method === 'POST' && (m = /^\/api\/v1\/machines\/([^/]+)\/screen$/.exec(req.url))) {
        if (!mineOf(decodeURIComponent(m[1]))) return answer(404, { code: 'bot.device_not_found' });
        return answer(201, { machine_id: decodeURIComponent(m[1]), streaming: true, seconds: 600, fps: 2, until: new Date(Date.now() + 600000).toISOString(), desk: body.desk || 'main' });
    }
    if (req.method === 'GET' && (m = /^\/api\/v1\/machines\/([^/]+)\/screen$/.exec(req.url))) {
        const id = decodeURIComponent(m[1]);
        if (!mineOf(id)) return answer(404, { code: 'bot.device_not_found' });
        const live = stateOf(id).screen_live === true;
        return answer(200, { machine_id: id, live, signaling_url: live ? 'wss://ingest.openre.stream/w/abc' : null, state: live ? 'live' : 'off', online: true, desk: 'main' });
    }
    if (req.method === 'DELETE' && (m = /^\/api\/v1\/machines\/([^/]+)\/screen$/.exec(req.url))) {
        if (!mineOf(decodeURIComponent(m[1]))) return answer(404, { code: 'bot.device_not_found' });
        setFlag(decodeURIComponent(m[1]), 'screen_live', false);
        return answer(200, { stopped: true });
    }
    if (req.method === 'POST' && (m = /^\/api\/v1\/machines\/([^/]+)\/screen\/input$/.exec(req.url))) {
        if (!mineOf(decodeURIComponent(m[1]))) return answer(404, { code: 'bot.device_not_found' });
        return answer(200, { done: true, desk: 'main' });
    }
    if (req.method === 'GET' && (m = /^\/api\/v1\/machines\/([^/]+)\/desks$/.exec(req.url))) {
        if (!mineOf(decodeURIComponent(m[1]))) return answer(404, { code: 'bot.device_not_found' });
        return answer(200, { machine_id: decodeURIComponent(m[1]), desks: [{ desk: 'desk-a', kind: 'browser', since: 1700000000, width: 1280, height: 720 }], max_desks: 2 });
    }
    if (req.method === 'POST' && (m = /^\/api\/v1\/machines\/([^/]+)\/desks\/([^/]+)\/(stop|live)$/.exec(req.url))) {
        const id = decodeURIComponent(m[1]);
        if (!mineOf(id)) return answer(404, { code: 'bot.device_not_found' });
        if (m[3] === 'stop') return answer(200, { stopped: decodeURIComponent(m[2]) });
        setFlag(id, 'screen_live', true);
        return answer(201, { machine_id: id, streaming: true, seconds: 1800, until: new Date(Date.now() + 1800000).toISOString(), desk: decodeURIComponent(m[2]), live: { channel_url: 'https://openvibe.live/@ana' } });
    }
    if (req.method === 'GET' && (m = /^\/api\/v1\/machines\/([^/]+)\/shares$/.exec(req.url))) {
        if (!mineOf(decodeURIComponent(m[1]))) return answer(404, { code: 'bot.device_not_found' });
        return answer(200, { machine_id: decodeURIComponent(m[1]), shares: [{ id: 'shr_abc', label: 'Staff room', control: false, desk: 'main', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() }] });
    }
    if (req.method === 'DELETE' && (m = /^\/api\/v1\/machines\/([^/]+)\/shares\/([^/]+)$/.exec(req.url))) {
        if (!mineOf(decodeURIComponent(m[1]))) return answer(404, { code: 'bot.device_not_found' });
        return answer(200, { revoked: decodeURIComponent(m[2]) === 'shr_abc' });
    }
    if (req.method === 'PATCH' && req.url.startsWith('/api/v1/machines/')) {
        const id = decodeURIComponent(req.url.slice('/api/v1/machines/'.length));
        const row = machineOf(id); row.name = body.name; return answer(200, { machine: row });
    }
    if (req.method === 'PUT' && req.url.endsWith('/roles')) {
        const id = decodeURIComponent(req.url.slice('/api/v1/machines/'.length, -'/roles'.length));
        const row = machineOf(id); row.roles = body.roles; return answer(200, { machine: row });
    }
    if (req.method === 'POST' && req.url.endsWith('/revoke')) {
        const id = decodeURIComponent(req.url.slice('/api/v1/machines/'.length, -'/revoke'.length));
        const row = machineOf(id); row.online = false; return answer(200, { machine: row });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v1/machines/')) {
        const id = decodeURIComponent(req.url.slice('/api/v1/machines/'.length));
        return mineOf(id) ? answer(200, { machine: machineOf(id) }) : answer(404, { code: 'bot.device_not_found' });
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
const machineRouters = machines.routers({ bot, requireAuth, publicKey: keys.publicKey, issuer: config.jwt.issuer });
app.use('/api/v1/machines', machineRouters.hub);
app.use('/api/v1/link/compute', machineRouters.compute);
// Bot's report of a machine's state (network.link.manage, the capability Bot already holds).
app.use('/internal', machines.internalRouters({ guard: principals.guard('network.link.manage') }).internal);
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
    const signedOut = await call('GET', '/api/v1/machines');
    assert.strictEqual(signedOut.status, 401, "the cross-site read requires the person's Network token");
    // ── A person sees their own machines, and the hub calls Bot as them. ──
    const mine = await call('GET', '/api/v1/machines', { user: ana });
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
    assert.deepStrictEqual(mine.body.machines.map((m) => m.id), [anaMachine]);
    assert.strictEqual(mine.body.machines[0].kind, 'onboard');
    assert.strictEqual(mine.body.machines[0].system, 'onboard');
    assert.deepStrictEqual(mine.body.machines[0].can_run, []);
    assert.deepStrictEqual(mine.body.machines[0].roles, []);
    assert.deepStrictEqual(mine.body.machines[0].running, []);
    const last = calls[calls.length - 1];
    assert.strictEqual(last.subject, ana.subject_id, 'Bot is called as the person');
    assert.ok(String(last.auth).startsWith('Bearer '), 'the hub carries a service token');
    const theirs = await call('GET', '/api/v1/machines', { user: bob });
    assert.deepStrictEqual(theirs.body.machines.map((m) => m.id), [bobMachine], 'nobody else\'s machine is in it');

    const compute = await call('GET', '/api/v1/link/compute', { user: ana });
    assert.strictEqual(compute.status, 200, JSON.stringify(compute.body));
    assert.deepStrictEqual(compute.body.sources.map((s) => s.kind), ['personal', 'cloud', 'exchange', 'community']);
    assert.deepStrictEqual(compute.body.candidates.map((c) => c.id), [anaMachine]);
    assert.strictEqual(compute.body.candidates[0].status, 'unavailable', 'a machine without the worker role cannot be picked');
    assert.strictEqual((await call('POST', '/api/v1/link/compute/pick', { user: ana, body: { kind: 'personal', id: anaMachine } })).status, 409);
    assert.strictEqual((await call('POST', '/api/v1/link/compute/pick', { user: ana, body: { kind: 'exchange' } })).status, 409, 'a rental cannot start from a placeholder');
    assert.strictEqual((await call('GET', '/api/v1/link/compute?kind=unknown', { user: ana })).status, 400);

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

    // ── The owner's controls on the machine card: Bot's report is the switch's state, and each control is a call
    // to Bot as the person. Nothing here is assumed on: the fake Link has both switches off until asked. ──
    const card = (await call('GET', '/api/v1/machines', { user: ana })).body.machines[0];
    assert.deepStrictEqual([card.controls.agent_computer, card.controls.watch_probe], [false, false], 'off because Bot said off');
    assert.deepStrictEqual(card.controls.screen, { available: true, live: false }, 'the screen it may show, not shown');
    assert.strictEqual(card.controls.computer, true);
    assert.strictEqual(card.controls.probe, true);
    assert.strictEqual(card.controls.desk.available, true);

    const agentOn = await call('POST', `/api/v1/machines/${anaMachine}/agent-computer`, { user: ana, body: { on: true } });
    assert.strictEqual(agentOn.status, 200, JSON.stringify(agentOn.body));
    assert.strictEqual(agentOn.body.machine.controls.agent_computer, true);
    let sent = calls.at(-1);
    assert.deepStrictEqual([sent.method, sent.url, sent.subject, sent.body], ['POST', `/api/v1/machines/${anaMachine}/agent-computer`, ana.subject_id, { on: true }]);
    assert.strictEqual((await call('GET', '/api/v1/machines', { user: ana })).body.machines[0].controls.agent_computer, true, 'the switch now reads on from Bot');
    const agentOff = await call('POST', `/api/v1/machines/${anaMachine}/agent-computer`, { user: ana, body: { on: false } });
    assert.strictEqual(agentOff.body.machine.controls.agent_computer, false);

    const watchOn = await call('POST', `/api/v1/machines/${anaMachine}/watch-probe`, { user: ana, body: { on: true } });
    assert.strictEqual(watchOn.status, 200, JSON.stringify(watchOn.body));
    assert.strictEqual(watchOn.body.machine.controls.watch_probe, true);
    sent = calls.at(-1);
    assert.deepStrictEqual([sent.method, sent.url, sent.subject, sent.body], ['POST', `/api/v1/machines/${anaMachine}/watch-probe`, ana.subject_id, { on: true }]);
    // 2026-11-12: the card's two new switches, the models and lending browsers to other people's agents.
    for (const [route, key] of [['ai-models', 'ai_models'], ['shared-desks', 'shared_desks']]) {
        const r = await call('POST', `/api/v1/machines/${anaMachine}/${route}`, { user: ana, body: { on: true } });
        assert.strictEqual(r.status, 200, `${route}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.machine.controls[key], true, route);
        sent = calls.at(-1);
        assert.deepStrictEqual([sent.method, sent.url, sent.subject, sent.body], ['POST', `/api/v1/machines/${anaMachine}/${route}`, ana.subject_id, { on: true }], route);
    }
    // A body that is not true/false never reaches Bot.
    const beforeBadSwitch = calls.length;
    const badSwitch = await call('POST', `/api/v1/machines/${anaMachine}/agent-computer`, { user: ana, body: { on: 'yes' } });
    assert.strictEqual(badSwitch.status, 422, JSON.stringify(badSwitch.body));
    assert.strictEqual(calls.length, beforeBadSwitch, 'Bot never saw it');

    // The live screen: 10 minutes by Bot's default (the hub sends no seconds), the state, input, stop.
    const started = await call('POST', `/api/v1/machines/${anaMachine}/screen`, { user: ana, body: { desk: 'main' } });
    assert.strictEqual(started.status, 201, JSON.stringify(started.body));
    assert.deepStrictEqual([started.body.streaming, started.body.seconds, started.body.desk], [true, 600, 'main']);
    sent = calls.at(-1);
    assert.deepStrictEqual([sent.method, sent.url, sent.subject, sent.body], ['POST', `/api/v1/machines/${anaMachine}/screen`, ana.subject_id, { desk: 'main' }]);
    const state = await call('GET', `/api/v1/machines/${anaMachine}/screen`, { user: ana });
    assert.strictEqual(state.status, 200, JSON.stringify(state.body));
    assert.deepStrictEqual([state.body.live, state.body.state], [false, 'off']);
    const input = await call('POST', `/api/v1/machines/${anaMachine}/screen/input`, { user: ana, body: { action: 'click', x: 1, y: 2, width: 100, height: 100 } });
    assert.strictEqual(input.status, 200, JSON.stringify(input.body));
    assert.strictEqual(input.body.done, true);
    assert.strictEqual(calls.at(-1).url, `/api/v1/machines/${anaMachine}/screen/input`);
    const stopped = await call('DELETE', `/api/v1/machines/${anaMachine}/screen`, { user: ana });
    assert.deepStrictEqual([stopped.status, stopped.body.stopped], [200, true]);

    // The screen links: listed without their token, then revoked by id.
    const shares = await call('GET', `/api/v1/machines/${anaMachine}/shares`, { user: ana });
    assert.strictEqual(shares.status, 200, JSON.stringify(shares.body));
    assert.deepStrictEqual(shares.body.shares.map((s) => [s.id, s.label, s.control, s.desk]), [['shr_abc', 'Staff room', false, 'main']]);
    assert.ok(!JSON.stringify(shares.body).includes('token'), 'never the token');
    const revokeShare = await call('DELETE', `/api/v1/machines/${anaMachine}/shares/shr_abc`, { user: ana });
    assert.deepStrictEqual([revokeShare.status, revokeShare.body.revoked], [200, true]);
    assert.strictEqual(calls.at(-1).url, `/api/v1/machines/${anaMachine}/shares/shr_abc`);

    // The desks: read on demand, stopped, and put on the person's Live channel for 30 minutes.
    const desks = await call('GET', `/api/v1/machines/${anaMachine}/desks`, { user: ana });
    assert.strictEqual(desks.status, 200, JSON.stringify(desks.body));
    assert.deepStrictEqual(desks.body.desks.map((d) => [d.desk, d.kind, d.width, d.height]), [['desk-a', 'browser', 1280, 720]]);
    assert.strictEqual(desks.body.max_desks, 2);
    const deskStop = await call('POST', `/api/v1/machines/${anaMachine}/desks/desk-a/stop`, { user: ana, body: {} });
    assert.deepStrictEqual([deskStop.status, deskStop.body.stopped], [200, 'desk-a']);
    const live = await call('POST', `/api/v1/machines/${anaMachine}/desks/desk-a/live`, { user: ana, body: {} });
    assert.strictEqual(live.status, 201, JSON.stringify(live.body));
    assert.deepStrictEqual([live.body.desk, live.body.seconds, live.body.channel_url], ['desk-a', 1800, 'https://openvibe.live/@ana']);
    const afterLive = await call('GET', `/api/v1/machines/${anaMachine}/screen`, { user: ana });
    assert.deepStrictEqual([afterLive.body.live, afterLive.body.state, afterLive.body.signaling_url], [true, 'live', 'wss://ingest.openre.stream/w/abc']);

    // Another person's machine is not there for any of them (404, never 403).
    const otherPaths = [
        ['POST', `/api/v1/machines/${bobMachine}/agent-computer`, { on: true }],
        ['POST', `/api/v1/machines/${bobMachine}/watch-probe`, { on: true }],
        ['POST', `/api/v1/machines/${bobMachine}/screen`, { desk: 'main' }],
        ['GET', `/api/v1/machines/${bobMachine}/screen`],
        ['GET', `/api/v1/machines/${bobMachine}/desks`],
        ['GET', `/api/v1/machines/${bobMachine}/shares`],
    ];
    for (const [method, url, body] of otherPaths) {
        const theirs = await call(method, url, { user: ana, body });
        assert.strictEqual(theirs.status, 404, `${method} ${url}: ${JSON.stringify(theirs.body)}`);
        assert.strictEqual(theirs.body.code, 'bot.device_not_found');
    }

    // An app or a run acting for the person may not reach the owner's own controls: only their own session does.
    const beforeDelegatedControls = calls.length;
    for (const [name, tokenFor] of [['an app', appToken], ['a run', runToken]]) {
        for (const [method, url, body, cap] of [
            ['POST', `/api/v1/machines/${anaMachine}/agent-computer`, { on: true }, 'network.machines.manage'],
            ['POST', `/api/v1/machines/${anaMachine}/watch-probe`, { on: true }, 'network.machines.manage'],
            ['POST', `/api/v1/machines/${anaMachine}/screen`, { desk: 'main' }, 'network.machines.manage'],
            ['GET', `/api/v1/machines/${anaMachine}/screen`, undefined, 'network.machines.read'],
            ['GET', `/api/v1/machines/${anaMachine}/desks`, undefined, 'network.machines.read'],
            ['GET', `/api/v1/machines/${anaMachine}/shares`, undefined, 'network.machines.read'],
        ]) {
            const refused = await call(method, url, { token: tokenFor(cap), body });
            assert.strictEqual(refused.status, 403, `${name} ${method} ${url}: ${JSON.stringify(refused.body)}`);
            assert.strictEqual(refused.body.code, 'capability.owner_denied');
        }
    }
    assert.strictEqual(calls.length, beforeDelegatedControls, 'Bot was not called for a delegated control');

    // ── A role outside the catalogue is refused, and Bot never sees it. ──
    const before = calls.length;
    const bad = await call('PUT', `/api/v1/machines/${bobMachine}/roles`, { user: ana, body: { roles: ['nope.nope'] } });
    assert.strictEqual(bad.status, 422, JSON.stringify(bad.body));
    assert.strictEqual(bad.body.code, 'registry.unknown_role');
    assert.strictEqual(calls.length, before, 'Bot was not called');

    // ── The catalogue: the four roles the products declare. ──
    const cat = await call('GET', '/api/v1/machines/roles', { user: ana });
    assert.strictEqual(cat.status, 200);
    // The four roles the products declare; the order is the manifests' own, so the set is what matters.
    assert.deepStrictEqual(cat.body.roles.map((r) => r.id).sort(), ['ai.host', 'bot.robot', 'codes.worker', 'desks.host']);
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
    const OWN_SESSION = 'only your own session on openvibe.network changes what a machine does';
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
