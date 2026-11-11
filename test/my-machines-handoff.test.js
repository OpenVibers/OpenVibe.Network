'use strict';
// Network's apex sends signed-in /machines visitors to Link with a handoff ticket. openvibe.my keeps its
// signed-in Machines section and silently signs in visitors who arrive there without a session.
//   ov test test/my-machines-handoff.test.js   (or: node test/my-machines-handoff.test.js)
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createMyRoutes } = require('../server/my/routes');

(async () => {
const db = getDb();
await db.prepare("UPDATE oauth_clients SET client_secret = 'my-secret' WHERE client_id = 'my'").run();
await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (12, 'mymint', 'x')").run();

const stubSso = {
    router: () => express.Router(),
    verify: async (token) => (token === 'good-token' ? { id: 12, username: 'mymint' } : null),
};
const app = express();
app.use(await createMyRoutes({ db, config: {}, sso: stubSso }));
app.use((req, res) => res.status(404).end());
const server = http.createServer(app);

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const get = (path, cookie = '', host = 'openvibe.my') => new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) } }, res => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
    });

    // The account hub's own /machines route stays here and serves its Machines section.
    let r = await get('/machines', 'ov_token=good-token');
    assert.strictEqual(r.status, 200, 'signed in /machines stays on the account hub');
    assert.ok(r.body.includes('id="sec-machines"'));

    // Signed out: openvibe.my starts its silent sign-in with /machines as the return path.
    r = await get('/machines');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, '/auth/login?silent=1&next=%2Fmachines');
    r = await get('/machines', 'ov_token=nope');
    assert.strictEqual(r.status, 200, 'an existing session cookie reaches the account hub');

    // Network apex arrivals still get Link's signed-in handoff.
    r = await get('/machines', 'ov_token=good-token', 'openvibe.network');
    assert.ok(new URL(r.headers.location).searchParams.get('ov_handoff'));

    console.log('my-machines-handoff.test.js: all assertions passed');
    server.close();
    process.exit(0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
})();
