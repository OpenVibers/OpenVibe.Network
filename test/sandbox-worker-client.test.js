'use strict';
/**
 * The chat plays sandbox worker's own Network service client (Agent Streams S6).
 *
 * The worker is not Codes: it runs as its own unprivileged user with its own OAuth client, so a token it holds names
 * `codes-sandbox` and Live can tell it from a person's Codes session. The client is seeded with the other service
 * clients (server/db/database.js), has no redirect URIs (client_credentials only), and its one grant is
 * live.agent_sandbox.register for the audience openvibe.live. Its secret is never printed here: the owner reads it
 * from Network's admin (the `oauth_clients` row) into the worker's network-client-secret credential.
 *
 *   node test/sandbox-worker-client.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { getDb, seedDb } = require('../server/db/database');

const CLIENT = 'codes-sandbox';
const CAP = 'live.agent_sandbox.register';
const AUDIENCE = 'openvibe.live';
const ISSUER = 'https://openvibe.network';

(async () => {
    const principals = require('../server/identity/principals');
    const db = getDb();
    const quiet = console.log;
    console.log = () => {};
    await seedDb(db, { log: { log() {}, warn() {}, error() {} } });
    console.log = quiet;

    const client = await db.prepare('SELECT client_id, name, redirect_uris, client_secret, is_first_party FROM oauth_clients WHERE client_id = ?').get(CLIENT);
    assert.ok(client, 'the seed creates the worker as its own service client');
    assert.strictEqual(client.redirect_uris, '[]', 'it has no redirect URIs: client_credentials only');
    assert.strictEqual(Number(client.is_first_party), 1, 'it is first-party');
    assert.ok(client.client_secret && String(client.client_secret).length >= 20, 'the seed gives it a secret (stored, never logged)');

    const grants = await db.prepare('SELECT capability, audience, namespaces, granted_by, revoked_at FROM principal_grants WHERE client_id = ?').all(CLIENT);
    assert.deepStrictEqual(grants.map((g) => g.capability), [CAP], 'its only grant is the sandbox registration');
    const row = grants[0];
    assert.strictEqual(row.audience, AUDIENCE, 'the grant is for Live alone');
    assert.deepStrictEqual(JSON.parse(row.namespaces || '[]'), [], 'it is unscoped');
    assert.strictEqual(row.granted_by, 'default');
    assert.strictEqual(row.revoked_at, null);

    // The row is a default grant, held by no other principal.
    assert.deepStrictEqual(principals.DEFAULT_GRANTS.find((g) => g[0] === CLIENT && g[1] === CAP && g[2] === AUDIENCE),
        [CLIENT, CAP, AUDIENCE, []]);
    assert.ok(!principals.DEFAULT_GRANTS.some((g) => g[1] === CAP && g[0] !== CLIENT), 'no other service holds live.agent_sandbox.register');
    assert.ok(!principals.DEFAULT_GRANTS.some((g) => g[1] === CAP && g[2] !== AUDIENCE), 'the capability is granted for Live and no other audience');

    // The pinned Contracts release names the capability, and gives it Live as its owner.
    const cap = contracts.capabilities.get(CAP);
    assert.ok(cap, 'the pinned contracts know ' + CAP);
    assert.strictEqual(cap.owner, 'live');
    assert.ok(cap.implementedBy.includes('POST /api/streams/agent/:id/plays/worker'));

    // A client_credentials token for openvibe.live carries exactly the registration capability.
    const keys = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const issued = await principals.issueToken(db, {
        clientId: CLIENT, clientSecret: client.client_secret, audience: AUDIENCE, privateKey: keys.privateKey, issuer: ISSUER,
    });
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    const claims = contracts.serviceAuth.verifyServiceToken(issued.body.access_token, {
        publicKey: keys.publicKey, issuer: ISSUER, audience: AUDIENCE,
    });
    assert.ok(claims.ok, claims.reason);
    assert.deepStrictEqual(claims.claims.cap, [CAP], 'the token carries the registration capability and nothing else');
    assert.strictEqual(claims.claims.sub, `svc:${CLIENT}`, 'the token names the worker, not Codes');
    assert.strictEqual(claims.claims.on_behalf_of, undefined, 'the person is named by X-OV-Subject on the request, not minted into the token');

    // A token for another audience is refused: this client has nothing there.
    const elsewhere = await principals.issueToken(db, {
        clientId: CLIENT, clientSecret: client.client_secret, audience: 'openvibe.chat', privateKey: keys.privateKey, issuer: ISSUER,
    });
    assert.strictEqual(elsewhere.status, 400, 'no grants for openvibe.chat');
    assert.match(String(elsewhere.body.error_description), /no grants/);

    console.log('sandbox worker client: ' + CAP + ' for ' + AUDIENCE + ', client_credentials only');
})().catch((err) => { console.error(err); process.exit(1); });
