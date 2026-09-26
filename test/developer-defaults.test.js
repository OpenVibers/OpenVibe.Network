'use strict';
// Developer-project defaults that let a new project work without staff (Wave 20 exit criterion),
// and the relay of developer-project events to OpenVibe.Events.
//   - DEV_SANDBOX_AUDIENCES defaults to openvibe.media, openvibe.events, openvibe.tools
//   - sandbox apps may hold the sandbox allowance (public capabilities only) without staff;
//     production apps still need the staff-set allowance
//   - events.app.* join the sandbox allowance as soon as the installed contracts know them
//   - dev_audit envelopes are relayed to Events through an outbox (OV_EVENTS_INTERNAL_URL), backfilled
//   node test/developer-defaults.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const contracts = require('openvibe-contracts');
const { serviceAuth, validate } = contracts;
const { initDb } = require('../server/db/database');
const policy = require('../server/developer/policy');
const relay = require('../server/developer/event-relay');

const quiet = { log() {}, warn() {}, error() {} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-devdefaults-'));
const db = initDb(path.join(dir, 'network.db'));
db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (10, 'owner', 'x', 'user'), (11, 'dev', 'x', 'user'), (14, 'staff', 'x', 'admin')`).run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
// No developer settings at all: the code defaults apply (as with DEV_SANDBOX_* unset).
app.locals.config = { baseUrl: ISSUER, loginUrl: ISSUER, internalKey: 'legacy-key', jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);
const userToken = (id) => jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const T = { owner: userToken(10), dev: userToken(11), staff: userToken(14) };

// The three app-scoped Events capabilities (openvibe-contracts >= 0.28.0, installed). withoutCatalog()
// hides them, to show what a release that does not define them does.
const EVENTS_APP_IDS = ['events.app.publish', 'events.app.read', 'events.app.subscribe'];
const PARTNER = { id: 'media.partner.test', version: '1.0', owner: 'media', status: 'active', visibility: 'partner', description: 'test', permissions: [], resourceConstraints: [], events: [], implementedBy: [] };
async function withCatalog(extra, fn) {
    const caps = contracts.capabilities;
    const origGet = caps.get;
    const origManifests = caps.manifests;
    caps.get = (id) => extra.find(c => c.id === id) || origGet.call(caps, id);
    caps.manifests = [...origManifests, ...extra];
    try { return await fn(); } finally { caps.get = origGet; caps.manifests = origManifests; }
}
async function withoutCatalog(hidden, fn) {
    const caps = contracts.capabilities;
    const origGet = caps.get;
    const origManifests = caps.manifests;
    caps.get = (id) => (hidden.includes(id) ? undefined : origGet.call(caps, id));
    caps.manifests = origManifests.filter(c => !hidden.includes(c.id));
    try { return await fn(); } finally { caps.get = origGet; caps.manifests = origManifests; }
}

(async () => {
    // ── Settings: defaults, env overrides, and the public-only rule ──
    let s = policy.settings({});
    assert.deepStrictEqual([...s.sandboxAudiences].sort(), ['openvibe.events', 'openvibe.media', 'openvibe.tools']);
    assert.ok(!s.sandboxAudiences.has('openvibe.network'), 'Network itself never defaults to accepting sandbox tokens');
    assert.deepStrictEqual(s.sandboxAllowance, ['events.app.publish', 'events.app.read', 'events.app.subscribe',
        'media.object.delete', 'media.object.list', 'media.object.read', 'media.object.upload', 'tools.job.cancel', 'tools.job.create', 'tools.job.read', 'tools.tool.read', 'tools.tool.run'],
        'the default sandbox allowance (openvibe-contracts 0.59.0 defines media.object.list and .delete)');
    assert.deepStrictEqual(policy.DEFAULT_SANDBOX_ALLOWANCE.filter(id => id.startsWith('events.')), ['events.app.publish', 'events.app.read', 'events.app.subscribe']);
    s = policy.settings({ developer: { sandboxAudiences: '', sandboxAllowance: '' } });
    assert.strictEqual(s.sandboxAudiences.size, 0, 'set-but-empty means none');
    assert.deepStrictEqual(s.sandboxAllowance, []);
    s = policy.settings({ developer: { sandboxAudiences: 'openvibe.media', sandboxAllowance: 'media.object.upload,network.coins.credit,identity.subject.resolve,events.event.publish,nope.x.y' } });
    assert.deepStrictEqual([...s.sandboxAudiences], ['openvibe.media']);
    assert.deepStrictEqual(s.sandboxAllowance, ['media.object.upload'], 'first-party, internal and unknown capabilities never enter the sandbox allowance');
    await withCatalog([PARTNER], () => {
        assert.ok(policy.isGrantable('media.partner.test'), 'partner is grantable by hand');
        assert.deepStrictEqual(policy.settings({ developer: { sandboxAllowance: 'media.partner.test,media.object.read' } }).sandboxAllowance, ['media.object.read'],
            'partner capabilities never come from the sandbox allowance');
    });
    await withoutCatalog(EVENTS_APP_IDS, () => {
        assert.deepStrictEqual(policy.settings({}).sandboxAllowance.filter(id => id.startsWith('events.')), [],
            'capabilities the installed contracts do not define are silently left out');
    });
    // Media's list and delete verbs (WS-G task 2) enter the default sandbox allowance once the pinned
    // contracts define them as public and active; until then they are left out like any unknown id.
    assert.ok(['media.object.list', 'media.object.delete'].every(id => policy.DEFAULT_SANDBOX_ALLOWANCE.includes(id)));
    const MEDIA_VERBS = ['media.object.list', 'media.object.delete'].map(id => ({ id, version: '1.0', owner: 'media', status: 'active', visibility: 'public', description: 'test', permissions: [], resourceConstraints: ['namespace'], events: [], implementedBy: [] }));
    await withoutCatalog(MEDIA_VERBS.map(c => c.id), () => withCatalog(MEDIA_VERBS, () => {
        const media = policy.settings({}).sandboxAllowance.filter(id => id.startsWith('media.'));
        assert.deepStrictEqual(media, ['media.object.delete', 'media.object.list', 'media.object.read', 'media.object.upload'], 'with the verbs in the catalog, sandbox apps may hold them');
    }));
    await withoutCatalog(['media.object.list', 'media.object.delete'], () => {
        assert.deepStrictEqual(policy.settings({}).sandboxAllowance.filter(id => id.startsWith('media.')), ['media.object.read', 'media.object.upload'], 'without them, as before');
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: { authorization: `Bearer ${T[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, text, body: text ? JSON.parse(text) : null };
    };
    const cc = (appId, secret, audience, extra = {}) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: secret, audience, ...extra }) }).then(async r => ({ status: r.status, body: await r.json() }));
    const verify = (t, audience) => serviceAuth.verifyServiceToken(t, { publicKey: keys.publicKey, issuer: ISSUER, audience, acceptSandbox: true });

    // ── Events written before the relay starts (backfilled later) ──
    let r = await api('owner', 'POST', '', { name: 'Walkthrough' });
    assert.strictEqual(r.status, 201, r.text);
    const P = r.body.id;
    assert.deepStrictEqual(r.body.allowance, [], 'no staff allowance');
    assert.deepStrictEqual(r.body.sandbox_allowance, policy.settings({}).sandboxAllowance, 'the project shows what its sandbox apps may hold');
    r = await api('owner', 'GET', '/catalog');
    assert.deepStrictEqual(r.body.sandbox_allowance, policy.settings({}).sandboxAllowance);

    // ── The walkthrough, with no staff action: sandbox app, grant, token ──
    r = await api('owner', 'POST', `/${P}/apps`, { name: 'examples', environment: 'sandbox', type: 'confidential' });
    assert.strictEqual(r.status, 201, r.text);
    const A = r.body.id;
    const secret = r.body.credential.client_secret;
    for (const c of ['media.object.upload', 'media.object.read', 'tools.job.create']) {
        r = await api('owner', 'POST', `/${P}/apps/${A}/grants`, { capability: c });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.body.status, 'approved', `${c}: an owner's request inside the sandbox allowance is approved at once`);
    }
    let t = await cc(A, secret, 'openvibe.media');
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    let v = verify(t.body.access_token, 'openvibe.media');
    assert.ok(v.ok, v.reason);
    assert.strictEqual(v.claims.env, 'sandbox');
    assert.deepStrictEqual(v.claims.ns, [P, `app.${P}.*`], 'the project, and its app.<project_id>.* namespaces (Media, WS-G task 2)');
    assert.strictEqual(v.claims.project_id, P);
    assert.deepStrictEqual(v.claims.cap, ['media.object.read', 'media.object.upload']);
    assert.strictEqual(serviceAuth.verifyServiceToken(t.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.media' }).code, 'token.sandbox_refused',
        'receivers still refuse it unless they opt in');
    t = await cc(A, secret, 'openvibe.tools');
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.deepStrictEqual(verify(t.body.access_token, 'openvibe.tools').claims.cap, ['tools.job.create']);
    t = await cc(A, secret, 'openvibe.network');
    assert.strictEqual(t.body.error, 'invalid_target', 'Network is not a default sandbox audience');

    // A developer's request waits; an owner approves it inside the sandbox allowance.
    r = await api('owner', 'POST', `/${P}/members`, { username: 'dev', role: 'developer' });
    assert.strictEqual(r.status, 201, r.text);
    r = await api('dev', 'POST', `/${P}/apps/${A}/grants`, { capability: 'tools.job.read' });
    assert.strictEqual(r.body.status, 'requested');
    r = await api('owner', 'POST', `/${P}/apps/${A}/grants/tools.job.read/approve`);
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.body.status, 'approved');
    // Outside the sandbox allowance (a public capability staff did not allow): still refused.
    r = await api('owner', 'POST', `/${P}/apps/${A}/grants`, { capability: 'games.mod.read' });
    assert.strictEqual(r.body.status, 'requested');
    r = await api('owner', 'POST', `/${P}/apps/${A}/grants/games.mod.read/approve`);
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'grant.beyond_allowance');
    r = await api('owner', 'POST', `/${P}/apps/${A}/grants`, { capability: 'network.coins.credit' });
    assert.strictEqual(r.body.code, 'grant.not_grantable');

    // Staff changing the project allowance does not take the sandbox allowance away.
    r = await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['games.mod.read'] });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!r.body.trimmed.some(x => x.app_id === A && x.capability.startsWith('media.')), JSON.stringify(r.body.trimmed));
    assert.strictEqual((await cc(A, secret, 'openvibe.media')).status, 200);

    // ── Production apps still need the staff-set allowance ──
    r = await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' });
    assert.strictEqual(r.status, 200);
    r = await api('owner', 'POST', `/${P}/apps`, { name: 'prod', environment: 'production', type: 'confidential' });
    assert.strictEqual(r.status, 201, r.text);
    const C = r.body.id;
    const prodSecret = r.body.credential.client_secret;
    r = await api('owner', 'POST', `/${P}/apps/${C}/grants`, { capability: 'media.object.upload' });
    assert.strictEqual(r.body.status, 'requested', 'no sandbox allowance for production apps');
    r = await api('owner', 'POST', `/${P}/apps/${C}/grants/media.object.upload/approve`);
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'grant.beyond_allowance');
    assert.strictEqual((await cc(C, prodSecret, 'openvibe.media')).body.error, 'invalid_scope');
    r = await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload'] });
    r = await api('owner', 'POST', `/${P}/apps/${C}/grants/media.object.upload/approve`);
    assert.strictEqual(r.status, 200, r.text);
    t = await cc(C, prodSecret, 'openvibe.media');
    assert.strictEqual(t.status, 200);
    assert.strictEqual(verify(t.body.access_token, 'openvibe.media').claims.env, 'production');
    // A production app's grant outside the new allowance is trimmed as before.
    r = await api('staff', 'PUT', `/${P}/allowance`, { capabilities: [] });
    assert.ok(r.body.trimmed.some(x => x.app_id === C && x.capability === 'media.object.upload'));
    assert.ok(!r.body.trimmed.some(x => x.app_id === A && x.capability === 'media.object.upload'));

    // ── events.app.* in sandbox without staff ──
    {
        for (const c of ['events.app.publish', 'events.app.read', 'events.app.subscribe']) {
            r = await api('owner', 'POST', `/${P}/apps/${A}/grants`, { capability: c });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.body.status, 'approved', c);
            assert.strictEqual(r.body.audience, 'openvibe.events');
        }
        t = await cc(A, secret, 'openvibe.events');
        assert.strictEqual(t.status, 200, JSON.stringify(t.body));
        v = verify(t.body.access_token, 'openvibe.events');
        assert.deepStrictEqual(v.claims.cap, ['events.app.publish', 'events.app.read', 'events.app.subscribe']);
        assert.strictEqual(v.claims.env, 'sandbox');
        r = await api('owner', 'POST', `/${P}/apps/${C}/grants`, { capability: 'events.app.publish' });
        assert.strictEqual(r.body.status, 'requested', 'production still needs staff');
    }
    // Without the capabilities in the catalog they fall out of tokens again (grantability is re-checked).
    await withoutCatalog(EVENTS_APP_IDS, async () => {
        t = await cc(A, secret, 'openvibe.events');
        assert.strictEqual(t.body.error, 'invalid_scope');
    });

    // ── Relay off: nothing is sent ──
    assert.strictEqual(relay.startRelay(db, { eventsUrl: '', privateKey: keys.privateKey, issuer: ISSUER, fetch: () => { throw new Error('no fetch when off'); } }), null);
    assert.strictEqual(relay.outboxFor(db), null);
    // (The table itself exists from boot: user modules write their events into it whether or not a relay runs.)
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM network_event_outbox').get().n, 0, 'nothing queued while the relay is off');

    // ── Relay on: a fake Events receives every envelope once, in order, with a Network service token ──
    const received = [];
    const stored = new Map();
    const tokensSeen = [];
    const events = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            tokensSeen.push(String(req.headers.authorization || '').replace(/^Bearer /, ''));
            const parsed = JSON.parse(body);
            const list = parsed.events || [parsed];
            const results = list.map(e => {
                received.push(e);
                const dup = stored.has(e.event_id);
                if (!dup) stored.set(e.event_id, stored.size + 1);
                return { event_id: e.event_id, seq: stored.get(e.event_id), duplicate: dup };
            });
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify(parsed.events ? { results } : results[0]));
        });
    });
    await new Promise(res => events.listen(0, '127.0.0.1', res));
    const eventsUrl = `http://127.0.0.1:${events.address().port}`;
    const before = db.prepare('SELECT event FROM dev_audit WHERE event IS NOT NULL ORDER BY id').all().map(x => JSON.parse(x.event).event_id);
    assert.ok(before.length >= 5, 'the walkthrough produced events');
    let outbox = relay.startRelay(db, { eventsUrl, privateKey: keys.privateKey, issuer: ISSUER, autoStart: false, log: quiet });
    assert.ok(outbox);
    assert.strictEqual(outbox.pending(), before.length, 'events written while the relay was off are backfilled');
    // A new event now goes into the outbox in the same transaction as its audit row.
    r = await api('owner', 'POST', `/${P}/apps`, { name: 'later', environment: 'sandbox', type: 'confidential' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(outbox.pending(), before.length + 1);
    let flushed = await outbox.flush();
    assert.strictEqual(flushed.sent, before.length + 1, JSON.stringify(flushed));
    const all = db.prepare('SELECT event FROM dev_audit WHERE event IS NOT NULL ORDER BY id').all().map(x => JSON.parse(x.event));
    assert.deepStrictEqual(received.map(e => e.event_id), all.map(e => e.event_id), 'published in dev_audit id order');
    for (const e of received) {
        assert.ok(validate('events.event-envelope@1', e).valid, JSON.stringify(e));
        assert.strictEqual(e.source, 'network');
    }
    assert.ok(received.some(e => e.event_type === 'network.app.created' && e.subject.id === r.body.id));
    for (const tok of new Set(tokensSeen)) {
        const tv = serviceAuth.verifyServiceToken(tok, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.events' });
        assert.ok(tv.ok, tv.reason);
        assert.strictEqual(tv.claims.sub, 'svc:network');
        assert.deepStrictEqual(tv.claims.cap, ['events.event.publish']);
        assert.ok(tv.claims.exp - tv.claims.iat <= 300);
        assert.ok(validate('identity.service-token-claims@1', tv.claims).valid);
    }
    // Duplicates are harmless: a republished row is answered as a duplicate and stored once.
    db.prepare(`UPDATE ${relay.TABLE} SET sent_at = NULL WHERE id = (SELECT MAX(id) FROM ${relay.TABLE})`).run();
    flushed = await outbox.flush();
    assert.strictEqual(flushed.sent, 1);
    assert.strictEqual(stored.size, all.length, 'Events stored each event once');
    // A restart backfills nothing new and sends nothing twice.
    await relay.stopRelay(db);
    outbox = relay.startRelay(db, { eventsUrl, privateKey: keys.privateKey, issuer: ISSUER, autoStart: false, log: quiet });
    assert.strictEqual(outbox.pending(), 0);
    const n = received.length;
    await outbox.flush();
    assert.strictEqual(received.length, n);
    // The audit and the outbox row are one transaction: a failing enqueue leaves no audit row.
    const auditCount = db.prepare('SELECT COUNT(*) AS n FROM dev_audit').get().n;
    const origEnqueue = outbox.enqueue;
    outbox.enqueue = () => { throw new Error('boom'); };
    r = await api('owner', 'POST', `/${P}/apps`, { name: 'atomic', environment: 'sandbox', type: 'confidential' });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM dev_audit').get().n, auditCount, 'no audit row without its outbox row');
    outbox.enqueue = origEnqueue;
    await relay.stopRelay(db);

    server.close(); events.close();
    console.log('developer defaults and events relay: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
