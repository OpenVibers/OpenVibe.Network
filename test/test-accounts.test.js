'use strict';
// Test accounts (migrations/0075_test_accounts.sql; server/auth/routes.js): a name the probe tooling signs up with
// (ovprobe_) is created already marked is_test, and an ordinary account is not. The flag is the identity authority's
// answer to every public surface's "leave test accounts out".
//   node test/test-accounts.test.js
const assert = require('assert');
const { bootServer } = require('./helpers/boot-server');

(async () => {
    const srv = await bootServer();
    try {
        const register = (username) => fetch(`${srv.base}/api/auth/register`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username, password: 'correct-horse-battery' }),
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
        const db = srv.app.locals.db;
        // The test's bootstrap profile may leave sign-ups closed; this test is about how a sign-up is marked.
        await db.prepare("INSERT INTO site_settings (key, value, type) VALUES ('registration_open', 'true', 'boolean') ON CONFLICT (key) DO UPDATE SET value = 'true'").run();

        let r = await register('ovprobe_registered');
        assert.strictEqual(r.status, 201, `register answered ${r.status}`);
        const probe = await db.prepare('SELECT username, is_test, subject_id FROM users WHERE lower(username) = ?').get('ovprobe_registered');
        assert.strictEqual(Number(probe.is_test), 1, 'the probe sign-up path marks the account as a test account');
        assert.ok(/^usr_/.test(probe.subject_id), 'it is still a real account with a subject');

        r = await register('ordinary_person');
        assert.strictEqual(r.status, 201);
        const person = await db.prepare('SELECT username, is_test FROM users WHERE lower(username) = ?').get('ordinary_person');
        assert.strictEqual(Number(person.is_test), 0, 'an ordinary account is never marked as a test account');

        console.log('test accounts: the probe sign-up path marks is_test; an ordinary registration does not');
    } catch (err) {
        console.error(err);
        console.error(srv.logs());
        process.exitCode = 1;
    } finally {
        await srv.stop();
    }
    process.exit(process.exitCode || 0);
})();
