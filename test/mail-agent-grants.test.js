'use strict';
/**
 * HO6 (Contracts 0.342.0): an agent answers the mail sent to its own address.
 *
 * Actor's mail client (server/mail/client.js) mints a service token for the audience openvibe.mail with exactly
 * mail.agent.read, mail.agent.reply and mail.agent.answering. Mail's internal routes (server/http/agent-mail.js)
 * guard those three capabilities, and none is wider: it reads one letter, sends the reply the person approved and
 * reads or sets the per-agent answering switch. Actor is the one service that does this; no other principal holds
 * the grants, and no other audience is granted them.
 *
 *   node test/mail-agent-grants.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const AUDIENCE = 'openvibe.mail';
const CAPS = ['mail.agent.read', 'mail.agent.reply', 'mail.agent.answering'];
const ISSUER = 'https://openvibe.network';

// ── The defaults: Actor and nobody else, Mail's audience and no other ──
for (const cap of CAPS) {
    const g = principals.DEFAULT_GRANTS.find((row) => row[0] === 'actor' && row[1] === cap && row[2] === AUDIENCE);
    assert.ok(g, `Actor holds ${cap} for ${AUDIENCE}`);
    assert.deepStrictEqual(g[3], [], `${cap} is unscoped: Actor acts for the person in X-OV-Subject`);
    assert.ok(!principals.DEFAULT_GRANTS.some((row) => row[1] === cap && row[2] !== AUDIENCE),
        `${cap} is granted for ${AUDIENCE} and no other audience`);
    assert.ok(!principals.DEFAULT_GRANTS.some((row) => row[0] !== 'actor' && row[1] === cap),
        `no other client holds ${cap}`);

    const known = contracts.capabilities.get(cap);
    assert.ok(known, `the pinned openvibe-contracts knows ${cap}`);
    assert.deepStrictEqual([known.owner, known.status, known.visibility], ['mail', 'active', 'first-party'],
        `${cap} is Mail's active first-party capability`);
}

// These rows are new (never granted or revoked before) and carry no namespaces: the seed needs no restore and no
// namespace move, and no node principal answers mail.
for (const cap of CAPS) {
    assert.ok(!principals.REVOKED_GRANTS.some((row) => row[1] === cap), `${cap} was never revoked`);
    assert.ok(!principals.RESTORED_GRANTS.some((row) => row[1] === cap), `a new default needs no RESTORED_GRANTS entry for ${cap}`);
    assert.ok(!principals.NODE_GRANTS.some(([, c]) => c === cap), `a person's machine never answers mail (${cap})`);
}
assert.ok(!Array.isArray(principals.CHANGED_DEFAULT_NAMESPACES), 'the changed-namespaces list is not exported');

// ── The token: Actor mints exactly these three, and no other service gets them ──
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
const mint = (client) => principals.issueToken(dbFor(client), {
    clientId: client, clientSecret: 'the-service-secret', audience: AUDIENCE,
    scope: CAPS.join(' '), privateKey: keys.privateKey, issuer: ISSUER,
});

(async () => {
    const actor = await mint('actor');
    assert.strictEqual(actor.status, 200, JSON.stringify(actor.body));
    assert.deepStrictEqual(actor.body.scope.split(' ').sort(), [...CAPS].sort(),
        'Actor\'s token carries exactly the three mail.agent capabilities');
    const v = contracts.serviceAuth.verifyServiceToken(actor.body.access_token, {
        publicKey: keys.publicKey, issuer: ISSUER, audience: AUDIENCE,
    });
    assert.ok(v.ok, v.reason);
    assert.deepStrictEqual([v.claims.sub, v.claims.actor_type, v.claims.aud],
        ['svc:actor', 'service', [AUDIENCE]]);
    assert.deepStrictEqual([...v.claims.cap].sort(), [...CAPS].sort());
    assert.deepStrictEqual(v.claims.ns, [], 'the grant is unscoped: the person travels in X-OV-Subject');
    assert.ok(contracts.validate('identity.service-token-claims@1', v.claims).valid,
        'the claims fit identity.service-token-claims@1');

    // Any other service asks for the same scopes on Mail's audience and is refused: it has no grant there.
    const other = await mint('codes');
    assert.strictEqual(other.status, 400, JSON.stringify(other.body));
    assert.strictEqual(other.body.error, 'invalid_scope');
    console.log('mail agent grants: Actor reads, replies and answers; nobody else does');
})().catch((e) => { console.error(e); process.exit(1); });
