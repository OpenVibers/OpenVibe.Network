'use strict';

// The directory and message ledger belong to Network. A service's A2A address is selected from
// Network's configured first-party services, never from a registration body.
const crypto = require('node:crypto');
const express = require('express');
const { ids, http, validate, serviceAuth } = require('openvibe-contracts');
const { ensureUserSubject } = require('../identity/subjects');
const access = require('./access');
const eventRelay = require('../developer/event-relay');

const AGENT = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const KINDS = new Set(['actor', 'codes', 'link-local', 'chat-bot', 'service']);
const MAX_TASKS_PER_MINUTE = 60;
const MAX_THREAD_IDLE_MS = 24 * 60 * 60 * 1000;
const id = (prefix) => `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
const iso = (ms) => new Date(ms).toISOString();
const fail = (status, code, detail) => { throw Object.assign(new Error(detail), { status, code }); };
const parse = (value) => { try { return JSON.parse(value); } catch { return null; } };

function directoryView(row) {
    return { id: row.id, owner: row.owner_subject, kind: row.kind, name: row.name,
        ...(row.service ? { service: row.service } : {}), ...(row.machine_id ? { machine_id: row.machine_id } : {}),
        ...(row.endpoint ? { endpoint: row.endpoint } : {}), skills: parse(row.skills) || [],
        status: row.status, allow_others: !!row.allow_others, updated_at: row.updated_at };
}
function taskView(row) {
    return { id: row.id, thread: row.thread_id, from: row.from_agent, to: row.to_agent,
        on_behalf_of: row.on_behalf_of, message: parse(row.message), ...(row.skill_id ? { skillId: row.skill_id } : {}), status: row.status,
        result: row.result ? parse(row.result) : null, remote_id: row.remote_id || null,
        created_at: row.created_at, updated_at: row.updated_at };
}

/** The verified token's claims (the guard that ran before this router checked the signature). */
function tokenClaims(req) {
    try { return JSON.parse(Buffer.from(String(req.headers.authorization || '').slice(7).split('.')[1], 'base64url').toString('utf8')); }
    catch { return null; }
}

async function caller(db, req) {
    const sub = String(req.principal?.sub || '');
    if (sub.startsWith('link:')) {
        const machine = await access.selfNode(db, req);
        return { type: 'node', id: machine.id, owner: machine.owner_subject };
    }
    if (sub === 'svc:actor' || sub === 'svc:codes') {
        // A service registers and sends only for the person its token acts for: the agent's owner is the token's
        // on_behalf_of, never a subject in the body (a service that knows an id could otherwise speak as them).
        const person = String(tokenClaims(req)?.on_behalf_of || '');
        if (!USER.test(person)) fail(403, 'agents.owner_required', 'a service token must name the person it acts for');
        return { type: 'service', id: sub.slice(4), owner: person };
    }
    fail(403, 'agents.caller_denied', 'only Actor, Codes or a paired machine may register and send');
}

async function register(db, identity, body, now = Date.now()) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) fail(422, 'agents.name', 'agent name must be plain text up to 120 characters');
    const kind = String(body?.kind || '');
    if (!KINDS.has(kind)) fail(422, 'agents.kind', 'unknown agent kind');
    const skills = body?.skills === undefined ? [] : body.skills;
    if (!Array.isArray(skills) || skills.length > 100 || skills.some((s) => typeof s !== 'string' || !s || s.length > 120)) {
        fail(422, 'agents.skills', 'skills must be short names');
    }
    const status = body?.status === undefined ? 'offline' : String(body.status);
    if (!['online', 'busy', 'offline'].includes(status)) fail(422, 'agents.status', 'unknown agent status');
    let owner, service = null, machine = null, endpoint = null;
    if (identity.type === 'node') {
        if (kind !== 'link-local') fail(403, 'agents.kind_denied', 'a machine registers only its local agents');
        if (!(await access.settings(db, identity.id)).agents_talk) fail(403, 'agents.off', 'the owner has not let agents talk on this machine');
        owner = identity.owner; machine = identity.id;
    } else {
        if (kind !== identity.id) fail(403, 'agents.kind_denied', 'a service registers only its own agent kind');
        owner = identity.owner; service = identity.id;
        if (body?.owner != null && String(body.owner) !== owner) fail(403, 'agents.owner_denied', 'a service registers agents only for its own person');
        if (!USER.test(owner) || !(await db.prepare('SELECT 1 FROM users WHERE subject_id = ?').get(owner))) {
            fail(404, 'agents.owner_not_found', 'no such person');
        }
        endpoint = `https://openvibe.${service}/a2a/v1/tasks`;
    }
    const existingId = String(body?.id || '');
    if (existingId && !AGENT.test(existingId)) fail(422, 'agents.id', 'invalid agent id');
    if (existingId) {
        const prior = await db.prepare('SELECT * FROM agent_directory WHERE id = ?').get(existingId);
        if (!prior || prior.owner_subject !== owner || prior.service !== service || prior.machine_id !== machine) {
            fail(404, 'agents.not_found', 'no such agent of this caller');
        }
    }
    const agentId = existingId || `agt_${ids.ulid()}`, at = iso(now);
    if (existingId) {
        await db.prepare('UPDATE agent_directory SET name = ?, skills = ?, status = ?, updated_at = ? WHERE id = ?')
            .run(name, JSON.stringify(skills), status, at, agentId);
    } else {
        await db.prepare(`INSERT INTO agent_directory (id, owner_subject, kind, name, service, machine_id, endpoint, skills, status, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(agentId, owner, kind, name, service, machine, endpoint, JSON.stringify(skills), status, at);
    }
    return directoryView(await db.prepare('SELECT * FROM agent_directory WHERE id = ?').get(agentId));
}

function event(type, payload, who, subject, at) {
    const env = { event_id: ids.newId('event', Date.parse(at)), event_type: type, version: 1, source: 'network',
        actor: { type: 'user', id: who }, timestamp: at, visibility: 'internal',
        subject: { type: 'agent_task', id: subject }, payload };
    const v = validate('events.event-envelope@1', env), p = validate(`${type}@1`, payload);
    if (!v.valid || !p.valid) throw new Error(`agent event invalid: ${JSON.stringify((v.errors || []).concat(p.errors || [])).slice(0, 300)}`);
    return env;
}
const emit = (db, type, payload, who, subject, at) => eventRelay.writerFor(db).enqueue(db, event(type, payload, who, subject, at));

async function createTask(db, identity, targetId, body, now = Date.now()) {
    const to = AGENT.test(String(targetId)) ? await db.prepare('SELECT * FROM agent_directory WHERE id = ?').get(targetId) : null;
    if (!to) fail(404, 'agents.not_found', 'no such receiving agent');
    const fromId = String(body?.from || '');
    const from = AGENT.test(fromId) ? await db.prepare('SELECT * FROM agent_directory WHERE id = ?').get(fromId) : null;
    if (!from || (identity.type === 'node' ? from.machine_id !== identity.id : from.service !== identity.id)
        || (identity.type === 'service' && from.owner_subject !== identity.owner)) {
        fail(403, 'agents.sender_denied', 'this caller does not own the sending agent');
    }
    if (from.id === to.id) fail(422, 'agents.self', 'choose another agent');
    if (from.owner_subject !== to.owner_subject) {
        if (!to.allow_others) fail(403, 'agents.others_off', 'this agent does not accept other people');
        if (to.machine_id) {
            if (!from.machine_id) fail(403, 'agents.grant_required', 'a machine grant is required');
            const grant = await db.prepare(`SELECT * FROM link_access_grants WHERE from_principal = ? AND to_principal = ? AND
                revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1`)
                .get(from.machine_id, to.machine_id, iso(now));
            if (!grant || !JSON.parse(grant.scopes).includes('agent')) fail(403, 'agents.grant_required', 'an agent grant is required');
        }
    }
    const threadId = body?.thread ? String(body.thread) : id('thr');
    if (body?.thread && !/^thr_[A-Za-z0-9_-]{8,80}$/.test(threadId)) fail(422, 'agents.thread', 'invalid thread id');
    const taskId = id('tsk'), at = iso(now), message = body?.message, skillId = body?.skillId;
    const check = validate('agent.task@1', { id: taskId, thread: threadId, from: from.id, to: to.id,
        on_behalf_of: from.owner_subject, message, ...(skillId == null ? {} : { skillId }), created_at: at });
    if (!check.valid) fail(422, 'agents.invalid_task', 'text parts are required and each is at most 8000 characters');
    return db.tx(async () => {
        await db.prepare('SELECT id FROM agent_directory WHERE id = ? FOR UPDATE').get(from.id);
        const old = await db.prepare('SELECT * FROM agent_threads WHERE id = ? FOR UPDATE').get(threadId);
        if (old && (old.stopped_at || Date.parse(old.closes_at) <= now ||
            !((old.from_agent === from.id && old.to_agent === to.id) || (old.from_agent === to.id && old.to_agent === from.id)))) {
            fail(409, 'agents.thread_closed', 'this thread is closed or belongs to another pair');
        }
        const count = await db.prepare('SELECT COUNT(*) AS n FROM agent_tasks WHERE from_agent = ? AND to_agent = ? AND created_at > ?')
            .get(from.id, to.id, iso(now - 60_000));
        if (Number(count.n) >= MAX_TASKS_PER_MINUTE) fail(429, 'agents.rate_limit', '60 tasks per minute is the limit for this pair');
        if (!old) await db.prepare('INSERT INTO agent_threads (id, from_agent, to_agent, from_owner, to_owner, created_at, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(threadId, from.id, to.id, from.owner_subject, to.owner_subject, at, iso(now + MAX_THREAD_IDLE_MS));
        await db.prepare(`INSERT INTO agent_tasks (id, thread_id, from_agent, to_agent, on_behalf_of, message, skill_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(taskId, threadId, from.id, to.id, from.owner_subject, JSON.stringify(message), skillId || null, at, at);
        await emit(db, 'network.agent.task.created', { task_id: taskId, thread: threadId, from: from.id, to: to.id, at }, from.owner_subject, taskId, at);
        return { task: taskView(await db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId)), to: directoryView(to) };
    });
}

