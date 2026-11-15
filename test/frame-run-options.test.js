'use strict';
/**
 * GET /api/frame/run-options (server/frame/run-options.js; Shared 4.259.0's run line): who does a run and where.
 *   • signed out: the short lists, kept a minute;
 *   • signed in: your Actor by its own name ("My Actor" and "Vibe" read Actor), Codes, then Codes' harnesses with
 *     their makers (OpenVibe.AI left out: it is not a coding harness), kept five minutes;
 *   • places: Auto, OpenVibe, then your computers, online and able first; an offline one, or one that runs nothing,
 *     is listed and cannot be picked, with why; a product that does not answer leaves its part short.
 *   node test/frame-run-options.test.js
 */
const assert = require('assert');
const { createRunOptions } = require('../server/frame/run-options');

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
(async () => {
    let harnessCalls = 0, actorName = 'My Actor', codesUp = true;
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        if (u.pathname === '/api/v1/harnesses') {
            harnessCalls++;
            if (!codesUp) throw new Error('down');
            return reply(200, { harnesses: [{ id: 'claude-code', name: 'Claude Code', provider: 'Anthropic' }, { id: 'openvibe-ai', name: 'OpenVibe.AI' }, { id: 'codex', name: 'Codex', provider: 'OpenAI' }, { id: '../x', name: 'bad' }] });
        }
        if (u.pathname === '/api/v1/me/actor') { assert.strictEqual(init.headers.Authorization, 'Bearer tok_abcdefghijklmnopqrstuvwxyz'); return reply(200, { name: actorName }); }
        return reply(404, {});
    };
    const bot = { list: async (subject) => {
        assert.strictEqual(subject, 'usr_1');
        return { machines: [
            { id: 'dev_01K9R2V6M8Q4T0B7C3D5E9F2GA', name: 'Old laptop', online: false, roles: ['codes.worker'] },
            { id: 'dev_01K9R2V6M8Q4T0B7C3D5E9F2GB', name: 'Studio PC', online: true, roles: ['codes.worker', 'ai.host'], specs_words: '16 cores, 64 GB, RTX 4090, Linux' },
            { id: 'dev_01K9R2V6M8Q4T0B7C3D5E9F2GC', name: 'Pi', online: true, roles: [] },
            { id: 'not-a-device', name: 'x', online: true, roles: ['codes.worker'] },
        ] };
    } };
    let t = 0;
    const opts = createRunOptions({ svcUrl: (n, f) => f, fetchImpl, bot, now: () => t, log: { warn() {} } });

    // Signed out: the short lists, cacheable.
    let got = await opts.get({});
    assert.strictEqual(got.cache, true);
    assert.deepStrictEqual(got.body.agents.map((a) => a.id), ['auto', 'actor', 'codes']);
    assert.deepStrictEqual(got.body.places.map((p) => p.kind), ['auto', 'openvibe']);

    // Signed in: your Actor by name, Codes, its harnesses; your computers.
    got = await opts.get({ auth: 'Bearer tok_abcdefghijklmnopqrstuvwxyz', subject: 'usr_1' });
    assert.strictEqual(got.cache, false);
    assert.deepStrictEqual(got.body.agents.map((a) => [a.id, a.name]), [['auto', 'Auto'], ['actor', 'Actor'], ['codes', 'Codes'], ['claude-code', 'Claude Code'], ['codex', 'Codex']], '"My Actor" reads Actor; OpenVibe.AI and a bad id are left out');
    assert.match(got.body.agents[3].line, /Anthropic/);
    const places = got.body.places;
    assert.deepStrictEqual(places.map((p) => [p.kind, p.id || null, !!p.disabled]), [
        ['auto', null, false], ['openvibe', null, false],
        ['machine', 'dev_01K9R2V6M8Q4T0B7C3D5E9F2GB', false],
        ['machine', 'dev_01K9R2V6M8Q4T0B7C3D5E9F2GA', true],
        ['machine', 'dev_01K9R2V6M8Q4T0B7C3D5E9F2GC', true],
    ], 'your computers: the able one first, offline and idle ones listed but not pickable');
    assert.match(places[2].line, /RTX 4090/);
    assert.match(places[3].line, /offline/);
    assert.match(places[4].line, /openvibe\.link\/machines/);

    // A named Actor keeps its name; the harness list is kept five minutes.
    actorName = 'Juniper';
    got = await opts.get({ auth: 'Bearer tok_abcdefghijklmnopqrstuvwxyz', subject: 'usr_1' });
    assert.strictEqual(got.body.agents[1].name, 'Juniper');
    assert.strictEqual(harnessCalls, 1, 'Codes asked once in five minutes');
    // Codes down after the window: its part is short, the lists still answer.
    t += 6 * 60_000; codesUp = false;
    const fresh = createRunOptions({ svcUrl: (n, f) => f, fetchImpl, bot: { list: async () => { throw new Error('Bot down'); } }, now: () => t, log: { warn() {} } });
    got = await fresh.get({ auth: 'Bearer tok_abcdefghijklmnopqrstuvwxyz', subject: 'usr_1' });
    assert.deepStrictEqual(got.body.agents.map((a) => a.id), ['auto', 'actor', 'codes']);
    assert.deepStrictEqual(got.body.places.map((p) => p.kind), ['auto', 'openvibe']);

    // The route is mounted beside /choices.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'frame', 'service.js'), 'utf8');
    assert.match(src, /router\.get\('\/run-options'/);
    console.log('frame-run-options: short lists signed out; your Actor, Codes and its harnesses; your computers, able first; short parts when a product is down');
})().catch((e) => { console.error(e); process.exit(1); });
