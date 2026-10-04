'use strict';
// Confirmations, owner side (plan T2 WS-Z2 slice 4, docs/t2-projects-and-grants.md sections 3-5 and 7;
// server/developer/confirmations.js): views are network.confirmation-request@1; create → approve → consume once;
// digest mismatch, deny, expiry (lazy and swept), the service's cancel, standing rules once/session/until/always and
// their revocation; only the owner sees one; 20 pending per agent; the wrong audience; audits without summary/details;
// one revoke-after-approval case per cause; authority that lapses without a write; two concurrent consumes.
// Most rows are created and consumed through the store; the /internal/confirmations routes (slice 7) are checked with
// service tokens: the gate, one service never seeing another's, consume once with the digest, expiry and cancel.
//   node test/confirmations.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const grantsAdmin = require('../server/identity/grants-admin');
const accountData = require('../server/identity/account-data');
const confirmations = require('../server/developer/confirmations');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
const PEOPLE = [[10, 'owner'], [11, 'admin'], [12, 'dev'], [13, 'stranger'], [14, 'staff'], [17, 'erased']];
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (10, 'owner', 'x', 'user'), (11, 'admin', 'x', 'user'), (12, 'dev', 'x', 'user'), (13, 'stranger', 'x', 'user'), (14, 'staff', 'x', 'admin'), (17, 'erased', 'x', 'user')`).run();
await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('actor', 'x', 'OpenVibe.Actor', '[]', 1)").run();
// No service holds network.confirmation.manage by default (no receiver ships yet): Media and Tools get it here, Live does not.
for (const c of ['media', 'tools', 'live']) await db.prepare(`UPDATE oauth_clients SET client_secret = '${c}-secret' WHERE client_id = ?`).run(c);
for (const c of ['media', 'tools']) await db.prepare("INSERT INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES (?, 'network.confirmation.manage', 'openvibe.network', '[]', 'test')").run(c);
const S = {};
for (const [id, name] of PEOPLE) S[name] = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { sandboxAllowance: 'media.object.read', agentHostServices: 'actor' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal', require('../server/internal/routes'));
app.use('/api/v1/projects', require('../server/developer/routes').router());
app.use('/api/v1/confirmations', confirmations.router());
const server = http.createServer(app);
const T = {};
for (const [id, name] of PEOPLE) T[name] = jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (who, method, p, body) => {
        const r = await fetch(`${base}${p}`, { method, headers: { ...(who ? { authorization: `Bearer ${T[who]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') || '', body: text ? JSON.parse(text) : null };
    };
    const api = (who, method, p, body) => call(who, method, `/api/v1/projects${p}`, body);
    const inbox = (who, method, p, body) => call(who, method, `/api/v1/confirmations${p}`, body);
    const ok = (r, status = 200) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); return r.body; };
    const refused = (r, status, code) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); assert.strictEqual(r.body.code, code); assert.match(r.type, /problem\+json/); };
    const rejects = (p, status, code) => assert.rejects(p, (e) => { assert.deepStrictEqual([e.status, e.code], [status, code], e.message); return true; });
    const valid = (doc) => { const v = validate('network.confirmation-request@1', doc); assert.ok(v.valid, JSON.stringify(v.errors)); return doc; };
    const row = async (id) => await db.prepare('SELECT * FROM dev_confirmations WHERE id = ?').get(id);
    const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
    const D = digest('DELETE /v1/objects/obj_1');
    const SUMMARY = 'Delete the photo "beach-secret.jpg" from your library';
    const DETAILS = { note: 'private-detail-text', count: 1 };
    const audOf = (cap) => `openvibe.${cap.split('.')[0]}`;
    const ask = (agentId, capability = 'media.object.delete', extra = {}) => confirmations.create(db, {
        agentId, capability, audience: audOf(capability), summary: SUMMARY, details: DETAILS,
        resources: [{ service: 'media', type: 'object', id: 'obj_1' }], requestDigest: D, ...extra,
    });
    const spend = (c, extra = {}) => confirmations.consume(db, { id: c.id, audience: audOf(c.capability), requestDigest: D, ...extra });
    const approve = async (c, who = 'owner', body = {}) => ok(await inbox(who, 'POST', `/${c.id}/approve`, body));
    const svcToken = async (id) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: `${id}-secret`, audience: 'openvibe.network' }) })).json()).access_token;
    const SVC = {};
    for (const c of ['media', 'tools', 'live']) SVC[c] = await svcToken(c);
    const internal = async (who, method, p, body) => {
        const r = await fetch(`${base}/internal/confirmations${p}`, { method, headers: { ...(who ? { authorization: `Bearer ${SVC[who]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') || '', text, body: text ? JSON.parse(text) : null };
    };
    for (const c of ['chat.message.send']) await grantsAdmin.grant(db, { client_id: 'actor', capability: c, reason: 'agent host test' }, null);

    // A project with a production app holding media.object.delete and .upload, an admin and a developer member.
    let n = 0;
    const project = async () => {
        const P = ok(await api('owner', 'POST', '', { name: `Confirm ${++n}` }), 201).id;
        for (const [name, role] of [['admin', 'admin'], ['dev', 'developer']]) ok(await api('owner', 'POST', `/${P}/members`, { username: name, role }), 201);
        ok(await api('staff', 'PUT', `/${P}/environment-policy`, { environment_policy: 'sandbox+production' }));
        ok(await api('staff', 'PUT', `/${P}/allowance`, { capabilities: ['media.object.upload', 'media.object.delete'] }));
        const PR = ok(await api('owner', 'POST', `/${P}/apps`, { name: 'Bot', environment: 'production' }), 201).id;
        for (const c of ['media.object.upload', 'media.object.delete']) ok(await api('owner', 'POST', `/${P}/apps/${PR}/grants`, { capability: c }), 201);
        return { P, PR };
    };
    // An agent with media.object.delete (confirm) and media.object.upload (auto), or a service-hosted one with chat.message.send.
    const appAgent = async ({ P, PR }, who = 'owner') => {
        const id = ok(await api(who, 'POST', `/${P}/agents`, { name: 'Bot', host: { type: 'app', id: PR } }), 201).id;
        ok(await api(who, 'PUT', `/${P}/agents/${id}/grants/media.object.delete`, {}));
        ok(await api(who, 'PUT', `/${P}/agents/${id}/grants/media.object.upload`, { mode: 'auto' }));
        return id;
    };
    const svcAgent = async ({ P }, who = 'owner') => {
        const id = ok(await api(who, 'POST', `/${P}/agents`, { name: 'Helper', host: { type: 'service', id: 'actor' } }), 201).id;
        ok(await api(who, 'PUT', `/${P}/agents/${id}/grants/chat.message.send`, {}));
        return id;
    };
    const approved = async (agentId, capability) => { const c = await ask(agentId, capability); await approve(c); return c; };
    const cancelledBy = async (c, reason) => {
        const r = await row(c.id);
        assert.deepStrictEqual([r.state, r.cancel_reason, r.used_at], ['cancelled', reason, null], `${c.id} cancelled by ${reason}`);
        await rejects(spend(c), 409, 'confirmation.cancelled');
    };

    try {
        const W = await project();
        const bot = await appAgent(W);

        // ── create → approve → consume once ──
        const c1 = valid(await ask(bot));
        assert.deepStrictEqual([c1.state, c1.owner, c1.requested_by, c1.capability, c1.summary, c1.details, c1.standing_rule, c1.decided_at],
            ['pending', { type: 'user', id: S.owner }, { type: 'agent', id: bot }, 'media.object.delete', SUMMARY, DETAILS, undefined, undefined]);
        for (const k of ['audience', 'session_id', 'request_digest', 'rule_id', 'used_at', 'decided_by', 'cancel_reason', 'project_id']) assert.ok(!(k in c1), `${k} stays Network-local`);
        assert.ok(Date.parse(c1.expires_at) - Date.parse(c1.created_at) >= 899_000, 'ttl defaults to 900 s');
        await rejects(spend(c1), 409, 'confirmation.not_pending');
        const listed = ok(await inbox('owner', 'GET', '/'));
        assert.match((await inbox('owner', 'GET', '/')).cache, /private/);
        assert.deepStrictEqual(listed.confirmations.map((c) => c.id), [c1.id]);
        listed.confirmations.forEach(valid);
        assert.deepStrictEqual(listed.agents[bot], { name: 'Bot', project_id: W.P, host: { type: 'app', id: W.PR } });
        assert.strictEqual(listed.next_before, null);
        const one = ok(await inbox('owner', 'GET', `/${c1.id}`));
        valid(one.confirmation);
        assert.strictEqual(one.agent.name, 'Bot');
        const a1 = await approve(c1);
        valid(a1.confirmation);
        assert.deepStrictEqual([a1.confirmation.state, a1.confirmation.standing_rule, a1.rule], ['approved', 'once', undefined]);
        assert.ok(a1.confirmation.decided_at);
        refused(await inbox('owner', 'POST', `/${c1.id}/approve`, {}), 409, 'confirmation.not_pending');
        refused(await inbox('owner', 'POST', `/${c1.id}/deny`, {}), 409, 'confirmation.not_pending');
        await rejects(spend(c1, { requestDigest: digest('DELETE /v1/objects/obj_2') }), 409, 'confirmation.mismatch');
        await rejects(spend(c1, { audience: 'openvibe.chat' }), 404, 'confirmation.not_found');
        const used = await spend(c1);
        valid(used.confirmation);
        assert.match(used.used_at, /^\d{4}-/);
        await rejects(spend(c1), 409, 'confirmation.used');
        assert.strictEqual((await row(c1.id)).used_at, used.used_at);

        // ── deny ──
        const c2 = await ask(bot);
        const d2 = ok(await inbox('owner', 'POST', `/${c2.id}/deny`, {}));
        valid(d2.confirmation);
        assert.strictEqual(d2.confirmation.state, 'denied');
        await rejects(spend(c2), 409, 'confirmation.not_pending');
        assert.strictEqual(ok(await inbox('owner', 'GET', '/?state=denied')).confirmations[0].id, c2.id);
        refused(await inbox('owner', 'GET', '/?state=open'), 422, 'confirmation.invalid');

        // ── Creation refusals ──
        await rejects(ask(bot, 'media.object.upload'), 403, 'grant.not_delegated'); // auto: nothing to confirm
        await rejects(ask(bot, 'media.object.delete', { audience: 'openvibe.chat' }), 403, 'confirmation.wrong_audience');
        await rejects(ask(bot, 'media.object.delete', { requestDigest: 'abc' }), 422, 'confirmation.invalid');
        await rejects(ask(bot, 'media.object.delete', { ttlS: 59 }), 422, 'confirmation.invalid');
        await rejects(ask(bot, 'media.object.delete', { ttlS: 86401 }), 422, 'confirmation.invalid');
        await rejects(ask(bot, 'media.object.delete', { summary: '' }), 422, 'confirmation.invalid');
        await rejects(ask(bot, 'media.object.delete', { resources: [{ id: 'x' }] }), 422, 'confirmation.invalid');
        await rejects(ask(`agt_${'9'.repeat(26)}`), 404, 'agent.not_found');

        // ── Expiry: reads report it, a decision records it, consume refuses an approved one past expiry, the sweep records the rest ──
        const c3 = await ask(bot, 'media.object.delete', { ttlS: 60 });
        await db.prepare("UPDATE dev_confirmations SET expires_at = '2001-01-01T00:00:00.000Z' WHERE id = ?").run(c3.id);
        assert.strictEqual(valid(ok(await inbox('owner', 'GET', `/${c3.id}`)).confirmation).state, 'expired');
        assert.ok(!ok(await inbox('owner', 'GET', '/')).confirmations.some((c) => c.id === c3.id));
        assert.ok(ok(await inbox('owner', 'GET', '/?state=expired')).confirmations.some((c) => c.id === c3.id));
        refused(await inbox('owner', 'POST', `/${c3.id}/approve`, {}), 409, 'confirmation.expired');
        assert.strictEqual((await row(c3.id)).state, 'expired', 'the refused decision recorded the expiry');
        const c4 = await approved(bot);
        await db.prepare("UPDATE dev_confirmations SET expires_at = '2001-01-01T00:00:00.000Z' WHERE id = ?").run(c4.id);
        await rejects(spend(c4), 409, 'confirmation.expired');
        const c5 = await ask(bot);
        await db.prepare("UPDATE dev_confirmations SET expires_at = '2001-01-01T00:00:00.000Z' WHERE id = ?").run(c5.id);
        assert.strictEqual(await confirmations.expireDue(db), 1);
        assert.strictEqual(await confirmations.expireDue(db), 0, 'recorded once');
        assert.strictEqual((await row(c5.id)).state, 'expired');
        assert.strictEqual((await row(c4.id)).state, 'approved', 'an approved row is not swept');

        // ── The service cancels a pending one ──
        const c6 = await ask(bot);
        assert.strictEqual(await confirmations.cancelFor(db, { agentId: bot, capability: 'media.object.delete', reason: 'service', actor: 'service:openvibe.media' }), 2, 'c6 and the approved-unused c4');
        assert.strictEqual(valid(ok(await inbox('owner', 'GET', `/${c6.id}`)).confirmation).state, 'cancelled');
        await rejects(spend(c6), 409, 'confirmation.cancelled');
        refused(await inbox('owner', 'POST', `/${c6.id}/approve`, {}), 409, 'confirmation.not_pending');

        // ── Only the owner: another member, an admin and staff get 404, never the row ──
        const c7 = await ask(bot);
        for (const who of ['admin', 'stranger', 'staff']) {
            refused(await inbox(who, 'GET', `/${c7.id}`), 404, 'confirmation.not_found');
            refused(await inbox(who, 'POST', `/${c7.id}/approve`, {}), 404, 'confirmation.not_found');
            refused(await inbox(who, 'POST', `/${c7.id}/deny`, {}), 404, 'confirmation.not_found');
            assert.deepStrictEqual(ok(await inbox(who, 'GET', '/')).confirmations, []);
        }
        refused(await inbox(null, 'GET', '/'), 401, 'auth.required');
        refused(await inbox('owner', 'GET', '/cnf_nope'), 404, 'confirmation.not_found');
        assert.strictEqual((await row(c7.id)).state, 'pending');

        // ── Standing rules ──
        refused(await inbox('owner', 'POST', `/${c7.id}/approve`, { standing_rule: 'session' }), 422, 'confirmation.no_session');
        refused(await inbox('owner', 'POST', `/${c7.id}/approve`, { standing_rule: 'until' }), 422, 'confirmation.invalid');
        refused(await inbox('owner', 'POST', `/${c7.id}/approve`, { standing_rule: 'until', until: new Date(Date.now() + 31 * 86400e3).toISOString() }), 422, 'confirmation.invalid');
        refused(await inbox('owner', 'POST', `/${c7.id}/approve`, { standing_rule: 'forever' }), 422, 'confirmation.invalid');
        assert.strictEqual((await row(c7.id)).state, 'pending', 'a refused approval changes nothing');
        assert.strictEqual((await db.prepare('SELECT count(*) AS n FROM dev_standing_rules').get()).n, 0);
        // session: needs the request's session_id, lasts at most 24 hours, approves the same session only.
        const sess = 'run-2026-10-04:abc';
        const c8 = await ask(bot, 'media.object.delete', { sessionId: sess });
        const a8 = await approve(c8, 'owner', { standing_rule: 'session' });
        assert.deepStrictEqual([a8.confirmation.standing_rule, a8.rule.rule, a8.rule.session_id, a8.rule.source], ['session', 'session', sess, c8.id]);
        assert.ok(Date.parse(a8.rule.until_at) <= Date.now() + 24 * 3600e3);
        const c9 = valid(await ask(bot, 'media.object.delete', { sessionId: sess }));
        assert.deepStrictEqual([c9.state, c9.standing_rule], ['approved', 'session']);
        assert.deepStrictEqual([(await row(c9.id)).decided_by, Number((await row(c9.id)).rule_id)], [`rule:${a8.rule.id}`, a8.rule.id]);
        assert.strictEqual((await spend(c9)).confirmation.state, 'approved');
        assert.strictEqual((await ask(bot, 'media.object.delete', { sessionId: 'another-session' })).state, 'pending');
        assert.strictEqual((await ask(bot)).state, 'pending');
        // until and always
        const c10 = await ask(bot);
        const until = new Date(Date.now() + 7 * 86400e3).toISOString();
        assert.strictEqual((await approve(c10, 'owner', { standing_rule: 'until', until })).rule.until_at, until);
        assert.strictEqual((await ask(bot)).state, 'approved');
        const rules = ok(await api('dev', 'GET', `/${W.P}/agents/${bot}/rules`)).rules;
        assert.deepStrictEqual(rules.map((r) => r.rule), ['session', 'until']);
        // Revoking rules: a developer who is not the owner may not; the owner (or admin, or staff) may.
        refused(await api('dev', 'DELETE', `/${W.P}/agents/${bot}/rules/${rules[0].id}`), 403, 'agent.forbidden');
        refused(await api('owner', 'DELETE', `/${W.P}/agents/${bot}/rules/999999`), 404, 'rule.not_found');
        refused(await api('owner', 'DELETE', `/${W.P}/agents/${bot}/rules/abc`), 404, 'rule.not_found');
        assert.ok(ok(await api('owner', 'DELETE', `/${W.P}/agents/${bot}/rules/${rules[0].id}`)).revoked_at);
        assert.ok(ok(await api('staff', 'DELETE', `/${W.P}/agents/${bot}/rules/${rules[1].id}`)).revoked_at);
        assert.deepStrictEqual(ok(await api('owner', 'GET', `/${W.P}/agents/${bot}/rules`)).rules, []);
        assert.strictEqual((await ask(bot, 'media.object.delete', { sessionId: sess })).state, 'pending', 'a revoked rule approves nothing');
        const c11 = await ask(bot);
        assert.strictEqual((await approve(c11, 'owner', { standing_rule: 'always' })).rule.until_at, null);
        assert.strictEqual((await ask(bot)).state, 'approved');
        const ruleAudit = await db.prepare("SELECT actor, detail FROM dev_audit WHERE action = 'agent.rule_revoked' ORDER BY id").all();
        assert.deepStrictEqual(ruleAudit.map((r) => r.actor), [`user:${S.owner}`, `user:${S.staff}`]);

        // ── 20 pending per agent ──
        const busy = await appAgent(W);
        for (let i = 0; i < 20; i++) await ask(busy);
        await rejects(ask(busy), 429, 'confirmation.too_many_pending');
        assert.strictEqual(ok(await inbox('owner', 'GET', '/?limit=5')).next_before !== null, true);
        const page1 = ok(await inbox('owner', 'GET', '/?limit=5'));
        const page2 = ok(await inbox('owner', 'GET', `/?limit=5&before=${page1.next_before}`));
        assert.ok(page2.confirmations.every((c) => c.id < page1.next_before));

        // ── The owner banned: nothing more is created or spent ──
        await db.prepare("UPDATE dev_standing_rules SET revoked_at = ?, revoked_by = 'test' WHERE revoked_at IS NULL").run(new Date().toISOString());
        const c12 = await approved(bot);
        await db.prepare('UPDATE users SET is_banned = 1 WHERE id = 10').run();
        await rejects(spend(c12), 409, 'confirmation.agent_inactive');
        await rejects(ask(bot), 409, 'confirmation.agent_inactive');
        await db.prepare('UPDATE users SET is_banned = 0 WHERE id = 10').run();
        assert.strictEqual((await row(c12.id)).used_at, null);
        assert.strictEqual((await spend(c12)).confirmation.id, c12.id);

        // ── Two concurrent consumes of one approval: exactly one 200 ──
        const c13 = await approved(bot, 'media.object.delete');
        const both = await Promise.allSettled([spend(c13), spend(c13)]);
        assert.deepStrictEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
        assert.strictEqual(both.find((r) => r.status === 'rejected').reason.code, 'confirmation.used');

        // ── Revoke after approval, one case per cause: cancelled with the cause, consume refused, resume revives nothing ──
        // Pausing the agent
        const paused = await appAgent(W);
        const p1 = await approved(paused);
        const p2 = await ask(paused);
        ok(await api('owner', 'POST', `/${W.P}/agents/${paused}/pause`));
        await cancelledBy(p1, 'agent_paused');
        assert.deepStrictEqual([(await row(p2.id)).state, (await row(p2.id)).cancel_reason], ['cancelled', 'agent_paused'], 'pending ones too');
        await rejects(ask(paused), 409, 'confirmation.agent_inactive');
        ok(await api('owner', 'POST', `/${W.P}/agents/${paused}/resume`));
        await rejects(spend(p1), 409, 'confirmation.cancelled');
        assert.strictEqual((await ask(paused)).state, 'pending', 'its next action asks again');
        // Revoking the agent
        const revoked = await appAgent(W);
        const r1 = await approved(revoked);
        ok(await api('admin', 'DELETE', `/${W.P}/agents/${revoked}`));
        await cancelledBy(r1, 'agent_revoked');
        // Revoking the delegated grant (and only that capability's rows and rules)
        const ungranted = await appAgent(W);
        const g1 = await approved(ungranted);
        await approve(await ask(ungranted), 'owner', { standing_rule: 'always' });
        ok(await api('owner', 'DELETE', `/${W.P}/agents/${ungranted}/grants/media.object.delete`));
        await cancelledBy(g1, 'grant_revoked');
        assert.strictEqual((await db.prepare('SELECT count(*) AS n FROM dev_standing_rules WHERE agent_id = ? AND revoked_at IS NULL').get(ungranted)).n, 0, 'its rules are revoked');
        ok(await api('owner', 'PUT', `/${W.P}/agents/${ungranted}/grants/media.object.delete`, {}));
        assert.strictEqual((await ask(ungranted)).state, 'pending', 'granting again revives no rule');
        // Shrinking the allowance (app host)
        const A = await project();
        const shrunk = await appAgent(A);
        const s1 = await approved(shrunk);
        ok(await api('staff', 'PUT', `/${A.P}/allowance`, { capabilities: ['media.object.upload'] }));
        await cancelledBy(s1, 'beyond_host');
        // Revoking the app's grant (app host)
        const G = await project();
        const appGrantBot = await appAgent(G);
        const ag1 = await approved(appGrantBot);
        ok(await api('owner', 'DELETE', `/${G.P}/apps/${G.PR}/grants/media.object.delete`));
        await cancelledBy(ag1, 'beyond_host');
        // Revoking the host's principal_grants row (service host), and its expiry
        const svc = await svcAgent(W);
        const v1 = await approved(svc, 'chat.message.send');
        await grantsAdmin.revoke(db, { client_id: 'actor', capability: 'chat.message.send', reason: 'test revoke' }, null);
        await cancelledBy(v1, 'beyond_host');
        await grantsAdmin.grant(db, { client_id: 'actor', capability: 'chat.message.send', reason: 'agent host test', expires_at: new Date(Date.now() + 3600e3).toISOString() }, null);
        ok(await api('owner', 'PUT', `/${W.P}/agents/${svc}/grants/chat.message.send`, {}));
        const v2 = await approved(svc, 'chat.message.send');
        await db.prepare("UPDATE principal_grants SET expires_at = '2001-01-01 00:00:00' WHERE client_id = 'actor' AND capability = 'chat.message.send'").run();
        // Lapse without a write: the sweep has not run, consume refuses all the same and spends nothing.
        await rejects(spend(v2), 403, 'grant.not_delegated');
        assert.strictEqual((await row(v2.id)).used_at, null);
        await grantsAdmin.expireDue(db);
        await cancelledBy(v2, 'grant_expired');
        await grantsAdmin.grant(db, { client_id: 'actor', capability: 'chat.message.send', reason: 'agent host test' }, null);
        // A delegated grant's own expires_at passing, without a sweep
        const lapsed = await appAgent(W);
        const l1 = await approved(lapsed);
        await db.prepare("UPDATE dev_agent_grants SET expires_at = '2001-01-01T00:00:00.000Z' WHERE agent_id = ? AND capability = 'media.object.delete'").run(lapsed);
        await rejects(spend(l1), 403, 'grant.not_delegated');
        assert.deepStrictEqual([(await row(l1.id)).state, (await row(l1.id)).used_at], ['approved', null]);
        // The owner removed from the project
        const leaver = await svcAgent(W, 'dev');
        const m1 = await ask(leaver, 'chat.message.send');
        refused(await inbox('owner', 'POST', `/${m1.id}/approve`, {}), 404, 'confirmation.not_found'); // the agent's owner decides, not the project's
        await approve(m1, 'dev');
        ok(await api('owner', 'DELETE', `/${W.P}/members/${S.dev}`), 204);
        await cancelledBy(m1, 'member_removed');
        // Revoking the host app
        const R = await project();
        const appBot = await appAgent(R);
        const ap1 = await approved(appBot);
        ok(await api('owner', 'DELETE', `/${R.P}/apps/${R.PR}`));
        await cancelledBy(ap1, 'app_revoked');
        // Archiving the project
        const X = await project();
        const archBot = await appAgent(X);
        const x1 = await approved(archBot);
        ok(await api('owner', 'POST', `/${X.P}/archive`));
        await cancelledBy(x1, 'project_archived');
        // The owner's account erased
        const E = await project();
        ok(await api('owner', 'POST', `/${E.P}/members`, { username: 'erased', role: 'admin' }), 201);
        const erasedBot = await appAgent(E, 'erased');
        const e1 = await ask(erasedBot); await approve(e1, 'erased');
        const delId = `del_${'1'.repeat(26)}`;
        await db.prepare('INSERT INTO account_deletions (id, user_id, subject, requested_at, delete_after) VALUES (?, 17, ?, ?, ?)').run(delId, S.erased, new Date().toISOString(), new Date().toISOString());
        await accountData.erase(db, await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(delId));
        await cancelledBy(e1, 'account_erased');

        // ── /internal/confirmations: the owning service's routes (slice 7) ──
        const routed = await appAgent(await project());
        const askBody = (extra = {}) => ({ requested_by: { type: 'agent', id: routed }, capability: 'media.object.delete', summary: SUMMARY, details: DETAILS,
            resources: [{ service: 'media', type: 'object', id: 'obj_1' }], request_digest: D, ...extra });
        refused(await internal(null, 'POST', '', askBody()), 401, 'token.missing');
        refused(await internal('live', 'POST', '', askBody()), 403, 'capability.denied');
        refused(await internal('live', 'GET', '/cnf_nope'), 403, 'capability.denied');
        // The owner is the agent's: a body naming another person is ignored.
        const made = await internal('media', 'POST', '', askBody({ owner: { type: 'user', id: S.stranger } }));
        assert.strictEqual(made.status, 201, made.text);
        assert.strictEqual(made.cache, 'no-store');
        const i1 = valid(made.body.confirmation);
        assert.deepStrictEqual([i1.state, i1.owner, i1.requested_by], ['pending', { type: 'user', id: S.owner }, { type: 'agent', id: routed }]);
        assert.ok(!made.text.includes(D) && !made.text.includes('openvibe.media'), 'never the digest or the audience');
        refused(await internal('media', 'POST', '', askBody({ requested_by: routed })), 422, 'confirmation.invalid');
        refused(await internal('media', 'POST', '', askBody({ requested_by: { type: 'agent', id: `agt_${'9'.repeat(26)}` } })), 404, 'agent.not_found');
        refused(await internal('tools', 'POST', '', askBody()), 403, 'confirmation.wrong_audience');
        // Each service sees only its own: Tools cannot read, consume or cancel Media's.
        assert.deepStrictEqual(ok(await internal('media', 'GET', `/${i1.id}`)), { confirmation: i1, used_at: null });
        refused(await internal('tools', 'GET', `/${i1.id}`), 404, 'confirmation.not_found');
        refused(await internal('tools', 'POST', `/${i1.id}/consume`, { request_digest: D }), 404, 'confirmation.not_found');
        refused(await internal('tools', 'POST', `/${i1.id}/cancel`, {}), 404, 'confirmation.not_found');
        refused(await internal('media', 'GET', '/cnf_nope'), 404, 'confirmation.not_found');
        // Consume once, with the action's digest.
        refused(await internal('media', 'POST', `/${i1.id}/consume`, { request_digest: D }), 409, 'confirmation.not_pending');
        await approve(i1);
        refused(await internal('media', 'POST', `/${i1.id}/consume`, { request_digest: digest('DELETE /v1/objects/obj_2') }), 409, 'confirmation.mismatch');
        refused(await internal('media', 'POST', `/${i1.id}/consume`, {}), 409, 'confirmation.mismatch');
        const spent = ok(await internal('media', 'POST', `/${i1.id}/consume`, { request_digest: D }));
        valid(spent.confirmation);
        assert.match(spent.used_at, /^\d{4}-/);
        assert.strictEqual(ok(await internal('media', 'GET', `/${i1.id}`)).used_at, spent.used_at);
        refused(await internal('media', 'POST', `/${i1.id}/consume`, { request_digest: D }), 409, 'confirmation.used');
        refused(await internal('media', 'POST', `/${i1.id}/cancel`, {}), 409, 'confirmation.not_pending');
        // Expired: an approved one past expires_at is refused, and so is cancelling a pending one past it.
        const i2 = ok(await internal('media', 'POST', '', askBody({ ttl_s: 60 })), 201).confirmation;
        await approve(i2);
        await db.prepare("UPDATE dev_confirmations SET expires_at = '2001-01-01T00:00:00.000Z' WHERE id = ?").run(i2.id);
        refused(await internal('media', 'POST', `/${i2.id}/consume`, { request_digest: D }), 409, 'confirmation.expired');
        const i3 = ok(await internal('media', 'POST', '', askBody()), 201).confirmation;
        await db.prepare("UPDATE dev_confirmations SET expires_at = '2001-01-01T00:00:00.000Z' WHERE id = ?").run(i3.id);
        refused(await internal('media', 'POST', `/${i3.id}/cancel`, {}), 409, 'confirmation.not_pending');
        // Cancelled: pending or approved-unused, again is a no-op; the owner can no longer decide, the service no longer spend.
        const i4 = ok(await internal('media', 'POST', '', askBody()), 201).confirmation;
        assert.strictEqual(valid(ok(await internal('media', 'POST', `/${i4.id}/cancel`, {})).confirmation).state, 'cancelled');
        assert.strictEqual(ok(await internal('media', 'POST', `/${i4.id}/cancel`, {})).confirmation.state, 'cancelled');
        assert.strictEqual((await row(i4.id)).cancel_reason, 'service');
        refused(await inbox('owner', 'POST', `/${i4.id}/approve`, {}), 409, 'confirmation.not_pending');
        const i5 = ok(await internal('media', 'POST', '', askBody()), 201).confirmation;
        await approve(i5, 'owner', { standing_rule: 'always' });
        ok(await internal('media', 'POST', `/${i5.id}/cancel`, {}));
        refused(await internal('media', 'POST', `/${i5.id}/consume`, { request_digest: D }), 409, 'confirmation.cancelled');
        // The owner's standing rule outlives the service's cancel: the next request is approved at once (200, not 201).
        const i6 = await internal('media', 'POST', '', askBody());
        assert.deepStrictEqual([i6.status, i6.body.confirmation.state, i6.body.confirmation.standing_rule], [200, 'approved', 'always']);
        ok(await internal('media', 'POST', `/${i6.body.confirmation.id}/consume`, { request_digest: D }));

        // ── Audits: every transition, never the summary or the details ──
        const audits = await db.prepare("SELECT action, actor, detail, event FROM dev_audit WHERE action LIKE 'confirmation.%' ORDER BY id").all();
        assert.deepStrictEqual([...new Set(audits.map((a) => a.action))].sort(),
            ['confirmation.approved', 'confirmation.cancelled', 'confirmation.created', 'confirmation.denied', 'confirmation.expired', 'confirmation.used']);
        for (const a of audits) {
            assert.strictEqual(a.event, null);
            assert.ok(!a.detail.includes('beach-secret') && !a.detail.includes('private-detail-text'), a.detail);
            const d = JSON.parse(a.detail);
            assert.ok(d.agent && d.capability && !('summary' in d) && !('details' in d));
        }
        console.log('confirmations: all tests passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
