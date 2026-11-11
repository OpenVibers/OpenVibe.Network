'use strict';
// Ask 273, channel points: GET /api/wallet/changes?streamer= reads the person's channel points from
// Live (their Network subject only), with the same gain/loss shape, cursor and read state as the
// other currencies. Live is stubbed; its own route is covered by Live's channel-points-changes test.
//   node --import ./test/helpers/pg-preload.mjs test/wallet-channel-points.test.js
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const authRoutes = require('../server/auth/routes');
const { makeRequireAuth } = require('../server/auth/session');
const createWalletRoutes = require('../server/wallet/routes');

const ISSUER = 'https://openvibe.network';

(async () => {
    console.log('wallet channel points');
    const db = getDb();
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
    const mk = async (name) => {
        const id = (await db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id')
            .run(name, `${name}@example.test`, 'x', 'user')).lastInsertRowid;
        await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)));
        return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    };
    const ann = await mk(`cpann${Date.now() % 100000}`);
    const bob = await mk(`cpbob${Date.now() % 100000}`);
    const tok = (u) => jwt.sign({ sub: u.id, id: u.id, subject_id: u.subject_id, username: u.username, role: 'user', auth_time: Math.floor(Date.now() / 1000) - 10, iat: Math.floor(Date.now() / 1000) - 10 }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
    const annToken = tok(ann);
    const requireAuth = makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);

    const ROWS = [
        { id: 11, streamer_id: 7, at: '2026-11-01T10:00:00Z', delta: 100, reason: 'watch' },
        { id: 12, streamer_id: 7, at: '2026-11-01T11:00:00Z', delta: -30, reason: 'redeem reward 9' },
        { id: 13, streamer_id: 9, at: '2026-11-01T12:00:00Z', delta: 50, reason: 'watch' },
    ];
    const liveSeen = [];
    let liveMode = 'ok';
    const liveStub = express();
    liveStub.get('/internal/channel-points/changes', (req, res) => {
        liveSeen.push({ query: { ...req.query }, auth: req.headers.authorization });
        if (liveMode === 'down') return res.status(503).json({ error: 'down' });
        if (liveMode === 'unlinked') return res.status(404).json({ ok: false, error: 'no linked live account' });
        const streamer = Number(req.query.streamer_id);
        const since = Number(req.query.since_id || 0);
        const limit = Math.min(Number(req.query.limit || 100), 500);
        const rows = ROWS.filter((r) => r.streamer_id === streamer && r.id > since).slice(0, limit + 1);
        const page = rows.slice(0, limit);
        res.json({
            ok: true, streamer_id: streamer, balance: page.reduce((n, r) => n + r.delta, 200),
            moves: page.map((r) => ({ id: r.id, streamer_id: r.streamer_id, at: r.at, delta: r.delta, reason: r.reason })),
            cursor: page.length ? page[page.length - 1].id : since,
            next_since: rows.length > limit ? page[page.length - 1].id : null,
        });
    });
    const liveServer = liveStub.listen(0, '127.0.0.1');
    await new Promise((r) => liveServer.once('listening', r));

    const billingStub = express();
    billingStub.get('/api/me/balances/changes', (req, res) => res.json({ currency: 'vibes', balance: { credit: 0, payable: 0 }, since: null, moves: [], parts: { earned: 0, spent: 0, received: 0, sent: 0 }, net: 0, cursor: null, next_since: null, read_cursor: null }));
    const billingServer = billingStub.listen(0, '127.0.0.1');
    await new Promise((r) => billingServer.once('listening', r));

    const app = express();
    app.use('/api/wallet', createWalletRoutes(db, requireAuth, {
        billingUrl: `http://127.0.0.1:${billingServer.address().port}`,
        liveUrl: `http://127.0.0.1:${liveServer.address().port}`,
        selfToken: () => 'tok-live',
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/wallet/changes`;
    const get = async (token, q = '') => {
        const r = await fetch(`${base}${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const putRead = async (token, body) => {
        const r = await fetch(`${base}/read`, { method: 'PUT', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    let failures = 0;
    const check = async (name, fn) => {
        try { await fn(); console.log('  ✓', name); }
        catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); }
    };

    await check('a gain and a loss on the channel, with plain words', async () => {
        const { status, body } = await get(annToken, '?streamer=7');
        assert.strictEqual(status, 200);
        const cp = body.channel_points;
        assert.strictEqual(cp.currency, 'channel-points');
        assert.strictEqual(cp.streamer, 7);
        assert.strictEqual(cp.balance, 270);
        assert.strictEqual(cp.moves.length, 2);
        assert.strictEqual(cp.moves[0].delta, 100);
        assert.strictEqual(cp.moves[0].part, 'earned');
        assert.ok(cp.moves[0].label, 'a plain-words reason rides along');
        assert.strictEqual(cp.moves[1].part, 'spent');
        assert.deepStrictEqual(cp.parts, { earned: 100, spent: -30, received: 0, sent: 0 });
        assert.strictEqual(cp.net, 70);
        assert.strictEqual(body.state.channel_points, 'open');
        assert.strictEqual(liveSeen[0].auth, 'Bearer tok-live', 'Live gets the service token, never the person’s');
        assert.strictEqual(liveSeen[0].query.network_user_id, ann.subject_id, 'Live is asked for the caller only');
    });

    await check('a cursor pages, and another channel is its own window', async () => {
        const { body } = await get(annToken, '?streamer=7&limit=1');
        assert.strictEqual(body.channel_points.moves.length, 1);
        assert.strictEqual(body.channel_points.next_since, 11);
        const rest = await get(annToken, '?streamer=7&since_channel_points=11');
        assert.strictEqual(rest.body.channel_points.moves.length, 1);
        assert.strictEqual(rest.body.channel_points.moves[0].delta, -30);
        const other = await get(annToken, '?streamer=9');
        assert.strictEqual(other.body.channel_points.moves.length, 1, 'channel 9 is a separate window');
        assert.strictEqual((await get(annToken, '?streamer=x')).body.channel_points, null);
    });

    await check("another person's points are unreachable: Live is asked for the caller only", async () => {
        const before = liveSeen.length;
        await get(tok(bob), '?streamer=7');
        assert.strictEqual(liveSeen.length, before + 1);
        assert.strictEqual(liveSeen[liveSeen.length - 1].query.network_user_id, bob.subject_id);
        assert.strictEqual((await get(null, '?streamer=7')).status, 401);
    });

    await check('read state: marking read empties "since I last looked", and it only moves forward', async () => {
        const marked = await putRead(annToken, { currency: 'channel-points', streamer: 7, cursor: 12 });
        assert.strictEqual(marked.status, 200);
        assert.strictEqual(marked.body.read_cursor, 12);
        const after = await get(annToken, '?streamer=7');
        assert.strictEqual(after.body.channel_points.moves.length, 0, 'nothing since the look');
        assert.strictEqual(after.body.channel_points.read_cursor, 12);
        assert.strictEqual((await putRead(annToken, { currency: 'channel-points', streamer: 7, cursor: 11 })).status, 409, 'looking backwards is refused');
        assert.strictEqual((await putRead(annToken, { currency: 'channel-points', streamer: 7, cursor: 'x' })).status, 422);
        assert.strictEqual((await putRead(annToken, { currency: 'channel-points', cursor: 12 })).status, 422, 'marking needs its channel');
    });

    await check('Live down or unlinked nulls the part and says so; the rest still draws', async () => {
        liveMode = 'down';
        const down = await get(annToken, '?streamer=7');
        assert.strictEqual(down.body.channel_points, null);
        assert.strictEqual(down.body.state.channel_points, 'unavailable');
        assert.notStrictEqual(down.body.opencoins, null);
        liveMode = 'unlinked';
        const unlinked = await get(annToken, '?streamer=7');
        assert.strictEqual(unlinked.body.channel_points, null);
        assert.strictEqual(unlinked.body.state.channel_points, 'unlinked');
        liveMode = 'ok';
        const none = await get(annToken);
        assert.strictEqual(none.body.channel_points, null);
        assert.strictEqual(none.body.state.channel_points, 'needs_streamer');
    });

    server.close(); liveServer.close(); billingServer.close();
    if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
    console.log('all passed');
    process.exit(0);
})();
