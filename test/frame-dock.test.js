'use strict';
// /api/frame/agent-view, /api/frame/agent/timeline and /api/frame/actor: the shared Dock's OpenVibe.Codes and
// OpenVibe.Actor calls on every site, relayed through Network because every site's connect-src lets the Dock reach
// openvibe.network and refuses openvibe.codes and openvibe.actor (2026-11-09: 49 sites logged the refusals). Only
// the person's Bearer token goes upstream, never a cookie; fixed paths; JSON bodies at most 8 KB; upstream status
// and answer pass back; nothing is cached, and a signed-out page asks upstream nothing.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

const TOKEN = 'Bearer abcdefghijklmnop.qrstu';
const AGENT_ID = 'agt_00000000000000000000000000';
const MEMORY_ID = 'mem_00000000000000000000000000';
// A one-pixel JPEG: the still the Dock shows when nothing is live.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

(async () => {
    const asked = [];
    let down = false;
    const stub = (name, handler) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                req.body = Buffer.concat(chunks).toString('utf8');
                asked.push({ svc: name, method: req.method, url: req.url, auth: req.headers.authorization || '', cookie: req.headers.cookie || '', body: req.body });
                if (down) { res.statusCode = 503; return res.end('{"error":"down"}'); }
                return handler(req, res, new URL(req.url, 'http://x'));
            });
        });
        return server;
    };
    const codes = stub('codes', (req, res, u) => {
        if (u.pathname === '/api/v1/me/agent-view' && req.method === 'GET') {
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ agent: { id: 'ags_1', state: 'live', title: 'Ship it' } }));
        }
        if (u.pathname === '/api/v1/me/agent-view/frame' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=10' });
            return res.end(JPEG);
        }
        if (/^\/api\/v1\/me\/agent-view\/(pause|curtain|mute|end)$/.test(u.pathname) && req.method === 'POST') {
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ agent: { id: 'ags_1', state: 'live', control: u.pathname.split('/').pop() } }));
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"error":"no route"}');
    });
    const actor = stub('actor', (req, res, u) => {
        res.setHeader('content-type', 'application/json');
        if (u.pathname === `/api/v1/me/agents/${AGENT_ID}` && u.searchParams.get('view') === 'sheet') return res.end(JSON.stringify({ agent: { id: AGENT_ID, name: 'Helper' }, work: [], asks_empty: 'Requests to approve or decline will appear here.' }));
        if (u.pathname === `/api/v1/me/agents/${AGENT_ID}` && req.method === 'PATCH') return res.end(JSON.stringify({ status: JSON.parse(req.body || '{}').status }));
        if (u.pathname === `/api/v1/me/agents/${AGENT_ID}/memory` && req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ text: JSON.parse(req.body || '{}').text })); }
        if (u.pathname === `/api/v1/me/agents/${AGENT_ID}/memory/${MEMORY_ID}` && (req.method === 'PATCH' || req.method === 'DELETE')) { res.statusCode = req.method === 'DELETE' ? 204 : 200; return res.end(req.method === 'DELETE' ? '' : JSON.stringify({ text: JSON.parse(req.body || '{}').text })); }
        if (u.pathname === '/api/v1/agent/timeline' && req.method === 'GET') return res.end(JSON.stringify({ now: null, needs_you: [], entries: [], counts: { mode: u.searchParams.get('mode') } }));
        if (/^\/api\/v1\/agent\/approvals\/[a-z]+\/[A-Za-z0-9._~-]+\/decide$/.test(u.pathname) && req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ product: 'actor', state: 'approved' })); }
        if (u.pathname === '/api/v1/agent/kill-switch' && req.method === 'POST') return res.end(JSON.stringify({ ok: true }));
        if (/^\/api\/v1\/tasks\/[A-Za-z0-9._~-]+\/(takeover|giveback)$/.test(u.pathname) && req.method === 'POST') return res.end(JSON.stringify({ ok: true }));
        if (u.pathname === '/api/v1/me/actor' && req.method === 'GET') return res.end(JSON.stringify({ id: 'act_1', name: 'My Actor', status: 'resting', asks: [] }));
        if (/^\/api\/v1\/me\/actor\/(pause|resume|tell)$/.test(u.pathname) && req.method === 'POST') return res.end(JSON.stringify({ ok: true }));
        if (/^\/api\/v1\/me\/actor\/asks\/[A-Za-z0-9._~-]+\/(answer|decline)$/.test(u.pathname) && req.method === 'POST') return res.end(JSON.stringify({ ok: true }));
        res.statusCode = 404;
        return res.end('{"error":"no route"}');
    });
    await Promise.all([codes, actor].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
    const svc = await createFrameService(getDb(), { services: {
        codes: { internalUrl: `http://127.0.0.1:${codes.address().port}` },
        actor: { internalUrl: `http://127.0.0.1:${actor.address().port}` },
    } }, null);
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

    // The agent view: the person's token upstream, never their cookie, and never kept.
    let { r, d } = await get('/agent-view', { Authorization: TOKEN, Cookie: 'ov_token=secret' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(d.agent.title, 'Ship it');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'any site may ask');
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store', 'a personal answer is not kept');
    let hit = asked.find((x) => x.url === '/api/v1/me/agent-view' && x.method === 'GET');
    assert.strictEqual(hit.auth, TOKEN, "the person's token goes along");
    assert.strictEqual(hit.cookie, '', 'a cookie never does');

    // Signed out: a 401 and nothing asked upstream.
    const before = asked.length;
    ({ r } = await get('/agent-view'));
    assert.strictEqual(r.status, 401, 'no token, no agent view');
    ({ r } = await get('/agent/timeline'));
    assert.strictEqual(r.status, 401, 'no token, no timeline');
    ({ r } = await get('/actor'));
    assert.strictEqual(r.status, 401, 'no token, no Actor');
    assert.strictEqual(asked.length, before, 'none of the signed-out calls asked upstream');

    // The still is the picture itself, with Codes' type.
    const still = await fetch(`${base}/agent-view/frame`, { headers: { Authorization: TOKEN } });
    assert.strictEqual(still.status, 200);
    assert.strictEqual(still.headers.get('content-type'), 'image/jpeg');
    assert.deepStrictEqual(Buffer.from(await still.arrayBuffer()), JPEG, 'the bytes pass through');
    hit = asked.find((x) => x.url === '/api/v1/me/agent-view/frame');
    assert.strictEqual(hit.auth, TOKEN, 'the still is asked with the token');

    // The four controls post the Dock's body and pass Codes' answer back.
    for (const what of ['pause', 'curtain', 'mute', 'end']) {
        ({ r, d } = await send(`/agent-view/${what}`, { paused: true }));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(d.agent.control, what);
        hit = asked.find((x) => x.url === `/api/v1/me/agent-view/${what}`);
        assert.strictEqual(hit.method, 'POST');
        assert.deepStrictEqual(JSON.parse(hit.body), { paused: true }, 'the body passes');
        assert.strictEqual(hit.auth, TOKEN, 'and the token');
    }

    // The timeline passes its four filters and drops anything else.
    ({ d } = await get('/agent/timeline?mode=code&needs_you=1&cursor=c2&scope=shared&subject=usr_other&limit=500', { Authorization: TOKEN }));
    assert.strictEqual(d.counts.mode, 'code');
    hit = new URL(asked.filter((x) => x.url.startsWith('/api/v1/agent/timeline')).at(-1).url, 'http://x');
    assert.deepStrictEqual([...hit.searchParams.keys()].sort(), ['cursor', 'mode', 'needs_you', 'scope'], 'only the Dock\'s filters go upstream');
    assert.strictEqual(hit.searchParams.get('needs_you'), '1');

    // An approval keeps its product and id fixed; a bad one asks upstream nothing.
    ({ r, d } = await send('/agent/approvals/actor/apr_01JZ/decide', { decision: 'approve' }));
    assert.strictEqual(r.status, 201, 'the upstream status passes');
    assert.strictEqual(d.state, 'approved');
    hit = asked.find((x) => x.url === '/api/v1/agent/approvals/actor/apr_01JZ/decide');
    assert.deepStrictEqual(JSON.parse(hit.body), { decision: 'approve' });
    const askedBefore = asked.length;
    ({ r } = await send('/agent/approvals/../../etc/apr_1/decide', { decision: 'approve' }));
    assert.ok(r.status === 404 || r.status === 401, 'a bad product is refused');
    ({ r } = await send('/agent/approvals/actor/bad id/decide', { decision: 'approve' }));
    assert.strictEqual(r.status, 404, 'a bad id is refused');
    assert.strictEqual(asked.length, askedBefore, 'neither asked upstream');

    // The kill switch and the task hand-off.
    ({ r } = await send('/agent/kill-switch', { action: 'stop' }));
    assert.strictEqual(r.status, 200);
    ({ r } = await send('/tasks/tsk_01JZ/takeover'));
    assert.strictEqual(r.status, 200);
    assert.ok(asked.some((x) => x.url === '/api/v1/tasks/tsk_01JZ/takeover' && x.method === 'POST'));

    // The Actor block and its ask.
    ({ r, d } = await get('/actor', { Authorization: TOKEN }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(d.name, 'My Actor');
    for (const what of ['pause', 'resume', 'tell']) {
        ({ r } = await send(`/actor/${what}`, { text: 'hello' }));
        assert.strictEqual(r.status, 200);
    }
    for (const what of ['answer', 'decline']) {
        ({ r } = await send(`/actor/asks/ask_1/${what}`, { option: 'yes' }));
        assert.strictEqual(r.status, 200);
        assert.ok(asked.some((x) => x.url === `/api/v1/me/actor/asks/ask_1/${what}` && x.method === 'POST'));
    }

    // The sheet and its owner edits use fixed paths, pass only the Bearer, and reject malformed IDs locally.
    ({ r, d } = await get(`/agents/${AGENT_ID}/sheet`, { Authorization: TOKEN, Cookie: 'ov_token=secret' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(d.agent.name, 'Helper');
    hit = asked.at(-1);
    assert.strictEqual(hit.url, `/api/v1/me/agents/${AGENT_ID}?view=sheet`);
    assert.strictEqual(hit.auth, TOKEN);
    assert.strictEqual(hit.cookie, '');
    const sheetCalls = asked.length;
    ({ r } = await get(`/agents/${AGENT_ID}/sheet`));
    assert.strictEqual(r.status, 401);
    ({ r } = await get('/agents/bad/sheet', { Authorization: TOKEN }));
    assert.strictEqual(r.status, 404);
    assert.strictEqual(asked.length, sheetCalls);
    const patch = await fetch(`${base}/agents/${AGENT_ID}`, { method: 'PATCH', headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'paused' }) });
    assert.strictEqual((await patch.json()).status, 'paused');
    ({ r, d } = await send(`/agents/${AGENT_ID}/memory`, { text: 'Keep this fact' }));
    assert.strictEqual(r.status, 201);
    assert.strictEqual(d.text, 'Keep this fact');
    const editMemory = await fetch(`${base}/agents/${AGENT_ID}/memory/${MEMORY_ID}`, { method: 'PATCH', headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Revised fact' }) });
    assert.strictEqual((await editMemory.json()).text, 'Revised fact');
    const removeMemory = await fetch(`${base}/agents/${AGENT_ID}/memory/${MEMORY_ID}`, { method: 'DELETE', headers: { Authorization: TOKEN } });
    assert.strictEqual(removeMemory.status, 204);

    // A preflight is answered for every path; an upstream status passes back, and a service that is not there is
    // a 502, never a hang.
    const opt = await fetch(`${base}/agent/timeline`, { method: 'OPTIONS' });
    assert.strictEqual(opt.status, 204);
    assert.strictEqual(opt.headers.get('access-control-allow-origin'), '*');
    assert.match(opt.headers.get('access-control-allow-headers'), /Authorization/);
    down = true;
    ({ r } = await get('/agent-view', { Authorization: TOKEN }));
    assert.strictEqual(r.status, 503, "Codes' own status passes back");
    down = false;
    await new Promise((resolve) => actor.close(resolve));
    ({ r } = await get('/actor', { Authorization: TOKEN }));
    assert.strictEqual(r.status, 502, 'Actor not answering is a 502');

    // Bodies over 8 KB are refused before they reach a service.
    const big = await fetch(`${base}/actor/tell`, { method: 'POST', headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(9000) }) });
    assert.strictEqual(big.status, 413, 'an 8 KB ceiling');

    server.close();
    console.log('frame dock relay: the Dock\'s Codes and Actor calls through Network');
    console.log('all passed');
    process.exit(0);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
