'use strict';
// Delegated grants (plan T2 WS-Z2 slice 3, docs/t2-projects-and-grants.md sections 4-7; server/developer/agents.js):
// the delegation ceiling for production-app, sandbox-app and service hosts; modes (auto on a sensitive capability is
// refused, and effective_mode follows the installed catalog on every read); only the agent's owner sets a grant; and
// every cascade with its audit row: an allowance shrink, an app grant revoke, a service grant revoke and its expiry,
// then an app revocation, a member's removal and an archive taking the agents.
//   node test/agent-grants.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { capabilities } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const grantsAdmin = require('../server/identity/grants-admin');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
const PEOPLE = [[10, 'owner'], [11, 'dev'], [12, 'viewer'], [13, 'stranger'], [14, 'staff'], [15, 'admin']];
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (10, 'owner', 'x', 'user'), (11, 'dev', 'x', 'user'), (12, 'viewer', 'x', 'user'), (13, 'stranger', 'x', 'user'), (14, 'staff', 'x', 'admin'), (15, 'admin', 'x', 'user')`).run();
await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('actor', 'x', 'OpenVibe.Actor', '[]', 1)").run();
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
    const grantRow = async (agent, cap) => await db.prepare('SELECT * FROM dev_agent_grants WHERE agent_id = ? AND capability = ?').get(agent, cap);
    const audits = async (agent) => (await db.prepare("SELECT actor, detail, event FROM dev_audit WHERE target = ? AND action = 'grant.changed' ORDER BY id").all(`agent:${agent}`))
        .map((r) => { assert.strictEqual(r.event, null, 'no event until Contracts has a payload'); const d = JSON.parse(r.detail); return `${d.capability} ${d.from}>${d.to} ${d.mode} ${d.reason || '-'} ${r.actor}`; });
    try {
        // ── A project: a production app with two approved grants, a sandbox app with one, and Actor as a service host ──
        const P = ok(await api('owner', 'POST', '', { name: 'Delegation' }), 201).id;
        for (const [name, role] of [['dev', 'developer'], ['viewer', 'viewer'], ['admin', 'admin']]) ok(await api('owner', 'POST', `/${P}/members`, { username: name, role }), 201);
        ok(await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' }));
        ok(await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload', 'media.object.delete', 'events.app.publish'] }));
        const PR = ok(await api('owner', 'POST', `/${P}/apps`, { name: 'Bot', environment: 'production' }), 201).id;
        const SB = ok(await api('dev', 'POST', `/${P}/apps`, { name: 'Bot sandbox', environment: 'sandbox' }), 201).id;
        for (const c of ['media.object.upload', 'media.object.delete']) assert.strictEqual(ok(await api('owner', 'POST', `/${P}/apps/${PR}/grants`, { capability: c }), 201).status, 'approved');
        assert.strictEqual(ok(await api('dev', 'POST', `/${P}/apps/${SB}/grants`, { capability: 'media.object.read' }), 201).status, 'requested');
        assert.strictEqual(ok(await api('owner', 'POST', `/${P}/apps/${SB}/grants/media.object.read/approve`)).status, 'approved');
        for (const c of ['chat.message.send', 'chat.moderation.read']) await grantsAdmin.grant(db, { client_id: 'actor', capability: c, reason: 'agent host test' }, null);
        const ownBot = ok(await api('owner', 'POST', `/${P}/agents`, { name: 'Prod bot', host: { type: 'app', id: PR } }), 201).id;
        const devBot = ok(await api('dev', 'POST', `/${P}/agents`, { name: 'Sandbox bot', host: { type: 'app', id: SB } }), 201).id;
        const svcBot = ok(await api('dev', 'POST', `/${P}/agents`, { name: 'Actor helper', host: { type: 'service', id: 'actor' } }), 201).id;
        const put = (who, agent, cap, body = {}) => api(who, 'PUT', `/${P}/agents/${agent}/grants/${cap}`, body);

        // ── Production-app host: only what the app holds now, inside the allowance; never first-party ──
        const up = ok(await put('owner', ownBot, 'media.object.upload', { mode: 'auto' }));
        assert.deepStrictEqual({ ...up, granted_at: undefined }, {
            capability: 'media.object.upload', audience: 'openvibe.media', mode: 'auto', effective_mode: 'auto', sensitive: false,
            status: 'active', within_host: true, expires_at: null, granted_at: undefined, granted_by: `user:${S.owner}`,
        });
        assert.match(up.granted_at, /^\d{4}-\d{2}-\d{2}T/);
        refused(await put('owner', ownBot, 'events.app.publish'), 403, 'grant.beyond_host'); // in the allowance, but the app lacks it
        refused(await put('owner', ownBot, 'media.object.read'), 403, 'grant.beyond_host'); // the sandbox allowance is not a production app's
        refused(await put('owner', ownBot, 'chat.message.send'), 403, 'grant.beyond_host'); // first-party
        refused(await put('owner', ownBot, 'nope.thing.do'), 404, 'grant.unknown_capability');
        refused(await put('owner', ownBot, 'pics.image.upload'), 404, 'grant.not_grantable'); // planned
        refused(await put('owner', ownBot, 'media.object.upload', { mode: 'always' }), 422, 'grant.invalid');
        refused(await put('owner', ownBot, 'media.object.upload', { expires_at: '2001-01-01T00:00:00Z' }), 422, 'grant.invalid');

        // ── Modes: auto on a sensitive capability is refused; confirm is the default ──
        refused(await put('owner', ownBot, 'media.object.delete', { mode: 'auto' }), 422, 'grant.sensitive_requires_confirm');
        const del = ok(await put('owner', ownBot, 'media.object.delete'));
        assert.deepStrictEqual([del.mode, del.effective_mode, del.sensitive, del.within_host], ['confirm', 'confirm', true, true]);
        const later = new Date(Date.now() + 86400e3).toISOString();
        assert.strictEqual(ok(await put('owner', ownBot, 'media.object.upload', { mode: 'auto', expires_at: later })).expires_at, later);

        // ── effective_mode follows the installed catalog: a grant set to auto before its capability became sensitive reads as confirm ──
        const manifest = capabilities.get('media.object.upload');
        const wasSensitive = manifest.sensitive;
        manifest.sensitive = true;
        try {
            const g = ok(await api('owner', 'GET', `/${P}/agents/${ownBot}/grants`)).grants.find((x) => x.capability === 'media.object.upload');
            assert.deepStrictEqual([g.mode, g.effective_mode, g.sensitive], ['auto', 'confirm', true]);
            assert.strictEqual((await grantRow(ownBot, 'media.object.upload')).mode, 'auto', 'the stored row is not rewritten');
        } finally {
            if (wasSensitive === undefined) delete manifest.sensitive; else manifest.sensitive = wasSensitive;
        }
        assert.strictEqual(ok(await api('owner', 'GET', `/${P}/agents/${ownBot}/grants`)).grants.find((x) => x.capability === 'media.object.upload').effective_mode, 'auto');

        // ── Only the agent's owner sets a grant ──
        refused(await put('admin', ownBot, 'media.object.read'), 403, 'agent.forbidden');
        refused(await put('viewer', ownBot, 'media.object.read'), 403, 'agent.forbidden');
        refused(await put('dev', ownBot, 'media.object.upload'), 403, 'agent.forbidden');
        refused(await put('staff', ownBot, 'media.object.upload'), 403, 'project.forbidden');
        refused(await put('stranger', ownBot, 'media.object.upload'), 404, 'project.not_found');
        refused(await put(null, ownBot, 'media.object.upload'), 401, 'auth.required');

        // ── Sandbox-app host: the sandbox allowance counts, and still only what the app holds ──
        assert.strictEqual(ok(await put('dev', devBot, 'media.object.read', { mode: 'auto' })).within_host, true);
        refused(await put('dev', devBot, 'media.object.upload'), 403, 'grant.beyond_host');

        // ── Service host: its principal_grants, never an internal capability ──
        refused(await put('dev', svcBot, 'chat.message.send', { mode: 'auto' }), 422, 'grant.sensitive_requires_confirm');
        const chat = ok(await put('dev', svcBot, 'chat.message.send', { mode: 'confirm' }));
        assert.deepStrictEqual([chat.audience, chat.effective_mode, chat.within_host], ['openvibe.chat', 'confirm', true]);
        refused(await put('dev', svcBot, 'chat.moderation.read'), 403, 'grant.beyond_host'); // internal, though Actor holds it
        refused(await put('dev', svcBot, 'media.object.read'), 403, 'grant.beyond_host'); // Actor does not hold it

        // ── Read: members and staff ──
        assert.deepStrictEqual(ok(await api('viewer', 'GET', `/${P}/agents/${ownBot}/grants`)).grants.map((g) => g.capability), ['media.object.delete', 'media.object.upload']);
        assert.strictEqual(ok(await api('staff', 'GET', `/${P}/agents/${svcBot}/grants`)).grants.length, 1);
        refused(await api('stranger', 'GET', `/${P}/agents/${ownBot}/grants`), 404, 'project.not_found');

        // ── Revoke: the owner, an admin+ or staff; not twice ──
        refused(await api('viewer', 'DELETE', `/${P}/agents/${ownBot}/grants/media.object.delete`), 403, 'agent.forbidden');
        refused(await api('dev', 'DELETE', `/${P}/agents/${ownBot}/grants/media.object.delete`), 403, 'agent.forbidden');
        assert.strictEqual(ok(await api('staff', 'DELETE', `/${P}/agents/${ownBot}/grants/media.object.delete`)).status, 'revoked');
        refused(await api('owner', 'DELETE', `/${P}/agents/${ownBot}/grants/media.object.delete`), 409, 'grant.not_active');
        refused(await api('owner', 'DELETE', `/${P}/agents/${ownBot}/grants/media.object.list`), 404, 'grant.not_found');
        assert.strictEqual((await grantRow(ownBot, 'media.object.delete')).revoked_by, `user:${S.staff}`);
        assert.strictEqual(ok(await put('owner', ownBot, 'media.object.delete')).status, 'active', 'the owner may set it again');
        const again = await grantRow(ownBot, 'media.object.delete');
        assert.deepStrictEqual([again.revoked_at, again.revoked_by, again.revoke_reason], [null, null, null]);

        // ── Cascade: an allowance shrink revokes the delegated grants outside it; the sandbox allowance keeps devBot's ──
        ok(await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload', 'events.app.publish'] }));
        const cut = await grantRow(ownBot, 'media.object.delete');
        assert.deepStrictEqual([cut.status, cut.revoked_by, cut.revoke_reason], ['revoked', `user:${S.staff}`, 'beyond_host']);
        assert.strictEqual((await grantRow(ownBot, 'media.object.upload')).status, 'active');
        assert.strictEqual((await grantRow(devBot, 'media.object.read')).status, 'active');

        // ── Cascade: revoking the app's grant revokes its agents' delegated grant ──
        ok(await api('owner', 'DELETE', `/${P}/apps/${PR}/grants/media.object.upload`));
        assert.deepStrictEqual([(await grantRow(ownBot, 'media.object.upload')).status, (await grantRow(ownBot, 'media.object.upload')).revoke_reason], ['revoked', 'beyond_host']);
        assert.deepStrictEqual(await audits(ownBot), [
            `media.object.upload none>active auto - user:${S.owner}`,
            `media.object.delete none>active confirm - user:${S.owner}`,
            `media.object.upload active>active auto - user:${S.owner}`,
            `media.object.delete active>revoked confirm - user:${S.staff}`,
            `media.object.delete revoked>active confirm - user:${S.owner}`,
            `media.object.delete active>revoked confirm beyond_host user:${S.staff}`,
            `media.object.upload active>revoked auto beyond_host user:${S.owner}`,
        ]);

        // ── Cascade: /api/admin/grants/revoke on the service host ──
        await grantsAdmin.revoke(db, { client_id: 'actor', capability: 'chat.message.send', reason: 'no longer needed' }, S.owner);
        assert.deepStrictEqual([(await grantRow(svcBot, 'chat.message.send')).status, (await grantRow(svcBot, 'chat.message.send')).revoked_by], ['revoked', `user:${S.owner}`]);

        // ── Cascade: the service grant's expiry. It stops counting at once (within_host false); the sweep revokes ──
        await grantsAdmin.grant(db, { client_id: 'actor', capability: 'blog.post.publish', reason: 'agent host test', expires_at: later }, null);
        assert.strictEqual(ok(await put('dev', svcBot, 'blog.post.publish')).within_host, true);
        await db.prepare("UPDATE principal_grants SET expires_at = '2001-01-01 00:00:00' WHERE client_id = 'actor' AND capability = 'blog.post.publish'").run();
        const lapsed = ok(await api('dev', 'GET', `/${P}/agents/${svcBot}/grants`)).grants.find((g) => g.capability === 'blog.post.publish');
        assert.deepStrictEqual([lapsed.status, lapsed.within_host], ['active', false]);
        assert.ok(await grantsAdmin.expireDue(db) >= 1);
        assert.strictEqual((await grantRow(svcBot, 'blog.post.publish')).status, 'revoked');
        assert.deepStrictEqual(await audits(svcBot), [
            `chat.message.send none>active confirm - user:${S.dev}`,
            `chat.message.send active>revoked confirm beyond_host user:${S.owner}`,
            `blog.post.publish none>active confirm - user:${S.dev}`,
            'blog.post.publish active>revoked confirm beyond_host system:network',
        ]);

        // ── Losing the host or the project takes the agents (slice 2's cascades), each with its audit row; a revoked
        // agent's grants are outside every ceiling, and it takes no new ones ──
        const reasons = async (agent) => (await db.prepare("SELECT detail FROM dev_audit WHERE target = ? AND action = 'agent.revoked'").all(`agent:${agent}`)).map((r) => JSON.parse(r.detail).reason);
        ok(await api('dev', 'DELETE', `/${P}/apps/${SB}`));
        assert.deepStrictEqual(await reasons(devBot), ['app_revoked']);
        assert.strictEqual(ok(await api('dev', 'GET', `/${P}/agents/${devBot}/grants`)).grants[0].within_host, false);
        refused(await put('dev', devBot, 'media.object.read'), 409, 'agent.revoked');
        ok(await api('admin', 'DELETE', `/${P}/members/${S.dev}`), 204);
        assert.deepStrictEqual(await reasons(svcBot), ['member_removed']);
        ok(await api('owner', 'POST', `/${P}/archive`));
        assert.deepStrictEqual(await reasons(ownBot), ['project_archived']);
        refused(await put('owner', ownBot, 'media.object.delete'), 409, 'project.archived');
        console.log('agent grants: all tests passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
