'use strict';
// The owner's platform settings proxy (server/admin/ai-config-proxy.js, AI Exchange D11 S3) against fake services:
// every route maps to the service's /internal/config with Network's own token, the owner's usr_ id in X-OV-Subject
// and (when fresh) X-OV-Fresh; a secret write or an x-danger change needs a sign-in within 10 minutes; an invalid
// summary is dropped with a warning; every secret and danger change is audited and raises an operator alert; and no
// value ever reaches a Network table or log line.
// The Setup tab (2026-11-07) adds: seventeen services, each secret's marker (hint and date) forwarded, and the test
// route, whose outcome is kept as an ai_config_test audit row and never carries a value.
//   node test/ai-config-proxy.test.js
const assert = require('assert');
const http = require('http');
const jwt = require('jsonwebtoken');
const { buildWorld } = require('./security-world');
const { checkSecretsStored } = require('./security-suite');
const principals = require('../server/identity/principals');

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const NOW = new Date().toISOString();
const FP = 'a'.repeat(64);

/** A fake service: records every request and answers from `routes` ({ 'METHOD /path': body | fn }). */
function fake(name) {
    const seen = [];
    const holder = { name, seen, routes: {} };
    holder.srv = http.createServer((req, res) => {
        let text = '';
        req.on('data', (d) => { text += d; });
        req.on('end', () => {
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch { body = text; }
            const rec = { method: req.method, url: req.url, headers: req.headers, body, text };
            seen.push(rec);
            const key = `${req.method} ${req.url.split('?')[0]}`;
            const hit = holder.routes[key];
            const answer = typeof hit === 'function' ? hit(rec) : hit;
            if (answer === undefined) { res.writeHead(404, { 'content-type': 'application/problem+json' }); return res.end(JSON.stringify({ code: 'config.route_not_found', error: 'no such route' })); }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(answer));
        });
    });
    return new Promise((resolve) => holder.srv.listen(0, '127.0.0.1', () => { holder.url = `http://127.0.0.1:${holder.srv.address().port}`; resolve(holder); }));
}

function summary(service, namespace, extra = {}) {
    return {
        service, namespace, revision: 7,
        values: { paid_requests: false, daily_budget_nano_usd: 2500000000, model_catalog: ['deepseek-chat'], routing: 'auto' },
        classification: { paid_requests: 'internal', daily_budget_nano_usd: 'internal', model_catalog: 'internal', routing: 'internal' },
        sealed: true, pins: [], schema: {
            title: 'AI Exchange', description: 'What the exchange routes, spends and models.',
            type: 'object',
            properties: {
                paid_requests: { type: 'boolean', title: 'Paid AI requests', description: 'Paid AI requests will spend Credits', 'x-danger': true },
                daily_budget_nano_usd: { type: 'integer', title: 'Daily budget', 'x-unit': 'nano_usd' },
                model_catalog: { type: 'array', title: 'Model catalog' },
                routing: { type: 'string', title: 'Routing', enum: ['auto', 'pinned'] },
            },
        },
        active: null, last_known_good: null,
        ...extra,
    };
}

