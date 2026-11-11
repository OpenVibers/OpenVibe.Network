'use strict';
// One-time cross-site sign-in handoff tickets: issue → redeem → standard code exchange.
//   ov test test/handoff.test.js   (or: node test/handoff.test.js)
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const { hashTicket } = require('../server/auth/handoff');

(async () => {
const db = getDb();
await db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'tools-secret' WHERE client_id = 'tools'").run();
await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'viewer', 'x')").run();
await db.prepare("INSERT INTO users (id, username, password_hash, is_banned) VALUES (8, 'banned1', 'x', 1)").run();
await db.prepare("INSERT INTO users (id, username, password_hash, is_anon) VALUES (9, 'guest1', 'x', 1)").run();
await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (10, 'revoked1', 'x')").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h', refreshTokenExpiry: '30d' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
const requireAuth = require('../server/auth/session').makeRequireAuth(
    async () => ({ db, publicKey: keys.publicKey, config: app.locals.config }),
    require('../server/auth/routes').signToken);
app.use('/api/v1/handoff', require('../server/auth/handoff').router({ db, requireAuth }));
app.use('/oauth', require('../server/auth/oauth-routes'));
const server = http.createServer(app);

const REDIRECT = 'https://openvibe.live/api/auth/callback';
const tokenFor = (id, name) => jwt.sign({ sub: id, id, username: name }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '5m' });

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, token) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
        .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const userToken = tokenFor(7, 'viewer');

    // No session mints nothing.
    let r = await post('/api/v1/handoff/tickets', { client_id: 'live', redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 401, 'issue without auth is 401');

    // Banned accounts and guests cannot mint.
    r = await post('/api/v1/handoff/tickets', { client_id: 'live', redirect_uri: REDIRECT }, tokenFor(8, 'banned1'));
    assert.strictEqual(r.status, 403, 'banned user cannot mint');
    r = await post('/api/v1/handoff/tickets', { client_id: 'live', redirect_uri: REDIRECT }, tokenFor(9, 'guest1'));
    assert.strictEqual(r.status, 403, 'guest cannot mint');

    // Unknown client and unregistered redirect are refused.
    r = await post('/api/v1/handoff/tickets', { client_id: 'nope', redirect_uri: REDIRECT }, userToken);
    assert.strictEqual(r.status, 400, 'unknown destination client is 400');
    r = await post('/api/v1/handoff/tickets', { client_id: 'live', redirect_uri: 'https://evil.example/cb' }, userToken);
    assert.strictEqual(r.status, 400, 'unregistered redirect_uri is 400');

    // A ticket mints: opaque, short-lived, stored hashed only.
    r = await post('/api/v1/handoff/tickets', { client_id: 'live', redirect_uri: REDIRECT }, userToken);
    assert.strictEqual(r.status, 200, 'issue is 200');
    assert.ok(r.body.ticket.startsWith('ovh_'), 'ticket carries its prefix');
    assert.strictEqual(r.body.expires_in, 60);
    const row = await db.prepare('SELECT * FROM handoff_tickets WHERE ticket_hash = ?').get(hashTicket(r.body.ticket));
    assert.ok(row && !row.used, 'ticket row stored hashed');
    assert.strictEqual(row.client_id, 'live');
    const dump = await db.prepare('SELECT * FROM handoff_tickets WHERE ticket_hash = ?').get(hashTicket(r.body.ticket));
    assert.ok(!JSON.stringify(dump).includes(r.body.ticket), 'plaintext ticket never stored');

    // Redeem refuses a bad client secret, then yields a standard code on the exact binding.
    const ticket = r.body.ticket;
    r = await post('/api/v1/handoff/redeem', { ticket, client_id: 'live', client_secret: 'wrong', redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 401, 'wrong client secret is 401');
    r = await post('/api/v1/handoff/redeem', { ticket, client_id: 'tools', client_secret: 'tools-secret', redirect_uri: 'https://openvibe.tools/auth/callback' });
    assert.strictEqual(r.status, 400, 'another client cannot redeem a live ticket');
    r = await post('/api/v1/handoff/redeem', { ticket, client_id: 'live', client_secret: 'live-secret', redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 200, 'redeem is 200');
    assert.ok(/^[0-9a-f]{64}$/.test(r.body.code), 'redeem yields a code');
    const code = r.body.code;

    // The code exchanges through the unchanged token endpoint for the destination's session.
    r = await post('/oauth/token', { grant_type: 'authorization_code', client_id: 'live', client_secret: 'live-secret', code, redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 200, 'code exchanges for tokens');
    assert.ok(r.body.access_token, 'access token issued');
    assert.strictEqual(r.body.user.username, 'viewer');

    // Replay is dead, and expiry is enforced.
    r = await post('/api/v1/handoff/redeem', { ticket, client_id: 'live', client_secret: 'live-secret', redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 400, 'used ticket is refused');
    r = await post('/api/v1/handoff/tickets', { client_id: 'live', redirect_uri: REDIRECT }, userToken);
    const stale = r.body.ticket;
    await db.prepare("UPDATE handoff_tickets SET expires_at = '2000-01-01T00:00:00.000Z' WHERE ticket_hash = ?").run(hashTicket(stale));
    r = await post('/api/v1/handoff/redeem', { ticket: stale, client_id: 'live', client_secret: 'live-secret', redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 400, 'expired ticket is refused');

    // A password change (token_valid_after past issuance... here set after) revokes outstanding tickets.
    r = await post('/api/v1/handoff/tickets', { client_id: 'live', redirect_uri: REDIRECT }, tokenFor(10, 'revoked1'));
    const revoked = r.body.ticket;
    await db.prepare("UPDATE users SET token_valid_after = '2999-01-01 00:00:00' WHERE id = 10").run();
    r = await post('/api/v1/handoff/redeem', { ticket: revoked, client_id: 'live', client_secret: 'live-secret', redirect_uri: REDIRECT });
    assert.strictEqual(r.status, 400, 'post-issuance revocation is refused');

    console.log('handoff.test.js: all assertions passed');
    server.close();
    process.exit(0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
})();
