'use strict';
// Extractors behind docs/roadmap-baseline (scripts/roadmap-baseline/extract.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('../scripts/roadmap-baseline/extract');

// Tables: real CREATE TABLE statements only, not prose that happens to contain the words.
assert.deepStrictEqual(X.extractTables([
    "db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)`);",
    '// we CREATE TABLE below once the lock is held',
    'CREATE VIRTUAL TABLE docs_fts USING fts5(body);',
    'create table "quoted" (x)',
].join('\n')).map(t => t.table), ['users', 'docs_fts', 'quoted']);

// Routes: express verbs with a leading slash; Map#get and friends are ignored.
assert.deepStrictEqual(X.extractRoutes([
    "router.get('/a', h);",
    "app.post(\"/b/:id\", requireAuth, h);",
    "cache.get('/not-a-route');",
    "r.delete(`/c`, h)",
].join('\n')).map(r => `${r.method} ${r.path}`), ['GET /a', 'POST /b/:id', 'DELETE /c']);

// Mount prefixes compose through required modules, including factory and destructured forms.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
const w = (f, body) => { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), body); return path.join(tmp, f); };
const index = w('index.js', [
    "const chat = require('./chat/routes');",
    "const svc = require('./svc').create({});",
    "const { makeAdmin } = require('./admin');",
    "app.use('/api/chat', chat);",
    "app.use('/api/svc', rateLimit({ max: 5 }), svc.router);",
    "app.use('/api/admin', makeAdmin(db, requireAuth));",
    "app.use('/api/inline', require('./inline'));",
].join('\n'));
const chat = w('chat/routes.js', "const sub = require('./dm');\nrouter.get('/history', h);\nrouter.use('/dm', sub);");
const dm = w('chat/dm.js', "router.post('/send', h);");
const svc = w('svc.js', "router.get('/x', h);");
const admin = w('admin.js', "router.get('/y', h);");
const inline = w('inline.js', "router.get('/z', h);");
const mountsByFile = {};
for (const f of [index, chat]) mountsByFile[f] = X.extractMounts(fs.readFileSync(f, 'utf8')).map(m => ({ ...m, target: X.resolveModule(f, m.spec) }));
const { prefixesOf } = X.computePrefixes(mountsByFile);
assert.deepStrictEqual(prefixesOf(chat), ['/api/chat']);
assert.deepStrictEqual(prefixesOf(dm), ['/api/chat/dm']);
assert.deepStrictEqual(prefixesOf(svc), ['/api/svc']);
assert.deepStrictEqual(prefixesOf(admin), ['/api/admin']);
assert.deepStrictEqual(prefixesOf(inline), ['/api/inline']);
assert.deepStrictEqual(prefixesOf(index), ['']);
fs.rmSync(tmp, { recursive: true, force: true });

// Raw http.Server routing (Games).
assert.deepStrictEqual(X.extractRawRoutes([
    "if (url === '/api/map' && req.method === 'POST') {",
    "if (url.startsWith('/auth/')) {",
].join('\n')).map(r => `${r.method} ${r.path}`), ['POST /api/map', 'ANY /auth/*']);

// Env names: process.env and env-parameter forms; secret classification never needs a value.
assert.deepStrictEqual(X.extractEnv("process.env.A_KEY; env.OV_NETWORK_URL; process.env['B_SECRET']").sort(), ['A_KEY', 'B_SECRET', 'OV_NETWORK_URL']);
for (const n of ['INTERNAL_API_KEY', 'PAYPAL_CLIENT_SECRET', 'MEDIA_B2_SECRET_ACCESS_KEY', 'DISCORD_BOT_TOKEN', 'OPS_ALERT_WEBHOOK_URL']) assert.ok(X.isSecretName(n), n);
for (const n of ['OV_NETWORK_URL', 'VAPID_PUBLIC_KEY', 'MEDIA_APP_ID', 'TOKEN_TTL_MS', 'WHISPER_MODEL_MULTI', 'KEY_FILE']) assert.ok(!X.isSecretName(n), n);

// Cross-service calls: env var, loopback port, config indirection, contract path; self calls ignored.
const ob = X.extractOutbound([
    "const r = await fetch(`${process.env.OV_NETWORK_INTERNAL_URL}/internal/coins/credit`, {",
    "  headers: { 'X-Internal-Key': key }, signal: AbortSignal.timeout(5000) });",
    "await fetch(config.media.url + '/x');",
    "await fetch('http://127.0.0.1:3000/api/streams');",
].join('\n'), 'live');
assert.deepStrictEqual(ob.targets.map(t => t.service).sort(), ['media', 'network']);
assert.deepStrictEqual(ob.auth, ['internal-key']);
assert.strictEqual(ob.timeout, true);
assert.strictEqual(X.extractOutbound("const u = process.env.OV_NETWORK_URL;", 'live'), null, 'no HTTP client, no call');

// Jobs.
assert.deepStrictEqual(X.extractJobs([
    "jobs.every('restream-viewer-counts', 60_000, poll);",
    'setInterval(sweep, 5 * 60 * 1000);',
].join('\n')).map(j => `${j.kind}:${j.name}:${j.intervalMs}`), ['jobs.every:restream-viewer-counts:60000', 'setInterval:null:300000']);

console.log('roadmap-baseline extractors: ok');
