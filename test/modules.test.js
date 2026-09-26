'use strict';
// Versioned user modules (server/identity/modules.js): user CRUD with revisions, public field-level
// reads, owner-only service writes behind scoped tokens, and no legacy-key access. Roadmap Wave 1.
//   node test/modules.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-modules-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
// chat is registered on the host, not seeded (ai is seeded since its console, WS-O task 4): add a missing one as a copy of tools, then seed the grants again.
for (const c of ['chat', 'ai']) {
    const cols = db.prepare('PRAGMA table_info(oauth_clients)').all().map(x => x.name).filter(n => n !== 'client_id' && n !== 'id');
    db.prepare(`INSERT OR IGNORE INTO oauth_clients (client_id, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM oauth_clients WHERE client_id = 'tools'`).run(c);
}
require('../server/identity/principals').ensureSchema(db);
for (const [c, s] of [['live', 'live-secret'], ['tools', 'tools-secret'], ['games', 'games-secret'], ['chat', 'chat-secret'], ['ai', 'ai-secret']]) db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(s, c);
db.prepare("INSERT INTO users (id, username, password_hash, subject_id) VALUES (1, 'ann', 'x', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA'), (2, 'bob', 'x', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB')").run();
const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { internalKey: 'legacy-key', jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/modules', require('../server/identity/modules').userRouter(requireAuth));
app.use('/internal', require('../server/internal/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const annTok = signToken(db.prepare('SELECT * FROM users WHERE id = 1').get(), keys.privateKey, config);
    const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async r => ({ status: r.status, etag: r.headers.get('etag'), cache: r.headers.get('cache-control'), body: r.status === 204 ? null : await r.json().catch(() => null) }));
    const me = { authorization: `Bearer ${annTok}` };
    const svc = async (client) => (await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: `${client}-secret`, audience: 'openvibe.network' }) }).then(r => r.json())).access_token;

    // ── The user ──
    let r = await call('GET', '/api/modules/chat.tts_defaults', { headers: me });
    assert.strictEqual(r.status, 404);
    r = await call('PUT', '/api/modules/chat.tts_defaults', { headers: me, body: { data: { send: true, volume: 40 } } });
    assert.strictEqual(r.status, 428, 'a user write must say which revision it read');
    r = await call('PUT', '/api/modules/chat.tts_defaults', { headers: { ...me, 'if-match': '0' }, body: { data: { send: true, volume: 40 } } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.revision, 1); assert.strictEqual(r.etag, '"1"');
    assert.ok(validate('modules.module-record@1', r.body).valid);
    assert.deepStrictEqual(r.body.subject, { type: 'user', id: ANN });
    r = await call('PUT', '/api/modules/chat.tts_defaults', { headers: { ...me, 'if-match': '0' }, body: { data: { volume: 50 } } });
    assert.strictEqual(r.status, 412, 'stale revision refused'); assert.strictEqual(r.body.code, 'modules.revision_conflict');
    r = await call('PUT', '/api/modules/chat.tts_defaults', { headers: { ...me, 'if-match': '"1"' }, body: { data: { volume: 500 } } });
    assert.strictEqual(r.status, 422, 'schema enforced'); assert.ok(r.body.errors.length);
    r = await call('PUT', '/api/modules/chat.tts_defaults', { headers: { ...me, 'if-match': '"1"' }, body: { data: { volume: 50 } } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.revision, 2);
    r = await call('PUT', '/api/modules/live.profile', { headers: { ...me, 'if-match': '0' }, body: { data: { followers: 1000000 } } });
    assert.strictEqual(r.status, 403, 'users cannot write a service-owned summary'); assert.strictEqual(r.body.code, 'modules.write_denied');
    r = await call('PUT', '/api/modules/nope.nope', { headers: { ...me, 'if-match': '0' }, body: { data: {} } });
    assert.strictEqual(r.status, 404);
    r = await call('GET', '/api/modules/chat.tts_defaults', {});
    assert.strictEqual(r.status, 401, 'reading my record needs me');

    // ── Services ──
    const live = await svc('live');
    const tools = await svc('tools');
    r = await call('PUT', `/internal/modules/live.profile/${ANN}`, { headers: { authorization: `Bearer ${live}` }, body: { data: { followers: 42, is_streamer: true, stream_minutes_30d: 900 } } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); assert.strictEqual(r.body.updated_by, 'svc:live');
    r = await call('PUT', `/internal/modules/tools.usage/${ANN}`, { headers: { authorization: `Bearer ${live}` }, body: { data: { recent: [] } } });
    assert.strictEqual(r.status, 403, 'live has no grant for tools.usage'); assert.strictEqual(r.body.code, 'capability.namespace_denied');
    r = await call('GET', `/internal/modules/chat.tts_defaults/${ANN}`, { headers: { authorization: `Bearer ${tools}` } });
    assert.strictEqual(r.status, 403, 'tools cannot read chat preferences');
    r = await call('GET', `/internal/modules/chat.tts_defaults/${ANN}`, { headers: { authorization: `Bearer ${live}` } });
    assert.strictEqual(r.status, 403, 'chat.tts_defaults is Chat\'s since contracts 0.41.0: Live has no grant');
    const chat = await svc('chat');
    r = await call('GET', `/internal/modules/chat.tts_defaults/${ANN}`, { headers: { authorization: `Bearer ${chat}` } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.volume, 50);

    // ── Field-level read rules (readers) ──
    r = await call('PUT', '/api/modules/ai.preferences', { headers: { ...me, 'if-match': '0' }, body: { data: { style: 'casual', history: false } } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const ai = await svc('ai');
    r = await call('GET', `/internal/modules/ai.preferences/${ANN}`, { headers: { authorization: `Bearer ${ai}` } });
    assert.deepStrictEqual(r.body.data, { style: 'casual', history: false }, 'ai is a listed reader of ai.preferences');
    r = await call('PUT', `/internal/modules/live.stats/${ANN}`, { headers: { authorization: `Bearer ${live}` }, body: { data: { streams_30d: 3, peak_viewers_30d: 12, new_followers_30d: 7 } } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    db.prepare("UPDATE principal_grants SET namespaces = '[\"tools.usage\",\"live.stats\"]' WHERE client_id = 'tools' AND capability = 'network.modules.read'").run();
    const tools2 = await svc('tools');
    r = await call('GET', `/internal/modules/live.stats/${ANN}`, { headers: { authorization: `Bearer ${tools2}` } });
    assert.deepStrictEqual(r.body.data, { streams_30d: 3, peak_viewers_30d: 12 }, 'a granted service that is not a listed reader sees public fields only');
    r = await call('GET', `/internal/modules/live.stats/${ANN}`, { headers: { authorization: `Bearer ${live}` } });
    assert.strictEqual(r.body.data.new_followers_30d, 7, 'the owner reads the whole record');

    // ── Version migration: a stored v1 record reads as the current version ──
    db.prepare("INSERT INTO user_modules (subject_id, namespace, version, revision, data) VALUES (?, 'tools.usage', 1, 1, ?)").run(ANN, JSON.stringify({ recent: [{ tool: 'img' }] }));
    r = await call('GET', '/api/modules/tools.usage', { headers: me });
    assert.strictEqual(r.body.version, 2); assert.deepStrictEqual(r.body.data, { recent: [{ tool: 'img' }] });
    r = await call('PUT', '/api/modules/tools.usage', { headers: { ...me, 'if-match': '1' }, body: { data: { ...r.body.data, favorites: ['img'] } } });
    assert.strictEqual(r.status, 200, 'the person may star tools (tools.usage v2)');
    assert.strictEqual(db.prepare("SELECT version FROM user_modules WHERE subject_id = ? AND namespace = 'tools.usage'").get(ANN).version, 2, 'the next write stores the current version');
    db.prepare("INSERT INTO user_modules (subject_id, namespace, version, revision, data) VALUES ('usr_01JAB2C3D4E5F6G7H8J9K0MNPB', 'chat.tts_defaults', 1, 1, ?)").run(JSON.stringify({ voice: 'en-1', rate: 1.2, muted: true }));
    r = await call('GET', '/internal/modules/chat.tts_defaults/usr_01JAB2C3D4E5F6G7H8J9K0MNPB', { headers: { authorization: `Bearer ${chat}` } });
    assert.strictEqual(r.body.version, 2); assert.deepStrictEqual(r.body.data, {}, 'v1 tts fields are dropped by the migration');
    r = await call('PUT', `/internal/modules/live.profile/${ANN}`, { headers: { 'x-internal-key': 'legacy-key' }, body: { data: { followers: 1 } } });
    assert.strictEqual(r.status, 403, 'module routes never accept the shared key');
    assert.ok(db.prepare("SELECT 1 FROM principal_usage WHERE principal = 'legacy-key' AND auth = 'internal-key' AND allowed = 0 AND route LIKE 'PUT /internal/modules%'").get(), 'a refused key is audited as the key');
    r = await call('PUT', `/internal/modules/live.profile/usr_01JAB2C3D4E5F6G7H8J9K0ZZZZ`, { headers: { authorization: `Bearer ${live}` }, body: { data: { followers: 1 } } });
    assert.strictEqual(r.status, 404, 'unknown subject');
    r = await call('PUT', `/internal/modules/live.profile/${ANN}`, { headers: { authorization: `Bearer ${live}`, 'if-match': '0' }, body: { data: { followers: 43 } } });
    assert.strictEqual(r.status, 412, 'services get revision checks when they ask for them');

    // ── Public, field-level ──
    r = await call('GET', `/api/modules/live.profile/public/${ANN}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.data, { followers: 42, is_streamer: true }, 'only public fields');
    r = await call('GET', `/api/modules/chat.tts_defaults/public/${ANN}`);
    assert.deepStrictEqual(r.body.data, {}, 'a namespace with no public fields shows nothing');
    r = await call('GET', '/api/modules/live.profile/public/1');
    assert.strictEqual(r.status, 404, 'public reads take subject ids only');

    // ── Export and delete: the user's data ──
    r = await call('GET', '/api/modules', { headers: me });
    assert.deepStrictEqual(r.body.modules.map(m => m.namespace), ['ai.preferences', 'chat.tts_defaults', 'live.profile', 'live.stats', 'tools.usage']);
    assert.ok(r.body.namespaces.find(n => n.namespace === 'chat.preferences').userWritable);
    assert.ok(r.cache.includes('no-store'));
    r = await call('DELETE', '/api/modules/live.profile', { headers: me });
    assert.strictEqual(r.status, 204, 'people can delete even service-written summaries about them');
    r = await call('GET', `/api/modules/live.profile/public/${ANN}`);
    assert.strictEqual(r.status, 404);

    server.close(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('modules: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
