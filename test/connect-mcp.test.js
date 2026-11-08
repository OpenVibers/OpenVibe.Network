'use strict';
// The MCP server (Compute plan E7, server/connect/mcp.js): a real MCP client lists the tools of the apps
// the person connected and the caller was granted, and calls one. The client's own token is the key
// the person made on the Apps page. A caller with no grant sees no tools; an unknown token is
// refused; a call that fails answers with isError, not with a crash.
//   node test/connect-mcp.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const vault = require('../server/connect/vault');
const callers = require('../server/connect/callers');
const { createGateway } = require('../server/connect/gateway');
const { createMcpHandler } = require('../server/connect/mcp');
const { startApp } = require('./helpers/connect-app');

(async () => {
    const quiet = console.log;
    console.log = () => {};
    const db = getDb();
    await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (10, 'owner', 'x', 'user')`).run();
    const owner = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 10').get());
    const config = { secrets: { key: crypto.randomBytes(32).toString('base64') }, jwt: { issuer: 'https://openvibe.network' } };

    let failures = 0;
    const check = async (name, fn) => { try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); } };

    const seen = [];
    const app = await startApp((req, res) => {
        seen.push(req.url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ login: 'octocat', id: 7 }));
    });
    const def = {
        key: 'testapp', name: 'Test App', apiHost: app.host,
        auth: { kind: 'token', fields: [{ name: 'default', label: 'Token', where: 'header', header: 'Authorization', scheme: 'Bearer' }] },
        test: { method: 'GET', path: '/read' },
        actions: [
            { name: 'testapp.read', title: 'Read', risk: 'read', description: 'read a thing', input: { type: 'object', properties: { q: { type: 'string' } }, required: [], additionalProperties: false }, request: { method: 'GET', path: '/read' } },
        ],
    };

    const gateway = createGateway({ db, config, defs: [def], defaultRequestOptions: app.options });
    const expressApp = express();
    expressApp.use(express.json({ limit: '256kb' }));
    expressApp.post('/mcp', createMcpHandler({ db, config, gateway, publicPage: async (handle) => ({ username: handle, profile_url: `https://openvibe.my/@${handle}` }), myTrust: async () => ({ kind: 'guest', age_band: 'under_1d', age_hours: 2, age_days: 0, networks_seen: 1, guests_from_same_networks_24h: 2, converted: false }) }));
    const server = http.createServer(expressApp);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;

    const connect = async (token) => {
        const client = new Client({ name: 'connect-test', version: '1.0' }, { capabilities: {} });
        const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + token } } });
        await client.connect(transport);
        return client;
    };

    try {
        await vault.store(db, owner, 'testapp', 'default', 'the-token', { config });
        const made = await callers.createKeyCaller(db, owner, 'Claude Code');
        const key = made.key;

        await check('a real MCP client lists the tools of the connected apps', async () => {
            const client = await connect(key);
            try {
                const listed = await client.listTools();
                const tools = listed.tools || listed || [];
                assert.deepStrictEqual(tools.map((tool) => tool.name), ['network.person_page.read', 'network.my_trust.read'], 'the two privacy-limited reads are available without an app grant');
                await callers.setGrant(db, made.caller.id, 'testapp', 'read', owner);
                const after = await client.listTools();
                const afterTools = after.tools || after || [];
                assert.strictEqual(afterTools.length, 3);
                const appTool = afterTools.find((tool) => tool.name === 'testapp.read');
                assert.ok(appTool.inputSchema, 'the tool carries its schema');
                assert.strictEqual(appTool.annotations.readOnlyHint, true);
            } finally { await client.close(); }
        });

        await check('the MCP public person-page tool returns only its public read', async () => {
            const client = await connect(key);
            try {
                const out = await client.callTool({ name: 'network.person_page.read', arguments: { handle: 'ana' } });
                assert.ok(!out.isError);
                assert.match(out.content[0].text, /openvibe\.my\/@ana/);
            } finally { await client.close(); }
        });

        await check('the MCP trust tool returns only coarse signals and counts', async () => {
            const client = await connect(key);
            try {
                const out = await client.callTool({ name: 'network.my_trust.read', arguments: {} });
                assert.ok(!out.isError);
                assert.match(out.content[0].text, /"kind": "guest"/);
                assert.doesNotMatch(out.content[0].text, /192\.0\.2\.|email|last_seen/);
            } finally { await client.close(); }
        });

        await check('a real MCP client calls a tool and gets the answer', async () => {
            const client = await connect(key);
            try {
                const out = await client.callTool({ name: 'testapp.read', arguments: { q: 'hello' } });
                assert.ok(!out.isError, 'the call worked');
                const text = out.content.map((c) => c.text || '').join('\n');
                assert.ok(text.includes('octocat'), text);
                assert.ok(seen.some((u) => u.startsWith('/read')), 'the app was called');
            } finally { await client.close(); }
        });

        await check('a call with a bad input is refused, and the answer says so', async () => {
            const client = await connect(key);
            try {
                const out = await client.callTool({ name: 'testapp.read', arguments: { q: 42 } });
                assert.strictEqual(out.isError, true, 'the bad input is refused');
            } finally { await client.close(); }
        });

        await check('an unknown token is refused', async () => {
            let refused = false;
            try { await connect('ovc_cal_00000000000000000000000000_nope'); } catch (e) { refused = true; }
            assert.ok(refused, 'the client cannot connect');
            const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
            assert.strictEqual(r.status, 401);
        });

        await check('the server speaks the MCP initialize handshake', async () => {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + key },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
            });
            assert.strictEqual(r.status, 200);
            const body = await r.json();
            assert.strictEqual(body.jsonrpc, '2.0');
            assert.strictEqual(body.result.protocolVersion, '2025-06-18');
            assert.ok(body.result.capabilities.tools, 'the server offers tools');
            assert.ok(body.result.serverInfo.name, 'the server says its name');
        });
    } finally {
        await app.stop();
        server.close();
        console.log = quiet;
    }
    console.log(failures ? `\n${failures} failed` : '\nconnect mcp: all checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