async function updateTask(db, taskId, status, result, by, now = Date.now()) {
    if (!['running', 'completed', 'failed', 'cancelled'].includes(status)) fail(422, 'agents.status', 'invalid result status');
    if (result != null) {
        const parts = result?.parts;
        if (!Array.isArray(parts) || parts.length < 1 || parts.length > 20 || parts.some((p) => p?.type !== 'text' ||
            typeof p.text !== 'string' || p.text.length > 8000)) fail(422, 'agents.result', 'result must contain text parts up to 8000 characters');
    }
    return db.tx(async () => {
        const task = await db.prepare('SELECT t.*, a.service, a.machine_id FROM agent_tasks t JOIN agent_directory a ON a.id = t.to_agent WHERE t.id = ? FOR UPDATE').get(taskId);
        if (!task) fail(404, 'agents.task_not_found', 'no such task');
        if (by.type === 'service' && task.service !== by.id || by.type === 'node' && task.machine_id !== by.id ||
            by.type === 'bot' && !task.machine_id) fail(403, 'agents.result_denied', 'this caller does not run the receiving agent');
        if (['completed', 'failed', 'cancelled'].includes(task.status)) fail(409, 'agents.task_closed', 'this task is already closed');
        const at = iso(now);
        await db.prepare('UPDATE agent_tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?').run(status, result == null ? null : JSON.stringify(result), at, taskId);
        if (result != null) await db.prepare('UPDATE agent_threads SET last_answer_at = ?, closes_at = ? WHERE id = ?').run(at, iso(now + MAX_THREAD_IDLE_MS), task.thread_id);
        await emit(db, 'network.agent.task.updated', { task_id: taskId, thread: task.thread_id, status, at }, task.on_behalf_of, taskId, at);
        return taskView(await db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId));
    });
}

