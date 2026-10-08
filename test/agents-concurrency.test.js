'use strict';
// Agents under concurrent writers (plan T2 WS-Z2 slice 2, server/developer/agents.js): one transaction is held open
// at a chosen point while a competing request runs against it, then let go. On PostgreSQL (npm run test:pg) the
// competing request really runs and must wait on a lock; on PGlite, one connection, it waits its turn, so the same
// assertions hold there too. Covers creation against an app revocation, a member's removal and a project archive
// (each order), and resume against a revoke (a person's, and an app revocation's cascade).
//   node test/agents-concurrency.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const agents = require('../server/developer/agents');
const store = require('../server/developer/store');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
const PG = process.env.NETWORK_TEST_STORE === 'pg';
const USERS = [[10, 'owner'], [11, 'dev'], [12, 'leaver'], [13, 'stayer']];
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ${USERS.map(([id, n]) => `(${id}, '${n}', 'x', 'user')`).join(', ')}`).run();
// The seed creates Actor's client (server/db/database.js); this file sets the fields it relies on.
await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris) VALUES ('actor', 'x', 'OpenVibe.Actor', '[]') ON CONFLICT (client_id) DO UPDATE SET client_secret = EXCLUDED.client_secret, name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris, is_first_party = 0").run();
const S = {};
for (const [id, name] of USERS) S[name] = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.locals.db = db;
app.locals.config = { baseUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { sandboxAllowance: '', agentHostServices: 'actor' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);
const T = {};
for (const [id, name] of USERS) T[name] = jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });

// Hold the first transaction that reaches `point` (agents.revokeWhere or store.audit, matched by `when`) until the
// competing request is waiting on it: on PostgreSQL, until another session is seen waiting on a lock, which must
// happen within 10 s and before the competing request finishes (else the interleaving was not tested and this
// fails); on PGlite, briefly. The hold is always let go, so a failure never hangs the test.
const realRevokeWhere = agents.revokeWhere;
const realAudit = store.audit;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function interleave({ point, when, first, second }) {
    let entered, release;
    const reached = new Promise((r) => { entered = r; });
    const gate = new Promise((r) => { release = r; });
    let armed = true;
    const hold = async (args) => { if (armed && when(...args)) { armed = false; entered(); await gate; } };
    if (point === 'revokeWhere') agents.revokeWhere = async (...a) => { const n = await realRevokeWhere(...a); await hold([a[3]]); return n; };
    else store.audit = async (...a) => { await realAudit(...a); await hold([a[1]]); };
    let one, two;
    try {
        one = first();
        await Promise.race([reached, one.then(() => { throw new Error('the first request finished without reaching the hold point'); })]);
        let settled = false;
        two = second();
        two.then(() => { settled = true; }, () => { settled = true; });
        if (PG) {
            const until = Date.now() + 10000;
            for (;;) {
                const waiting = (await db.prepare("SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'").get()).n;
                if (Number(waiting) > 0) break;
                assert.ok(!settled, 'the competing request finished without waiting on the held transaction');
                assert.ok(Date.now() < until, 'the competing request never waited on a lock held by the first transaction');
                await sleep(20);
            }
        } else await sleep(100);
        release();
        return await Promise.all([one, two]);
    } catch (err) {
        release();
        await Promise.allSettled([one, two].filter(Boolean));
        throw err;
    } finally {
        agents.revokeWhere = realRevokeWhere;
        store.audit = realAudit;
    }
}

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: { authorization: `Bearer ${T[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    const ok = (r, status = 200) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); return r.body; };
    const refused = (r, status, code) => { assert.strictEqual(r.status, status, JSON.stringify(r.body)); assert.strictEqual(r.body.code, code); };
    const row = async (id) => await db.prepare('SELECT * FROM dev_agents WHERE id = ?').get(id);
    const live = async (where, ...params) => (await db.prepare(`SELECT COUNT(*) AS n FROM dev_agents WHERE status <> 'revoked' AND ${where}`).get(...params)).n;
    const project = async (name) => {
        const id = ok(await api('owner', 'POST', '', { name }), 201).id;
        for (const u of ['dev', 'leaver', 'stayer']) ok(await api('owner', 'POST', `/${id}/members`, { username: u, role: 'developer' }), 201);
        return id;
    };
    const sandboxApp = async (p, name) => ok(await api('dev', 'POST', `/${p}/apps`, { name, environment: 'sandbox' }), 201).id;
    const actorHost = { type: 'service', id: 'actor' };
    try {
        const P = await project('Concurrent');

        // ── Creation against an app's revocation ──
        // The revocation first: the creation that read the app as live re-checks it and finds it revoked.
        const A1 = await sandboxApp(P, 'A1');
        let [rev, made] = await interleave({ point: 'revokeWhere', when: (o) => o.reason === 'app_revoked',
            first: () => api('dev', 'DELETE', `/${P}/apps/${A1}`), second: () => api('dev', 'POST', `/${P}/agents`, { name: 'Late', host: { type: 'app', id: A1 } }) });
        ok(rev);
        refused(made, 404, 'app.not_found');
        assert.strictEqual(await live('host_app_id = ?', A1), 0, 'no live agent on a revoked app');
        // The creation first: the revocation waits for it and takes the new agent with the app.
        const A2 = await sandboxApp(P, 'A2');
        [made, rev] = await interleave({ point: 'audit', when: (e) => e.action === 'agent.created',
            first: () => api('dev', 'POST', `/${P}/agents`, { name: 'Early', host: { type: 'app', id: A2 } }), second: () => api('dev', 'DELETE', `/${P}/apps/${A2}`) });
        ok(rev);
        assert.deepStrictEqual([(await row(ok(made, 201).id)).status, (await row(made.body.id)).revoked_by], ['revoked', 'app_revoked']);

        // ── Creation against a member's removal ──
        let removed;
        [removed, made] = await interleave({ point: 'revokeWhere', when: (o) => o.reason === 'member_removed',
            first: () => api('owner', 'DELETE', `/${P}/members/${S.leaver}`), second: () => api('leaver', 'POST', `/${P}/agents`, { name: 'Late', host: actorHost }) });
        ok(removed, 204);
        refused(made, 404, 'project.not_found');
        assert.strictEqual(await live('project_id = ? AND owner_subject = ?', P, S.leaver), 0, 'no live agent of a removed member');
        [made, removed] = await interleave({ point: 'audit', when: (e) => e.action === 'agent.created',
            first: () => api('stayer', 'POST', `/${P}/agents`, { name: 'Early', host: actorHost }), second: () => api('owner', 'DELETE', `/${P}/members/${S.stayer}`) });
        ok(removed, 204);
        assert.deepStrictEqual([(await row(ok(made, 201).id)).status, (await row(made.body.id)).revoked_by], ['revoked', 'member_removed']);

        // ── Creation against the project's archive ──
        const P2 = await project('Archived first');
        let archived;
        [archived, made] = await interleave({ point: 'revokeWhere', when: (o) => o.reason === 'project_archived',
            first: () => api('owner', 'POST', `/${P2}/archive`), second: () => api('dev', 'POST', `/${P2}/agents`, { name: 'Late', host: actorHost }) });
        ok(archived);
        refused(made, 409, 'project.archived');
        assert.strictEqual(await live('project_id = ?', P2), 0, 'no live agent in an archived project');
        const P3 = await project('Created first');
        [made, archived] = await interleave({ point: 'audit', when: (e) => e.action === 'agent.created',
            first: () => api('dev', 'POST', `/${P3}/agents`, { name: 'Early', host: actorHost }), second: () => api('owner', 'POST', `/${P3}/archive`) });
        ok(archived);
        assert.deepStrictEqual([(await row(ok(made, 201).id)).status, (await row(made.body.id)).revoked_by], ['revoked', 'project_archived']);

        // ── Resume against revoke ──
        // A revoke in flight is never undone by a resume that read the agent as paused.
        const paused = async (host) => {
            const a = ok(await api('dev', 'POST', `/${P}/agents`, { name: 'Paused', host }), 201);
            ok(await api('dev', 'POST', `/${P}/agents/${a.id}/pause`));
            return a.id;
        };
        let g = await paused(actorHost), resumed;
        [rev, resumed] = await interleave({ point: 'audit', when: (e) => e.action === 'agent.revoked',
            first: () => api('owner', 'DELETE', `/${P}/agents/${g}`), second: () => api('dev', 'POST', `/${P}/agents/${g}/resume`) });
        ok(rev);
        refused(resumed, 409, 'agent.revoked');
        assert.deepStrictEqual([(await row(g)).status, !!(await row(g)).revoked_at], ['revoked', true]);
        // The same against an app revocation's cascade.
        const A3 = await sandboxApp(P, 'A3');
        g = await paused({ type: 'app', id: A3 });
        [rev, resumed] = await interleave({ point: 'revokeWhere', when: (o) => o.reason === 'app_revoked',
            first: () => api('dev', 'DELETE', `/${P}/apps/${A3}`), second: () => api('dev', 'POST', `/${P}/agents/${g}/resume`) });
        ok(rev);
        refused(resumed, 409, 'agent.revoked');
        assert.deepStrictEqual([(await row(g)).status, (await row(g)).revoked_by], ['revoked', 'app_revoked']);
        // The resume first: the revoke waits for it and still wins.
        g = await paused(actorHost);
        [resumed, rev] = await interleave({ point: 'audit', when: (e) => e.action === 'agent.resumed',
            first: () => api('dev', 'POST', `/${P}/agents/${g}/resume`), second: () => api('owner', 'DELETE', `/${P}/agents/${g}`) });
        assert.strictEqual(ok(resumed).status, 'active');
        assert.strictEqual(ok(rev).status, 'revoked');
        assert.strictEqual((await row(g)).status, 'revoked');
        const trail = (await db.prepare('SELECT action FROM dev_audit WHERE target = ? ORDER BY id').all(`agent:${g}`)).map((a) => a.action);
        assert.deepStrictEqual(trail, ['agent.created', 'agent.paused', 'agent.resumed', 'agent.revoked']);

        console.log(`agents-concurrency (${PG ? 'PostgreSQL' : 'PGlite'}): all tests passed`);
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
