'use strict';
// The Dock's state (server/dock, the Dock plan 2026-10-30, K-D1): GET and PUT /api/v1/me/dock answer network.dock-result@1.
// The Dock is the little floating surface every OpenVibe site draws, and localStorage is per site, so the state it
// follows the person with lives in the Network.
//
// What this proves:
//   - the default state for a person who has never opened the Dock, and the counts beside it;
//   - a partial PUT merges into the stored state (place merges per device class), and an invalid body is refused
//     with the contract's problem shape (an unknown tab, a width of 2000, a key the contract does not know);
//   - the counts come from the Action Center's aggregator and the notification service, and sources_partial says
//     when an authority did not answer;
//   - one person never reads or writes another's state: the subject comes from the token and nowhere else;
//   - CORS: an OpenVibe site may ask, another origin is refused (and a cross-origin write never runs the route);
//   - 60 writes a minute per person;
//   - the row goes into the person's export and is erased with them, and a merge leaves it with the survivor;
//   - the migration is expand-only.
//   node --import ./test/helpers/pg-preload.mjs test/dock.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { ids, validate } = require('openvibe-contracts');
const { uncovered } = require('openvibe-sdk/account-data');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const dockMod = require('../server/dock');
const accountData = require('../server/identity/account-data');
const accountMerge = require('../server/identity/account-merge');
const publicCors = require('../server/public-cors');
const authRoutes = require('../server/auth/routes');

