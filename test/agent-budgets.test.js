'use strict';
// Agent budgets (plan T2 WS-Z2 slice 5, docs/t2-projects-and-grants.md sections 3-5 and 7; server/developer/agents.js):
// the owner or an admin+ sets one (never staff as such, never another member), with enforced_by the owning service;
// it needs an active delegated grant and stays within the project's quota (same window and unit); a bad limit or
// window is refused; revoking the grant deletes it; a budget of 0 stops confirmations from being spent.
//   node test/agent-budgets.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const confirmations = require('../server/developer/confirmations');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
const PEOPLE = [[10, 'owner'], [11, 'dev'], [12, 'viewer'], [13, 'stranger'], [14, 'staff'], [15, 'admin']];
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (10, 'owner', 'x', 'user'), (11, 'dev', 'x', 'user'), (12, 'viewer', 'x', 'user'), (13, 'stranger', 'x', 'user'), (14, 'staff', 'x', 'admin'), (15, 'admin', 'x', 'user')`).run();
const S = {};
for (const [id, name] of PEOPLE) S[name] = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { sandboxAllowance: 'media.object.read', agentHostServices: 'actor' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);
const T = {};
for (const [id, name] of PEOPLE) T[name] = jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: { ...(who ? { authorization: `Bearer ${T[who]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('content-type') || '', body: text ? JSON.parse(text) : null };
    };
    const ok = (r, status = 200) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); return r.body; };
    const refused = (r, status, code) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); assert.strictEqual(r.body.code, code); assert.match(r.type, /problem\+json/); };
    const audits = async (agent) => (await db.prepare("SELECT action, actor, detail FROM dev_audit WHERE target = ? AND action LIKE 'agent.budget_%' ORDER BY id").all(`agent:${agent}`))
        .map((r) => { const d = JSON.parse(r.detail); return `${r.action} ${d.capability} ${d.limit === undefined ? '-' : d.limit} ${d.reason || '-'} ${r.actor}`; });
    try {
        const P = ok(await api('owner', 'POST', '', { name: 'Budgets' }), 201).id;
        for (const [name, role] of [['dev', 'developer'], ['viewer', 'viewer'], ['admin', 'admin']]) ok(await api('owner', 'POST', `/${P}/members`, { username: name, role }), 201);
        ok(await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' }));
        ok(await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload', 'media.object.delete'] }));
        const PR = ok(await api('owner', 'POST', `/${P}/apps`, { name: 'Bot', environment: 'production' }), 201).id;
        for (const c of ['media.object.upload', 'media.object.delete']) ok(await api('owner', 'POST', `/${P}/apps/${PR}/grants`, { capability: c }), 201);
        const bot = ok(await api('admin', 'POST', `/${P}/agents`, { name: 'Uploader', host: { type: 'app', id: PR } }), 201).id;
        ok(await api('admin', 'PUT', `/${P}/agents/${bot}/grants/media.object.upload`, { mode: 'auto' }));
        ok(await api('admin', 'PUT', `/${P}/agents/${bot}/grants/media.object.delete`, {}));
        const put = (who, cap, body, agent = bot) => api(who, 'PUT', `/${P}/agents/${agent}/budgets/${cap}`, body);

        // ── The agent's owner sets one; the owning service enforces it ──
        assert.deepStrictEqual(ok(await put('admin', 'media.object.upload', { limit: 1073741824, window: 'day', unit: 'bytes' })),
            { capability: 'media.object.upload', limit: 1073741824, window: 'day', unit: 'bytes', enforced_by: 'openvibe.media' });
        // Overwrite; unit defaults to requests
        assert.deepStrictEqual(ok(await put('admin', 'media.object.upload', { limit: 50, window: 'hour' })),
            { capability: 'media.object.upload', limit: 50, window: 'hour', unit: 'requests', enforced_by: 'openvibe.media' });
        // An admin+ caps a member's agent (here the project owner, who does not own the agent)
        ok(await put('owner', 'media.object.delete', { limit: 10, window: 'day' }));
        // A budget of 0 is legal (the issuance off switch)
        ok(await put('admin', 'media.object.delete', { limit: 0, window: 'day' }));
        assert.deepStrictEqual(ok(await api('viewer', 'GET', `/${P}/agents/${bot}/budgets`)).budgets.map((b) => [b.capability, b.limit, b.window]),
            [['media.object.delete', 0, 'day'], ['media.object.upload', 50, 'hour']]);
        assert.strictEqual(ok(await api('staff', 'GET', `/${P}/agents/${bot}/budgets`)).budgets.length, 2, 'staff read');
        refused(await api('stranger', 'GET', `/${P}/agents/${bot}/budgets`), 404, 'project.not_found');

        // ── Who: not a developer who does not own it, not a viewer, not staff as such, not a stranger ──
        refused(await put('dev', 'media.object.upload', { limit: 1, window: 'day' }), 403, 'agent.forbidden');
        refused(await put('viewer', 'media.object.upload', { limit: 1, window: 'day' }), 403, 'agent.forbidden');
        refused(await put('staff', 'media.object.upload', { limit: 1, window: 'day' }), 403, 'project.forbidden');
        refused(await put('stranger', 'media.object.upload', { limit: 1, window: 'day' }), 404, 'project.not_found');
        refused(await put(null, 'media.object.upload', { limit: 1, window: 'day' }), 401, 'auth.required');
        refused(await api('dev', 'DELETE', `/${P}/agents/${bot}/budgets/media.object.upload`), 403, 'agent.forbidden');
        refused(await api('staff', 'DELETE', `/${P}/agents/${bot}/budgets/media.object.upload`), 403, 'project.forbidden');

        // ── Validation ──
        for (const body of [{ limit: -1, window: 'day' }, { limit: 1.5, window: 'day' }, { limit: '5', window: 'day' }, { window: 'day' },
            { limit: 5, window: 'week' }, { limit: 5 }, { limit: 5, window: 'day', unit: 'Bytes!' }]) {
            refused(await put('admin', 'media.object.upload', body), 422, 'budget.invalid');
        }
        refused(await put('admin', 'media.object.upload', { limit: 5, window: 'day' }, `agt_${'9'.repeat(26)}`), 404, 'agent.not_found');
        refused(await put('admin', 'media.object.list', { limit: 5, window: 'day' }), 404, 'grant.not_found');

        // ── Never beyond the project's quota: a higher limit, another window or another unit ──
        ok(await api('staff', 'PUT', `/${P}/quotas/media.object.upload`, { limit: 100, window: 'hour', unit: 'requests' }));
        refused(await put('admin', 'media.object.upload', { limit: 101, window: 'hour' }), 422, 'budget.beyond_quota');
        refused(await put('admin', 'media.object.upload', { limit: 10, window: 'day' }), 422, 'budget.beyond_quota');
        refused(await put('admin', 'media.object.upload', { limit: 10, window: 'hour', unit: 'bytes' }), 422, 'budget.beyond_quota');
        assert.strictEqual(ok(await put('admin', 'media.object.upload', { limit: 100, window: 'hour' })).limit, 100, 'equal to the quota');
        assert.strictEqual(ok(await api('admin', 'GET', `/${P}/agents/${bot}/budgets`)).budgets.find((b) => b.capability === 'media.object.upload').limit, 100);

        // ── A budget of 0 stops an approved confirmation from being spent ──
        const D = 'a'.repeat(64);
        await db.prepare('DELETE FROM dev_agent_budgets WHERE agent_id = ? AND capability = ?').run(bot, 'media.object.delete');
        const c = await confirmations.create(db, { agentId: bot, capability: 'media.object.delete', audience: 'openvibe.media', summary: 'Delete one photo', requestDigest: D });
        await db.prepare("UPDATE dev_confirmations SET state = 'approved', decided_at = ?, decided_by = 'test' WHERE id = ?").run(new Date().toISOString(), c.id);
        ok(await put('admin', 'media.object.delete', { limit: 0, window: 'day' }));
        await assert.rejects(confirmations.consume(db, { id: c.id, audience: 'openvibe.media', requestDigest: D }), (e) => e.code === 'grant.not_delegated');
        assert.strictEqual((await db.prepare('SELECT used_at FROM dev_confirmations WHERE id = ?').get(c.id)).used_at, null);

        // ── DELETE removes it; revoking the grant deletes its budget ──
        assert.strictEqual(ok(await api('admin', 'DELETE', `/${P}/agents/${bot}/budgets/media.object.delete`)).limit, 0);
        refused(await api('admin', 'DELETE', `/${P}/agents/${bot}/budgets/media.object.delete`), 404, 'budget.not_found');
        ok(await api('staff', 'DELETE', `/${P}/agents/${bot}/grants/media.object.upload`));
        assert.deepStrictEqual(ok(await api('admin', 'GET', `/${P}/agents/${bot}/budgets`)).budgets, []);
        refused(await put('admin', 'media.object.upload', { limit: 5, window: 'hour' }), 404, 'grant.not_found');
        // Each change is an audit row (no event), and the cascade names its cause.
        assert.deepStrictEqual(await audits(bot), [
            `agent.budget_set media.object.upload 1073741824 - user:${S.admin}`,
            `agent.budget_set media.object.upload 50 - user:${S.admin}`,
            `agent.budget_set media.object.delete 10 - user:${S.owner}`,
            `agent.budget_set media.object.delete 0 - user:${S.admin}`,
            `agent.budget_set media.object.upload 100 - user:${S.admin}`,
            `agent.budget_set media.object.delete 0 - user:${S.admin}`,
            `agent.budget_removed media.object.delete - - user:${S.admin}`,
            `agent.budget_removed media.object.upload - grant_revoked user:${S.staff}`,
        ]);

        // ── A revoked agent takes no budget ──
        ok(await api('admin', 'DELETE', `/${P}/agents/${bot}`));
        refused(await put('admin', 'media.object.delete', { limit: 5, window: 'day' }), 409, 'agent.revoked');
        console.log('agent budgets: all tests passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
