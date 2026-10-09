'use strict';
// Public profiles (server/profile/public.js, plan T21 step 3): openvibe.network/@<username> and
// GET /api/v1/profiles/:username, with the items from a stand-in OpenVibe.Inventory read with the Network's own
// service token. A public profile shows the picture, name, escaped bio, member since, what the person wears and their
// items by kind; a hidden one only the name and picture (noindex); an anonymous or deleted account is a 404; an old
// username answers 301; Inventory down still answers the profile; a second view within a minute reads nothing again.
//   node test/public-profile.test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createPublicProfiles, monthOf } = require('../server/profile/public');
const publicCors = require('../server/public-cors');

const A = 'usr_01JZ0000000000000000000AAA';
const KINDS = [
    { id: 'live.name_effect', name: 'Name effect' }, { id: 'live.hat', name: 'Hat' }, { id: 'live.particle', name: 'Particle' },
];
const DEFS = {
    itd_01JZ00000000000000000001R1: { id: 'itd_01JZ00000000000000000001R1', kind: 'live.hat', name: 'Royal Crown', rarity: 'legendary', art: { emoji: '👑' } },
    itd_01JZ00000000000000000001R2: { id: 'itd_01JZ00000000000000000001R2', kind: 'live.name_effect', name: 'Rainbow', rarity: 'epic', art: { emoji: '🌈', token: 'name-fx-rainbow' } },
    itd_01JZ00000000000000000001R3: { id: 'itd_01JZ00000000000000000001R3', kind: 'live.particle', name: 'Sparkles <b>', rarity: 'common', art: { emoji: '✨' } },
};
const INSTANCES = [
    { id: 'inv_01JZ0000000000000000000001', definition_id: 'itd_01JZ00000000000000000001R1', state: 'owned', acquired_at: '2026-10-02T00:00:00Z' },
    { id: 'inv_01JZ0000000000000000000002', definition_id: 'itd_01JZ00000000000000000001R2', state: 'owned', acquired_at: '2026-10-03T00:00:00Z' },
    { id: 'inv_01JZ0000000000000000000003', definition_id: 'itd_01JZ00000000000000000001R3', state: 'owned', acquired_at: '2026-10-04T00:00:00Z' },
];

