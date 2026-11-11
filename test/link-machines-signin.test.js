'use strict';
// openvibe.link/machines arrival: a handoff ticket signs the browser in with no round trip, a session
// serves the hub, nobody home starts the silent sign-in, and the login page only shows the truly signed out.
//   ov test test/link-machines-signin.test.js   (or: node test/link-machines-signin.test.js)
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const { issueTicketForUser } = require('../server/auth/handoff');
const { createLinkRoutes } = require('../server/link/routes');

(async () => {
const db = getDb();
await db.prepare("UPDATE oauth_clients SET client_secret = 'link-secret' WHERE client_id = 'link-web'").run();
await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (11, 'linkarr', 'x')").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, nodeEnv: 'test', jwt: { issuer: ISSUER, accessTokenExpiry: '1h', refreshTokenExpiry: '30d' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use(createLinkRoutes({ db, config: app.locals.config, publicKey: keys.publicKey, log: { warn() {}, log() {} } }));
app.use((req, res) => res.status(404).end());
const server = http.createServer(app);

const DEST = 'https://openvibe.link/auth/callback';
const tokenFor = (id, name) => jwt.sign({ sub: id, id, username: name }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '5m' });

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (path, cookie = '', host = 'openvibe.link') => new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) } }, res => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
    });
    const cookiesOf = (res) => (res.headers['set-cookie'] || []).map(c => c.split(';')[0]);
    const session = tokenFor(11, 'linkarr');

    // A ticket arrival signs in with no round trip and scrubs the ticket from the address bar.
    const { hashTicket } = require('../server/auth/handoff');
    const { ticket } = await issueTicketForUser(db, { userId: 11, clientId: 'link-web', redirectUri: DEST, source: 'openvibe.my' });
    let r = await get(`/machines?ov_handoff=${encodeURIComponent(ticket)}`);
    assert.strictEqual(r.status, 302, 'ticket arrival redirects');
    assert.strictEqual(r.headers.location, '/machines', 'the ticket leaves the address bar');
    const jar = cookiesOf(r).join(';');
    assert.ok(jar.includes('ov_token=') && jar.includes('ov_sso_hint=account'), 'a link-web session is set');
    const used = await db.prepare('SELECT used FROM handoff_tickets WHERE ticket_hash = ?').get(hashTicket(ticket));
    assert.strictEqual(used.used, 1, 'the ticket is consumed');

    // A signed-in arrival serves the hub; the ticket is never touched.
    const { ticket: spare } = await issueTicketForUser(db, { userId: 11, clientId: 'link-web', redirectUri: DEST });
    r = await get(`/machines?ov_handoff=${encodeURIComponent(spare)}`, `ov_token=${session}`);
    assert.strictEqual(r.status, 200, 'a session serves the hub');
    assert.ok(r.body.includes('sec-machines'), 'the hub page');
    // The hub is the Machines section alone: marked for my.css, titled for Link, with one h1 (the section's).
    assert.ok(r.body.includes('<body class="link-hub">'), 'the body is marked link-hub');
    assert.ok(r.body.includes('<title>Your machines - OpenVibe Link</title>'), 'titled for Link');
    assert.strictEqual((r.body.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
    assert.ok(/<h1 class="mc-title">[^]*?Your machines<\/h1>/.test(r.body), 'and it is the machines heading');
    const spareRow = await db.prepare('SELECT used FROM handoff_tickets WHERE ticket_hash = ?').get(hashTicket(spare));
    assert.strictEqual(spareRow.used, 0, 'no silent account switch: the ticket stays unused');

    // Nobody home starts the silent sign-in, keeping pair intent; back as a guest lands on the hub.
    r = await get('/machines?pair=1');
    assert.strictEqual(r.status, 302, 'no session starts the silent sign-in');
    assert.ok(r.headers.location.startsWith('/auth/login?silent=1&next=%2Fmachines%3Fpair%3D1'), `silent login keeps pair intent: ${r.headers.location}`);
    r = await get('/machines?sso=none');
    assert.strictEqual(r.status, 200, 'a guest (sso=none) lands on the hub, not a loop');

    // A guest hint is never signed in, even with a fresh ticket.
    const { ticket: guestTicket } = await issueTicketForUser(db, { userId: 11, clientId: 'link-web', redirectUri: DEST });
    r = await get(`/machines?ov_handoff=${encodeURIComponent(guestTicket)}`, 'ov_sso_hint=guest');
    assert.strictEqual(r.status, 302, 'a guest stays a guest');
    assert.ok(r.headers.location.startsWith('/auth/login?'), 'guests go quiet, not into an account');
    assert.ok(!cookiesOf(r).join(';').includes('ov_token='), 'no session for a guest');
    const guestRow = await db.prepare('SELECT used FROM handoff_tickets WHERE ticket_hash = ?').get(hashTicket(guestTicket));
    assert.strictEqual(guestRow.used, 0, 'the guest ticket stays unused');

    // A forged ticket breaks nothing: the silent sign-in starts instead.
    r = await get('/machines?ov_handoff=ovh_forged');
    assert.strictEqual(r.status, 302);
    assert.ok(r.headers.location.startsWith('/auth/login?silent=1'), 'a bad ticket falls through to silent sign-in');

    // /pair lands on the hub with the intent in the query; other hosts fall through.
    r = await get('/pair');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, 'https://openvibe.link/machines?pair=1', '/pair keeps pairing intent');
    r = await get('/machines', '', 'openvibe.network');
    assert.strictEqual(r.status, 404, 'other hosts fall through');

    console.log('link-machines-signin.test.js: all assertions passed');
    server.close();
    process.exit(0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
})();
