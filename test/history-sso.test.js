'use strict';
// Cross-site history API and the sign-in-everywhere target list.
//   node test/history-sso.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const { createHistoryRoutes, allowedUrl, serviceFromUrl } = require('../server/history/routes');
const { ssoTargets, safeNext } = require('../server/auth/sso-targets');

// ── pure helpers ─────────────────────────────────────────────
assert.strictEqual(allowedUrl('https://json.openvibe.tools/?x=1&token=abc#frag'), 'https://json.openvibe.tools/?x=1', 'tokens + fragments stripped');
assert.strictEqual(allowedUrl('https://evil.example.com/'), null, 'off-network URLs are dropped');
assert.strictEqual(allowedUrl('javascript:alert(1)'), null);
assert.deepStrictEqual(serviceFromUrl('https://pastes.openvibe.tools/p/x'), { service: 'tools', sub: 'pastes' });
assert.deepStrictEqual(serviceFromUrl('https://openvibe.live/@someone'), { service: 'live', sub: null });
assert.deepStrictEqual(serviceFromUrl('https://ingest.openre.stream/'), { service: 'openre', sub: 'ingest' });

const t = ssoTargets({});
assert.ok(t.find(x => x.id === 'live') && t.find(x => x.id === 'tools') && t.find(x => x.id === 'community'), 'default targets');
assert.ok(t.every(x => x.login.includes('{next}')), 'every login hop carries the continuation');
assert.deepStrictEqual(ssoTargets({ OV_SSO_TARGETS_DISABLED: 'games, community' }).map(x => x.id), ['live', 'tools'], 'disabled targets are dropped');
assert.strictEqual(safeNext('https://openvibe.live/@x?y=1'), 'https://openvibe.live/@x?y=1');
assert.strictEqual(safeNext('https://phish.example/'), '/', 'foreign hosts fall back to /');
assert.strictEqual(safeNext('//evil'), '/');
assert.strictEqual(safeNext('/my#linked'), '/my#linked');

// ── API against an in-memory database ────────────────────────
const db = new Database(':memory:');
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, is_anon INTEGER DEFAULT 0);
         INSERT INTO users (id, username) VALUES (1, 'alex'), (2, 'other');`);
const users = { a: { id: 1, username: 'alex' }, b: { id: 2, username: 'other' }, anon: { id: 3, username: 'anon', is_anon: true } };
const requireAuth = (req, res, next) => { const u = users[req.headers['x-user']]; if (!u) return res.status(401).json({ error: 'no' }); req.user = u; next(); };
const app = express();
app.use(express.json());
app.use('/api/history', createHistoryRoutes(db, requireAuth));
const server = http.createServer(app);

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, path, user, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    let r = await call('POST', '/api/history', 'a', { type: 'tool', title: 'JSON Formatter', url: 'https://json.openvibe.tools/', icon: 'fa-code' });
    assert.strictEqual(r.status, 201);
    r = await call('POST', '/api/history', 'a', { type: 'tool', title: 'JSON Formatter (again)', url: 'https://json.openvibe.tools/' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.merged, true, 'same URL within the window merges');
    r = await call('POST', '/api/history', 'a', { type: 'stream', title: 'goosely live', url: 'https://openvibe.live/@goosely' });
    assert.strictEqual(r.status, 201);
    r = await call('POST', '/api/history', 'a', { type: 'page', title: 'nope', url: 'https://evil.example/' });
    assert.strictEqual(r.status, 400, 'off-network URL rejected');
    r = await call('POST', '/api/history', 'anon', { type: 'page', title: 'x', url: 'https://openvibe.live/' });
    assert.strictEqual(r.status, 403, 'anonymous sessions keep no history');
    r = await call('POST', '/api/history', null, { type: 'page', title: 'x', url: 'https://openvibe.live/' });
    assert.strictEqual(r.status, 401);

    r = await call('GET', '/api/history?limit=10', 'a');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 2);
    assert.strictEqual(r.body.items[0].title, 'goosely live', 'newest first');
    assert.strictEqual(r.body.items[1].hits, 2, 'merged entry counted twice');
    assert.strictEqual(r.body.items[1].service_label, 'json.Tools');
    assert.deepStrictEqual(r.body.services.map(s => s.service).sort(), ['live', 'tools']);
    r = await call('GET', '/api/history?service=live', 'a');
    assert.strictEqual(r.body.items.length, 1);
    r = await call('GET', '/api/history?q=json', 'a');
    assert.strictEqual(r.body.items.length, 1);
    r = await call('GET', '/api/history', 'b');
    assert.strictEqual(r.body.total, 0, 'other accounts see nothing');

    // pause → nothing recorded
    r = await call('PUT', '/api/history/settings', 'a', { paused: true });
    assert.strictEqual(r.body.paused, true);
    r = await call('POST', '/api/history', 'a', { type: 'page', title: 'paused', url: 'https://openvibe.games/' });
    assert.strictEqual(r.body.paused, true);
    r = await call('GET', '/api/history', 'a'); assert.strictEqual(r.body.total, 2); assert.strictEqual(r.body.paused, true);
    await call('PUT', '/api/history/settings', 'a', { paused: false });

    // delete one / all, ownership enforced
    const id = r.body.items[0].id;
    r = await call('DELETE', `/api/history/${id}`, 'b'); assert.strictEqual(r.status, 404, 'cannot delete another account\'s entry');
    r = await call('DELETE', `/api/history/${id}`, 'a'); assert.strictEqual(r.status, 200);
    r = await call('DELETE', '/api/history', 'a'); assert.strictEqual(r.body.deleted, 1);
    r = await call('GET', '/api/history', 'a'); assert.strictEqual(r.body.total, 0);

    server.close();
    console.log('history + sso targets: all checks passed');
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
