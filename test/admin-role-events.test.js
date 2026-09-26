'use strict';
// WS-B task 2 step 5: an admin role change reaches Live (and every consumer) as network.user.updated with
// `changed` naming role (the users trigger, server/identity/profile-events.js), not as a key-only push to
// Live's retired POST /internal/user-role. Both admin paths are covered: PUT /users/:id/role (up and down)
// and the owner's POST /users/grant-admin.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-admin-role-events-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
const profile = require('../server/identity/profile-events');
profile.ensureSchema(db);
profile.drain(db);
db.prepare('DELETE FROM network_event_outbox').run();

delete process.env.OWNER_USERNAME;   // the default owner, 'goosely'
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const MIA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
db.prepare("INSERT INTO users (id, username, password_hash, subject_id, role) VALUES (1, 'goosely', 'x', ?, 'admin')").run(OWNER);
db.prepare("INSERT INTO users (id, username, password_hash, subject_id, role) VALUES (2, 'mia', 'x', ?, 'user')").run(MIA);
profile.drain(db);
db.prepare('DELETE FROM network_event_outbox').run();
const events = () => db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope))
    .filter((e) => e.event_type === 'network.user.updated');

// Any outbound call the admin routes make is recorded; none may go to Live's retired route.
const outbound = [];
const realFetch = global.fetch;
global.fetch = (url, opts) => { outbound.push(String(url)); return Promise.resolve(new Response('{}', { status: 200 })); };

const createAdminRoutes = require('../server/admin/routes');
const owner = db.prepare('SELECT * FROM users WHERE id = 1').get();
const app = express();
app.use(express.json());
app.use('/api/admin', createAdminRoutes(db, {}, {}, (req, res, next) => { req.user = owner; next(); }));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/admin`;
    const call = (method, p, body) => realFetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const roleEvent = (n, role) => {
        assert.strictEqual(profile.drain(db), 1, 'one event for the change');
        const ev = events();
        assert.strictEqual(ev.length, n);
        const e = ev[n - 1];
        assert.ok(validate('events.event-envelope@1', e).valid);
        assert.ok(validate('network.user.updated@1', e.payload).valid);
        assert.deepStrictEqual([e.subject.id, e.payload.role, e.payload.changed], [MIA, role, ['role']]);
    };
    try {
        let r = await call('PUT', '/users/2/role', { role: 'global_mod' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        roleEvent(1, 'global_mod');
        r = await call('PUT', '/users/2/role', { role: 'user' });
        assert.strictEqual(r.status, 200);
        roleEvent(2, 'user');   // a downgrade too: Live applies it from the event
        r = await call('POST', '/users/grant-admin', { id: 2 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        roleEvent(3, 'admin');
        assert.deepStrictEqual(outbound.filter((u) => /user-role/.test(u)), [], 'no push to Live\'s retired /internal/user-role');
        const src = fs.readFileSync(path.join(__dirname, '../server/admin/routes.js'), 'utf8');
        assert.ok(!/pushRoleToStreamer|fetch\([^)]*user-role/.test(src), 'the push is gone from the admin routes');
        console.log('admin role events: all checks passed');
    } finally {
        global.fetch = realFetch;
        server.close();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
