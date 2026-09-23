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
for (const n of ['OV_NETWORK_URL', 'VAPID_PUBLIC_KEY', 'MEDIA_APP_ID', 'TOKEN_TTL_MS', 'WHISPER_MODEL_MULTI', 'KEY_FILE', 'COOKIE_SECURE', 'OPENRE_DEST_ALLOW_PRIVATE']) assert.ok(!X.isSecretName(n), n);
assert.ok(X.isSecretName('OPENRE_SECRETS_KEY_PREVIOUS'), 'a previous key is still a secret');

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

// Services added after the first baseline: loopback ports, URL env names and config keys resolve to them;
// Network-issued service tokens are recognised as an auth mechanism.
assert.strictEqual(X.SERVICE_PORTS[4600], 'billing');
assert.strictEqual(X.SERVICE_PORTS[4910], 'host');
assert.strictEqual(X.envTarget('OV_BILLING_INTERNAL_URL'), 'billing');
assert.strictEqual(X.envTarget('EVENTS_URL'), 'events');
assert.strictEqual(X.envTarget('OPENRE_URL'), 'openre');
assert.strictEqual(X.envTarget('HOST_URL'), null, 'HOST is a generic name, not the Host service');
assert.strictEqual(X.envTarget('CODES_PLAYGROUND_EVENTS_URL'), null, 'anchored: a prefixed name is not a service URL');
const ob2 = X.extractOutbound([
    "const tokens = createTokenClient({ tokenUrl: `${config.network.internalUrl}/oauth/token` });",
    "await fetch(`${config.billing.url}/api/v1/intents`, { signal: AbortSignal.timeout(5000) });",
    "await fetch('http://127.0.0.1:4610/api/v1/tips');",
].join('\n'), 'vip');
assert.deepStrictEqual(ob2.targets.map(t => t.service).sort(), ['billing', 'network', 'tips']);
assert.deepStrictEqual(ob2.auth, ['service-token']);

// Jobs.
assert.deepStrictEqual(X.extractJobs([
    "jobs.every('restream-viewer-counts', 60_000, poll);",
    'setInterval(sweep, 5 * 60 * 1000);',
].join('\n')).map(j => `${j.kind}:${j.name}:${j.intervalMs}`), ['jobs.every:restream-viewer-counts:60000', 'setInterval:null:300000']);

// Hand-maintained inputs: the rules the generator enforces on every run, checked here so CI catches a
// malformed edit without the sibling checkouts (artifact paths are verified by generate.js itself).
const DATA = path.join(__dirname, '../docs/roadmap-baseline/data');
const ledger = JSON.parse(fs.readFileSync(path.join(DATA, 'requirement-ledger.json'), 'utf8'));
const ids = ledger.requirements.map(r => r.id);
assert.deepStrictEqual(ids, Array.from({ length: 46 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`), 'one row per D01-D46, in order');
const STATUSES = ['met', 'partial', 'not-met', 'blocked-on-owner'];
const KINDS = new Set(['test', 'prod', 'drill', 'snapshot', 'doc', 'commit']);
for (const r of ledger.requirements) {
    assert.ok(STATUSES.includes(r.status), `${r.id}: status`);
    assert.ok(r.title && r.owner && r.target && r.summary, `${r.id}: title, owner, target and summary`);
    assert.ok(Array.isArray(r.artifacts) && r.artifacts.length, `${r.id}: at least one acceptance artifact`);
    for (const a of r.artifacts) {
        assert.ok(KINDS.has(a.kind), `${r.id}: artifact kind ${a.kind}`);
        if (['test', 'doc', 'drill'].includes(a.kind)) assert.ok(a.repo && a.path, `${r.id}: ${a.kind} needs repo and path`);
        if (a.kind === 'commit') assert.match(a.sha, /^[0-9a-f]{7,40}$/, `${r.id}: commit sha`);
        if (a.kind === 'prod') assert.ok(a.check && a.observed && /^\d{4}-\d{2}-\d{2}/.test(a.at), `${r.id}: prod check, observed and dated at`);
    }
    if (r.status === 'met') {
        assert.deepStrictEqual(r.remaining, [], `${r.id}: met lists nothing remaining`);
        assert.ok(r.artifacts.some(a => ['test', 'prod', 'drill', 'snapshot'].includes(a.kind)), `${r.id}: met needs a test, production check or drill (roadmap 8.3)`);
    } else {
        assert.ok(r.remaining.length, `${r.id}: not met, so something remains`);
    }
    if (r.status === 'blocked-on-owner') assert.ok(r.blockedOn, `${r.id}: names the owner action`);
}
for (const f of ledger.families) assert.match(f.ids, /^D\d{2}(-D\d{2})?$/, `family ${f.ids}`);
const hazards = JSON.parse(fs.readFileSync(path.join(DATA, 'hazards.json'), 'utf8'));
for (const h of hazards.hazards) {
    assert.ok(['open', 'partial', 'mitigated', 'blocked-on-owner', 'standing-rule', 'closed'].includes(h.status), `${h.id}: status ${h.status}`);
    assert.ok('ownerReview' in h, `${h.id}: says whether the owner must review it`);
    if (h.status === 'blocked-on-owner') assert.ok(h.ownerReview, `${h.id}: blocked on the owner, so the owner action is named`);
}
const own = JSON.parse(fs.readFileSync(path.join(DATA, 'ownership-rules.json'), 'utf8'));
for (const r of [...own.rules, ...own.routes, ...own.jobs]) {
    for (const k of ['match', 'name', 'file', 'method', 'dbMatch']) if (r[k] !== undefined) new RegExp(r[k]);
    assert.ok(r.target && r.disposition, `rule ${r.repo} ${r.match || r.file}: target and disposition`);
}

console.log('roadmap-baseline extractors and data: ok');
