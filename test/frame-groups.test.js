'use strict';
/**
 * Group conversations (server/frame/groups.js; plan §AD.19): admins start a group of people and agents; any member reads
 * and says; who answers follows openvibe-sdk/agents/group; each agent's turn runs through the Frame's runs API with the
 * bearer of the person whose message started the round, one run per agent and person, told what the others said; the
 * shared space lists every file; strangers see nothing.
 *   node test/frame-groups.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb, initDb } = require('../server/db/database');
const { createFrameGroups, agentOf, startBody } = require('../server/frame/groups');
const { createFrameRuns } = require('../server/frame/runs');

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };

(async () => {
    const db = await getDb();
    await initDb();
    const mk = async (username, role) => {
        await db.prepare(`INSERT INTO users (username, display_name, email, password_hash, subject_id, role) VALUES (?, ?, ?, 'x', ?, ?)`)
            .run(username, username[0].toUpperCase() + username.slice(1), `${username}@example.test`, `usr_${username.toUpperCase().padEnd(26, '0').slice(0, 26)}`, role);
        return { username, display_name: username[0].toUpperCase() + username.slice(1), subject_id: `usr_${username.toUpperCase().padEnd(26, '0').slice(0, 26)}`, role };
    };
    const ada = await mk('gada', 'admin'), bo = await mk('gbo', 'user'), cy = await mk('gcy', 'user');
    const people = { 'Bearer tok-ada-0123456789': ada, 'Bearer tok-bo-0123456789x': bo, 'Bearer tok-cy-0123456789x': cy };

    // The Frame's runs API, as Actor and Codes would answer through it.
    const runs = new Map();
    const calls = [];
    const fake = express();
    fake.use(express.json());
    fake.post('/api/frame/runs', (req, res) => {
        const id = `r${runs.size + 1}`;
        const product = req.body.kind === 'code' ? 'codes' : 'actor';
        runs.set(id, { id, product, auth: req.headers.authorization, steps: [{ seq: 1, from: 'person', kind: 'message', text: req.body.text }], status: 'running', body: req.body });
        calls.push({ op: 'start', id, auth: req.headers.authorization, body: req.body, at: Date.now() });
        setTimeout(() => answer(id), 30);
        res.status(201).json({ id, ref: `${product}:${id}`, status: 'running' });
    });
    const runOf = (ref) => runs.get(String(ref).split(':')[1]);
    fake.post('/api/frame/runs/:ref/messages', (req, res) => {
        const r = runOf(req.params.ref);
        r.steps.push({ seq: r.steps.length + 1, from: 'person', kind: 'message', text: req.body.text }); r.status = 'running';
        calls.push({ op: 'say', id: r.id, auth: req.headers.authorization, text: req.body.text });
        setTimeout(() => answer(r.id), 30);
        res.status(201).json({});
    });
    fake.get('/api/frame/runs/:ref', (req, res) => { const r = runOf(req.params.ref); res.json({ ref: req.params.ref, status: r.status, cost: { usd: 0.01 } }); });
    fake.get('/api/frame/runs/:ref/steps', (req, res) => { const r = runOf(req.params.ref); res.json({ steps: r.steps.filter((s) => s.seq > Number(req.query.after || 0)) }); });
    // Ada's own Actor agent: its sheet answers her only (Actor checks the owner).
    const SCOUT = 'agt_01J0SC0VT000000000000000000'.slice(0, 30);
    fake.get('/api/frame/agents/:id/sheet', (req, res) => (req.params.id === SCOUT && req.headers.authorization === 'Bearer tok-ada-0123456789'
        ? res.json({ agent: { id: SCOUT, name: 'Scout' } }) : res.status(404).json({ error: 'Not found' })));
    function answer(id) {
        const r = runs.get(id);
        const told = r.steps[r.steps.length - 1].text;
        let text;
        // A reviewer (plan §AD.25): Design asks for one fix in its first review and approves after; the Codex critic approves.
        if (/You are reviewing/.test(told)) {
            r.reviews = (r.reviews || 0) + 1;
            text = r.body.engine && r.body.engine.specialist === 'design' && r.reviews === 1 ? 'The tabs read well.\nCHANGES\n1. The gauges are full width: draw each to its share.' : 'Reads right.\nAPPROVED';
        } else if (r.product === 'codes' && (r.shop || /build the shop page/.test(told))) {
            r.shop = true;
            text = /The check found faults above/.test(told) ? 'Swapped the select for our picker: https://shop.example/usage. DONE'
                : /asked for changes above/.test(told) ? 'Fixed the gauges: https://shop.example/usage. DONE' : 'Built it.\nWhere to see it: https://shop.example/usage\nPR: https://github.com/OpenVibers/x/pull/9\nDONE';
        } else if (r.product === 'codes') text = /asked for changes above/.test(told) ? 'Fixed the gauges. DONE' : 'Fixed the build in the repo. DONE';
        else if (/handoff please/.test(told)) text = 'I planned it. @codes please fix the failing test.';
        else text = 'Here is the plan.';
        r.steps.push({ seq: r.steps.length + 1, from: 'agent', kind: 'message', text, ...(r.product === 'codes' ? { files: [{ id: 'med_01J00000000000000000000000', name: 'patch.diff', url: 'https://openvibe.media/o/med_01J00000000000000000000000' }] } : {}) });
        r.status = 'waiting';
    }
    const fakeServer = await new Promise((r) => { const s = http.createServer(fake).listen(0, '127.0.0.1', () => r(s)); });
    // OpenVibe.Design's page audit (faked): the first look at the shop page finds a native select, later ones nothing.
    const audited = [];
    const designFetch = async (url, init) => {
        const page = JSON.parse(init.body).params.arguments.url;
        audited.push(page);
        const findings = audited.length === 1 ? [{ id: 'native-controls', rule: 'no-native-controls', severity: 'high', says: 'A native select shows.', fix: 'Use the shared picker.', count: 1 }] : [];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { url: page, findings } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const check = require('../server/frame/room-check').createRoomCheck({ designUrl: 'http://design.test', fetchImpl: designFetch });
    const groups = createFrameGroups({ check, db, frameUrl: `http://127.0.0.1:${fakeServer.address().port}/api/frame`, personOf: async (req) => people[req.headers.authorization] || null, pollMs: 20, log: { warn() {}, error() {} } });
    const app = express();
    app.use('/api/frame/groups', groups.router);
    // The one runs list: a group is a run beside chats, tasks and coding runs (the other products are down here).
    const frameRuns = createFrameRuns({ personOf: async (req) => people[req.headers.authorization] || null, svcUrl: () => 'http://127.0.0.1:9', log: { warn() {} }, since: 0, extra: { group: groups.adapter } });
    app.use('/api/frame/runs', frameRuns.router);
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/frame/groups`;
    const call = async (auth, method, path = '', body) => {
        const r = await fetch(base + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    const ADA = 'Bearer tok-ada-0123456789', BO = 'Bearer tok-bo-0123456789x', CY = 'Bearer tok-cy-0123456789x';
    try {
        // Starting one is for admins and the owner; members are any people, agents are roles with engines or harnesses.
        assert.strictEqual((await call(BO, 'POST', '', { title: 'Nope' })).status, 403, 'a plain user does not start groups yet');
        const made = await call(ADA, 'POST', '', { title: 'Launch room', people: ['gbo'], agents: [
            { handle: 'actor', name: 'Actor', product: 'actor', lead: true },
            { handle: 'codex', name: 'Actor · Codex', product: 'actor', engine: { kind: 'harness', harness: 'codex' } },
            { handle: 'codes', name: 'Codes', product: 'codes' },
        ] });
        assert.strictEqual(made.status, 201, JSON.stringify(made.json));
        const id = made.json.id;
        const view = await call(BO, 'GET', `/${id}`);
        assert.strictEqual(view.status, 200, 'an invited person reads it');
        assert.deepStrictEqual(view.json.members.map((m) => [m.kind, m.handle]).sort(), [['agent', 'actor'], ['agent', 'codes'], ['agent', 'codex'], ['person', 'gada'], ['person', 'gbo']]);
        assert.strictEqual((await call(CY, 'GET', `/${id}`)).status, 404, 'a stranger sees nothing');
        assert.strictEqual((await call(CY, 'GET', '')).json.groups.length, 0);

        // Bo says something: the lead answers on Bo's own account.
        assert.strictEqual((await call(BO, 'POST', `/${id}/messages`, { text: 'Plan the launch' })).status, 202);
        const one = await until(async () => { const v = (await call(BO, 'GET', `/${id}`)).json; return !v.busy && v.messages.length >= 2 ? v : null; });
        assert.deepStrictEqual(one.messages.map((m) => [m.from, m.state]), [['usr:gbo', 'done'], ['agent:actor', 'done']]);
        assert.strictEqual(one.messages[1].text, 'Here is the plan.');
        assert.strictEqual(calls[0].auth, BO, 'the turn ran with the bearer of the person who spoke');
        assert.deepStrictEqual([calls[0].body.agent, calls[0].body.kind], ['actor', 'task']);
        assert.match(calls[0].body.text, /^You are Actor in a group conversation with Gada, Gbo and the agents @codex \(Actor · Codex\), @codes \(Codes\)\./);

        // Ada @mentions the Codex role, which hands off to Codes; Codes closes the round with DONE and a file.
        await call(ADA, 'POST', `/${id}/messages`, { text: '@codex handoff please' });
        const two = await until(async () => { const v = (await call(ADA, 'GET', `/${id}`)).json; return !v.busy && v.messages.length >= 5 ? v : null; });
        assert.deepStrictEqual(two.messages.slice(2).map((m) => m.from), ['usr:gada', 'agent:codex', 'agent:codes']);
        const codexStart = calls.find((c) => c.op === 'start' && c.body.engine);
        assert.deepStrictEqual([codexStart.auth, codexStart.body.engine], [ADA, { kind: 'harness', harness: 'codex' }], 'the Codex role on Ada\'s own account');
        const codesStart = calls.find((c) => c.op === 'start' && c.body.kind === 'code');
        assert.deepStrictEqual([codesStart.auth, codesStart.body.agent], [ADA, 'codes']);
        assert.match(codesStart.body.text, /\[Actor · Codex\]: I planned it\. @codes please fix the failing test\./, 'told what the others said');
        assert.deepStrictEqual(two.space.map((f) => [f.name, f.from]), [['patch.diff', 'agent:codes']], 'the shared space lists the file');

        // Bo again: the lead's run is Bo's own and is continued, not restarted.
        await call(BO, 'POST', `/${id}/messages`, { text: 'and the date?' });
        await until(async () => { const v = (await call(BO, 'GET', `/${id}`)).json; return !v.busy && v.messages.length >= 7 ? v : null; });
        const say = calls.filter((c) => c.op === 'say');
        assert.strictEqual(say.length, 1);
        assert.strictEqual(say[0].auth, BO);
        assert.match(say[0].text, /Since you last spoke:\n\[Gada\]: @codex handoff please/);

        // The same group through the one runs API every site's session surface reads.
        const runBase = base.replace('/groups', '/runs');
        const list = await (await fetch(`${runBase}?kind=group`, { headers: { Authorization: BO } })).json();
        assert.deepStrictEqual(list.runs.map((r) => [r.ref, r.kind]), [[`group:${id}`, 'group']], 'listed as a run');
        const steps = await (await fetch(`${runBase}/group:${id}/steps`, { headers: { Authorization: BO } })).json();
        assert.deepStrictEqual(steps.steps.slice(0, 2).map((x) => [x.from, x.author.name]), [['person', 'Gbo'], ['agent', 'Actor']], 'each step names who said it');
        assert.deepStrictEqual([steps.steps[0].author.you, steps.steps[2].author.you], [true, false], 'your own words are yours, Gada\'s are hers');
        const asAda = await (await fetch(`${runBase}/group:${id}/steps`, { headers: { Authorization: ADA } })).json();
        assert.strictEqual(asAda.steps[0].author.you, false, 'the same step, read by someone else');
        assert.strictEqual(steps.steps.find((x) => x.author.handle === 'codes').files[0].name, 'patch.diff');
        const said = await fetch(`${runBase}/group:${id}/messages`, { method: 'POST', headers: { Authorization: BO, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '@actor one more thing' }) });
        assert.strictEqual(said.status, 201, 'said through the runs API');
        await until(async () => { const v = (await call(BO, 'GET', `/${id}`)).json; return !v.busy && v.messages.length >= 9 ? v : null; });
        assert.strictEqual((await fetch(`${runBase}/group:${id}/steps`, { headers: { Authorization: CY } })).status, 404, 'a stranger reads no steps');

        // Your own agent joins: checked against your agent sheet, started as that agent, answering only you.
        assert.strictEqual((await call(ADA, 'POST', `/${id}/members`, { agent: { handle: 'stray', product: 'actor', agent: 'agt_01J0N0TADA00000000000000000'.slice(0, 30) } })).status, 403, 'not hers');
        assert.strictEqual((await call(ADA, 'POST', `/${id}/members`, { agent: { handle: 'bad', product: 'actor', agent: 'agt_x' } })).status, 422);
        const added = await call(ADA, 'POST', `/${id}/members`, { agent: { handle: 'scout', name: 'Scout', product: 'actor', agent: SCOUT } });
        assert.strictEqual(added.status, 201, JSON.stringify(added.json));
        const scout = added.json.members.find((m) => m.handle === 'scout');
        assert.deepStrictEqual([scout.product, scout.personal, scout.owner_name, scout.engine, scout.owner], ['actor', true, 'Gada', null, undefined], 'whose, by name; no subject id');
        const before = calls.length;
        await call(ADA, 'POST', `/${id}/messages`, { text: '@scout look into the venue' });
        const mine = await until(async () => { const v = (await call(ADA, 'GET', `/${id}`)).json; const m = v.messages.filter((x) => x.from === 'agent:scout'); return !v.busy && m.length ? m : null; });
        assert.strictEqual(mine[0].state, 'done');
        const scoutStart = calls.slice(before).find((c) => c.op === 'start');
        assert.deepStrictEqual([scoutStart.auth, scoutStart.body.agent, scoutStart.body.kind, scoutStart.body.engine], [ADA, SCOUT, 'task', undefined], 'started as her agent, on her account');
        await call(BO, 'POST', `/${id}/messages`, { text: '@scout and for me?' });
        const others = await until(async () => { const v = (await call(BO, 'GET', `/${id}`)).json; const m = v.messages.filter((x) => x.from === 'agent:scout'); return !v.busy && m.length >= 2 ? m : null; });
        assert.deepStrictEqual([others[1].state, /answers only the person who added it/.test(others[1].text)], ['failed', true], 'someone else\'s agent does not run on Bo\'s account');
        assert.ok(!calls.slice(before).some((c) => c.auth === BO && c.body && c.body.agent === SCOUT), 'no run of Scout as Bo');
        assert.strictEqual((await call(ADA, 'DELETE', `/${id}/members/agent:scout`)).status, 200);

        // Members: admins add and remove; a plain member does not; the last person stays.
        assert.strictEqual((await call(BO, 'POST', `/${id}/members`, { username: 'gcy' })).status, 403);
        assert.strictEqual((await call(ADA, 'POST', `/${id}/members`, { username: 'gcy' })).status, 201);
        assert.strictEqual((await call(CY, 'GET', `/${id}`)).status, 200, 'now Cy is in it');
        assert.strictEqual((await call(ADA, 'POST', `/${id}/members`, { agent: { handle: 'codex', product: 'codes' } })).status, 409, 'a handle once');
        assert.strictEqual((await call(ADA, 'POST', `/${id}/members`, { agent: { handle: 'x1', product: 'actor', engine: { kind: 'harness', harness: 'nope' } } })).status, 422);
        // WorkBuddy's agent: a preset, and Codes on the codebuddy-code harness.
        const presets = (await call(ADA, 'GET', '/presets')).json;
        assert.ok(presets.harnesses.includes('codebuddy-code') && presets.agents.some((x) => x.handle === 'workbuddy' && x.harness === 'codebuddy-code'), 'WorkBuddy\'s agent is offered');
        const wb = await call(ADA, 'POST', `/${id}/members`, { agent: presets.agents.find((x) => x.handle === 'workbuddy') });
        assert.strictEqual(wb.status, 201, JSON.stringify(wb.json));
        assert.deepStrictEqual(['product', 'harness'].map((k) => wb.json.members.find((m) => m.handle === 'workbuddy')[k]), ['codes', 'codebuddy-code']);
        assert.strictEqual((await call(ADA, 'DELETE', `/${id}/members/agent:workbuddy`)).status, 200);
        assert.strictEqual((await call(ADA, 'DELETE', `/${id}/members/usr:gcy`)).status, 200);

        // A room (plan §AD.25): a group started with no agents named has Actor (lead), Codes (coder) and Design (a reviewer:
        // Actor's loop with the design specialist); the critics are presets.
        const room = await call(ADA, 'POST', '', { title: 'Usage sheet' });
        assert.strictEqual(room.status, 201, JSON.stringify(room.json));
        const rv = (await call(ADA, 'GET', `/${room.json.id}`)).json;
        const roles = rv.members.filter((m) => m.kind === 'agent').map((m) => [m.handle, !!m.lead, !!m.coder, !!m.reviewer]);
        assert.deepStrictEqual(roles, [['actor', true, false, false], ['codes', false, true, false], ['design', false, false, true]], 'Actor, Codes and Design by default');
        assert.deepStrictEqual(rv.members.find((m) => m.handle === 'design').engine, { kind: 'agent', specialist: 'design' });
        const ps = (await call(ADA, 'GET', '/presets')).json.agents;
        assert.deepStrictEqual(ps.filter((x) => x.reviewer).map((x) => x.handle), ['design', 'codex-review', 'muse-review', 'claude-review', 'model-review'], 'Design and four critics');
        assert.strictEqual((await call(ADA, 'POST', `/${room.json.id}/members`, { agent: ps.find((x) => x.handle === 'codex-review') })).status, 201);
        const group = require('openvibe-sdk/agents/group');
        if (typeof group.verdict === 'function') {
            // Codes builds; Design and the Codex critic look at once; Design asks for a fix; Codes fixes; both approve.
            const was = calls.length;
            await call(ADA, 'POST', `/${room.json.id}/messages`, { text: '@codes build the usage sheet' });
            const done = await until(async () => { const v = (await call(ADA, 'GET', `/${room.json.id}`)).json; return !v.busy && v.messages.length >= 7 ? v : null; }, 15000);
            assert.deepStrictEqual(done.messages.map((m) => m.from), ['usr:gada', 'agent:codes', 'agent:design', 'agent:codex-review', 'agent:codes', 'agent:design', 'agent:codex-review'], 'build, review, fix, review');
            assert.deepStrictEqual(done.messages.slice(2, 4).map((m) => m.why), ['review 1 of 2', 'review 1 of 2']);
            assert.match(done.messages[4].why, /@design asked for changes/);
            assert.match(done.messages[6].text, /APPROVED$/);
            const starts = calls.slice(was).filter((c) => c.op === 'start');
            const d = starts.find((c) => c.body.engine && c.body.engine.specialist === 'design'), x = starts.find((c) => c.body.engine && c.body.engine.harness === 'codex');
            assert.ok(d && x && Math.abs(d.at - x.at) < 25, `the reviewers started together (${d && x ? Math.abs(d.at - x.at) : '?'} ms apart)`);
            assert.match(d.body.text, /You are reviewing @codes's work/);
            assert.deepStrictEqual(d.body.engine, { kind: 'agent', specialist: 'design' }, 'Design runs as Actor\'s design specialist');
            const fix = calls.slice(was).filter((c) => c.op === 'say' && /asked for changes above/.test(c.text));
            assert.strictEqual(fix.length, 1, 'Codes was told what to fix');
            assert.match(fix[0].text, /The gauges are full width/);
        } else console.log('  (the review round runs with openvibe-sdk 0.181.0)');
        assert.deepStrictEqual(audited, [], 'a hand-over with no page link is not checked');

        if ('gate' in group.POLICY) {
            // The check before the reviewers (openvibe-sdk 0.185.0; Stageshow's gate): Codes hands over a page; Design's
            // free audit finds a native select and sends it back before any reviewer is paid; the fix passes the check,
            // and the reviewers see what it found.
            const shop = await call(ADA, 'POST', '', { title: 'Shop page' });
            assert.strictEqual(shop.status, 201);
            const was = calls.length;
            await call(ADA, 'POST', `/${shop.json.id}/messages`, { text: '@codes build the shop page' });
            const done = await until(async () => { const v = (await call(ADA, 'GET', `/${shop.json.id}`)).json; return !v.busy && v.messages.length >= 9 ? v : null; }, 15000);
            assert.deepStrictEqual(done.messages.map((m) => [m.from, m.kind]), [['usr:gada', 'person'], ['agent:codes', 'agent'], ['gate', 'gate'], ['agent:codes', 'agent'], ['gate', 'gate'], ['agent:design', 'agent'], ['agent:codes', 'agent'], ['gate', 'gate'], ['agent:design', 'agent']],
                'build, the check sends it back, fix, the check passes, review, fix, the check, review');
            assert.match(done.messages[2].text, /^Checked https:\/\/shop\.example\/usage with openvibe\.design's audit \(its markup, no model\): 1 finding\.\nCHANGES\n1\. high: A native select shows\./);
            assert.strictEqual(done.messages[2].why, 'the check found faults');
            assert.match(done.messages[3].why, /the check found faults/);
            assert.match(done.messages[4].text, /nothing wrong in the markup/);
            assert.deepStrictEqual(done.messages.slice(5, 6).map((m) => m.why), ['review 1 of 2'], 'the bounce was no review');
            assert.deepStrictEqual(audited, ['https://shop.example/usage', 'https://shop.example/usage', 'https://shop.example/usage'], 'the page each time, never the PR');
            const starts = calls.slice(was).filter((c) => c.op === 'start' && c.body.engine && c.body.engine.specialist === 'design');
            assert.match(starts[0].body.text, /What the check before you found \(free, measured, no model\):\nChecked https:\/\/shop\.example\/usage[^\n]*nothing wrong in the markup/, 'Design sees what the check found');
            const told = calls.slice(was).filter((c) => c.op === 'say' && /The check found faults above/.test(c.text));
            assert.strictEqual(told.length, 1, 'Codes was told what the check found');
            const steps = (await groups.adapter.steps(ADA, { id: people[ADA].subject_id }, shop.json.id)).steps;
            assert.deepStrictEqual(steps.filter((s) => s.author.id === 'gate').map((s) => [s.from, s.author.name]), [['agent', 'The check'], ['agent', 'The check'], ['agent', 'The check']], 'the session view names it');
        } else console.log('  (the check before the reviewers runs with openvibe-sdk 0.185.0)');
        assert.strictEqual((await call(ADA, 'POST', `/${room.json.id}/members`, { agent: { handle: 'x2', product: 'actor', engine: { kind: 'model', specialist: 'design' } } })).status, 422, 'a specialist is on the agent engine only');

        // Roles map to the Frame's run start.
        assert.deepStrictEqual(startBody(agentOf({ handle: 'oc', product: 'codes', harness: 'opencode' }).config, 'hi'), { text: 'hi', kind: 'code', agent: 'opencode' });
        assert.deepStrictEqual(startBody(agentOf({ handle: 'one', product: 'actor', engine: 'model' }).config, 'hi'), { text: 'hi', kind: 'task', agent: 'actor', engine: { kind: 'model' } });
        assert.deepStrictEqual(startBody(agentOf({ handle: 'design', product: 'actor', engine: { kind: 'agent', specialist: 'design' }, reviewer: true }).config, 'hi'), { text: 'hi', kind: 'task', agent: 'actor', engine: { kind: 'agent', specialist: 'design' } });
        assert.strictEqual(agentOf({ handle: 'cr', product: 'codes', reviewer: true }).config.reviewer, undefined, 'a reviewer is an Actor role');
        console.log('frame-groups: people and agents in one thread, each turn on the speaker\'s own account, a shared space, members by rank');
    } finally { server.close(); fakeServer.close(); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
