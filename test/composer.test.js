'use strict';
// The shared composer on Network: composer.prefs@1 with its revision check (a stale tab gets 409 with the current
// copy), composer.mention@1 from people (followed first, then public), OpenVibe Git repositories and first-party
// sites, signed-in only, and CORS (a first-party origin yes, a foreign one refused).
const assert = require('assert');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');

(async () => {
    const db = require('../server/db/database').getDb();
    const { createRouter } = require('../server/composer/routes');
    const { gate, restrictedCors, originGuard } = require('../server/public-cors');

    // A Git that answers the repository search the way Git's /api/v1/repos does.
    const gitSeen = [];
    const git = http.createServer((req, res) => {
        gitSeen.push({ url: req.url, authorization: req.headers.authorization, subject: req.headers['x-ov-subject'] });
        const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ repositories: [
            { full_name: 'OpenVibers/OpenVibe.Contracts', html_url: 'https://git.openvibe.codes/OpenVibers/OpenVibe.Contracts' },
            { full_name: `openvibers/${q || 'demo'}`, html_url: 'https://git.openvibe.codes/openvibers/demo' },
        ] }));
    });
    await new Promise((r) => git.listen(0, '127.0.0.1', r));
    const gitUrl = `http://127.0.0.1:${git.address().port}`;

    // requireAuth stand-in: X-Test-User names the session row; none -> 401, as Network answers.
    const requireAuth = (req, res, next) => {
        const raw = req.headers['x-test-user'];
        if (!raw) return res.status(401).json({ error: 'Authentication required' });
        req.user = JSON.parse(raw);
        next();
    };
    const config = { baseUrl: 'https://openvibe.network', services: { git: { internalUrl: gitUrl } } };
    const app = express();
    const allowed = (o) => ['https://openvibe.community', 'https://openvibe.network'].includes(o);
    const guard = originGuard(allowed, { log: { warn() {} } });
    app.use(gate(restrictedCors(guard.origin)));
    app.use(express.json());
    app.use('/api/v1', createRouter({ db, requireAuth, selfToken: () => 'git-service-token', config }));
    app.use(guard.denied);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // ── The person and the people around them ──
    const me = { username: 'sam', display: 'Sam Rivera' };
    const insertUser = async (username, extra = {}) => {
        const subject = ids.newId('user');
        const r = await db.prepare(`INSERT INTO users (username, display_name, avatar_url, password_hash, subject_id, is_anon, is_banned, profile_public)
            VALUES (?, ?, ?, 'x', ?, ?, ?, 1) RETURNING id`).get(username, extra.display || username, extra.avatar || null, subject, extra.anon ? 1 : 0, extra.banned ? 1 : 0);
        return { id: Number(r.id), subject_id: subject, username, display_name: extra.display || username, avatar_url: extra.avatar || null };
    };
    const self = await insertUser(me.username, { display: me.display });
    const followed = await insertUser('ana', { display: 'Ana Followed' });
    const publicPerson = await insertUser('zoe', { display: 'Zoe Public' });
    const banned = await insertUser('banned', { display: 'Banned Person', banned: true });
    const anon = await insertUser('anon', { display: 'Anon Person', anon: true });
    await db.prepare('INSERT INTO follows (follower_id, followed_id) VALUES (?, ?)').run(self.id, followed.id);
    const who = JSON.stringify({ id: self.id, subject_id: self.subject_id, username: self.username });
    const call = async (method, p, body, headers = {}) => {
        const h = { 'x-test-user': who, ...headers };
        if (body !== undefined) h['content-type'] = 'application/json';
        const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    // ── Settings: defaults, a write, a stale tab ──
    let r = await call('GET', '/api/v1/me/composer');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { rev: 0, send_key: 'enter', tools: [], density: 'comfy', voice: true, snippets: [] });

    const prefs = {
        rev: 0, send_key: 'mod-enter', density: 'compact', voice: false,
        tools: [{ id: 'attach', hidden: false }, { id: 'gif', hidden: true }],
        snippets: [{ trigger: '/sig', label: 'Signature', text: '— Sam' }],
    };
    r = await call('PUT', '/api/v1/me/composer', prefs);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.rev, 1);
    assert.strictEqual(r.body.send_key, 'mod-enter');
    r = await call('GET', '/api/v1/me/composer');
    assert.deepStrictEqual(r.body, { ...prefs, rev: 1 });

    // A second tab that read rev 0 is refused with the current copy, and writes nothing.
    r = await call('PUT', '/api/v1/me/composer', { ...prefs, rev: 0, density: 'comfy' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'composer.rev_conflict');
    assert.strictEqual(r.body.current.rev, 1);
    assert.strictEqual(r.body.current.density, 'compact');
    assert.deepStrictEqual((await call('GET', '/api/v1/me/composer')).body, { ...prefs, rev: 1 });

    // Invalid documents are refused: a trigger that is not a slash word, 51 snippets, an unknown field.
    r = await call('PUT', '/api/v1/me/composer', { ...prefs, rev: 1, snippets: [{ trigger: 'sig', label: 'Signature', text: 'x' }] });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'composer.invalid_prefs');
    r = await call('PUT', '/api/v1/me/composer', { ...prefs, rev: 1, snippets: Array.from({ length: 51 }, (_, i) => ({ trigger: `/s${i}`, label: `s${i}`, text: 'x' })) });
    assert.strictEqual(r.status, 422);
    r = await call('PUT', '/api/v1/me/composer', { ...prefs, rev: 1, extra: true });
    assert.strictEqual(r.status, 422);

    // ── Mentions: people the person follows first, then public people ──
    r = await call('GET', '/api/v1/mentions?q=o');
    assert.strictEqual(r.status, 200);
    const people = r.body.mentions.filter((m) => m.kind === 'person');
    assert.strictEqual(people[0].id, followed.subject_id, 'a followed person comes first');
    assert.strictEqual(people[0].handle, 'ana');
    assert.strictEqual(people[0].label, 'Ana Followed');
    assert.match(people[0].avatar, /^https:\/\/openvibe\.network\/avatar\/ana\?s=64$/);
    assert.ok(!people.some((p) => p.id === banned.subject_id), 'a banned person is not mentioned');
    assert.ok(!people.some((p) => p.id === anon.subject_id), 'an anonymous account is not mentioned');
    assert.ok(!people.some((p) => p.id === self.subject_id), 'a person does not mention themselves');

    // Repositories come from Git with the person's subject and Network's service token.
    r = await call('GET', '/api/v1/mentions?q=contract&kinds=repo');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.mentions.length >= 1);
    assert.deepStrictEqual([...new Set(r.body.mentions.map((m) => m.kind))], ['repo']);
    assert.strictEqual(r.body.mentions[0].id, 'OpenVibers/OpenVibe.Contracts');
    assert.match(r.body.mentions[0].url, /^https:\/\/git\.openvibe\.codes\//);
    assert.strictEqual(gitSeen[0].authorization, 'Bearer git-service-token');
    assert.strictEqual(gitSeen[0].subject, self.subject_id, 'Git is asked as the person');

    // First-party sites, and the 8-entry ceiling.
    r = await call('GET', '/api/v1/mentions?q=chat&kinds=site');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.mentions.some((m) => m.kind === 'site' && m.id === 'chat'));
    for (let i = 0; i < 10; i++) await insertUser(`extra${i}`);
    r = await call('GET', '/api/v1/mentions?q=extra');
    assert.ok(r.body.mentions.length <= 8, 'at most 8 mentions');

    // A kind outside the list is refused; file-only is an empty list (files are the message's own context).
    r = await call('GET', '/api/v1/mentions?kinds=channel');
    assert.strictEqual(r.status, 422);
    r = await call('GET', '/api/v1/mentions?kinds=file');
    assert.deepStrictEqual(r.body.mentions, []);

    // ── Signed-in only ──
    let res = await fetch(`${base}/api/v1/mentions`, { headers: { 'x-test-user': '' } });
    assert.strictEqual(res.status, 401);
    res = await fetch(`${base}/api/v1/me/composer`);
    assert.strictEqual(res.status, 401);

    // ── CORS: a first-party origin, and a refused foreign one ──
    res = await fetch(`${base}/api/v1/mentions`, { method: 'OPTIONS', headers: { Origin: 'https://openvibe.community', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://openvibe.community');
    res = await fetch(`${base}/api/v1/mentions`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).code, 'cors.origin_denied');

    await new Promise((r2) => server.close(r2));
    await new Promise((r2) => git.close(r2));
    console.log('composer: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
