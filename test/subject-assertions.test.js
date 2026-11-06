'use strict';
// Subject assertions (server/identity/subject-assertions.js): a first-party service signs the
// person's own access token into a 60-second assertion, and nothing is signed without it.
// ADR-003, the 2026-11-06 amendment; plan H1.
//   node test/subject-assertions.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { serviceAuth } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const assertions = require('../server/identity/subject-assertions');

(async () => {
const db = await getDb();
const ISSUER = 'https://openvibe.network';

await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (77, 'payer', 'x') ON CONFLICT (id) DO NOTHING").run();
const person = await db.prepare('SELECT id, subject_id FROM users WHERE id = 77').get();
person.subject_id = await require('../server/identity/subjects').ensureUserSubject(db, person);
assert.ok(person.subject_id, 'the person has a canonical subject');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const keys = assertions.loadAssertionKeys({ privateKeyPath: null, publicKeyPath: null, log: { warn: () => {} } });

const app = express();
app.use(express.json());
app.locals.db = db;
app.locals.privateKey = rsa.privateKey;
app.locals.publicKey = rsa.publicKey;
app.locals.assertionKeys = keys;
app.locals.config = { jwt: { issuer: ISSUER }, subjectAssertions: { audiences: ['openvibe.billing', 'openvibe.tips'] } };
app.use('/internal', require('../server/internal/routes'));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** A service token (client_credentials, signed here) for the service `svc:<id>`. */
const serviceToken = (id, over = {}) => serviceAuth.signServiceToken({
    iss: ISSUER, sub: `svc:${id}`, actor_type: 'service', aud: ['openvibe.network'], cap: [], ns: [],
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}`, ...over,
}, rsa.privateKey);
/** The person's own access token (a Network session). */
const personToken = () => jwt.sign({ sub: '77' }, rsa.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });

const post = (body, headers) => fetch(`${base}/internal/subject-assertions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

try {
    // ── The happy path ──
    const out = await post({ user_token: personToken(), audience: 'openvibe.billing' }, { authorization: `Bearer ${serviceToken('tips')}` });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.ok(out.body.assertion, 'an assertion comes back');
    assert.strictEqual(out.body.subject, person.subject_id, 'it names the person');
    assert.strictEqual(out.body.audience, 'openvibe.billing');
    assert.strictEqual(out.body.act, 'svc:tips', 'it names the service it was minted for');
    assert.strictEqual(out.body.expires_in, 60);

    // The assertion verifies with Network's published key and carries the H1 claims.
    const decoded = jwt.decode(out.body.assertion);
    assert.strictEqual(decoded.iss, ISSUER);
    assert.strictEqual(decoded.sub, person.subject_id);
    assert.deepStrictEqual(decoded.aud, ['openvibe.billing']);
    assert.strictEqual(decoded.act, 'svc:tips');
    assert.ok(decoded.jti, 'it has a jti');
    assert.strictEqual(decoded.exp - decoded.iat, 60, 'it lives 60 seconds');
    const header = JSON.parse(Buffer.from(out.body.assertion.split('.')[0], 'base64url').toString('utf8'));
    assert.strictEqual(header.alg, 'ES256');
    assert.strictEqual(header.kid, 'ov-network-assertion-1');
    const verified = jwt.verify(out.body.assertion, keys.publicKey, { algorithms: ['ES256'], issuer: ISSUER, audience: 'openvibe.billing' });
    assert.strictEqual(verified.sub, person.subject_id);

    // The key is published in the JWKS, so a receiver can verify it offline.
    const jwk = assertions.assertionJwk(keys.publicKey);
    assert.strictEqual(jwk.kty, 'EC');
    assert.strictEqual(jwk.alg, 'ES256');
    assert.strictEqual(jwk.kid, 'ov-network-assertion-1');
    assert.ok(jwk.x && jwk.y && !jwk.d, 'the private half is not published');

    // ── Without the person's token, nothing is signed ──
    const noToken = await post({ audience: 'openvibe.billing' }, { authorization: `Bearer ${serviceToken('tips')}` });
    assert.strictEqual(noToken.status, 401);
    assert.strictEqual(noToken.body.code, 'assertion.no_user_token');

    const badToken = await post({ user_token: 'not-a-token', audience: 'openvibe.billing' }, { authorization: `Bearer ${serviceToken('tips')}` });
    assert.strictEqual(badToken.status, 401);
    assert.strictEqual(badToken.body.code, 'assertion.invalid_user_token');

    // A service token of a service, naming no person: the service may not vouch for itself.
    const noService = await post({ user_token: personToken(), audience: 'openvibe.billing' }, {});
    assert.strictEqual(noService.status, 401);
    assert.strictEqual(noService.body.code, 'token.missing');

    // A developer app token is not a first-party service: it never gets an assertion.
    const appToken = serviceToken('live', { sub: 'app:app_01H8XYZABCDEFGHJKMNPQRRSTV', actor_type: 'app', project_id: 'prj_01H8XYZABCDEFGHJKMNPQRRSTV', env: 'production' });
    const notService = await post({ user_token: personToken(), audience: 'openvibe.billing' }, { authorization: `Bearer ${appToken}` });
    assert.strictEqual(notService.status, 403);
    assert.strictEqual(notService.body.code, 'assertion.not_a_service');

    // ── The person is the one the token names ──
    await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (78, 'other', 'x') ON CONFLICT (id) DO NOTHING").run();
    const otherSubject = await require('../server/identity/subjects').ensureUserSubject(db, await db.prepare('SELECT id, subject_id FROM users WHERE id = 78').get());
    const mismatch = await post({ user_token: personToken(), audience: 'openvibe.billing', subject: otherSubject }, { authorization: `Bearer ${serviceToken('tips')}` });
    assert.strictEqual(mismatch.status, 403);
    assert.strictEqual(mismatch.body.code, 'assertion.subject_mismatch');

    const same = await post({ user_token: personToken(), audience: 'openvibe.billing', subject: person.subject_id }, { authorization: `Bearer ${serviceToken('tips')}` });
    assert.strictEqual(same.status, 200, JSON.stringify(same.body));

    // ── The audience is one Network signs assertions for ──
    const badAudience = await post({ user_token: personToken(), audience: 'openvibe.somethingelse' }, { authorization: `Bearer ${serviceToken('tips')}` });
    assert.strictEqual(badAudience.status, 403);
    assert.strictEqual(badAudience.body.code, 'assertion.audience_not_allowed');

    const noAudience = await post({ user_token: personToken() }, { authorization: `Bearer ${serviceToken('tips')}` });
    assert.strictEqual(noAudience.status, 422);
    assert.strictEqual(noAudience.body.code, 'assertion.invalid_audience');

    // ── The chain: an assertion that travels from the site to Tips and on to Billing ──
    const chained = await post({ user_token: personToken(), audience: ['openvibe.tips', 'openvibe.billing'], for: ['svc:tips'] }, { authorization: `Bearer ${serviceToken('live')}` });
    assert.strictEqual(chained.status, 200, JSON.stringify(chained.body));
    const chainClaims = jwt.decode(chained.body.assertion);
    assert.deepStrictEqual(chainClaims.aud, ['openvibe.tips', 'openvibe.billing']);
    assert.deepStrictEqual(chainClaims.for, ['svc:live', 'svc:tips'], 'the minting service is always one that may carry it');
    assert.strictEqual(chainClaims.act, 'svc:live', 'it names the service that vouched for the person');
    assert.strictEqual(chainClaims.sub, person.subject_id);

    // A service that is not named may not carry it.
    const stranger = await post({ user_token: personToken(), audience: ['openvibe.tips'], for: ['nope'] }, { authorization: `Bearer ${serviceToken('live')}` });
    assert.strictEqual(stranger.status, 422);
    assert.strictEqual(stranger.body.code, 'assertion.invalid_for');

    console.log('ok - subject assertions: minted with the person\'s own token, refused without it');
} finally {
    server.close();
    await db.close();
}
})().catch((err) => { console.error(err); process.exit(1); });
