'use strict';
// The owning service's agent read (plan T2 WS-Z2 slice 6, docs/t2-projects-and-grants.md section 4):
// GET /internal/agents/:agent takes network.project.read on a service token and returns the agent, its active and
// unexpired delegated grants at the caller's own audience (effective_mode from the catalog) and only those grants'
// budgets. Another audience's grants are never shown (grants: [], not 404), nor the agent's project, owner or host;
// an agent that is not active lists none;
// an unknown or malformed id is a 404; no labels, digests or secrets; Cache-Control: no-store.
//   node test/internal-agents.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
for (const c of ['host', 'live', 'media']) await db.prepare(`UPDATE oauth_clients SET client_secret = '${c}-secret' WHERE client_id = ?`).run(c);
// Host holds network.project.read by default; Media gets it here to read its own audience's grants.
await db.prepare("INSERT INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES ('media', 'network.project.read', 'openvibe.network', '[]', 'test') ON CONFLICT DO NOTHING").run();
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (10, 'owner', 'x', 'user'), (14, 'staff', 'x', 'admin')`).run();
const owner = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 10').get());

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { sandboxAllowance: '' } };
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
    const token = async (id, scope) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: `${id}-secret`, audience: 'openvibe.network', ...(scope ? { scope } : {}) }) })).json()).access_token;
    const read = async (id, headers = {}) => {
        const r = await fetch(`${base}/internal/agents/${encodeURIComponent(id)}`, { headers });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control'), text, body: text ? JSON.parse(text) : null };
    };
    const refused = (r, status, code) => { assert.strictEqual(r.status, status, r.text); assert.strictEqual(r.body.code, code); assert.match(r.type, /problem\+json/); };
    try {
        // A production app holding three media capabilities; the agent is delegated delete (confirm), upload (auto)
        // and read (revoked again), with a budget on upload.
        const P = ok(await api('owner', 'POST', '', { name: 'Agents read' }), 201).id;
        ok(await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' }));
        ok(await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.read', 'media.object.upload', 'media.object.delete'] }));
        const PR = ok(await api('owner', 'POST', `/${P}/apps`, { name: 'Bot', environment: 'production' }), 201).id;
        for (const c of ['media.object.read', 'media.object.upload', 'media.object.delete']) ok(await api('owner', 'POST', `/${P}/apps/${PR}/grants`, { capability: c }), 201);
        const A = ok(await api('owner', 'POST', `/${P}/agents`, { name: 'Helper', host: { type: 'app', id: PR } }), 201).id;
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/grants/media.object.delete`, {}));
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/grants/media.object.upload`, { mode: 'auto' }));
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/grants/media.object.read`, { mode: 'auto' }));
        ok(await api('owner', 'DELETE', `/${P}/agents/${A}/grants/media.object.read`));
        ok(await api('owner', 'PUT', `/${P}/agents/${A}/budgets/media.object.upload`, { limit: 50, window: 'day' }));
        const media = { authorization: `Bearer ${await token('media')}` };
        const host = { authorization: `Bearer ${await token('host')}` };

        // ── The gate ──
        refused(await read(A), 401, 'token.missing');
        const denied = await read(A, { authorization: `Bearer ${await token('live')}` });
        refused(denied, 403, 'capability.denied');
        assert.strictEqual(denied.cache, 'no-store', 'the guard\'s refusal is not cached either');

        // ── The owning service sees its own audience's grants and their budgets ──
        const r = await read(A, media);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.cache, 'no-store');
        assert.deepStrictEqual(r.body.agent, { ...r.body.agent, id: A, project_id: P, owner: { type: 'user', id: owner }, host: { type: 'app', id: PR }, environment: 'production', status: 'active' });
        assert.deepStrictEqual(r.body.grants, [
            { capability: 'media.object.delete', audience: 'openvibe.media', mode: 'confirm', effective_mode: 'confirm', sensitive: true, expires_at: null },
            { capability: 'media.object.upload', audience: 'openvibe.media', mode: 'auto', effective_mode: 'auto', sensitive: false, expires_at: null },
        ], 'active grants only: the revoked read is not listed');
        assert.deepStrictEqual(r.body.budgets, [{ capability: 'media.object.upload', limit: 50, window: 'day', unit: 'requests', enforced_by: 'openvibe.media' }]);
        for (const s of ['granted_by', 'updated_by', 'created_by', 'request_digest', 'secret', `user:${owner}`]) assert.ok(!r.text.includes(s), `never ${s}`);

        // ── Another audience: 200 with the id alone, never a 404, the grants, the project, owner or host ──
        const h = await read(A, host);
        assert.strictEqual(h.status, 200, h.text);
        assert.deepStrictEqual(h.body, { agent: { id: A, subject: { type: 'agent', id: A } }, grants: [], budgets: [] });
        for (const s of [owner, PR, P]) assert.ok(!h.text.includes(s), `another audience never learns ${s}`);

        // ── A grant whose expires_at passed, before any sweep, is not listed; nor its budget ──
        await db.prepare("UPDATE dev_agent_grants SET expires_at = '2001-01-01T00:00:00.000Z' WHERE agent_id = ? AND capability = 'media.object.upload'").run(A);
        const e = (await read(A, media)).body;
        assert.deepStrictEqual([e.grants.map((g) => g.capability), e.budgets], [['media.object.delete'], []]);
        await db.prepare("UPDATE dev_agent_grants SET expires_at = NULL WHERE agent_id = ? AND capability = 'media.object.upload'").run(A);

        // ── An agent that is not active lists no grants ──
        ok(await api('owner', 'POST', `/${P}/agents/${A}/pause`));
        const p = (await read(A, media)).body;
        assert.deepStrictEqual([p.agent.status, p.grants, p.budgets], ['paused', [], []]);
        ok(await api('owner', 'POST', `/${P}/agents/${A}/resume`));
        assert.strictEqual((await read(A, media)).body.grants.length, 2);

        // ── Unknown and malformed ids ──
        refused(await read(`agt_${'9'.repeat(26)}`, media), 404, 'agent.not_found');
        refused(await read('agt_nope', media), 404, 'agent.not_found');
        refused(await read(P, media), 404, 'agent.not_found');
        console.log('internal-agents: all tests passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
