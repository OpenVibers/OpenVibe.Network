'use strict';
/**
 * Frame Runs: one front door for every run on OpenVibe (agent-engine.md §3; OpenVibe.Contracts docs/agents-runs.md).
 *
 * Everything a person asks an AI to do is a run with a thread of steps: a chat with Vibe, a coding task, an agent's
 * task. Each product keeps its own runs; this router lists, reads, starts, continues and follows them in one shape
 * (`agents.run@1` 1.1.0, `agents.step@1`, `agents.event@1`) under one address, the run's ref `<product>:<id>`:
 *
 *   GET  /api/frame/runs?kind=&status=&q=&limit=      every product's runs, newest first → { runs, next, partial }
 *   POST /api/frame/runs                             start (agents.run-start@1; Idempotency-Key)  → 201 the run
 *   GET  /api/frame/runs/:ref                        one run
 *   GET  /api/frame/runs/:ref/steps?after=&limit=    its thread → { steps, next }
 *   GET  /api/frame/runs/:ref/events                 its stream (agents.event@1 as server-sent events)
 *   POST /api/frame/runs/:ref/messages               say something to it { text, attachments } → 201 the step
 *   POST /api/frame/runs/:ref/stop                   stop it
 *   POST /api/frame/runs/:ref/approvals/:approval    answer an approval { answer }
 *
 * Products behind it (an adapter each; a product that serves the Run API natively needs only a pass-through):
 *   chat   OpenVibe.Chat's Vibe conversations (kind chat; a conversation is a run waiting for a message);
 *   codes  OpenVibe.Codes' tasks (kind code);
 *   actor  OpenVibe.Actor's tasks, already served as agents.run@1 (kind task).
 * The person's own bearer goes upstream unchanged; every product checks it. A product that does not answer within its
 * deadline is left out of a list and named in `partial`; it never blocks the others.
 */
const crypto = require('crypto');
const express = require('express');

const REF = /^([a-z][a-z0-9-]{0,30}):([A-Za-z0-9._~-]{1,160})$/;
const BEARER = /^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/;
const LIST_DEADLINE_MS = 4000;
const CALL_TIMEOUT_MS = 15000;
const POLL_MS = 1500;
const STREAM_MS = 55000;
const KINDS = new Set(['chat', 'ask', 'task', 'code', 'machine', 'goal']);
const STATUSES = new Set(['planning', 'running', 'waiting', 'done', 'failed', 'stopped']);

const iso = (t) => {
    if (t == null || t === '') return null;
    const v = String(t);
    const d = new Date(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const httpsUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; } };
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Codes' task status (codes.task-summary@1) → the run's. */
const CODES_STATUS = { queued: 'planning', running: 'running', 'needs-you': 'waiting', done: 'done', failed: 'failed', stopped: 'stopped' };
/** An AG-UI run's status (agent.run@1) → the run's. */
const AGUI_STATUS = { queued: 'planning', running: 'running', waiting: 'waiting', needs_you: 'waiting', succeeded: 'done', failed: 'failed', stopped: 'stopped', cancelled: 'stopped' };
const CODES_TARGET = { create: 'new', openvibe: 'openvibe' };

