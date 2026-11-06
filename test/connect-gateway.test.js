'use strict';
// The gateway (Compute plan E7, server/connect/gateway.js): a caller with no grant sees no action; an
// input that fails its schema is refused before anything is sent; a send action waits for the person;
// the egress guard refuses a redirect off the app's own host; a secret in an answer is redacted; the
// limits are 120 calls a minute for one person in one app, and a daily cap on top; the log keeps who,
// which action and whether it worked, and never the input of a write action.
//   node test/connect-gateway.test.js
const assert = require('assert');
const crypto = require('crypto');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const vault = require('../server/connect/vault');
const callers = require('../server/connect/callers');
const approvals = require('../server/connect/approvals');
const { createGateway } = require('../server/connect/gateway');
const { createLimiter } = require('../server/connect/limits');
const { startApp } = require('./helpers/connect-app');

(async () => {
    const quiet = console.log;
    console.log = () => {};
    const db = getDb();
    await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (10, 'owner', 'x', 'user'), (11, 'other', 'x', 'user'), (12, 'third', 'x', 'user')`).run();
    const owner = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 10').get());
    const other = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 11').get());
    const third = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 12').get());
    const config = { secrets: { key: crypto.randomBytes(32).toString('base64') } };
    const SECRET = 'ghp_' + crypto.randomBytes(18).toString('hex');

    let failures = 0;
    const check = async (name, fn) => { try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); } };

    // The app under test: its own host, its own actions, its own answers.
    const seen = [];
    const app = await startApp((req, res) => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
        const answer = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url.startsWith('/redirect')) {
            res.writeHead(302, { location: 'https://evil.example.com/steal' });
            return res.end();
        }
        if (req.url.startsWith('/read')) return answer(200, { login: 'octocat', access_token: SECRET, note: 'the token is ' + SECRET });
        if (req.url.startsWith('/write')) return answer(200, { ok: true, wrote: true });
        if (req.url.startsWith('/send')) return answer(200, { ok: true, sent: true });
        if (req.url.startsWith('/other')) return answer(200, { ok: true });
        return answer(404, { message: 'Not Found' });
    });

    const def = {
        key: 'testapp', name: 'Test App', apiHost: app.host,
        auth: { kind: 'token', fields: [{ name: 'default', label: 'Token', where: 'header', header: 'Authorization', scheme: 'Bearer' }] },
        test: { method: 'GET', path: '/read' },
        actions: [
            { name: 'testapp.read', title: 'Read', risk: 'read', description: 'read', input: { type: 'object', properties: { q: { type: 'string' } }, required: [], additionalProperties: false }, request: { method: 'GET', path: '/read' } },
            { name: 'testapp.write', title: 'Write', risk: 'write', description: 'write', input: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'], additionalProperties: false }, request: { method: 'POST', path: '/write', body: { title: '{title}' } } },
            { name: 'testapp.send', title: 'Send', risk: 'send', description: 'send', input: { type: 'object', properties: { to: { type: 'string', minLength: 1 } }, required: ['to'], additionalProperties: false }, request: { method: 'POST', path: '/send', body: { to: '{to}' } } },
            { name: 'testapp.remove', title: 'Delete', risk: 'delete', description: 'delete', input: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false }, request: { method: 'DELETE', path: '/other' } },
            { name: 'testapp.redirect', title: 'Redirect', risk: 'read', description: 'redirect', input: { type: 'object', properties: {}, additionalProperties: false }, request: { method: 'GET', path: '/redirect' } },
        ],
    };

    const limiter = createLimiter({ perMinute: 120, dailyCap: 2000 });
    const gateway = createGateway({ db, config, defs: [def], limiter, approvalWaitMs: 8000, defaultRequestOptions: app.options });

    try {
        const caller = await callers.ensurePersonCaller(db, owner, 'The owner');
        await vault.store(db, owner, 'testapp', 'default', 'the-token', { config });
        await vault.store(db, other, 'testapp', 'default', 'the-token', { config });
        await vault.store(db, third, 'testapp', 'default', 'the-token', { config });

        await check('an ungranted caller sees no actions, and a read grant shows only the read ones', async () => {
            assert.deepStrictEqual(await gateway.listActions({ subject: owner, callerId: caller.id }), [], 'no grant, no tools');
            await callers.setGrant(db, caller.id, 'testapp', 'read', owner);
            const tools = await gateway.listActions({ subject: owner, callerId: caller.id });
            assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['testapp.read', 'testapp.redirect'], 'only the read actions');
            await callers.setGrant(db, caller.id, 'testapp', 'write', owner);
            const more = await gateway.listActions({ subject: owner, callerId: caller.id });
            assert.deepStrictEqual(more.map((t) => t.name).sort(), ['testapp.read', 'testapp.redirect', 'testapp.remove', 'testapp.send', 'testapp.write']);
        });

        await check('an input that fails its schema is refused, and nothing is sent', async () => {
            const before = seen.length;
            let err = null;
            try { await gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.write', input: { title: '' } }); } catch (e) { err = e; }
            assert.ok(err, 'the call is refused');
            assert.strictEqual(err.status, 422);
            assert.strictEqual(err.code, 'connect.invalid_input');
            assert.strictEqual(seen.length, before, 'the app was never called');
            let missing = null;
            try { await gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.write', input: {} }); } catch (e) { missing = e; }
            assert.strictEqual(missing.status, 422, 'a missing required field is refused');
            let extra = null;
            try { await gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.write', input: { title: 'x', nope: 1 } }); } catch (e) { extra = e; }
            assert.strictEqual(extra.status, 422, 'an unknown field is refused');
        });

        await check('a send action waits for the person, and only then happens', async () => {
            const pending = gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.send', input: { to: 'someone' } });
            pending.catch(() => {});   // the wait is decided below; a refusal must not crash the file
            // The request is written down and the app is not called yet.
            let rows = await approvals.list(db, owner, { state: 'pending' });
            for (let i = 0; i < 40 && !rows.length; i++) { await new Promise((r) => setTimeout(r, 50)); rows = await approvals.list(db, owner, { state: 'pending' }); }
            assert.strictEqual(rows.length, 1, 'the request waits for the person');
            assert.ok(!seen.some((s) => s.url.startsWith('/send')), 'the app was not called yet');
            await approvals.decide(db, owner, rows[0].id, 'approve');
            const out = await pending;
            assert.strictEqual(out.status, 200);
            assert.ok(seen.some((s) => s.url.startsWith('/send')), 'the app was called after the approval');
        });

        await check('a denied send action never happens', async () => {
            const pending = gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.send', input: { to: 'someone else' } });
            pending.catch(() => {});
            let rows = await approvals.list(db, owner, { state: 'pending' });
            for (let i = 0; i < 40 && !rows.length; i++) { await new Promise((r) => setTimeout(r, 50)); rows = await approvals.list(db, owner, { state: 'pending' }); }
            await approvals.decide(db, owner, rows[0].id, 'deny');
            let err = null;
            try { await pending; } catch (e) { err = e; }
            assert.ok(err, 'the call fails');
            assert.strictEqual(err.code, 'connect.approval_denied');
            assert.ok(!seen.some((s) => s.url === '/send' && s.body === 'someone else'), 'the app was not called');
        });

        await check('a delete action asks as well', async () => {
            const pending = gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.remove', input: { id: 'x' } });
            pending.catch(() => {});
            let rows = await approvals.list(db, owner, { state: 'pending' });
            for (let i = 0; i < 40 && !rows.length; i++) { await new Promise((r) => setTimeout(r, 50)); rows = await approvals.list(db, owner, { state: 'pending' }); }
            assert.strictEqual(rows.length, 1, 'the delete waits');
            await approvals.decide(db, owner, rows[0].id, 'deny');
            await pending.catch(() => {});
        });

        await check('the egress guard refuses a redirect off the app\'s own host', async () => {
            let err = null;
            try { await gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.redirect', input: {} }); } catch (e) { err = e; }
            assert.ok(err, 'the redirect is refused');
            assert.strictEqual(err.code, 'connect.egress_denied');
            assert.ok(/not its own host/.test(err.detail), err.detail);
        });

        await check('a secret in an answer is redacted', async () => {
            const out = await gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.read', input: { q: 'x' } });
            const text = JSON.stringify(out.data);
            assert.ok(!text.includes(SECRET), 'the secret is not in the answer');
            assert.ok(text.includes('[redacted]'), 'the secret is redacted');
            assert.ok(out.data.login === 'octocat', 'the rest of the answer stands');
        });

        await check('the log says who, which action and whether it worked, and keeps no write input', async () => {
            await gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.write', input: { title: 'a private title' } });
            const rows = await db.prepare('SELECT * FROM connect_log WHERE subject = ? ORDER BY created_at DESC').all(owner);
            assert.ok(rows.length, 'the log has rows');
            const write = rows.find((r) => r.action === 'testapp.write');
            assert.ok(write, 'the write is logged');
            assert.strictEqual(Number(write.ok), 1);
            assert.strictEqual(write.caller_name, 'The owner');
            assert.strictEqual(write.input, null, 'the input of a write action is never written');
            const read = rows.find((r) => r.action === 'testapp.read');
            assert.ok(read && read.input, 'a read keeps its input');
            assert.ok(!JSON.stringify(rows).includes(SECRET), 'no secret in the log');
        });

        await check('the limit is 120 calls a minute for one person in one app', async () => {
            const small = createLimiter({ perMinute: 120, dailyCap: 100000 });
            const g = createGateway({ db, config, defs: [def], limiter: small, defaultRequestOptions: app.options });
            for (let i = 0; i < 120; i++) {
                await g.call({ subject: other, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.read', input: {} });
            }
            let err = null;
            try { await g.call({ subject: other, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.read', input: {} }); } catch (e) { err = e; }
            assert.ok(err, 'the 121st call is refused');
            assert.strictEqual(err.status, 429);
            assert.strictEqual(err.code, 'connect.rate_limited');
        });

        await check('the daily cap is on top of the minute window', async () => {
            const daily = createLimiter({ perMinute: 1000, dailyCap: 2 });
            const g = createGateway({ db, config, defs: [def], limiter: daily, defaultRequestOptions: app.options });
            await g.call({ subject: third, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.read', input: {} });
            await g.call({ subject: third, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.read', input: {} });
            let err = null;
            try { await g.call({ subject: third, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.read', input: {} }); } catch (e) { err = e; }
            assert.ok(err, 'the third call is refused');
            assert.strictEqual(err.code, 'connect.daily_cap');
        });

        await check('a standing rule lets one recipe stop asking', async () => {
            await approvals.setRule(db, owner, 'testapp', 'testapp.send', true);
            const out = await gateway.call({ subject: owner, callerId: caller.id, callerName: 'The owner', actionName: 'testapp.send', input: { to: 'with a rule' } });
            assert.strictEqual(out.status, 200, 'the rule let it through');
            const rows = await approvals.list(db, owner, { state: 'pending' });
            assert.strictEqual(rows.length, 0, 'nothing waits');
        });
    } finally {
        await app.stop();
        console.log = quiet;
    }
    console.log(failures ? `\n${failures} failed` : '\nconnect gateway: all checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
