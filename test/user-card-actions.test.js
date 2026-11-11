'use strict';
// Ask 287: the user card's actions. The card read gains viewer-aware `actions` (computed per
// request, never cached); mutes, friendships and user reports are new Network resources beside
// blocks, reusing the follow/block route shapes.
//   ov test test/user-card-actions.test.js
const assert = require('assert');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createPublicProfiles } = require('../server/profile/public');
const { createUserCards } = require('../server/profile/card');
const { setFollow } = require('../server/identity/follows');
const { setBlock } = require('../server/identity/blocks');
const { setMute } = require('../server/identity/mutes');
const { setFriend } = require('../server/identity/friends');
const cors = require('../server/public-cors');
(async () => {
    const db = getDb();
    const VIC = 'usr_01JAB2C3D4E5F6G7H8J9K0MNV1';
    const TED = 'usr_01JAB2C3D4E5F6G7H8J9K0MNT2';
    await db.prepare("INSERT INTO users(username,password_hash,display_name,subject_id,role) VALUES ('VicAct','x','Vic',?,'user'),('TedAct','x','Ted',?,'user') ON CONFLICT DO NOTHING").run(VIC, TED);
    const vic = await db.prepare("SELECT * FROM users WHERE username='VicAct'").get();
    const ted = await db.prepare("SELECT * FROM users WHERE username='TedAct'").get();
    // A fresh pair: clear any rows an earlier run left behind.
    await db.prepare('DELETE FROM user_mutes WHERE muter_subject IN (?,?) OR muted_subject IN (?,?)').run(VIC, TED, VIC, TED);
    await db.prepare('DELETE FROM user_friends WHERE user_subject IN (?,?) OR friend_subject IN (?,?)').run(VIC, TED, VIC, TED);
    await db.prepare('DELETE FROM user_reports WHERE reporter_subject IN (?,?) OR target_subject IN (?,?)').run(VIC, TED, VIC, TED);
    await db.prepare('DELETE FROM user_blocks WHERE blocker_subject IN (?,?) OR blocked_subject IN (?,?)').run(VIC, TED, VIC, TED);
    await db.prepare('DELETE FROM user_follows WHERE follower_subject IN (?,?) OR target_id IN (?,?)').run(VIC, TED, VIC, TED);
    const fetchImpl = async (url) => {
        if (url.endsWith('/badges')) return { ok: true, json: async () => ({ badges: [] }) };
        if (url.includes('/streak')) return { ok: true, json: async () => ({}) };
        return { ok: true, json: async () => ({ channel: { username: 'TedAct' }, streams: [{ id: 7 }] }) };
    };
    let viewer = null; // the stubbed viewer identify() returns
    const profiles = createPublicProfiles({ db });
    const cards = createUserCards({ db, profiles, fetchImpl, identify: async () => viewer });
    const authStub = (user) => (req, res, next) => { req.user = user; next(); };
    const app = express(); app.use(express.json());
    app.locals.db = db; app.locals.publicKey = 'x';
    app.get('/api/v1/people/:username/card', cors.publicCors, cards.api);
    const asVic = { id: vic.id, username: 'VicAct', subject_id: VIC, is_anon: false, role: 'user' };
    const asTed = { id: ted.id, username: 'TedAct', subject_id: TED, is_anon: false, role: 'user' };
    app.use('/api/v1/me/mutes', require('../server/identity/mutes').userRouter(authStub(asVic)));
    app.use('/api/v1/me/friends', require('../server/identity/friends').userRouter(authStub(asVic)));
    app.use('/api/v1/me/reports', require('../server/identity/user-reports').userRouter(authStub(asVic)));
    app.use('/api/v1/staff/user-reports', authStub(asVic), require('../server/identity/user-reports').staffRouter());
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const card = (who) => fetch(`${base}/api/v1/people/${who}/card`).then(r => r.json());
    try {
        await db.prepare("UPDATE site_settings SET value='true' WHERE key='user_card_enabled'").run();
        // Anonymous: only Profile/Channel.
        viewer = null;
        let tedCard = await card('TedAct');
        assert.deepStrictEqual(tedCard.actions, [
            { id: 'profile', label: 'Profile', href: 'https://openvibe.network/@TedAct' },
            { id: 'channel', label: 'Channel', href: 'https://openvibe.live/@TedAct' },
        ], 'anonymous card keeps Profile/Channel');
        // Own card, signed in: still only Profile/Channel.
        viewer = { subject: VIC, username: 'VicAct', role: 'user' };
        let vicCard = await card('VicAct');
        assert.deepStrictEqual(vicCard.actions.map(a => a.id), ['profile'], 'own card has no self actions (no channel without live)');
        // Viewer + other: the full set with clean state.
        viewer = { subject: VIC, username: 'VicAct', role: 'user' };
        tedCard = await card('TedAct');
        assert.deepStrictEqual(tedCard.actions.map(a => a.id),
            ['profile', 'channel', 'message', 'follow', 'add-friend', 'tip', 'watch', 'mute', 'block', 'report'],
            'viewer card lists every action, watch present while live');
        const byId = Object.fromEntries(tedCard.actions.map(a => [a.id, a]));
        assert.strictEqual(byId.follow.method, 'PUT');
        assert.strictEqual(byId.follow.path, '/api/v1/me/follows/channel/TedAct');
        assert.deepStrictEqual(byId.follow.state, { following: false });
        assert.deepStrictEqual(byId.report.body, { target: 'TedAct', reason: 'other', detail: '' });
        assert.strictEqual(byId.watch.href, 'https://openvibe.live/@TedAct');
        assert.ok(!tedCard.actions.some(a => a.id.startsWith('staff-')), 'no staff tools for a plain viewer');
        // Following flips the action to Unfollow.
        await setFollow(db, VIC, 'channel', TED, true, {});
        tedCard = await card('TedAct');
        assert.strictEqual(tedCard.actions.find(a => a.id === 'unfollow').state.following, true, 'following state is served');
        await setFollow(db, VIC, 'channel', TED, false, {});
        // Mute through its route, then the card state follows.
        assert.strictEqual((await (await fetch(`${base}/api/v1/me/mutes/TedAct`, { method: 'PUT' })).json()).mute.active, true);
        assert.strictEqual((await fetch(`${base}/api/v1/me/mutes`)).status, 200);
        tedCard = await card('TedAct');
        assert.strictEqual(tedCard.actions.find(a => a.id === 'unmute').state.muted, true, 'muted state is served');
        assert.strictEqual((await (await fetch(`${base}/api/v1/me/mutes/TedAct`, { method: 'DELETE' })).json()).mute.active, false);
        assert.strictEqual((await fetch(`${base}/api/v1/me/mutes/NoSuchPersonXYZ`, { method: 'PUT' })).status, 404, 'unknown people cannot be muted');
        assert.strictEqual((await fetch(`${base}/api/v1/me/friends/VicAct`, { method: 'PUT' })).status, 400, 'self adds are refused');
        // Friendship: none → pending → friends.
        assert.strictEqual((await (await fetch(`${base}/api/v1/me/friends/TedAct`, { method: 'PUT' })).json()).friend.state, 'pending');
        tedCard = await card('TedAct');
        assert.strictEqual(tedCard.actions.find(a => a.id === 'cancel-request').state.friendship, 'pending', 'outgoing request reads Requested');
        await setFriend(db, TED, VIC, true);
        tedCard = await card('TedAct');
        assert.strictEqual(tedCard.actions.find(a => a.id === 'unfriend').state.friendship, 'friends', 'mutual adds read Friends');
        // Report through its route, then the card state follows.
        const filed = await (await fetch(`${base}/api/v1/me/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'TedAct', reason: 'spam', detail: 'test' }) })).json();
        assert.strictEqual(filed.created, true);
        assert.strictEqual(filed.report.reason, 'spam');
        tedCard = await card('TedAct');
        assert.strictEqual(tedCard.actions.find(a => a.id === 'report').state.reported, true, 'open report is served');
        const again = await (await fetch(`${base}/api/v1/me/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'TedAct', reason: 'scam' }) })).json();
        assert.strictEqual(again.created, false, 'an open report is returned, never duplicated');
        const badReason = await fetch(`${base}/api/v1/me/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'TedAct', reason: 'bogus' }) });
        assert.strictEqual(badReason.status, 400, 'bad reasons are refused');
        const selfReport = await fetch(`${base}/api/v1/me/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'VicAct', reason: 'spam' }) });
        assert.strictEqual(selfReport.status, 400, 'self reports are refused');
        // A staff viewer sees the queue; a plain viewer is refused.
        assert.strictEqual((await fetch(`${base}/api/v1/staff/user-reports`)).status, 403, 'non-staff cannot read the queue');
        asVic.role = 'global_mod';
        const queue = await fetch(`${base}/api/v1/staff/user-reports?status=open&target=${TED}`);
        assert.strictEqual(queue.status, 200, 'a moderator reads the queue');
        const queueBody = await queue.json();
        assert.ok(queueBody.reports.some((r) => r.target === TED), 'the queue carries the open report');
        assert.strictEqual((await fetch(`${base}/api/v1/staff/user-reports?status=bogus`)).status, 400, 'a bad status is refused');
        asVic.role = 'user';
        // Blocked pair: only Unblock + Report.
        await setBlock(db, VIC, TED, true);
        tedCard = await card('TedAct');
        assert.deepStrictEqual(tedCard.actions.map(a => a.id), ['profile', 'channel', 'unblock', 'report'], 'a blocked person keeps Unblock + Report');
        await setBlock(db, VIC, TED, false);
        await setBlock(db, TED, VIC, true);
        tedCard = await card('TedAct');
        assert.deepStrictEqual(tedCard.actions.map(a => a.id), ['profile', 'channel', 'block', 'report'], 'being blocked keeps Block + Report');
        await setBlock(db, TED, VIC, false);
        // Staff tools for staff (by role).
        viewer = { subject: VIC, username: 'VicAct', role: 'global_mod', staff: require('../server/auth/staff-claims').staffClaims({ role: 'global_mod' }) };
        tedCard = await card('TedAct');
        assert.deepStrictEqual(tedCard.actions.filter(a => a.id.startsWith('staff-')).map(a => a.id), ['staff-review', 'staff-reports'], 'staff see their tools');
        console.log('user-card-actions: anonymous/self/viewer sets, follow/mute/friend/report/block states and staff tools passed');
    } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
