'use strict';
// GET /api/frame/feed and /api/frame/wall: the menu's Feed and wall on every site, relayed to OpenVibe.Community, because
// every site's connect-src lets the navbar reach openvibe.network and refuses openvibe.community (2026-11-09).
const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createFrameService } = require('../server/frame/service');

(async () => {
    const asked = [];
    let down = false;
    const community = http.createServer((req, res) => {
        asked.push({ url: req.url, auth: req.headers.authorization || '', cookie: req.headers.cookie || '' });
        if (down) { res.statusCode = 503; return res.end('{}'); }
        res.setHeader('content-type', 'application/json');
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/feed') return res.end(JSON.stringify({ items: [{ id: 'p:1', kind: u.searchParams.get('kind') || 'post', url: 'https://openvibe.community/p/1', title: 'A post' }], next_cursor: 'c2' }));
        if (u.pathname === '/api/v1/feed/search') return res.end(JSON.stringify({ items: [{ id: 'p:2', title: u.searchParams.get('q') }], next_cursor: null }));
        if (u.pathname === '/api/v1/feed/examples') return res.end(JSON.stringify({ examples: [{ text: 'New photos', reason: 'kind' }] }));
        if (u.pathname === '/api/v1/me/status' && req.method === 'POST') { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { asked.push({ url: req.url, auth: req.headers.authorization || '', body }); res.statusCode = req.headers.authorization ? 201 : 401; res.end(JSON.stringify({ ok: true })); }); return undefined; }
        if ((u.pathname === '/api/v1/spaces/status/attachments' || u.pathname === '/api/v1/posts') && req.method === 'POST') {
            const chunks = []; req.on('data', (c) => chunks.push(c));
            req.on('end', () => { const body = Buffer.concat(chunks); asked.push({ url: req.url, auth: req.headers.authorization || '', cookie: req.headers.cookie || '', type: req.headers['content-type'] || '', size: body.length, text: body.toString('utf8').slice(0, 400) });
                res.statusCode = 201; res.end(u.pathname === '/api/v1/posts' ? '{"id":7,"post_id":9}' : '{"attachment":{"media_id":"med_01ABCDEFGHJKMNPQRSTVWXYZ01"}}'); });
            return;
        }
        if (u.pathname === '/api/v1/pulse') return res.end(JSON.stringify({ items: [{ id: 1, title: 'ada went live' }], next_cursor: null, viewer: { can_post: !!req.headers.authorization } }));
        res.statusCode = 404; return res.end('{}');
    });
    await new Promise((r) => community.listen(0, '127.0.0.1', r));
    const svc = await createFrameService(getDb(), { services: { community: { internalUrl: `http://127.0.0.1:${community.address().port}` } } }, null);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/frame', svc.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/frame`;
    const get = async (p, headers) => { const r = await fetch(`${base}${p}`, { headers }); return { r, d: await r.json() }; };

    let { r, d } = await get('/feed?kind=clip&limit=12&cursor=c1');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'any site may ask');
    assert.deepStrictEqual(d.items.map((x) => x.kind), ['clip']);
    assert.strictEqual(d.next_cursor, 'c2');
    const first = new URL(asked[0].url, 'http://x');
    assert.deepStrictEqual([first.pathname, first.searchParams.get('kind'), first.searchParams.get('limit'), first.searchParams.get('cursor')], ['/api/v1/feed', 'clip', '12', 'c1']);
    ({ r, d } = await get('/feed/search?q=New%20photos'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(d.items[0].title, 'New photos');
    assert.strictEqual(new URL(asked[asked.length - 1].url, 'http://x').pathname, '/api/v1/feed/search');
    ({ r, d } = await get('/feed/examples'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(d.examples[0].text, 'New photos');

    const afterSearch = asked.length;
    ({ d } = await get('/feed?kind=clip&limit=12&cursor=c1'));
    assert.strictEqual(asked.length, afterSearch, 'the same anonymous page within 30 s is answered from memory');

    ({ r, d } = await get('/wall?limit=20&for=me', { Authorization: 'Bearer abcdefghijklmnop.qrstu', Cookie: 'ov_session=secret' }));
    const wall = asked[asked.length - 1];
    assert.strictEqual(new URL(wall.url, 'http://x').pathname, '/api/v1/pulse');
    assert.strictEqual(wall.auth, 'Bearer abcdefghijklmnop.qrstu', "the person's token goes along for their own wall");
    assert.strictEqual(wall.cookie, '', 'a cookie never does');
    assert.strictEqual(d.viewer.can_post, true);
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store', 'a personal answer is not kept');

    ({ d } = await get('/feed?kind=../admin&limit=999&cursor=<x>'));
    const odd = new URL(asked[asked.length - 1].url, 'http://x');
    assert.ok(!odd.searchParams.has('kind') && !odd.searchParams.has('cursor') && odd.searchParams.get('limit') === '40', 'an odd kind and cursor are dropped and the limit capped');

    // The new kinds and the filters reach Community; odd values do not.
    ({ d } = await get('/feed?kind=quest&site=wiki&q=%20head%0Aslider%20&following=1', { Authorization: 'Bearer abcdefghijklmnop.qrstu' }));
    const f = new URL(asked[asked.length - 1].url, 'http://x');
    assert.deepStrictEqual([f.searchParams.get('kind'), f.searchParams.get('site'), f.searchParams.get('q'), f.searchParams.get('following')], ['quest', 'wiki', 'head slider', '1'], 'kind, site, words and following pass');
    assert.strictEqual(asked[asked.length - 1].auth, 'Bearer abcdefghijklmnop.qrstu', 'following goes with the person');
    for (const k of ['wiki', 'chat', 'event', 'member', 'rundown']) { ({ d } = await get(`/feed?kind=${k}`)); assert.strictEqual(new URL(asked[asked.length - 1].url, 'http://x').searchParams.get('kind'), k, `${k} passes`); }
    ({ d } = await get('/feed?site=../x&q=' + 'a'.repeat(200) + '&following=yes'));
    const g = new URL(asked[asked.length - 1].url, 'http://x');
    assert.ok(!g.searchParams.has('site') && g.searchParams.get('q').length === 80 && !g.searchParams.has('following'), 'an odd site and following are dropped, words capped at 80');

    const pre = await fetch(`${base}/feed`, { method: 'OPTIONS', headers: { Origin: 'https://openvibe.video', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.strictEqual(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers') || '', /Authorization/i);

    const post = await fetch(`${base}/status`, { method: 'POST', headers: { Authorization: 'Bearer abcdefghijklmnop.qrstu', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
    assert.strictEqual(post.status, 201, "Community's answer comes back");
    const sent = asked.filter((x) => x.body)[0];
    assert.strictEqual(sent.auth, 'Bearer abcdefghijklmnop.qrstu');
    assert.deepStrictEqual(JSON.parse(sent.body), { text: 'hello' });
    // The composer's pictures: one multipart picture to Community's status space, then the post that names it.
    const form = new FormData(); form.append('file', new Blob([Buffer.from('\x89PNG fake')], { type: 'image/png' }), 'a.png');
    const up = await fetch(`${base}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer abcdefghijklmnop.qrstu', Cookie: 'ov_session=secret' }, body: form });
    assert.strictEqual(up.status, 201, 'the picture is stored');
    assert.strictEqual((await up.json()).attachment.media_id, 'med_01ABCDEFGHJKMNPQRSTVWXYZ01');
    const upSent = asked.filter((x) => x.url === '/api/v1/spaces/status/attachments' && x.size != null).pop();
    assert.ok(/^multipart\/form-data; *boundary=/i.test(upSent.type) && upSent.size > 0 && upSent.text.includes('PNG fake'), 'the picture goes on as it came: ' + JSON.stringify({ type: upSent.type, size: upSent.size, text: upSent.text.slice(0, 120) }));
    assert.deepStrictEqual([upSent.auth, upSent.cookie], ['Bearer abcdefghijklmnop.qrstu', ''], 'the token goes along, the cookie never');
    const posted = await fetch(`${base}/posts`, { method: 'POST', headers: { Authorization: 'Bearer abcdefghijklmnop.qrstu', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'look', pictures: [{ media_id: 'med_01ABCDEFGHJKMNPQRSTVWXYZ01', alt: 'A cat' }] }) });
    assert.strictEqual(posted.status, 201);
    assert.deepStrictEqual(JSON.parse(asked.filter((x) => x.url === '/api/v1/posts' && x.text != null).pop().text), { text: 'look', pictures: [{ media_id: 'med_01ABCDEFGHJKMNPQRSTVWXYZ01', alt: 'A cat' }] });
    assert.strictEqual((await fetch(`${base}/attachments`, { method: 'POST', body: form })).status, 401, 'no token, no picture');
    assert.strictEqual((await fetch(`${base}/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, 'no token, no post');
    assert.strictEqual((await fetch(`${base}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer abcdefghijklmnop.qrstu', 'Content-Type': 'image/png' }, body: 'x' })).status, 400, 'only multipart');

    const anon = await fetch(`${base}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(anon.status, 401, 'no token, no post');

    down = true;
    ({ r, d } = await get('/feed?kind=meme'));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(d, { items: [], next_cursor: null }, 'Community not answering is an empty page');

    server.close(); community.close();
    console.log('frame feed: the Feed and wall through Network for every site, tokens along, cookies never, kept 30 s ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
