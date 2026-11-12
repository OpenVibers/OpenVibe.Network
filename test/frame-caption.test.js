'use strict';
// POST /api/frame/caption (11-12): a picture's alt text, caption and tags from AI's pics.describe_image, as the person
// (their token goes to AI), signed in only, validated, rate-limited, and an AI refusal passed on with its words.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createFrameCaption, readCaption } = require('../server/frame/caption');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SUBJECT = 'usr_01KKT9AC60KM7CRTB3WN1Z8P56';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.person-token.signature';

(async () => {
    assert.deepStrictEqual(readCaption({}), { error: 'Send the picture as image.data_url' });
    assert.match(readCaption({ image: { data_url: 'data:image/svg+xml;base64,PHN2Zz4=' } }).error, /JPEG, PNG or WebP/);
    assert.match(readCaption({ image: { data_url: `data:image/jpeg;base64,${'A'.repeat(950_001)}` } }).error, /too large/);
    assert.deepStrictEqual(readCaption({ image: { data_url: PNG }, title: ' My\ncat ' }), { dataUrl: PNG, title: 'My cat' });

    const sent = [];
    let answer = { status: 201, body: { run: { id: 'run_1', status: 'succeeded', output: { alt: 'A tabby cat asleep on a red blanket', caption: 'Nap time, again.', tags: ['cat', 'nap', ' '] } } } };
    const fetchImpl = async (url, init) => {
        sent.push({ url, init, body: JSON.parse(init.body) });
        return { ok: answer.status < 400, status: answer.status, headers: { get: () => null }, json: async () => answer.body };
    };
    let t = 0;
    const requireAuth = (req, res, next) => {
        if (req.get('authorization') !== `Bearer ${TOKEN}`) return res.status(401).json({ error: 'sign in' });
        req.user = { subject_id: SUBJECT };
        return next();
    };
    const { caption } = createFrameCaption({ aiUrl: 'http://ai.test/', requireAuth, fetchImpl, now: () => t, perMinute: 2 });
    const app = express();
    app.post('/api/frame/caption', ...caption);
    const server = http.createServer(app);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}/api/frame/caption`;
    const post = (body, auth = true) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify(body) });
    try {
        let r = await post({ image: { data_url: PNG } }, false);
        assert.strictEqual(r.status, 401, 'signed in only');
        assert.strictEqual(sent.length, 0);

        r = await post({ image: { data_url: PNG }, title: 'cat' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(await r.json(), { alt: 'A tabby cat asleep on a red blanket', caption: 'Nap time, again.', tags: ['cat', 'nap'] });
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.ok(sent[0].url.startsWith('http://ai.test/api/v1/runs?wait='), 'one run on AI');
        assert.strictEqual(sent[0].init.headers.Authorization, `Bearer ${TOKEN}`, 'as the person: their token pays');
        assert.deepStrictEqual(sent[0].body, { workflow: 'pics.describe_image', input: { image: { data_url: PNG }, title: 'cat' } });

        r = await post({ image: { data_url: 'data:text/html;base64,PGI+' } });
        assert.strictEqual(r.status, 422);

        answer = { status: 402, body: { code: 'quota.exhausted', detail: 'Your free AI allowance for today is used up' } };
        r = await post({ image: { data_url: PNG } });
        assert.deepStrictEqual([r.status, (await r.json()).error], [402, 'Your free AI allowance for today is used up'], 'AI\'s refusal, in its own words');

        r = await post({ image: { data_url: PNG } });
        assert.strictEqual(r.status, 429, 'two a minute in this test');
        t += 61_000;
        answer = { status: 202, body: { run: { id: 'run_2', status: 'running', output: null } } };
        r = await post({ image: { data_url: PNG } });
        assert.strictEqual(r.status, 504, 'a run still going is a timeout the composer can retry');
        console.log('frame caption: as the person, validated, AI\'s words passed on, rate-limited');
    } finally {
        server.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
