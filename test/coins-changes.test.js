'use strict';
// Ask 273, Network part: GET /api/coins/me/changes (a gain, a loss, a cursor, another person's
// balance refused) and PUT /api/coins/me/read (the person's own read state), plus the
// network.balance.changed subject-visible message a wallet move enqueues for an open page.
//   node --import ./test/helpers/pg-preload.mjs test/coins-changes.test.js
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const authRoutes = require('../server/auth/routes');
const { makeRequireAuth } = require('../server/auth/session');
const createCoinsRoutes = require('../server/coins/routes');
const createWalletRoutes = require('../server/wallet/routes');
const wallet = require('../server/coins/wallet');

const ISSUER = 'https://openvibe.network';

(async () => {
    console.log('coins changes');
    const db = getDb();
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
    const mk = async (name) => {
        const id = (await db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id')
            .run(name, `${name}@example.test`, 'x', 'user')).lastInsertRowid;
        await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)));
        return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    };
    const ann = await mk(`ann${Date.now() % 100000}`);
    const bob = await mk(`bob${Date.now() % 100000}`);
    const tok = (u) => jwt.sign({ sub: u.id, id: u.id, subject_id: u.subject_id, username: u.username, role: 'user', auth_time: Math.floor(Date.now() / 1000) - 10, iat: Math.floor(Date.now() / 1000) - 10 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
    const annToken = tok(ann);
    const bobToken = tok(bob);
    const requireAuth = makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);

    const billingSeen = [];
    let billingMode = 'ok';
    const billingStub = express();
    billingStub.use(express.json());
    billingStub.get('/api/me/balances/changes', (req, res) => {
        billingSeen.push({ url: req.url, auth: req.headers.authorization });
        if (billingMode === 'down') return res.status(503).json({ error: 'down' });
        if (billingMode === 'shadow') return res.status(409).json({ code: 'billing.not_authoritative' });
        res.json({ currency: 'vibes', balance: { credit: 400, payable: 0 }, since: null, moves: [], parts: { earned: 0, spent: 0, received: 0, sent: 0 }, net: 0, cursor: 'txn_stub', next_since: null, read_cursor: null });
    });
    billingStub.put('/api/me/balances/read', (req, res) => {
        billingSeen.push({ url: req.url, auth: req.headers.authorization, body: req.body });
        res.json({ currency: 'vibes', read_cursor: req.body && req.body.cursor });
    });
    const billingServer = billingStub.listen(0, '127.0.0.1');
    await new Promise((r) => billingServer.once('listening', r));

    const app = express();
    app.use('/api/coins', createCoinsRoutes(db, requireAuth, {}));
    app.use('/api/wallet', createWalletRoutes(db, requireAuth, { billingUrl: `http://127.0.0.1:${billingServer.address().port}` }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (token, q = '') => {
        const r = await fetch(`${base}/api/coins/me/changes${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const putRead = async (token, body) => {
        const r = await fetch(`${base}/api/coins/me/read`, { method: 'PUT', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    const credited = await wallet.credit(db, { user_id: ann.id, app_id: 'quest', amount: 250, reason: 'quest:publish-video', idempotency_key: `k-${Date.now()}-1` });
    assert.strictEqual(credited.balance, 250);
    const moved = await wallet.transfer(db, { from_user_id: ann.id, to_user_id: bob.id, app_id: 'live', amount: 60, reason: 'tip to @bob', idempotency_key: `k-${Date.now()}-2` });
    assert.strictEqual(moved.from_balance, 190);

    let failures = 0;
    const check = async (name, fn) => {
        try { await fn(); console.log('  ✓', name); }
        catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); }
    };

    await check('a gain: quest earnings arrive earned with their plain words', async () => {
        const { status, body } = await get(annToken);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.currency, 'opencoins');
        assert.strictEqual(body.balance, 190);
        assert.strictEqual(body.moves.length, 2);
        assert.strictEqual(body.moves[0].delta, 250);
        assert.strictEqual(body.moves[0].part, 'earned');
        assert.ok(body.moves[0].label, 'a plain-words reason rides along');
        assert.ok(body.moves[0].reason_key, 'and the ledger key for support');
        assert.deepStrictEqual(body.parts, { earned: 250, spent: 0, received: 0, sent: -60 });
        assert.strictEqual(body.net, 190);
        assert.strictEqual(body.next_since, null);
    });

    await check("a loss: the tip leaves as sent, and the other side receives it", async () => {
        const { body } = await get(annToken);
        assert.strictEqual(body.moves[1].delta, -60);
        assert.strictEqual(body.moves[1].part, 'sent');
        const seen = (await get(bobToken)).body;
        assert.strictEqual(seen.moves.length, 1);
        assert.strictEqual(seen.moves[0].delta, 60);
        assert.strictEqual(seen.balance, 60);
    });

    let firstId = null;
    await check('a cursor: since replays only what came after', async () => {
        const first = (await get(annToken)).body.moves[0].id;
        firstId = first;
        const { status, body } = await get(annToken, `?since=${first}`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.since, first);
        assert.strictEqual(body.moves.length, 1);
        assert.strictEqual(body.moves[0].delta, -60);
        assert.deepStrictEqual(body.parts, { earned: 0, spent: 0, received: 0, sent: -60 });
        assert.strictEqual((await get(annToken, '?since=999999999')).status, 422, 'a made-up cursor is refused');
    });

    await check("another person's balance is refused: no user parameter, tokens only open their own", async () => {
        assert.strictEqual((await get(null)).status, 401);
        assert.strictEqual((await get('bogus')).status, 401);
        const seen = (await get(bobToken)).body.moves;
        assert.ok(seen.every((m) => m.delta === 60), 'bob never sees ann’s quest earnings');
        assert.strictEqual((await get(bobToken, '?currency=coins')).status, 422);
    });

    await check('one call for every currency: the wallet combines Billing vibes with local opencoins', async () => {
        const r = await fetch(`${base}/api/wallet/changes`, { headers: { Authorization: `Bearer ${annToken}` } });
        assert.strictEqual(r.status, 200);
        const body = await r.json();
        assert.strictEqual(body.opencoins.balance, 190, 'opencoins come from the local ledger');
        assert.strictEqual(body.opencoins.moves.length, 2);
        assert.deepStrictEqual(body.vibes.balance, { credit: 400, payable: 0 }, 'vibes come from Billing');
        assert.deepStrictEqual(body.state, { vibes: 'open', opencoins: 'open', channel_points: 'needs_streamer' });
        assert.strictEqual(body.channel_points, null, 'no channel named: no channel points');
        assert.strictEqual(billingSeen.length, 1);
        assert.strictEqual(billingSeen[0].auth, `Bearer ${annToken}`, "Billing is asked with the person's own token");
        assert.match(billingSeen[0].url, /currency=vibes/);

        const paged = await (await fetch(`${base}/api/wallet/changes?since_vibes=txn_zzz&since_opencoins=${firstId}&limit=1`, { headers: { Authorization: `Bearer ${annToken}` } })).json();
        assert.strictEqual(paged.opencoins.moves.length, 1, 'per-currency cursors page each part');
        assert.ok(billingSeen[billingSeen.length - 1].url.includes('since=txn_zzz'), 'the vibes cursor is forwarded');

        billingMode = 'down';
        const down = await (await fetch(`${base}/api/wallet/changes`, { headers: { Authorization: `Bearer ${annToken}` } })).json();
        assert.strictEqual(down.vibes, null, 'Billing down: no vibes, the coins still answer');
        assert.strictEqual(down.state.vibes, 'unavailable');
        assert.strictEqual(down.opencoins.balance, 190);
        billingMode = 'shadow';
        const shadow = await (await fetch(`${base}/api/wallet/changes`, { headers: { Authorization: `Bearer ${annToken}` } })).json();
        assert.strictEqual(shadow.state.vibes, 'not_authoritative', 'Billing in shadow names its state');
        billingMode = 'ok';

        const anon = await fetch(`${base}/api/wallet/changes`);
        assert.strictEqual(anon.status, 401, 'no token: no balances');
    });

    await check('read-marking routes per currency: vibes to Billing, opencoins here', async () => {
        const coinsMark = await putRead(annToken, { currency: 'vibes', cursor: firstId });
        assert.strictEqual(coinsMark.status, 422, 'the coins router only marks opencoins');
        const r = await fetch(`${base}/api/wallet/changes/read`, { method: 'PUT', headers: { Authorization: `Bearer ${annToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ currency: 'vibes', cursor: 'txn_abc' }) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await r.json()).read_cursor, 'txn_abc');
        const lastSeen = billingSeen[billingSeen.length - 1];
        assert.strictEqual(lastSeen.url, '/api/me/balances/read');
        assert.strictEqual(lastSeen.auth, `Bearer ${annToken}`);
        assert.deepStrictEqual(lastSeen.body, { currency: 'vibes', cursor: 'txn_abc' });
        const local = await (await fetch(`${base}/api/wallet/changes/read`, { method: 'PUT', headers: { Authorization: `Bearer ${annToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ currency: 'opencoins', cursor: firstId }) })).json();
        assert.strictEqual(local.read_cursor, firstId);
        const bad = await fetch(`${base}/api/wallet/changes/read`, { method: 'PUT', headers: { Authorization: `Bearer ${annToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ currency: 'stars', cursor: firstId }) });
        assert.strictEqual(bad.status, 422);
    });

    await check('read state: marking read empties "since I last looked", and it only moves forward', async () => {
        const last = (await get(annToken)).body.cursor;
        const marked = await putRead(annToken, { currency: 'opencoins', cursor: last });
        assert.strictEqual(marked.status, 200);
        assert.strictEqual(marked.body.read_cursor, last);
        const after = await get(annToken);
        assert.strictEqual(after.body.moves.length, 0, 'nothing since the look');
        assert.strictEqual(after.body.read_cursor, last);
        assert.strictEqual((await putRead(annToken, { currency: 'opencoins', cursor: firstId })).status, 409, 'looking backwards is refused');
        assert.strictEqual((await putRead(annToken, { currency: 'opencoins', cursor: 999999999 })).status, 422);
        assert.strictEqual((await putRead(null, { currency: 'opencoins', cursor: last })).status, 401);
    });

    await check('a wallet move enqueues network.balance.changed, subject-visible, per person', async () => {
        const rows = await db.prepare("SELECT envelope FROM network_event_outbox WHERE envelope->>'event_type' = 'network.balance.changed' ORDER BY id").all();
        const events = rows.map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope));
        assert.strictEqual(events.length, 3, `credit + transfer both sides, got ${events.length}`);
        for (const e of events) {
            assert.strictEqual(e.visibility, 'subject', 'only the person sees their own over realtime');
            assert.strictEqual(e.subject.type, 'user');
            assert.strictEqual(e.payload.currency, 'opencoins');
        }
        assert.deepStrictEqual(events.filter((e) => e.subject.id === ann.subject_id).map((e) => e.payload.delta), [250, -60]);
        assert.deepStrictEqual(events.filter((e) => e.subject.id === bob.subject_id).map((e) => e.payload.delta), [60]);
    });

    server.close();
    billingServer.close();
    if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
    console.log('all passed');
    process.exit(0);
})();
