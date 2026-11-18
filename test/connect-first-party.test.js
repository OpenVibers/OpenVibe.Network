'use strict';
// OpenVibe's own apps in Connect (2026-11-18, server/connect/first-party.js; plan §AD.28 item 2). An Apps-page key with a
// grant in OpenVibe Design or Vision uses the person's own tools there through /mcp/all, as the person, without ever
// holding their account:
// - no grant: the public tools, anonymously, as before;
// - a grant needs no connected credential (they are the person's own account), and is read or write like any app;
// - each call carries a delegated person token (SDK 0.187) minted for that call: the person, role user, this one
//   service, the key as the actor, the grant as the scope, ten minutes; the service verifies it with the SDK;
// - read reaches only read-only tools; a destructive tool asks the person first, unless a standing rule says not to;
// - search says which tools run as the person; each call is in the Connect log; a banned person's key gets nothing.
//   node test/connect-first-party.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const callers = require('../server/connect/callers');
const approvals = require('../server/connect/approvals');
const { createGateway } = require('../server/connect/gateway');
const { createCodeMode } = require('../server/connect/mcp-all');
const { createFirstParty, FIRST_PARTY } = require('../server/connect/first-party');
const { verifyUserToken } = require('openvibe-sdk/auth');

(async () => {
    const quiet = console.log;
    console.log = () => {};
    const db = getDb();
    await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role) VALUES (21, 'fpowner', 'FP Owner', 'x', 'admin')`).run();
    const owner = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 21').get());
    const ISS = 'https://openvibe.network';
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const jwks = { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'k1' }] };
    const config = { secrets: { key: crypto.randomBytes(32).toString('base64') }, jwt: { issuer: ISS } };
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); } };

    // OpenVibe Design's /mcp, standing in: it verifies a Bearer token as Design does (SDK, delegated for 'design').
    const seen = [];
    const design = http.createServer((req, res) => {
        let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
            const j = JSON.parse(b || '{}');
            const auth = req.headers.authorization || null;
            let claims = null;
            if (auth) { try { claims = await verifyUserToken(auth.slice(7), { jwks, issuer: ISS, audience: ['openvibe.network'], delegated: { service: 'design' } }); } catch (e) { claims = { error: e.code }; } }
            seen.push({ method: j.method, name: j.params && j.params.name, claims, auth: !!auth });
            const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result })); };
            if (j.method === 'tools/list') return reply({ tools: [
                { name: 'list_themes', description: 'The public themes', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
                { name: 'make_vector', description: 'Draw an SVG from a prompt, charged to the person', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } }, annotations: { readOnlyHint: false } },
                { name: 'delete_vector', description: 'Delete one of the person\'s vectors', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
            ] });
            const who = claims && !claims.error ? claims.subject_id : null;
            return reply({ content: [{ type: 'text', text: JSON.stringify({ tool: j.params.name, as: who }) }] });
        });
    });
    await new Promise((r) => design.listen(0, '127.0.0.1', r));
    const gateway = createGateway({ db, config, defs: [] });
    const firstParty = createFirstParty({ db, privateKey: privatePem, issuer: ISS, approvals, writeLog: gateway.writeLog, approvalWaitMs: 300, log: { warn() {} } });
    const codeMode = createCodeMode({ servers: [{ prefix: 'design', url: `http://127.0.0.1:${design.address().port}/mcp` }], firstParty, log: { warn() {} } });
    const own = { list: async () => [], call: async () => ({ content: [{ type: 'text', text: '{}' }] }) };
    const made = await callers.createKeyCaller(db, owner, 'Claude Desktop');
    const who = { subject: owner, caller: made.caller, kind: 'key' };
    const run = async (code) => JSON.parse((await codeMode.call(who, { name: 'execute', arguments: { code } }, own)).content[0].text);

    try {
        await check('no grant: the public tools, anonymously, as before', async () => {
            seen.length = 0;
            const out = await run("return await tools.design_list_themes({})");
            assert.deepStrictEqual(out.value, { tool: 'list_themes', as: null });
            assert.strictEqual(seen.find((s) => s.method === 'tools/call').auth, false);
        });

        await check('a grant in an OpenVibe app needs no connected credential; another app still does', async () => {
            await callers.setGrant(db, made.caller.id, 'design', 'read', owner);
            assert.strictEqual(await callers.grantOf(db, made.caller.id, 'design'), 'read');
            await assert.rejects(callers.setGrant(db, made.caller.id, 'github', 'read', owner), (e) => e.code === 'connect.not_connected');
            assert.deepStrictEqual(Object.keys(FIRST_PARTY).sort(), ['design', 'vision']);
        });

        await check('read: the person, by a delegated token for Design alone, the key as the actor; a change is refused', async () => {
            seen.length = 0;
            const out = await run("return await tools.design_list_themes({})");
            assert.deepStrictEqual(out.value, { tool: 'list_themes', as: owner }, JSON.stringify(seen));
            const c = seen.find((s) => s.method === 'tools/call').claims;
            assert.deepStrictEqual([c.typ, c.role, c.svc, c.act, c.scope, c.delegated.by], ['delegated', 'user', ['design'], { sub: made.caller.id }, 'read', made.caller.id]);
            assert.ok(c.exp - c.iat <= 600 && !c.staff_caps && !c.is_owner, 'ten minutes, never staff (the owner is an admin)');
            const refused = await run("return await tools.design_make_vector({ prompt: 'a bird' })");
            assert.strictEqual(refused.ok, false);
            assert.match(refused.error, /may only read in OpenVibe Design/);
            assert.ok(!seen.some((s) => s.name === 'make_vector'), 'never sent');
        });

        await check('write: a change runs as the person; a destructive one asks first, and a standing rule lets it through', async () => {
            await callers.setGrant(db, made.caller.id, 'design', 'write', owner);
            seen.length = 0;
            const madeV = await run("return await tools.design_make_vector({ prompt: 'a bird' })");
            assert.deepStrictEqual(madeV.value, { tool: 'make_vector', as: owner });
            assert.strictEqual(seen.find((s) => s.name === 'make_vector').claims.scope, 'write');
            const waited = await run("return await tools.design_delete_vector({ id: 'vec_1' })");
            assert.strictEqual(waited.ok, false);
            assert.match(waited.error, /has not approved this yet/);
            assert.ok(!seen.some((s) => s.name === 'delete_vector'), 'not sent before a yes');
            const pending = await approvals.list(db, owner, { state: 'pending' });
            assert.ok(pending.some((a) => a.app === 'design' && a.action === 'design.delete_vector'), JSON.stringify(pending).slice(0, 300));
            await approvals.setRule(db, owner, 'design', 'design.delete_vector', true);
            const ruled = await run("return await tools.design_delete_vector({ id: 'vec_1' })");
            assert.deepStrictEqual(ruled.value, { tool: 'delete_vector', as: owner });
        });

        await check('search says which tools run as the person; each call is in the Connect log', async () => {
            const found = (await codeMode.call(who, { name: 'search', arguments: { query: 'draw an svg vector' } }, own)).content[0].text;
            assert.match(found, /Runs as you in OpenVibe Design/);
            const rows = await db.prepare("SELECT action, ok FROM connect_log WHERE subject = ? AND app = 'design' ORDER BY created_at").all(owner);
            assert.ok(rows.some((r) => r.action === 'design.make_vector' && Number(r.ok) === 1), JSON.stringify(rows));
            assert.ok(rows.some((r) => r.action === 'design.delete_vector' && Number(r.ok) === 0), 'the refused one too');
        });

        await check('a banned person\'s key gets nothing as them', async () => {
            await db.prepare('UPDATE users SET is_banned = 1 WHERE id = 21').run();
            const out = await run("return await tools.design_list_themes({})");
            assert.strictEqual(out.ok, false);
            assert.match(out.error, /could not be used as the person/);
            await db.prepare('UPDATE users SET is_banned = 0 WHERE id = 21').run();
        });
    } finally {
        design.close();
        console.log = quiet;
    }
    if (failures) { quiet(`connect-first-party: ${failures} failed`); process.exit(1); }
    quiet('connect-first-party: OpenVibe Design and Vision as the person, by grant, by delegated token, asked first when it matters');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
