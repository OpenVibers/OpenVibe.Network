'use strict';
/**
 * GET /api/frame/usage (server/frame/usage.js; 2026-11-17, the owner: "display usage stats and tokens and all that for
 * each harness or API balances or cost"): what the person's answers used, read as them from Actor's /api/v1/me/usage and
 * passed on with numbers and names only. Signed out: 401; a bad ?days=: 400; Actor down: 502, nothing made up.
 *   node test/frame-usage.test.js
 */
const assert = require('assert');
const { createUsage } = require('../server/frame/usage');

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AUTH = 'Bearer tok_abcdefghijklmnopqrstuvwxyz';

(async () => {
    const asked = [];
    let actor = 'up';
    const fetchImpl = async (url, init) => {
        const u = new URL(url);
        asked.push([u.host, u.pathname, u.searchParams.get('days'), init.headers.Authorization]);
        if (actor === 'down') throw new Error('ECONNREFUSED');
        if (actor === 'denied') return reply(403, {});
        return reply(200, {
            days: 30, since: '2026-10-19', requester: 'user:usr_secret',
            today: { usd: 0.0905, tokens: 68278, tasks: 2, by: { allowance: { usd: 0.0095, tokens: 53278, tasks: 1 }, key: { usd: 0.081, tokens: 15000, tasks: 1 }, bogus: { usd: 9 } } },
            period: { usd: 0.5, tokens: 77278, tasks: 4, by: { machine: { usd: 0, tokens: 9000, tasks: 1 } } },
            models: [{ id: 'deepseek-flash', usd: 0.0095, tokens: 53278, tasks: 1 }, { id: 'claude-sonnet-5-5', provider: 'anthropic', usd: 0.081, tokens: 15000, tasks: 1 }, { id: '<script>', tokens: 1 }],
            limit: { per_day_usd: 1, tasks_per_day: 50 },
        });
    };
    const svcUrl = (name, fallback) => ({ actor: 'http://actor.test' }[name] || fallback);
    const u = createUsage({ svcUrl, fetchImpl, log: { warn() {} } });

    assert.strictEqual((await u.get({ auth: '' })).status, 401, 'signed out');
    assert.strictEqual((await u.get({ auth: AUTH, days: '99' })).status, 400, 'days is 1 to 30');
    assert.strictEqual(asked.length, 0, 'neither asks Actor');

    const got = await u.get({ auth: AUTH, days: '7' });
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual(asked[0], ['actor.test', '/api/v1/me/usage', '7', AUTH], 'Actor, as the person');
    assert.deepStrictEqual(got.body.today, { usd: 0.0905, tokens: 68278, tasks: 2, by: { allowance: { usd: 0.0095, tokens: 53278, tasks: 1 }, key: { usd: 0.081, tokens: 15000, tasks: 1 } } }, 'only the known ways of paying');
    assert.deepStrictEqual(got.body.period.by, { machine: { usd: 0, tokens: 9000, tasks: 1 } });
    assert.deepStrictEqual(got.body.models.map((m) => [m.id, m.provider]), [['deepseek-flash', null], ['claude-sonnet-5-5', 'anthropic']], 'a model id that is not one is dropped');
    assert.deepStrictEqual(got.body.limit, { per_day_usd: 1, tasks_per_day: 50 });
    assert.ok(!JSON.stringify(got.body).includes('usr_secret'), 'no requester passes');

    actor = 'denied';
    assert.strictEqual((await u.get({ auth: AUTH })).status, 403, 'Actor\'s refusal is the answer');
    actor = 'down';
    const down = await u.get({ auth: AUTH });
    assert.strictEqual(down.status, 502);
    assert.match(down.body.error, /did not answer/);
    console.log('frame-usage: what you used, from Actor as you, numbers and names only; 401, 400, 403 and 502 as they are');
})().catch((err) => { console.error(err); process.exit(1); });
