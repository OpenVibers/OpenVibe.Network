'use strict';
/**
 * The orchestrator's own Network service client (2026-11-07).
 *
 * The agent runs coordinator records the editorial queue's AI editor decision on Blog, News and Wiki. It does so as
 * itself — a svc: principal — never for a person: a token it holds names `orchestrator` and carries exactly that
 * service's review capability. The client is seeded with the other service clients (server/db/database.js), has no
 * redirect URIs (client_credentials only), and its three grants are in server/identity/principals.js: exactly one per
 * service, each for its own service's audience, never a wildcard.
 *
 *   node test/orchestrator-review-client.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { getDb, seedDb } = require('../server/db/database');

const CLIENT = 'orchestrator';
const GRANTS = [
    ['blog.review.ai_editor', 'openvibe.blog', 'POST /api/v1/posts/:id/reviews'],
    ['news.review.ai_editor', 'openvibe.news', 'POST /api/v1/stories/:id/reviews'],
    ['wiki.review.ai_editor', 'openvibe.wiki', 'POST /api/v1/pages/:id/revisions/:n/review'],
];
const ISSUER = 'https://openvibe.network';

(async () => {
    const principals = require('../server/identity/principals');
    const db = getDb();
    const quiet = console.log;
    console.log = () => {};
    await seedDb(db, { log: { log() {}, warn() {}, error() {} } });
    console.log = quiet;

    const client = await db.prepare('SELECT client_id, name, redirect_uris, client_secret, is_first_party FROM oauth_clients WHERE client_id = ?').get(CLIENT);
    assert.ok(client, 'the seed creates the orchestrator as its own service client');
    assert.strictEqual(client.name, 'OpenVibe orchestrator');
    assert.strictEqual(client.redirect_uris, '[]', 'it has no redirect URIs: client_credentials only');
    assert.strictEqual(Number(client.is_first_party), 1, 'it is first-party');
    assert.ok(client.client_secret && String(client.client_secret).length >= 20, 'the seed gives it a secret (stored, never logged)');

    const rows = await db.prepare('SELECT capability, audience, namespaces, granted_by, revoked_at FROM principal_grants WHERE client_id = ? ORDER BY capability').all(CLIENT);
    assert.deepStrictEqual(rows.map((r) => [r.capability, r.audience]), GRANTS.map(([cap, aud]) => [cap, aud]), 'exactly the three review capabilities, each for its own service');
    for (const r of rows) {
        assert.deepStrictEqual(JSON.parse(r.namespaces || '[]'), [], 'it is unscoped');
        assert.strictEqual(r.granted_by, 'default');
        assert.strictEqual(r.revoked_at, null);
    }

    // The rows are default grants, each held by no other principal and for no other audience.
    for (const [cap, aud] of GRANTS) {
        assert.deepStrictEqual(principals.DEFAULT_GRANTS.find((g) => g[0] === CLIENT && g[1] === cap && g[2] === aud), [CLIENT, cap, aud, []]);
        assert.ok(!principals.DEFAULT_GRANTS.some((g) => g[1] === cap && g[0] !== CLIENT), 'no other service holds ' + cap);
        assert.ok(!principals.DEFAULT_GRANTS.some((g) => g[1] === cap && g[2] !== aud), cap + ' is granted for ' + aud + ' and no other audience');
    }

    // The pinned Contracts release names each capability, gives it the service as its owner, and names the route.
    for (const [cap, aud, route] of GRANTS) {
        const c = contracts.capabilities.get(cap);
        assert.ok(c, 'the pinned contracts know ' + cap);
        assert.strictEqual(c.owner, aud.replace('openvibe.', ''));
        assert.ok(c.implementedBy.includes(route), cap + ' names ' + route);
    }

    // A client_credentials token for each audience carries exactly that service's review capability.
    const keys = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    for (const [cap, aud] of GRANTS) {
        const issued = await principals.issueToken(db, {
            clientId: CLIENT, clientSecret: client.client_secret, audience: aud, privateKey: keys.privateKey, issuer: ISSUER,
        });
        assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
        const claims = contracts.serviceAuth.verifyServiceToken(issued.body.access_token, {
            publicKey: keys.publicKey, issuer: ISSUER, audience: aud,
        });
        assert.ok(claims.ok, claims.reason);
        assert.deepStrictEqual(claims.claims.cap, [cap], 'the token carries ' + cap + ' and nothing else');
        assert.strictEqual(claims.claims.sub, `svc:${CLIENT}`, 'the token names the orchestrator, never a person');
        assert.strictEqual(claims.claims.on_behalf_of, undefined, 'a review is never minted for a person');
    }

    // A token for an audience it has no grant for is refused.
    const elsewhere = await principals.issueToken(db, {
        clientId: CLIENT, clientSecret: client.client_secret, audience: 'openvibe.chat', privateKey: keys.privateKey, issuer: ISSUER,
    });
    assert.strictEqual(elsewhere.status, 400, 'no grants for openvibe.chat');
    assert.match(String(elsewhere.body.error_description), /no grants/);

    console.log('orchestrator review client: ' + GRANTS.map(([cap, aud]) => `${cap} for ${aud}`).join(', '));
})().catch((err) => { console.error(err); process.exit(1); });
