'use strict';
// Metrics and readiness (server/observability.js): token issuance by grant type, principal-token
// failures, route-template labels, loopback-only /metrics, and a /api/ready that fails only on a
// required dependency. Roadmap Track O.
//   node test/observability.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const metrics = require('openvibe-shared/metrics');
const { initDb } = require('../server/db/database');
const observability = require('../server/observability');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-observability-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
metrics.instrument(app, { service: 'network', release: 'abc123def456', registry: observability.registry });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { internalKey: 'legacy-key', jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth/token', observability.tokenEndpointMetrics);
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal', require('../server/internal/routes'));

let keysNow = { privateKey: keys.privateKey, publicKey: keys.publicKey };
let lastPoll = null;
let discordReady = false;
const ready = observability.createNetworkReadiness({
    db, release: 'abc123def456', production: true,
    getKeys: () => keysNow,
    ecosystem: { lastPollAt: () => lastPoll },
    discordService: { isReady: () => discordReady, _getSetting: () => 'configured-token' },
});
app.get('/api/ready', ready.handler);
// The release manifest as server/index.js mounts it: GET /release.json, POST /release-metrics into /metrics.
const release = require('openvibe-shared/release').createRelease({ service: 'network', root: path.join(__dirname, '..') });
release.mount(app, { registry: observability.registry });
const server = http.createServer(app);

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const form = (body) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async r => ({ status: r.status, body: await r.json() }));
    const get = (p, headers = {}) => fetch(base + p, { headers }).then(async r => ({ status: r.status, text: await r.text() }));

    // ── Token issuance and failures by grant type ──
    let t = await form({ grant_type: 'client_credentials', client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 200);
    const svcToken = t.body.access_token;
    t = await form({ grant_type: 'client_credentials', client_id: 'live', client_secret: 'wrong', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 401);
    t = await form({ grant_type: 'refresh_token', client_id: 'live', client_secret: 'live-secret', refresh_token: 'nope' });
    assert.ok(t.status >= 400);
    t = await form({ grant_type: 'password', client_id: 'live', client_secret: 'live-secret' });
    assert.strictEqual(t.status, 400);

    // ── Principal (service-token) failures at guarded routes ──
    const narrow = await form({ grant_type: 'client_credentials', client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network', scope: 'network.coins.credit' });
    let r = await fetch(`${base}/internal/coins/debit`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${narrow.body.access_token}` }, body: JSON.stringify({ user_id: 1, app_id: 'live', amount: 1, reason: 't', idempotency_key: 'k1' }) });
    assert.strictEqual(r.status, 403);
    r = await fetch(`${base}/internal/coins/credit`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${svcToken}` }, body: JSON.stringify({ user_id: 1, app_id: 'games', amount: 1, reason: 't', idempotency_key: 'k2' }) });
    assert.strictEqual(r.status, 403);
    r = await fetch(`${base}/internal/coins/credit`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-token' }, body: '{}' });
    assert.strictEqual(r.status, 401);

    // ── Release manifest (ADR-016) and open tabs' update reports ──
    const rel = await get('/release.json');
    assert.strictEqual(rel.status, 200);
    const manifest = JSON.parse(rel.text);
    assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', manifest).errors, []);
    assert.strictEqual(release.validate().valid, true);
    assert.strictEqual(manifest.metrics_url, '/release-metrics');
    r = await fetch(`${base}/release-metrics`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ counts: { applied: { style: 2 }, reloaded: { nonsense: 1 } } }) });
    assert.strictEqual(r.status, 204);

    const m = await get('/metrics');
    assert.strictEqual(m.status, 200);
    assert.ok(m.text.includes('release_client_updates_total{outcome="applied",reason="style"} 2\n'), m.text);
    assert.ok(m.text.includes('release_client_updates_total{outcome="reloaded",reason="other"} 1\n'), 'unknown reasons never become labels');
    assert.ok(m.text.includes('network_tokens_issued_total{grant_type="client_credentials"} 2\n'), m.text);
    assert.ok(m.text.includes('network_token_failures_total{grant_type="client_credentials",error="invalid_client"} 1\n'));
    assert.ok(/network_token_failures_total\{grant_type="refresh_token",error="[a-z_]+"\} 1\n/.test(m.text));
    assert.ok(m.text.includes('network_token_failures_total{grant_type="other",error="unsupported_grant_type"} 1\n'), 'unknown grant types never become labels');
    assert.ok(m.text.includes('network_principal_token_failures_total{code="capability.denied"} 1\n'));
    assert.ok(m.text.includes('network_principal_token_failures_total{code="capability.owner_denied"} 1\n'));
    assert.ok(m.text.includes('http_requests_total{method="POST",route="/oauth/token",status_class="2xx"} 2\n'));
    assert.ok(m.text.includes('release_info{service="network",release="abc123def456"} 1\n'));
    assert.ok(!/secret|live-secret|not-a-token/.test(m.text), 'no credentials in metrics');
    assert.strictEqual((await get('/metrics', { 'x-forwarded-for': '198.51.100.7' })).status, 404, '/metrics through a proxy is 404');

    // ── Readiness ──
    let rd = await get('/api/ready');
    let body = JSON.parse(rd.text);
    assert.strictEqual(rd.status, 200, rd.text);
    assert.strictEqual(body.status, 'degraded', 'poll not run yet and discord configured but down: optional only');
    assert.deepStrictEqual(body.degraded.sort(), ['discord_bot', 'registry_poll']);
    assert.strictEqual(body.checks.db.status, 'ok');
    assert.strictEqual(body.checks.signing_key.status, 'ok');
    assert.strictEqual(body.checks.signing_key.required, true);
    for (const c of Object.values(body.checks)) { assert.ok(c.checked_at && typeof c.latency_ms === 'number'); }

    lastPoll = Date.now(); discordReady = true;
    rd = await get('/api/ready'); body = JSON.parse(rd.text);
    assert.strictEqual(body.status, 'ready');

    // An ephemeral HS256 key in production is not ready: nothing else can verify its tokens.
    const eph = crypto.randomBytes(32).toString('hex');
    keysNow = { privateKey: eph, publicKey: eph };
    const ready2 = observability.createNetworkReadiness({ db, release: 'x', production: true, getKeys: () => keysNow });
    body = await ready2.run();
    assert.strictEqual(body.ready, false);
    assert.deepStrictEqual(body.failed, ['signing_key']);
    const devReady = observability.createNetworkReadiness({ db, release: 'x', production: false, getKeys: () => keysNow });
    body = await devReady.run();
    assert.strictEqual(body.ready, true, 'outside production the dev key only degrades');
    assert.deepStrictEqual(body.degraded, ['signing_key']);

    // The database gone: not ready.
    console.log = () => {};
    const db2 = initDb(path.join(dir, 'other.db'));
    console.log = log;
    const ready3 = observability.createNetworkReadiness({ db: db2, release: 'x', production: true, getKeys: () => ({ privateKey: keys.privateKey, publicKey: keys.publicKey }) });
    db2.close();
    body = await ready3.run();
    assert.strictEqual(body.ready, false);
    assert.deepStrictEqual(body.failed, ['db']);

    server.close();
    db.close();
    console.log('observability: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
