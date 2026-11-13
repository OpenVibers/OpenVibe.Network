'use strict';
// A14 (plan 2026-11-13 Y.1): an account marked users.is_test is visible as a Test account — in the admin user
// list, in the page of the account itself. The flag already reached the admin API through the identity
// projection; what was missing was the badge, so an operator could not tell a probe from a member.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { getDb } = require('../server/db/database');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-admin-test-badge-'));
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;

    const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
    const PROBE = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, role, is_test) VALUES (1, 'goosely', 'x', ?, 'admin', 0)").run(OWNER);
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, role, is_test) VALUES (2, 'ovprobe_probe', 'x', ?, 'user', 1)").run(PROBE);
    await db.prepare("INSERT INTO users (id, username, password_hash, subject_id, role, is_test) VALUES (3, 'mira', 'x', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPZ', 'user', 0)").run();

    const createAdminRoutes = require('../server/admin/routes');
    const owner = await db.prepare('SELECT * FROM users WHERE id = 1').get();
    const app = express();
    app.use(express.json());
    app.use('/api/admin', createAdminRoutes(db, {}, {}, (req, res, next) => { req.user = owner; next(); }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/admin`;
    try {
        const res = await fetch(base + '/users');
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.ok(body.ok, 'the user list answers');
        const probe = body.users.find((u) => u.username === 'ovprobe_probe');
        const mira = body.users.find((u) => u.username === 'mira');
        assert.ok(probe, 'the test account is in the list');
        assert.strictEqual(Number(probe.is_test), 1, 'the list says which accounts are test accounts');
        assert.strictEqual(Number(mira.is_test), 0, 'and says which are not');
    } finally {
        await new Promise((r) => server.close(r));
    }

    // The badge itself: the admin table and the account's own page.
    const users = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'users.js'), 'utf8');
    assert.ok(/u\.is_test \? '<span class="badge badge-test"/.test(users), 'the admin user list shows the Test badge');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'admin.css'), 'utf8');
    assert.ok(/\.badge-test\{/.test(css), 'the badge has its own colour');

    const { renderPage } = require('../server/profile/public');
    const testPage = renderPage({ username: 'ovprobe_probe', display_name: 'Probe', created_at: '2026-11-01 10:00:00', profile_public: 0, is_test: 1 });
    assert.ok(testPage.includes('pf-test-tag') && testPage.includes('Test account'), 'the account page says it is a test account');
    const plainPage = renderPage({ username: 'mira', display_name: 'Mira', created_at: '2026-11-01 10:00:00', profile_public: 0, is_test: 0 });
    assert.ok(!plainPage.includes('Test account'), 'a member page does not say it is a test account');

    console.log('admin-test-badge: the admin user list and the account page mark users.is_test as a Test account');
})().catch((e) => { console.error(e); process.exit(1); });
