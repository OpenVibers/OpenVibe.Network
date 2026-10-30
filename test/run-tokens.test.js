'use strict';
// Run tokens (Codes C3): a client_credentials token that names the person it acts for (on_behalf_of) and may live
// up to two hours (ttl). Only a service that holds the consent grant for that audience (ai.credential.manage — the
// grant that lets it store that person's own key in OpenVibe.AI) may mint one; Codes holds it for the people it
// builds for, and its harnesses run through AI with such a token.
//   node test/run-tokens.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { serviceAuth, validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    for (const id of ['codes', 'vision']) {
        await db.prepare("UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?").run(`${id}-secret`, id);
    }
    await principals.ensureSchema(db);

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
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    const claimsOf = (body) => {
        const c = serviceAuth.verifyServiceToken(body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.ai' });
        assert.ok(c.ok, c.reason);
        return c.claims;
    };
    const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';

    try {
        // ── The grants Codes holds for OpenVibe.AI (Codes C3) ──
        const has = (svc, cap, aud) => principals.DEFAULT_GRANTS.some(([s, c, a]) => s === svc && c === cap && a === aud);
        assert.ok(has('codes', 'ai.credential.manage', 'openvibe.ai'), 'Codes holds the consent grant for AI');
        assert.ok(has('codes', 'ai.run.create', 'openvibe.ai'), 'Codes runs AI workflows for its harnesses');
        const codesGrants = await principals.grantsFor(db, 'codes', 'openvibe.ai');
        assert.deepStrictEqual(codesGrants.map((g) => g.capability).sort(), ['ai.credential.manage', 'ai.run.create']);

        // ── A run token: the person it acts for, and how long it lives ──
        let t = await token({ client_id: 'codes', client_secret: 'codes-secret', audience: 'openvibe.ai', scope: 'ai.run.create', on_behalf_of: OWNER, ttl: '7200' });
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

        console.log('run-tokens: ok');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
