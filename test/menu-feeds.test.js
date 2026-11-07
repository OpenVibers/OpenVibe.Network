'use strict';
// The menu's "Choose your feeds" (server/menu-feeds, 2026-11-07): GET and PUT /api/v1/me/menu-feeds answer
// network.menu-feeds@1. The choice is the sites' menu cards a person picked, in order, and it follows them across
// every OpenVibe site because localStorage is per site.
//
// What this proves:
//   - a person who never chose gets { on: null }; a PUT stores the choice and a GET reads it back, order included;
//   - the body is checked against the contract: five cards, a bad id, a missing on, a non-array, an unknown field
//     and an over-long id are 400s with a clear detail, and nothing is stored;
//   - a session is needed, and one person never reads or writes another's choice;
//   - 60 writes a minute per person;
//   - CORS: https://openvibe.live may ask (preflight included), another origin is refused and its write never runs;
//   - the choice goes into the person's export and is erased with them;
//   - the migration is expand-only.
//   node --import ./test/helpers/pg-preload.mjs test/menu-feeds.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { ids, validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const menuFeedsMod = require('../server/menu-feeds');
const accountData = require('../server/identity/account-data');
const publicCors = require('../server/public-cors');
const authRoutes = require('../server/auth/routes');

(async () => {
const db = getDb();
const log = console.log; console.log = () => {};

const mk = async (name) => {
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id').run(name, `${name}@example.test`, 'x')).lastInsertRowid;
    await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const ana = await mk('feedsana');
const bob = await mk('feedsbob');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const tokenOf = (u) => authRoutes.signToken(u, keys.privateKey, config);

const menuFeeds = menuFeedsMod.createMenuFeeds({ db });
const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
// The CORS the whole app runs behind (server/index.js): the first-party allow-list, and a foreign origin refused.
const allowed = new Set(['https://openvibe.live', 'https://openvibe.network']);
const corsGuard = publicCors.originGuard((origin) => allowed.has(origin), { log: { warn() {} } });
app.use(publicCors.gate(publicCors.restrictedCors(corsGuard.origin)));
app.use(corsGuard.denied);
app.use('/api/v1/me/menu-feeds', menuFeedsMod.router({ menuFeeds, requireAuth }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${server.address().port}/api/v1/me/menu-feeds`;
const call = (method, body, { as = ana, origin = null } = {}) => fetch(api, {
    method,
    headers: { authorization: `Bearer ${tokenOf(as)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(origin ? { origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));

try {
    // Never chosen: { on: null } and nothing else, private and not cached.
    let r = await call('GET');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body, { on: null }, 'never chosen reads as no choice');
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');

    // A choice is stored whole, order included, and the answer is the contract.
    const two = ['today:today', 'games:new-worlds'];
    r = await call('PUT', { on: two });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(validate(menuFeedsMod.CONTRACT, r.body).valid, JSON.stringify(validate(menuFeedsMod.CONTRACT, r.body).errors));
    assert.deepStrictEqual(r.body.on, two);
    assert.ok(r.body.updated_at, 'the answer carries when it changed');
    r = await call('GET');
    assert.deepStrictEqual(r.body.on, two, 'the choice is stored');

    // Replacing and clearing: the order is the person's, and an empty array is a cleared choice.
    r = await call('PUT', { on: ['news:top', 'today:today'] });
    assert.deepStrictEqual(r.body.on, ['news:top', 'today:today'], 'the new order is the stored one');
    r = await call('PUT', { on: [] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.on, [], 'an empty array is a choice, not "never set"');
    assert.deepStrictEqual((await call('GET')).body.on, [], 'and it reads back');

    // The contract refuses a body, with the field and the fault in detail; nothing is stored.
    const before = (await call('GET')).body;
    for (const [body, why] of [
        [{ on: Array.from({ length: 5 }, (_, i) => `site${i}:card${i}`) }, 'five cards'],
        [{ on: ['Today:Top'] }, 'an upper-case id'],
        [{ on: ['today'] }, 'an id without a card'],
        [{ on: 'today:today' }, 'on is not an array'],
        [{}, 'no on'],
        [{ on: ['today:today'], extra: true }, 'a field the contract does not know'],
        [{ on: [`${'a'.repeat(31)}:card`] }, 'a site over 30 characters'],
    ]) {
        r = await call('PUT', body);
        assert.strictEqual(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.error, 'menu-feeds.invalid', why);
        assert.ok(typeof r.body.detail === 'string' && r.body.detail.length, `${why}: the detail says what is wrong`);
        assert.deepStrictEqual((await call('GET')).body, before, `${why}: nothing was stored`);
    }

    // A session is needed; another person's token reads and writes only their own choice.
    assert.strictEqual((await fetch(api, { method: 'GET' })).status, 401, 'a session is needed');
    assert.strictEqual((await fetch(api, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"on":[]}' })).status, 401, 'a session is needed to write');
    r = await call('GET', undefined, { as: bob });
    assert.deepStrictEqual(r.body, { on: null }, "bob has not chosen");
    r = await call('PUT', { on: ['live:live-now'] }, { as: bob });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.on, ['live:live-now'], "bob's own choice");
    assert.deepStrictEqual((await call('GET')).body.on, [], "bob's write left ana's choice alone");

    // CORS: https://openvibe.live may read, and its preflight is answered; another origin is refused, and its
    // write never runs the route.
    let cors = await fetch(api, { headers: { origin: 'https://openvibe.live', authorization: `Bearer ${tokenOf(ana)}` } });
    assert.strictEqual(cors.status, 200, 'openvibe.live may read the choice');
    assert.strictEqual(cors.headers.get('access-control-allow-origin'), 'https://openvibe.live', 'the answer names the origin');
    cors = await fetch(api, { method: 'OPTIONS', headers: { origin: 'https://openvibe.live', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' } });
    assert.ok(cors.status === 204 || cors.status === 200, `the PUT preflight is answered: ${cors.status}`);
    assert.strictEqual(cors.headers.get('access-control-allow-origin'), 'https://openvibe.live', 'the preflight names the origin');
    cors = await fetch(api, { headers: { origin: 'https://evil.example', authorization: `Bearer ${tokenOf(ana)}` } });
    assert.strictEqual(cors.status, 403, 'another origin is refused');
    assert.strictEqual((await cors.json()).code, 'cors.origin_denied');
    cors = await fetch(api, { method: 'PUT', headers: { origin: 'https://evil.example', authorization: `Bearer ${tokenOf(ana)}`, 'content-type': 'application/json' }, body: JSON.stringify({ on: ['news:top'] }) });
    assert.strictEqual(cors.status, 403, 'a cross-origin write never runs the route');
    assert.deepStrictEqual((await call('GET')).body.on, [], 'the refused write changed nothing');

    // 60 writes a minute per person (a small window here so the test is quick).
    const limitedMod = menuFeedsMod.createMenuFeeds({ db, writeLimit: 2 });
    const limitApp = express();
    Object.assign(limitApp.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    limitApp.use('/api/v1/me/menu-feeds', menuFeedsMod.router({ menuFeeds: limitedMod, requireAuth }));
    const limitServer = http.createServer(limitApp);
    await new Promise((r) => limitServer.listen(0, '127.0.0.1', r));
    const limitApi = `http://127.0.0.1:${limitServer.address().port}/api/v1/me/menu-feeds`;
    const limited = (body) => fetch(limitApi, { method: 'PUT', headers: { authorization: `Bearer ${tokenOf(bob)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual((await limited({ on: ['today:today'] })).status, 200, 'write 1');
    assert.strictEqual((await limited({ on: ['today:today'] })).status, 200, 'write 2');
    const over = await limited({ on: ['today:today'] });
    assert.strictEqual(over.status, 429, 'the third write in the minute is refused');
    assert.strictEqual((await over.json()).error, 'menu-feeds.rate_limited');
    limitServer.close();

    // The choice goes into the person's export, and it is erased with the person.
    const part = await accountData.networkPart(db, ana.id);
    const feedsFile = part.files.find((f) => f.name === 'menu-feeds.json');
    assert.ok(feedsFile, "ana's export carries her menu feeds");
    const storedFeeds = JSON.parse((await db.prepare('SELECT menu_feeds FROM user_preferences WHERE user_id = ?').get(ana.id)).menu_feeds);
    assert.deepStrictEqual(feedsFile.content, storedFeeds, 'the exported choice is the stored one');
    const bobPart = await accountData.networkPart(db, bob.id);
    assert.deepStrictEqual(bobPart.files.find((f) => f.name === 'menu-feeds.json').content.on, ['today:today'], "bob's export carries only his own choice");

    const delId = `del_${ids.ulid()}`;
    await db.prepare(`INSERT INTO account_deletions (id, user_id, subject, status, requested_at, delete_after) VALUES (?, ?, ?, 'scheduled', ?, ?)`)
        .run(delId, ana.id, ana.subject_id, '2026-11-07T12:00:00.000Z', '2026-12-07T12:00:00.000Z');
    const deletion = await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(delId);
    await accountData.erase(db, deletion, { now: Date.parse('2026-12-07T12:00:00Z') });
    assert.strictEqual(await db.prepare('SELECT menu_feeds FROM user_preferences WHERE user_id = ?').get(ana.id), undefined, 'the choice is erased with the person');

    // The migration is expand-only.
    const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0048_menu_feeds.sql'), 'utf8');
    assert.match(migration, /^-- phase: expand$/m, 'the migration is expand-only');
} finally {
    server.close();
    console.log = log;
}
console.log('menu-feeds: ok');
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
