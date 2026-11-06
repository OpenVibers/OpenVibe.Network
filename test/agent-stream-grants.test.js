'use strict';
/**
 * The Agent Streams plan (S1, Contracts 0.298.0): who may publish a person's agent stream on OpenVibe.Live.
 *
 * Codes and Actor hold live.agent_stream.publish for the audience openvibe.live as service principals: they act for the
 * person and for nobody else. A node principal (a person's own machine, paired with its credential) holds the same
 * capability for the same audience, but only as the owner's machine: the token names its owner (on_behalf_of), so Live
 * knows whose stream it is. A machine with no owner (a platform one) gets nothing, and no audience but Live's carries
 * the capability.
 *
 *   node test/agent-stream-grants.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');
const nodePrincipals = require('../server/registry/node-principals');

const CAP = 'live.agent_stream.publish';
const ISSUER = 'https://openvibe.network';

// The service principals: Codes and Actor publish the person's agent stream on Live.
const grant = (client) => principals.DEFAULT_GRANTS.find((g) => g[0] === client && g[1] === CAP && g[2] === 'openvibe.live');
for (const client of ['codes', 'actor']) {
    const g = grant(client);
    assert.ok(g, `${client} may publish the person's agent stream on Live`);
    assert.deepStrictEqual(g[3], [], `${client} holds it for Live's audience alone`);
}
assert.ok(!principals.DEFAULT_GRANTS.some((g) => g[1] === CAP && g[2] !== 'openvibe.live'),
    'the capability is granted for Live and for no other audience');
assert.ok(!principals.DEFAULT_GRANTS.some((g) => g[0] !== 'codes' && g[0] !== 'actor' && g[1] === CAP),
    'no other service principal holds it');

// The node principals: a person's machine publishes for its owner.
const nodeGrant = principals.NODE_GRANTS.find(([aud, cap]) => aud === 'openvibe.live' && cap === CAP);
assert.ok(nodeGrant, "a person's machine may publish for its owner on Live");

const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const CREDENTIAL = 'node-credential-for-the-agent-stream-test';
const principal = {
    id: 'nod_01JAB2C3D4E5F6G7H8J9K0MNPQ',
    status: 'active',
    owner_kind: 'user',
    owner_subject: OWNER,
    paired_by_service: 'bot',
    credential_hash: crypto.createHash('sha256').update(CREDENTIAL).digest('hex'),
};
const dbFor = (row) => ({
    prepare: (sql) => ({
        get: async () => (sql.includes('platform_node_principals') ? row : null),
        run: async () => ({ changes: 1 }),
    }),
});
const keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

(async () => {
    const issue = (row, audience) => nodePrincipals.issueNodeToken(dbFor(row), {
        clientId: row.id, clientSecret: CREDENTIAL, audience, privateKey: keys.privateKey, issuer: ISSUER,
    });

    const r = await issue(principal, 'openvibe.live');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.scope, CAP, 'the token carries the publish capability and nothing else');
    const v = contracts.serviceAuth.verifyServiceToken(r.body.access_token, {
        publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.live',
    });
    assert.ok(v.ok, v.reason);
    assert.deepStrictEqual([v.claims.sub, v.claims.actor_type, v.claims.aud, v.claims.cap],
        [`node:${principal.id}`, 'node', ['openvibe.live'], [CAP]]);
    assert.strictEqual(v.claims.on_behalf_of, OWNER, 'the token names the owner it acts for');
    assert.ok(contracts.validate('identity.service-token-claims@1', v.claims).valid,
        'the claims fit identity.service-token-claims@1');

    const other = await issue(principal, 'openvibe.chat');
    assert.deepStrictEqual([other.status, other.body.error], [400, 'invalid_scope'], 'no other audience');

    const website = await issue(principal, 'openvibe.website');
    assert.strictEqual(website.status, 200, JSON.stringify(website.body));
    const w = contracts.serviceAuth.verifyServiceToken(website.body.access_token, {
        publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.website',
    });
    assert.ok(w.ok, w.reason);
    assert.deepStrictEqual(w.claims.cap, [], 'the Connect audience carries no capability');
    assert.strictEqual(w.claims.on_behalf_of, undefined, 'only the audience where the machine acts for its owner names the owner');

    const self = await issue(principal, 'openvibe.network');
    assert.strictEqual(self.status, 200, JSON.stringify(self.body));
    const st = contracts.serviceAuth.verifyServiceToken(self.body.access_token, {
        publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.network',
    });
    assert.ok(st.ok, st.reason);
    assert.strictEqual(st.claims.on_behalf_of, undefined, 'self-management names nobody');

    const platform = { ...principal, owner_kind: 'platform', owner_subject: null };
    const none = await issue(platform, 'openvibe.live');
    assert.deepStrictEqual([none.status, none.body.error], [400, 'invalid_scope'], 'a machine with no owner publishes for nobody');

    const unbound = { ...principal, owner_subject: null };
    const noOwner = await issue(unbound, 'openvibe.live');
    assert.deepStrictEqual([noOwner.status, noOwner.body.error], [400, 'invalid_scope'], 'a user machine must name its owner');

    const known = contracts.capabilities.get(CAP);
    if (known) assert.strictEqual(known.status, 'active', `${CAP} is an active capability`);
    else console.log(`note: the pinned contracts do not know ${CAP} yet (the pin round lands it)`);
    console.log('agent stream grants: codes and actor publish for the person; a node principal publishes for its owner');
})().catch((e) => { console.error(e); process.exit(1); });
