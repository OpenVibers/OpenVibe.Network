'use strict';
// Run tokens (Codes C3): a client_credentials token that names the person it acts for (on_behalf_of) and may live
// up to two hours (ttl). Only a service that holds the consent grant for that audience (ai.credential.manage — the
// grant that lets it store that person's own key in OpenVibe.AI) may mint one; Codes holds it for the people it
// builds for, and its harnesses run through AI with such a token. The person must have signed in to THAT service
// (a live refresh-token family of theirs for that client), every mint is audited, and a service may mint at most
// 120 run tokens an hour for one person.
//   node test/run-tokens.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { serviceAuth, validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const runTokens = require('../server/identity/run-tokens');

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    for (const id of ['codes', 'vision']) {
        await db.prepare("UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?").run(`${id}-secret`, id);
    }
    await principals.ensureSchema(db);

    // ── The people ──
    // The subject is users.subject_id; the integer id is the key (server/identity/subjects.js).
    const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';
    const NEVER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A2';
    const REVOKED = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
    const ELSEWHERE = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4';
    const BURST = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A5';
    const people = {};
    for (const [name, subject] of [['owner', OWNER], ['never', NEVER], ['revoked', REVOKED], ['elsewhere', ELSEWHERE], ['burst', BURST]]) {
        await db.prepare('INSERT INTO users (id, username, password_hash, subject_id) VALUES (?, ?, ?, ?)').run(100 + Object.keys(people).length, `rt_${name}`, 'x', subject);
        people[name] = await db.prepare('SELECT id, subject_id FROM users WHERE subject_id = ?').get(subject);
    }
    // A live Codes session (the person signed in to Codes), a revoked family, and a live session of another
    // service only. The token itself is a hash; the family and the expiry are what matter.
    const live = (clientId, userId) => db.prepare('INSERT INTO oauth_tokens (token, client_id, user_id, scope, expires_at, family_id, generation, revoked) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
        .run(`sha256:${crypto.randomBytes(24).toString('hex')}`, clientId, userId, 'profile theme', new Date(Date.now() + 86400e3).toISOString(), `fam_${clientId}_${userId}`, 0);
    await live('codes', people.owner.id);
    await live('codes', people.burst.id);
    await live('codes', people.revoked.id);
    await db.prepare('UPDATE oauth_tokens SET revoked = 1, revoked_reason = ? WHERE client_id = ? AND user_id = ?').run('reuse', 'codes', people.revoked.id);
    await live('vision', people.elsewhere.id);

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const ISSUER = 'https://openvibe.network';
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.locals.db = db;
    app.locals.config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
    app.locals.privateKey = keys.privateKey;
    app.locals.publicKey = keys.publicKey;
    app.use('/oauth', require('../server/auth/oauth-routes'));
    const server = http.createServer(app);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = (form) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', ...form }) })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
    const claimsOf = (body) => {
        const c = serviceAuth.verifyServiceToken(body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.ai' });
        assert.ok(c.ok, c.reason);
        return c.claims;
    };
    const runToken = (onBehalfOf, extra = {}) => token({ client_id: 'codes', client_secret: 'codes-secret', audience: 'openvibe.ai', scope: 'ai.run.create', on_behalf_of: onBehalfOf, ttl: '7200', ...extra });

    try {
        // ── The grants Codes holds for OpenVibe.AI (Codes C3) ──
        const has = (svc, cap, aud) => principals.DEFAULT_GRANTS.some(([s, c, a]) => s === svc && c === cap && a === aud);
        assert.ok(has('codes', 'ai.credential.manage', 'openvibe.ai'), 'Codes holds the consent grant for AI');
        assert.ok(has('codes', 'ai.run.create', 'openvibe.ai'), 'Codes runs AI workflows for its harnesses');
        const codesGrants = await principals.grantsFor(db, 'codes', 'openvibe.ai');
        assert.deepStrictEqual(codesGrants.map((g) => g.capability).sort(), ['ai.credential.manage', 'ai.run.create']);

        // ── A run token: the person it acts for, and how long it lives ──
        let t = await runToken(OWNER);
        assert.strictEqual(t.status, 200, JSON.stringify(t.body));
        assert.strictEqual(t.body.expires_in, 7200);
        const run = claimsOf(t.body);
        assert.strictEqual(run.sub, 'svc:codes');
        assert.strictEqual(run.on_behalf_of, OWNER, 'the token names the person it acts for');
        assert.strictEqual(run.exp - run.iat, 7200, 'and lives two hours');
        assert.deepStrictEqual(run.cap, ['ai.run.create']);
        assert.deepStrictEqual(run.ns, ['ai.messages', 'ai.complete'], 'AI\'s own workflows only');
        assert.ok(validate('identity.service-token-claims@1', run).valid, 'the claims are a service token\'s');

        // ── Without a person it is an ordinary five-minute service token ──
        t = await token({ client_id: 'codes', client_secret: 'codes-secret', audience: 'openvibe.ai', scope: 'ai.run.create' });
        assert.strictEqual(t.status, 200, JSON.stringify(t.body));
        assert.strictEqual(t.body.expires_in, 300);
        assert.strictEqual(claimsOf(t.body).on_behalf_of, undefined, 'no person, no on_behalf_of');

        // ── Only a service with the consent grant may mint one ──
        t = await token({ client_id: 'vision', client_secret: 'vision-secret', audience: 'openvibe.ai', scope: 'ai.run.create', on_behalf_of: OWNER });
        assert.strictEqual(t.status, 403, 'a service without the consent grant may not act for a person');
        assert.strictEqual(t.body.error, 'invalid_scope');

        // ── The person must have signed in to THAT service ──
        t = await runToken(NEVER);
        assert.strictEqual(t.status, 403, 'a person who never signed in to Codes is not spoken for');
        assert.strictEqual(t.body.error, 'consent_required');
        assert.strictEqual(t.body.error_description, 'that person has not signed in to this service');
        t = await runToken(REVOKED);
        assert.strictEqual(t.status, 403, 'a revoked session is not consent');
        assert.strictEqual(t.body.error, 'consent_required');
        t = await runToken(ELSEWHERE);
        assert.strictEqual(t.status, 403, 'a session of another service is not consent for this one');
        assert.strictEqual(t.body.error, 'consent_required');

        // ── The refusals ──
        t = await token({ client_id: 'codes', client_secret: 'codes-secret', audience: 'openvibe.ai', scope: 'ai.run.create', on_behalf_of: 'not-a-subject' });
        assert.strictEqual(t.status, 400, 'the person must be a usr_ subject');
        assert.strictEqual(t.body.error, 'invalid_request');
        t = await token({ client_id: 'codes', client_secret: 'codes-secret', audience: 'openvibe.ai', scope: 'ai.run.create', on_behalf_of: OWNER, ttl: '99999' });
        assert.strictEqual(t.status, 400, 'a run token lives at most two hours');
        assert.strictEqual(t.body.error, 'invalid_request');
        t = await token({ client_id: 'codes', client_secret: 'codes-secret', audience: 'openvibe.ai', scope: 'ai.run.create', ttl: '7200' });
        assert.strictEqual(t.status, 400, 'a lifetime without a person is refused');
        t = await token({ client_id: 'codes', client_secret: 'codes-secret', audience: 'openvibe.ai', scope: 'ai.run.create', on_behalf_of: OWNER, ttl: '7200', agent: 'agt_x' });
        assert.strictEqual(t.status, 400, 'an agent token is minted by its own route');

        // ── Every mint is audited: the action, the client, the person, the ttl and the jti — never the token ──
        const audits = await db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(runTokens.RUN_TOKEN_AUDIT_ACTION);
        assert.ok(audits.length >= 1, 'the mint left an audit row');
        const audit = audits[audits.length - 1];
        const details = JSON.parse(audit.details);
        assert.strictEqual(audit.user_id, people.owner.id, 'the audit row names the person');
        assert.strictEqual(details.client_id, 'codes');
        assert.strictEqual(details.subject, OWNER);
        assert.strictEqual(details.ttl_seconds, 7200);
        assert.ok(details.jti && details.jti.startsWith('tok_'), 'the audit row names the token\'s jti');
        assert.ok(!JSON.stringify(audit).includes(run.access_token), 'the audit row never holds the token');
        assert.ok(!JSON.stringify(audit).includes(String(run.access_token).split('.')[1]), 'nor any part of it');
        const mints = await db.prepare('SELECT * FROM run_token_mints WHERE client_id = ? AND subject = ?').all('codes', OWNER);
        assert.strictEqual(mints.length, 1, 'the ledger has one row for the mint');
        assert.strictEqual(mints[0].jti, details.jti);
        // The ledger is the limit's memory, not the trail: what leaves the window is dropped.
        await db.prepare('INSERT INTO run_token_mints (client_id, subject, user_id, jti, minted_at) VALUES (?, ?, ?, ?, ?)')
            .run('codes', OWNER, people.owner.id, 'tok_old', Math.floor(Date.now() / 1000) - 7200);
        await runToken(OWNER);
        const kept = await db.prepare('SELECT * FROM run_token_mints WHERE client_id = ? AND subject = ?').all('codes', OWNER);
        assert.ok(!kept.find((r) => r.jti === 'tok_old'), 'a mint outside the window is dropped from the ledger');
        const trail = await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND details LIKE ?').get(runTokens.RUN_TOKEN_AUDIT_ACTION, `%${OWNER}%`);
        assert.ok(Number(trail.n) >= 2, 'the audit trail keeps every mint, dropped or not');

        // ── At most 120 run tokens an hour for one (service, person) ──
        for (let i = 0; i < runTokens.RUN_TOKEN_LIMIT_PER_HOUR; i++) {
            const r = await runToken(BURST);
            assert.strictEqual(r.status, 200, `mint ${i + 1}: ${JSON.stringify(r.body)}`);
        }
        t = await runToken(BURST);
        assert.strictEqual(t.status, 429, 'the 121st run token of the hour is refused');
        assert.strictEqual(t.body.error, 'rate_limited');
        assert.ok(t.body.retry_after > 0 && t.body.retry_after <= 3600, 'it says when to come back');
        assert.strictEqual(t.headers.get('retry-after'), String(t.body.retry_after));
        const audited = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND details LIKE ?").get(runTokens.RUN_TOKEN_AUDIT_ACTION, `%${BURST}%`);
        assert.strictEqual(Number(audited.n), runTokens.RUN_TOKEN_LIMIT_PER_HOUR, 'every minted token left its audit row');
        // Another person is not affected by that person's limit.
        t = await runToken(OWNER);
        assert.strictEqual(t.status, 200, 'the limit is per service and person');

        console.log('run-tokens: ok');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
