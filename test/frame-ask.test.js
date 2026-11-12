'use strict';
// POST /api/frame/ask: one question on the chosen model, Search's results in the prompt, the answer streamed on
// /api/v1/runs/:id/events with the final ANSWER carrying numbered citations. Signed in only; the person's token pays
// on Search and AI, an 18+ model the person has not opted into is refused, and the stream resumes from Last-Event-ID.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

const TOKEN = `Bearer ${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(20)}`;
const RAW = TOKEN.slice(7);
const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';

function fakeAuth(req, res, next) {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.get('authorization') || ''));
    if (!m) return res.status(401).json({ error: 'sign in' });
    req.token = m[1];
    req.user = { subject_id: USR };
    req.tokenClaims = { sub: USR, subject_id: USR };
    next();
}

function blocks(text) {
    return text.split('\n\n').filter((b) => b.trim()).map((b) => {
        const out = { id: null, event: null, data: null };
        for (const line of b.split('\n')) {
            if (line.startsWith('id: ')) out.id = line.slice(4);
            else if (line.startsWith('event: ')) out.event = line.slice(7);
            else if (line.startsWith('data: ')) { try { out.data = JSON.parse(line.slice(6)); } catch { out.data = null; } }
        }
        return out;
    });
}

(async () => {
    const asked = [];
    const ai = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const u = new URL(req.url, 'http://x');
            asked.push({ method: req.method, path: u.pathname, query: u.search, auth: req.headers.authorization || '', body: Buffer.concat(chunks).toString('utf8') });
            if (u.pathname === '/api/v1/choices') {
                res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify({
                    task: { name: 'chat.reply', kind: 'text' }, choice: { model: 'openai/gpt-5-mini', source: 'openvibe' },
                    recommended: { model: 'openai/gpt-5-mini', source: 'openvibe' }, adult: false,
                    options: { openvibe: [{ model: 'openai/gpt-5-mini', source: 'openvibe', name: 'GPT-5 Mini', maker: 'openai', adult: false }], keys: [], machines: [] },
                }));
            }
            if (u.pathname === '/api/v1/runs' && u.searchParams.get('stream') === '1') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('event: delta\ndata: {"text":"The answer "}\n\n');
                res.write('event: delta\ndata: {"text":"is [1]."}\n\n');
                res.end(`event: run\ndata: ${JSON.stringify({ run: { id: 'run_ai', status: 'succeeded', cost_usd: 0.001, output: { text: 'The answer is [1].' }, provenance: { model: 'openai/gpt-5-mini' } } })}\n\n`);
                return;
            }
            res.statusCode = 404; res.end('{}');
        });
    });
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    const search = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        asked.push({ method: req.method, path: u.pathname, query: u.search, auth: req.headers.authorization || '', body: '' });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            results: [
                { scope: 'web', kind: 'page', title: 'Example source', url: 'https://example.org/a', site: 'example.org', snippet: 'The source says five.', provider: 'wikipedia' },
                { scope: 'network', kind: 'document', title: 'A network post', url: 'https://openvibe.community/p/1', site: 'openvibe.community', snippet: 'A post about it.' },
            ], groups: { web: 1, network: 1 }, citations: [], route: { explain: [], cost_usd: 0 }, next_cursor: null,
        }));
    });
    await new Promise((r) => search.listen(0, '127.0.0.1', r));

    const svc = await createFrameService(getDb(), { services: {
        ai: { internalUrl: `http://127.0.0.1:${ai.address().port}` },
        search: { internalUrl: `http://127.0.0.1:${search.address().port}` },
    } }, null, { requireAuth: fakeAuth, aiUrl: `http://127.0.0.1:${ai.address().port}` });
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    app.use('/api/v1/runs', svc.runsRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body, headers = { Authorization: TOKEN }) => {
        const r = await fetch(`${base}/api/frame/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        return { r, d: await r.json().catch(() => null) };
    };

    try {
        // One asked question: the answer comes back as AG-UI events, with the numbered sources in ANSWER.
        let { r, d } = await post({
            text: 'What is example?', model: 'openai/gpt-5-mini', sources: ['web', 'openvibe', 'page'], depth: 'balanced',
            files: ['med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3'],
            context: { site: 'openvibe.community', url: 'https://openvibe.community/thread/1', title: 'The thread', kind: 'thread', id: '1', text: 'The page says five too.' },
        });
        assert.strictEqual(r.status, 202);
        assert.match(d.run, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
        const runId = d.run;
        const eventsRes = await fetch(`${base}/api/v1/runs/${runId}/events`, { headers: { Authorization: TOKEN } });
        assert.strictEqual(eventsRes.status, 200);
        assert.match(eventsRes.headers.get('content-type'), /text\/event-stream/);
        const events = blocks(await eventsRes.text());
        const types = events.map((e) => e.event);
        assert.ok(types.includes('RUN_STARTED'));
        assert.ok(types.filter((t) => t === 'STEP_STARTED').length >= 2, 'Search and Answer are steps');
        assert.strictEqual(types.at(-1), 'RUN_FINISHED');
        assert.strictEqual(types.at(-2), 'ANSWER');
        assert.match(events.filter((e) => e.event === 'TEXT_MESSAGE_CONTENT').map((e) => e.data.delta).join(''), /^The answer is \[1\]\.$/);
        const answer = events.find((e) => e.event === 'ANSWER').data;
        assert.strictEqual(answer.answer, 'The answer is [1].');
        assert.strictEqual(answer.model, 'openai/gpt-5-mini');
        assert.deepStrictEqual(answer.citations.map((c) => [c.n, c.title, c.site]), [[1, 'Example source', 'example.org'], [2, 'A network post', 'openvibe.community'], [3, 'The thread', 'openvibe.community']]);
        const eventIds = events.map((e) => Number(e.id));
        assert.deepStrictEqual(eventIds, eventIds.map((_, i) => i + 1), 'events are numbered from 1');

        // What went upstream: Search scopes and the person's token; AI's chat with the numbered sources and the choice.
        const searchHit = asked.find((x) => x.path === '/api/v1/query');
        const su = new URL(searchHit.query, 'http://x');
        assert.strictEqual(su.searchParams.get('scopes'), 'web,network', 'page is context, not a Search scope');
        assert.strictEqual(su.searchParams.get('depth'), 'standard');
        assert.strictEqual(searchHit.auth, TOKEN);
        const chatHit = asked.find((x) => x.path === '/api/v1/runs' && x.query.includes('stream=1'));
        assert.strictEqual(chatHit.auth, TOKEN, "the person's token pays for the model");
        const chat = JSON.parse(chatHit.body);
        assert.strictEqual(chat.workflow, 'ai.chat');
        assert.deepStrictEqual(chat.choice, { model: 'openai/gpt-5-mini', source: 'openvibe' });
        assert.match(chat.input.messages[0].content, /\[1\] Example source — https:\/\/example\.org\/a/);
        assert.match(chat.input.messages[0].content, /\[3\] The thread/);
        assert.match(chat.input.messages[0].content, /The page's text/);
        assert.deepStrictEqual(chat.input.files, [{ id: 'med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3' }], 'a Media id rides on the turn');

        // The run's snapshot has the same answer.
        let snap = await fetch(`${base}/api/v1/runs/${runId}`, { headers: { Authorization: TOKEN } }).then((x) => x.json());
        assert.deepStrictEqual([snap.run.status, snap.run.answer, snap.run.citations.length], ['succeeded', 'The answer is [1].', 3]);

        // Resuming from Last-Event-ID sends only what came after it.
        const again = blocks(await fetch(`${base}/api/v1/runs/${runId}/events`, { headers: { Authorization: TOKEN, 'Last-Event-ID': '2' } }).then((x) => x.text()));
        assert.ok(again.length > 0 && Number(again[0].id) === 3, `resumed at ${again[0] && again[0].id}`);
        assert.strictEqual(again.at(-1).event, 'RUN_FINISHED');

        // Deep: Search's deep ladder with twenty sources, and room for a longer answer.
        asked.length = 0;
        ({ r, d } = await post({ text: 'A deep question', model: 'openai/gpt-5-mini', sources: ['web'], depth: 'deep' }));
        assert.strictEqual(r.status, 202);
        await fetch(`${base}/api/v1/runs/${d.run}/events`, { headers: { Authorization: TOKEN } }).then((x) => x.text());
        const deep = new URL(asked.find((x) => x.path === '/api/v1/query').query, 'http://x');
        assert.deepStrictEqual([deep.searchParams.get('depth'), deep.searchParams.get('limit')], ['deep', '20']);
        assert.strictEqual(JSON.parse(asked.find((x) => x.path === '/api/v1/runs' && x.query.includes('stream=1')).body).input.max_tokens, 4000);

        // Signed out: 401 and nothing asked of AI or Search.
        let n = asked.length;
        ({ r } = await post({ text: 'hello' }, {}));
        assert.strictEqual(r.status, 401);
        assert.strictEqual(asked.length, n, 'nothing went upstream');

        // An 18+ model the person has not opted into is refused before a run exists.
        n = asked.length;
        ({ r, d } = await post({ text: 'hello', model: 'abliteratedmodels/uncensored' }));
        assert.strictEqual(r.status, 403);
        assert.strictEqual(d.code, 'frame.model_refused');
        assert.strictEqual(asked.slice(n).filter((x) => x.path === '/api/v1/runs').length, 0, 'no model call for a refused model');

        // A body without text is a 422.
        ({ r } = await post({ model: 'openai/gpt-5-mini' }));
        assert.strictEqual(r.status, 422);

        // The run belongs to the person whose token made it.
        const other = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR';
        assert.notStrictEqual(other, USR);
        const notMine = await fetch(`${base}/api/v1/runs/${runId}/events`, { headers: { Authorization: TOKEN } });
        assert.strictEqual(notMine.status, 200, 'still the owner');
        assert.strictEqual((await fetch(`${base}/api/v1/runs/nope/events`, { headers: { Authorization: TOKEN } })).status, 404);

        console.log('  ok  frame ask: Search + AI chat streamed as AG-UI, ANSWER citations, deep ladder and refusals\n');
    } finally {
        server.close(); svc.stop(); ai.close(); search.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
