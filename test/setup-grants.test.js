'use strict';
// Setup done by your agent (plan §AB.44): a one-time grant saves the key(s) of exactly one Setup row, once, within 30
// minutes, only for OpenVibe.Actor, only with the owner's fresh sign-in to make it; the id is shown once and only its hash
// kept; a value is never returned, logged or stored here.
const assert = require('assert');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createSetupGrants, TTL_MS, hashOf } = require('../server/admin/setup-grants');

(async () => {
    const db = getDb();
    const subject = 'usr_01JZ0000000000000000000SGA';
    await db.prepare("INSERT INTO users(username,password_hash,subject_id) VALUES ('GrantOwner','x',?)").run(subject);
    const owner = await db.prepare("SELECT id FROM users WHERE username = 'GrantOwner'").get();
    let clock = Date.parse('2026-11-14T16:40:00Z');
    let fresh = true;
    const saved = [];
    const logs = [];
    const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
    const proxy = { saveSecretAsOwner: async (req, row) => { saved.push({ owner: req.user.subject_id, ...row }); return row; } };
    const grants = createSetupGrants({ db, proxy, isFresh: () => fresh, now: () => clock, log });

    const app = express();
    app.use('/api/admin/setup/grants', (req, res, next) => { req.user = { id: owner.id, subject_id: subject }; next(); }, grants.ownerRouter());
    let caller = 'svc:actor';
    app.post('/internal/setup/grants/:id/save', (req, res, next) => { req.principal = { sub: caller }; next(); }, ...grants.internalHandler());
    const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null), text: '' }; };
    const VALUE = 'canary-provider-key-7f3a';
    try {
        // Making a grant: the owner's fresh sign-in, one row of one service, one to four keys.
        fresh = false;
        assert.strictEqual((await call('POST', '/api/admin/setup/grants', { service: 'ai', namespace: 'ai.providers', keys: ['deepseek.api_key'] })).status, 403, 'a stale sign-in makes no grant');
        fresh = true;
        assert.strictEqual((await call('POST', '/api/admin/setup/grants', { service: 'ai', namespace: 'billing.stripe', keys: ['x'] })).status, 400, 'the namespace must be the service\'s');
        assert.strictEqual((await call('POST', '/api/admin/setup/grants', { service: 'ai', namespace: 'ai.providers', keys: [] })).status, 400, 'at least one key');
        let r = await call('POST', '/api/admin/setup/grants', { service: 'ai', namespace: 'ai.providers', keys: ['deepseek.api_key'], provider: 'DeepSeek', get_it_at: 'https://platform.deepseek.com/api_keys' });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const g = r.body.grant;
        assert.ok(/^sgr_[A-Za-z0-9_-]{32}$/.test(g.id) && g.ref === hashOf(g.id).slice(0, 12), 'an id shown once, and its ref');
        assert.strictEqual(Date.parse(g.expires_at) - clock, TTL_MS, 'thirty minutes');
        const row = await db.prepare('SELECT * FROM setup_grants WHERE id_hash = ?').get(hashOf(g.id));
        assert.ok(row && !JSON.stringify(row).includes(g.id), 'only the hash is kept');
        r = await call('GET', '/api/admin/setup/grants');
        assert.deepStrictEqual(r.body.grants.map((x) => [x.ref, x.namespace]), [[g.ref, 'ai.providers']]);
        assert.ok(!JSON.stringify(r.body).includes(g.id), 'the list never shows an id');

        // Saving: Actor only, the grant's own key only, once.
        caller = 'svc:chat';
        assert.strictEqual((await call('POST', `/internal/setup/grants/${g.id}/save`, { values: { 'deepseek.api_key': VALUE } })).status, 403, 'only Actor saves');
        caller = 'svc:actor';
        r = await call('POST', `/internal/setup/grants/${g.id}/save`, { values: { 'openai.api_key': VALUE } });
        assert.strictEqual(r.status, 403, 'another key is refused');
        assert.strictEqual(saved.length, 0, 'and nothing was saved');
        r = await call('POST', `/internal/setup/grants/${g.id}/save`, { values: { 'deepseek.api_key': VALUE }, run: 'run_setup_1' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(r.body, { saved: true, service: 'ai', namespace: 'ai.providers', keys: [{ key: 'deepseek.api_key', hint: '…7f3a' }] }, 'the row and a hint, never the value');
        assert.deepStrictEqual(saved, [{ owner: subject, service: 'ai', namespace: 'ai.providers', key: 'deepseek.api_key', value: VALUE }], 'saved as the owner, through the proxy');
        assert.strictEqual((await call('POST', `/internal/setup/grants/${g.id}/save`, { values: { 'deepseek.api_key': VALUE } })).status, 410, 'a second save finds nothing');
        assert.strictEqual((await call('GET', '/api/admin/setup/grants')).body.grants.length, 0, 'a spent grant is no longer live');

        // Two saves at once: one wins.
        r = await call('POST', '/api/admin/setup/grants', { service: 'ai', namespace: 'ai.providers', keys: ['kimi.api_key'] });
        const race = await Promise.all([1, 2].map(() => call('POST', `/internal/setup/grants/${r.body.grant.id}/save`, { values: { 'kimi.api_key': VALUE } })));
        assert.deepStrictEqual(race.map((x) => x.status).sort(), [200, 410], 'one of two racing saves');

        // Expired and revoked grants save nothing.
        r = await call('POST', '/api/admin/setup/grants', { service: 'ai', namespace: 'ai.providers', keys: ['groq.api_key'] });
        const late = r.body.grant;
        clock += TTL_MS + 1;
        assert.strictEqual((await call('POST', `/internal/setup/grants/${late.id}/save`, { values: { 'groq.api_key': VALUE } })).status, 410, 'an expired grant');
        r = await call('POST', '/api/admin/setup/grants', { service: 'ai', namespace: 'ai.providers', keys: ['groq.api_key'] });
        const gone = r.body.grant;
        assert.strictEqual((await call('DELETE', `/api/admin/setup/grants/${gone.ref}`)).status, 200, 'revoked');
        assert.strictEqual((await call('POST', `/internal/setup/grants/${gone.id}/save`, { values: { 'groq.api_key': VALUE } })).status, 410, 'a revoked grant');
        assert.strictEqual((await call('POST', '/internal/setup/grants/sgr_nope/save', { values: { a: 'b' } })).status, 404, 'a made-up id');

        // "Let my agent do it": the grant starts Actor's task here, with the owner's Bearer; the answer carries the task,
        // never the grant id; a start that fails revokes the grant; a provider Actor cannot read is refused.
        const toActor = [];
        let actorUp = true;
        const startApp = express();
        const starting = createSetupGrants({ db, proxy, isFresh: () => true, now: () => clock, log, actorUrl: 'http://actor.test',
            fetchImpl: async (url, init) => { toActor.push({ url, init }); return actorUp ? new Response(JSON.stringify({ id: 'tsk_01JABCDEFGHJKMNPQRSTVWXYZ0' }), { status: 201 }) : new Response(JSON.stringify({ detail: 'no' }), { status: 503 }); } });
        startApp.use('/g', (req, res, next) => { req.user = { id: owner.id, subject_id: subject }; next(); }, starting.ownerRouter());
        const s2 = await new Promise((ok) => { const x = startApp.listen(0, '127.0.0.1', () => ok(x)); });
        const b2 = `http://127.0.0.1:${s2.address().port}`;
        const start = async (body, auth = 'Bearer owner-token') => { const x = await fetch(b2 + '/g', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) }); return { status: x.status, body: await x.json() }; };
        try {
            const row = { service: 'ai', namespace: 'ai.providers', keys: ['deepseek.api_key'], provider: 'deepseek', get_it_at: 'https://platform.deepseek.com/api_keys', start: true };
            let st = await start(row);
            assert.strictEqual(st.status, 201, JSON.stringify(st.body));
            assert.deepStrictEqual(st.body.grant.task, { id: 'tsk_01JABCDEFGHJKMNPQRSTVWXYZ0', url: 'https://openvibe.actor/chat/tsk_01JABCDEFGHJKMNPQRSTVWXYZ0' }, 'the agent\'s task');
            assert.ok(!('id' in st.body.grant) && !JSON.stringify(st.body).includes('sgr_'), 'the browser never holds the grant id');
            const sent = JSON.parse(toActor[0].init.body).setup;
            assert.ok(/^sgr_/.test(sent.grant) && toActor[0].url === 'http://actor.test/api/v1/tasks' && toActor[0].init.headers.Authorization === 'Bearer owner-token', 'Actor gets the id, with the owner\'s Bearer');
            assert.strictEqual((await start({ ...row, provider: 'mistral' })).status, 422, 'a provider Actor cannot read');
            assert.strictEqual((await start(row, null)).status, 409, 'no Bearer: no agent');
            actorUp = false;
            st = await start(row);
            assert.strictEqual(st.status, 502, 'Actor down');
            const last = JSON.parse(toActor[toActor.length - 1].init.body).setup.grant;
            assert.ok((await db.prepare('SELECT revoked_at FROM setup_grants WHERE id_hash = ?').get(hashOf(last))).revoked_at, 'a failed start revokes its grant');
        } finally { s2.close(); }

        // The agent's screen beside the step (AB.44): its task and desk picture, read from Actor with the owner's
        // Bearer, on paths built here; a bad id never reaches Actor and Actor's own picture address is not followed.
        const TASK = 'tsk_01JABCDEFGHJKMNPQRSTVWXYZ0';
        const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
        const seen = [];
        const watching = createSetupGrants({ db, proxy, isFresh: () => true, now: () => clock, log, actorUrl: 'http://actor.test',
            fetchImpl: async (url, init) => {
                seen.push({ url, auth: init.headers.Authorization });
                if (url.endsWith('/desks')) return new Response(JSON.stringify({ desks: [{ where: 'run', desk: 'd1', kind: 'desktop', driving: true, still: 'https://evil.example/x.png' }] }), { status: 200 });
                if (url.endsWith('/still')) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
                if (url === `http://actor.test/api/v1/tasks/${TASK}`) return new Response(JSON.stringify({ id: TASK, state: 'running', finished_at: null, needs_you: { what: 'Sign in to DeepSeek', url: 'https://platform.deepseek.com' } }), { status: 200 });
                return new Response('{}', { status: 404 });
            } });
        const watchApp = express();
        watchApp.use('/g', (req, res, next) => { req.user = { id: owner.id, subject_id: subject }; next(); }, watching.ownerRouter());
        const s3 = await new Promise((ok) => { const x = watchApp.listen(0, '127.0.0.1', () => ok(x)); });
        const b3 = `http://127.0.0.1:${s3.address().port}`;
        const look = (path, auth = 'Bearer owner-token') => fetch(b3 + path, { headers: auth ? { authorization: auth } : {} });
        try {
            let r = await look(`/g/agent/${TASK}`);
            const view = (await r.json()).agent;
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(view, { state: 'running', ended: false, error: null, needs_you: { what: 'Sign in to DeepSeek' },
                desk: { where: 'run', kind: 'desktop', driving: true }, page: `https://openvibe.actor/chat/${TASK}` }, 'what the overlay shows, and nothing more');
            r = await look(`/g/agent/${TASK}/still`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('content-type'), 'image/png');
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            assert.ok(Buffer.from(await r.arrayBuffer()).equals(PNG), 'the desk picture');
            assert.ok(seen.every((x) => x.url.startsWith('http://actor.test/api/v1/tasks/') && x.auth === 'Bearer owner-token'), 'only Actor, with the owner\'s Bearer');
            assert.ok(seen.some((x) => x.url === `http://actor.test/api/v1/tasks/${TASK}/still`) && !seen.some((x) => x.url.includes('evil')), 'the picture path is built here, never taken from the answer');
            const before = seen.length;
            assert.strictEqual((await look('/g/agent/tsk_..%2F..%2Fadmin')).status, 404, 'a bad task id');
            assert.strictEqual((await look('/g/agent/not-a-task/still')).status, 404);
            assert.strictEqual(seen.length, before, 'and Actor is never asked');
            assert.strictEqual((await look(`/g/agent/${TASK}`, null)).status, 409, 'no Bearer: nothing to watch');
            assert.strictEqual((await look(`/g/agent/tsk_01JABCDEFGHJKMNPQRSTVWXYZ1`)).status, 404, 'a task Actor does not know (or not theirs)');
        } finally { s3.close(); }

        assert.ok(!logs.some((m) => m.includes(VALUE)), 'a value is never logged');
        assert.ok(!JSON.stringify(await db.prepare('SELECT * FROM setup_grants').all()).includes(VALUE), 'nor stored here');
        console.log('setup grants: fresh-made, one row, Actor only, once, expiring, revocable, values never back');
    } finally { server.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
