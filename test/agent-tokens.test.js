'use strict';
// Agent tokens (plan T2 WS-Z2 slice 8, docs/t2-projects-and-grants.md section 4 "Agent tokens";
// server/developer/agent-tokens.js): the host mints with agent=agt_… at /oauth/token. The claims validate as
// identity.service-token-claims@1 (v0.90.0) and carry exactly sub/actor_type agent, aud, cap (auto grants),
// cap_confirm (confirm grants), ns, project_id, env, on_behalf_of, act, iat/exp/jti; RS256 with Network's key.
// Refusals: another host, another project's app, an unknown agent, a paused/revoked agent, a banned owner, an archived
// project (400 invalid_grant, one message); a revoked or expired grant, a budget of 0, a capability outside the host's
// ceiling (left out; asked by scope: 400 invalid_scope); a sandbox agent at an audience without sandbox tokens
// (invalid_target). A confirm-mode capability is never in cap: its use needs an approval the owning service consumes
// once, even under concurrency. Service-host namespaces; app tokens without `agent` are unchanged; Network's own
// guard refuses agent tokens; every issue and refusal is audited without secrets.
//   node test/agent-tokens.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { validate, serviceAuth } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const confirmations = require('../server/developer/confirmations');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('actor', 'actor-secret', 'OpenVibe.Actor', '[]', 1)").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (10, 'owner', 'x', 'user'), (14, 'staff', 'x', 'admin')`).run();
const owner = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 10').get());

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { sandboxAllowance: 'media.object.read', agentHostServices: 'actor' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal', require('../server/internal/routes'));
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);
const U = { owner: jwt.sign({ sub: 10, id: 10 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' }), staff: jwt.sign({ sub: 14, id: 14 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' }) };

