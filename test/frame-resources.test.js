'use strict';
/**
 * GET /api/frame/resources (server/frame/resources.js; plan §AD.17): everything an answer can run on, for the person, in
 * one read. Signed out: 401. Signed in: OpenVibe.AI's free allowance today, the person's own keys (a provider, a state
 * and a time: never a key, a hint or an account), which services may use them, and Billing's Balance; all read with the
 * person's own token; a service that does not answer leaves its part empty and is named in `partial`.
 *   node test/frame-resources.test.js
 */
const assert = require('assert');
const { createResources } = require('../server/frame/resources');

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AUTH = 'Bearer tok_abcdefghijklmnopqrstuvwxyz';

(async () => {
    let billingUp = true;
    const asked = [];
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        asked.push([u.host, u.pathname, init.headers.Authorization]);
        if (u.pathname === '/api/v1/me/allowance') return reply(200, { allowance: { tier: 'standard', unlimited: false, tokens: 50000, used: 12000, left: 38000, resets_at: '2026-11-18T00:00:00.000Z' } });
        if (u.pathname === '/api/v1/me/credentials') return reply(200, { credentials: [
            { provider: 'anthropic', status: 'ok', checked_at: '2026-11-17T03:00:00Z', hint: 'sk-…AbCd', key: 'sk-secret-should-never-pass', label: 'my work account' },
            { id: 'openrouter', status: 'failed' }, { provider: 'Bad Provider!' },
        ] });
        if (u.pathname === '/api/v1/me/key-apps') return reply(200, { apps: [{ subject: 'usr_x', service: 'actor', provider: 'anthropic' }, { service: 'actor', provider: '<x>' }, { service: 'codes', provider: '*' }, { service: 'actor', provider: 'openrouter' }] });
        if (u.pathname === '/api/v1/me/wallet') return billingUp ? reply(200, { balances: { balance: { amount: '1234', scale: 2, currency: 'USD', purpose: 'For the AI API, the Exchange and pro products' } } }) : reply(503, {});
        return reply(404, {});
    };
    const svcUrl = (name, fallback) => ({ ai: 'http://ai.test', billing: 'http://billing.test' }[name] || fallback);
    let pcsUp = true;
    const computers = async (subject) => {
        if (!pcsUp) throw new Error('Bot did not answer');
        assert.strictEqual(subject, 'usr_me', 'the person\'s own computers');
        return [{ kind: 'machine', id: 'dev_tower', name: 'Tower', online: true }, { kind: 'machine', id: 'dev_old', name: 'Old', online: false, disabled: true }];
    };
    const r = createResources({ svcUrl, fetchImpl, computers, log: { warn() {} } });

    const out = await r.get({ auth: '' });
    assert.strictEqual(out.status, 401, 'signed out');

    const got = await r.get({ auth: AUTH, subject: 'usr_me' });
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual(got.body.allowance, { tier: 'standard', unlimited: false, tokens: 50000, used: 12000, left: 38000, resets_at: '2026-11-18T00:00:00.000Z' });
    assert.deepStrictEqual(got.body.keys, [{ provider: 'anthropic', status: 'ok', checked_at: '2026-11-17T03:00:00Z' }, { provider: 'openrouter', status: 'failed', checked_at: null }], 'names and states only');
    assert.ok(!JSON.stringify(got.body).includes('secret') && !JSON.stringify(got.body).includes('AbCd') && !JSON.stringify(got.body).includes('work account'), 'no key, hint or account name');
    assert.deepStrictEqual(got.body.key_apps, [{ service: 'actor', providers: ['anthropic', 'openrouter'] }, { service: 'codes', providers: ['*'] }], 'one row per service, as AI\'s rows group');
    assert.deepStrictEqual(got.body.balance, { amount: '1234', scale: 2, currency: 'USD', purpose: 'For the AI API, the Exchange and pro products' });
    assert.deepStrictEqual(got.body.partial, []);
    // The road, in the one order (openvibe-sdk/agents/roads): 38,000 left covers an agent turn, so the free AI takes it.
    assert.deepStrictEqual([got.body.road.agent.road, got.body.road.agent.need, got.body.road.chat.road], ['free', 12000, 'free']);
    assert.match(got.body.road.agent.say, /free AI answers \(38k tokens left today\)/);
    assert.ok(asked.every(([, , a]) => a === AUTH), 'every read as the person');
    assert.deepStrictEqual([...new Set(asked.map(([h]) => h))].sort(), ['ai.test', 'billing.test']);

    // Less left than an agent turn takes: the key AI lets Actor use (anthropic, ok; openrouter failed), then the computer.
    const lowFetch = async (url, init) => (new URL(url).pathname === '/api/v1/me/allowance'
        ? reply(200, { allowance: { tier: 'standard', unlimited: false, tokens: 50000, used: 46000, left: 4000, resets_at: '2026-11-18T00:00:00.000Z' } }) : fetchImpl(url, init));
    const low = await createResources({ svcUrl, fetchImpl: lowFetch, computers, log: { warn() {} } }).get({ auth: AUTH, subject: 'usr_me' });
    assert.deepStrictEqual([low.body.road.agent.road, low.body.road.agent.provider], ['key', 'anthropic']);
    assert.deepStrictEqual(low.body.road.agent.ladder.map((s) => [s.road, s.open]), [['choice', false], ['free', false], ['key', true]]);
    assert.strictEqual(low.body.road.chat.road, 'free', 'Chat\'s one model answers with anything left');
    const noKeyFetch = async (url, init) => (new URL(url).pathname === '/api/v1/me/key-apps' ? reply(200, { apps: [] }) : lowFetch(url, init));
    const pc = await createResources({ svcUrl, fetchImpl: noKeyFetch, computers, log: { warn() {} } }).get({ auth: AUTH, subject: 'usr_me' });
    assert.deepStrictEqual([pc.body.road.agent.road, pc.body.road.agent.machine], ['computer', { id: 'dev_tower', name: 'Tower' }], 'the online one, not the offline one');
    pcsUp = false;
    const none = await createResources({ svcUrl, fetchImpl: noKeyFetch, computers, log: { warn() {} } }).get({ auth: AUTH, subject: 'usr_me' });
    assert.deepStrictEqual([none.body.road.agent.road, none.body.road.agent.chat_only, none.body.partial], ['none', true, ['computers']]);
    pcsUp = true;

    billingUp = false;
    const part = await r.get({ auth: AUTH });
    assert.strictEqual(part.body.balance, null);
    assert.deepStrictEqual(part.body.partial, ['billing'], 'the part that did not answer is named');
    assert.ok(part.body.allowance, 'the rest stands');
    console.log('frame-resources: one read of your AI (allowance, keys by name, who may use them, Balance), as you, nothing secret');
})().catch((err) => { console.error(err); process.exit(1); });
