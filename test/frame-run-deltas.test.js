'use strict';
// An Actor turn's words as the model writes them (11-18, the owner: "stream response"): while the conversation's newest
// turn runs, the Frame's stream follows that turn's own task stream (?deltas=1) and passes each piece on as
// `delta { live: true, text }`, unstored; the stored answer still comes as a step. A Codes run is not followed.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createFrameRuns } = require('../server/frame/runs');

const TOKEN = 'Bearer tok_person_1234567890';
const TURN = 'tsk_01M7P78K4FGZ6J3PNXDMT9N9KB';
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const sendJson = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };

(async () => {
    const followed = [];
    let answered = false;
    const run = () => ({ id: 'tsk_ACTOR1', owner: { type: 'user', id: 'usr_1' }, agent: { id: 'actor', name: 'Actor', product: 'actor' }, kind: 'chat', status: answered ? 'waiting' : 'running',
        waiting: answered ? { for: 'message' } : null, created_at: '2026-11-18T04:00:00Z', updated_at: '2026-11-18T04:00:05Z', url: `https://openvibe.actor/chat/${TURN}`, title: 'Plan my week' });
    const actor = await listen((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === `/api/v1/tasks/${TURN}/events`) {
            followed.push({ deltas: u.searchParams.get('deltas'), auth: req.headers.authorization });
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('event: delta\ndata: {"text":"Monday: ","n":1}\n\n');
            setTimeout(() => res.write('event: delta\ndata: {"text":"the gym, then ","n":1}\n\n'), 40);
            setTimeout(() => { res.write('event: delta\ndata: {"text":"the dentist.","n":1}\n\n'); }, 80);
            setTimeout(() => { answered = true; res.write('id: 9\nevent: end\ndata: {}\n\n'); res.end(); }, 140);
            return;
        }
        if (u.pathname === '/api/v1/runs/tsk_ACTOR1/steps') {
            const steps = [{ seq: 1, kind: 'message', from: 'person', status: 'done', text: 'Plan my week' }];
            if (answered) steps.push({ seq: 2, kind: 'message', from: 'agent', status: 'done', text: 'Monday: the gym, then the dentist.' });
            return sendJson(res, 200, { steps });
        }
        if (u.pathname === '/api/v1/runs/tsk_ACTOR1') return sendJson(res, 200, run());
        return sendJson(res, 404, { error: 'not found' });
    });
    const urls = { actor: `http://127.0.0.1:${actor.address().port}`, chat: 'http://127.0.0.1:9', codes: 'http://127.0.0.1:9' };
    const frame = createFrameRuns({ svcUrl: (name, fallback) => urls[name] || fallback, personOf: async () => ({ subject_id: 'usr_01K9R2V6M8Q4T0B7C3D5E9F2GH' }), log: { warn() {} }, since: 0 });
    const app = express();
    app.use('/api/frame/runs', frame.router);
    const server = await listen(app);
    try {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/frame/runs/actor:tsk_ACTOR1/events`, { headers: { authorization: TOKEN } });
        assert.strictEqual(r.status, 200);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let text = '';
        const end = Date.now() + 8000;
        while (Date.now() < end && !/event: end/.test(text)) {
            const { value, done } = await reader.read();
            if (done) break;
            text += dec.decode(value, { stream: true });
        }
        try { await reader.cancel(); } catch { /* closed */ }
        const events = text.split('\n\n').filter(Boolean).map((b) => ({ event: (/^event: (.+)$/m.exec(b) || [])[1], data: JSON.parse((/^data: (.+)$/m.exec(b) || [, '{}'])[1]) }));
        const live = events.filter((e) => e.event === 'delta').map((e) => e.data);
        assert.deepStrictEqual(live.map((d) => d.text), ['Monday: ', 'the gym, then ', 'the dentist.'], JSON.stringify(events.map((e) => e.event)));
        assert.ok(live.every((d) => d.live === true && d.type === 'delta'), 'unstored pieces, marked live');
        assert.deepStrictEqual(followed, [{ deltas: '1', auth: TOKEN }], 'the newest turn followed once, as the person');
        const answer = events.find((e) => e.event === 'step' && e.data.step && e.data.step.from === 'agent');
        assert.ok(answer && /dentist/.test(answer.data.step.text), 'the stored answer still comes as a step');
        assert.ok(events.findIndex((e) => e.event === 'delta') < events.findIndex((e) => e.event === 'step' && e.data.step.from === 'agent'), 'the words come before the stored answer');
        console.log('frame-run-deltas: an Actor turn\'s words pass on as they are written, then the stored answer');
    } finally {
        server.close(); actor.close();
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
