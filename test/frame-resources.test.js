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
    const r = createResources({ svcUrl, fetchImpl, log: { warn() {} } });

    const out = await r.get({ auth: '' });
    assert.strictEqual(out.status, 401, 'signed out');

    const got = await r.get({ auth: AUTH });
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual(got.body.allowance, { tier: 'standard', unlimited: false, tokens: 50000, used: 12000, left: 38000, resets_at: '2026-11-18T00:00:00.000Z' });
    assert.deepStrictEqual(got.body.keys, [{ provider: 'anthropic', status: 'ok', checked_at: '2026-11-17T03:00:00Z' }, { provider: 'openrouter', status: 'failed', checked_at: null }], 'names and states only');
    assert.ok(!JSON.stringify(got.body).includes('secret') && !JSON.stringify(got.body).includes('AbCd') && !JSON.stringify(got.body).includes('work account'), 'no key, hint or account name');
    assert.deepStrictEqual(got.body.key_apps, [{ service: 'actor', providers: ['anthropic', 'openrouter'] }, { service: 'codes', providers: ['*'] }], 'one row per service, as AI\'s rows group');
    assert.deepStrictEqual(got.body.balance, { amount: '1234', scale: 2, currency: 'USD', purpose: 'For the AI API, the Exchange and pro products' });
    assert.deepStrictEqual(got.body.partial, []);
    assert.ok(asked.every(([, , a]) => a === AUTH), 'every read as the person');
    assert.deepStrictEqual([...new Set(asked.map(([h]) => h))].sort(), ['ai.test', 'billing.test']);

    billingUp = false;
    const part = await r.get({ auth: AUTH });
    assert.strictEqual(part.body.balance, null);
    assert.deepStrictEqual(part.body.partial, ['billing'], 'the part that did not answer is named');
    assert.ok(part.body.allowance, 'the rest stands');
    console.log('frame-resources: one read of your AI (allowance, keys by name, who may use them, Balance), as you, nothing secret');
})().catch((err) => { console.error(err); process.exit(1); });
