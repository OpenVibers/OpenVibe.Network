'use strict';
// Who may act for a person in Connect (server/connect/auth.js, callers.js, gateway.js), from Opus's security review
// of E7 (2026-11-06):
//   - a valid service token is not enough: only the services Connect names (codes, actor) may act for a person;
//   - a service's caller row is per person, so one person's grant never opens another person's apps;
//   - a personal key always works (its secret holds no "_" for the parser to split on);
//   - a path value of "." or ".." is refused before any request.
//   node test/connect-callers.test.js
const assert = require('assert');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const { resolveCaller } = require('../server/connect/auth');
const callers = require('../server/connect/callers');

(async () => {
    const db = getDb();
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const config = { jwt: { issuer: 'https://openvibe.network' } };
    const A = 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1';
    const B = 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2';
    const token = (client, person) => {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({
            iss: config.jwt.issuer, sub: `svc:${client}`, actor_type: 'service', aud: ['openvibe.network'], cap: [], ns: [],
            on_behalf_of: person, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
        }, keys.privateKey);
    };
    const asReq = (t) => ({ headers: { authorization: `Bearer ${t}` } });
    const resolve = (t) => resolveCaller(db, asReq(t), { config, publicKey: keys.publicKey });

    // Only the named services.
    const meme = await resolve(token('meme', A));
    assert.strictEqual(meme.ok, false, 'a service Connect does not name is refused');
    assert.strictEqual(meme.status, 403);
    const codesA = await resolve(token('codes', A));
    assert.ok(codesA.ok && codesA.kind === 'service' && codesA.subject === A, 'codes may act for a person');

    // Per person: A's grant to codes is not B's.
    const codesB = await resolve(token('codes', B));
    assert.ok(codesB.ok, codesB.detail);
    assert.notStrictEqual(codesA.caller.id, codesB.caller.id, 'codes acting for A and for B are two callers');
    assert.strictEqual(codesB.caller.subject, B);
    // A's grant to codes (written directly: setGrant also wants the app connected, which is not what this tests).
    await db.prepare("INSERT INTO connect_grants (caller_id, app, level, created_at, updated_at) VALUES (?, 'github', 'write', ?, ?)").run(codesA.caller.id, new Date().toISOString(), new Date().toISOString());
    assert.ok(await db.prepare("SELECT level FROM connect_grants WHERE caller_id = ? AND app = 'github'").get(codesA.caller.id), 'A granted codes github');
    const bGrant = await db.prepare("SELECT level FROM connect_grants WHERE caller_id = ? AND app = 'github'").get(codesB.caller.id);
    assert.ok(!bGrant, 'B has given codes nothing');

    // Keys always parse.
    for (let i = 0; i < 40; i++) {
        const made = await callers.createKeyCaller(db, A, `key ${i}`);
        assert.ok(!/_/.test(made.key.split('_').slice(-1)[0]) && /^[0-9a-f]+$/.test(made.key.slice(made.key.lastIndexOf('_') + 1)), 'the secret is hex');
        const found = await callers.findByKey(db, made.key);
        assert.ok(found && found.subject === A, 'every key made is found again');
    }

    // Dot segments.
    const gateway = require('../server/connect/gateway');
    const build = gateway.interpolatePath;
    assert.throws(() => build('/repos/{owner}/{repo}', { owner: '..', repo: 'x' }, ['owner', 'repo']), /may not be/);
    assert.throws(() => build('/repos/{owner}/{repo}', { owner: 'a', repo: '.' }, ['owner', 'repo']), /may not be/);
    assert.strictEqual(build('/repos/{owner}/{repo}', { owner: 'a b', repo: 'x' }, ['owner', 'repo']), '/repos/a%20b/x');
    console.log('connect callers: named services only, per-person service callers, keys parse, no dot segments');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
