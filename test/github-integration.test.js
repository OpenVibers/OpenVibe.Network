'use strict';
// The network's GitHub token (server/integrations/github.js): env first, else what the owner saves in admin;
// admin never sees the value; only the owner changes it; Blog (network.integration.github.read) reads it
// over /internal with its service token and no other service can; the registry's library tags use it.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { initDb } = require('../server/db/database');
const github = require('../server/integrations/github');
const principals = require('../server/identity/principals');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-github-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
delete process.env.GITHUB_TOKEN;
process.env.OWNER_USERNAME = 'goosely';
db.prepare("UPDATE oauth_clients SET client_secret = 'blog-secret' WHERE client_id = 'blog'").run();
db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'goosely', 'x'), (2, 'anadmin', 'x')").run();

const TOKEN = 'github_pat_' + 'A1b2C3d4E5'.repeat(6);
const seen = [];
const fakeGithub = async (url, opts) => {
    seen.push(opts.headers.Authorization || null);
    const authed = Boolean(opts.headers.Authorization);
    return { ok: true, status: 200, json: async () => ({ resources: { core: { limit: authed ? 5000 : 60, remaining: authed ? 4999 : 59, reset: 1790000000 } } }) };
};

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const app = express();
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use((req, _res, next) => { const u = req.headers['x-user']; req.user = u ? db.prepare('SELECT id, username FROM users WHERE username = ?').get(u) : null; next(); });
app.use('/api/admin/integrations/github', github.adminRouter(db, { fetchImpl: fakeGithub }));
app.get('/internal/integrations/github-token', principals.guard('network.integration.github.read', { legacy: false }), github.internalHandler(db));
const server = http.createServer(app);

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, { user, body, headers } = {}) => fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async r => ({ status: r.status, cache: r.headers.get('cache-control'), text: await r.text() })).then(r => ({ ...r, body: JSON.parse(r.text || '{}') }));
    const svcToken = (client, secret) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: secret, audience: 'openvibe.network' }) }).then(r => r.json());
    const A = '/api/admin/integrations/github';
    try {
        // Owner only.
        assert.strictEqual((await call('GET', A)).status, 403);
        assert.strictEqual((await call('GET', A, { user: 'anadmin' })).status, 403, 'admins do not manage secrets');
        let r = await call('GET', A, { user: 'goosely' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.body.github.set, r.body.github.source, r.body.github.env], [false, 'unset', 'GITHUB_TOKEN']);

        // Validation, save, never echoed.
        assert.strictEqual((await call('PUT', A, { user: 'goosely', body: { token: 'hunter2' } })).status, 400);
        r = await call('PUT', A, { user: 'goosely', body: { token: TOKEN } });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(!r.text.includes(TOKEN), 'the token is never sent back');
        assert.deepStrictEqual([r.body.github.set, r.body.github.source, r.body.github.last4], [true, 'database', TOKEN.slice(-4)]);
        assert.strictEqual(github.tokenOf(db), TOKEN);
        const audit = db.prepare("SELECT details FROM audit_log WHERE action = 'integration_update'").all();
        assert.strictEqual(audit.length, 1);
        assert.ok(!audit[0].details.includes(TOKEN), 'the audit row keeps the last four only');
        assert.ok(!(await call('GET', A, { user: 'goosely' })).text.includes(TOKEN));

        // Test asks GitHub with the token.
        r = await call('POST', A + '/test', { user: 'goosely' });
        assert.deepStrictEqual([r.body.test.authenticated, r.body.test.limit, r.body.test.remaining], [true, 5000, 4999]);
        assert.strictEqual(seen.pop(), `Bearer ${TOKEN}`);

        // Blog reads it with its service token; another service and the legacy key cannot.
        const blog = await svcToken('blog', 'blog-secret');
        assert.ok(blog.access_token, JSON.stringify(blog));
        assert.ok(blog.scope.split(' ').includes('network.integration.github.read'));
        r = await call('GET', '/internal/integrations/github-token', { headers: { authorization: `Bearer ${blog.access_token}` } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body, { token: TOKEN, source: 'database' });
        assert.strictEqual(r.cache, 'no-store');
        const live = await svcToken('live', 'live-secret');
        assert.strictEqual((await call('GET', '/internal/integrations/github-token', { headers: { authorization: `Bearer ${live.access_token}` } })).status, 403, 'only blog holds the capability');
        assert.ok([401, 403].includes((await call('GET', '/internal/integrations/github-token', { headers: { 'x-internal-key': 'legacy-key' } })).status), 'no legacy key');
        assert.ok([401, 403].includes((await call('GET', '/internal/integrations/github-token')).status), 'no credential');

        // Clear → 404 not_configured; the test falls back to anonymous.
        r = await call('DELETE', A, { user: 'goosely' });
        assert.deepStrictEqual([r.status, r.body.github.set], [200, false]);
        r = await call('GET', '/internal/integrations/github-token', { headers: { authorization: `Bearer ${blog.access_token}` } });
        assert.deepStrictEqual([r.status, r.body.error], [404, 'not_configured']);
        r = await call('POST', A + '/test', { user: 'goosely' });
        assert.deepStrictEqual([r.body.test.authenticated, r.body.test.limit], [false, 60]);
        assert.strictEqual(seen.pop(), null);

        // The environment wins and cannot be changed from admin.
        process.env.GITHUB_TOKEN = 'ghp_' + 'Z'.repeat(36);
        r = await call('GET', A, { user: 'goosely' });
        assert.deepStrictEqual([r.body.github.source, r.body.github.last4], ['env', 'ZZZZ']);
        assert.strictEqual((await call('PUT', A, { user: 'goosely', body: { token: TOKEN } })).status, 409);
        assert.strictEqual((await call('DELETE', A, { user: 'goosely' })).status, 409);
        assert.strictEqual(github.tokenOf(db), process.env.GITHUB_TOKEN);
        delete process.env.GITHUB_TOKEN;

        // The registry's library tags read the token at call time.
        const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
        assert.ok(/token: \(\) => require\('\.\/integrations\/github'\)\.tokenOf\(db\)/.test(src), 'library tags get the token lazily');
        assert.ok(src.indexOf("app.get('/internal/integrations/github-token'") < src.indexOf("app.use('/internal', require('./internal/routes'))"), 'mounted before the /internal router');
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('github integration: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
