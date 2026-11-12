'use strict';
// GET /api/frame/choices: AI's task choices for the person, joined with Exchange's model directory (maker, price per
// million, speed, rating and page) and the plans group. Signed in the token goes to AI and the answer is never kept;
// signed out only the OpenVibe group is named and the whole answer is kept 60 s.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

const TOKEN = `Bearer ${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(20)}`;

(async () => {
    const asked = [];
    let aiDown = false;
    const ai = http.createServer((req, res) => {
        asked.push({ path: req.url, auth: req.headers.authorization || '' });
        if (aiDown) { res.statusCode = 503; return res.end('{}'); }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            task: { name: 'chat.reply', kind: 'text' },
            choice: { model: 'openai/gpt-5-mini', source: 'openvibe' },
            recommended: { model: 'openai/gpt-5-mini', source: 'openvibe' },
            options: {
                openvibe: [
                    { model: 'openai/gpt-5-mini', source: 'openvibe', name: 'GPT-5 Mini', maker: 'openai', price_estimate_usd: 0.003, speed_ms: 900, quality: 0.8, adult: false },
                    { model: 'abliteratedmodels/uncensored', source: 'openvibe', name: 'Uncensored', maker: 'abliteratedmodels', adult: true },
                ],
                keys: [{ model: 'openai/gpt-5-mini', source: 'keys', name: 'GPT-5 Mini', maker: 'openai', price_estimate_usd: 0 }],
                machines: [{ model: 'llama3.1:8b', source: 'machines', machine: 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', name: 'llama3.1:8b', maker: null }],
            },
            adult: false,
        }));
    });
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    const exchange = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ count: 1, models: [{
            id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 Mini', provider: 'openai', provider_name: 'OpenAI',
            status: 'available', routing_enabled: true, type: 'chat',
            price: { input_per_million: 0.25, output_per_million: 2 }, offers: [{ price: { in: 0.25, out: 2 }, speed: { p50_ms: 750 } }],
        }] }));
    });
    await new Promise((r) => exchange.listen(0, '127.0.0.1', r));
    const report = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ rows: [{ id: 'openai/gpt-5-mini', rating: { value: 0.82 }, benchmark: { value: null }, uncensored: false }] }));
    });
    await new Promise((r) => report.listen(0, '127.0.0.1', r));

    const svc = await createFrameService(getDb(), { services: {
        ai: { internalUrl: `http://127.0.0.1:${ai.address().port}` },
        exchange: { internalUrl: `http://127.0.0.1:${exchange.address().port}` },
        report: { internalUrl: `http://127.0.0.1:${report.address().port}` },
    } }, null);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame/choices`;
    const get = async (qs, headers) => { const r = await fetch(`${base}${qs}`, { headers }); return { r, d: await r.json() }; };

    try {
        // Signed out: only OpenVibe, enriched from Exchange and Report, held 60 s.
        let { r, d } = await get('?task=chat');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
        assert.deepStrictEqual(d.groups.map((g) => g.id), ['openvibe'], 'keys and machines need a person');
        assert.deepStrictEqual(d.recommended, { model: 'openai/gpt-5-mini', source: 'openvibe' });
        const row = d.groups[0].rows[0];
        assert.deepStrictEqual([row.model, row.source, row.name, row.maker], ['openai/gpt-5-mini', 'openvibe', 'GPT-5 Mini', 'openai']);
        assert.deepStrictEqual(row.price, { in: 0.25, out: 2, unit: 'USD per 1M tokens' });
        assert.strictEqual(row.free, false);
        assert.strictEqual(row.speed, 750);
        assert.strictEqual(row.score, 0.82);
        assert.equal(row.url, 'https://openvibe.exchange/models/openai%2Fgpt-5-mini');
        assert.ok(!d.groups[0].rows.some((x) => x.adult), 'an 18+ row is not offered without the 18+ setting');
        assert.strictEqual(asked[0].auth, '', 'an anonymous sheet asks as anyone');
        const firstUrls = asked.map((x) => x.path);
        await get('?task=chat');
        assert.deepStrictEqual(asked.map((x) => x.path), firstUrls, 'the anonymous sheet is answered from memory');

        // Signed in: the person's token goes to AI, all four groups are named, and nothing is kept.
        ({ r, d } = await get('?task=chat', { Authorization: TOKEN }));
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.deepStrictEqual(d.groups.map((g) => g.id), ['openvibe', 'keys', 'machines', 'plans']);
        assert.strictEqual(asked[asked.length - 1].auth, TOKEN, "the person's token goes along");
        assert.strictEqual(d.groups.find((g) => g.id === 'keys').rows[0].source, 'keys');
        assert.strictEqual(d.groups.find((g) => g.id === 'keys').rows[0].price.in, 0.25, 'a key row still shows the model price');
        assert.strictEqual(d.groups.find((g) => g.id === 'keys').rows[0].free, true, 'no OpenVibe fee on your own key');
        const machine = d.groups.find((g) => g.id === 'machines').rows[0];
        assert.deepStrictEqual([machine.model, machine.source, machine.machine], ['llama3.1:8b', 'machines', 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3']);
        assert.strictEqual(d.groups.find((g) => g.id === 'plans').rows.length, 0);
        assert.match(d.groups.find((g) => g.id === 'plans').note, /Codes/);
        await get('?task=chat', { Authorization: TOKEN });
        assert.strictEqual(asked.filter((x) => x.auth === TOKEN).length, 2, 'a person is always asked fresh');

        // The task maps to AI's task for it; a malformed token is a signed-out ask, never a person's.
        await get('?task=code', { Authorization: 'Bearer short' });
        assert.strictEqual(asked[asked.length - 1].auth, '', 'a malformed token is not passed on');
        assert.match(asked[asked.length - 1].path, /task=design\.icon$/, 'code maps to AI\'s code task');

        // AI down: Exchange's directory still fills the OpenVibe group, with a note.
        aiDown = true;
        ({ r, d } = await get('?task=agent'));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(d.groups[0].rows[0].model, 'openai/gpt-5-mini');
        assert.match(d.groups[0].note, /Exchange/);
        aiDown = false;

        // A task not in the list is a 400, never an upstream ask.
        const n = asked.length;
        ({ r, d } = await get('?task=unreal'));
        assert.strictEqual(r.status, 400);
        assert.strictEqual(d.code, 'frame.task_invalid');
        assert.strictEqual(asked.length, n);

        console.log('  ok  frame choices: AI choices, Exchange enrichment, signed-out cache and the plans note\n');
    } finally {
        server.close(); svc.stop(); ai.close(); exchange.close(); report.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
