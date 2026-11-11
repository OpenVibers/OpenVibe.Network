'use strict';
// /api/frame/codes-tasks: the Dock's Code tab reads and writes the person's OpenVibe.Codes tasks through Network,
// because every site's connect-src allows openvibe.network and refuses openvibe.codes. Only the person's Bearer
// token goes upstream, never a cookie; upstream status and answer come back as they are; nothing is kept.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

const TOKEN = 'Bearer abcdefghijklmnop.qrstu';
const TASK = 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';

(async () => {
    const asked = [];
    let down = false;
    const codes = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const u = new URL(req.url, 'http://x');
            asked.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', cookie: req.headers.cookie || '', last: req.headers['last-event-id'] || '', body: Buffer.concat(chunks).toString('utf8') });
            if (down) { req.socket.destroy(); return; }
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (u.pathname === '/api/v1/me/tasks' && req.method === 'GET') {
                return json(200, { tasks: [{ id: TASK, limit: u.searchParams.get('limit') }] });
            }
            if (u.pathname === '/api/v1/tasks' && req.method === 'POST') {
                const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                if (!b.text) { res.statusCode = 422; return res.end('{"code":"codes.task_invalid"}'); }
                return json(201, { id: TASK, url: `https://openvibe.codes/tasks/${TASK}` });
            }
            if (u.pathname === `/api/v1/tasks/${TASK}/stop` && req.method === 'POST') return json(200, { ok: true });
            if (u.pathname === `/api/v1/runs/${TASK}` && req.method === 'GET') return json(200, { id: TASK, title: 'A task', plan: [] });
            if (u.pathname === `/api/v1/runs/${TASK}/events` && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                return res.end('id: 3\nevent: STEP_STARTED\ndata: {"type":"STEP_STARTED","stepName":"Read files"}\n\n');
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end('{"error":"no route"}');
        });
    });
    await new Promise((r) => codes.listen(0, '127.0.0.1', r));
    const svc = await createFrameService(getDb(), { services: { codes: { internalUrl: `http://127.0.0.1:${codes.address().port}` } } }, null);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame`;
    const get = async (p, headers) => { const r = await fetch(`${base}${p}`, { headers }); return { r, d: await r.json().catch(() => null) }; };
    const send = async (p, body = {}) => {
        const r = await fetch(`${base}${p}`, { method: 'POST', headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { r, d: await r.json().catch(() => null) };
    };

    try {
        // The list: the person's token upstream, the limit passed through, the answer untouched.
        let { r, d } = await get('/codes-tasks?limit=8', { Authorization: TOKEN, Cookie: 'ov_token=secret' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(d.tasks, [{ id: TASK, limit: '8' }]);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'any site may ask');
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store', 'a personal answer is not kept');
        let hit = asked.find((x) => x.url === '/api/v1/me/tasks?limit=8');
        assert.strictEqual(hit.auth, TOKEN, "the person's token goes along");
        assert.strictEqual(hit.cookie, '', 'a cookie never does');

        // A limit outside 1-50 is clamped, not refused.
        ({ r, d } = await get('/codes-tasks?limit=500', { Authorization: TOKEN }));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(asked[asked.length - 1].url, '/api/v1/me/tasks?limit=50');

        // Signed out: a 401 and nothing asked upstream.
        const before = asked.length;
        ({ r } = await get('/codes-tasks?limit=8'));
        assert.strictEqual(r.status, 401, 'no token, no tasks');
        assert.strictEqual(asked.length, before, 'nothing asked upstream');

        // A start: the JSON body rides along, the answer comes back as it is.
        ({ r, d } = await send('/codes-tasks', { text: 'Add a test.', mode: 'repo', repo: 'octocat/Hello-World' }));
        assert.strictEqual(r.status, 201);
        assert.deepStrictEqual(d, { id: TASK, url: `https://openvibe.codes/tasks/${TASK}` });
        hit = asked.find((x) => x.url === '/api/v1/tasks' && x.method === 'POST' && x.body.includes('Add a test.'));
        assert.ok(hit, 'the start reached Codes');
        assert.strictEqual(hit.auth, TOKEN);

        // Codes' own refusal passes back with its status.
        ({ r } = await send('/codes-tasks', { mode: 'repo' }));
        assert.strictEqual(r.status, 422, "Codes' 422 is the relay's 422");

        // A stop: straight to the task's stop, { ok } back.
        ({ r, d } = await send(`/codes-tasks/${TASK}/stop`, {}));
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(d, { ok: true });
        assert.ok(asked.some((x) => x.url === `/api/v1/tasks/${TASK}/stop`), 'the stop reached Codes');

        // Not a task id: 404, and Codes hears nothing.
        const n = asked.length;
        ({ r } = await send('/codes-tasks/nope/stop', {}));
        assert.strictEqual(r.status, 404);
        assert.strictEqual(asked.length, n, 'a bad id never goes upstream');

        // The card's snapshot and resumable AG-UI stream carry the same owner token.
        ({ r, d } = await get(`/codes-runs/${TASK}`, { Authorization: TOKEN }));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(d.title, 'A task');
        const events = await fetch(`${base}/codes-runs/${TASK}/events`, { headers: { Authorization: TOKEN, 'Last-Event-ID': '2' } });
        assert.strictEqual(events.status, 200);
        assert.match(await events.text(), /id: 3\nevent: STEP_STARTED/);
        hit = asked.find((x) => x.url === `/api/v1/runs/${TASK}/events`);
        assert.strictEqual(hit.auth, TOKEN);
        assert.strictEqual(hit.last, '2');
        assert.strictEqual(hit.cookie, '');
        ({ r } = await get('/codes-runs/nope', { Authorization: TOKEN }));
        assert.strictEqual(r.status, 404);
        ({ r } = await get(`/codes-runs/${TASK}`));
        assert.strictEqual(r.status, 401);

        // Preflights end here.
        const pre = await fetch(`${base}/codes-tasks`, { method: 'OPTIONS' });
        assert.strictEqual(pre.status, 204);

        // Codes down: a 502 that says so.
        down = true;
        ({ r } = await get('/codes-tasks', { Authorization: TOKEN }));
        assert.strictEqual(r.status, 502);
        console.log('  ok  the Code tab relay lists, starts and stops through the person\u2019s token');
    } finally {
        server.close();
        svc.stop();
        codes.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
