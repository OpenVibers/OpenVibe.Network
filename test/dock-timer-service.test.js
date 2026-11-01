'use strict';
// The Dock's timer for a first-party service (plan L48 R2; server/dock): PUT /api/v1/people/:subject/dock/timer
// answers network.dock-result@1 for a service that holds network.dock.timer.write. OpenVibe.Chat's Vibe starts the
// person's focus timer where they are ("Vibe, start a 25-minute focus timer"), and it counts down in the Dock's pill
// on every OpenVibe site.
//
// What this proves:
//   - a person's own token never opens the service route, and a service without the grant is refused;
//   - the service writes the timer and nothing else: every other field of the person's Dock state stays as it was;
//   - the timer it writes is the shape the Dock reads (openvibe-shared/dock-timer.js start());
//   - a bad timer is 422, an unknown person is 404, and X-OV-Subject may not name another person;
//   - the write limit is the person's own: 60 a minute, the person route and the service route together.
//   node --import ./test/helpers/pg-preload.mjs test/dock-timer-service.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { validate, serviceAuth } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const dockMod = require('../server/dock');
const authRoutes = require('../server/auth/routes');

(async () => {
const db = getDb();
const log = console.log; console.log = () => {};

const mk = async (name) => {
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id').run(name, `${name}@example.test`, 'x')).lastInsertRowid;
    await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const ana = await mk('timerana');
const bob = await mk('timerbob');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const tokenOf = (u) => authRoutes.signToken(u, keys.privateKey, config);

// A service token, the way Network's /oauth/token mints one: svc:<client> and the capabilities it holds.
const serviceToken = (client, cap) => {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: config.jwt.issuer, sub: `svc:${client}`, actor_type: 'service', aud: ['openvibe.network'],
        cap, ns: [], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    }, keys.privateKey);
};
const CHAT = serviceToken('chat', ['network.dock.timer.write']);

const dock = dockMod.createDock({ db, actions: { forPerson: async () => ({ counts: { running: 1, waiting: 0 }, partial: false }) }, notifications: { getUnreadCount: async () => 2 } });
const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use(express.json({ limit: '64kb' }));
app.use('/api/v1/me/dock', dockMod.router({ dock, requireAuth }));
app.use('/api/v1/people', dockMod.serviceRouter({ dock }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const put = (subject, body, { token = CHAT, subjectHeader = null } = {}) => fetch(`${base}/api/v1/people/${subject}/dock/timer`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(subjectHeader ? { 'x-ov-subject': subjectHeader } : {}) },
    body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));
const putMine = (body) => fetch(`${base}/api/v1/me/dock`, {
    method: 'PUT', headers: { authorization: `Bearer ${tokenOf(ana)}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const mine = () => fetch(`${base}/api/v1/me/dock`, { headers: { authorization: `Bearer ${tokenOf(ana)}` } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
    // The grant is Chat's alone, and it is the grant the seeded principal holds.
    const principals = require('../server/identity/principals');
    await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('chat', 'x', 'Chat', '[]', 1) ON CONFLICT DO NOTHING").run();
    await principals.ensureSchema(db);
    assert.deepStrictEqual(principals.DEFAULT_GRANTS.filter(([, cap]) => cap === 'network.dock.timer.write'),
        [['chat', 'network.dock.timer.write', 'openvibe.network', []]], 'Chat holds the grant, and nobody else is given it');
    assert.ok((await principals.grantsFor(db, 'chat', 'openvibe.network')).some((g) => g.capability === 'network.dock.timer.write'), 'the grant is seeded');
    assert.ok(!(await principals.grantsFor(db, 'live', 'openvibe.network')).some((g) => g.capability === 'network.dock.timer.write'), 'no other service holds it');

    // A person's own token never opens the service route: this is the service's door, not theirs.
    let r = await put(ana.subject_id, { minutes: 25 }, { token: tokenOf(ana) });
    assert.strictEqual(r.status, 401, `a person\'s token is refused: ${JSON.stringify(r.body)}`);
    assert.strictEqual((await put(ana.subject_id, { minutes: 25 }, { token: 'not-a-token' })).status, 401, 'a bad token is refused');

    // Another service without the grant is refused; so is a service that holds something else.
    r = await put(ana.subject_id, { minutes: 25 }, { token: serviceToken('live', ['network.modules.read']) });
    assert.strictEqual(r.status, 403, 'a service without the grant is refused');
    assert.strictEqual(r.body.code, 'capability.denied');
    r = await put(ana.subject_id, { minutes: 25 }, { token: serviceToken('live', ['network.*']) });
    assert.strictEqual(r.status, 200, 'a family grant covers it, as it does everywhere else on the network');
    // An app or an agent is not a first-party service, whatever it holds.
    const now = Math.floor(Date.now() / 1000);
    const appToken = serviceAuth.signServiceToken({
        iss: config.jwt.issuer, sub: 'app:app_01JABCDEFGHJKMNPQRSTVWXYZ0', actor_type: 'app', aud: ['openvibe.network'],
        cap: ['network.dock.timer.write'], ns: [], project_id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0', env: 'production',
        iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    }, keys.privateKey);
    r = await put(ana.subject_id, { minutes: 25 }, { token: appToken });
    assert.strictEqual(r.status, 403, 'an app token is refused');
    assert.strictEqual(r.body.code, 'capability.owner_denied');

    // The granted service sets the timer, and the answer is a Dock state.
    r = await put(ana.subject_id, { minutes: 25, kind: 'focus', label: 'Write the post', rounds: 4 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(validate('network.dock-result@1', r.body).valid, JSON.stringify(validate('network.dock-result@1', r.body).errors));
    const timer = r.body.state.timer;
    assert.strictEqual(timer.kind, 'focus');
    assert.strictEqual(timer.label, 'Write the post');
    assert.strictEqual(timer.round, 1);
    assert.strictEqual(timer.rounds, 4);
    assert.strictEqual(timer.focus_min, 25);
    assert.strictEqual(timer.break_min, 5);
    // The Dock reads this: the shape openvibe-shared/dock-timer.js start() writes, and the length it says.
    assert.deepStrictEqual(Object.keys(timer).sort(), ['break_min', 'ends_at', 'focus_min', 'kind', 'label', 'round', 'rounds', 'started_at']);
    assert.strictEqual(Date.parse(timer.ends_at) - Date.parse(timer.started_at), 25 * 60000, 'it ends 25 minutes after it starts');
    assert.ok(validate('network.dock-state@1', r.body.state).valid, 'the state is a Dock state');

    // A plain timer: no rounds, no break.
    r = await put(ana.subject_id, { minutes: 10 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.body.state.timer).sort(), ['ends_at', 'kind', 'started_at']);
    assert.strictEqual(r.body.state.timer.kind, 'timer');

    // The service writes the timer and nothing else: the person's own Dock state is left as it was.
    await putMine({ open: true, tab: 'chats', pinned: true, chat: 'cnv_1', place: { desktop: { width: 500 } } });
    const before = (await mine()).body.state;
    r = await put(ana.subject_id, { minutes: 25, label: 'Write' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.state.open, true, 'the Dock stayed open');
    assert.strictEqual(r.body.state.tab, 'chats', 'the tab stayed');
    assert.strictEqual(r.body.state.pinned, true, 'the pill stayed pinned');
    assert.strictEqual(r.body.state.chat, 'cnv_1', 'the chat stayed');
    assert.deepStrictEqual(r.body.state.place, before.place, 'where the Dock sits stayed');
    assert.strictEqual(r.body.state.timer.label, 'Write', 'the timer is the new part');
    assert.deepStrictEqual((await mine()).body.state, r.body.state, 'the stored state is the one the service was answered with');

    // A timer the contract does not accept is refused, and nothing is stored.
    for (const [body, why] of [
        [{ minutes: 0 }, 'no minutes'],
        [{ minutes: 200 }, 'too many minutes'],
        [{ minutes: 25.5 }, 'a fraction of a minute'],
        [{ minutes: 25, kind: 'nap' }, 'a kind the Dock does not know'],
        [{ minutes: 25, rounds: 0 }, 'no rounds'],
        [{ minutes: 25, rounds: 13 }, 'too many rounds'],
        [{ minutes: 25, label: 'x'.repeat(61) }, 'a label over 60 characters'],
        [{ minutes: 25, clear: true }, 'both at once'],
        [{ clear: false }, 'clear is false'],
        [{}, 'nothing at all'],
        [{ minutes: 25, colour: 'blue' }, 'a field the timer does not have'],
    ]) {
        const state = (await mine()).body.state;
        r = await put(ana.subject_id, body);
        assert.strictEqual(r.status, 422, `${why}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'dock.invalid', why);
        assert.deepStrictEqual((await mine()).body.state, state, `${why}: nothing was stored`);
    }

    // The service stops the timer, and the rest of the state stays.
    r = await put(ana.subject_id, { clear: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.state.timer, null, 'the timer is gone');
    assert.strictEqual(r.body.state.tab, 'chats', 'the tab stayed');

    // Only a person the Network knows has a Dock.
    r = await put('usr_01JABCDEFGHJKMNPQRSTVWXYZ0', { minutes: 25 });
    assert.strictEqual(r.status, 404, 'an unknown person is 404');
    r = await put('not-a-subject', { minutes: 25 });
    assert.strictEqual(r.status, 400, 'a malformed subject is 400');

    // The service names the person: X-OV-Subject may not name another one.
    r = await put(ana.subject_id, { minutes: 25 }, { subjectHeader: bob.subject_id });
    assert.strictEqual(r.status, 403, 'another person in the header is refused');
    assert.strictEqual(r.body.code, 'dock.subject_mismatch');
    r = await put(ana.subject_id, { minutes: 25 }, { subjectHeader: ana.subject_id });
    assert.strictEqual(r.status, 200, 'the same person in the header is fine');

    // One person never touches another's state: the service writes the timer of the person it names, and of nobody else.
    const bobState = await fetch(`${base}/api/v1/me/dock`, { headers: { authorization: `Bearer ${tokenOf(bob)}` } }).then((x) => x.json());
    assert.strictEqual(bobState.state.timer, undefined, "bob's Dock has no timer");
    await put(ana.subject_id, { minutes: 25 });
    const bobAgain = await fetch(`${base}/api/v1/me/dock`, { headers: { authorization: `Bearer ${tokenOf(bob)}` } }).then((x) => x.json());
    assert.strictEqual(bobAgain.state.timer, undefined, "bob's Dock still has no timer");

    // Every decision is counted, like the other service routes: who called, and whether they were let in.
    const usage = await db.prepare('SELECT principal, route, capability, auth, allowed FROM principal_usage WHERE capability = ?').all('network.dock.timer.write');
    assert.ok(usage.length, 'the decisions are counted');
    assert.ok(usage.some((u) => u.allowed === 1), 'an allowed call is counted');
    assert.ok(usage.some((u) => u.allowed === 0), 'a refused call is counted');
    assert.ok(usage.every((u) => u.route.includes('dock/timer')), `the route is named: ${usage.map((u) => u.route).join(', ')}`);
    assert.ok(usage.every((u) => u.auth === 'service-token'), 'the caller was a service token');

    // The write limit is the person's own: 60 a minute, the person route and the service route together.
    const limiter = dockMod.createDock({ db, actions: null, notifications: null });
    const limitApp = express();
    Object.assign(limitApp.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    limitApp.use(express.json({ limit: '64kb' }));
    limitApp.use('/api/v1/people', dockMod.serviceRouter({ dock: limiter }));
    const limitServer = http.createServer(limitApp);
    await new Promise((r) => limitServer.listen(0, '127.0.0.1', r));
    const limitPut = (body) => fetch(`http://127.0.0.1:${limitServer.address().port}/api/v1/people/${bob.subject_id}/dock/timer`, {
        method: 'PUT', headers: { authorization: `Bearer ${CHAT}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (let i = 0; i < dockMod.WRITE_LIMIT; i++) {
        const w = await limitPut({ minutes: 5 });
        assert.strictEqual(w.status, 200, `write ${i + 1} of ${dockMod.WRITE_LIMIT}`);
    }
    const over = await limitPut({ minutes: 5 });
    assert.strictEqual(over.status, 429, 'the 61st write in a minute is refused');
    assert.strictEqual((await over.json()).code, 'dock.rate_limited');
    limitServer.close();
} finally {
    server.close();
    console.log = log;
}
console.log('dock timer service: ok');
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