(async () => {
    const SECRET = 'proxy-sentinel-value-3f9a1c-do-not-store';
    const OWNER = 'rootowner';
    const ai = await fake('ai');
    const billing = await fake('billing');
    const run = await fake('run');
    let w = null;
    try {
        w = await buildWorld({
            label: 'ai-config',
            env: { OV_AI_INTERNAL_URL: ai.url, OV_BILLING_INTERNAL_URL: billing.url, OV_RUN_INTERNAL_URL: run.url, AI_CONFIG_WRITES_PER_HOUR: '60' },
        });
        const owner = w.users.owner;
        ai.seen.length = 0; billing.seen.length = 0;
        const configCalls = () => [...ai.seen, ...billing.seen].filter((x) => x.url.startsWith('/internal/config') || x.url.startsWith('/api/v1/providers'));
        const configWrites = () => configCalls().filter((x) => !['GET', 'HEAD'].includes(x.method));
        const fresh = jwt.sign({ sub: owner.id, id: owner.id, username: owner.username, subject_id: owner.subject, role: owner.role, auth_time: Math.floor(Date.now() / 1000) },
            w.keys.privateKey, { algorithm: 'RS256', issuer: w.issuer, expiresIn: '1h' });
        const stale = w.users.owner.token;   // no auth_time: an old session shape
        const call = (who, method, p, body) => w.call(who, method, p, body);
        const ownerCall = (method, p, body) => call({ authorization: `Bearer ${fresh}`, cookie: `ov_token=${fresh}` }, method, p, body);

        // ── The answer the fakes give, per namespace ───────────────────
        const exchange = summary('ai', 'ai.exchange', { kek: 'k1', secrets: { provider_key: { redacted: true, fingerprint: FP, hint: 'a1b2', set_at: NOW, set_by: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, bound_to: 'https://api.deepseek.com', value: SECRET } } });
        const broken = summary('ai', 'ai.broken', { values: { api_key: { redacted: true, fingerprint: FP, hint: 'a1b2', value: SECRET } } });
        const credits = summary('billing', 'billing.credits', { sealed: false });
        const creditsBroken = summary('billing', 'billing.broken', { values: { api_key: { redacted: true, fingerprint: FP, value: 'a-plain-value' } } });
        Object.assign(ai.routes, {
            'GET /internal/config': { namespaces: [exchange, broken] },
            'GET /internal/config/ai.exchange': exchange,
            'GET /internal/config/ai.exchange/history': { namespace: 'ai.exchange', snapshots: [{ revision: 7, reason: 'seed' }], next_before: null },
            'POST /internal/config/ai.exchange': { service: 'ai', namespace: 'ai.exchange', revision: 8, state: 'active' },
            'POST /internal/config/ai.exchange/rollback': { service: 'ai', namespace: 'ai.exchange', revision: 9, state: 'active' },
            'PUT /internal/config/ai.exchange/secrets/provider_key': { redacted: true, fingerprint: FP, hint: 'a1b2', set_at: NOW, bound_to: 'https://api.deepseek.com' },
            'DELETE /internal/config/ai.exchange/secrets/provider_key': { redacted: true, fingerprint: FP, hint: 'a1b2', set_at: NOW, bound_to: null },
            'POST /internal/config/ai.exchange/test/provider_key': { ok: false, message: '401 Unauthorized:\n the key was refused' },
            'PUT /internal/config/ai.provider_keys/secrets/deepseek': { redacted: true, fingerprint: FP, hint: 'a1b2', set_at: NOW, bound_to: 'https://api.deepseek.com' },
            'DELETE /internal/config/ai.provider_keys/secrets/deepseek': { redacted: true, fingerprint: FP, hint: 'a1b2', set_at: NOW, bound_to: null },
            'GET /api/v1/providers': { providers: [{ key: 'deepseek', display_name: 'DeepSeek', kind: 'openai', status: 'active', base_url: 'https://api.deepseek.com', secret_ref: 'vault:deepseek', billing_profile: 'metered', metadata: { provider_access: 'OWN_DEPLOYMENT' }, credentials: 'configured' }] },
            'POST /api/v1/providers': { provider: { key: 'new', display_name: 'New', kind: 'openai', status: 'active', base_url: 'https://new.example', secret_ref: null, billing_profile: 'metered', credentials: 'missing' } },
            'PATCH /api/v1/providers/deepseek': { provider: { key: 'deepseek', display_name: 'DeepSeek', kind: 'openai', status: 'active', base_url: 'https://api.deepseek.com', secret_ref: 'vault:deepseek', billing_profile: 'metered', credentials: 'configured' } },
        });
        Object.assign(billing.routes, {
            'GET /internal/config': { namespaces: [credits, creditsBroken] },
            'GET /internal/config/billing.credits': credits,
        });

        run.routes['GET /internal/config/compute-status'] = {enabled:false,dry_run:true,budgets:[{provider:'daytona',near_cap:true,cap:'10',committed_micros:'8000000',currency:'USD'}]};
        assert.strictEqual((await call('staff','GET','/api/admin/ai/config/compute/status')).status,403);
        const compute = await ownerCall('GET','/api/admin/ai/config/compute/status');
        assert.strictEqual(compute.status,200);
        assert.strictEqual(compute.body.compute.budgets[0].near_cap,true);
        const computeRequest = run.seen.find((request) => request.url === '/internal/config/compute-status');
        assert.ok(computeRequest && computeRequest.headers['x-ov-subject']);

        // ── Only the owner: a user and a plain admin are refused, and nothing reaches a service ──
        let r = await call('alice', 'GET', '/api/admin/ai/config/services');
        assert.strictEqual(r.status, 403, 'a user never gets the owner settings');
        r = await call('staff', 'GET', '/api/admin/ai/config/services');
        assert.strictEqual(r.status, 403, 'a plain admin never gets the owner settings');
        assert.strictEqual(configCalls().length, 0, 'a refused request never reaches a service');

        // ── GET /services: the seventeen services and their operator-set internal URLs ──
        r = await ownerCall('GET', '/api/admin/ai/config/services');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body.services.map((s) => s.service), ['ai', 'billing', 'services', 'watch', 'bench', 'report', 'host', 'codes', 'actor', 'chat', 'connect', 'deals', 'work', 'sources', 'design', 'domains', 'media', 'run', 'mail']);
        assert.strictEqual(r.body.services.find((s) => s.service === 'deals').name, 'OpenVibe.Deals');
        assert.strictEqual(r.body.services.find((s) => s.service === 'deals').capability, 'deals.config.manage');
        assert.strictEqual(r.body.services.find((s) => s.service === 'ai').internal_url, ai.url);
        assert.strictEqual(r.body.services.find((s) => s.service === 'billing').internal_url, billing.url);

        // ── GET /:service: an invalid summary is dropped, with a warning row; the vault keeps the KEK ──
        r = await ownerCall('GET', '/api/admin/ai/config/service/ai');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body.namespaces.map((n) => n.namespace), ['ai.exchange'], 'the unambiguous /service/:service alias lists a service');
        r = await ownerCall('GET', '/api/admin/ai/config/ai');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body.namespaces.map((n) => n.namespace), ['ai.exchange'], 'the invalid summary is dropped');
        assert.strictEqual(r.body.warnings.length, 1);
        assert.strictEqual(r.body.warnings[0].namespace, 'ai.broken');
        assert.match(r.body.warnings[0].detail, /api_key|redacted|additional/i);
        assert.deepStrictEqual(r.body.vault, { sealed: true, kek: 'k1' });
        assert.ok(!r.text.includes(SECRET), 'the dropped summary never reaches the browser');
        assert.deepStrictEqual(r.body.namespaces[0].secret_markers, { provider_key: { hint: 'a1b2', set_at: NOW, fingerprint: FP, bound_to: 'https://api.deepseek.com' } },
            'a secret\'s hint and date reach the panel, and nothing else of its marker');
        const listCall = ai.seen.find((x) => x.method === 'GET' && x.url === '/internal/config');
        assert.match(listCall.headers.authorization, /^Bearer /, 'the service gets Network\'s own token');
        assert.strictEqual(listCall.headers['x-ov-subject'], owner.subject, 'the owner travels in X-OV-Subject');
        assert.strictEqual(billing.seen.filter((x) => x.url.startsWith('/internal/config')).length, 0, 'AI is the only service asked so far');

        // ── GET one namespace, and its history (query kept) ──
        r = await ownerCall('GET', '/api/admin/ai/config/ai/ai.exchange');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.namespace.revision, 7);
        assert.ok(Array.isArray(r.body.namespace.pins));
        r = await ownerCall('GET', '/api/admin/ai/config/ai/ai.exchange/history?limit=5');
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(ai.seen.some((x) => x.url === '/internal/config/ai.exchange/history?limit=5'), 'the history query reaches AI');

        // ── A stale sign-in: secret and danger writes are refused before any service sees them ──
        const before = configWrites().length;
        r = await call({ authorization: `Bearer ${stale}`, cookie: `ov_token=${stale}` }, 'PUT', '/api/admin/ai/config/ai/ai.exchange/secrets/provider_key', { value: SECRET, reason: 'test' });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.body.code, 'config.fresh_required');
        assert.match(r.body.sign_in_url, /\/login\?reauth=1&return=.*%2Fadmin%23ai/, 'the sign-in asks for the password again and returns to /admin#ai');
        r = await call({ authorization: `Bearer ${stale}`, cookie: `ov_token=${stale}` }, 'POST', '/api/admin/ai/config/ai/ai.exchange', { values: { paid_requests: true }, reason: 'test' });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.body.code, 'config.fresh_required');
        assert.strictEqual(configWrites().length, before, 'a stale sign-in never sends a write to AI');

        // ── A fresh danger change: X-OV-Fresh to the service, an audit row and an operator alert ──
        r = await ownerCall('POST', '/api/admin/ai/config/ai/ai.exchange', { values: { paid_requests: true }, reason: 'turn paid requests on', merge: true });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.revision, 8);
        const dangerCall = ai.seen.filter((x) => x.method === 'POST' && x.url === '/internal/config/ai.exchange').at(-1);
        assert.strictEqual(dangerCall.headers['x-ov-fresh'], '1', 'a fresh danger change tells the service it is fresh');
        assert.deepStrictEqual(dangerCall.body, { values: { paid_requests: true }, reason: 'turn paid requests on', merge: true }, 'the change is streamed through unchanged');
        const audit = await w.db.prepare("SELECT action, details FROM audit_log WHERE user_id = ? AND action = 'ai_config_change' ORDER BY id DESC LIMIT 1").get(owner.id);
        const details = JSON.parse(audit.details);
        assert.deepStrictEqual({ service: details.service, namespace: details.namespace, key: details.key, action: details.action, revision: details.revision },
            { service: 'ai', namespace: 'ai.exchange', key: 'paid_requests', action: 'config.change', revision: 8 });
        assert.strictEqual((await w.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'OPERATOR_ALERT'").get(owner.id)).n, 1, 'the danger change raises one operator alert');
        const note = await w.db.prepare("SELECT title, message FROM notifications WHERE user_id = ? AND type = 'OPERATOR_ALERT' ORDER BY id DESC LIMIT 1").get(owner.id);
        assert.match(note.message, /ai\.exchange/);
        assert.match(note.message, /paid_requests/);
        assert.match(note.message, new RegExp(`@${OWNER}`));

        // ── A fresh secret write: forwarded once, audited, alerted, and never stored or logged ──
        r = await ownerCall('PUT', '/api/admin/ai/config/ai/ai.exchange/secrets/provider_key', { value: SECRET, reason: 'rotate' });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body, { redacted: true, fingerprint: FP, hint: 'a1b2', set_at: NOW, bound_to: 'https://api.deepseek.com' });
        const secretCall = ai.seen.filter((x) => x.method === 'PUT' && x.url === '/internal/config/ai.exchange/secrets/provider_key').at(-1);
        assert.strictEqual(secretCall.method, 'PUT');
        assert.strictEqual(secretCall.headers['x-ov-fresh'], '1');
        assert.strictEqual(secretCall.body.value, SECRET, 'the service gets the value once');
        assert.strictEqual((await w.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'OPERATOR_ALERT'").get(owner.id)).n, 2, 'the secret write raises another alert');
        const secretAudit = JSON.parse((await w.db.prepare("SELECT details FROM audit_log WHERE user_id = ? AND action = 'ai_config_change' ORDER BY id DESC LIMIT 1").get(owner.id)).details);
        assert.deepStrictEqual({ service: secretAudit.service, namespace: secretAudit.namespace, key: secretAudit.key, action: secretAudit.action }, { service: 'ai', namespace: 'ai.exchange', key: 'provider_key', action: 'secret.put' });
        assert.ok(!JSON.stringify(secretAudit).includes(SECRET));

        // ── Test: the service's one-line answer, kept as an audit row with the fingerprint it tried ──
        r = await call('staff', 'POST', '/api/admin/ai/config/ai/ai.exchange/test/provider_key', {});
        assert.strictEqual(r.status, 403, 'a plain admin cannot run a test');
        r = await call({ authorization: `Bearer ${stale}`, cookie: `ov_token=${stale}` }, 'POST', '/api/admin/ai/config/ai/ai.exchange/test/provider_key', {});
        assert.strictEqual(r.status, 200, 'a test needs no fresh sign-in: it changes nothing and shows nothing of the value');
        assert.deepStrictEqual({ ok: r.body.ok, passed: r.body.passed, message: r.body.message }, { ok: true, passed: false, message: '401 Unauthorized: the key was refused' }, 'one line');
        const testCall = ai.seen.filter((x) => x.method === 'POST' && x.url === '/internal/config/ai.exchange/test/provider_key').at(-1);
        assert.strictEqual(testCall.headers['x-ov-subject'], owner.subject);
        assert.match(testCall.headers.authorization, /^Bearer /);
        const testRow = JSON.parse((await w.db.prepare("SELECT details FROM audit_log WHERE action = 'ai_config_test' ORDER BY id DESC LIMIT 1").get()).details);
        assert.deepStrictEqual({ service: testRow.service, namespace: testRow.namespace, key: testRow.key, passed: testRow.passed, message: testRow.message },
            { service: 'ai', namespace: 'ai.exchange', key: 'provider_key', passed: false, message: '401 Unauthorized: the key was refused' }, 'the test row names the key and keeps the answer');
        const { triedDigest } = require('../server/admin/ai-config-proxy');
        assert.strictEqual(testRow.tried, triedDigest('ai', 'ai.exchange', 'provider_key', undefined, { fingerprint: FP }), 'it keeps a digest of what it tried');
        assert.ok(!JSON.stringify(testRow).includes(FP), 'never the marker\'s fingerprint itself');
        r = await ownerCall('POST', '/api/admin/ai/config/ai/ai.exchange/test/nothing_here', {});
        assert.strictEqual(r.status, 404, 'a key the service does not test relays the service\'s answer');

        // ── Secret delete, rollback, and the provider registry (GET/POST/PATCH and its write-only key) ──
        r = await ownerCall('DELETE', '/api/admin/ai/config/ai/ai.exchange/secrets/provider_key', { reason: 'gone' });
        assert.strictEqual(r.status, 200, r.text);
        r = await ownerCall('POST', '/api/admin/ai/config/ai/ai.exchange/rollback', { to: 6, reason: 'back' });
        assert.strictEqual(r.status, 200, r.text);
        r = await ownerCall('GET', '/api/admin/ai/config/providers');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.providers[0].provider_access, 'OWN_DEPLOYMENT');
        assert.strictEqual(r.body.providers[0].key, 'deepseek');
        assert.ok(ai.seen.filter((x) => x.method === 'GET' && x.url === '/api/v1/providers').every((x) => x.headers['x-ov-subject'] === owner.subject));
        r = await ownerCall('POST', '/api/admin/ai/config/providers', { key: 'new', display_name: 'New', kind: 'openai', base_url: 'https://new.example', billing_profile: 'metered', provider_access: 'UNVERIFIED' });
        assert.strictEqual(r.status, 200, r.text);
        r = await ownerCall('PATCH', '/api/admin/ai/config/providers/deepseek', { display_name: 'DeepSeek 2' });
        assert.strictEqual(r.status, 200, r.text);
        r = await ownerCall('PUT', '/api/admin/ai/config/providers/deepseek/key', { value: SECRET, reason: 'vault it' });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(ai.seen.some((x) => x.method === 'PUT' && x.url === '/internal/config/ai.provider_keys/secrets/deepseek' && x.body.value === SECRET));
        assert.ok(ai.seen.some((x) => x.method === 'PATCH' && x.url === '/api/v1/providers/deepseek' && x.body.secret_ref === 'vault:deepseek'));
        r = await ownerCall('DELETE', '/api/admin/ai/config/providers/deepseek/key', { reason: 'remove' });
        assert.strictEqual(r.status, 200, r.text);

        // ── An invalid service answer is dropped, with a warning row ──
        r = await ownerCall('GET', '/api/admin/ai/config/billing');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body.namespaces.map((n) => n.namespace), ['billing.credits']);
        assert.strictEqual(r.body.warnings.length, 1);
        assert.strictEqual(r.body.warnings[0].namespace, 'billing.broken');
        assert.deepStrictEqual(r.body.vault, { sealed: false, kek: null }, 'the vault says billing is not sealed');

        // ── The grants: nine config.manage capabilities for Network, ai.provider.manage, and Host's usage read ──
        const has = (client, cap, aud) => principals.DEFAULT_GRANTS.some((g) => g[0] === client && g[1] === cap && g[2] === aud);
        for (const svc of ['ai', 'billing', 'services', 'watch', 'bench', 'report', 'host', 'codes', 'actor']) {
            assert.ok(has('network', `${svc}.config.manage`, `openvibe.${svc}`), `Network holds ${svc}.config.manage`);
        }
        // The eight Setup services: Network holds each grant as soon as the pinned Contracts (0.308.0) knows it.
        const { capabilities, version: contractsVersion } = require('openvibe-contracts');
        const setupServices = ['chat', 'connect', 'deals', 'work', 'sources', 'design', 'domains', 'media', 'run'];
        // OpenVibe.Mail holds its owner settings too (the email group): the same proxy reaches it.
        for (const svc of setupServices) {
            const known = !!capabilities.get(`${svc}.config.manage`);
            assert.strictEqual(has('network', `${svc}.config.manage`, `openvibe.${svc}`), known, `Network holds ${svc}.config.manage exactly when Contracts knows it`);
        }
        const [maj, min] = String(contractsVersion || require('openvibe-contracts/package.json').version).split('.').map(Number);
        if (maj > 0 || min >= 308) {
            for (const svc of setupServices) assert.ok(has('network', `${svc}.config.manage`, `openvibe.${svc}`), `from Contracts 0.308.0 Network holds ${svc}.config.manage`);
        }
        assert.ok(has('network', 'ai.provider.manage', 'openvibe.ai'), 'Network holds ai.provider.manage');
        assert.ok(has('host', 'ai.usage.read', 'openvibe.ai'), 'Host holds ai.usage.read');
        // The boot seed only inserts a grant when its client exists. In production the network principal does; here we
        // make it and run the same ensureSchema() the deploy runs at boot, then check the rows.
        await w.db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('network', 'x', 'OpenVibe.Network (service)', '[]', 1) ON CONFLICT DO NOTHING").run();
        await principals.ensureSchema(w.db);
        const seeded = (await w.db.prepare("SELECT capability, audience FROM principal_grants WHERE client_id = 'network' AND capability LIKE '%config.manage' AND revoked_at IS NULL ORDER BY capability").all()).map((x) => `${x.capability}|${x.audience}`).sort();
        const expectSeeded = ['actor', 'ai', 'bench', 'billing', 'codes', 'host', 'report', 'services', 'watch', ...setupServices.filter((svc) => capabilities.get(`${svc}.config.manage`))]
            .map((svc) => `${svc}.config.manage|openvibe.${svc}`).sort();
        assert.deepStrictEqual(seeded, expectSeeded);
        assert.ok(await w.db.prepare("SELECT 1 FROM principal_grants WHERE client_id = 'network' AND capability = 'ai.provider.manage' AND audience = 'openvibe.ai' AND revoked_at IS NULL").get(), 'the provider grant is seeded');
        assert.ok(await w.db.prepare("SELECT 1 FROM principal_grants WHERE client_id = 'host' AND capability = 'ai.usage.read' AND audience = 'openvibe.ai' AND revoked_at IS NULL").get(), 'Host\'s usage grant is seeded');

        // ── No secret in a Network table or log line (the audit and alerts above ran meanwhile) ──
        await checkSecretsStored(w, () => ({ 'proxy secret': SECRET, 'proxy secret hint': FP }));

        // ── 60 writes an hour: keep writing until the limit answers 429 ──
        let limited = null;
        for (let i = 0; i < 70 && !limited; i++) {
            const rr = await ownerCall('POST', '/api/admin/ai/config/ai/ai.exchange', { values: { routing: 'auto' }, reason: 'limit probe', merge: true });
            if (rr.status === 429) limited = rr;
        }
        assert.ok(limited, 'the owner is rate-limited after the allowance');
        assert.strictEqual(limited.body.code, 'config.rate_limited');

        out('ai config proxy: all checks passed');
    } finally {
        if (w) await w.stop();
        await new Promise((r) => ai.srv.close(r));
        await new Promise((r) => billing.srv.close(r));
        await new Promise((r) => run.srv.close(r));
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
