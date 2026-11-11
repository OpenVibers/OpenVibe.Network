'use strict';
// /api/frame/wallet/…: the shared wallet sheet's Billing and Inventory calls on every site, relayed through Network
// because every site's connect-src lets the navbar reach openvibe.network and refuses billing./inventory.openvibe.network
// (2026-11-09). Only the person's Bearer token goes upstream, never a cookie; fixed paths; JSON bodies at most 8 KB;
// upstream status and body pass back; nothing is cached.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

const USR = 'usr_01JZ00000000000000000000A1';
const ITD = 'itd_01JZ00000000000000000000B1';

(async () => {
    const asked = [];
    let down = false;
    const stub = (name, handler) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                asked.push({ svc: name, method: req.method, url: req.url, auth: req.headers.authorization || '', cookie: req.headers.cookie || '', body });
                if (down) { res.statusCode = 503; return res.end('{"error":"down"}'); }
                res.setHeader('content-type', 'application/json');
                handler(req, res, new URL(req.url, 'http://x'), body);
            });
        });
        return server;
    };
    const billing = stub('billing', (req, res, u) => {
        if (u.pathname === '/api/v1/me/wallet' && req.method === 'GET') return res.end(JSON.stringify({ subject: { type: 'user', id: USR }, balances: { coins: { amount: '1', scale: 0, currency: 'opencoins' } }, checkout: { providers: [{ name: 'stripe', hosts: ['checkout.stripe.com'] }] } }));
        if (u.pathname === '/api/v1/me/vibes/buy' && req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ checkout_url: 'https://checkout.stripe.com/c/pay/x', intent: { id: 'pin_1' } })); }
        if (u.pathname === '/api/v1/me/wallet/topups' && req.method === 'POST') { res.statusCode = 402; return res.end(JSON.stringify({ detail: 'Choose an offered top-up' })); }
        res.statusCode = 404; return res.end('{"error":"no route"}');
    });
    const inventory = stub('inventory', (req, res, u) => {
        if (u.pathname === '/api/v1/me/items') return res.end(JSON.stringify({ instances: [{ id: 'inv_1' }], definitions: {}, next_cursor: 'c2' }));
        if (u.pathname === `/api/v1/people/${USR}/equipped`) return res.end(JSON.stringify({ subject: USR, slots: { 'live.hat:hat': null } }));
        if (u.pathname === '/api/v1/me/equipped' && req.method === 'PUT') return res.end(JSON.stringify({ subject: USR, slots: {} }));
        if (u.pathname === '/api/v1/store') return res.end(JSON.stringify({ items: [{ id: ITD, name: 'Crown', prices: { vibes: 5 } }] }));
        if (u.pathname === `/api/v1/store/${ITD}/buy` && req.method === 'POST') return res.end(JSON.stringify({ status: 'fulfilled' }));
        if (u.pathname === '/api/v1/kinds') return res.end(JSON.stringify({ kinds: [{ id: 'live.hat', slots: ['hat'] }] }));
        res.statusCode = 404; return res.end('{"error":"no route"}');
    });
    const network = stub('network', (req, res, u, body) => {
        if (u.pathname === '/api/wallet/changes' && req.method === 'GET') return res.end(JSON.stringify({ opencoins: { net: 5, cursor: 42, moves: [{ id: 42, delta: 5, label: 'For a quest' }] }, vibes: null, channel_points: null }));
        if (u.pathname === '/api/wallet/changes/read' && req.method === 'PUT') return res.end(JSON.stringify({ currency: JSON.parse(body).currency, read_cursor: JSON.parse(body).cursor }));
        res.statusCode = 404; return res.end('{"error":"no route"}');
    });
    await Promise.all([billing, inventory, network].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
    const svc = await createFrameService(getDb(), { services: {
        billing: { internalUrl: `http://127.0.0.1:${billing.address().port}` },
        inventory: { internalUrl: `http://127.0.0.1:${inventory.address().port}` },
        network: { internalUrl: `http://127.0.0.1:${network.address().port}` },
    } }, null);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame`;
    const token = 'Bearer abcdefghijklmnop.qrstu';
    const get = async (p, headers) => { const r = await fetch(`${base}${p}`, { headers }); return { r, d: await r.json() }; };
    const send = async (p, method, body, headers = {}) => {
        const r = await fetch(`${base}${p}`, { method, headers: { Authorization: token, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        return { r, d: await r.json().catch(() => null) };
    };

    // The wallet read: the person's token upstream, never their cookie, and never kept.
    let { r, d } = await get('/wallet/api/v1/me/wallet', { Authorization: token, Cookie: 'ov_session=secret' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(d.subject.id, USR);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'any site may ask');
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store', 'a personal answer is not kept');
    const wallet = asked.find((x) => x.url.startsWith('/api/v1/me/wallet') && x.method === 'GET');
    assert.strictEqual(wallet.auth, token, "the person's token goes along");
    assert.strictEqual(wallet.cookie, '', 'a cookie never does');

    ({ r, d } = await get('/wallet/api/v1/me/wallet'));
    assert.strictEqual(r.status, 401, 'no token, no wallet');
    assert.strictEqual(asked.filter((x) => x.url.startsWith('/api/v1/me/wallet')).length, 1, 'and nothing is asked upstream');

    // A site with its own cookie session has no token for the navbar: the person's Network cookie (ov_token) is the
    // token, sent upstream as the Bearer and never as a cookie; the answer keeps the allow-list's echoed Origin.
    const session = 'abcdefghijklmnop.cookie';
    ({ r, d } = await get('/wallet/api/v1/me/wallet', { Cookie: `ov_sso=x; ov_token=${session}`, Origin: 'https://openvibe.events' }));
    assert.strictEqual(r.status, 200);
    const viaCookie = asked.filter((x) => x.url.startsWith('/api/v1/me/wallet')).at(-1);
    assert.strictEqual(viaCookie.auth, `Bearer ${session}`, "the person's session token goes along as the Bearer");
    assert.strictEqual(viaCookie.cookie, '', 'the cookie itself never does');
    assert.notStrictEqual(r.headers.get('access-control-allow-origin'), '*', "a credentialed answer is never '*'");
    const askedBefore = asked.length;
    ({ r } = await send('/wallet/api/v1/me/vibes/buy', 'POST', { pack: 'vibes_500' }, { Authorization: '', Cookie: `ov_token=${session}` }));
    assert.strictEqual(r.status, 401, 'a write by cookie needs an Origin');
    ({ r } = await get('/wallet/api/v1/me/wallet', { Cookie: `ov_token=${session}`, Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }));
    assert.strictEqual(r.status, 401, 'never from an extension page');
    ({ r } = await get('/wallet/api/v1/me/wallet', { Cookie: 'ov_token=short' }));
    assert.strictEqual(r.status, 401, 'a malformed cookie is no token');
    assert.strictEqual(asked.length, askedBefore, 'none of these asked upstream');

    // Change reads keep their three cursor types and streamer, while unrelated input never reaches Network.
    const vibesCursor = 'txn_01JZ00000000000000000000A1';
    ({ r, d } = await get(`/wallet/changes?since_vibes=${vibesCursor}&since_opencoins=41&streamer=7&since_channel_points=9&limit=10&subject=usr_other`, { Authorization: token }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(d.opencoins.net, 5);
    const changes = asked.at(-1), query = new URL(changes.url, 'http://x').searchParams;
    assert.strictEqual(changes.svc, 'network');
    assert.strictEqual(changes.auth, token);
    assert.strictEqual(changes.cookie, '');
    assert.deepStrictEqual([...query.keys()].sort(), ['limit', 'since_channel_points', 'since_opencoins', 'since_vibes', 'streamer']);
    assert.strictEqual(query.get('since_vibes'), vibesCursor);
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    ({ r } = await get('/wallet/changes'));
    assert.strictEqual(r.status, 401);
    ({ r } = await send('/wallet/changes/read', 'PUT', { currency: 'opencoins', cursor: 42 }));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(asked.at(-1).body), { currency: 'opencoins', cursor: 42 });
    ({ r } = await send('/wallet/changes/read', 'PUT', { currency: 'vibes', cursor: vibesCursor }, { Authorization: '', Cookie: `ov_token=${session}`, Origin: 'https://openvibe.events' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(asked.at(-1).auth, `Bearer ${session}`);
    assert.notStrictEqual(r.headers.get('access-control-allow-origin'), '*');
    ({ r } = await send('/wallet/changes/read', 'PUT', { currency: 'vibes', cursor: vibesCursor }, { Authorization: '', Cookie: `ov_token=${session}` }));
    assert.strictEqual(r.status, 401, 'a cookie write without Origin is refused');

    // A page limit and cursor pass; every other query is dropped.
    ({ r } = await get('/wallet/api/v1/me/items?limit=500&cursor=c1&subject=usr_other', { Authorization: token }));
    assert.strictEqual(r.status, 200);
    const items = new URL(asked[asked.length - 1].url, 'http://x');
    assert.deepStrictEqual([items.pathname, items.searchParams.get('limit'), items.searchParams.get('cursor'), items.searchParams.has('subject')], ['/api/v1/me/items', '100', 'c1', false]);

    // A checkout: the JSON body goes up and Billing's status and body come back as they are.
    ({ r, d } = await send('/wallet/api/v1/me/vibes/buy', 'POST', { provider: 'stripe', vibes: 100, idempotency_key: 'k1' }));
    assert.strictEqual(r.status, 201);
    assert.strictEqual(d.checkout_url, 'https://checkout.stripe.com/c/pay/x');
    const buy = asked[asked.length - 1];
    assert.deepStrictEqual([buy.method, buy.auth, JSON.parse(buy.body)], ['POST', token, { provider: 'stripe', vibes: 100, idempotency_key: 'k1' }]);

    ({ r, d } = await send('/wallet/api/v1/me/wallet/topups', 'POST', { provider: 'stripe', amount_cents: 1 }));
    assert.strictEqual(r.status, 402, "Billing's refusal is passed back");
    assert.strictEqual(d.detail, 'Choose an offered top-up');

    // Equipping is a PUT with a body; the store, kinds and a person's worn slots are public reads.
    ({ r } = await send('/wallet/api/v1/me/equipped', 'PUT', { kind: 'live.hat', slot: 'hat', instance_id: 'inv_1' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(asked[asked.length - 1].method, 'PUT');
    ({ d } = await get(`/wallet/api/v1/people/${USR}/equipped`));
    assert.strictEqual(d.subject, USR);
    assert.strictEqual(asked[asked.length - 1].auth, '', 'a public read asks anonymously');
    ({ d } = await get('/wallet/api/v1/store'));
    assert.strictEqual(d.items[0].id, ITD);
    ({ d } = await get('/wallet/api/v1/kinds'));
    assert.strictEqual(d.kinds[0].id, 'live.hat');

    ({ r } = await send(`/wallet/api/v1/store/${ITD}/buy`, 'POST', { currency: 'vibes', idempotency_key: 'k2' }));
    assert.strictEqual(r.status, 200);
    const before = asked.length;
    ({ r } = await send('/wallet/api/v1/store/itd_bad/buy', 'POST', {}));
    assert.strictEqual(r.status, 404, 'a malformed item id never reaches Inventory');
    ({ r } = await get('/wallet/api/v1/people/not-a-subject/equipped'));
    assert.strictEqual(r.status, 404, 'a malformed person id never reaches Inventory');
    assert.strictEqual(asked.length, before, 'neither asked upstream');

    const foreign = await fetch(`${base}/wallet/api/v1/admin`, { headers: { Authorization: token } });
    assert.strictEqual(foreign.status, 404, 'only the sheet paths exist');

    const big = await fetch(`${base}/wallet/api/v1/me/vibes/buy`, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(9000) }) });
    assert.strictEqual(big.status, 413, 'a body over 8 KB is refused');

    const pre = await fetch(`${base}/wallet/api/v1/me/equipped`, { method: 'OPTIONS', headers: { Origin: 'https://openvibe.live', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization, content-type' } });
    assert.strictEqual(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers') || '', /Authorization/i);
    assert.match(pre.headers.get('access-control-allow-methods') || '', /PUT/);

    down = true;
    ({ r, d } = await get('/wallet/api/v1/me/wallet', { Authorization: token }));
    assert.strictEqual(r.status, 503, "an upstream refusal is passed back, never turned into an empty wallet");

    await new Promise((r) => billing.close(r));
    ({ r, d } = await get('/wallet/api/v1/me/wallet', { Authorization: token }));
    assert.strictEqual(r.status, 502, 'a service that does not answer is a failure, never an empty wallet');
    assert.match(d.error, /did not answer/);

    server.close(); inventory.close(); network.close();
    console.log('frame wallet: fixed paths, bearer only, no cache, 8 KB bodies, statuses back, bad ids and foreign paths refused');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
