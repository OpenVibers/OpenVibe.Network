'use strict';
// /api/frame/comments: the feed's comment sheet (plan §AA.21) reads and writes Community's comment threads through
// Network, because every site's connect-src allows openvibe.network and refuses openvibe.community. Reads work signed
// out; a reply and a vote need the person's Bearer, which goes upstream as it is (never a cookie); ids are checked
// before they reach a path; Community's answer and status come back as they are.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

const TOKEN = 'Bearer abcdefghijklmnop.qrstu';
const THREAD = 'cth_AbCdEfGhIjKlMnOpQrStUv';

(async () => {
    const asked = [];
    const community = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const u = new URL(req.url, 'http://x');
            const body = Buffer.concat(chunks).toString('utf8');
            asked.push({ method: req.method, path: u.pathname, search: u.search, auth: req.headers.authorization || '', cookie: req.headers.cookie || '', body: body ? JSON.parse(body) : null });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (u.pathname === '/api/v1/comments/threads/resolve' && req.method === 'POST') return json(200, { id: THREAD, count: 2 });
            if (u.pathname === `/api/v1/comments/threads/${THREAD}` && req.method === 'GET') return json(200, { thread: { id: THREAD, count: 2 }, comments: [{ id: 'c1', message: 'First' }], next: null });
            if (u.pathname === `/api/v1/comments/threads/${THREAD}/comments` && req.method === 'POST') return json(201, { id: 'c2', message: JSON.parse(body).message });
            if (u.pathname === '/api/v1/comments/c1/votes' && req.method === 'POST') return json(200, { score: 1 });
            return json(404, { error: 'no route' });
        });
    });
    await new Promise((r) => community.listen(0, '127.0.0.1', r));
    const svc = await createFrameService(getDb(), { services: { community: { internalUrl: `http://127.0.0.1:${community.address().port}` } } }, null);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame/comments`;
    const call = async (method, path, body, headers = {}) => {
        const r = await fetch(`${base}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
        return { r, d: await r.json().catch(() => null) };
    };
    try {
        // Resolve and read, signed out.
        let { r, d } = await call('POST', '/resolve', { ref: { service: 'community', type: 'post', id: '42', label: 'not passed on' } });
        assert.strictEqual(r.status, 200); assert.strictEqual(d.id, THREAD);
        assert.deepStrictEqual(asked.at(-1).body, { ref: { service: 'community', type: 'post', id: '42' } }, 'only service, type and id go on');
        assert.strictEqual(asked.at(-1).auth, '', 'signed out: no Bearer');
        ({ r, d } = await call('GET', `/threads/${THREAD}?sort=new&limit=500&evil=1`));
        assert.strictEqual(r.status, 200); assert.strictEqual(d.comments[0].message, 'First');
        assert.strictEqual(asked.at(-1).search, '?sort=new&limit=50', 'only the known query, the limit capped');
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
        // Bad ids never reach a path.
        assert.strictEqual((await call('GET', '/threads/..%2F..%2Fadmin')).r.status, 404);
        assert.strictEqual((await call('POST', '/resolve', { ref: { service: 'Community/../x', type: 'post', id: '1' } })).r.status, 400);
        const before = asked.length;
        // A reply and a vote need the person; their Bearer goes as it is, never a cookie.
        assert.strictEqual((await call('POST', `/threads/${THREAD}/comments`, { message: 'Hi' })).r.status, 401, 'signed out cannot reply');
        assert.strictEqual(asked.length, before, 'a refused reply never reaches Community');
        ({ r, d } = await call('POST', `/threads/${THREAD}/comments`, { message: 'Hi there', parent_id: 'c1', extra: true }, { Authorization: TOKEN, Cookie: 'ov_token=x' }));
        assert.strictEqual(r.status, 201); assert.strictEqual(d.message, 'Hi there');
        assert.deepStrictEqual(asked.at(-1).body, { message: 'Hi there', parent_id: 'c1' });
        assert.deepStrictEqual([asked.at(-1).auth, asked.at(-1).cookie], [TOKEN, ''], 'the Bearer, never a cookie');
        ({ r } = await call('POST', '/c1/votes', { value: 1 }, { Authorization: TOKEN }));
        assert.strictEqual(r.status, 200); assert.deepStrictEqual(asked.at(-1).body, { value: 1 });
        // The browser may ask first.
        const pre = await fetch(`${base}/threads/${THREAD}/comments`, { method: 'OPTIONS' });
        assert.strictEqual(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
        console.log('frame-comments: resolve and read signed out, reply and vote with the person\'s Bearer only, ids checked, queries narrowed');
    } finally {
        server.close(); svc.stop(); community.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
