'use strict';
// The service-facing project read (plan T2 lane B step 3, docs/developer-projects.md "Service-side project reads"):
// GET /internal/projects/:project_id takes network.project.read on a service token (Host only by default), returns
// the project's tenancy, placement, allowance, quotas, apps and their grants, and never a secret, a client id, an
// actor label or a member other than the owner. Archived projects still read; a missing or malformed id is a 404.
//   node test/internal-projects.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const principals = require('../server/identity/principals');
const policy = require('../server/developer/policy');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare("UPDATE oauth_clients SET client_secret = 'host-secret' WHERE client_id = 'host'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (10, 'owner', 'x', 'user'), (11, 'dev', 'x', 'user'), (14, 'staff', 'x', 'admin')`).run();
const sid = async (id) => await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = {
    baseUrl: ISSUER, loginUrl: ISSUER,
    jwt: { issuer: ISSUER, accessTokenExpiry: '1h' },
    developer: { sandboxAudiences: 'openvibe.media', sandboxAllowance: '', credentialOverlapS: 60 },
};
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal', require('../server/internal/routes'));
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);
const userToken = (id) => jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const U = { owner: userToken(10), dev: userToken(11), staff: userToken(14) };

(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: { authorization: `Bearer ${U[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, text, body: text ? JSON.parse(text) : null };
    };
    const token = async (id, secret, scope) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network', ...(scope ? { scope } : {}) }) })).json()).access_token;
    const read = async (id, headers = {}) => {
        const r = await fetch(`${base}/internal/projects/${encodeURIComponent(id)}`, { headers });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control'), text, body: text ? JSON.parse(text) : null };
    };
    try {
        // 0. The grant: Host only by default, and never grantable to apps.
        assert.deepStrictEqual(principals.DEFAULT_GRANTS.filter(g => g[1] === 'network.project.read').map(g => [g[0], g[2]]), [['host', principals.SELF_AUDIENCE]],
            'only Host holds network.project.read by default');
        assert.strictEqual(policy.grantability('network.project.read').grantable, false, 'network.project.read is never grantable to apps');

        // A project made through the members' API: allowance, a quota, a second member, two apps with grants, one revoked.
        let r = await api('owner', 'POST', '', { name: 'Tenancy' });
        assert.strictEqual(r.status, 201, r.text);
        const P = r.body.id;
        r = await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload', 'media.object.read'] });
        assert.strictEqual(r.status, 200, r.text);
        r = await api('staff', 'PUT', `/${P}/quotas/media.object.upload`, { limit: 1073741824, window: 'total', unit: 'bytes' });
        assert.strictEqual(r.status, 200, r.text);
        r = await api('owner', 'POST', `/${P}/members`, { username: 'dev', role: 'developer' });
        assert.strictEqual(r.status, 201, r.text);
        r = await api('owner', 'POST', `/${P}/apps`, { name: 'Uploader', environment: 'sandbox', type: 'confidential' });
        assert.strictEqual(r.status, 201, r.text);
        const A = r.body.id;
        const secrets = [r.body.credential.client_secret];
        r = await api('owner', 'POST', `/${P}/apps`, { name: 'Reader', environment: 'sandbox', type: 'confidential' });
        assert.strictEqual(r.status, 201, r.text);
        const B = r.body.id;
        secrets.push(r.body.credential.client_secret);
        for (const [appId, cap] of [[A, 'media.object.upload'], [B, 'media.object.read']]) {
            assert.strictEqual((await api('owner', 'POST', `/${P}/apps/${appId}/grants`, { capability: cap })).status, 201);
            assert.strictEqual((await api('owner', 'POST', `/${P}/apps/${appId}/grants/${cap}/approve`)).status, 200);
        }
        r = await api('owner', 'DELETE', `/${P}/apps/${B}`);
        assert.strictEqual(r.status, 200, r.text);

        // 1. Auth matrix.
        const host = { authorization: `Bearer ${await token('host', 'host-secret')}` };
        r = await read(P);
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'token.missing', 'no token');
        assert.strictEqual((await read(P, { 'x-internal-key': 'legacy-key' })).status, 401, 'not the retired shared key');
        assert.strictEqual((await read(P, { authorization: `Bearer ${await token('live', 'live-secret')}` })).status, 403, 'Live lacks network.project.read');
        assert.strictEqual((await read(P, { authorization: `Bearer ${await token('host', 'host-secret', 'network.node.report')}` })).status, 403, 'a Host token scoped to another capability');
        assert.ok([401, 403].includes((await read(P, { authorization: `Bearer ${U.owner}` })).status), 'a person\'s session never reads it, not even the owner\'s');
        const appToken = (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: A, client_secret: secrets[0], audience: 'openvibe.network' }) })).json()).access_token;
        if (appToken) assert.ok([401, 403].includes((await read(P, { authorization: `Bearer ${appToken}` })).status), 'an app of the project cannot read it');

        // 2. The document.
        r = await read(P, host);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.cache, 'no-store');
        const owner = await sid(10);
        assert.deepStrictEqual(Object.keys(r.body).sort(), ['allowance', 'apps', 'grants', 'project', 'quotas']);
        assert.deepStrictEqual(r.body.project, {
            id: P, name: 'Tenancy', owner: { type: 'user', id: owner }, environment_policy: 'sandbox',
            home_cell: r.body.project.home_cell, residency: r.body.project.residency, preferred_regions: [],
            created_at: r.body.project.created_at, archived_at: null,
        });
        const member = (await api('owner', 'GET', `/${P}`)).body;
        assert.strictEqual(r.body.project.home_cell, member.home_cell, 'placement matches the members\' view');
        assert.strictEqual(r.body.project.residency, member.residency);
        assert.strictEqual(r.body.project.created_at, member.created_at);
        assert.deepStrictEqual(r.body.allowance, member.allowance, 'the allowance matches the members\' view');
        assert.deepStrictEqual([...r.body.allowance].sort(), ['media.object.read', 'media.object.upload']);
        assert.deepStrictEqual(r.body.quotas, [{ capability: 'media.object.upload', limit: 1073741824, window: 'total', unit: 'bytes', enforced_by: 'openvibe.media' }]);
        assert.deepStrictEqual(r.body.apps.map(a => [a.id, a.name, a.environment, a.status, !!a.revoked_at]).sort(), [[A, 'Uploader', 'sandbox', 'active', false], [B, 'Reader', 'sandbox', 'revoked', true]].sort());
        assert.deepStrictEqual(r.body.grants.map(g => [g.app_id, g.capability, g.audience]).sort(), [[A, 'media.object.upload', 'openvibe.media'], [B, 'media.object.read', 'openvibe.media']].sort());
        assert.strictEqual(r.body.grants.find(g => g.app_id === A).status, 'approved');
        const gB = r.body.grants.find(g => g.app_id === B);
        assert.strictEqual(gB.status, 'revoked', 'a revoked app\'s grant is listed as revoked');
        assert.strictEqual(gB.decided_at, r.body.apps.find(a => a.id === B).revoked_at, 'as of the app\'s revocation');

        // 3. Never a secret, a client id, an actor label or a member other than the owner.
        const dev = await sid(11);
        for (const s of secrets) assert.ok(!r.text.includes(s), 'no client secret');
        for (const k of ['client_secret', 'secret_hash', 'client_id', 'redirect_uris', 'token_valid_after', 'members', 'requested_by', 'decided_by', 'created_by', 'credential']) {
            assert.ok(!r.text.includes(`"${k}"`), `no ${k} in the body`);
        }
        assert.ok(!r.text.includes(dev), 'no member but the owner');
        assert.ok(!/:"(owner|dev|staff)"/.test(r.text), 'no usernames as values');

        // 4. Missing and malformed ids are 404 project.not_found, before or after the shape check.
        for (const id of ['prj_00000000000000000000000000', 'prj_nope', 'nope', `${P}'--`, P.toLowerCase()]) {
            const x = await read(id, host);
            assert.strictEqual(x.status, 404, id); assert.strictEqual(x.body.code, 'project.not_found', id);
            assert.match(x.type, /application\/problem\+json/);
        }

        // 5. An archived project still reads, with archived_at set and every app revoked.
        r = await api('owner', 'POST', `/${P}/archive`);
        assert.strictEqual(r.status, 200, r.text);
        r = await read(P, host);
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.body.project.archived_at, 'archived_at is set');
        assert.ok(r.body.apps.every(a => a.status === 'revoked'), 'archiving revoked every app');
        assert.ok(r.body.grants.length && r.body.grants.every(g => g.status === 'revoked'), 'and every grant of its apps reads revoked');
        assert.deepStrictEqual(r.body.quotas.map(q => q.capability), ['media.object.upload'], 'quotas outlive the archive');

        log('internal-projects: all assertions passed');
    } finally {
        server.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
})().catch((e) => { console.error(e); process.exit(1); });
