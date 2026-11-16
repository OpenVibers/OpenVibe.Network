'use strict';
// Frame Runs (agent-engine.md §3): every run on OpenVibe in one shape under /api/frame/runs/<product>:<id>. Stub Chat,
// Codes and Actor servers stand in for the products: the list merges them (needs-you first, then newest) and names a
// product that did not answer in `partial`; a chat is a run waiting for a message, its messages are steps; a coding task
// maps Codes' statuses, targets and pull requests; Actor's runs pass through with a ref; start goes to the product its
// kind or target names; say, stop and approvals reach the right product or say plainly why not; the stream follows a
// product without one by reading its steps, and resumes after Last-Event-ID; the person's bearer is required and goes
// upstream unchanged.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createFrameRuns } = require('../server/frame/runs');

const TOKEN = 'Bearer tok_person_1234567890';
// A Media object id for the file stub (built from parts: secret scanners read a literal next to `key` as a key).
const MED = ['med', '01ARZ3NDEKTSV4RRFFQ69G5FAV'].join('_');
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b ? JSON.parse(b) : null)); });
const sendJson = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };

(async () => {
    const seen = [];
    const messages = [
        { id: 101, from: 'you', text: 'Find me a mechanical keyboard', at: '2026-11-12 10:00:00' },
        { id: 102, from: 'vibe', text: 'Three picks under $90.', at: '2026-11-12 10:00:20', results: [{ kind: 'timer', label: '10 min' }] },
    ];
    let actorDown = false;
    const uploaded = [], asked = [];
    const chat = await listen(async (req, res) => {
        seen.push({ svc: 'chat', method: req.method, url: req.url, auth: req.headers.authorization });
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/vibe/conversations') return sendJson(res, 200, { conversations: [{ slug: 'c_keys', name: 'My keyboard hunt', last_line: 'Three picks under $90.', last_message_at: '2026-11-12 10:00:20', site: 'https://openvibe.deals', persona: { name: 'Keyboard Scout', glyph: 'search', hue: 212 } }], count: 1 });
        if (u.pathname === '/api/vibe/chat') {
            if (u.searchParams.get('slug') !== 'c_keys') return sendJson(res, 200, { chat: null, messages: [] });
            const after = Number(u.searchParams.get('after')) || 0;
            return sendJson(res, 200, { chat: { slug: 'c_keys', name: 'Keyboard Scout', url: 'https://openvibe.chat/vibe/c_keys' }, messages: messages.filter((m) => m.id > after) });
        }
        if (u.pathname === '/api/chat/vibe/files' && req.method === 'POST') {
            const chunks = []; for await (const c of req) chunks.push(c);
            uploaded.push({ bytes: Buffer.concat(chunks).length, type: req.headers['content-type'], name: req.headers['x-filename'] });
            return sendJson(res, 201, { file: { id: MED, name: decodeURIComponent(req.headers['x-filename'] || 'file'), media_type: req.headers['content-type'], size: 4, storage: { provider: 'media', key: MED }, read: { method: 'not_readable' }, role: 'input' } });
        }
        if (u.pathname === '/api/vibe/ask' && req.method === 'POST') {
            const b = await readBody(req);
            asked.push(b);
            const m = { id: 103 + (b.fresh ? 100 : 0), from: 'you', text: b.message, at: '2026-11-12 10:01:00' };
            if (!b.fresh) messages.push(m);
            return sendJson(res, 200, { chat: { slug: b.fresh ? 'c_new' : b.slug, name: 'Vibe', url: `https://openvibe.chat/vibe/${b.fresh ? 'c_new' : b.slug}` }, message: m });
        }
        return sendJson(res, 404, { error: 'not found' });
    });
    const codes = await listen(async (req, res) => {
        seen.push({ svc: 'codes', method: req.method, url: req.url, auth: req.headers.authorization, idem: req.headers['idempotency-key'] });
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/me/tasks') return sendJson(res, 200, { tasks: [
            { id: 'tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH', title: 'A goal bar for my sub goal', status: 'needs-you', mode: 'openvibe', repo: 'OpenVibers/OpenVibe.Live', started_at: '2026-11-12T09:00:00Z', updated_at: '2026-11-12T09:30:00Z', steps: 4, url: 'https://openvibe.codes/tasks/tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH', preview_url: null, pr_url: 'https://git.openvibe.codes/OpenVibers/OpenVibe.Live/pulls/871' },
            { id: 'tsk_01K9R2V6M8Q4T0B7C3D5E9F2GJ', title: 'Old task', status: 'done', mode: 'repo', repo: 'me/site', started_at: '2026-11-01T09:00:00Z', updated_at: '2026-11-01T09:30:00Z', steps: 1, url: 'https://openvibe.codes/tasks/tsk_01K9R2V6M8Q4T0B7C3D5E9F2GJ', preview_url: 'https://preview.openvibe.codes/x', pr_url: null },
        ] });
        if (u.pathname === '/api/v1/runs/tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH') return sendJson(res, 200, { id: 'tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH', product: 'codes', title: 'A goal bar for my sub goal', status: 'needs_you', plan: [], steps: [{ title: 'Read the overlay code', kind: 'tool', status: 'done' }, { title: 'Write the bar', status: 'running' }], sources: [], result: null, started_at: '2026-11-12T09:00:00Z', ended_at: null, cost_usd: 0.42 });
        if (u.pathname === '/api/v1/tasks' && req.method === 'POST') {
            const b = await readBody(req); seen.at(-1).body = b;
            // Codes' make mode: one of the person's repositories named in the words starts a task; anything else is new.
            if (b && b.mode === 'make') return /my-site/.test(String(b.text)) ? sendJson(res, 201, { id: 'tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH', url: 'https://openvibe.codes/tasks/x' }) : sendJson(res, 200, { id: null, url: 'https://openvibe.space/build' });
            return sendJson(res, 201, { id: 'tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH' });
        }
        if (/\/api\/v1\/tasks\/tsk_[0-9A-Z]+\/stop$/.test(u.pathname)) return sendJson(res, 200, { ok: true });
        if (/^\/api\/v1\/tasks\/tsk_[0-9A-Z]+$/.test(u.pathname) && req.method === 'PATCH') { const b = await readBody(req); seen.at(-1).body = b; return sendJson(res, 200, { task: { id: 'x' } }); }
        if (/\/api\/v1\/tasks\/tsk_[0-9A-Z]+\/replay$/.test(u.pathname)) return req.method === 'DELETE' ? sendJson(res, 200, { stopped: true }) : sendJson(res, 201, { url: 'https://openvibe.codes/r/AbCdEfGhIjKlMnOpQrStUvWxYz012345', created_at: '2026-11-15T17:00:00Z', created: true });
        if (/\/api\/v1\/tasks\/tsk_[0-9A-Z]+\/(message|continue)$/.test(u.pathname) && req.method === 'POST') { const b = await readBody(req); seen.at(-1).body = b; return sendJson(res, /message$/.test(u.pathname) ? 202 : 200, { queued: true }); }
        return sendJson(res, 404, { error: 'not found' });
    });
    const actor = await listen(async (req, res) => {
        seen.push({ svc: 'actor', method: req.method, url: req.url, auth: req.headers.authorization, accept: req.headers.accept });
        if (actorDown) return sendJson(res, 503, { error: 'down' });
        const u = new URL(req.url, 'http://x');
        const run = { id: 'tsk_ACTOR1', owner: { type: 'user', id: 'usr_1' }, agent: { id: 'agt_1', name: 'Juniper', product: 'actor' }, status: 'running', created_at: '2026-11-12T08:00:00Z', updated_at: '2026-11-12T10:05:00Z' };
        if (u.pathname === '/api/v1/runs' && req.method === 'GET') return sendJson(res, 200, { runs: [run], next: null });
        if (u.pathname === '/api/v1/runs/tsk_ACTOR1' && req.method === 'PATCH') { const b = await readBody(req); seen.at(-1).body = b; return sendJson(res, 200, { ...run, title: b.title || 'Plan my week' }); }
        if (u.pathname === '/api/v1/runs/tsk_ACTOR1') return sendJson(res, 200, run);
        if (u.pathname === '/api/v1/runs' && req.method === 'POST') { const b = await readBody(req); seen.at(-1).body = b; return sendJson(res, 201, { ...run, id: 'tsk_MACHINE1', kind: b.kind || 'task', status: 'planning' }); }
        if (u.pathname === '/api/v1/runs/tsk_ACTOR1/messages' && req.method === 'POST') { const b = await readBody(req); seen.at(-1).body = b; return sendJson(res, 202, { ok: true, run: { ...run, turns: 2 } }); }
        if (u.pathname === '/api/v1/runs/tsk_ACTOR1/approvals/apr_1') { const b = await readBody(req); return sendJson(res, 200, { run_id: 'tsk_ACTOR1', step_seq: 3, what: 'post', options: [{ id: 'approve', label: 'Approve' }], answer: b.answer }); }
        return sendJson(res, 404, { error: 'not found' });
    });

    const at = (s) => `http://127.0.0.1:${s.address().port}`;
    const urls = { chat: at(chat), codes: at(codes), actor: at(actor) };
    // These runs are from before the new agent system, so this router lists everything (since: 0); the archive is
    // checked on its own below.
    const runs = createFrameRuns({ svcUrl: (name, fallback) => urls[name] || fallback, personOf: async () => ({ subject_id: 'usr_01K9R2V6M8Q4T0B7C3D5E9F2GH' }), log: { warn() {} }, since: 0 });
    const app = express();
    app.use('/api/frame/runs', runs.router);
    // 11-15 (the owner: "clear out old conversations, since now the system works way differently"): from a cutover on,
    // older runs are archived: left out of the list, listed with ?archived=1; live work always shows.
    const cut = createFrameRuns({ svcUrl: (name, fallback) => urls[name] || fallback, personOf: async () => ({ subject_id: 'usr_01K9R2V6M8Q4T0B7C3D5E9F2GH' }), log: { warn() {} }, since: Date.parse('2026-11-12T09:30:00Z') });
    app.use('/api/frame/cut/runs', cut.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame/runs`;
    const go = async (path, { method = 'GET', body, headers = {} } = {}) => {
        const r = await fetch(`${base}${path}`, { method, headers: { Authorization: TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        let d = null; try { d = JSON.parse(text); } catch { d = text; }
        return { r, d };
    };

    try {
        // Signed out: no runs.
        let res = await fetch(base);
        assert.strictEqual(res.status, 401, 'a bearer is required');

        // The list: every product, needs-you first, then newest; the bearer goes upstream unchanged.
        let { r, d } = await go('/?limit=10');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(d.partial, []);
        assert.deepStrictEqual(d.runs.map((x) => x.ref), ['codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH', 'actor:tsk_ACTOR1', 'chat:c_keys', 'codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GJ'], 'needs you first, then newest');
        assert.ok(seen.every((x) => x.auth === TOKEN), 'the person\'s own bearer reaches every product');
        const vibeRun = d.runs.find((x) => x.ref === 'chat:c_keys');
        assert.strictEqual(vibeRun.kind, 'chat');
        assert.strictEqual(vibeRun.status, 'waiting');
        assert.deepStrictEqual(vibeRun.waiting, { for: 'message' }, 'a conversation is a run waiting for a message');
        assert.deepStrictEqual(vibeRun.agent, { id: 'vibe', name: 'Keyboard Scout', product: 'chat', harness: 'openvibe', glyph: 'search', hue: 212 }, 'the persona is the agent\'s face');
        assert.strictEqual(vibeRun.title, 'My keyboard hunt', 'the chat\'s own name is its title (a person\'s rename stays theirs); the persona names the agent');
        assert.strictEqual(vibeRun.updated_at, '2026-11-12T10:00:20.000Z', 'a time without a zone is UTC');
        assert.deepStrictEqual(vibeRun.context, { site: 'openvibe.deals' });
        assert.deepStrictEqual(vibeRun.owner, { type: 'user', id: 'usr_01K9R2V6M8Q4T0B7C3D5E9F2GH' });
        const codeRun = d.runs[0];
        assert.strictEqual(codeRun.status, 'waiting');
        assert.strictEqual(codeRun.waiting.for, 'approval');
        assert.strictEqual(codeRun.target, 'openvibe');
        assert.deepStrictEqual(codeRun.outputs, [{ kind: 'pr', title: 'Pull request', url: 'https://git.openvibe.codes/OpenVibers/OpenVibe.Live/pulls/871' }]);
        assert.deepStrictEqual(d.runs[3].target, { repo: 'me/site' });
        assert.strictEqual(d.runs[3].ended_at, '2026-11-01T09:30:00.000Z');
        assert.match(seen.find((x) => x.svc === 'actor').accept, /agents\.run\+json/, 'Actor is asked for agents.run@1');

        // Filters and a product that does not answer.
        ({ d } = await go('/?kind=chat'));
        assert.deepStrictEqual(d.runs.map((x) => x.ref), ['chat:c_keys'], 'kind=chat asks Chat only');
        ({ d } = await go('/?q=goal+bar'));
        assert.deepStrictEqual(d.runs.map((x) => x.ref), ['codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH']);
        actorDown = true;
        ({ d } = await go('/'));
        assert.deepStrictEqual(d.partial, ['actor'], 'a product that does not answer is named, not fatal');
        assert.strictEqual(d.runs.length, 3);
        actorDown = false;

        // One run and its thread.
        ({ r, d } = await go('/chat:c_keys'));
        assert.strictEqual(d.ref, 'chat:c_keys');
        assert.strictEqual(d.preview.text, 'Three picks under $90.');
        ({ d } = await go('/chat:c_keys/steps'));
        assert.deepStrictEqual(d.steps.map((x) => [x.seq, x.from, x.kind]), [[101, 'person', 'message'], [102, 'agent', 'message']]);
        assert.deepStrictEqual(d.steps[1].ui, { type: 'results', data: { results: [{ kind: 'timer', label: '10 min' }] } }, 'what Vibe did is a card');
        ({ d } = await go('/chat:c_keys/steps?after=101'));
        assert.deepStrictEqual(d.steps.map((x) => x.seq), [102], 'after= reads only what came later');
        ({ r } = await go('/chat:c_missing'));
        assert.strictEqual(r.status, 404);
        ({ r } = await go('/nothing'));
        assert.strictEqual(r.status, 404, 'an address that is not a ref is not a run');
        ({ d } = await go('/codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH'));
        assert.strictEqual(d.status, 'waiting'); assert.deepStrictEqual(d.cost, { usd: 0.42 });
        ({ d } = await go('/codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/steps'));
        assert.deepStrictEqual(d.steps.map((x) => [x.seq, x.kind, x.title, x.status]), [[1, 'tool', 'Read the overlay code', 'done'], [2, 'think', 'Write the bar', 'running']]);
        ({ d } = await go('/actor:tsk_ACTOR1'));
        assert.strictEqual(d.ref, 'actor:tsk_ACTOR1'); assert.strictEqual(d.kind, 'task');

        // Start: by kind or target; words are required.
        ({ r, d } = await go('/', { method: 'POST', body: { kind: 'chat' } }));
        assert.strictEqual(r.status, 422);
        // Words with no kind are a conversation with the person's Actor (11-15: the old Vibe character is gone).
        ({ r, d } = await go('/', { method: 'POST', body: { text: 'What happened in tech news today?' } }));
        assert.strictEqual(r.status, 201); assert.strictEqual(d.ref, 'actor:tsk_MACHINE1'); assert.strictEqual(r.headers.get('x-ov-placed'), 'actor');
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body, { text: 'What happened in tech news today?', kind: 'task' }, 'Actor gets the words');
        // Actor down: Chat's Vibe still answers, so nobody is left with nothing.
        actorDown = true;
        ({ r, d } = await go('/', { method: 'POST', body: { text: 'What happened in tech news today?' } }));
        actorDown = false;
        assert.strictEqual(r.status, 201); assert.strictEqual(d.ref, 'chat:c_new'); assert.strictEqual(r.headers.get('x-ov-placed'), 'vibe');
        ({ r, d } = await go('/', { method: 'POST', body: { text: 'Add a goal bar', kind: 'code', target: 'openvibe' } }));
        assert.strictEqual(r.status, 422, 'Codes needs a repository until Create and OpenVibe ship');
        assert.match(d.error, /repository/);
        ({ r, d } = await go('/', { method: 'POST', body: { text: 'Fix the login redirect', target: { repo: 'me/site' } }, headers: { 'Idempotency-Key': 'k-123' } }));
        assert.strictEqual(r.status, 201); assert.strictEqual(d.kind, 'code');
        const started = seen.filter((x) => x.svc === 'codes' && x.method === 'POST' && x.url === '/api/v1/tasks').at(-1);
        assert.deepStrictEqual(started.body, { repo: 'me/site', ref: null, prompt: 'Fix the login redirect' });
        assert.strictEqual(started.idem, 'k-123', 'the idempotency key goes to the product');

        // One agent (11-13): words with no kind are placed by what they ask for.
        const place = async (text) => { const x = await go('/', { method: 'POST', body: { text } }); return [x.r.status, x.r.headers.get('x-ov-placed'), x.d.kind || 'chat', x.d.ref]; };
        let p = await place('Fix the login on my-site');
        assert.deepStrictEqual(p.slice(0, 3), [201, 'codes', 'code'], 'a change to a repository of yours goes to Codes');
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'codes' && x.method === 'POST').at(-1).body, { mode: 'make', text: 'Fix the login on my-site' }, 'in its make mode, with the words');
        p = await place('Build a landing page for my bakery');
        assert.deepStrictEqual(p.slice(0, 2), [201, 'actor'], 'something new Codes has no repository for is a conversation with your Actor');
        p = await place('Open my email on my computer and file the receipts');
        assert.deepStrictEqual(p.slice(0, 3), [201, 'machine', 'machine'], 'work on your own computer is a machine run');
        assert.strictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body.kind, 'machine');
        p = await place('Remind me to fix the login tomorrow at 9');
        assert.deepStrictEqual(p.slice(0, 2), [201, 'actor'], 'a reminder is your Actor\'s, whatever it is about');
        p = await place('How do I fix my login page?');
        assert.deepStrictEqual(p.slice(0, 2), [201, 'actor'], 'a question is your Actor\'s');
        p = await place('test');
        assert.deepStrictEqual(p.slice(0, 2), [201, 'actor'], 'a word on its own starts a conversation');

        // The composer's choice (Shared 4.259.0; the owner, 11-15: "choose your harness … configure your model … choose a
        // node"): a harness goes to Codes with it, the model and the computer; your Actor goes to Actor whatever the words.
        const pick = async (body) => { const x = await go('/', { method: 'POST', body }); return [x.r.status, x.r.headers.get('x-ov-placed')]; };
        let q = await pick({ text: 'Fix the login on my-site', agent: 'claude-code', model: { id: 'anthropic/claude-sonnet', source: 'keys' }, where: { kind: 'machine', id: 'dev_01K9R2V6M8Q4T0B7C3D5E9F2GH', name: 'Studio PC' } });
        assert.deepStrictEqual(q, [201, 'codes']);
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'codes' && x.method === 'POST').at(-1).body,
            { mode: 'make', text: 'Fix the login on my-site', harness: 'claude-code', model: 'anthropic/claude-sonnet', machine: 'dev_01K9R2V6M8Q4T0B7C3D5E9F2GH' }, 'Codes gets the harness, the model and the computer');
        // 2026-11-16 ("make sure reasoning effort is configurable and … all settings for all harnesses exist"): the effort and
        // what the agent may do go to Codes too; anything else is dropped, never passed on.
        q = await pick({ text: 'Fix the login on my-site', agent: 'claude-code', effort: 'high', permission: 'read' });
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'codes' && x.method === 'POST').at(-1).body,
            { mode: 'make', text: 'Fix the login on my-site', harness: 'claude-code', effort: 'high', permission: 'read' });
        q = await pick({ text: 'Fix the login on my-site', agent: 'claude-code', effort: 'turbo', permission: 'root' });
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'codes' && x.method === 'POST').at(-1).body,
            { mode: 'make', text: 'Fix the login on my-site', harness: 'claude-code' }, 'an effort or a permission that is not one of the ladder is dropped');
        q = await pick({ text: 'Fix the login on my-site', agent: 'codes' });
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'codes' && x.method === 'POST').at(-1).body, { mode: 'make', text: 'Fix the login on my-site' }, 'Codes itself: its own pick of harness');
        q = await pick({ text: 'How do I fix my login page?', agent: 'actor', model: { id: 'deepseek/deepseek-chat', source: 'openvibe' } });
        assert.deepStrictEqual(q, [201, 'actor'], 'your Actor, even for a question');
        const toActor = seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body;
        assert.deepStrictEqual([toActor.kind, toActor.agent, toActor.model], ['task', undefined, { id: 'deepseek/deepseek-chat', source: 'openvibe' }], 'a task for your default agent, on the model you picked');
        q = await pick({ text: 'Tidy my downloads folder', agent: 'auto', where: { kind: 'machine', id: 'dev_01K9R2V6M8Q4T0B7C3D5E9F2GH' } });
        assert.deepStrictEqual(q, [201, 'machine'], 'Auto on your computer is a machine run');
        // A way chosen on the chip (Actor's engines, 11-16) starts on Actor, whatever the words say, and goes with it.
        q = await pick({ text: 'Fix the login on my-site', engine: { kind: 'model', model: 'openai/gpt-5.2' } });
        assert.deepStrictEqual(q, [201, 'actor'], 'an engine is Actor\'s to run');
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body.engine, { kind: 'model', model: 'openai/gpt-5.2' });

        // Your Actor's conversation (Actor#517): read whole, and the next words come back as the step the thread reads.
        assert.ok(seen.some((x) => x.svc === 'actor' && x.method === 'GET' && /^\/api\/v1\/runs\?limit=\d+&conversations=1/.test(x.url)), 'the list asks Actor for conversations');
        ({ r, d } = await go('/actor:tsk_ACTOR1/messages', { method: 'POST', body: { text: 'And the second one?', attachments: [{ id: 'med_01K9R2V6M8Q4T0B7C3D5E9F2GH', name: 'shot.png', url: 'https://cdn.openvibe.media/f/shot.png' }] } }));
        assert.strictEqual(r.status, 201, JSON.stringify(d));
        assert.deepStrictEqual([d.from, d.seq, d.kind], ['person', 1000001, 'message'], 'the second turn\'s words, numbered as Actor numbers them');
        assert.strictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body.text, 'And the second one?\n\nAttached:\n- shot.png: https://cdn.openvibe.media/f/shot.png', 'a file rides as its link');
        assert.strictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body.model, undefined, 'no model named: Actor keeps the conversation\'s');
        // A model the session's chip changed to mid-session goes with the words (plan §AD.8 step 3).
        ({ r, d } = await go('/actor:tsk_ACTOR1/messages', { method: 'POST', body: { text: 'Shorter', model: { id: 'deepseek/deepseek-v4-flash', source: 'openvibe', name: 'DeepSeek V4 Flash' } } }));
        assert.strictEqual(r.status, 201, JSON.stringify(d));
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body.model, { id: 'deepseek/deepseek-v4-flash' }, 'the model goes to Actor with the words');
        // The way the conversation is worked, swapped on the chip (Actor's engines, 11-16): to Actor with the words, its
        // shape only (Actor checks the rest); a bad shape is dropped, never forwarded.
        ({ r, d } = await go('/actor:tsk_ACTOR1/messages', { method: 'POST', body: { text: 'Pick one', engine: { kind: 'decisions', model: 'gemini/gemini-decision-1', extra: 'x' } } }));
        assert.strictEqual(r.status, 201, JSON.stringify(d));
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body.engine, { kind: 'decisions', model: 'gemini/gemini-decision-1' }, 'the engine goes to Actor with the words');
        ({ r, d } = await go('/actor:tsk_ACTOR1/messages', { method: 'POST', body: { text: 'Again', engine: { kind: 'Bad Kind!' } } }));
        assert.strictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body.engine, undefined, 'a bad shape is dropped');
        ({ r, d } = await go('/actor:tsk_ACTOR1/messages', { method: 'POST', body: { text: 'Back to normal', engine: 'auto' } }));
        assert.strictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'POST').at(-1).body.engine, 'auto', 'auto gives it back');

        // Say, stop, approvals.
        ({ r, d } = await go('/chat:c_keys/messages', { method: 'POST', body: { text: 'Under $70?' } }));
        assert.strictEqual(r.status, 201); assert.strictEqual(d.from, 'person'); assert.strictEqual(d.text, 'Under $70?');
        ({ r } = await go('/chat:c_keys/messages', { method: 'POST', body: {} }));
        assert.strictEqual(r.status, 422);
        ({ r, d } = await go('/chat:c_keys/stop', { method: 'POST', body: {} }));
        assert.strictEqual(r.status, 409); assert.match(d.error, /waits for you/);
        ({ r, d } = await go('/codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/stop', { method: 'POST', body: { reason: 'not now' } }));
        assert.strictEqual(r.status, 200);
        // A coding run's replay link (plan §AD.8, the session menu's Share): made by the person, or stopped.
        ({ r, d } = await go('/codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/replay', { method: 'POST', body: {} }));
        assert.strictEqual(r.status, 200, JSON.stringify(d));
        assert.deepStrictEqual(d, { url: 'https://openvibe.codes/r/AbCdEfGhIjKlMnOpQrStUvWxYz012345', created_at: '2026-11-15T17:00:00.000Z' });
        assert.strictEqual(seen.filter((x) => x.svc === 'codes').at(-1).url, '/api/v1/tasks/tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/replay');
        ({ r, d } = await go('/codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/replay', { method: 'DELETE' }));
        assert.deepStrictEqual([r.status, d], [200, { stopped: true }]);
        ({ r, d } = await go('/actor:tsk_ACTOR1/replay', { method: 'POST', body: {} }));
        assert.strictEqual(r.status, 409, 'an Actor conversation has no replay link yet');
        // Rename (plan §AD.8, the session's ⋯ menu): Actor's conversation and Codes' task, as the person.
        ({ r, d } = await go('/actor:tsk_ACTOR1', { method: 'PATCH', body: { title: '  My   week ' } }));
        assert.deepStrictEqual([r.status, d.title], [200, 'My week']);
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'actor' && x.method === 'PATCH').at(-1).body, { title: 'My week' });
        ({ r, d } = await go('/codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH', { method: 'PATCH', body: { title: '' } }));
        assert.strictEqual(r.status, 200, JSON.stringify(d));
        assert.deepStrictEqual(seen.filter((x) => x.svc === 'codes' && x.method === 'PATCH').at(-1).body, { title: null }, 'empty gives it back its first line');
        ({ r } = await go('/actor:tsk_ACTOR1', { method: 'PATCH', body: { title: 7 } }));
        assert.strictEqual(r.status, 422);
        ({ r } = await go('/chat:c_keys', { method: 'PATCH', body: { title: 'Keys' } }));
        assert.strictEqual(r.status, 409, 'a Chat conversation is not renamed from here yet');
        // A coding task takes the next words too (plan §AD.8): Codes queues them on the task; a model the chip changed to
        // carries the task on with that model.
        ({ r, d } = await go('/codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/messages', { method: 'POST', body: { text: 'Make the bar thinner' } }));
        assert.strictEqual(r.status, 201, JSON.stringify(d));
        assert.deepStrictEqual([d.from, d.kind, d.text], ['person', 'message', 'Make the bar thinner']);
        let toCodes = seen.filter((x) => x.svc === 'codes' && x.method === 'POST').at(-1);
        assert.deepStrictEqual([toCodes.url, toCodes.body], ['/api/v1/tasks/tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/message', { text: 'Make the bar thinner' }], 'the words queue on the task');
        ({ r, d } = await go('/codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/messages', { method: 'POST', body: { text: 'Try it on Sonnet', model: { id: 'anthropic/claude-sonnet-5-5', source: 'openvibe', name: 'Sonnet 5.5' } } }));
        assert.strictEqual(r.status, 201, JSON.stringify(d));
        toCodes = seen.filter((x) => x.svc === 'codes' && x.method === 'POST').at(-1);
        assert.deepStrictEqual([toCodes.url, toCodes.body], ['/api/v1/tasks/tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/continue', { text: 'Try it on Sonnet', model: 'anthropic/claude-sonnet-5-5' }], 'a new model carries the task on with it');
        ({ r, d } = await go('/actor:tsk_ACTOR1/approvals/apr_1', { method: 'POST', body: { answer: 'approve' } }));
        assert.strictEqual(r.status, 200); assert.strictEqual(d.answer, 'approve');
        ({ r } = await go('/actor:tsk_ACTOR1/approvals/apr_1', { method: 'POST', body: {} }));
        assert.strictEqual(r.status, 422);

        // The stream: Chat has none, so the Frame reads its steps; Last-Event-ID resumes after a seq.
        const ctl = new AbortController();
        const sr = await fetch(`${base}/chat:c_keys/events`, { headers: { Authorization: TOKEN, 'Last-Event-ID': '102' }, signal: ctl.signal });
        assert.strictEqual(sr.status, 200);
        assert.match(sr.headers.get('content-type'), /text\/event-stream/);
        const reader = sr.body.getReader();
        let text = '';
        const deadline = Date.now() + 5000;
        while (!/event: run/.test(text) && Date.now() < deadline) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); }
        ctl.abort();
        assert.match(text, /id: 103\nevent: step\n/, 'the message said above arrives as a step');
        assert.ok(!/id: 10[12]\n/.test(text), 'nothing at or before Last-Event-ID is sent again');
        assert.match(text, /event: run\n/, 'and the run\'s new snapshot follows');

        // Files (4.250.0, the messenger): an upload goes to Chat as the person and comes back an ai.file@1 reference;
        // a message and a new conversation carry it on; anything that is not a Media object is left out.
        let fr = await fetch(`${base}/files`, { method: 'POST', headers: { Authorization: TOKEN, 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('cat.png') }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
        assert.strictEqual(fr.status, 201);
        const file = (await fr.json()).file;
        assert.strictEqual(file.id, MED);
        assert.deepStrictEqual([uploaded[0].type, uploaded[0].name, uploaded[0].bytes], ['image/png', 'cat.png', 4], 'the bytes, type and name reach Chat');
        fr = await fetch(`${base}/files`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('x') });
        assert.strictEqual(fr.status, 401, 'an upload needs the person');
        assert.match((await fetch(`${base}/files`, { method: 'OPTIONS' })).headers.get('access-control-allow-headers'), /X-Filename/, 'a browser may name the file');
        ({ r } = await go('/chat:c_keys/messages', { method: 'POST', body: { text: 'What is this?', attachments: [file, { id: 'nope' }] } }));
        assert.strictEqual(r.status, 201);
        assert.deepStrictEqual(asked.at(-1).files.map((f) => f.id), [file.id], 'a message carries its Media files, nothing else');
        ({ r } = await go('/', { method: 'POST', body: { text: '', attachments: [file], kind: 'chat' } }));
        assert.strictEqual(r.status, 201, 'a file alone starts a conversation');
        assert.strictEqual(asked.at(-1).files[0].id, file.id);

        // The archive: what was last touched before the cutover is out, unless it is running or waits on the person.
        const all = (await go('/')).d.runs;
        const listed = async (q) => { const r = await fetch(`${base.replace('/api/frame/runs', '/api/frame/cut/runs')}${q}`, { headers: { Authorization: TOKEN } }); return (await r.json()).runs; };
        const kept = await listed('/');
        const live = (x) => x.status === 'running' || x.status === 'planning' || (x.status === 'waiting' && x.waiting && x.waiting.for !== 'message');
        const expect = all.filter((x) => live(x) || Date.parse(x.updated_at || x.created_at) >= Date.parse('2026-11-12T09:30:00Z')).map((x) => x.ref);
        assert.ok(expect.length < all.length, `the cutover leaves something out (${all.length} → ${expect.length})`);
        assert.deepStrictEqual(kept.map((x) => x.ref), expect, 'older runs are archived; live ones always show');
        assert.ok(!kept.some((x) => x.ref === 'codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GJ'), 'the old done task is gone from the list');
        assert.deepStrictEqual((await listed('/?archived=1')).map((x) => x.ref), all.map((x) => x.ref), '?archived=1 lists everything: archived, never deleted');

        console.log('frame-runs: one list across Chat, Codes and Actor (needs you first, partial named), a chat as a run waiting for a message, start by kind or target, say, stop, approvals, and a stream for a product without one');
    } finally {
        server.close(); chat.close(); codes.close(); actor.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
