'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { ids, capabilities } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const access = require('../server/link/access');
const agents = require('../server/link/agents');
const { DEFAULT_GRANTS } = require('../server/identity/principals');

(async () => {
    const db = getDb(), owner = `usr_${ids.ulid()}`, other = `usr_${ids.ulid()}`, stranger = `usr_${ids.ulid()}`;
    for (const [subject, name] of [[owner, 'alex'], [other, 'sam'], [stranger, 'jo']]) {
        await db.prepare(`INSERT INTO users (username, email, password_hash, role, subject_id)
            SELECT ?, ?, 'x', 'user', ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE subject_id = ?)`)
            .run(name, `${name}-${subject.slice(-8)}@example.test`, subject, subject);
    }
    const node = async (who) => {
        const principal = `lnk_${ids.ulid()}`;
        await db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, trust, owner_subject, credential_hash, created_by)
            VALUES (?, ?, 'wnam-1', 'user', 'community', ?, ?, ?)`)
            .run(principal, `n-${ids.ulid().toLowerCase()}`, who, crypto.createHash('sha256').update(principal).digest('hex'), who);
        return { id: principal, owner_subject: who };
    };
    const a = await node(owner), b = await node(other), c = await node(owner);
    const granted = (client, cap, aud) => DEFAULT_GRANTS.some((g) => g[0] === client && g[1] === cap && g[2] === aud);
    for (const cap of ['network.link.access.request', 'network.agents.register', 'network.agents.relay', 'bot.machine.relay']) {
        assert.ok(capabilities.get(cap), `Contracts pin carries ${cap}`);
    }
    assert.ok(granted('actor', 'network.agents.register', 'openvibe.network'));
    assert.ok(granted('codes', 'network.agents.register', 'openvibe.network'));
    assert.ok(granted('bot', 'network.agents.relay', 'openvibe.network'));
    assert.ok(granted('network', 'bot.machine.relay', 'openvibe.bot'));
    assert.ok(!granted('chat', 'network.agents.register', 'openvibe.network'));

    const body = { to_principal: b.id, scopes: ['agent', 'send'], reason: 'work together' };
    await assert.rejects(access.ask(db, a, body), (e) => e.code === 'link_access.others_off');
    await access.putSettings(db, b.id, other, { others_may_ask: true });
    await assert.rejects(access.ask(db, a, body), (e) => e.code === 'link_access.not_followed');
    await db.prepare("INSERT INTO user_follows (follower_subject, target_type, target_id, active, revision) VALUES (?, 'channel', ?, 1, 1)").run(other, owner);
    const request = await access.ask(db, a, body);
    assert.equal(request.status, 'pending');
    await assert.rejects(access.answer(db, request.id, stranger, { approve: true }), (e) => e.code === 'link_access.request_not_found');
    await assert.rejects(access.answer(db, request.id, other, { approve: true, scopes: ['agent', 'computer'] }), (e) => e.code === 'link_access.widened_scope');
    await assert.rejects(access.answer(db, request.id, other, { approve: true, duration_seconds: 7200 }), (e) => e.code === 'link_access.widened_time');
    const answered = await access.answer(db, request.id, other, { approve: true, scopes: ['agent'], duration_seconds: 600 });
    assert.deepEqual(answered.grant.scopes, ['agent']);
    assert.equal(answered.request.status, 'approved');
    await assert.rejects(access.answer(db, request.id, other, { approve: false }), (e) => e.code === 'link_access.already_answered');
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs1' });
    const publicKey = pair.publicKey.export({ format: 'pem', type: 'pkcs1' });
    const token = await access.grantToken(db, answered.grant.id, a, privateKey, 'https://openvibe.network');
    const claims = jwt.verify(token.grant_token, publicKey, { algorithms: ['RS256'], audience: b.id, issuer: 'https://openvibe.network' });
    assert.equal(claims.sub, a.id);
    assert.deepEqual(claims.scopes, ['agent']);
    await assert.rejects(access.grantToken(db, answered.grant.id, b, privateKey, 'https://openvibe.network'), (e) => e.code === 'link_access.grant_not_found');
    await assert.rejects(access.useGrant(db, answered.grant.id, a.id, b.id, 'computer', 'click'), (e) => e.code === 'link_access.grant_denied');
    await access.useGrant(db, answered.grant.id, a.id, b.id, 'agent', 'task');
    await assert.rejects(access.revoke(db, answered.grant.id, stranger), (e) => e.code === 'link_access.grant_not_found');
    await access.revoke(db, answered.grant.id, owner);
    assert.equal(await access.liveGrant(db, answered.grant.id), null);
    await assert.rejects(access.grantToken(db, answered.grant.id, a, privateKey, 'https://openvibe.network'), (e) => e.code === 'link_access.grant_not_found');

    const denied = await access.ask(db, a, body);
    await access.answer(db, denied.id, other, { approve: false });
    await assert.rejects(access.ask(db, a, body), (e) => e.code === 'link_access.refused_cooldown');
    const noCooldownOwner = `usr_${ids.ulid()}`, d = await node(noCooldownOwner);
    await access.putSettings(db, d.id, noCooldownOwner, { others_may_ask: true });
    await db.prepare("INSERT INTO user_follows (follower_subject, target_type, target_id, active, revision) VALUES (?, 'channel', ?, 1, 1)").run(noCooldownOwner, owner);
    for (let i = 0; i < 5; i++) await access.ask(db, a, { to_principal: d.id, scopes: ['screen'] });
    await assert.rejects(access.ask(db, a, { to_principal: d.id, scopes: ['screen'] }), (e) => e.code === 'link_access.daily_limit');
    await assert.rejects(access.ask(db, a, { to_principal: c.id, scopes: ['computer'], duration_seconds: null }), (e) => e.code === 'link_access.duration');
    const own = await access.ask(db, a, { to_principal: c.id, scopes: ['agent', 'send'], duration_seconds: null });
    const ownGrant = await access.answer(db, own.id, owner, { approve: true });
    assert.equal(ownGrant.grant.expires_at, null);
    assert.ok(await access.liveGrant(db, ownGrant.grant.id, Date.now() + 31 * 86400_000));
    await access.putSettings(db, c.id, owner, { auto_agent_send: true });
    assert.equal((await access.ask(db, a, { to_principal: c.id, scopes: ['agent', 'send'] })).status, 'approved');
    assert.equal((await access.ask(db, a, { to_principal: c.id, scopes: ['computer'] })).status, 'pending');
    const oldPending = await access.ask(db, c, { to_principal: a.id, scopes: ['screen'] }, Date.now() - 2 * 86400_000);
    await access.expirePending(db);
    assert.equal((await db.prepare('SELECT status FROM link_access_requests WHERE id = ?').get(oldPending.id)).status, 'expired');

    // A service registers its agent for the person its token acts for, never for a subject in the body.
    const actorReq = (person) => ({ principal: { sub: 'svc:actor' }, headers: { authorization: `Bearer x.${Buffer.from(JSON.stringify({ sub: 'svc:actor', ...(person ? { on_behalf_of: person } : {}) })).toString('base64url')}.y` } });
    const actorAgent = await agents.register(db, await agents.caller(db, actorReq(other)), { kind: 'actor', name: 'Actor', skills: ['chat'], status: 'online' });
    assert.equal(actorAgent.owner, other);
    assert.equal(actorAgent.service, 'actor');
    await assert.rejects(agents.register(db, await agents.caller(db, actorReq(other)), { kind: 'actor', name: 'Actor', owner }), (e) => e.code === 'agents.owner_denied');
    await assert.rejects(agents.caller(db, actorReq(null)), (e) => e.code === 'agents.owner_required');

    await access.putSettings(db, a.id, owner, { agents_talk: true });
    await access.putSettings(db, b.id, other, { agents_talk: true });
    const from = await agents.register(db, { type: 'node', id: a.id, owner }, { kind: 'link-local', name: 'Codex', skills: ['code'], status: 'online' });
    const to = await agents.register(db, { type: 'node', id: b.id, owner: other }, { kind: 'link-local', name: 'Muse', skills: [], status: 'online' });
    await assert.rejects(agents.register(db, { type: 'node', id: a.id, owner }, { kind: 'actor', name: 'Forged' }), (e) => e.code === 'agents.kind_denied');
    const message = { role: 'user', parts: [{ type: 'text', text: 'hello' }] };
    await assert.rejects(agents.createTask(db, { type: 'node', id: a.id }, to.id, { from: from.id, message }), (e) => e.code === 'agents.others_off');
    // A service token acting for one person may not send from another person's agent of the same service.
    await assert.rejects(agents.createTask(db, { type: 'service', id: 'actor', owner }, actorAgent.id,
        { from: actorAgent.id, message }), (e) => e.code === 'agents.sender_denied');
    await db.prepare('UPDATE agent_directory SET allow_others = 1 WHERE id = ?').run(to.id);
    await assert.rejects(agents.createTask(db, { type: 'node', id: a.id }, to.id, { from: from.id, message }), (e) => e.code === 'agents.grant_required');
    // A fresh grant is required even though the prior grant's signed token has not expired.
    await db.prepare('UPDATE link_access_requests SET answered_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 86400_000).toISOString(), denied.id);
    const fresh = await access.ask(db, a, body);
    const replacement = await access.answer(db, fresh.id, other, { approve: true, scopes: ['agent'] });
    assert.equal(await access.liveGrant(db, replacement.grant.id, Date.now() + 3601_000), null);
    await assert.rejects(agents.createTask(db, { type: 'node', id: a.id }, to.id,
        { from: from.id, message: { parts: [{ type: 'text', text: 'x'.repeat(8001) }] } }), (e) => e.code === 'agents.invalid_task');
    const created = await agents.createTask(db, { type: 'node', id: a.id }, to.id, { from: from.id, message });
    assert.equal(created.task.status, 'pending');
    const targetDevice = `dev_${ids.ulid()}`;
    const machineDelivery = await agents.deliver(created, {
        config: { services: { bot: { internalUrl: 'http://127.0.0.1:4630' } } }, privateKey, issuer: 'https://openvibe.network',
        bot: { list: async () => ({ machines: [{ id: targetDevice, node_id: b.id }] }) },
        fetchImpl: async (url, options) => {
            assert.equal(url, `http://127.0.0.1:4630/api/v1/machines/${targetDevice}/relay`);
            const claims = jwt.verify(options.headers.Authorization.slice(7), publicKey, { algorithms: ['RS256'], audience: 'openvibe.bot' });
            assert.deepEqual(claims.cap, ['bot.machine.relay']);
            assert.equal(claims.on_behalf_of, other);
            assert.equal(JSON.parse(options.body).type, 'agent.task');
            return { ok: true };
        },
    });
    assert.equal(machineDelivery.delivered, true);
    await agents.updateTask(db, created.task.id, 'completed', { parts: [{ type: 'text', text: 'done' }] }, { type: 'bot' });
    await assert.rejects(agents.updateTask(db, created.task.id, 'completed', null, { type: 'bot' }), (e) => e.code === 'agents.task_closed');
    const second = await agents.createTask(db, { type: 'node', id: a.id }, to.id, { from: from.id, message, thread: created.task.thread });
    await agents.stopThread(db, second.task.thread, owner);
    await assert.rejects(agents.createTask(db, { type: 'node', id: a.id }, to.id,
        { from: from.id, message, thread: second.task.thread }), (e) => e.code === 'agents.thread_closed');
    const closed = await db.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(second.task.id);
    assert.equal(closed.status, 'cancelled');
    const idle = await agents.createTask(db, { type: 'node', id: a.id }, to.id, { from: from.id, message });
    await db.prepare('UPDATE agent_threads SET closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), idle.task.thread);
    await agents.expireThreads(db);
    assert.equal((await db.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(idle.task.id)).status, 'cancelled');
    const actorId = `agt_${ids.ulid()}`;
    await db.prepare(`INSERT INTO agent_directory (id, owner_subject, kind, name, service, endpoint, skills, status, allow_others)
        VALUES (?, ?, 'actor', 'Actor', 'actor', 'https://openvibe.actor/a2a/v1/tasks', '[]', 'online', 1)`).run(actorId, other);
    const serviceTask = await agents.createTask(db, { type: 'node', id: a.id }, actorId, { from: from.id, message, skillId: 'answer' });
    const delivered = await agents.deliver(serviceTask, { config: { services: { actor: { internalUrl: 'http://127.0.0.1:4950' } } },
        privateKey, issuer: 'https://openvibe.network', fetchImpl: async (url, options) => {
            assert.equal(url, 'http://127.0.0.1:4950/a2a/v1/tasks');
            const claims = jwt.verify(options.headers.Authorization.slice(7), publicKey, { algorithms: ['RS256'], audience: 'openvibe.actor' });
            assert.deepEqual(claims.cap, ['actor.a2a.task']);
            assert.equal(claims.on_behalf_of, other);
            assert.equal(JSON.parse(options.body).skillId, 'answer');
            return { ok: true, json: async () => ({ id: 'a2a_remote', state: 'submitted' }) };
        } });
    assert.equal(delivered.remote_id, 'a2a_remote');
    await db.prepare('UPDATE agent_tasks SET remote_id = ? WHERE id = ?').run(delivered.remote_id, serviceTask.task.id);
    await agents.updateTask(db, serviceTask.task.id, 'running', null, { type: 'service', id: 'actor' });
    const refreshed = await agents.refreshServiceTask(db,
        agents.taskView(await db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(serviceTask.task.id)),
        { config: { services: { actor: { internalUrl: 'http://127.0.0.1:4950' } } }, privateKey, issuer: 'https://openvibe.network',
            fetchImpl: async (url) => { assert.equal(url, 'http://127.0.0.1:4950/a2a/v1/tasks/a2a_remote');
                return { ok: true, json: async () => ({ state: 'completed', answer: 'answer' }) }; } });
    assert.equal(refreshed.status, 'completed');
    assert.equal(refreshed.result.parts[0].text, 'answer');
    // The per-pair rate is independent of IP and applies to agent-originated tasks.
    const minute = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 57; i++) await db.prepare(`INSERT INTO agent_tasks (id, thread_id, from_agent, to_agent, on_behalf_of, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(`tsk_${crypto.randomBytes(16).toString('hex')}`, created.task.thread, from.id, to.id, owner, JSON.stringify(message), minute, minute);
    await assert.rejects(agents.createTask(db, { type: 'node', id: a.id }, to.id, { from: from.id, message }), (e) => e.code === 'agents.rate_limit');
    await access.revoke(db, replacement.grant.id, other);

    // The owner's page names both sides (server/link/names.js): machines, people and agents, and which side the
    // viewer is on, never a bare lnk_/usr_/agt_ id.
    const names = require('../server/link/names');
    await db.prepare('UPDATE platform_node_principals SET name = ? WHERE id = ?').run('Alex laptop', a.id);
    await db.prepare('UPDATE platform_node_principals SET name = ? WHERE id = ?').run('Sam desktop', b.id);
    await db.prepare('UPDATE platform_node_principals SET name = ? WHERE id = ?').run('Alex desktop', c.id);
    const rows = (await db.prepare('SELECT * FROM link_access_requests WHERE from_owner = ? OR to_owner = ? ORDER BY asked_at').all(owner, owner)).map(access.requestView);
    const asSam = await names.nameAccessRows(db, rows.filter((r) => r.to_owner === other), other);
    assert.equal(asSam[0].side, 'in', 'a request to Sam is "in" for Sam');
    assert.equal(asSam[0].from_machine.name, 'Alex laptop');
    assert.equal(asSam[0].to_machine.name, 'Sam desktop');
    assert.equal(asSam[0].from_person.username, 'alex');
    const asAlex = await names.nameAccessRows(db, rows, owner);
    assert.equal(asAlex.find((r) => r.to_principal === b.id).side, 'out', 'the same request is "out" for Alex');
    assert.equal(asAlex.find((r) => r.to_principal === c.id).side, 'own', 'between Alex\'s own machines');
    const [thread] = await names.nameThreads(db, [{ id: 'thr_x', from: from.id, to: to.id, tasks: [] }], owner);
    assert.equal(thread.from_agent.name, 'Codex');
    assert.equal(thread.from_agent.mine, true);
    assert.equal(thread.to_agent.mine, false);
    assert.equal(thread.to_agent.person.username, 'sam');
    assert.equal(thread.to_agent.machine.name, 'Sam desktop');
    const [mineAgent] = await names.nameAgents(db, [agents.directoryView(await db.prepare('SELECT * FROM agent_directory WHERE id = ?').get(from.id))]);
    assert.equal(mineAgent.machine.name, 'Alex laptop');
    console.log('link access and agents: ownership, follow gate, defaults, narrowing, time, limits, token, revocation and relay refusals passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