async function stopThread(db, threadId, who, now = Date.now()) {
    return db.tx(async () => {
        const thread = await db.prepare('SELECT * FROM agent_threads WHERE id = ? FOR UPDATE').get(threadId);
        if (!thread || (thread.from_owner !== who && thread.to_owner !== who)) fail(404, 'agents.thread_not_found', 'no such thread of yours');
        const at = iso(now);
        if (!thread.stopped_at) {
            await db.prepare('UPDATE agent_threads SET stopped_at = ? WHERE id = ?').run(at, threadId);
            const tasks = await db.prepare("SELECT id FROM agent_tasks WHERE thread_id = ? AND status IN ('pending','running')").all(threadId);
            for (const task of tasks) {
                await db.prepare("UPDATE agent_tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(at, task.id);
                await emit(db, 'network.agent.task.updated', { task_id: task.id, thread: threadId, status: 'cancelled', at }, who, task.id, at);
            }
        }
        return { id: threadId, stopped_at: at };
    });
}

async function expireThreads(db, now = Date.now()) {
    const rows = await db.prepare('SELECT id, from_owner FROM agent_threads WHERE stopped_at IS NULL AND closes_at <= ? ORDER BY closes_at LIMIT 100').all(iso(now));
    for (const row of rows) await stopThread(db, row.id, row.from_owner, now);
    return rows.length;
}

function serviceToken(privateKey, issuer, cap, audience, person, now = Date.now()) {
    const iat = Math.floor(now / 1000);
    return serviceAuth.signServiceToken({ iss: issuer, sub: 'svc:network', actor_type: 'service', aud: [audience], cap: [cap],
        on_behalf_of: person, iat, exp: iat + 300, jti: id('tok') }, privateKey);
}

async function deliver({ task, to }, { config, privateKey, issuer, fetchImpl = globalThis.fetch, bot }) {
    if (to.machine_id) {
        const machines = (await bot.list(to.owner)).machines || [];
        const machine = machines.find((m) => m.node_id === to.machine_id);
        if (!machine) fail(503, 'agents.machine_unavailable', 'receiving machine is not bound to Bot');
        const token = serviceToken(privateKey, issuer, 'bot.machine.relay', 'openvibe.bot', to.owner);
        const response = await fetchImpl(`${config.services.bot.internalUrl}/api/v1/machines/${encodeURIComponent(machine.id)}/relay`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-OV-Subject': to.owner,
                'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ type: 'agent.task', task }), signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) fail(503, 'agents.machine_unavailable', 'Bot did not deliver the agent task');
        return { delivered: true };
    }
    if (to.service !== 'actor') fail(501, 'agents.service_unavailable', 'this service has no A2A task route yet');
    const token = serviceToken(privateKey, issuer, 'actor.a2a.task', 'openvibe.actor', to.owner);
    const response = await fetchImpl(`${config.services.actor.internalUrl}/a2a/v1/tasks`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-OV-Subject': to.owner,
            'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ message: task.message, ...(task.skillId ? { skillId: task.skillId } : {}) }), signal: AbortSignal.timeout(20000),
    });
    const out = await response.json().catch(() => null);
    if (!response.ok || !out) fail(503, 'agents.service_unavailable', 'the service did not accept the task');
    return { delivered: true, remote_id: out.id || null, state: out.state || null };
}

async function refreshServiceTask(db, task, { config, privateKey, issuer, fetchImpl = globalThis.fetch }) {
    if (task.status !== 'running' || !task.remote_id) return task;
    const recipient = await db.prepare('SELECT service, owner_subject FROM agent_directory WHERE id = ?').get(task.to);
    if (recipient?.service !== 'actor') return task;
    const token = serviceToken(privateKey, issuer, 'actor.a2a.task', 'openvibe.actor', recipient.owner_subject);
    let response;
    try {
        response = await fetchImpl(`${config.services.actor.internalUrl}/a2a/v1/tasks/${encodeURIComponent(task.remote_id)}`, {
            headers: { Authorization: `Bearer ${token}`, 'X-OV-Subject': recipient.owner_subject, Accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
    } catch { return task; }
    if (!response.ok) return task;
    const out = await response.json().catch(() => null);
    if (!out) return task;
    if (out.state === 'completed') return updateTask(db, task.id, 'completed', { parts: [{ type: 'text', text: String(out.answer || '').slice(0, 8000) }] }, { type: 'service', id: 'actor' });
    if (out.state === 'failed') return updateTask(db, task.id, 'failed', { parts: [{ type: 'text', text: String(out.error || 'the agent failed').slice(0, 8000) }] }, { type: 'service', id: 'actor' });
    return task;
}

function routers({ requireAuth, registerGuard, resultGuard, bot, config, privateKey, issuer, fetchImpl = globalThis.fetch }) {
    const relay = express.Router(), me = express.Router();
    const wrap = (fn) => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await fn(req, res, req.app.locals.db); } catch (e) {
            if (e.status && e.code) return http.sendProblem(res, e.status, e.code, { detail: e.message });
            console.error('[agent directory]', e.message);
            return http.sendProblem(res, 500, 'agents.failed', { detail: 'the agent request failed' });
        }
    };
    relay.use(registerGuard);
    relay.post('/register', express.json({ limit: '16kb' }), wrap(async (req, res, db) =>
        res.status(201).json({ agent: await register(db, await caller(db, req), req.body) })));
    relay.post('/:id/tasks', express.json({ limit: '64kb' }), wrap(async (req, res, db) => {
        const created = await createTask(db, await caller(db, req), req.params.id, req.body);
        let delivery;
        try { delivery = await deliver(created, { config, privateKey, issuer, fetchImpl, bot }); }
        catch (e) {
            await updateTask(db, created.task.id, 'failed', { parts: [{ type: 'text', text: e.message.slice(0, 500) }] },
                created.to.machine_id ? { type: 'bot' } : { type: 'service', id: created.to.service });
            throw e;
        }
        if (delivery.remote_id) await db.prepare('UPDATE agent_tasks SET remote_id = ? WHERE id = ?').run(delivery.remote_id, created.task.id);
        await updateTask(db, created.task.id, 'running', null, created.to.machine_id ? { type: 'bot' } : { type: 'service', id: created.to.service });
        res.status(201).json({ task: taskView(await db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(created.task.id)), delivery });
    }));
    relay.get('/tasks/:id', wrap(async (req, res, db) => {
        await expireThreads(db);
        const who = await caller(db, req);
        const row = await db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(req.params.id);
        if (!row) fail(404, 'agents.task_not_found', 'no such task');
        const agents = await db.prepare('SELECT id FROM agent_directory WHERE id IN (?, ?) AND ' +
            (who.type === 'node' ? 'machine_id = ?' : 'service = ?')).all(row.from_agent, row.to_agent, who.id);
        if (!agents.length) fail(404, 'agents.task_not_found', 'no such task of this caller');
        let task = taskView(row);
        task = await refreshServiceTask(db, task, { config, privateKey, issuer, fetchImpl });
        res.json({ task });
    }));
    relay.get('/inbox', wrap(async (req, res, db) => {
        await expireThreads(db);
        const who = await caller(db, req);
        const rows = await db.prepare(`SELECT t.* FROM agent_tasks t JOIN agent_directory a ON a.id = t.to_agent
            WHERE ${who.type === 'node' ? 'a.machine_id' : 'a.service'} = ? AND t.status IN ('pending','running')
            ORDER BY t.created_at DESC LIMIT 100`).all(who.id);
        res.json({ tasks: rows.map(taskView) });
    }));
    // Bot and service agents report asynchronous results. Their verified capability is selected in the mount.
    const results = express.Router();
    results.use(resultGuard);
    results.post('/tasks/:id/result', express.json({ limit: '64kb' }), wrap(async (req, res, db) => {
        const sub = String(req.principal?.sub || '');
        const by = sub === 'svc:bot' ? { type: 'bot' } : sub === 'svc:actor' || sub === 'svc:codes' ? { type: 'service', id: sub.slice(4) } : null;
        if (!by) fail(403, 'agents.result_denied', 'only the receiving service may answer');
        res.json({ task: await updateTask(db, req.params.id, req.body?.status, req.body?.result, by) });
    }));
    me.use(requireAuth);
    me.get('/agents', wrap(async (req, res, db) => {
        const who = await ensureUserSubject(db, req.user);
        const rows = await db.prepare('SELECT * FROM agent_directory WHERE owner_subject = ? ORDER BY updated_at DESC, id LIMIT 200').all(who);
        res.json({ agents: await names.nameAgents(db, rows.map(directoryView)) });
    }));
    me.put('/agents/:id/allow-others', express.json({ limit: '2kb' }), wrap(async (req, res, db) => {
        if (typeof req.body?.allow_others !== 'boolean') fail(422, 'agents.allow_others', 'allow_others must be boolean');
        const who = await ensureUserSubject(db, req.user);
        const changed = await db.prepare('UPDATE agent_directory SET allow_others = ?, updated_at = ? WHERE id = ? AND owner_subject = ?')
            .run(+req.body.allow_others, iso(Date.now()), req.params.id, who);
        if (!changed.changes) fail(404, 'agents.not_found', 'no such agent of yours');
        res.json({ agent: directoryView(await db.prepare('SELECT * FROM agent_directory WHERE id = ?').get(req.params.id)) });
    }));
    me.get('/agent-threads', wrap(async (req, res, db) => {
        const who = await ensureUserSubject(db, req.user);
        await expireThreads(db);
        const threads = await db.prepare('SELECT * FROM agent_threads WHERE from_owner = ? OR to_owner = ? ORDER BY created_at DESC LIMIT 100').all(who, who);
        const out = await Promise.all(threads.map(async (thread) => ({
            id: thread.id, from: thread.from_agent, to: thread.to_agent, created_at: thread.created_at,
            closes_at: thread.closes_at, stopped_at: thread.stopped_at || null,
            tasks: (await db.prepare('SELECT * FROM agent_tasks WHERE thread_id = ? ORDER BY created_at LIMIT 100').all(thread.id)).map(taskView),
        })));
        // Each side by name, machine and person, for the owner's Agents section on openvibe.link/machines.
        res.json({ threads: await names.nameThreads(db, out, who) });
    }));
    me.post('/agent-threads/:id/stop', wrap(async (req, res, db) =>
        res.json({ thread: await stopThread(db, req.params.id, await ensureUserSubject(db, req.user)) })));
    return { relay, results, me };
}

module.exports = { register, caller, createTask, updateTask, stopThread, deliver, routers, directoryView, taskView,
    expireThreads, refreshServiceTask, MAX_TASKS_PER_MINUTE, MAX_THREAD_IDLE_MS };