function createFrameRuns({ svcUrl = (name, fallback) => fallback, personOf = async () => null, fetchImpl = fetch, now = Date.now, log = console } = {}) {
    const base = {
        chat: svcUrl('chat', 'http://127.0.0.1:4400'),
        codes: svcUrl('codes', 'http://127.0.0.1:4900'),
        actor: svcUrl('actor', 'http://127.0.0.1:4950'),
    };
    async function call(product, path, { auth, method = 'GET', body, accept = 'application/json', timeoutMs = CALL_TIMEOUT_MS, idempotencyKey } = {}) {
        const headers = { Accept: accept, Authorization: auth };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        let r;
        try {
            r = await fetchImpl(new URL(path, base[product]).href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        } catch { throw fail(502, 'runs.product_unavailable', `${product} did not answer`); }
        const text = await r.text();
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (!r.ok) throw fail(r.status === 404 ? 404 : r.status >= 500 ? 502 : r.status, (json && json.code) || `runs.${product}_${r.status}`, (json && (json.error || json.detail || json.message)) || `${product} answered ${r.status}`);
        return json;
    }

    // ── chat: Vibe's conversations ──
    const chat = {
        product: 'chat',
        kinds: ['chat'],
        toRun(c, owner, last) {
            const persona = c.persona && typeof c.persona === 'object' ? c.persona : null;
            const at = iso(c.last_message_at || c.updated_at || c.created_at) || new Date(now()).toISOString();
            const run = {
                id: String(c.slug), ref: `chat:${c.slug}`, kind: 'chat', title: clip(c.name || (persona && persona.name) || 'Vibe', 200) || 'Vibe',   // the chat's own name: Chat sets it to the persona's unless the person renamed it
                owner, agent: { id: 'vibe', name: clip((persona && persona.name) || 'Vibe', 160) || 'Vibe', product: 'chat', harness: 'openvibe' },
                status: 'waiting', waiting: { for: 'message' },
                url: httpsUrl(c.url) || `https://openvibe.chat/vibe/${encodeURIComponent(c.slug)}`,
                created_at: iso(c.created_at) || at, updated_at: at,
            };
            if (persona && /^[a-z][a-z0-9-]{0,40}$/.test(String(persona.glyph || ''))) run.agent.glyph = persona.glyph;
            if (persona && Number.isInteger(persona.hue) && persona.hue >= 0 && persona.hue <= 359) run.agent.hue = persona.hue;
            if (persona && httpsUrl(persona.image_url)) run.agent.avatar_url = httpsUrl(persona.image_url);
            const line = last ? last.text : c.last_line;
            if (line) run.preview = { text: clip(line, 500), from: last ? (last.from === 'you' ? 'person' : 'agent') : 'agent', at };
            if (last && last.from === 'you') { run.status = 'running'; run.waiting = null; run.doing = { text: 'Writing an answer', glyph: 'spark' }; }
            const site = String(c.site || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            if (/^[a-z0-9.-]{3,80}$/.test(site)) run.context = { site };
            return run;
        },
        toStep(m, runId) {
            const step = { run_id: runId, seq: Number(m.id), kind: 'message', from: m.from === 'you' ? 'person' : 'agent', status: 'done', text: String(m.text || '').slice(0, 65536), started_at: iso(m.at) || new Date(now()).toISOString() };
            step.ended_at = step.started_at;
            if (Array.isArray(m.results) && m.results.length) step.ui = { type: 'results', data: { results: m.results.slice(0, 20) } };
            return step;
        },
        async list(auth, owner, { limit }) {
            const out = await call('chat', `/api/vibe/conversations?limit=${limit}`, { auth, timeoutMs: LIST_DEADLINE_MS });
            return (out && Array.isArray(out.conversations) ? out.conversations : []).filter((c) => c && c.slug).map((c) => chat.toRun(c, owner));
        },
        async get(auth, owner, id) {
            const out = await call('chat', `/api/vibe/chat?slug=${encodeURIComponent(id)}`, { auth });
            if (!out || !out.chat) throw fail(404, 'runs.not_found', 'No such run');
            const msgs = Array.isArray(out.messages) ? out.messages : [];
            const last = msgs[msgs.length - 1] || null;
            return chat.toRun({ ...out.chat, last_message_at: last && last.at }, owner, last);
        },
        async steps(auth, owner, id, { after, limit }) {
            const out = await call('chat', `/api/vibe/chat?slug=${encodeURIComponent(id)}${after ? `&after=${after}` : ''}`, { auth });
            if (!out || !out.chat) throw fail(404, 'runs.not_found', 'No such run');
            const steps = (Array.isArray(out.messages) ? out.messages : []).map((m) => chat.toStep(m, id)).filter((s) => Number.isInteger(s.seq) && s.seq > 0).slice(0, limit);
            return { steps, next: null };
        },
        async start(auth, owner, body) {
            const out = await call('chat', '/api/vibe/ask', { auth, method: 'POST', body: { message: body.text, fresh: true } });
            if (!out || !out.chat) throw fail(502, 'runs.chat_no_chat', 'Chat did not start a conversation');
            return chat.toRun({ ...out.chat, last_message_at: out.message && out.message.at }, owner, out.message ? { from: 'you', text: out.message.text || body.text, at: out.message.at } : null);
        },
        async say(auth, owner, id, msg) {
            const out = await call('chat', '/api/vibe/ask', { auth, method: 'POST', body: { message: msg.text, slug: id } });
            const m = out && out.message;
            if (!m) throw fail(502, 'runs.chat_no_message', 'Chat did not keep the message');
            return chat.toStep({ id: m.id, from: 'you', text: m.text || msg.text, at: m.at }, id);
        },
    };

    // ── codes: coding tasks ──
    const codes = {
        product: 'codes',
        kinds: ['code'],
        fromSummary(t, owner) {
            const status = CODES_STATUS[t.status] || 'running';
            const run = {
                id: t.id, ref: `codes:${t.id}`, kind: 'code', title: clip(t.title, 200) || 'A coding task', owner,
                agent: { id: 'codes', name: 'Codes', product: 'codes', glyph: 'code' },
                status, url: httpsUrl(t.url) || `https://openvibe.codes/tasks/${t.id}`,
                created_at: iso(t.started_at) || new Date(now()).toISOString(), updated_at: iso(t.updated_at) || iso(t.started_at) || new Date(now()).toISOString(),
                counts: { steps: Number.isInteger(t.steps) ? t.steps : 0 },
            };
            run.target = CODES_TARGET[t.mode] || (t.repo ? { repo: clip(t.repo, 300) } : 'new');
            if (status === 'waiting') run.waiting = { for: 'approval', what: 'Codes asks before it goes on' };
            if (status === 'running') run.doing = { text: 'Working on the code', glyph: 'code' };
            const outputs = [];
            if (httpsUrl(t.pr_url)) outputs.push({ kind: 'pr', title: 'Pull request', url: httpsUrl(t.pr_url) });
            if (httpsUrl(t.preview_url)) outputs.push({ kind: 'page', title: 'Preview', url: httpsUrl(t.preview_url) });
            if (outputs.length) run.outputs = outputs;
            if (['done', 'failed', 'stopped'].includes(status)) run.ended_at = run.updated_at;
            return run;
        },
        fromAgui(r, owner) {
            const status = AGUI_STATUS[r.status] || 'running';
            const run = {
                id: r.id, ref: `codes:${r.id}`, kind: 'code', title: clip(r.title, 200) || 'A coding task', owner,
                agent: { id: 'codes', name: 'Codes', product: 'codes', glyph: 'code' }, status,
                url: `https://openvibe.codes/tasks/${encodeURIComponent(r.id)}`,
                created_at: iso(r.started_at) || new Date(now()).toISOString(), updated_at: iso(r.ended_at || r.started_at) || new Date(now()).toISOString(),
                counts: { steps: Array.isArray(r.steps) ? r.steps.length : 0 },
            };
            if (r.result && typeof r.result === 'object' && typeof r.result.summary === 'string') run.result_summary = r.result.summary.slice(0, 8000);
            if (typeof r.cost_usd === 'number') run.cost = { usd: r.cost_usd };
            if (status === 'waiting') run.waiting = { for: 'approval', what: 'Codes asks before it goes on' };
            if (['done', 'failed', 'stopped'].includes(status)) run.ended_at = iso(r.ended_at) || run.updated_at;
            return run;
        },
        async list(auth, owner, { limit }) {
            const out = await call('codes', `/api/v1/me/tasks?limit=${Math.min(limit, 50)}`, { auth, timeoutMs: LIST_DEADLINE_MS });
            return (out && Array.isArray(out.tasks) ? out.tasks : []).filter((t) => t && t.id).map((t) => codes.fromSummary(t, owner));
        },
        async get(auth, owner, id) {
            return codes.fromAgui(await call('codes', `/api/v1/runs/${encodeURIComponent(id)}`, { auth }), owner);
        },
        async steps(auth, owner, id, { after, limit }) {
            const r = await call('codes', `/api/v1/runs/${encodeURIComponent(id)}`, { auth });
            const started = iso(r && r.started_at) || new Date(now()).toISOString();
            const steps = (Array.isArray(r && r.steps) ? r.steps : []).map((s, i) => {
                const title = clip(s && (s.title || s.name || s.label), 200);
                const text = clip(s && (s.text || s.summary || s.detail || s.title || s.name), 65536);
                const step = { run_id: id, seq: i + 1, kind: /tool|command|exec|edit/i.test(String(s && (s.kind || s.type) || '')) ? 'tool' : 'think', from: 'agent', text: text || null, started_at: iso(s && (s.started_at || s.at)) || started };
                if (title) step.title = title;
                const st = String(s && s.status || '');
                step.status = /run|progress|pending|active/.test(st) ? 'running' : /fail|error/.test(st) ? 'failed' : 'done';
                return step;
            }).filter((s) => !after || s.seq > after).slice(0, limit);
            return { steps, next: null };
        },
        async start(auth, owner, body, { idempotencyKey } = {}) {
            const target = body.target;
            if (!target || typeof target !== 'object' || !target.repo) throw fail(422, 'runs.codes_needs_a_repository', 'Codes starts a task on a repository for now ({ target: { repo } }); Create and OpenVibe without one are coming');
            const out = await call('codes', '/api/v1/tasks', { auth, method: 'POST', body: { repo: target.repo, ref: target.branch || null, prompt: body.text }, idempotencyKey });
            const id = out && (out.id || (out.task && out.task.id));
            if (!id) throw fail(502, 'runs.codes_no_task', 'Codes did not start a task');
            return codes.get(auth, owner, id).catch(() => ({ id, ref: `codes:${id}`, kind: 'code', title: clip(body.text, 200), owner, agent: { id: 'codes', name: 'Codes', product: 'codes', glyph: 'code' }, status: 'planning', target: { repo: target.repo }, created_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() }));
        },
        async stop(auth, owner, id, { reason }) {
            await call('codes', `/api/v1/tasks/${encodeURIComponent(id)}/stop`, { auth, method: 'POST', body: reason ? { reason } : {} });
            return codes.get(auth, owner, id);
        },
    };

    // ── actor: agents' tasks, served as agents.run@1 ──
    const RUN_TYPE = 'application/vnd.openvibe.agents.run+json, application/json';
    const actorRun = (r) => (r && r.id ? { ...r, ref: `actor:${r.id}`, kind: r.kind || 'task' } : r);
    const actor = {
        product: 'actor',
        kinds: ['task', 'goal', 'machine'],
        async list(auth, owner, { limit, status }) {
            const out = await call('actor', `/api/v1/runs?limit=${limit}${status ? `&status=${status}` : ''}`, { auth, accept: RUN_TYPE, timeoutMs: LIST_DEADLINE_MS });
            return (out && Array.isArray(out.runs) ? out.runs : []).filter((r) => r && r.id).map(actorRun);
        },
        async get(auth, owner, id) { return actorRun(await call('actor', `/api/v1/runs/${encodeURIComponent(id)}?shape=agents.run@1`, { auth, accept: RUN_TYPE })); },
        async steps(auth, owner, id, { after, limit }) {
            const out = await call('actor', `/api/v1/runs/${encodeURIComponent(id)}/steps?limit=${limit}${after ? `&after=${after}` : ''}`, { auth });
            return { steps: out && Array.isArray(out.steps) ? out.steps : [], next: out && out.next != null ? out.next : null };
        },
        async start(auth, owner, body, { idempotencyKey } = {}) {
            return actorRun(await call('actor', '/api/v1/runs', { auth, method: 'POST', body, accept: RUN_TYPE, idempotencyKey }));
        },
        async say(auth, owner, id, msg) { return call('actor', `/api/v1/runs/${encodeURIComponent(id)}/messages`, { auth, method: 'POST', body: msg }); },
        async stop(auth, owner, id, { reason }) { return actorRun(await call('actor', `/api/v1/runs/${encodeURIComponent(id)}/stop`, { auth, method: 'POST', body: reason ? { reason } : {}, accept: RUN_TYPE })); },
        async answer(auth, owner, id, approval, answer) { return call('actor', `/api/v1/runs/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approval)}`, { auth, method: 'POST', body: { answer } }); },
    };

    const PRODUCTS = { chat, codes, actor };
    const productFor = (ref) => {
        const m = REF.exec(String(ref || ''));
        if (!m || !PRODUCTS[m[1]]) throw fail(404, 'runs.not_found', 'No such run');
        return { a: PRODUCTS[m[1]], id: m[2] };
    };
    /** Which product starts a run: its kind, else a target (code), else Vibe (it answers, or hands the work on). */
    const starterFor = (body) => {
        if (body.kind === 'code' || body.target) return codes;
        if (body.kind && ['task', 'goal', 'machine'].includes(body.kind)) return actor;
        return chat;
    };

    const router = express.Router();
    const json = express.json({ limit: '64kb' });
    router.use((req, res, next) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600', 'Cache-Control': 'private, no-store', Vary: 'Authorization' });
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
    });
    /** The person: their bearer for the products, their subject for the owner field. */
    async function who(req) {
        const auth = String(req.get('authorization') || '');
        if (!BEARER.test(auth)) throw fail(401, 'auth.required', 'Sign in to see your runs');
        let person = null;
        try { person = await personOf(req); } catch { person = null; }
        const subject = person && (person.subject_id || person.subject || (person.id && /^usr_/.test(String(person.id)) ? person.id : null));
        return { auth, owner: { type: 'user', id: subject || 'usr_unknown' } };
    }
    const send = (res, err) => {
        const status = err && Number.isInteger(err.status) ? err.status : 500;
        if (status >= 500 && status !== 502) log.warn && log.warn(`[frame runs] ${err && err.message}`);
        return res.status(status).json({ error: err && err.status ? err.message : 'Runs are unavailable right now', code: (err && err.code) || 'runs.error' });
    };
    const handle = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { send(res, err); } };

    router.get('/', handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const kind = KINDS.has(String(req.query.kind || '')) ? String(req.query.kind) : null;
        const status = STATUSES.has(String(req.query.status || '')) ? String(req.query.status) : null;
        const q = clip(req.query.q, 200).toLowerCase();
        const asked = Object.values(PRODUCTS).filter((a) => !kind || a.kinds.includes(kind));
        const partial = [];
        const lists = await Promise.all(asked.map((a) => a.list(auth, owner, { limit, status }).catch((err) => {
            if (!(err && err.status === 401)) partial.push(a.product);
            return [];
        })));
        let runs = lists.flat();
        if (kind) runs = runs.filter((r) => (r.kind || 'task') === kind);
        if (status) runs = runs.filter((r) => r.status === status);
        if (q) runs = runs.filter((r) => `${r.title || ''} ${(r.preview && r.preview.text) || ''}`.toLowerCase().includes(q));
        // Needs you first, then newest.
        const needs = (r) => (r.status === 'waiting' && r.waiting && r.waiting.for !== 'message' ? 1 : 0);
        runs.sort((x, y) => needs(y) - needs(x) || String(y.updated_at).localeCompare(String(x.updated_at)));
        res.json({ runs: runs.slice(0, limit), next: null, partial });
    }));

    router.post('/', json, handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const text = clip(b.text, 16000);
        if (!text) throw fail(422, 'runs.start_needs_words', 'Say what the run is for ({ text })');
        const key = String(req.get('idempotency-key') || '');
        const idempotencyKey = /^[A-Za-z0-9._~-]{1,200}$/.test(key) ? key : (key ? null : crypto.randomUUID());
        const a = starterFor(b);
        const run = await a.start(auth, owner, { ...b, text }, { idempotencyKey });
        res.status(201).json(run);
    }));

    router.get('/:ref', handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const { a, id } = productFor(req.params.ref);
        res.json(await a.get(auth, owner, id));
    }));

    router.get('/:ref/steps', handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const { a, id } = productFor(req.params.ref);
        const after = parseInt(req.query.after, 10) > 0 ? parseInt(req.query.after, 10) : 0;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        res.json(await a.steps(auth, owner, id, { after, limit }));
    }));

    router.post('/:ref/messages', json, handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const { a, id } = productFor(req.params.ref);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const text = clip(b.text, 16000);
        const attachments = Array.isArray(b.attachments) ? b.attachments.slice(0, 20) : [];
        if (!text && !attachments.length) throw fail(422, 'runs.say_needs_words', 'Say something ({ text })');
        if (!a.say) throw fail(409, 'runs.cannot_say', `A ${a.product} run does not take messages yet`);
        res.status(201).json(await a.say(auth, owner, id, { text, attachments }));
    }));

    router.post('/:ref/stop', json, handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const { a, id } = productFor(req.params.ref);
        if (!a.stop) throw fail(409, 'runs.cannot_stop', a.product === 'chat' ? 'A conversation does not stop: it waits for you' : `A ${a.product} run cannot be stopped from here yet`);
        res.json(await a.stop(auth, owner, id, { reason: clip(req.body && req.body.reason, 500) || undefined }));
    }));

    router.post('/:ref/approvals/:approval', json, handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const { a, id } = productFor(req.params.ref);
        const approval = String(req.params.approval || '');
        if (!/^[A-Za-z0-9._~-]{1,160}$/.test(approval)) throw fail(404, 'runs.not_found', 'No such approval');
        const answer = req.body && req.body.answer;
        if (answer === undefined || answer === null || answer === '') throw fail(422, 'runs.answer_needed', 'An answer is required ({ answer })');
        if (!a.answer) throw fail(409, 'runs.cannot_answer', `Answer a ${a.product} run on its own page for now`);
        res.json(await a.answer(auth, owner, id, approval, answer));
    }));

    /**
     * The stream. A product without a stream of its own (Chat today) is followed by reading its steps every 1.5 s;
     * the connection closes after 55 s and the client resumes with Last-Event-ID (a step's seq), so a proxy never
     * holds it open forever. Events: step (a new step), run (the snapshot when a new step arrived), end.
     */
    router.get('/:ref/events', async (req, res) => {
        let ctx;
        try { ctx = await who(req); } catch (err) { return send(res, err); }
        let target;
        try { target = productFor(req.params.ref); } catch (err) { return send(res, err); }
        const last = String(req.get('last-event-id') || req.query.after || '0');
        if (!/^\d{1,16}$/.test(last)) return res.status(400).json({ error: 'Last-Event-ID is a step seq', code: 'runs.bad_event_id' });
        let after = Number(last);
        let open = true;
        req.on('close', () => { open = false; });
        res.status(200).set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const write = (event, id, data) => { if (open) res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`); };
        const until = now() + STREAM_MS;
        try {
            while (open && now() < until) {
                const { steps } = await target.a.steps(ctx.auth, ctx.owner, target.id, { after, limit: 100 });
                const fresh = steps.filter((s) => s.seq > after);
                for (const s of fresh) { write('step', s.seq, { step: s }); after = Math.max(after, s.seq); }
                if (fresh.length) {
                    const run = await target.a.get(ctx.auth, ctx.owner, target.id).catch(() => null);
                    if (run) {
                        write('run', after, { run });
                        if (['done', 'failed', 'stopped'].includes(run.status)) { write('end', after, { run_id: run.ref || req.params.ref, status: run.status }); break; }
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            }
        } catch (err) {
            write('error', null, { error: err && err.status ? err.message : 'The run could not be read', code: (err && err.code) || 'runs.error' });
        }
        if (open) res.end();
    });

    return { router, adapters: PRODUCTS };
}

module.exports = { createFrameRuns, REF };
