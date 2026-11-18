'use strict';
/**
 * Frame Runs: one front door for every run on OpenVibe (agent-engine.md §3; OpenVibe.Contracts docs/agents-runs.md).
 *
 * Everything a person asks an AI to do is a run with a thread of steps: a chat with Vibe, a coding task, an agent's
 * task. Each product keeps its own runs; this router lists, reads, starts, continues and follows them in one shape
 * (`agents.run@1` 1.1.0, `agents.step@1`, `agents.event@1`) under one address, the run's ref `<product>:<id>`:
 *
 *   GET  /api/frame/runs?kind=&status=&q=&limit=&archived=1
 *                                                    every product's runs, newest first → { runs, next, partial };
 *                                                    runs last touched before the new agent system (FRAME_RUNS_SINCE,
 *                                                    2026-11-15) are archived: left out unless archived=1, never deleted,
 *                                                    and anything running or waiting on the person always shows
 *   POST /api/frame/runs                             start (agents.run-start@1; Idempotency-Key)  → 201 the run
 *   POST /api/frame/runs/files                       a file for the next message (the body is the file, its name in
 *                                                    X-Filename; at most 10 MB) → 201 { file }: an ai.file@1 reference,
 *                                                    stored in Media as the person through Chat, for `attachments`
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
 * Words with no kind and no target are the person's agent's to place (one agent, 2026-11-13; placeFor below): coding
 * work goes to Codes' make mode, work on the person's own computer to Actor as a machine run, the rest to Vibe.
 * The person's own bearer goes upstream unchanged; every product checks it. A product that does not answer within its
 * deadline is left out of a list and named in `partial`; it never blocks the others.
 */
const crypto = require('crypto');
const express = require('express');
// The shared effort ladder every harness maps to its own flag (OpenVibe.Codes' runner: claude --effort, codex
// model_reasoning_effort …); auto leaves it to the harness.
const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

const REF = /^([a-z][a-z0-9-]{0,30}):([A-Za-z0-9._~-]{1,160})$/;
const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The ai.file@1 references a message carries (Media objects only, at most 10); anything else is left out. */
function aiFiles(list) {
    return (Array.isArray(list) ? list : []).filter((f) => f && typeof f === 'object' && MEDIA_ID.test(String(f.id || ''))).slice(0, 10);
}
const BEARER = /^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/;
const LIST_DEADLINE_MS = 4000;
const CALL_TIMEOUT_MS = 15000;
const POLL_MS = 1500;
const STREAM_MS = 55000;
const KINDS = new Set(['chat', 'ask', 'task', 'code', 'machine', 'goal', 'group']);
const STATUSES = new Set(['planning', 'running', 'waiting', 'done', 'failed', 'stopped']);

const iso = (t) => {
    if (t == null || t === '') return null;
    const v = String(t);
    const d = new Date(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
/**
 * The way an Actor conversation is worked (Actor's engines, 11-16): a kind's name ('agent', 'model', 'decisions',
 * 'harness', 'openai-agent', 'open-model', 'auto') or { kind, model?, harness?, specialist? } (a specialist such as
 * 'design' on the agent engine, plan §AD.25). Only its shape is checked here; Actor checks the rest and refuses in words.
 */
function engineOf(v) {
    const KIND = /^[a-z][a-z-]{1,30}$/;
    if (typeof v === 'string') return KIND.test(v) ? v : null;
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.kind !== 'string' || !KIND.test(v.kind)) return null;
    return { kind: v.kind, ...(typeof v.model === 'string' && v.model.trim() ? { model: v.model.trim().slice(0, 256) } : {}), ...(typeof v.harness === 'string' && v.harness.trim() ? { harness: v.harness.trim().slice(0, 40) } : {}), ...(typeof v.specialist === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(v.specialist) ? { specialist: v.specialist } : {}) };
}
const httpsUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; } };
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Codes' task status (codes.task-summary@1) → the run's. */
const CODES_STATUS = { queued: 'planning', running: 'running', 'needs-you': 'waiting', done: 'done', failed: 'failed', stopped: 'stopped' };
/** An AG-UI run's status (agent.run@1) → the run's. */
const AGUI_STATUS = { queued: 'planning', running: 'running', waiting: 'waiting', needs_you: 'waiting', succeeded: 'done', failed: 'failed', stopped: 'stopped', cancelled: 'stopped' };
const CODES_TARGET = { create: 'new', openvibe: 'openvibe' };

