'use strict';
// Agents (plan T2 WS-Z2 slice 2, docs/t2-projects-and-grants.md; server/developer/agents.js): who may create,
// rename, pause, resume and revoke; an agent is only ever its creator's; AGENT_HOST_SERVICES; an app of another
// project is not a host (404, and the composite foreign key); the CHECK constraints; and the cascades from an app
// revocation, a member's removal, an account erasure and a project archive.
//   node test/agents.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const accountData = require('../server/identity/account-data');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (10, 'owner', 'x', 'user'), (11, 'dev', 'x', 'user'), (12, 'viewer', 'x', 'user'), (13, 'stranger', 'x', 'user'),
    (14, 'staff', 'x', 'admin'), (15, 'admin', 'x', 'user'), (16, 'leaver', 'x', 'user'), (17, 'erased', 'x', 'user')`).run();
// The seed creates Actor's client (server/db/database.js); this file sets the fields it relies on.
await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris) VALUES ('actor', 'x', 'OpenVibe.Actor', '[]') ON CONFLICT (client_id) DO UPDATE SET client_secret = EXCLUDED.client_secret, name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris, is_first_party = 0").run();
const S = {};
for (const [id, name] of [[10, 'owner'], [11, 'dev'], [12, 'viewer'], [13, 'stranger'], [14, 'staff'], [15, 'admin'], [16, 'leaver'], [17, 'erased']]) {
    S[name] = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.locals.db = db;
// 'ghost' is listed but is no OAuth client; 'live' is an OAuth client but not listed. Neither hosts agents.
app.locals.config = { baseUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { sandboxAllowance: '', agentHostServices: 'actor,ghost' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);
const T = {};
for (const [id, name] of [[10, 'owner'], [11, 'dev'], [12, 'viewer'], [13, 'stranger'], [14, 'staff'], [15, 'admin'], [16, 'leaver'], [17, 'erased']]) {
    T[name] = jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
}

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
    const row = async (id) => await db.prepare('SELECT * FROM dev_agents WHERE id = ?').get(id);
    try {
        // ── A project with every role, a sandbox and a production app, and another project ──
        const P = ok(await api('owner', 'POST', '', { name: 'Agents' }), 201).id;
        for (const [name, role] of [['dev', 'developer'], ['viewer', 'viewer'], ['admin', 'admin'], ['leaver', 'developer'], ['erased', 'developer']]) {
            ok(await api('owner', 'POST', `/${P}/members`, { username: name, role }), 201);
        }
        ok(await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' }));
        const SB = ok(await api('dev', 'POST', `/${P}/apps`, { name: 'Bot sandbox', environment: 'sandbox' }), 201).id;
        const PR = ok(await api('owner', 'POST', `/${P}/apps`, { name: 'Bot', environment: 'production' }), 201).id;
        const Q = ok(await api('stranger', 'POST', '', { name: 'Elsewhere' }), 201).id;
        const QA = ok(await api('stranger', 'POST', `/${Q}/apps`, { name: 'Theirs', environment: 'sandbox' }), 201).id;
        const sandboxHost = { type: 'app', id: SB };

        // ── Authentication: user tokens only ──
        refused(await api(null, 'GET', `/${P}/agents`), 401, 'auth.required');

        // ── Create: for yourself, by role and host ──
        refused(await api('viewer', 'POST', `/${P}/agents`, { name: 'x', host: sandboxHost }), 403, 'project.forbidden');
        refused(await api('staff', 'POST', `/${P}/agents`, { name: 'x', host: sandboxHost }), 403, 'project.forbidden');
        refused(await api('stranger', 'POST', `/${P}/agents`, { name: 'x', host: sandboxHost }), 404, 'project.not_found');
        refused(await api('dev', 'POST', `/${P}/agents`, { name: 'x', host: { type: 'app', id: PR } }), 403, 'project.forbidden');
        refused(await api('dev', 'POST', `/${P}/agents`, { name: 'x', host: sandboxHost, owner: { type: 'user', id: S.owner } }), 403, 'agent.forbidden');
        refused(await api('admin', 'POST', `/${P}/agents`, { name: 'x', host: sandboxHost, owner: S.dev }), 403, 'agent.forbidden');
        // Another project's app is answered exactly like an unknown id, so app ids are not probed.
        refused(await api('dev', 'POST', `/${P}/agents`, { name: 'x', host: { type: 'app', id: QA } }), 404, 'app.not_found');
        refused(await api('dev', 'POST', `/${P}/agents`, { name: 'x', host: { type: 'app', id: `app_${'0'.repeat(26)}` } }), 404, 'app.not_found');
        refused(await api('dev', 'POST', `/${P}/agents`, { name: 'x', host: { type: 'service', id: 'live' } }), 422, 'agent.host_not_allowed');
        refused(await api('dev', 'POST', `/${P}/agents`, { name: 'x', host: { type: 'service', id: 'ghost' } }), 422, 'agent.host_not_allowed');
        refused(await api('dev', 'POST', `/${P}/agents`, { name: 'x', host: { type: 'mod', id: 'mod_x' } }), 422, 'agent.invalid');
        refused(await api('dev', 'POST', `/${P}/agents`, { name: ' ', host: sandboxHost }), 422, 'agent.invalid');

        const devBot = ok(await api('dev', 'POST', `/${P}/agents`, { name: 'Release bot', host: sandboxHost, owner: { type: 'user', id: S.dev } }), 201);
        assert.match(devBot.id, /^agt_[0-9A-HJKMNP-TV-Z]{26}$/);
        for (const ref of [devBot.subject, devBot.owner, devBot.host]) assert.ok(validate('identity.subject-ref@1', ref).valid, JSON.stringify(ref));
        assert.deepStrictEqual([devBot.project_id, devBot.owner.id, devBot.environment, devBot.status, devBot.revoked_at], [P, S.dev, 'sandbox', 'active', null]);
        const adminBot = ok(await api('admin', 'POST', `/${P}/agents`, { name: 'Prod bot', host: { type: 'app', id: PR } }), 201);
        assert.strictEqual(adminBot.environment, 'production');
        const actorBot = ok(await api('dev', 'POST', `/${P}/agents`, { name: 'Actor helper', host: { type: 'service', id: 'actor' } }), 201);
        assert.deepStrictEqual([actorBot.host, actorBot.environment], [{ type: 'service', id: 'actor' }, 'production']);
        assert.ok(validate('identity.subject-ref@1', actorBot.host).valid);
        assert.strictEqual((await row(devBot.id)).created_by, `user:${S.dev}`);

        // ── Read: members and staff; nobody else, and never through another project ──
        assert.strictEqual(ok(await api('viewer', 'GET', `/${P}/agents`)).agents.length, 3);
        assert.deepStrictEqual(ok(await api('dev', 'GET', `/${P}/agents?owner=me`)).agents.map((a) => a.id).sort(), [devBot.id, actorBot.id].sort());
        assert.strictEqual(ok(await api('staff', 'GET', `/${P}/agents`)).agents.length, 3);
        refused(await api('stranger', 'GET', `/${P}/agents`), 404, 'project.not_found');
        refused(await api('stranger', 'GET', `/${Q}/agents/${devBot.id}`), 404, 'agent.not_found');
        assert.deepStrictEqual(ok(await api('viewer', 'GET', `/${P}/agents/${devBot.id}`)), devBot);

        // ── Rename: the owner or an admin+ ──
        refused(await api('viewer', 'PATCH', `/${P}/agents/${devBot.id}`, { name: 'Mine now' }), 403, 'agent.forbidden');
        refused(await api('staff', 'PATCH', `/${P}/agents/${devBot.id}`, { name: 'Staff' }), 403, 'project.forbidden');
        refused(await api('leaver', 'PATCH', `/${P}/agents/${devBot.id}`, { name: 'Other dev' }), 403, 'agent.forbidden');
        assert.strictEqual(ok(await api('admin', 'PATCH', `/${P}/agents/${devBot.id}`, { name: 'Renamed by admin' })).name, 'Renamed by admin');
        assert.strictEqual(ok(await api('dev', 'PATCH', `/${P}/agents/${devBot.id}`, { name: 'Release bot' })).name, 'Release bot');

        // ── Pause and resume: staff may pause but not resume; the owner lifts a staff pause ──
        refused(await api('viewer', 'POST', `/${P}/agents/${devBot.id}/pause`), 403, 'agent.forbidden');
        assert.strictEqual(ok(await api('staff', 'POST', `/${P}/agents/${devBot.id}/pause`)).status, 'paused');
        assert.strictEqual(ok(await api('staff', 'POST', `/${P}/agents/${devBot.id}/pause`)).status, 'paused', 'pausing twice is a no-op');
        refused(await api('staff', 'POST', `/${P}/agents/${devBot.id}/resume`), 403, 'project.forbidden');
        refused(await api('leaver', 'POST', `/${P}/agents/${devBot.id}/resume`), 403, 'agent.forbidden');
        assert.strictEqual(ok(await api('dev', 'POST', `/${P}/agents/${devBot.id}/resume`)).status, 'active');
        assert.strictEqual(ok(await api('admin', 'POST', `/${P}/agents/${devBot.id}/pause`)).status, 'paused');
        assert.strictEqual(ok(await api('admin', 'POST', `/${P}/agents/${devBot.id}/resume`)).status, 'active');

        // ── Revoke: final ──
        const doomed = ok(await api('dev', 'POST', `/${P}/agents`, { name: 'Doomed', host: sandboxHost }), 201);
        refused(await api('viewer', 'DELETE', `/${P}/agents/${doomed.id}`), 403, 'agent.forbidden');
        const gone = ok(await api('staff', 'DELETE', `/${P}/agents/${doomed.id}`));
        assert.strictEqual(gone.status, 'revoked'); assert.ok(gone.revoked_at);
        assert.strictEqual((await row(doomed.id)).revoked_by, `user:${S.staff}`);
        assert.deepStrictEqual(ok(await api('dev', 'DELETE', `/${P}/agents/${doomed.id}`)), gone, 'revoking twice answers the same agent');
        refused(await api('dev', 'POST', `/${P}/agents/${doomed.id}/resume`), 409, 'agent.revoked');
        refused(await api('dev', 'POST', `/${P}/agents/${doomed.id}/pause`), 409, 'agent.revoked');
        refused(await api('dev', 'PATCH', `/${P}/agents/${doomed.id}`, { name: 'Back' }), 409, 'agent.revoked');

        const actions = (await db.prepare("SELECT action, actor FROM dev_audit WHERE target = ? ORDER BY id").all(`agent:${doomed.id}`)).map((a) => `${a.action} ${a.actor}`);
        assert.deepStrictEqual(actions, [`agent.created user:${S.dev}`, `agent.revoked user:${S.staff}`]);
        assert.ok(!(await db.prepare("SELECT event FROM dev_audit WHERE action LIKE 'agent.%' AND event IS NOT NULL").get()), 'no agent event until Contracts has a payload');

        // ── The database refuses what the routes never write ──
        const id = () => `agt_${crypto.randomBytes(20).toString('hex').toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '0').slice(0, 26)}`;
        const insert = (r) => db.prepare(`INSERT INTO dev_agents (id, project_id, owner_subject, host_kind, host_app_id, host_service, environment, name, status, created_by, revoked_at)
                                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.id || id(), r.project_id || P, S.dev, r.host_kind || 'app', r.host_app_id === undefined ? SB : r.host_app_id,
            r.host_service || null, r.environment || 'sandbox', 'x', r.status || 'active', 'test', r.revoked_at || null);
        const rejects = async (r, why) => { await assert.rejects(insert(r), undefined, why); };
        await insert({});
        await rejects({ host_app_id: null }, 'an app host needs host_app_id');
        await rejects({ host_kind: 'service', host_app_id: null, host_service: 'actor', environment: 'sandbox' }, 'a service host is production');
        await rejects({ host_kind: 'service', host_app_id: SB, host_service: 'actor', environment: 'sandbox' }, 'a service host has no app');
        await rejects({ status: 'revoked' }, 'revoked needs revoked_at');
        await rejects({ revoked_at: new Date().toISOString() }, 'revoked_at needs revoked');
        await rejects({ host_app_id: QA }, 'an app of another project (composite foreign key)');
        await rejects({ host_app_id: SB, environment: 'production' }, 'an app of the other environment (composite foreign key)');
        await rejects({ id: 'agt_lowercase0000000000000000000' }, 'not a Crockford ULID');
        await rejects({ id: `agx_${'0'.repeat(26)}` }, 'wrong prefix');
        await rejects({ host_kind: 'service', host_app_id: null, host_service: 'nobody', environment: 'production' }, 'a service host is an OAuth client');

        // ── Cascades ──
        // Revoking the app revokes the agents it hosts, and only those.
        const sbBot = ok(await api('dev', 'POST', `/${P}/agents`, { name: 'On SB', host: sandboxHost }), 201);
        ok(await api('dev', 'DELETE', `/${P}/apps/${SB}`));
        for (const a of [devBot, sbBot]) assert.deepStrictEqual([(await row(a.id)).status, (await row(a.id)).revoked_by], ['revoked', 'app_revoked'], a.name);
        assert.strictEqual((await row(actorBot.id)).status, 'active');
        refused(await api('dev', 'POST', `/${P}/agents`, { name: 'x', host: sandboxHost }), 404, 'app.not_found');
        assert.ok(await db.prepare("SELECT 1 FROM dev_audit WHERE action = 'agent.revoked' AND target = ? AND detail LIKE '%app_revoked%'").get(`agent:${sbBot.id}`));

        // A member who leaves (or is removed) takes their agents in that project with them.
        const leaverBot = ok(await api('leaver', 'POST', `/${P}/agents`, { name: 'Leaver', host: { type: 'service', id: 'actor' } }), 201);
        ok(await api('admin', 'DELETE', `/${P}/members/${S.leaver}`), 204);
        assert.deepStrictEqual([(await row(leaverBot.id)).status, (await row(leaverBot.id)).revoked_by], ['revoked', 'member_removed']);
        assert.strictEqual((await row(actorBot.id)).status, 'active');

        // An account erasure revokes the person's agents; their export lists them first, without who revoked one.
        const erasedBot = ok(await api('erased', 'POST', `/${P}/agents`, { name: 'Erased', host: { type: 'service', id: 'actor' } }), 201);
        const part = await accountData.networkPart(db, 17);
        const dev = part.files.find((f) => f.name === 'developer_projects.json').content;
        assert.deepStrictEqual(dev.agents.map((a) => [a.id, a.owner_subject, a.status]), [[erasedBot.id, S.erased, 'active']]);
        assert.ok(dev.agents.every((a) => !('revoked_by' in a)));
        const delId = `del_${'1'.repeat(26)}`;
        await db.prepare("INSERT INTO account_deletions (id, user_id, subject, requested_at, delete_after) VALUES (?, 17, ?, ?, ?)").run(delId, S.erased, new Date().toISOString(), new Date().toISOString());
        const erased = await accountData.erase(db, await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(delId));
        assert.strictEqual(erased.agents_revoked, 1);
        assert.deepStrictEqual([(await row(erasedBot.id)).status, (await row(erasedBot.id)).revoked_by], ['revoked', 'account_deleted']);
        assert.strictEqual((await row(actorBot.id)).status, 'active');

        // Archiving the project revokes every agent left, each with the archive as its cause.
        ok(await api('dev', 'POST', `/${P}/agents/${actorBot.id}/pause`));
        ok(await api('owner', 'POST', `/${P}/archive`));
        for (const a of [actorBot, adminBot]) assert.deepStrictEqual([(await row(a.id)).status, (await row(a.id)).revoked_by], ['revoked', 'project_archived'], a.name);
        refused(await api('owner', 'POST', `/${P}/agents`, { name: 'x', host: { type: 'service', id: 'actor' } }), 409, 'project.archived');
        assert.strictEqual(ok(await api('viewer', 'GET', `/${P}/agents`)).agents.filter((a) => a.status !== 'revoked').length, 0);
        assert.strictEqual(ok(await api('owner', 'DELETE', `/${P}/agents/${adminBot.id}`)).status, 'revoked', 'revoking in an archived project answers the agent');

        console.log('agents: all tests passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
