'use strict';
// The Action Center (server/actions, capability network.actions.read): GET /api/v1/me/actions merges the person's pending
// confirmations with Actor's, Codes' and AI's items into five buckets (network.me-actions-result@1), with Network's own
// token per service and the person's subject; a slow, missing or not-yet-deployed service is named in `sources`, never
// fails the answer; an invalid item or one claiming another service is dropped; the answer is cached per person and
// dropped when they act; approve/decline go to Network's confirmations or to Actor's decide route.
//   node --import ./test/helpers/pg-preload.mjs test/me-actions.test.js
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const actionsMod = require('../server/actions');
const { signToken } = require('../server/auth/routes');

const T0 = Date.parse('2026-10-28T15:00:00Z');
const iso = (min) => new Date(T0 - min * 60000).toISOString();
const item = (over) => ({
    service: 'actor', id: 'tsk_1', kind: 'agent_task', title: 'Find three cheap flights', summary: 'Read 4 pages', bucket: 'running', state: 'running',
    agent: 'deepseek-flash', cost_usd: 0.004, steps: 6, error: null, created_at: iso(10), updated_at: iso(2), next_run_at: null,
    href: 'https://openvibe.actor/tasks/tsk_1', actions: ['open', 'cancel'], ...over,
});

(async () => {
const db = getDb();
const log = console.log; console.log = () => {};
await db.prepare("INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (51, 'acto', 'acto@example.test', 'x', 1)").run();

// Fake Actor (two items, one invalid, one claiming to be Codes) and AI (slow); Codes is not deployed (404).
const calls = [];
let aiDelay = 0;
const svc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        calls.push({ method: req.method, path: u.pathname, subject: u.searchParams.get('subject') || req.headers['x-ov-subject'] || null, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (u.pathname === '/actor/api/v1/actions') return json(200, { items: [
            item(),
            item({ id: 'apr_1', kind: 'approval', title: 'Spend $0.40 on a desk hour', bucket: 'waiting', state: 'pending', actions: ['approve', 'decline', 'open'], updated_at: iso(5), href: 'https://openvibe.actor/me/approvals' }),
            item({ id: 'tsk_bad', href: 'http://openvibe.actor/tasks/x' }),
            item({ id: 'tsk_spoof', service: 'codes' }),
            item({ id: 'agt_1', bucket: 'scheduled', state: 'scheduled', next_run_at: new Date(T0 + 3600000).toISOString(), actions: ['open'] }),
            item({ id: 'tsk_old', bucket: 'failed', state: 'failed', error: 'The page asked for a login', actions: ['open'], updated_at: iso(300) }),
        ] });
        if (u.pathname === '/ai/api/v1/actions') return setTimeout(() => json(200, { items: [item({ service: 'ai', id: 'run_1', kind: 'ai_run', bucket: 'done', state: 'succeeded', href: 'https://ai.openvibe.services/runs/run_1', actions: ['open'] })] }), aiDelay);
        if (u.pathname === '/actor/api/v1/approvals/apr_1/decide') return json(200, item({ id: 'apr_1', kind: 'approval', bucket: 'done', state: 'approved', actions: ['open'] }));
        if (u.pathname === '/actor/api/v1/approvals/apr_404/decide') return json(404, { code: 'not_found' });
        if (u.pathname === '/domains/api/v1/actions') return json(200, { items: [item({ service: 'domains', id: 'dpr_1', kind: 'approval', title: 'Add a TXT record to example.com', bucket: 'waiting', state: 'pending', actions: ['approve', 'decline', 'open'], updated_at: iso(20), href: 'https://openvibe.domains/panel/p/dpr_1' })] });
        if (u.pathname === '/domains/api/v1/proposals/dpr_1/decide') return json(200, item({ service: 'domains', id: 'dpr_1', kind: 'approval', bucket: 'done', state: 'applied', actions: ['open'], href: 'https://openvibe.domains/panel/p/dpr_1' }));
        if (u.pathname === '/domains/api/v1/proposals/dpr_2/decide') return json(409, { code: 'proposal.decided', detail: 'This proposal is applied already.' });
        json(404, { code: 'not_found' });
    });
});
await new Promise((r) => svc.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${svc.address().port}`;
const decided = [];
const fakeConfirmations = {
    list: async () => ({
        confirmations: [{ id: 'cnf_01JAB2C3D4E5F6G7H8J9K0MNPQ', owner: { type: 'user', id: 'x' }, requested_by: { type: 'agent', id: 'agt_x' }, capability: 'mail.send', summary: 'Send one email to the venue', state: 'pending', created_at: iso(1), expires_at: iso(-15) }],
        agents: { agt_x: { id: 'agt_x', name: 'Trip planner' } },
    }),
    decide: async (_db, actor, id, action) => { decided.push([actor.subject, id, action]); return { confirmation: { id, capability: 'mail.send', summary: 'Send one email to the venue', state: action === 'approve' ? 'approved' : 'denied', created_at: iso(1) } }; },
};
let clock = T0;
const actions = actionsMod.createActions({
    db, urls: { actor: `${base}/actor`, codes: `${base}/codes`, ai: `${base}/ai`, domains: `${base}/domains` }, timeoutMs: 150, now: () => clock,
    selfToken: (aud, caps) => `tok:${aud}:${caps.join(',')}`, confirmationsImpl: fakeConfirmations, log: { warn() {} },
});

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const user = await db.prepare('SELECT * FROM users WHERE id = 51').get();
const token = signToken(user, keys.privateKey, config);
const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/api/v1/me/actions', actionsMod.router({ actions, requireAuth }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${server.address().port}/api/v1/me/actions`;
const call = (method, path = '', auth = true) => fetch(api + path, { method, headers: auth ? { authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
    assert.strictEqual((await call('GET', '', false)).status, 401, 'a session is needed');

    aiDelay = 400;   // AI is slower than the 150 ms budget
    let r = await call('GET');
    assert.strictEqual(r.status, 200);
    const doc = r.body;
    assert.ok(validate('network.me-actions-result@1', doc).valid, JSON.stringify(validate('network.me-actions-result@1', doc).errors));
    assert.deepStrictEqual(doc.sources, { network: 'ok', actor: 'ok', codes: 'not_connected', ai: 'timeout', domains: 'ok' });
    assert.strictEqual(doc.partial, true, 'a timeout makes the answer partial');
    assert.deepStrictEqual(doc.counts, { running: 1, waiting: 3, scheduled: 1, done: 0, failed: 1 });
    assert.deepStrictEqual(doc.buckets.waiting.map((x) => x.id), ['cnf_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'apr_1', 'dpr_1'], 'newest first');
    const cnf = doc.buckets.waiting[0];
    assert.deepStrictEqual([cnf.service, cnf.kind, cnf.title, cnf.summary, cnf.href, cnf.actions], ['network', 'approval', 'Send one email to the venue', 'Trip planner asks to use mail.send', 'https://openvibe.network/my#approvals', ['approve', 'decline', 'open']]);
    const all = Object.values(doc.buckets).flat().map((x) => x.id);
    assert.ok(!all.includes('tsk_bad'), 'an item that is not common.action-item@1 is dropped');
    assert.ok(!all.includes('tsk_spoof'), 'an item claiming another service is dropped');
    const ask = calls.find((c) => c.path === '/actor/api/v1/actions');
    assert.deepStrictEqual([ask.auth, ask.subject && ask.subject.startsWith('usr_')], ['Bearer tok:openvibe.actor:actor.actions.read', true], 'Network\'s own token, the person\'s subject');
    assert.strictEqual(calls.find((c) => c.path === '/ai/api/v1/actions').auth, 'Bearer tok:openvibe.ai:ai.actions.read');

    // Cached for ten seconds: no second round of calls.
    const n = calls.length;
    await call('GET');
    assert.strictEqual(calls.length, n, 'cached');
    clock += actionsMod.CACHE_MS + 1;
    aiDelay = 0;
    r = await call('GET');
    assert.ok(calls.length > n, 'read again after the cache');
    assert.deepStrictEqual([r.body.sources.ai, r.body.partial, r.body.counts.done], ['ok', false, 1]);

    // Acting: a Network confirmation through confirmations.decide, an Actor approval through Actor, others refused.
    r = await call('POST', '/network/cnf_01JAB2C3D4E5F6G7H8J9K0MNPQ/approve');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.item.state, r.body.item.bucket], ['approved', 'done']);
    assert.strictEqual(decided[0][2], 'approve');
    const before = calls.length;
    await call('GET');
    assert.ok(calls.length > before, 'acting drops the cached answer');
    r = await call('POST', '/actor/apr_1/decline');
    assert.strictEqual(r.status, 200);
    const d = calls.find((c) => c.path === '/actor/api/v1/approvals/apr_1/decide');
    assert.deepStrictEqual([d.method, d.auth, d.body.decision, d.subject.startsWith('usr_')], ['POST', 'Bearer tok:openvibe.actor:actor.approval.decide', 'decline', true]);
    assert.strictEqual((await call('POST', '/actor/apr_404/approve')).status, 404);
    // A Domains proposal is approved through Domains' decide route, with domains.proposal.decide, for this person.
    r = await call('POST', '/domains/dpr_1/approve');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const dd = calls.find((c) => c.path === '/domains/api/v1/proposals/dpr_1/decide');
    assert.deepStrictEqual([dd.method, dd.auth, dd.body.decision, dd.subject.startsWith('usr_')], ['POST', 'Bearer tok:openvibe.domains:domains.proposal.decide', 'approve', true]);
    assert.strictEqual((await call('POST', '/domains/dpr_2/approve')).status, 409, 'decided already, in words');
    assert.deepStrictEqual([(await call('POST', '/codes/tsk_1/approve')).body.code, (await call('POST', '/actor/tsk_1/cancel')).body.code], ['actions.unsupported', 'actions.unsupported']);
    assert.strictEqual((await call('POST', '/actor/..%2Fx/approve')).status, 404, 'ids are plain');
} finally {
    server.close(); svc.close();
    console.log = log;
}
console.log('me-actions: ok');
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
