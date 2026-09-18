'use strict';
// GET /sso/check — origin allow-list, headers that let exactly one OpenVibe origin frame it,
// and the postMessage payload for signed-in / signed-out browsers.
//   node test/sso-check.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { allowedOrigin, renderCheck, createSsoCheckRoute } = require('../server/auth/sso-check');

assert.strictEqual(allowedOrigin('https://openvibe.tools'), 'https://openvibe.tools');
assert.strictEqual(allowedOrigin('https://json.openvibe.tools/'), 'https://json.openvibe.tools');
assert.strictEqual(allowedOrigin('https://play.openvibe.games'), 'https://play.openvibe.games');
assert.strictEqual(allowedOrigin('https://ingest.openre.stream'), 'https://ingest.openre.stream');
assert.strictEqual(allowedOrigin('https://openvibe.tools.evil.com'), null, 'suffix spoof rejected');
assert.strictEqual(allowedOrigin('https://evilopenvibe.tools'), null);
assert.strictEqual(allowedOrigin('https://openvibe.xyz'), null, 'a TLD we do not own is not ours');
assert.strictEqual(allowedOrigin('https://x.openvibe.deals'), 'https://x.openvibe.deals');
assert.strictEqual(allowedOrigin('http://openvibe.tools'), null, 'plain http rejected');
assert.strictEqual(allowedOrigin('https://openvibe.tools/path'), null, 'origins only');
assert.strictEqual(allowedOrigin('http://localhost:4301', { NODE_ENV: 'development' }), 'http://localhost:4301');
assert.strictEqual(allowedOrigin('http://localhost:4301', { NODE_ENV: 'production' }), null);
assert.ok(renderCheck('https://openvibe.tools', { signedIn: true, username: 'a"b' }).includes('"username":"a\\"b"'), 'payload is JSON-escaped');

// Route: a stub verifySession through a real express app.
const app = express();
app.use(cookieParser());
// The route reads the session through server/auth/session.js; give it a key it can verify with.
const jwt = require('jsonwebtoken');
const secret = 'test-secret';
const config = { jwt: { issuer: 'https://openvibe.network', expiresIn: '1h' } };
const db = { prepare: () => ({ get: (id) => ({ id, username: 'goosely', is_banned: 0, token_valid_after: null }) }) };
app.get('/sso/check', createSsoCheckRoute(() => ({ db, publicKey: secret, config })));
const server = http.createServer(app);
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (q, cookie) => fetch(`${base}/sso/check${q}`, { headers: cookie ? { cookie } : {} }).then(async r => ({ status: r.status, headers: r.headers, body: await r.text() }));

    let r = await get('?origin=https://phish.example');
    assert.strictEqual(r.status, 400);

    r = await get('?origin=https://openvibe.tools');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-security-policy'), "frame-ancestors https://openvibe.tools; default-src 'none'; script-src 'unsafe-inline'");
    assert.ok(!r.headers.get('x-frame-options'), 'no X-Frame-Options (the frame-ancestors directive is the rule)');
    assert.ok(/no-store/.test(r.headers.get('cache-control')));
    assert.ok(r.body.includes('"signedIn":false') && r.body.includes('"https://openvibe.tools"'), 'signed-out answer addressed to the origin');

    const token = jwt.sign({ sub: 7, id: 7, username: 'goosely' }, secret, { issuer: config.jwt.issuer, expiresIn: '1h' });
    r = await get('?origin=https://openvibe.community', `ov_sso=${token}`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('"signedIn":true') && r.body.includes('"username":"goosely"'), 'the httpOnly cross-site cookie alone is enough');
    r = await get('?origin=https://openvibe.community', `ov_token=${token}`);
    assert.ok(r.body.includes('"signedIn":true'), 'the page cookie works too');
    r = await get('?origin=https://openvibe.community', `ov_sso=not-a-jwt`);
    assert.ok(r.body.includes('"signedIn":false'), 'garbage cookie → signed out, still 200');

    server.close();
    console.log('sso check: all checks passed');
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
