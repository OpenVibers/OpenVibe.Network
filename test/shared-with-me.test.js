'use strict';
// Sharing on OpenVibe: Network's part (design 2026-11-06, SHARING-DESIGN-2026-11-06.md).
//
// The share events (share.granted, share.revoked, share.transfer.*) arrive over OpenVibe.Events and
// build two things: the list of what is shared with this person (GET /api/v1/shared-with-me, the
// /shared page) and the notifications about it. The picker's suggestions (GET /api/v1/share/suggestions)
// come from the same events and belong to one person alone; the @name check the picker uses
// (GET /api/v1/share/name-check) has a budget per person, so nobody can walk the network's accounts.
//
//   node test/shared-with-me.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { getDb } = require('../server/db/database');
const { NotificationService } = require('../server/notifications/notification-service');
const { createEventsConsumer } = require('../server/notifications/events-consumer');
const { createSharingApi } = require('../server/sharing/routes');
const { createSharedPage } = require('../server/sharing/page');
const { NAME_CHECK_LIMIT } = require('../server/sharing/routes');

(async () => {
const db = getDb();
const log = console.log; console.log = () => {};
const notifications = new NotificationService(db);
console.log = log;

const ALICE = ids.newId('user'), BOB = ids.newId('user');
await db.prepare("INSERT INTO users (id, username, display_name, password_hash, subject_id, email, email_verified) VALUES (7, 'alice', 'Alice', 'x', ?, 'alice@example.test', 1), (8, 'bob', 'Bob', 'x', ?, NULL, 0)").run(ALICE, BOB);

const SECRET = 's'.repeat(40);
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' }, baseUrl: 'https://openvibe.network', services: {} };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);

// The owning service: it answers the uniform share API only for a viewer that brings a token, and
// names the item. Network asks it on the person's behalf (server/sharing/item.js).
const items = {
    'paste/pst_1': { title: 'LOOI bridge notes', url: 'https://openvibe.community/p/pst_1' },
    'paste/pst_2': { title: 'Second paste', url: 'https://openvibe.community/p/pst_2' },
};
const owner = express();
owner.get('/api/v1/:kind/:id/share', (req, res) => {
    if (!/^Bearer /.test(String(req.headers.authorization || ''))) return res.status(401).json({ error: 'auth.required' });
    const item = items[req.params.kind + '/' + req.params.id];
    if (!item) return res.status(404).json({ error: 'not.found' });
    res.json({ audience: 'people', title: item.title, url: item.url, members: [] });
});
const ownerServer = http.createServer(owner);
await new Promise((r) => ownerServer.listen(0, '127.0.0.1', r));
const ownerBase = 'http://127.0.0.1:' + ownerServer.address().port;

const sharingCtx = {
    db, notifications, config, privateKey: keys.privateKey, issuer: config.jwt.issuer,
    serviceBase: () => ownerBase,
};

const consumer = await createEventsConsumer({
    db, notifications, secrets: SECRET,
    sharing: { apply: (event) => require('../server/sharing/events').applyShareEvent(sharingCtx, event) },
});
const app = express();
app.use('/internal/events', (req, res, next) => consumer.router(req, res, next));
app.use(express.json());
app.use('/api/v1', createSharingApi({ ...sharingCtx, requireAuth }));
app.get('/shared', createSharedPage({ ...sharingCtx, authCtx: { db, publicKey: keys.publicKey, config } }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const tok = async (id) => signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);
const as = async (id) => ({ authorization: 'Bearer ' + await tok(id) });
const call = async (method, path, { body, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const post = async (event) => {
    const raw = JSON.stringify({ event, seq: 1 });
    const r = await fetch(base + '/internal/events', { method: 'POST', headers: { 'content-type': 'application/json', ...signDeliveryHeaders(raw, SECRET) }, body: raw });
    return { status: r.status, body: await r.json() };
};
const shareEvent = (type, payload, over = {}) => ({
    event_id: ids.newId('event'), event_type: type, version: 1, source: 'community',
    actor: { type: 'user', id: BOB }, subject: { type: 'user', id: BOB }, visibility: 'internal',
    occurred_at: new Date().toISOString(), payload, ...over,
});
const inbox = async (userId) => await db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at, seq').all(userId);

(async () => {
    try {
        // ── share.granted: the item joins the list, and the person is told ──
        const granted = shareEvent('share.granted', {
            resource: { service: 'community', kind: 'paste', id: 'pst_1' },
            member: { subject: ALICE, role: 'editor', expires_at: null, added_by: BOB, added_at: '2026-11-06T09:12:00.000Z' },
        });
        let r = await post(granted);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.outcome, 'notified', JSON.stringify(r.body));

        let mine = await inbox(7);
        assert.strictEqual(mine.length, 1, 'one notification for the person who was added');
        assert.strictEqual(mine[0].type, 'share.added');
        assert.strictEqual(mine[0].title, 'Shared with you');
        assert.strictEqual(mine[0].message, '@bob shared "LOOI bridge notes" with you.', 'plain words, the item named');
        assert.strictEqual(mine[0].url, 'https://openvibe.community/p/pst_1', 'the item link');
        assert.strictEqual(mine[0].sender_name, 'Bob');

        // The list, from the events.
        r = await call('GET', '/api/v1/shared-with-me', { headers: await as(7) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.items.length, 1);
        const item = r.body.items[0];
        assert.strictEqual(item.service, 'community');
        assert.strictEqual(item.kind, 'paste');
        assert.strictEqual(item.id, 'pst_1');
        assert.strictEqual(item.title, 'LOOI bridge notes', 'the name comes from the owning service');
        assert.strictEqual(item.url, 'https://openvibe.community/p/pst_1');
        assert.strictEqual(item.site.full_name, 'OpenVibe.Community', 'the site it is on');
        assert.strictEqual(item.owner.username, 'bob', 'who shared it');
        assert.strictEqual(item.role, 'editor', 'the role');
        assert.ok(item.shared_at, 'when it was shared');

        // It is private: Bob's list is his own.
        r = await call('GET', '/api/v1/shared-with-me', { headers: await as(8) });
        assert.strictEqual(r.body.items.length, 0, 'the list is the person\'s own');
        r = await call('GET', '/api/v1/shared-with-me');
        assert.strictEqual(r.status, 401, 'signed in only');

        // The page, for the same person.
        const page = await fetch(base + '/shared', { headers: await as(7) });
        assert.strictEqual(page.status, 200);
        const html = await page.text();
        assert.ok(html.includes('LOOI bridge notes'), 'the page names the item');
        assert.ok(html.includes('OpenVibe.Community'), 'the page names the site');
        assert.ok(html.includes('@bob'), 'the page names who shared it');
        assert.ok(html.includes('Can edit'), 'the page says the role');
        // On a phone the kit's row would cut the item's name and the words under it: the page carries
        // its own rule for that, scoped to itself.
        assert.ok(html.includes('ovk-shared'), 'the page scopes its own phone rule');
        assert.ok(html.includes('max-width:480px'), 'the phone rule is on the page');
        assert.ok(html.includes('ovk-row-trail'), 'the phone rule moves the trail');
        const anon = await fetch(base + '/shared');
        assert.strictEqual(anon.status, 200);
        assert.ok((await anon.text()).includes('Sign in'), 'signed out, the page asks to sign in');

        // ── share.revoked: the item leaves the list ──
        r = await post(shareEvent('share.revoked', {
            resource: { service: 'community', kind: 'paste', id: 'pst_1' },
            member: { subject: ALICE, added_by: BOB },
        }));
        assert.strictEqual(r.body.outcome, 'revoked');
        r = await call('GET', '/api/v1/shared-with-me', { headers: await as(7) });
        assert.strictEqual(r.body.items.length, 0, 'the revoked item is gone');

        // ── a transfer: pending, then answered ──
        const transfer = { transfer_id: 'sht_1', resource: { service: 'community', kind: 'paste', id: 'pst_2' }, from: BOB, to: ALICE, keep_access: false, requested_at: '2026-11-06T10:00:00.000Z', expires_at: '2026-11-13T10:00:00.000Z' };
        r = await post(shareEvent('share.transfer.requested', transfer));
        assert.strictEqual(r.body.outcome, 'notified');
        mine = await inbox(7);
        const offer = mine.find((n) => n.type === 'share.transfer.requested');
        assert.ok(offer, 'the recipient is told');
        assert.strictEqual(offer.message, '@bob wants to give you "Second paste".');
        assert.strictEqual(offer.url, 'https://openvibe.community/p/pst_2');

        r = await call('GET', '/api/v1/shared-with-me', { headers: await as(7) });
        assert.strictEqual(r.body.transfers.length, 1, 'the transfer waits for an answer');
        const t = r.body.transfers[0];
        assert.strictEqual(t.state, 'pending');
        assert.strictEqual(t.from.username, 'bob');
        assert.strictEqual(t.accept_url, 'https://openvibe.community/p/pst_2?share=accept', 'Accept links to the item');
        assert.strictEqual(t.decline_url, 'https://openvibe.community/p/pst_2?share=decline', 'Decline links to the item');

        // The old owner is told when the answer comes.
        r = await post(shareEvent('share.transfer.accepted', { ...transfer, accepted_at: '2026-11-06T11:00:00.000Z' }));
        assert.strictEqual(r.body.outcome, 'notified');
        const bobs = await inbox(8);
        const answered = bobs.find((n) => n.type === 'share.transfer.answered');
        assert.ok(answered, 'the old owner is told');
        assert.strictEqual(answered.message, '@alice accepted "Second paste". It is theirs now.');
        r = await call('GET', '/api/v1/shared-with-me', { headers: await as(7) });
        assert.strictEqual(r.body.transfers.length, 0, 'the answered transfer is not pending any more');

        // ── a declined transfer changes nothing ──
        const transfer2 = { transfer_id: 'sht_2', resource: { service: 'community', kind: 'paste', id: 'pst_2' }, from: BOB, to: ALICE, keep_access: true, requested_at: '2026-11-06T12:00:00.000Z' };
        r = await post(shareEvent('share.transfer.requested', transfer2));
        assert.strictEqual(r.body.outcome, 'notified');
        r = await post(shareEvent('share.transfer.declined', { ...transfer2, declined_at: '2026-11-06T12:30:00.000Z' }));
        assert.strictEqual(r.body.outcome, 'notified');
        const bobs2 = await inbox(8);
        assert.ok(bobs2.some((n) => n.type === 'share.transfer.answered' && n.message.includes('declined')), 'the old owner is told');
        r = await call('GET', '/api/v1/shared-with-me', { headers: await as(7) });
        assert.strictEqual(r.body.transfers.length, 0, 'a declined transfer is not pending');

        // ── share.access.requested: the owner is told ──
        r = await post(shareEvent('share.access.requested', { resource: { service: 'community', kind: 'paste', id: 'pst_1' }, from: ALICE, to: BOB }));
        assert.strictEqual(r.body.outcome, 'notified');
        const bobs3 = await inbox(8);
        const asked = bobs3.find((n) => n.type === 'share.access_requested');
        assert.ok(asked, 'the owner is told');
        assert.strictEqual(asked.message, '@alice asked for access to "LOOI bridge notes".');

        // ── the suggestions: only from this person's own history, and private ──
        r = await call('GET', '/api/v1/share/suggestions', { headers: await as(8) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.people.length, 1, 'Bob shared with Alice, so Alice is a suggestion');
        assert.strictEqual(r.body.people[0].username, 'alice');
        r = await call('GET', '/api/v1/share/suggestions', { headers: await as(7) });
        assert.strictEqual(r.body.people.length, 0, 'Alice shared with nobody');
        r = await call('GET', '/api/v1/share/suggestions');
        assert.strictEqual(r.status, 401, 'signed in only');

        // ── the @name check: one budget per person ──
        r = await call('GET', '/api/v1/share/name-check?name=bob', { headers: await as(7) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.exists, true);
        assert.strictEqual(r.body.username, 'bob');
        r = await call('GET', '/api/v1/share/name-check?name=@bob', { headers: await as(7) });
        assert.strictEqual(r.body.exists, true, 'a leading @ is the same name');
        r = await call('GET', '/api/v1/share/name-check?name=nobodyhere', { headers: await as(7) });
        assert.strictEqual(r.body.exists, false, 'no such account');

        // The budget: thirty checks a minute, for this person only.
        await db.prepare('DELETE FROM share_name_checks WHERE user_id = ?').run(7);
        for (let i = 0; i < NAME_CHECK_LIMIT; i++) {
            const c = await call('GET', '/api/v1/share/name-check?name=bob', { headers: await as(7) });
            assert.strictEqual(c.status, 200, 'check ' + i + ' is inside the budget');
        }
        r = await call('GET', '/api/v1/share/name-check?name=bob', { headers: await as(7) });
        assert.strictEqual(r.status, 429, 'the budget stops the walking of accounts');
        assert.strictEqual(r.body.code, 'share.too_many_checks');
        // Bob's own budget is his own.
        r = await call('GET', '/api/v1/share/name-check?name=alice', { headers: await as(8) });
        assert.strictEqual(r.status, 200, 'the budget is per person');

        console.log('sharing: the list, the transfers, the notifications, the suggestions and the name-check budget are all checked');
        process.exit(0);
    } catch (err) {
        console.error('sharing test failed:', err);
        process.exit(1);
    }
})();
})();
