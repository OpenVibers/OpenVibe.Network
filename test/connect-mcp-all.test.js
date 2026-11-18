'use strict';
// All of OpenVibe in two tools (plan §AD.26 item 2; server/connect/mcp-all.js): a real MCP client on /mcp/all sees only
// search and execute; search finds the person's own app actions (with this caller's grants) and a public server's tools,
// as typed signatures; execute runs a script that calls both and returns only its value; a script error, an unknown
// tool and a tool that fails come back as words. The public server is called without the caller's key.
//   node test/connect-mcp-all.test.js
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
const { createCodeMode } = require('../server/connect/mcp-all');
const { startApp } = require('./helpers/connect-app');

(async () => {
    const quiet = console.log;
    console.log = () => {};
    const db = getDb();
    await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (11, 'allowner', 'x', 'user')`).run();
    const owner = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 11').get());
    const config = { secrets: { key: crypto.randomBytes(32).toString('base64') }, jwt: { issuer: 'https://openvibe.network' } };
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); } };

    // The person's connected app (Connect's gateway).
    const app = await startApp((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ login: 'octocat', followers: 12 })); });
    const def = {
        key: 'testapp', name: 'Test App', apiHost: app.host,
        auth: { kind: 'token', fields: [{ name: 'default', label: 'Token', where: 'header', header: 'Authorization', scheme: 'Bearer' }] },
        test: { method: 'GET', path: '/read' },
        actions: [{ name: 'testapp.read', title: 'Read', risk: 'read', description: 'read the person\'s profile on Test App', input: { type: 'object', properties: { q: { type: 'string' } }, required: [], additionalProperties: false }, request: { method: 'GET', path: '/read' } }],
    };
    const gateway = createGateway({ db, config, defs: [def], defaultRequestOptions: app.options });

    // A public OpenVibe MCP server (Tools' catalogue stands in).
    const remoteSeen = [];
    const remote = http.createServer((req, res) => {
        let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
            const j = JSON.parse(b || '{}');
            remoteSeen.push({ method: j.method, auth: req.headers.authorization || null, name: j.params && j.params.name });
            const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result })); };
            if (j.method === 'tools/list') return reply({ tools: [
                { name: 'convert_units', description: 'Convert a value between units of length, weight and temperature', inputSchema: { type: 'object', properties: { value: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['value', 'from', 'to'] } },
                { name: 'always_fails', description: 'A tool that fails', inputSchema: { type: 'object' } },
            ] });
            if (j.method === 'tools/call' && j.params.name === 'convert_units') return reply({ content: [{ type: 'text', text: JSON.stringify({ value: j.params.arguments.value * 1.609, unit: 'km' }) }] });
            if (j.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'the tool broke' }], isError: true });
            return reply({});
        });
    });
    await new Promise((r) => remote.listen(0, '127.0.0.1', r));
    const codeMode = createCodeMode({ servers: [{ prefix: 'tools', url: `http://127.0.0.1:${remote.address().port}/mcp` }], log: { warn() {} } });

    const expressApp = express();
    expressApp.use(express.json({ limit: '256kb' }));
    expressApp.post('/mcp/all', createMcpHandler({ db, config, gateway, codeMode }));
    const server = http.createServer(expressApp);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/mcp/all`;
    const connect = async (token) => {
        const client = new Client({ name: 'all-test', version: '1.0' }, { capabilities: {} });
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
        return client;
    };

    try {
        await vault.store(db, owner, 'testapp', 'default', 'the-token', { config });
        const made = await callers.createKeyCaller(db, owner, 'Claude Code');
        await callers.setGrant(db, made.caller.id, 'testapp', 'read', owner);

        await check('the client sees two tools, and who this server is', async () => {
            const client = await connect(made.key);
            try {
                const tools = (await client.listTools()).tools;
                assert.deepStrictEqual(tools.map((t) => t.name), ['search', 'execute']);
                assert.strictEqual(client.getServerVersion().name, 'openvibe');
            } finally { await client.close(); }
        });

        await check('search finds the person\'s own action and a public server\'s tool, as typed signatures', async () => {
            const client = await connect(made.key);
            try {
                const units = (await client.callTool({ name: 'search', arguments: { query: 'convert units temperature' } })).content[0].text;
                assert.match(units, /tools_convert_units\(input: \{ value: number; from: string; to: string \}\): Promise<any>/);
                const mine = (await client.callTool({ name: 'search', arguments: { query: 'profile test app' } })).content[0].text;
                assert.match(mine, /testapp_read\(input:/);
                const none = (await client.callTool({ name: 'search', arguments: { query: 'zzqqxx' } })).content[0].text;
                assert.match(none, /Nothing matches/);
            } finally { await client.close(); }
        });

        await check('execute runs a script over both and returns only its value', async () => {
            const client = await connect(made.key);
            try {
                const code = `const km = await tools.tools_convert_units({ value: 10, from: 'mi', to: 'km' });
const me = await tools.testapp_read({});
console.log('looked up', me.status);
return { km: km.value, app: me.app, status: me.status };`;
                const out = await client.callTool({ name: 'execute', arguments: { code } });
                assert.ok(!out.isError, out.content[0].text);
                const r = JSON.parse(out.content[0].text);
                assert.strictEqual(r.ok, true);
                assert.strictEqual(Math.round(r.value.km * 100) / 100, 16.09);
                assert.strictEqual(r.calls, 2);
                assert.deepStrictEqual([r.value.app, r.value.status], ['testapp', 200], 'the person\'s own app, through the gateway');
                assert.ok(r.logs.some((l) => /looked up/.test(JSON.stringify(l))), JSON.stringify(r.logs));
            } finally { await client.close(); }
        });

        await check('a failing tool, an unknown tool and a script error come back as words', async () => {
            const client = await connect(made.key);
            try {
                const failing = JSON.parse((await client.callTool({ name: 'execute', arguments: { code: 'try { await tools.tools_always_fails({}); } catch (e) { return String(e.message || e); } return "no";' } })).content[0].text);
                assert.match(String(failing.value), /the tool broke/);
                const unknown = await client.callTool({ name: 'execute', arguments: { code: 'return await tools.nope_nothing({});' } });
                assert.ok(unknown.isError && /nope_nothing|no tool/i.test(unknown.content[0].text), unknown.content[0].text);
                const broken = await client.callTool({ name: 'execute', arguments: { code: 'throw new Error("my script failed")' } });
                assert.ok(broken.isError && /my script failed/.test(broken.content[0].text));
                const other = await client.callTool({ name: 'testapp.read', arguments: {} });
                assert.ok(other.isError && /use search, then execute/.test(other.content[0].text));
            } finally { await client.close(); }
        });

        await check('the public server is never sent the caller\'s key', async () => {
            assert.ok(remoteSeen.length >= 2);
            assert.ok(remoteSeen.every((x) => x.auth === null), JSON.stringify(remoteSeen));
        });
    } finally {
        server.close(); remote.close();
        await app.stop().catch(() => {});
    }
    if (failures) { quiet(`${failures} failed`); process.exit(1); }
    quiet('connect-mcp-all: two tools, search over own and public tools, execute over both, errors in words, no key forwarded');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
