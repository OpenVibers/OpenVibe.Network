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
    const chat = await listen(async (req, res) => {
        seen.push({ svc: 'chat', method: req.method, url: req.url, auth: req.headers.authorization });
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/vibe/conversations') return sendJson(res, 200, { conversations: [{ slug: 'c_keys', name: 'My keyboard hunt', last_line: 'Three picks under $90.', last_message_at: '2026-11-12 10:00:20', site: 'https://openvibe.deals', persona: { name: 'Keyboard Scout', glyph: 'search', hue: 212 } }], count: 1 });
        if (u.pathname === '/api/vibe/chat') {
            if (u.searchParams.get('slug') !== 'c_keys') return sendJson(res, 200, { chat: null, messages: [] });
            const after = Number(u.searchParams.get('after')) || 0;
            return sendJson(res, 200, { chat: { slug: 'c_keys', name: 'Keyboard Scout', url: 'https://openvibe.chat/vibe/c_keys' }, messages: messages.filter((m) => m.id > after) });
        }
        if (u.pathname === '/api/vibe/ask' && req.method === 'POST') {
            const b = await readBody(req);
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
        if (u.pathname === '/api/v1/tasks' && req.method === 'POST') { const b = await readBody(req); seen.at(-1).body = b; return sendJson(res, 201, { id: 'tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH' }); }
        if (/\/api\/v1\/tasks\/tsk_[0-9A-Z]+\/stop$/.test(u.pathname)) return sendJson(res, 200, { ok: true });
        return sendJson(res, 404, { error: 'not found' });
    });
    const actor = await listen(async (req, res) => {
        seen.push({ svc: 'actor', method: req.method, url: req.url, auth: req.headers.authorization, accept: req.headers.accept });
        if (actorDown) return sendJson(res, 503, { error: 'down' });
        const u = new URL(req.url, 'http://x');
        const run = { id: 'tsk_ACTOR1', owner: { type: 'user', id: 'usr_1' }, agent: { id: 'agt_1', name: 'Juniper', product: 'actor' }, status: 'running', created_at: '2026-11-12T08:00:00Z', updated_at: '2026-11-12T10:05:00Z' };
        if (u.pathname === '/api/v1/runs' && req.method === 'GET') return sendJson(res, 200, { runs: [run], next: null });
        if (u.pathname === '/api/v1/runs/tsk_ACTOR1') return sendJson(res, 200, run);
        if (u.pathname === '/api/v1/runs/tsk_ACTOR1/approvals/apr_1') { const b = await readBody(req); return sendJson(res, 200, { run_id: 'tsk_ACTOR1', step_seq: 3, what: 'post', options: [{ id: 'approve', label: 'Approve' }], answer: b.answer }); }
        return sendJson(res, 404, { error: 'not found' });
    });

    const at = (s) => `http://127.0.0.1:${s.address().port}`;
    const urls = { chat: at(chat), codes: at(codes), actor: at(actor) };
    const runs = createFrameRuns({ svcUrl: (name, fallback) => urls[name] || fallback, personOf: async () => ({ subject_id: 'usr_01K9R2V6M8Q4T0B7C3D5E9F2GH' }), log: { warn() {} } });
    const app = express();
    app.use('/api/frame/runs', runs.router);
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
        ({ r, d } = await go('/', { method: 'POST', body: { text: 'What happened in tech news today?' } }));
        assert.strictEqual(r.status, 201); assert.strictEqual(d.ref, 'chat:c_new'); assert.strictEqual(d.status, 'running', 'Vibe is writing its answer');
        ({ r, d } = await go('/', { method: 'POST', body: { text: 'Add a goal bar', kind: 'code', target: 'openvibe' } }));
        assert.strictEqual(r.status, 422, 'Codes needs a repository until Create and OpenVibe ship');
        assert.match(d.error, /repository/);
        ({ r, d } = await go('/', { method: 'POST', body: { text: 'Fix the login redirect', target: { repo: 'me/site' } }, headers: { 'Idempotency-Key': 'k-123' } }));
        assert.strictEqual(r.status, 201); assert.strictEqual(d.kind, 'code');
        const started = seen.filter((x) => x.svc === 'codes' && x.method === 'POST' && x.url === '/api/v1/tasks').at(-1);
        assert.deepStrictEqual(started.body, { repo: 'me/site', ref: null, prompt: 'Fix the login redirect' });
        assert.strictEqual(started.idem, 'k-123', 'the idempotency key goes to the product');

        // Say, stop, approvals.
        ({ r, d } = await go('/chat:c_keys/messages', { method: 'POST', body: { text: 'Under $70?' } }));
        assert.strictEqual(r.status, 201); assert.strictEqual(d.from, 'person'); assert.strictEqual(d.text, 'Under $70?');
        ({ r } = await go('/chat:c_keys/messages', { method: 'POST', body: {} }));
        assert.strictEqual(r.status, 422);
        ({ r, d } = await go('/chat:c_keys/stop', { method: 'POST', body: {} }));
        assert.strictEqual(r.status, 409); assert.match(d.error, /waits for you/);
        ({ r, d } = await go('/codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH/stop', { method: 'POST', body: { reason: 'not now' } }));
        assert.strictEqual(r.status, 200);
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

        console.log('frame-runs: one list across Chat, Codes and Actor (needs you first, partial named), a chat as a run waiting for a message, start by kind or target, say, stop, approvals, and a stream for a product without one');
    } finally {
        server.close(); chat.close(); codes.close(); actor.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