(async () => {
const db = getDb();
const log = console.log; console.log = () => {};

// Two people, each with a canonical subject: the Dock's row belongs to one of them, never to both.
// A jsonb column comes back already parsed from some drivers and as text from others.
const asJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const mk = async (name) => {
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id').run(name, `${name}@example.test`, 'x')).lastInsertRowid;
    await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const ana = await mk('dockana');
const bob = await mk('dockbob');

// The Action Center's aggregator and the notification service, faked: the Dock asks them and shows what they say.
const seen = [];
const aggregator = { forPerson: async (actor) => { seen.push(actor.subject); return { counts: { running: 2, waiting: 1, scheduled: 0, done: 0, failed: 0 }, partial: false }; } };
const notifications = { getUnreadCount: async (userId) => (userId === ana.id ? 4 : 7) };

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const tokenOf = (u) => authRoutes.signToken(u, keys.privateKey, config);

const dock = dockMod.createDock({ db, actions: aggregator, notifications });
const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
// The CORS the whole app runs behind (server/index.js): the first-party allow-list, and a foreign origin refused.
const allowed = new Set(['https://openvibe.blog', 'https://openvibe.network']);
const corsGuard = publicCors.originGuard((origin) => allowed.has(origin), { log: { warn() {} } });
app.use(publicCors.gate(publicCors.restrictedCors(corsGuard.origin)));
app.use(corsGuard.denied);
app.use('/api/v1/me/dock', dockMod.router({ dock, requireAuth }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${server.address().port}/api/v1/me/dock`;
const call = (method, body, { as = ana, origin = null } = {}) => fetch(api, {
    method,
    headers: { authorization: `Bearer ${tokenOf(as)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(origin ? { origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));

try {
    // The default state: closed, on the activity tab, not pinned, bottom-right, the site's own size.
    let r = await call('GET');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(validate('network.dock-result@1', r.body).valid, JSON.stringify(validate('network.dock-result@1', r.body).errors));
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    assert.deepStrictEqual(r.body.state, {
        open: false, tab: 'activity', pinned: false, agent: null, chat: null,
        place: { phone: { corner: 'bottom-right' }, desktop: { corner: 'bottom-right', width: null, height: null } },
        updated_at: r.body.state.updated_at,
    });
    assert.ok(r.body.state.updated_at, 'the default state carries a time');
    assert.deepStrictEqual(r.body.counts, { running: 2, waiting: 1, unread: 4 }, 'the counts come from the aggregator and the notifications');
    assert.strictEqual(r.body.sources_partial, false);

    // A session is needed; another person's token reads their own state, never this one's.
    assert.strictEqual((await fetch(api, { method: 'GET' })).status, 401, 'a session is needed');
    r = await call('GET', undefined, { as: bob });
    assert.deepStrictEqual(r.body.state.place, { phone: { corner: 'bottom-right' }, desktop: { corner: 'bottom-right', width: null, height: null } }, "bob sees his own default");
    assert.deepStrictEqual(r.body.counts, { running: 2, waiting: 1, unread: 7 }, 'the unread count is the caller\'s own');

    // A partial write merges into the stored state.
    r = await call('PUT', { open: true, tab: 'chats' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(validate('network.dock-result@1', r.body).valid);
    assert.deepStrictEqual([r.body.state.open, r.body.state.tab, r.body.state.pinned], [true, 'chats', false], 'pinned was not in the body and stayed');
    r = await call('GET');
    assert.deepStrictEqual([r.body.state.open, r.body.state.tab], [true, 'chats'], 'the state is stored');

    // place merges per device class, and inside a class per field.
    r = await call('PUT', { place: { desktop: { width: 500 } } });
    assert.deepStrictEqual(r.body.state.place, { phone: { corner: 'bottom-right' }, desktop: { corner: 'bottom-right', width: 500, height: null } }, 'the corner and the height stayed');
    r = await call('PUT', { place: { phone: { corner: 'top-left' } } });
    assert.deepStrictEqual(r.body.state.place, { phone: { corner: 'top-left' }, desktop: { corner: 'bottom-right', width: 500, height: null } }, 'the desktop stayed');
    r = await call('PUT', { place: { desktop: { corner: 'top-right', height: 700 } } });
    assert.deepStrictEqual(r.body.state.place, { phone: { corner: 'top-left' }, desktop: { corner: 'top-right', width: 500, height: 700 } });

    // The agent and the chat: replaced whole, and null clears them.
    r = await call('PUT', { agent: { service: 'actor', id: 'tsk_1' }, chat: 'cnv_1' });
    assert.deepStrictEqual(r.body.state.agent, { service: 'actor', id: 'tsk_1' });
    assert.strictEqual(r.body.state.chat, 'cnv_1');
    r = await call('PUT', { agent: null });
    assert.strictEqual(r.body.state.agent, null, 'null clears the agent');
    assert.strictEqual(r.body.state.chat, 'cnv_1', 'the chat was not in the body and stayed');

    // An invalid body is refused with the contract's problem shape.
    for (const [body, why] of [
        [{ tab: 'profile' }, 'an unknown tab'],
        [{ place: { desktop: { width: 2000 } } }, 'a width of 2000'],
        [{ place: { desktop: { height: 10 } } }, 'a height under 360'],
        [{ theme: 'neon-tokyo' }, 'a key the contract does not know'],
        [{ place: { tablet: { corner: 'top-left' } } }, 'a device class the contract does not know'],
        [{ chat: '' }, 'an empty chat id'],
    ]) {
        const before = (await call('GET')).body.state;
        r = await call('PUT', body);
        assert.strictEqual(r.status, 422, `${why}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'dock.invalid', why);
        assert.strictEqual(r.body.status, 422);
        assert.ok(r.body.type && r.body.title, 'the problem carries a type and a title');
        assert.ok(Array.isArray(r.body.errors) && r.body.errors.length, `${why}: the faults are listed`);
        assert.ok(r.body.errors.every((e) => typeof e.message === 'string'), 'each fault has a message');
        assert.deepStrictEqual((await call('GET')).body.state, before, `${why}: nothing was stored`);
    }

    // One person never reads or writes another's state: the subject comes from the token and nowhere else.
    const anaRow = await db.prepare('SELECT subject, state FROM dock_states WHERE subject = ?').get(ana.subject_id);
    assert.ok(anaRow, "ana's row is his own");
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM dock_states').get()).n, 1, "bob's write made no row of his own");
    r = await call('PUT', { tab: 'agent' }, { as: bob });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.state.tab, 'agent', "bob's own state");
    assert.strictEqual(r.body.state.pinned, false, "bob's state is his own default plus his own write");
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM dock_states').get()).n, 2, 'one row each');
    const anaAgain = await db.prepare('SELECT state FROM dock_states WHERE subject = ?').get(ana.subject_id);
    assert.deepStrictEqual(asJson(anaAgain.state), asJson(anaRow.state), "bob's write left ana's state alone");
    assert.ok(seen.every((s) => s === ana.subject_id || s === bob.subject_id), 'the aggregator was asked about the caller only');

    // CORS: an OpenVibe site may ask; another origin is refused, and its write never runs the route.
    let cors = await fetch(api, { headers: { origin: 'https://openvibe.blog', authorization: `Bearer ${tokenOf(ana)}` } });
    assert.strictEqual(cors.status, 200, 'an OpenVibe site may read the Dock');
    assert.strictEqual(cors.headers.get('access-control-allow-origin'), 'https://openvibe.blog', 'the answer names the origin');
    cors = await fetch(api, { method: 'OPTIONS', headers: { origin: 'https://openvibe.blog', 'access-control-request-method': 'PUT' } });
    assert.ok(cors.status === 204 || cors.status === 200, `the preflight is answered: ${cors.status}`);
    cors = await fetch(api, { headers: { origin: 'https://evil.example', authorization: `Bearer ${tokenOf(ana)}` } });
    assert.strictEqual(cors.status, 403, 'another origin is refused');
    assert.strictEqual((await cors.json()).code, 'cors.origin_denied');
    cors = await fetch(api, { method: 'PUT', headers: { origin: 'https://evil.example', authorization: `Bearer ${tokenOf(ana)}`, 'content-type': 'application/json' }, body: JSON.stringify({ tab: 'chats' }) });
    assert.strictEqual(cors.status, 403, 'a cross-origin write never runs the route');
    assert.deepStrictEqual(asJson((await db.prepare('SELECT state FROM dock_states WHERE subject = ?').get(ana.subject_id)).state), asJson(anaAgain.state), "the refused write changed nothing");

    // 60 writes a minute, per person.
    const limiter = dockMod.createDock({ db, actions: aggregator, notifications });
    const limitApp = express();
    Object.assign(limitApp.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    limitApp.use('/api/v1/me/dock', dockMod.router({ dock: limiter, requireAuth }));
    const limitServer = http.createServer(limitApp);
    await new Promise((r) => limitServer.listen(0, '127.0.0.1', r));
    const limitApi = `http://127.0.0.1:${limitServer.address().port}/api/v1/me/dock`;
    const limited = (body) => fetch(limitApi, { method: 'PUT', headers: { authorization: `Bearer ${tokenOf(ana)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (let i = 0; i < dockMod.WRITE_LIMIT; i++) {
        const w = await limited({ pinned: true });
        assert.strictEqual(w.status, 200, `write ${i + 1} of ${dockMod.WRITE_LIMIT}`);
    }
    const over = await limited({ pinned: false });
    assert.strictEqual(over.status, 429, 'the 61st write in a minute is refused');
    assert.strictEqual((await over.json()).code, 'dock.rate_limited');
    limitServer.close();

    // The counts say so when an authority does not answer.
    const brokenDock = dockMod.createDock({ db, actions: { forPerson: async () => { throw new Error('the aggregator is down'); } }, notifications: { getUnreadCount: async () => { throw new Error('the notifications are down'); } }, log: { warn() {} } });
    const brokenApp = express();
    Object.assign(brokenApp.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    brokenApp.use('/api/v1/me/dock', dockMod.router({ dock: brokenDock, requireAuth }));
    const brokenServer = http.createServer(brokenApp);
    await new Promise((r) => brokenServer.listen(0, '127.0.0.1', r));
    r = await fetch(`http://127.0.0.1:${brokenServer.address().port}/api/v1/me/dock`, { headers: { authorization: `Bearer ${tokenOf(ana)}` } }).then((x) => x.json());
    assert.strictEqual(r.sources_partial, true, 'the counts are lower than the truth, and the answer says so');
    assert.deepStrictEqual(r.counts, { running: 0, waiting: 0, unread: 0 }, 'and it still answers');
    brokenServer.close();

    // The row is the person's own: it goes into their export and is erased with them (ADR-033).
    // The SDK's uncovered() guard (0.74.0) sees every table with a person-shaped column a service's account-data
    // module does not cover. Network is the hub and keeps its own rows in server/identity/account-data.js, so the
    // guard here is that dock_states is one of the tables Network must answer for.
    const personTables = await uncovered(db, {});
    assert.ok(personTables.includes('dock_states'), 'the guard sees dock_states: it names a person');
    const part = await accountData.networkPart(db, ana.id);
    const dockFile = part.files.find((f) => f.name === 'dock.json');
    assert.ok(dockFile, "ana's export carries his Dock state");
    const exported = dockFile.content;
    assert.strictEqual(exported.length, 1);
    assert.strictEqual(exported[0].subject, ana.subject_id, 'the export carries his own row');
    assert.strictEqual(asJson(exported[0].state).tab, 'chats', 'the exported state is the one ana stored');
    const bobPart = await accountData.networkPart(db, bob.id);
    assert.deepStrictEqual(bobPart.files.find((f) => f.name === 'dock.json').content.map((x) => x.subject), [bob.subject_id], "bob's export carries only his own row");

    // The merge (ADR-029) leaves the Dock with the surviving account.
    const survivor = await db.prepare('SELECT * FROM users WHERE id = ?').get(ana.id);
    await accountMerge.merge(db, bob, survivor, { initiatedBy: 'person' });
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM dock_states WHERE subject = ?').get(bob.subject_id)).n, 0, "the folded-in account's row is gone");
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM dock_states WHERE subject = ?').get(ana.subject_id)).n, 1, "the survivor keeps the row");

    // And the row is erased with the person.
    const delId = `del_${ids.ulid()}`;
    await db.prepare(`INSERT INTO account_deletions (id, user_id, subject, status, requested_at, delete_after) VALUES (?, ?, ?, 'scheduled', ?, ?)`)
        .run(delId, ana.id, ana.subject_id, '2026-10-30T12:00:00.000Z', '2026-11-29T12:00:00.000Z');
    const deletion = await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(delId);
    await accountData.erase(db, deletion, { now: Date.parse('2026-11-29T12:00:00Z') });
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM dock_states WHERE subject = ?').get(ana.subject_id)).n, 0, 'the Dock state is erased with the person');

    // The migration is expand-only.
    const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0031_dock_states.sql'), 'utf8');
    assert.match(migration, /^-- phase: expand$/m, 'the migration is expand-only');
} finally {
    server.close();
    console.log = log;
}
console.log('dock: ok');
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
