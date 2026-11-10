'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const { parseHTML } = require('linkedom');
const { createServiceProxies } = require('../server/admin/service-proxies');
(async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
        let body = ''; req.on('data', d => { body += d; });
        req.on('end', () => { seen.push({ path: req.url, auth: req.headers.authorization, origin: req.headers.origin, method: req.method, body }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true })); });
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const app = express(); app.use(express.json());
    app.locals.config = { baseUrl: 'https://openvibe.network' }; app.locals.privateKey = 'fixture';
    const requireAuth = (req, res, next) => { if (!req.headers['x-test-user']) return res.sendStatus(401); req.user = { id: 'test', username: req.headers['x-test-user'], role: 'admin' }; req.token = 'original-fixture'; next(); };
    app.use('/api/admin', createServiceProxies({ requireAuth, signToken: () => 'reminted-fixture', services: { tools: { internalUrl: `http://127.0.0.1:${upstream.address().port}` } } }));
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/admin/tools-workers`;
    const id = 'wrk_' + '1'.repeat(24);
    const owner = process.env.OWNER_USERNAME || 'goosely';
    async function call(p, method = 'GET', who = owner, origin = 'https://openvibe.network') {
        return fetch(base + p, { method, headers: { 'x-test-user': who, origin, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify({ draining: true }) });
    }
    try {
        assert.equal((await call('/fleet', 'GET', 'other-admin')).status, 403);
        assert.equal((await call('/workers', 'POST', owner, 'https://elsewhere.example')).status, 403);
        assert.equal(seen.length, 0);
        const response = await call('/fleet'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(seen[0], { path: '/api/v1/owner/workers', method: 'GET', body: '', auth: 'Bearer reminted-fixture', origin: 'https://openvibe.tools' });
        assert.equal((await call(`/workers/${id}/drain`, 'PUT')).status, 200);
        assert.equal(seen.at(-1).path, `/api/v1/owner/workers/${id}/drain`);
        assert.equal((await call('/workers/not-a-worker/drain', 'PUT')).status, 400);
        assert.equal((await call('/workers/anything/extra', 'POST')).status, 404);
        assert.equal((await call('/routing', 'PUT')).status, 200);
        assert.equal(seen.at(-1).path, '/api/v1/owner/worker-routing');
        const { document } = parseHTML('<html><body><div id="settings-tools"></div></body></html>');
        const calls = [];
        const fleet = { day: '2026-11-10', routing: { enabled: false, order: ['home', 'host'] }, workers: [{ id, label: '<img src=x onerror=bad>', location: 'home', online: true, revoked: false, draining: false, slots: 2, free: 1, active_jobs: 1, jobs_today: 7, load: 0.2 }] };
        const context = vm.createContext({ document, currentUser: { is_owner: true }, esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
            FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.querySelector(`[name="${name}"]`).value; } },
            api: async (p, options) => { calls.push({ p, options }); return p.endsWith('/fleet') ? fleet : p.endsWith('/workers') ? { id, token: 'one-time-fixture' } : {}; },
        });
        vm.runInContext(fs.readFileSync('public/js/admin/tools-workers.js', 'utf8'), context);
        await context.loadToolsWorkers();
        assert.equal(document.querySelector('img'), null, 'worker labels are escaped');
        assert.match(document.querySelector('#tools-workers-panel').textContent, /Jobs today/);
        await document.querySelector('[data-worker-drain]').onclick();
        assert.equal(calls.find(c => c.p.endsWith('/drain')).options.body.draining, true);
        const form = document.querySelector('#tools-workers-create'); form.reset = () => {};
        form.querySelector('[name="label"]').value = 'Tower';
        await form.onsubmit({ preventDefault() {}, target: form });
        assert.match(document.querySelector('#tools-workers-token').textContent, /one-time-fixture/);
        document.querySelector('#tools-workers-clear').onclick();
        assert.equal(document.querySelector('#tools-workers-token').textContent, '');
        const count = calls.length; context.currentUser.is_owner = false;
        await context.loadToolsWorkers(); assert.equal(calls.length, count, 'nonowners do not request fleet data');
        console.log('Tools console: owner/origin gates, fixed proxy paths, reminted auth, no-store, fleet rendering, escaping, drain and one-time credential clear passed');
    } finally { await new Promise(r => server.close(r)); await new Promise(r => upstream.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
