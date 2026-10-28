'use strict';
// The bell's tabs (server/notifications/tabs.js): GET /api/notifications?tab= lists what each tab holds (Mentions by
// type, Live and Deals & alerts and System by category, Agents by type and prefix), an unknown tab is All, tab and
// unread_only combine, and GET /api/notifications/unread-by-tab counts each tab's unread notices.
//   node --import ./test/helpers/pg-preload.mjs test/notification-tabs.test.js
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { getDb } = require('../server/db/database');
const { NotificationService } = require('../server/notifications/notification-service');
const createNotificationRoutes = require('../server/notifications/routes');
const tabs = require('../server/notifications/tabs');
const { signToken } = require('../server/auth/routes');

(async () => {
const db = getDb();
const log = console.log; console.log = () => {};
await db.prepare("INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (41, 'tabby', 'tabby@example.test', 'x', 1)").run();
const notifications = new NotificationService(db);

// The pure parts.
assert.strictEqual(tabs.tabWhere('all'), null, 'All is no filter');
assert.strictEqual(tabs.tabWhere('nope'), null, 'an unknown tab is All');
assert.deepStrictEqual(tabs.tabWhere('agents').params, ['CONFIRMATION_REQUESTED', 'AGENT\\_%', 'RUN\\_%'], 'prefixes escape LIKE wildcards');
assert.strictEqual(tabs.inTab('agents', 'system', 'AGENT_TASK_DONE'), true);
assert.strictEqual(tabs.inTab('mentions', 'social', 'FOLLOW'), false, 'a follow is not a mention');
assert.deepStrictEqual(tabs.countsByTab([{ category: 'social', type: 'MENTION', count: '2' }, { category: 'stream', type: 'STREAM_LIVE', count: 3 }]),
    { all: 5, mentions: 2, live: 3, alerts: 0, system: 0, agents: 0 }, 'counts add up per tab, string counts included');

const made = {};
for (const [key, type, category] of [
    ['mention', 'MENTION', 'social'], ['reply', 'CONTENT_REPLY', 'social'], ['dm', 'DIRECT_MESSAGE', 'chat'], ['follow', 'FOLLOW', 'social'],
    ['live', 'STREAM_LIVE', 'stream'], ['deal', 'DEAL_WATCH_MATCH', 'service'], ['login', 'NEW_LOGIN', 'system'],
    ['ops', 'OPERATOR_ALERT', 'admin'], ['confirm', 'CONFIRMATION_REQUESTED', 'system'], ['agent', 'AGENT_TASK_DONE', 'system'], ['level', 'LEVEL_UP', 'game'],
]) {
    made[key] = await notifications.create({ user_id: 41, type, category, title: `${key} notice`, service: 'network' });
    assert.ok(made[key], `${key} is created`);
}

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const user = await db.prepare('SELECT * FROM users WHERE id = 41').get();
const token = signToken(user, keys.privateKey, config);
const app = express();
app.use(express.json());
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/api/notifications', createNotificationRoutes(db, notifications, requireAuth));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (path) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: await r.json() }));
const titles = (r) => r.body.notifications.map((n) => n.title.replace(' notice', '')).sort();

try {
    assert.deepStrictEqual(titles(await get('/api/notifications?tab=mentions')), ['dm', 'mention', 'reply'], 'Mentions: what people said to you');
    assert.deepStrictEqual(titles(await get('/api/notifications?tab=live')), ['live']);
    assert.deepStrictEqual(titles(await get('/api/notifications?tab=alerts')), ['deal'], 'Deals & alerts: the service category');
    assert.deepStrictEqual(titles(await get('/api/notifications?tab=system')), ['agent', 'confirm', 'login', 'ops'], 'System: system, admin and moderation');
    assert.deepStrictEqual(titles(await get('/api/notifications?tab=agents')), ['agent', 'confirm'], 'Agents: approvals and AGENT_ work');
    assert.strictEqual((await get('/api/notifications?tab=bogus')).body.notifications.length, 11, 'an unknown tab lists everything');
    const tabTotal = await get('/api/notifications?tab=mentions&limit=2');
    assert.deepStrictEqual([tabTotal.body.notifications.length, tabTotal.body.has_more, Number(tabTotal.body.total)], [2, true, 3], 'paging and the total follow the tab');

    let counts = await get('/api/notifications/unread-by-tab');
    assert.strictEqual(counts.status, 200);
    assert.deepStrictEqual(counts.body.tabs, { all: 11, mentions: 3, live: 1, alerts: 1, system: 4, agents: 2 });

    await notifications.markReadMany([made.mention.id, made.agent.id], 41);
    assert.deepStrictEqual(titles(await get('/api/notifications?tab=mentions&unread_only=1')), ['dm', 'reply'], 'tab and unread_only combine');
    counts = await get('/api/notifications/unread-by-tab');
    assert.deepStrictEqual(counts.body.tabs, { all: 9, mentions: 2, live: 1, alerts: 1, system: 3, agents: 1 }, 'read notices leave the counts');

    assert.strictEqual((await fetch(base + '/api/notifications/unread-by-tab')).status, 401, 'counts need a session');
} finally {
    server.close();
    console.log = log;
}
console.log('notification-tabs: ok');
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
