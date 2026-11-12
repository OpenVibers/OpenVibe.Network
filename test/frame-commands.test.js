'use strict';
// GET /api/frame/commands: every site's /ask, /do, /remind and /timer, a site's own from its Frame manifest, and a
// signed-in person's saved composer snippets. Site commands first, a name once, q filtering, and the cache rule
// (signed out public for 60 s, signed in private and never kept).
const assert = require('assert');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');
const { read: readCommands } = require('../server/frame/commands');

(async () => {
    const db = getDb();
    const subject = ids.newId('user');
    const row = await db.prepare(`INSERT INTO users (username, display_name, email, password_hash, subject_id, profile_public)
        VALUES ('sam', 'Sam Rivera', 'sam@example.test', 'x', ?, 1) RETURNING id`).get(subject);
    const me = { id: Number(row.id), subject_id: subject, username: 'sam' };
    await db.prepare(`INSERT INTO user_preferences (user_id, composer_prefs, composer_rev) VALUES (?, ?, 2)`)
        .run(me.id, JSON.stringify({ snippets: [
            { trigger: '/sig', label: 'Signature', text: '— Sam' },
            { trigger: '/standup', label: 'Stand-up notes', text: 'Yesterday: ' },
            { trigger: 'not a slash', label: 'bad', text: 'x' },
        ] }));

    const sites = [{
        id: 'community', name: 'Community', host: 'openvibe.community', status: 'open', tagline: 'Posts and pastes',
        commands: [
            { name: 'poll', summary: 'Ask the room a question', insert: '/poll ', needs_sign_in: true },
            { name: 'ask', hint: 'Ask the community', insert: '/ask ' },
            { name: 'Bad Name', hint: 'not a slash word', insert: '/bad ' },
        ],
    }];

    let clock = 1_000_000;
    let who = null;
    const svc = await createFrameService(db, { services: {} }, null, {
        person: async () => who, sites, places: sites, now: () => clock, mentionLimit: 120,
    });
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame/commands`;
    const get = async (qs, headers) => { const r = await fetch(`${base}${qs}`, { headers }); return { r, d: await r.json() }; };

    try {
        // Signed out: the site's own first (it replaces /ask), then the network's four; no saved commands.
        let { r, d } = await get('?site=openvibe.community');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
        assert.match(r.headers.get('vary') || '', /Authorization/);
        assert.deepStrictEqual(d.site, { id: 'community', name: 'Community', host: 'openvibe.community' });
        assert.deepStrictEqual(d.commands.map((c) => c.name), ['poll', 'ask', 'do', 'remind', 'timer'],
            'the site first, its /ask replaces the network one, then the network four');
        assert.deepStrictEqual(Object.keys(d.commands[0]).sort(), ['hint', 'insert', 'kind', 'name', 'needs_sign_in']);
        assert.deepStrictEqual([d.commands[0].kind, d.commands[0].needs_sign_in, d.commands[0].hint], ['site', true, 'Ask the room a question']);
        assert.deepStrictEqual([d.commands[1].kind, d.commands[1].hint], ['site', 'Ask the community']);
        assert.deepStrictEqual(d.commands.slice(2).map((c) => c.kind), ['network', 'network', 'network']);
        assert.strictEqual(d.commands.find((c) => c.name === 'do').insert, '/do ');
        assert.ok(!d.commands.some((c) => c.name === 'sig'), 'saved commands need a person');

        // The same signed-out answer is held 60 s, then the site manifest is read again.
        sites[0].commands.push({ name: 'clip', hint: 'Make a clip' });
        ({ d } = await get('?site=openvibe.community'));
        assert.ok(!d.commands.some((c) => c.name === 'clip'), 'the signed-out answer is held 60 s');
        clock += 61_000;
        ({ d } = await get('?site=openvibe.community'));
        assert.ok(d.commands.some((c) => c.name === 'clip'), 'after the minute the manifest is read again');

        // q filters by the name and the hint; an unknown site still offers the network four.
        ({ d } = await get('?site=community&q=poll'));
        assert.deepStrictEqual(d.commands.map((c) => c.name), ['poll']);
        ({ d } = await get('?site=community&q=SIGN'));
        assert.deepStrictEqual(d.commands, [], 'a query that matches no name or hint is an empty list');
        ({ d } = await get('?site=nope.example'));
        assert.strictEqual(d.site, null);
        assert.deepStrictEqual(d.commands.map((c) => c.name), ['ask', 'do', 'remind', 'timer']);

        // Signed in: the person's own snippets come last, and nothing is kept.
        who = me;
        ({ r, d } = await get('?site=openvibe.community'));
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.deepStrictEqual(d.commands.map((c) => c.name), ['poll', 'ask', 'clip', 'do', 'remind', 'timer', 'sig', 'standup']);
        const mine = d.commands.find((c) => c.name === 'sig');
        assert.deepStrictEqual(mine, { name: 'sig', hint: 'Signature', insert: '— Sam', kind: 'mine', needs_sign_in: false });
        assert.ok(!d.commands.some((c) => c.name === 'not a slash'), 'an invalid snippet is not a command');
        ({ d } = await get('?site=community&q=standup'));
        assert.deepStrictEqual(d.commands.map((c) => c.name), ['standup']);

        // The pure read is the same rule: an invalid manifest command is dropped.
        const pure = readCommands({ site: 'community', sites, siteForHost: () => null });
        assert.ok(!pure.commands.some((c) => c.name === 'bad name'));
        assert.strictEqual(pure.commands[0].name, 'poll');

        console.log('  ok  frame commands: site, network and saved rows; signed-out cache; q\n');
    } finally {
        await new Promise((r2) => server.close(r2));
        svc.stop();
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
