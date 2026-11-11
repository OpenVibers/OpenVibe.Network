'use strict';
// The hub's old paths here mint a one-time handoff ticket for link-web when the browser is signed in here,
// so openvibe.link signs them in with no round trip. Signed out, the plain hop lands on silent sign-in.
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

    // Signed in here: the hop carries a ticket minted for link-web.
    let r = await get('/machines', 'ov_token=good-token');
    assert.strictEqual(r.status, 302, 'signed in 302s to the hub');
    const to = new URL(r.headers.location);
    assert.strictEqual(to.origin + to.pathname, 'https://openvibe.link/machines');
    assert.ok(/^ovh_[A-Za-z0-9_-]{20,200}$/.test(to.searchParams.get('ov_handoff')), 'a ticket rides along');

    // Signed out (or a bad cookie): the plain hop, which lands on the hub's silent sign-in.
    r = await get('/machines');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, 'https://openvibe.link/machines', 'no ticket when signed out');
    r = await get('/machines', 'ov_token=nope');
    assert.strictEqual(r.headers.location, 'https://openvibe.link/machines', 'no ticket on a bad session');

    // The old Network path mints the same way.
    r = await get('/machines', 'ov_token=good-token', 'openvibe.network');
    assert.ok(new URL(r.headers.location).searchParams.get('ov_handoff'), 'apex arrivals mint too');

    console.log('my-machines-handoff.test.js: all assertions passed');
    server.close();
    process.exit(0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
})();