(async () => {
    assert.strictEqual(monthOf('2026-10-01 10:00:00'), 'October 2026');
    assert.strictEqual(monthOf('bad'), null);
    for (const p of ['/api/v1/profiles/Ana', '/api/v1/profiles/some_one_42']) assert.ok(publicCors.isPublicDiscoveryPath(p), `${p} is readable from any origin`);
    for (const p of ['/api/v1/profiles', '/api/v1/profiles/', '/api/v1/profiles/a/b', '/api/v1/profiles/a.b', '/api/v1/profiles/%2e%2e']) assert.ok(!publicCors.isPublicDiscoveryPath(p), `${p} is not`);

    // The route is mounted before the 404 page, and the column comes from a migration.
    const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.ok(index.indexOf("app.get('/@:username'") > 0 && index.indexOf("app.get('/@:username'") < index.indexOf("require('./not-found').notFound"), '/@:username answers before the 404 page');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0022_public_profiles.sql'), 'utf8'), /^-- phase: expand$/m);

    const db = getDb();
    await db.prepare(`INSERT INTO users (username, password_hash, display_name, bio, profile_color, created_at, subject_id, profile_public, is_anon, deleted_at) VALUES
        ('Ana', 'x', 'Ana', 'I stream <script>alert(1)</script> & paint', '#ff0066', '2026-10-01 10:00:00', '${A}', 1, 0, NULL),
        ('hidden', 'x', 'Hidden', 'secret bio', '#00ff00', '2026-09-01 10:00:00', 'usr_01JZ0000000000000000000BBB', 0, 0, NULL),
        ('ghost', 'x', 'Ghost', '', NULL, '2026-09-01 10:00:00', NULL, 1, 1, NULL),
        ('gone', 'x', 'Gone', '', NULL, '2026-09-01 10:00:00', NULL, 1, 0, '2026-10-05 00:00:00')`).run();
    const ana = await db.prepare("SELECT id FROM users WHERE username = 'Ana'").get();
    await db.prepare("INSERT INTO username_history (user_id, old_username, new_username) VALUES (?, 'oldana', 'Ana')").run(ana.id);
    assert.strictEqual(Number((await db.prepare("SELECT profile_public FROM users WHERE username = 'Ana'").get()).profile_public), 1);

    // A stand-in OpenVibe.Inventory.
    const calls = [];
    let down = false;
    const inv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        calls.push({ path: u.pathname, auth: req.headers.authorization || '' });
        const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (down) return json(503, { code: 'down' });
        if (u.pathname === '/api/v1/kinds') return json(200, { kinds: KINDS });
        if (u.pathname === `/api/v1/people/${A}/equipped`) return json(200, { subject: A, slots: { 'live.hat:hat': { instance_id: INSTANCES[0].id, definition_id: INSTANCES[0].definition_id }, 'live.name_effect:name_effect': { instance_id: INSTANCES[1].id, definition_id: INSTANCES[1].definition_id, token: 'name-fx-rainbow' } } });
        if (u.pathname === `/api/v1/people/${A}/items`) return json(200, { subject: A, instances: INSTANCES, definitions: DEFS, next_cursor: null });
        if (u.pathname === `/api/v1/profiles/${A}/badges`) return json(200, { subject: A, badges: [{ id: 'first-follow', name: 'First Follow', awarded_at: '2026-10-02T10:00:00Z' }, { id: 'thread-starter', name: 'Thread <Starter>', awarded_at: '2026-10-05T10:00:00Z' }] });
        return json(404, { code: 'inventory.unknown_subject' });
    });
    await new Promise((r) => inv.listen(0, '127.0.0.1', r));
    let clock = Date.now();
    const selfToken = (aud, caps) => `tok:${aud}:${caps.join(',')}`;
    const profiles = createPublicProfiles({ db, selfToken, inventoryUrl: `http://127.0.0.1:${inv.address().port}`, questUrl: `http://127.0.0.1:${inv.address().port}`, now: () => clock, log: { warn() {} } });

    const app = express();
    app.get('/@:username', profiles.pageHandler);
    app.use('/api/v1/profiles', profiles.api);
    app.use((req, res) => res.status(404).send('not found'));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const b = `http://127.0.0.1:${srv.address().port}`;
    const get = async (p) => { const r = await fetch(b + p, { redirect: 'manual' }); return { status: r.status, headers: r.headers, text: await r.text() }; };

    try {
        // A public profile.
        let r = await get('/@ana');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('<h1><span class="ov-fx name-fx-rainbow" title="Rainbow">Ana</span></h1>') && r.text.includes('@Ana'), 'her name wears its effect');
        assert.ok(r.text.includes('<link rel="stylesheet" href="/shared/items.css">'), 'with the shared effects stylesheet');
        assert.ok(/<span class="pf-hat" title="Royal Crown" aria-hidden="true">👑<\/span>/.test(r.text), 'her hat sits on her picture');
        assert.ok(!r.text.includes('<script>alert(1)</script>') && r.text.includes('I stream &lt;script&gt;alert(1)&lt;/script&gt; &amp; paint'), 'the bio is escaped');
        assert.ok(r.text.includes('Sparkles &lt;b&gt;') && !r.text.includes('Sparkles <b>'), 'item names are escaped');
        assert.ok(r.text.includes('id="pf-wearing"') && /pf-worn r-legendary[\s\S]*Royal Crown/.test(r.text), 'the crown is in the showcase');
        assert.ok(r.text.includes('Member since') && r.text.includes('October 2026'));
        assert.ok(/<span class="pf-stat-k">Rarest<\/span><span class="pf-stat-v">Legendary<\/span>/.test(r.text));
        assert.ok(r.text.includes('<span class="pf-count">3</span>'), 'three items');
        assert.ok(r.text.includes('"@type":"ProfilePage"') && r.text.includes('<link rel="canonical" href="https://openvibe.network/@Ana">'));
        assert.ok(r.text.includes('--pf-color:#ff0066'));
        assert.ok(r.text.includes('https://inventory.openvibe.network/items/itd_01JZ00000000000000000001R1'), 'items link to their Inventory page');
        assert.ok(!/name="robots" content="noindex"/.test(r.text));
        assert.ok(calls.filter((c) => !c.path.includes('/badges')).every((c) => c.auth === 'Bearer tok:openvibe.inventory:inventory.item.read'), 'Network\'s own token for Inventory');
        assert.strictEqual(calls.find((c) => c.path.endsWith('/badges')).auth, 'Bearer tok:openvibe.quest:quest.badge.read', 'and for Quest');
        assert.ok(r.text.includes('id="pf-badges"') && /Thread &lt;Starter&gt;[\s\S]*First Follow/.test(r.text), 'badges, newest first, escaped');
        assert.ok(/<span class="pf-stat-k">Badges<\/span><span class="pf-stat-v">2<\/span>/.test(r.text));

        // Cached for a minute: a second view reads nothing.
        const n = calls.length;
        await get('/@Ana');
        assert.strictEqual(calls.length, n, 'a second view within 60 s is cache');

        // The JSON every site reads.
        r = await get('/api/v1/profiles/Ana');
        assert.strictEqual(r.status, 200);
        const p = JSON.parse(r.text).profile;
        assert.deepStrictEqual([p.username, p.private, p.color, p.member_since, p.items.count, p.showcase.map((s) => s.name)], ['Ana', false, '#ff0066', '2026-10-01', 3, ['Rainbow', 'Royal Crown']]);
        assert.strictEqual(p.avatar_url, 'https://openvibe.network/avatar/Ana?s=160');
        assert.strictEqual(p.inventory_url, `https://inventory.openvibe.network/u/${A}`);
        assert.deepStrictEqual(p.items.by_kind.map((k) => k.kind).sort(), ['live.hat', 'live.name_effect', 'live.particle']);
        assert.deepStrictEqual(p.badges.map((b) => b.id), ['thread-starter', 'first-follow']);

        // A hidden profile: name and picture, nothing else, not indexed.
        r = await get('/@hidden');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('This profile is private.') && r.text.includes('name="robots" content="noindex"'));
        assert.ok(!r.text.includes('secret bio') && !r.text.includes('Member since') && !r.text.includes('class="pf-grid"'));
        assert.ok(r.text.includes('<h1>Hidden</h1>') && !r.text.includes('class="pf-hat"') && !r.text.includes('/shared/items.css'), 'a hidden profile wears nothing');
        r = await get('/api/v1/profiles/hidden');
        assert.deepStrictEqual(JSON.parse(r.text).profile, { username: 'hidden', display_name: 'Hidden', avatar_url: 'https://openvibe.network/avatar/hidden?s=160', profile_url: 'https://openvibe.network/@hidden', private: true });

        // No profile: anonymous, deleted, unknown.
        for (const name of ['ghost', 'gone', 'nobody', 'x']) {
            assert.strictEqual((await get(`/@${name}`)).status, 404, `/@${name}`);
            assert.strictEqual((await get(`/api/v1/profiles/${name}`)).status, 404, `api ${name}`);
        }
        // An old name: 301 to the current one.
        r = await get('/@oldana');
        assert.deepStrictEqual([r.status, r.headers.get('location')], [301, '/@Ana']);
        r = await get('/api/v1/profiles/oldana');
        assert.deepStrictEqual([r.status, r.headers.get('location')], [301, '/api/v1/profiles/Ana']);

        // Inventory down (and the cache expired): the profile still answers.
        down = true;
        clock += 61_000;
        r = await get('/@Ana');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('The items could not be loaded just now'));
        r = await get('/api/v1/profiles/Ana');
        assert.strictEqual(JSON.parse(r.text).profile.items.unavailable, true);
        assert.strictEqual(JSON.parse(r.text).profile.badges_unavailable, true, 'Quest down too: said, not hidden');
        console.log('public profiles: all checks passed');
    } finally {
        srv.close();
        inv.close();
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
