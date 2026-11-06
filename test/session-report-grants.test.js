'use strict';
/**
 * The Agent Streams plan (S3, Contracts 0.300.0): who may write an agent session's report on OpenVibe.Report.
 *
 * Codes, Actor and Live hold report.session.write for the audience openvibe.report as service principals: they act
 * for the person and for nobody else, so the grant is unscoped and Report's audience is the only one it is granted
 * for. A desk session on a person's own machine reports through Codes, which pairs the machine: no machine writes a
 * report itself, and no node principal holds the grant.
 *
 *   node test/session-report-grants.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const CAP = 'report.session.write';
const AUDIENCE = 'openvibe.report';
const ISSUER = 'https://openvibe.network';

// The service principals: Codes, Actor and Live write the person's session report on Report.
const grant = (client) => principals.DEFAULT_GRANTS.find((g) => g[0] === client && g[1] === CAP && g[2] === AUDIENCE);
for (const client of ['codes', 'actor', 'live']) {
    const g = grant(client);
    assert.ok(g, `${client} may write the person's session report on Report`);
    assert.deepStrictEqual(g[3], [], `${client} holds it for Report's audience alone`);
}
assert.ok(!principals.DEFAULT_GRANTS.some((g) => g[1] === CAP && g[2] !== AUDIENCE),
    'the capability is granted for Report and for no other audience');
assert.ok(!principals.DEFAULT_GRANTS.some((g) => g[0] !== 'codes' && g[0] !== 'actor' && g[0] !== 'live' && g[1] === CAP),
    'no other service principal holds it');

// The seed's own rules: a grant that was never granted and never revoked needs no RESTORED_GRANTS entry, and one
// with no namespaces needs no CHANGED_DEFAULT_NAMESPACES entry. Neither list may name this grant.
assert.ok(!principals.REVOKED_GRANTS.some((g) => g[1] === CAP), 'the grant is not revoked');
assert.ok(!principals.RESTORED_GRANTS.some((g) => g[1] === CAP), 'a new grant needs no RESTORED_GRANTS entry');
assert.ok(!Array.isArray(principals.CHANGED_DEFAULT_NAMESPACES), 'the changed-namespaces list is not exported');

// A node principal (a person's own machine) never writes a report: the desk reports through Codes.
assert.ok(!principals.NODE_GRANTS.some(([, cap]) => cap === CAP), 'a machine never writes a report itself');

// The token: a service token for Report's audience carries the capability and nothing else.
const keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const rowsFor = (client) => principals.DEFAULT_GRANTS
    .filter((g) => g[0] === client && g[2] === AUDIENCE)
    .map((g) => ({ capability: g[1], namespaces: JSON.stringify(g[3] || []) }));
const dbFor = (client) => ({
    prepare: (sql) => ({
        get: async () => (sql.includes('oauth_clients')
            ? { client_id: client, client_secret: 'the-service-secret' }
            : null),
        all: async () => rowsFor(client),
    }),
});

(async () => {
    for (const client of ['codes', 'actor', 'live']) {
        const r = await principals.issueToken(dbFor(client), {
            clientId: client, clientSecret: 'the-service-secret', audience: AUDIENCE,
            privateKey: keys.privateKey, issuer: ISSUER,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.scope, CAP, `${client}'s token carries the report capability and nothing else`);
        const v = contracts.serviceAuth.verifyServiceToken(r.body.access_token, {
            publicKey: keys.publicKey, issuer: ISSUER, audience: AUDIENCE,
        });
        assert.ok(v.ok, v.reason);
        assert.deepStrictEqual([v.claims.sub, v.claims.actor_type, v.claims.aud, v.claims.cap],
            [`svc:${client}`, 'service', [AUDIENCE], [CAP]]);
        assert.ok(contracts.validate('identity.service-token-claims@1', v.claims).valid,
            'the claims fit identity.service-token-claims@1');
    }

    const known = contracts.capabilities.get(CAP);
    if (known) {
        assert.strictEqual(known.owner, 'report', `${CAP} is owned by report`);
        assert.strictEqual(known.status, 'active', `${CAP} is an active capability`);
    } else {
        console.log(`note: the pinned contracts do not know ${CAP} yet (the pin round lands it)`);
    }
    console.log('session report grants: codes, actor and live write the report; nobody else does');
})().catch((e) => { console.error(e); process.exit(1); });
