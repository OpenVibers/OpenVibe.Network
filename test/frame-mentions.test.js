'use strict';
// GET /api/frame/mentions: public people first (avatar only from openvibe.media), then the person's own agents from
// the agent directory, then open sites and Live's public channels. At most eight; signed out it is public people only.
// The per-actor limit, the signed-out 60 s cache and the absence of any private account field are checked too.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

(async () => {
    const db = getDb();
    const addUser = async (username, extra = {}) => {
        const subject = ids.newId('user');
        const row = await db.prepare(`INSERT INTO users (username, display_name, email, password_hash, subject_id, is_anon, is_banned, profile_public, avatar_url)
            VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?) RETURNING id`)
            .get(username, extra.display || username, extra.email || null, subject, extra.anon ? 1 : 0, extra.banned ? 1 : 0,
                extra.public === false ? 0 : 1, extra.avatar || null);
        return { id: Number(row.id), subject_id: subject, username, display_name: extra.display || username };
    };
    const me = await addUser('sam', { display: 'Sam Rivera', email: 'sam@example.test' });
    const ana = await addUser('ana', { display: 'Ana Followed', email: 'ana@example.test', avatar: 'https://openvibe.media/p/ana/screenshot' });
    const anabel = await addUser('anabel', { display: 'Anabel Also', email: 'anabel@example.test' });
    await addUser('zoe', { display: 'Zoe Public', email: 'zoe@example.test', avatar: 'https://openvibe.network/avatar/zoe?s=64' });
    await addUser('hidden', { display: 'Hidden Person', public: false });
    await addUser('banned', { display: 'Banned Person', banned: true });
    await addUser('anon', { display: 'Anon Person', anon: true });
    const other = await addUser('other', { display: 'Other Person' });
    await db.prepare('INSERT INTO follows (follower_id, followed_id) VALUES (?, ?)').run(me.id, ana.id);
    await db.prepare('INSERT INTO follows (follower_id, followed_id) VALUES (?, ?)').run(me.id, anabel.id);

    const agent = async (owner, name, kind, status) => {
        const id = ids.newId('agent');
        await db.prepare(`INSERT INTO agent_directory (id, owner_subject, kind, name, service, skills, status)
            VALUES (?, ?, ?, ?, ?, '[]', ?)`).run(id, owner.subject_id, kind, name, kind, status);
        return id;
    };
    const actor = await agent(me, 'Actor', 'actor', 'online');
    await agent(me, 'Codes', 'codes', 'offline');
    await agent(other, 'Other Agent', 'actor', 'online');

    const live = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ streams: [
            { username: 'streamer', display_name: 'Streamer One', avatar_url: 'https://openvibe.media/p/streamer/screenshot', is_public: true },
            { username: 'secret', display_name: 'Secret Channel', visibility: 'private' },
            { username: 'unlisted', display_name: 'Unlisted Channel', unlisted: true },
            { username: 'bad name', display_name: 'Bad Channel', is_public: true },
        ] }));
    });
    await new Promise((r) => live.listen(0, '127.0.0.1', r));

    const places = [
        { id: 'community', name: 'Community', host: 'openvibe.community', status: 'open', tagline: 'Posts and pastes' },
        { id: 'live', name: 'Live', host: 'openvibe.live', status: 'open', tagline: 'Go live, watch streams' },
        { id: 'network', name: 'Network', host: 'openvibe.network', status: 'open', tagline: 'Your account' },
        { id: 'soon', name: 'Soon', host: 'openvibe.soon', status: 'soon' },
    ];

    let clock = 1_000_000;
    let who = null;
    const svc = await createFrameService(db, { services: { live: { internalUrl: `http://127.0.0.1:${live.address().port}` } } }, null, {
        person: async () => who, places, sites: places, now: () => clock, mentionLimit: 50,
    });
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame/mentions`;
    const get = async (qs) => { const r = await fetch(`${base}${qs}`); const text = await r.text(); return { r, text, d: JSON.parse(text) }; };

    try {
        // Signed out: public people only, in the mention row shape; the 60 s public cache.
        let { r, text, d } = await get('?q=ana');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
        assert.match(r.headers.get('vary') || '', /Authorization/);
        assert.deepStrictEqual(d.mentions.map((m) => m.handle), ['ana', 'anabel'], 'an exact username first, then the rest');
        assert.deepStrictEqual(d.mentions[0], {
            kind: 'person', id: ana.subject_id, label: 'Ana Followed', handle: 'ana',
            avatar: 'https://openvibe.media/p/ana/screenshot', url: 'https://openvibe.network/@ana',
        });
        assert.ok(d.mentions.every((m) => m.kind === 'person'), 'signed out has no agents or places');

        ({ d } = await get('?q=zoe'));
        assert.strictEqual(d.mentions.length, 1);
        assert.ok(!('avatar' in d.mentions[0]), 'a non-Media avatar is never returned');
        assert.ok(!/zoe@example\.test|sam@example\.test/.test(text), 'no email');

        for (const q of ['hidden', 'banned', 'anon']) {
            ({ d } = await get(`?q=${q}`));
            assert.deepStrictEqual(d.mentions, [], `${q} is not a public person to mention`);
        }

        // Signed in: people first, then the person's agents (never another owner's), then places and channels.
        who = me;
        ({ r, d } = await get('?q=actor'));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.deepStrictEqual(d.mentions.map((m) => [m.kind, m.id]), [['agent', actor]]);
        assert.strictEqual(d.mentions[0].label, 'Actor');
        assert.match(d.mentions[0].sub, /actor.*online/i);
        assert.ok(!text.includes(other.subject_id) && !text.includes('Other Agent'), "another owner's agent is not listed");

        ({ d } = await get('?q=live'));
        assert.ok(d.mentions.some((m) => m.kind === 'site' && m.id === 'live' && m.url === 'https://openvibe.live/'));
        assert.ok(!d.mentions.some((m) => m.id === 'soon'), 'a site that is not open is not a place');

        ({ d } = await get('?q=streamer'));
        assert.deepStrictEqual(d.mentions.map((m) => [m.kind, m.id]), [['channel', 'streamer']]);
        assert.strictEqual(d.mentions[0].url, 'https://openvibe.live/@streamer');
        assert.strictEqual(d.mentions[0].avatar, 'https://openvibe.media/p/streamer/screenshot');
        ({ d } = await get('?q=secret'));
        assert.deepStrictEqual(d.mentions, [], 'a private Live channel is never mentioned');
        ({ d } = await get('?q=unlisted'));
        assert.deepStrictEqual(d.mentions, [], 'an unlisted Live channel is never mentioned');

        ({ d } = await get('?site=openvibe.community&q=community'));
        assert.ok(!d.mentions.some((m) => m.id === 'community'), 'the site the box is on is not suggested back');

        ({ d } = await get('?q='));
        assert.ok(d.mentions.length <= 8, 'at most eight rows');
        const rank = { person: 0, agent: 1, site: 2, channel: 3 };
        const ranks = d.mentions.map((m) => rank[m.kind]);
        assert.deepStrictEqual(ranks, [...ranks].sort((a, b) => a - b), 'people first, then agents, then places');
        assert.ok(!/@example\.test/.test(JSON.stringify(d)), 'no email in the signed-in answer');
        assert.ok(!/password|owner_subject|machine_id|endpoint|skills/.test(JSON.stringify(d)), 'no private agent field');

        // The per-actor limit is in memory and resets on the next minute; Retry-After says when.
        const limited = await createFrameService(db, { services: { live: { internalUrl: `http://127.0.0.1:${live.address().port}` } } }, null, {
            person: async () => me, places, sites: places, now: () => clock, mentionLimit: 2,
        });
        const app2 = express();
        app2.set('trust proxy', 'loopback');
        app2.use('/api/frame', limited.router);
        const server2 = app2.listen(0, '127.0.0.1');
        await new Promise((r2) => server2.once('listening', r2));
        const base2 = `http://127.0.0.1:${server2.address().port}/api/frame/mentions`;
        try {
            assert.strictEqual((await fetch(`${base2}?q=a`)).status, 200);
            assert.strictEqual((await fetch(`${base2}?q=b`)).status, 200);
            const third = await fetch(`${base2}?q=c`);
            assert.strictEqual(third.status, 429);
            assert.ok(Number(third.headers.get('retry-after')) >= 1);
            assert.strictEqual((await third.json()).code, 'frame.mentions_rate_limited');
            clock += 61_000;
            assert.strictEqual((await fetch(`${base2}?q=d`)).status, 200, 'the window is a minute');
        } finally {
            await new Promise((r2) => server2.close(r2));
            limited.stop();
        }

        console.log('  ok  frame mentions: people, agents, places, ranking, signed-out cache and the per-actor limit\n');
    } finally {
        await new Promise((r2) => server.close(r2));
        live.close();
        svc.stop();
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
