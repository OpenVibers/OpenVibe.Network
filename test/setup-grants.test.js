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

        assert.ok(!logs.some((m) => m.includes(VALUE)), 'a value is never logged');
        assert.ok(!JSON.stringify(await db.prepare('SELECT * FROM setup_grants').all()).includes(VALUE), 'nor stored here');
        console.log('setup grants: fresh-made, one row, Actor only, once, expiring, revocable, values never back');
    } finally { server.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
