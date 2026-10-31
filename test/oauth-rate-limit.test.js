'use strict';
// OAuth limits (server/auth/oauth-limit.js): per address AND client, so one app cannot spend a shared
// address's budget and one address cannot hammer one app. The production mount uses 60 a minute; this
// test builds the same limiter with max 2 to prove the key.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createOAuthLimiter, oauthKey } = require('../server/auth/oauth-limit');

(async () => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(['/oauth/token', '/oauth/revoke'], createOAuthLimiter({ windowMs: 60_000, max: 2 }));
    app.post(['/oauth/token', '/oauth/revoke'], (req, res) => res.json({ ok: true, key: oauthKey(req) }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, client_id) => {
        const body = new URLSearchParams({ client_id, grant_type: 'refresh_token' }).toString();
        const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    try {
        assert.deepStrictEqual([(await post('/oauth/token', 'companion')).status, (await post('/oauth/token', 'companion')).status], [200, 200]);
        const blocked = await post('/oauth/token', 'companion');
        assert.strictEqual(blocked.status, 429, 'the third request for one address+client is limited');
        assert.strictEqual((await post('/oauth/token', 'live')).status, 200, 'another client on the same address is a separate bucket');
        assert.strictEqual((await post('/oauth/revoke', 'companion')).status, 429, 'revoke shares the client bucket');
        assert.strictEqual((await post('/oauth/revoke', 'live')).status, 200, 'and the other client is not blocked');
        assert.match((await post('/oauth/token', 'companion')).body.error, /too_many_requests/);
        console.log('oauth rate limit: all checks passed');
    } finally {
        await new Promise((r) => server.close(r));
    }
})();