/** When the new agent system began (the owner, 11-15: "we should clear out old conversations, since now the system works
 *  way differently"): the list starts here. Older runs stay in each product (Actor's tasks, Chat, Codes) and in the
 *  account export; ?archived=1 lists them too. */
const RUNS_SINCE = (() => { const t = Date.parse(String(process.env.FRAME_RUNS_SINCE || '2026-11-15T00:00:00Z')); return Number.isFinite(t) ? t : 0; })();

function createFrameRuns({ svcUrl = (name, fallback) => fallback, personOf = async () => null, fetchImpl = fetch, now = Date.now, log = console, since = RUNS_SINCE, extra = {} } = {}) {
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
            const files = aiFiles(body.attachments);
            const out = await call('chat', '/api/vibe/ask', { auth, method: 'POST', body: { message: body.text, fresh: true, ...(files.length ? { files } : {}) } });
            if (!out || !out.chat) throw fail(502, 'runs.chat_no_chat', 'Chat did not start a conversation');
            return chat.toRun({ ...out.chat, last_message_at: out.message && out.message.at }, owner, out.message ? { from: 'you', text: out.message.text || body.text, at: out.message.at } : null);
        },
        async say(auth, owner, id, msg) {
            const files = aiFiles(msg.attachments);
            const out = await call('chat', '/api/vibe/ask', { auth, method: 'POST', body: { message: msg.text, slug: id, ...(files.length ? { files } : {}) } });
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
        // The next words to a coding task (plan §AD.8: one session surface): Codes queues them while an attempt runs and
        // carries the task on when none does; a model the session's chip changed to carries it on with that model.
        async say(auth, owner, id, msg) {
            const text = withFiles(msg.text, msg.attachments);
            const model = msg.model && typeof msg.model.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\/#-]{0,99}$/.test(msg.model.id) ? msg.model.id : null;
            // A model or an effort changed on the chip carries the task on with it (Codes' continue reads both).
            const effort = EFFORTS.includes(msg.effort) ? msg.effort : null;
            if (model || effort) await call('codes', `/api/v1/tasks/${encodeURIComponent(id)}/continue`, { auth, method: 'POST', body: { text, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } });
            else await call('codes', `/api/v1/tasks/${encodeURIComponent(id)}/message`, { auth, method: 'POST', body: { text } });
            return { run_id: id, seq: null, kind: 'message', from: 'person', status: 'done', text, started_at: new Date(now()).toISOString() };
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
        // Rename (plan §AD.8, the session's ⋯ menu): the person names the task; null gives it back its first line.
        async rename(auth, owner, id, title) {
            await call('codes', `/api/v1/tasks/${encodeURIComponent(id)}`, { auth, method: 'PATCH', body: { title } });
            return codes.get(auth, owner, id);
        },
        // A replay link anyone can read (Codes' /r/<token>, plan §AD.6 (6)): made by the person themself, or stopped.
        async replay(auth, owner, id, { stop = false } = {}) {
            const out = await call('codes', `/api/v1/tasks/${encodeURIComponent(id)}/replay`, { auth, method: stop ? 'DELETE' : 'POST' });
            if (stop) return { stopped: !!(out && out.stopped) };
            const url = out && typeof out.url === 'string' && /^https:\/\/[^\s"'<>]+\/r\/[A-Za-z0-9_-]{16,64}$/.test(out.url) ? out.url : null;
            if (!url) throw fail(502, 'runs.codes_no_replay', 'Codes did not make the replay link');
            return { url, created_at: iso(out.created_at) || null };
        },
    };

    // ── actor: the person's Actor, served as agents.run@1 ──
    // 2026-11-15 (the owner: "it's supposed to use the actor even when you're on here … your main actor … instead of
    // vibe character"): a run is a whole conversation with the person's Actor (Actor's ?conversation(s)=1, Actor#517),
    // started with { text }, continued with POST …/messages, stopped with …/stop. A file rides as its link in the words.
    const RUN_TYPE = 'application/vnd.openvibe.agents.run+json, application/json';
    const ACTOR_TURN = 1000000;   // Actor's conversation step numbers: a turn's place × 1,000,000, + 1 for the person's words
    const actorRun = (r) => (r && r.id ? { ...r, ref: `actor:${r.id}`, kind: r.kind || 'task' } : r);
    const withFiles = (text, attachments) => {
        const links = aiFiles(attachments).map((f) => httpsUrl(f.url) && `${clip(f.name || 'A file', 120) || 'A file'}: ${httpsUrl(f.url)}`).filter(Boolean);
        return links.length ? `${text || 'Look at the attached files.'}\n\nAttached:\n${links.map((l) => `- ${l}`).join('\n')}` : text;
    };
    const actor = {
        product: 'actor',
        kinds: ['chat', 'task', 'goal', 'machine'],
        async list(auth, owner, { limit, status }) {
            const out = await call('actor', `/api/v1/runs?limit=${limit}&conversations=1${status ? `&status=${status}` : ''}`, { auth, accept: RUN_TYPE, timeoutMs: LIST_DEADLINE_MS });
            return (out && Array.isArray(out.runs) ? out.runs : []).filter((r) => r && r.id).map(actorRun);
        },
        async get(auth, owner, id) { return actorRun(await call('actor', `/api/v1/runs/${encodeURIComponent(id)}?shape=agents.run@1&conversation=1`, { auth, accept: RUN_TYPE })); },
        async steps(auth, owner, id, { after, limit }) {
            const out = await call('actor', `/api/v1/runs/${encodeURIComponent(id)}/steps?conversation=1&limit=${limit}${after ? `&after=${after}` : ''}`, { auth });
            return { steps: out && Array.isArray(out.steps) ? out.steps : [], next: out && out.next != null ? out.next : null };
        },
        async start(auth, owner, body, { idempotencyKey } = {}) {
            const agentId = typeof body.agent === 'string' && /^agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(body.agent) ? body.agent : undefined;
            const text = withFiles(body.text, body.attachments);
            // The kind, the model and the computer ride along for Actor to read as it grows into them; today the words lead.
            const kind = ['task', 'goal', 'machine'].includes(body.kind) ? body.kind : undefined;
            const model = body.model && typeof body.model === 'object' && typeof body.model.id === 'string' ? body.model : undefined;
            const where = body.where && typeof body.where === 'object' && body.where.kind === 'machine' && typeof body.where.id === 'string' ? { kind: 'machine', id: body.where.id } : undefined;
            const way = engineOf(body.engine);
            return actorRun(await call('actor', '/api/v1/runs', { auth, method: 'POST', body: { text, ...(kind ? { kind } : {}), ...(agentId ? { agent: agentId } : {}), ...(model ? { model } : {}), ...(where ? { where } : {}), ...(way ? { engine: way } : {}) }, accept: RUN_TYPE, idempotencyKey }));
        },
        async say(auth, owner, id, msg) {
            const text = withFiles(msg.text, msg.attachments);
            const out = await call('actor', `/api/v1/runs/${encodeURIComponent(id)}/messages`, { auth, method: 'POST', body: { text, ...(msg.model ? { model: msg.model } : {}), ...(msg.engine ? { engine: msg.engine } : {}) } });
            const turns = out && out.run && Number.isInteger(out.run.turns) ? out.run.turns : null;
            // The person's words as the step the thread will read back (the same seq, so it is drawn once).
            return { run_id: id, seq: turns ? (turns - 1) * ACTOR_TURN + 1 : null, kind: 'message', from: 'person', status: 'done', text, started_at: new Date(now()).toISOString() };
        },
        // Rename (plan §AD.8): the person names the conversation; null gives it back its first message.
        async rename(auth, owner, id, title) {
            return actorRun(await call('actor', `/api/v1/runs/${encodeURIComponent(id)}`, { auth, method: 'PATCH', body: { title }, accept: RUN_TYPE }));
        },
        // The conversation's approval level (agents.run@1 1.5.0; the session's chip in the box, 11-18), with a name too.
        async setLevel(auth, owner, id, level, title) {
            return actorRun(await call('actor', `/api/v1/runs/${encodeURIComponent(id)}`, { auth, method: 'PATCH', body: { level, ...(title !== undefined ? { title } : {}) }, accept: RUN_TYPE }));
        },
        async stop(auth, owner, id, { reason }) { return actorRun(await call('actor', `/api/v1/runs/${encodeURIComponent(id)}/stop`, { auth, method: 'POST', body: reason ? { reason } : {}, accept: RUN_TYPE })); },
        async answer(auth, owner, id, approval, answer) { return call('actor', `/api/v1/runs/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approval)}`, { auth, method: 'POST', body: { answer } }); },
    };

    // Products that live beside the Frame (11-17: a group conversation, server/frame/groups.js) join the same list, read
    // and say through the same routes.
    const PRODUCTS = { chat, codes, actor, ...Object.fromEntries(Object.entries(extra || {}).filter(([k, a]) => /^[a-z][a-z0-9-]{0,30}$/.test(k) && a && typeof a.list === 'function')) };
    const productFor = (ref) => {
        const m = REF.exec(String(ref || ''));
        if (!m || !PRODUCTS[m[1]]) throw fail(404, 'runs.not_found', 'No such run');
        return { a: PRODUCTS[m[1]], id: m[2] };
    };
    /** Which product starts a run: its kind, else a target (code), else the person's Actor (it answers, or hands the
     *  work on). Chat's old Vibe character answers only when Actor cannot be reached. */
    const starterFor = (body) => {
        if (body.kind === 'group' && PRODUCTS.group) return PRODUCTS.group;
        if (body.kind === 'code' || body.target) return codes;
        return actor;
    };
    /**
     * Words with no kind (2026-11-13, the owner: "your actor is just your agent … it can orchestrate to openvibe.codes,
     * or timer, task, desktop, browser"): where they go, read from the words. A question, a timer, a reminder or a
     * schedule is Vibe's (it has those tools); "on my computer" or "in my browser" is a machine run on Actor; a change
     * to make in code (a doing word and a thing code is made of) is Codes' make mode, which finds the repository in the
     * words or among the person's own. Anything else, and anything Codes cannot place, is a conversation with the
     * person's Actor (2026-11-15: Actor has the tools; the old Vibe character is gone).
     */
    const ASKS = /^\s*(how|what|why|who|where|when|which|can|could|should|would|is|are|do|does|did|will)\b|\?\s*$/i;
    const VIBE_TOOLS = /\b(remind(er)?s?|timer|alarm|pomodoro|every (day|morning|evening|night|week|hour|\d+\s*(minutes?|hours?|days?))|daily|weekly|tomorrow at)\b/i;
    const MACHINE = /\b(on|in|with|using|from)\s+my\s+(computer|pc|laptop|desktop|mac|browser|machine|screen)\b/i;
    const CODE_DO = /\b(fix|build|make|change|add|update|refactor|implement|rename|remove|edit|create|code|ship|deploy)\b/i;
    const CODE_THING = /\b(repo|repository|github|pull request|pr|bug|login|sign[- ]?in|navbar|page|site|website|web ?app|app|component|function|endpoint|api|css|html|script|tests?|overlay|widget|button|feature|landing|form|bot|extension|plugin|goal bar|layout|header|footer)\b/i;
    function placeFor(body) {
        if (body.kind || body.target) return 'given';
        const t = String(body.text || '');
        if (ASKS.test(t) || VIBE_TOOLS.test(t)) return 'actor';
        if (MACHINE.test(t)) return 'machine';
        if (CODE_DO.test(t) && CODE_THING.test(t)) return 'code';
        return 'actor';
    }
    /** Codes' make mode with the person's words: a run when it starts a task, null when the words are something new.
     *  `how` is the composer's choice for Codes (4.259.0): the harness, the model and the person's computer. */
    async function codesMake(auth, owner, text, idempotencyKey, how = {}) {
        let out;
        try { out = await call('codes', '/api/v1/tasks', { auth, method: 'POST', body: { mode: 'make', text, ...how }, idempotencyKey }); }
        catch (err) { if (err && (err.status === 422 || err.status === 404)) return null; throw err; }
        const id = out && (out.id || (out.task && out.task.id));
        if (!id) return null;   // something new: Vibe talks it through (Codes would hand it to OpenVibe AI's builder)
        return codes.get(auth, owner, id).catch(() => ({ id, ref: `codes:${id}`, kind: 'code', title: clip(text, 200), owner, agent: { id: 'codes', name: 'Codes', product: 'codes', glyph: 'code' }, status: 'planning', created_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() }));
    }

    const router = express.Router();
    const json = express.json({ limit: '64kb' });
    router.use((req, res, next) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID, Idempotency-Key, X-Filename', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Max-Age': '600', 'Cache-Control': 'private, no-store', Vary: 'Authorization' });
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
        // The old system's conversations are archived (11-15): out of the list, never deleted; live work always shows.
        if (since && req.query.archived !== '1') {
            runs = runs.filter((r) => {
                if (r.status === 'running' || r.status === 'planning' || (r.status === 'waiting' && r.waiting && r.waiting.for !== 'message')) return true;
                const t = Date.parse(String(r.updated_at || r.created_at || ''));
                return !Number.isFinite(t) || t >= since;
            });
        }
        // Needs you first, then newest.
        const needs = (r) => (r.status === 'waiting' && r.waiting && r.waiting.for !== 'message' ? 1 : 0);
        runs.sort((x, y) => needs(y) - needs(x) || String(y.updated_at).localeCompare(String(x.updated_at)));
        res.json({ runs: runs.slice(0, limit), next: null, partial });
    }));

    router.post('/', json, handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const text = clip(b.text, 16000);
        if (!text && !aiFiles(b.attachments).length) throw fail(422, 'runs.start_needs_words', 'Say what the run is for ({ text })');
        const key = String(req.get('idempotency-key') || '');
        const idempotencyKey = /^[A-Za-z0-9._~-]{1,200}$/.test(key) ? key : (key ? null : crypto.randomUUID());
        // The composer's choice (openvibe-shared 4.259.0, agents.run-start@1 agent, model, where; the owner, 11-15: "choose
        // your harness … configure your model … choose a node"): who does it decides the product; Auto reads the words.
        const chosen = typeof b.agent === 'string' ? b.agent.trim().slice(0, 160) : '';
        const where = b.where && typeof b.where === 'object' && !Array.isArray(b.where) && ['openvibe', 'machine', 'runner', 'this-computer'].includes(b.where.kind) ? b.where : null;
        const model = b.model && typeof b.model === 'object' && typeof b.model.id === 'string' ? b.model : null;
        const toActor = chosen === 'actor' || /^agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(chosen);
        const toCodes = !toActor && !!chosen && chosen !== 'auto';
        let place = placeFor({ ...b, text });
        if (toActor) place = 'actor';
        else if (toCodes) place = 'code';
        // Code mode with no repository (plan §AD.28 item 3; the owner, 11-18: Codes "should take it"): Codes' make mode,
        // which finds one in the words or makes a new one on OpenVibe Git (scratch).
        const codeMode = !toActor && (b.kind === 'code' || toCodes) && !(b.target && typeof b.target === 'object' && b.target.repo);
        if (codeMode) place = 'code';
        // A way chosen on the session's chip (Actor's engines, 11-16: an agent, one model, the Decisions API, a harness …)
        // is Actor's to run.
        else if (engineOf(b.engine) && engineOf(b.engine) !== 'auto') place = 'actor';
        else if (where && where.kind === 'machine' && place !== 'code') place = 'machine';
        // 2026-11-16 (the owner: "make sure reasoning effort is configurable and … all settings for all harnesses exist"): the
        // session's effort and, for coding, what the agent may do, as Codes' task start reads them.
        const effort = EFFORTS.includes(b.effort) ? b.effort : null;
        const permission = ['read', 'edit', 'full'].includes(b.permission) ? b.permission : null;
        const codesHow = toCodes || place === 'code' ? {
            ...(toCodes && chosen !== 'codes' ? { harness: chosen } : {}),
            ...(model ? { model: model.id } : {}),
            ...(effort ? { effort } : {}),
            ...(permission ? { permission } : {}),
            ...(where && where.kind === 'machine' && where.id ? { machine: String(where.id) } : {}),
        } : {};
        // Actor's own agent ids pass; "actor" is the person's default agent there (no agent named).
        const forActor = { ...b, text, ...(chosen === 'actor' ? { agent: undefined } : {}) };
        let run = null;
        // Actor down or failing on words nobody pointed at it: Chat's Vibe still answers, so nobody is left with nothing.
        // Your Actor picked by name fails honestly instead.
        const viaActor = async (body) => {
            try { return await actor.start(auth, owner, body, { idempotencyKey }); }
            catch (err) {
                if (toActor || (err && Number.isInteger(err.status) && err.status < 500 && err.status !== 404)) throw err;
                if (log.warn) log.warn(`[frame runs] Actor did not start a conversation (${err && (err.status || err.message)}); Chat answers`);
                return chat.start(auth, owner, { ...b, text }, { idempotencyKey });
            }
        };
        if (place === 'actor') run = await viaActor({ ...forActor, kind: b.kind && ['task', 'goal', 'machine'].includes(b.kind) ? b.kind : (where && where.kind === 'machine' ? 'machine' : 'task') });
        if (!run && place === 'code') run = await codesMake(auth, owner, text, idempotencyKey, codeMode ? { ...codesHow, scratch: true } : codesHow);
        // Code mode Codes could not take (no OpenVibe Git, no username for a new repository): the person's Actor answers,
        // never a refusal for a missing repository.
        if (!run && codeMode) run = await viaActor({ ...forActor, kind: 'task' });
        if (!run && place === 'machine') run = await actor.start(auth, owner, { ...forActor, kind: 'machine' }, { idempotencyKey });
        if (!run) run = starterFor(b) === actor ? await viaActor(forActor) : await starterFor(b).start(auth, owner, { ...b, text }, { idempotencyKey });
        res.set('X-OV-Placed', place === 'given' ? 'asked' : run.kind === 'code' ? 'codes' : run.kind === 'machine' ? 'machine' : String(run.ref || '').startsWith('chat:') ? 'vibe' : 'actor');
        res.status(201).json(run);
    }));

    router.post('/files', (req, res, next) => express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1 })(req, res, (err) => {
        if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'A file can be up to 10 MB', code: 'runs.file_too_large' });
        return next(err);
    }), handle(async (req, res) => {
        const { auth } = await who(req);
        if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(422, 'runs.file_empty', 'Choose a file first');
        const type = String(req.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 255) || 'application/octet-stream';
        const name = String(req.get('x-filename') || 'file').slice(0, 600);
        let r;
        try {
            r = await fetchImpl(new URL('/api/chat/vibe/files', base.chat).href, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(60_000),
                headers: { Accept: 'application/json', Authorization: auth, 'Content-Type': type, 'X-Filename': name }, body: req.body });
        } catch { throw fail(502, 'runs.product_unavailable', 'chat did not answer'); }
        const out = await r.json().catch(() => null);
        if (!r.ok || !out || !out.file || !MEDIA_ID.test(String(out.file.id || ''))) throw fail(r.ok ? 502 : r.status, (out && out.code) || 'runs.file_failed', (out && out.error) || 'That file did not upload');
        res.status(201).json({ file: out.file });
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
        // A model the session's chip changed to mid-session (plan §AD.8 step 3): { id, source, name } or an exact id.
        const model = b.model && typeof b.model === 'object' && typeof b.model.id === 'string' ? { id: clip(b.model.id, 256) }
            : typeof b.model === 'string' ? { id: clip(b.model, 256) } : null;
        // The way the conversation is worked, swapped on the chip (Actor's engines, 11-16); Actor checks it.
        const engine = a === actor ? engineOf(b.engine) : null;
        // The effort changed on the chip mid-session (2026-11-16): goes with the words, as the model does.
        const effort = EFFORTS.includes(b.effort) ? b.effort : null;
        res.status(201).json(await a.say(auth, owner, id, { text, attachments, ...(model && model.id ? { model } : {}), ...(engine ? { engine } : {}), ...(effort ? { effort } : {}) }));
    }));

    router.post('/:ref/stop', json, handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const { a, id } = productFor(req.params.ref);
        if (!a.stop) throw fail(409, 'runs.cannot_stop', a.product === 'chat' ? 'A conversation does not stop: it waits for you' : `A ${a.product} run cannot be stopped from here yet`);
        res.json(await a.stop(auth, owner, id, { reason: clip(req.body && req.body.reason, 500) || undefined }));
    }));

    // Rename a run (plan §AD.8, the session's ⋯ menu): { title }, at most 200 characters; empty or null gives it back.
    router.patch('/:ref', json, handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const { a, id } = productFor(req.params.ref);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const hasLevel = Object.prototype.hasOwnProperty.call(b, 'level');
        const hasTitle = Object.prototype.hasOwnProperty.call(b, 'title');
        if (hasLevel) {
            if (!['ask', 'auto-edits', 'approve-for-me', 'full'].includes(b.level)) throw fail(422, 'runs.level', 'level is one of ask, auto-edits, approve-for-me, full');
            if (!a.setLevel) throw fail(409, 'runs.cannot_set_level', `A ${a.product} run has no approval level here yet`);
        }
        if (!hasLevel && !a.rename) throw fail(409, 'runs.cannot_rename', `A ${a.product} run cannot be renamed from here yet`);
        const raw = hasTitle ? b.title : undefined;
        if ((!hasLevel || hasTitle) && raw !== null && typeof raw !== 'string') throw fail(422, 'runs.title_needed', 'Send the new name ({ title })');
        const title = raw == null ? (hasTitle ? null : undefined) : (clip(String(raw).replace(/\s+/g, ' ').trim(), 200) || null);
        if (hasLevel) { res.json(await a.setLevel(auth, owner, id, b.level, title)); return; }
        res.json(await a.rename(auth, owner, id, title));
    }));

    // A run's replay link (plan §AD.8: the session menu's Share): POST makes or reads it, DELETE stops it.
    router.post('/:ref/replay', json, handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const { a, id } = productFor(req.params.ref);
        if (!a.replay) throw fail(409, 'runs.cannot_replay', `A ${a.product} run has no replay link yet`);
        res.set('Cache-Control', 'private, no-store').json(await a.replay(auth, owner, id));
    }));
    router.delete('/:ref/replay', handle(async (req, res) => {
        const { auth, owner } = await who(req);
        const { a, id } = productFor(req.params.ref);
        if (!a.replay) throw fail(409, 'runs.cannot_replay', `A ${a.product} run has no replay link yet`);
        res.json(await a.replay(auth, owner, id, { stop: true }));
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
        // 11-18 (the owner: "stream response"): while an Actor turn runs, its words as the model writes them. Actor's
        // own task stream sends `delta` pieces (?deltas=1, tasks/stream.js); they go on as `delta { live: true, text }`,
        // unstored, until the stored answer comes as a step like any other.
        let follow = null;
        const followDeltas = (run) => {
            if (!run || target.a.product !== 'actor' || !['running', 'planning'].includes(run.status)) return;
            const m = /\/chat\/(tsk_[0-9A-HJKMNP-TV-Z]{26})(?:[/?#]|$)/.exec(String(run.url || ''));
            const turn = m && m[1];
            if (!turn || (follow && follow.turn === turn)) return;
            if (follow) follow.ac.abort();
            const ac = new AbortController();
            follow = { turn, ac };
            (async () => {
                try {
                    const r = await fetchImpl(new URL(`/api/v1/tasks/${encodeURIComponent(turn)}/events?deltas=1&after=9999999`, base.actor).href,
                        { headers: { Accept: 'text/event-stream', Authorization: ctx.auth }, redirect: 'manual', signal: ac.signal });
                    if (!r.ok || !r.body || typeof r.body.getReader !== 'function') return;
                    const reader = r.body.getReader();
                    const dec = new TextDecoder();
                    let buf = '';
                    while (open && !ac.signal.aborted) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buf += dec.decode(value, { stream: true });
                        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
                            const block = buf.slice(0, i); buf = buf.slice(i + 2);
                            const ev = /^event: ?(.+)$/m.exec(block);
                            const data = /^data: ?(.+)$/m.exec(block);
                            if (!ev) continue;
                            if (ev[1].trim() === 'delta' && data) {
                                let d = null; try { d = JSON.parse(data[1]); } catch { d = null; }
                                if (d && typeof d.text === 'string' && d.text) write('delta', null, { live: true, text: d.text.slice(0, 4000), n: Number(d.n) || 0 });
                            } else if (ev[1].trim() === 'end') { ac.abort(); return; }
                        }
                        if (buf.length > 65536) buf = buf.slice(-65536);
                    }
                } catch { /* the polled steps still carry the answer */ }
            })();
        };
        try {
            followDeltas(await target.a.get(ctx.auth, ctx.owner, target.id).catch(() => null));
            while (open && now() < until) {
                const { steps } = await target.a.steps(ctx.auth, ctx.owner, target.id, { after, limit: 100 });
                const fresh = steps.filter((s) => s.seq > after);
                for (const s of fresh) { write('step', s.seq, { step: s }); after = Math.max(after, s.seq); }
                if (fresh.length) {
                    const run = await target.a.get(ctx.auth, ctx.owner, target.id).catch(() => null);
                    if (run) {
                        followDeltas(run);
                        write('run', after, { run });
                        if (['done', 'failed', 'stopped'].includes(run.status)) { write('end', after, { run_id: run.ref || req.params.ref, status: run.status }); break; }
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            }
        } catch (err) {
            write('error', null, { error: err && err.status ? err.message : 'The run could not be read', code: (err && err.code) || 'runs.error' });
        }
        if (follow) follow.ac.abort();
        if (open) res.end();
    });

    return { router, adapters: PRODUCTS };
}

module.exports = { createFrameRuns, REF };
