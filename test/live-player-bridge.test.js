'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const helmet = require('helmet');
const path = require('node:path');
const { router, parentOrigin } = require('../server/frame/live-player');

assert.equal(parentOrigin('https://openvibe.video'), 'https://openvibe.video');
assert.equal(parentOrigin('https://evil.example'), null);
assert.equal(parentOrigin('http://openvibe.video'), null);
assert.equal(parentOrigin('https://openvibe.video/path'), null);

(async () => {
    const app = express();
    app.use(helmet());
    app.use('/frame/live', router);
    app.use(express.static(path.join(__dirname, '..', 'public')));
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const res = await fetch(`${base}/frame/live/maticus?from=https%3A%2F%2Fopenvibe.video`);
        assert.equal(res.status, 200);
        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /frame-src https:\/\/openvibe\.live/);
        assert.match(csp, /frame-ancestors https:\/\/openvibe\.video/);
        assert.equal(res.headers.get('x-frame-options'), null);
        const html = await res.text();
        assert.match(html, /https:\/\/openvibe\.live\/embed\/maticus/);
        assert.match(html, /\/js\/live-player-bridge\.js/);
        const script = await fetch(`${base}/js/live-player-bridge.js`);
        assert.equal(script.status, 200);
        for (const from of ['https://evil.example', 'http://openvibe.video', 'https://openvibe.video/path']) {
            const blocked = await fetch(`${base}/frame/live/maticus?from=${encodeURIComponent(from)}`);
            assert.equal(blocked.status, 404);
        }
        console.log('live-player-bridge: exact first-party frame policy and relay asset');
    } finally { server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
