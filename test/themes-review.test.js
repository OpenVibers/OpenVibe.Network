'use strict';
// Community themes (roadmap WS-E task 2): a submission is pending and private to its author until an
// admin approves it; the catalog shows approved themes only; theme values are allow-listed (only the
// shared token names, only colours, numbers, lengths and shadows); a theme exports as an
// openvibe-theme@1 file and imports as a new submission; custom overrides are cleaned the same way.
//   node test/themes-review.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-themes-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'ann', 'x', 'user'), (2, 'bob', 'x', 'user'), (3, 'boss', 'x', 'admin')").run();
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' }));
const themes = require('../server/themes/routes');
const app = express();
app.use(express.json());
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/api/themes', themes);
app.use('/api/admin/themes', requireAuth, requireAdmin, themes.reviewRouter());
const server = http.createServer(app);
const token = (id) => signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, { body, as } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${token(as)}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
    db.prepare("INSERT OR IGNORE INTO themes (id, name, slug, mode, variables, is_builtin, is_public) VALUES ('vibe', 'Vibe', 'vibe', 'dark', '{\"--accent\":\"#5b7cfa\"}', 1, 1)").run();

    // ── Values are allow-listed ──
    const good = { '--accent': '#ff6a3d', '--bg-primary': '#101010', '--accent-rgb': '255, 106, 61', '--shadow': '0 8px 24px rgba(0, 0, 0, .4)' };
    for (const [bad, why] of [[{ '--accent': 'url(https://evil.example/t.png)' }, 'url()'], [{ '--accent': 'red; } body { display: none' }, 'break-out'], [{ '--accent': 'var(--x)' }, 'var()'], [{ '--made-up': '#fff' }, 'unknown token']]) {
        const r = await call('POST', '/api/themes', { as: 1, body: { name: 'Bad', slug: `bad-${why.replace(/\W/g, '')}`, variables: bad } });
        assert.strictEqual(r.status, 422, `${why} is refused`);
    }

    // ── A submission is pending and private to its author ──
    let r = await call('POST', '/api/themes', { as: 1, body: { name: 'Ember Night', slug: 'ember-night', variables: good, tags: ['warm', 'Bad Tag!'] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.review, 'pending');
    assert.deepStrictEqual(r.body.theme.tags, ['warm'], 'tags are cleaned');
    assert.ok(!(await call('GET', '/api/themes')).body.themes.some((t) => t.slug === 'ember-night'), 'not in the catalog yet');
    assert.strictEqual((await call('GET', '/api/themes/ember-night', { as: 2 })).status, 404, 'hidden from others');
    assert.strictEqual((await call('GET', '/api/themes/ember-night')).status, 404, 'and from visitors');
    assert.strictEqual((await call('GET', '/api/themes/ember-night', { as: 1 })).status, 200, 'the author sees it');
    assert.strictEqual((await call('PUT', '/api/themes/me', { as: 1, body: { theme_id: 'ember-night' } })).status, 200, 'the author can use it now');
    assert.strictEqual((await call('PUT', '/api/themes/me', { as: 2, body: { theme_id: 'ember-night' } })).status, 404, 'nobody else can');
    assert.strictEqual((await call('GET', '/api/themes/me/submissions', { as: 1 })).body.themes[0].review_status, 'pending');

    // ── Export and import ──
    r = await call('GET', '/api/themes/ember-night/export', { as: 1 });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /ember-night\.openvibe-theme\.json/);
    assert.strictEqual(r.body.format, 'openvibe-theme@1');
    const file = { ...r.body, slug: 'ember-night-copy', name: 'Ember Night Copy' };
    assert.strictEqual((await call('POST', '/api/themes/import', { as: 2, body: { ...file, format: 'something-else' } })).status, 400);
    r = await call('POST', '/api/themes/import', { as: 2, body: file });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.review, 'pending', 'an import is a submission like any other');

    // ── Review ──
    assert.strictEqual((await call('GET', '/api/admin/themes', { as: 1 })).status, 403, 'admins only');
    r = await call('GET', '/api/admin/themes', { as: 3 });
    assert.deepStrictEqual(r.body.themes.map((t) => [t.slug, t.author]), [['ember-night', 'ann'], ['ember-night-copy', 'bob']]);
    assert.strictEqual((await call('POST', '/api/admin/themes/community-ember-night-copy/review', { as: 3, body: { decision: 'reject' } })).status, 400, 'a rejection says why');
    r = await call('POST', '/api/admin/themes/community-ember-night-copy/review', { as: 3, body: { decision: 'reject', note: 'a copy of ember-night' } });
    assert.strictEqual(r.body.theme.review_status, 'rejected');
    r = await call('POST', '/api/admin/themes/community-ember-night/review', { as: 3, body: { decision: 'approve' } });
    assert.strictEqual(r.body.theme.review_status, 'approved');
    assert.ok((await call('GET', '/api/themes')).body.themes.some((t) => t.slug === 'ember-night'), 'approved: in the catalog');
    assert.strictEqual((await call('GET', '/api/themes/ember-night', { as: 2 })).status, 200);
    assert.strictEqual((await call('GET', '/api/themes/ember-night-copy', { as: 3 })).status, 404, 'rejected stays private');
    assert.strictEqual((await call('POST', '/api/admin/themes/vibe/review', { as: 3, body: { decision: 'reject', note: 'x' } })).status, 404, 'built-ins are not reviewed');

    // ── Custom overrides are cleaned the same way; the pending limit holds ──
    assert.strictEqual((await call('PUT', '/api/themes/me', { as: 2, body: { theme_id: 'vibe', custom_variables: { '--accent': 'url(x)' } } })).status, 422);
    r = await call('PUT', '/api/themes/me', { as: 2, body: { theme_id: 'vibe', custom_variables: { '--accent': '#00ff88' } } });
    assert.deepStrictEqual(r.body.custom_variables, { '--accent': '#00ff88' });
    for (let i = 0; i < 5; i++) await call('POST', '/api/themes', { as: 2, body: { name: `Try ${i}`, slug: `try-${i}`, variables: good } });
    assert.strictEqual((await call('POST', '/api/themes', { as: 2, body: { name: 'One more', slug: 'one-more', variables: good } })).status, 429, 'at most five waiting');

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('themes review: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