(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: { authorization: `Bearer ${U[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    const ok = (r, status = 200) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); return r.body; };
    const SECRETS = {};
    const tokenReq = async (client, params) => {
        const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: SECRETS[client], audience: 'openvibe.media', ...params }) });
        return { status: r.status, body: await r.json() };
    };
    const claimsOf = (r) => { assert.strictEqual(r.status, 200, JSON.stringify(r.body)); return jwt.decode(r.body.access_token); };
    const mint = async (client, agent, params = {}) => claimsOf(await tokenReq(client, { agent, ...params }));
    const refusedGrant = async (client, agent, error, params = {}) => {
        const r = await tokenReq(client, { agent, ...params });
        assert.deepStrictEqual([r.status, r.body.error], [400, error], JSON.stringify(r.body));
        return r.body;
    };
    const capsOf = async (client, agent, params) => { const c = await mint(client, agent, params); return [c.cap, c.cap_confirm || []]; };
    try {
        // Project P: production app PR hosts agent A (read + upload auto, delete confirm); PR2 is another app of P;
        // project Q's app QR; a sandbox app SB hosts agent SA.
        const P = ok(await api('owner', 'POST', '', { name: 'Agent tokens' }), 201).id;
        ok(await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' }));
        ok(await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.read', 'media.object.upload', 'media.object.delete'] }));
        const newApp = async (project, name, environment) => {
            const a = ok(await api('owner', 'POST', `/${project}/apps`, { name, environment }), 201);
            SECRETS[a.id] = a.credential.client_secret;
            return a.id;
        };
        const PR = await newApp(P, 'Bot', 'production');
        const PR2 = await newApp(P, 'Other', 'production');
        const SB = await newApp(P, 'Sandbox bot', 'sandbox');
        for (const c of ['media.object.read', 'media.object.upload', 'media.object.delete']) ok(await api('owner', 'POST', `/${P}/apps/${PR}/grants`, { capability: c }), 201);
        ok(await api('owner', 'POST', `/${P}/apps/${SB}/grants`, { capability: 'media.object.read' }), 201);
        const Q = ok(await api('owner', 'POST', '', { name: 'Other project' }), 201).id;
        const QR = await newApp(Q, 'Q bot', 'sandbox');
        const A = ok(await api('owner', 'POST', `/${P}/agents`, { name: 'Helper', host: { type: 'app', id: PR } }), 201).id;
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/grants/media.object.delete`, {}));
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/grants/media.object.upload`, { mode: 'auto' }));
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/grants/media.object.read`, { mode: 'auto' }));
        const SA = ok(await api('owner', 'POST', `/${P}/agents`, { name: 'Sandbox helper', host: { type: 'app', id: SB } }), 201).id;
        ok(await api('owner', 'PUT', `/${P}/agents/${SA}/grants/media.object.read`, { mode: 'auto' }));

        // ── The claims: exactly the v0.90.0 agent shape, signed by Network's RS256 key ──
        const res = await tokenReq(PR, { agent: A });
        const claims = claimsOf(res);
        const v = validate('identity.service-token-claims@1', claims);
        assert.ok(v.valid, JSON.stringify(v.errors));
        const ownApp = claimsOf(await tokenReq(PR, {}));
        assert.deepStrictEqual(claims, {
            iss: ISSUER, sub: `agent:${A}`, actor_type: 'agent', aud: ['openvibe.media'], cap: ['media.object.read', 'media.object.upload'],
            cap_confirm: ['media.object.delete'], ns: ownApp.ns, project_id: P, env: 'production', on_behalf_of: owner, act: { sub: `app:${PR}` },
            iat: claims.iat, exp: claims.iat + 300, jti: claims.jti,
        });
        assert.match(claims.jti, /^tok_[0-9a-f]{24}$/);
        assert.deepStrictEqual([res.body.token_type, res.body.expires_in, res.body.scope], ['Bearer', 300, 'media.object.delete media.object.read media.object.upload']);
        const verified = serviceAuth.verifyServiceToken(res.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.media' });
        assert.ok(verified.ok, verified.reason);
        assert.strictEqual(jwt.decode(res.body.access_token, { complete: true }).header.alg, 'RS256');
        // The host's own app token is what it was: no agent claims.
        assert.deepStrictEqual(Object.keys(ownApp).sort(), ['actor_type', 'aud', 'cap', 'env', 'exp', 'iat', 'iss', 'jti', 'ns', 'project_id', 'sub']);
        assert.deepStrictEqual([ownApp.sub, ownApp.actor_type, ownApp.cap, ownApp.ns], [`app:${PR}`, 'app', ['media.object.delete', 'media.object.read', 'media.object.upload'], [P, `app.${P}.*`]]);
        // A scope narrows; a confirm-mode capability alone gives cap [] and cap_confirm, never cap.
        assert.deepStrictEqual(await capsOf(PR, A, { scope: 'media.object.delete' }), [[], ['media.object.delete']]);
        assert.ok(!('cap_confirm' in await mint(PR, A, { scope: 'media.object.read' })), 'no cap_confirm when there is none');
        await refusedGrant(PR, A, 'invalid_scope', { scope: 'media.object.list' });

        // ── Host binding: one answer for all of them ──
        const unknown = await refusedGrant(PR, `agt_${'9'.repeat(26)}`, 'invalid_grant');
        assert.deepStrictEqual(await refusedGrant(PR2, A, 'invalid_grant'), unknown, 'another app of the project');
        assert.deepStrictEqual(await refusedGrant(QR, A, 'invalid_grant', { audience: 'openvibe.media' }), unknown, 'an app of another project');
        assert.deepStrictEqual(await refusedGrant(PR, 'agt_nope', 'invalid_grant'), unknown);
        assert.deepStrictEqual(await refusedGrant(PR, SA, 'invalid_grant'), unknown, 'an agent of another host');
        SECRETS.live = 'live-secret';
        assert.deepStrictEqual(await refusedGrant('live', A, 'invalid_grant'), unknown, 'a service that is not the host');
        const badSecret = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: PR, client_secret: 'ovsec_wrong', audience: 'openvibe.media', agent: A }) });
        assert.strictEqual(badSecret.status, 401);
        const code = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', client_id: PR, client_secret: SECRETS[PR], code: 'x', audience: 'openvibe.media', agent: A }) });
        assert.deepStrictEqual([code.status, (await code.json()).error], [400, 'unsupported_grant_type']);
        // A paused agent, a banned owner.
        await db.prepare('UPDATE dev_agents SET status = ? WHERE id = ?').run('paused', A);
        await refusedGrant(PR, A, 'invalid_grant');
        await db.prepare("UPDATE dev_agents SET status = 'active' WHERE id = ?").run(A);
        await db.prepare('UPDATE users SET is_banned = 1 WHERE id = 10').run();
        await refusedGrant(PR, A, 'invalid_grant');
        await db.prepare('UPDATE users SET is_banned = 0 WHERE id = 10').run();
        await mint(PR, A);
        // A sandbox agent only for audiences that take sandbox tokens.
        await refusedGrant(SB, SA, 'invalid_target', { audience: 'openvibe.chat' });
        assert.strictEqual((await mint(SB, SA)).env, 'sandbox');

        // ── Grants: revoked, expired, a budget of 0 and the ceiling each leave the capability out ──
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/budgets/media.object.upload`, { limit: 0, window: 'day' }));
        assert.deepStrictEqual(await capsOf(PR, A), [['media.object.read'], ['media.object.delete']], 'budget 0 is the off switch');
        await refusedGrant(PR, A, 'invalid_scope', { scope: 'media.object.upload' });
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/budgets/media.object.upload`, { limit: 5, window: 'day' }));
        assert.deepStrictEqual((await capsOf(PR, A))[0], ['media.object.read', 'media.object.upload']);
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/budgets/media.object.delete`, { limit: 0, window: 'day' }));
        assert.deepStrictEqual(await capsOf(PR, A), [['media.object.read', 'media.object.upload'], []], 'budget 0 drops a confirm one too');
        await refusedGrant(PR, A, 'invalid_scope', { scope: 'media.object.delete' });
        ok(await api('owner', 'DELETE', `/${P}/agents/${A}/budgets/media.object.delete`));
        await db.prepare("UPDATE dev_agent_grants SET expires_at = '2001-01-01T00:00:00.000Z' WHERE agent_id = ? AND capability = 'media.object.upload'").run(A);
        assert.deepStrictEqual((await capsOf(PR, A))[0], ['media.object.read'], 'an expired grant, before any sweep');
        await db.prepare("UPDATE dev_agent_grants SET expires_at = NULL WHERE agent_id = ? AND capability = 'media.object.upload'").run(A);
        // Outside the ceiling without a cascade (the host's app grant flipped underneath): left out at issuance.
        await db.prepare("UPDATE dev_grants SET status = 'revoked' WHERE app_id = ? AND capability = 'media.object.upload'").run(PR);
        assert.deepStrictEqual((await capsOf(PR, A))[0], ['media.object.read']);
        await db.prepare("UPDATE dev_grants SET status = 'approved' WHERE app_id = ? AND capability = 'media.object.upload'").run(PR);
        ok(await api('owner', 'DELETE', `/${P}/agents/${A}/grants/media.object.read`));
        assert.deepStrictEqual(await capsOf(PR, A), [['media.object.upload'], ['media.object.delete']], 'a revoked grant');
        await refusedGrant(PR, A, 'invalid_scope', { scope: 'media.object.read' });
        await refusedGrant(PR, A, 'invalid_scope', { audience: 'openvibe.events' });

        // ── Confirm mode: the token carries the capability in cap_confirm; each use is one approval, spent once ──
        const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
        const D = digest('DELETE /v1/objects/obj_1');
        const ask = () => confirmations.create(db, { agentId: A, capability: 'media.object.delete', audience: 'openvibe.media', summary: 'Delete obj_1', requestDigest: D });
        const actor = { subject: owner, label: `user:${owner}` };
        const c1 = await ask();
        const spend = (c, d = D) => confirmations.consume(db, { id: c.id, audience: 'openvibe.media', requestDigest: d });
        const rejects = (p, code) => assert.rejects(p, (e) => { assert.strictEqual(e.code, code, e.message); return true; });
        await rejects(spend(c1), 'confirmation.not_pending');
        await confirmations.decide(db, actor, c1.id, 'approve', {});
        await rejects(spend(c1, digest('DELETE /v1/objects/obj_2')), 'confirmation.mismatch');
        const results = await Promise.allSettled([spend(c1), spend(c1), spend(c1)]);
        assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1, 'single use under concurrency');
        for (const r of results.filter((x) => x.status === 'rejected')) assert.strictEqual(r.reason.code, 'confirmation.used');
        const c2 = await ask();
        await confirmations.decide(db, actor, c2.id, 'approve', {});
        await db.prepare("UPDATE dev_confirmations SET expires_at = '2001-01-01T00:00:00.000Z' WHERE id = ?").run(c2.id);
        await rejects(spend(c2), 'confirmation.expired');
        assert.deepStrictEqual(await capsOf(PR, A), [['media.object.upload'], ['media.object.delete']], 'issuance neither needs nor spends an approval');

        // ── Service host: ns bounded by the host's own principal_grants rows ──
        SECRETS.actor = 'actor-secret';
        const grantActor = (cap, ns) => db.prepare("INSERT INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES ('actor', ?, 'openvibe.media', ?, 'test')").run(cap, JSON.stringify(ns));
        await grantActor('media.object.read', [P]);
        await grantActor('media.object.delete', ['app.*']);
        const S = ok(await api('owner', 'POST', `/${P}/agents`, { name: 'Actor agent', host: { type: 'service', id: 'actor' } }), 201).id;
        ok(await api('owner', 'PUT', `/${P}/agents/${S}/grants/media.object.read`, { mode: 'auto' }));
        ok(await api('owner', 'PUT', `/${P}/agents/${S}/grants/media.object.delete`, {}));
        const sc = await mint('actor', S);
        assert.ok(validate('identity.service-token-claims@1', sc).valid);
        assert.deepStrictEqual([sc.sub, sc.cap, sc.cap_confirm, sc.ns, sc.env, sc.act], [`agent:${S}`, ['media.object.read'], ['media.object.delete'], [P, `app.${P}.*`], 'production', { sub: 'svc:actor' }]);
        assert.deepStrictEqual((await mint('actor', S, { scope: 'media.object.read' })).ns, [P], 'only what the read row names');
        await db.prepare("UPDATE principal_grants SET namespaces = '[]' WHERE client_id = 'actor'").run();
        assert.deepStrictEqual((await mint('actor', S)).ns, [], 'rows that name no namespace give none');
        await refusedGrant('actor', A, 'invalid_grant');
        await refusedGrant(PR, S, 'invalid_grant');

        // ── Network's own routes refuse an agent token ──
        const now = Math.floor(Date.now() / 1000);
        const forged = serviceAuth.signServiceToken({ iss: ISSUER, sub: `agent:${A}`, actor_type: 'agent', aud: ['openvibe.network'], cap: ['network.project.read'],
            project_id: P, env: 'production', on_behalf_of: owner, act: { sub: `app:${PR}` }, iat: now, exp: now + 300, jti: 'tok_agentnet01' }, keys.privateKey);
        const g = await fetch(`${base}/internal/agents/${A}`, { headers: { authorization: `Bearer ${forged}` } });
        assert.deepStrictEqual([g.status, (await g.json()).code], [403, 'capability.denied']);

        // ── Revoked agent, archived project ──
        ok(await api('owner', 'DELETE', `/${P}/agents/${A}`));
        await refusedGrant(PR, A, 'invalid_grant');
        await db.prepare("UPDATE dev_projects SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(P);
        await refusedGrant('actor', S, 'invalid_grant');

        // ── Audit: every issue and refusal, never a secret or a token ──
        const rows = await db.prepare("SELECT * FROM dev_audit WHERE action IN ('agent.token_issued', 'agent.token_refused') ORDER BY id").all();
        const issued = rows.filter((r) => r.action === 'agent.token_issued');
        const refusals = rows.filter((r) => r.action === 'agent.token_refused');
        assert.ok(issued.some((r) => JSON.parse(r.detail).jti === claims.jti && r.actor === `app:${PR}` && r.target === `agent:${A}` && r.project_id === P));
        assert.ok(refusals.length >= 15, `refusals audited (${refusals.length})`);
        assert.ok(refusals.some((r) => JSON.parse(r.detail).reason === 'not the agent\'s host' && r.actor === `app:${PR2}`));
        assert.ok(refusals.some((r) => JSON.parse(r.detail).reason === 'agent revoked'));
        assert.ok(refusals.some((r) => r.project_id === null && JSON.parse(r.detail).reason === 'unknown agent'));
        const text = JSON.stringify(rows);
        for (const s of [...Object.values(SECRETS), res.body.access_token, 'ovsec_']) assert.ok(!text.includes(s), 'no secret or token in the audit');
        console.log('agent-tokens: all tests passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
