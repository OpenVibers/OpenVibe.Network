'use strict';
/**
 * The MCP server (Compute plan E7): https://connect.openvibe.network/mcp, streamable HTTP.
 *
 * One JSON-RPC call per request, the MCP Streamable HTTP transport, in both eras of the protocol:
 *
 *   2026-07-28 (stateless; 2026-11-16): every request carries its version in params._meta
 *   ("io.modelcontextprotocol/protocolVersion") and the MCP-Protocol-Version header, and its method in Mcp-Method
 *   (tools/call also its tool in Mcp-Name). A header that disagrees with the body is a 400 HeaderMismatch (-32020);
 *   a version this server does not speak is a 400 UnsupportedProtocolVersion (-32022) naming the ones it does.
 *     server/discover       the versions, the capabilities and who this server is
 *     tools/list            the tools, with how long the list may be kept (ttlMs, cacheScope: private)
 *     tools/call            one action, through the gateway
 *   Every result says resultType "complete"; an unknown method is a 404.
 *
 *   2025-03-26 … 2025-11-25 (the handshake; unchanged):
 *     initialize            what this server is and what it can do
 *     notifications/initialized   (no answer)
 *     ping                  (no answer needed, but answered)
 *     tools/list, tools/call
 *
 * No session is ever minted: the server was already stateless, so one endpoint serves both eras.
 *
 * The caller is the person's own token, a key they made on the Apps page, or a service acting for them.
 * A caller with no grant sees no tools at all: the list is what this caller may do, not what the
 * person owns.
 *
 * The tools are the actions, named as they are (github.issue.create). A tool that fails answers with
 * isError and a short line; nothing secret is ever in the answer.
 */
const mcpKit = require('openvibe-sdk/mcp');
const { resolveCaller } = require('./auth');
const PUBLIC_PERSON_TOOL = {
    name: 'network.person_page.read',
    description: 'Read a person’s public OpenVibe page by handle. Returns only fields and places visible while signed out.',
    inputSchema: { type: 'object', properties: { handle: { type: 'string', minLength: 3, maxLength: 24, pattern: '^[A-Za-z0-9_]+$' } }, required: ['handle'], additionalProperties: false },
    annotations: { title: 'Read a public person page', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const MY_TRUST_TOOL = {
    name: 'network.my_trust.read',
    description: 'Read your own privacy-limited account or guest trust signals. Returns age bands, booleans and aggregate counts only; never an IP, email, last-seen timestamp or linked account identities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Read my trust signals', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const PROTOCOL_VERSION = '2025-06-18';
// The versions this server speaks. The client's own version is echoed when it is one of these, so a
// newer client is not told it is talking to an older server than it is.
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
// The stateless era (2026-07-28): no handshake, the version and the method on every request. Its checks and result
// shapes are openvibe-sdk/mcp's (0.177.0), shared with every OpenVibe MCP server.
const MODERN_VERSIONS = mcpKit.MODERN_VERSIONS;
const INSTRUCTIONS = 'The tools here act in the person\'s own apps, with the person\'s own credentials. A send, a delete or a pay action asks the person first and waits.';
// How long a client may keep the tool list (it is this caller's: private) and the discovery (everyone's: public).
const TOOLS_TTL_MS = 60000;
const DISCOVER_TTL_MS = 3600000;
const SERVER_INFO = { name: 'openvibe-connect', title: 'OpenVibe Connect', version: '1.0' };
const JSONRPC_ERRORS = { parse: -32700, invalid: -32600, method: -32601, params: -32602, internal: -32603 };

const send = (res, status, body, headers = {}) => {
    res.status(status);
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
    res.set('Cache-Control', 'no-store');
    if (body === undefined) return res.end();
    res.json(body);
};

const ok = (res, id, result) => send(res, 200, { jsonrpc: '2.0', id, result });
const failRpc = (res, id, code, message) => send(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
const failHttp = (res, status, id, code, message, data) => send(res, status, { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

/** The tools this caller may use, as MCP tools. */
function toTools(actions) {
    return actions.map((a) => ({
        name: a.name,
        description: a.description || a.name,
        inputSchema: a.inputSchema || { type: 'object', properties: {} },
        annotations: {
            title: a.name,
            readOnlyHint: a.risk === 'read',
            destructiveHint: a.risk === 'delete' || a.risk === 'pay',
            idempotentHint: a.risk === 'read',
            openWorldHint: true,
        },
    }));
}

/**
 * The handler for POST /mcp. → (req, res)
 */
function createMcpHandler({ db, config, gateway, publicKey = null, issuer = null, requestOptions = {}, publicPage = null, myTrust = null } = {}) {
    return async function mcpHandler(req, res) {
        if (req.method !== 'POST') {
            // The transport allows a server to refuse the server-to-client stream.
            res.set('Allow', 'POST');
            return send(res, 405, { error: 'connect.method_not_allowed', detail: 'this MCP server answers POST' });
        }
        const who = await resolveCaller(db, req, { config, publicKey, issuer });
        if (!who.ok) {
            return send(res, who.status || 401, { error: who.code, detail: who.detail });
        }
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return send(res, 400, { error: 'connect.bad_request', detail: 'one JSON-RPC call per request' });
        }
        const id = body.id === undefined ? null : body.id;
        const method = String(body.method || '');
        const params = body.params && typeof body.params === 'object' ? body.params : {};

        // The stateless era: the version, the method and the tool are in the headers too, and must agree with the body.
        if (mcpKit.requestVersion(params)) return serveModern({ req, res, who, id, method, params });

        try {
            if (method === 'initialize') {
                const asked = String(params.protocolVersion || '');
                return ok(res, id, {
                    protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                    instructions: INSTRUCTIONS,
                });
            }
            if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
                return send(res, 202, undefined);
            }
            if (method === 'ping') return ok(res, id, {});
            if (method === 'tools/list') return ok(res, id, { tools: await listTools(who) });
            if (method === 'tools/call') return ok(res, id, await callTool(who, params));
            return failRpc(res, id, JSONRPC_ERRORS.method, `unknown method ${method}`);
        } catch (e) {
            return failRpc(res, id, JSONRPC_ERRORS.internal, String(e.message || 'the server failed').slice(0, 300));
        }
    };

    async function listTools(who) {
        const actions = await gateway.listActions({ subject: who.subject, callerId: who.caller.id });
        // The same order every time (2026-07-28 asks for a deterministic one): the gateway's actions, then the two reads.
        return [...toTools(actions), ...(publicPage ? [PUBLIC_PERSON_TOOL] : []), ...(myTrust ? [MY_TRUST_TOOL] : [])];
    }

    /** One tool call → its MCP result (a failure is a result with isError, never a protocol error). */
    async function callTool(who, params) {
                const name = String(params.name || '');
                const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
                try {
                    if (name === PUBLIC_PERSON_TOOL.name && publicPage) {
                        const handle = String(args.handle || '');
                        if (!/^[A-Za-z0-9_]{3,24}$/.test(handle)) throw Object.assign(new Error('Use a valid OpenVibe handle.'), { status: 400 });
                        const out = await publicPage(handle);
                        if (!out) throw Object.assign(new Error('No public page found for that handle.'), { status: 404 });
                        const text = JSON.stringify(out, null, 2);
                        return { content: [{ type: 'text', text }], structuredContent: out };
                    }
                    if (name === MY_TRUST_TOOL.name && myTrust) {
                        const out = await myTrust(who.subject);
                        const text = JSON.stringify(out, null, 2);
                        return { content: [{ type: 'text', text }], structuredContent: out };
                    }
                    const out = await gateway.call({
                        subject: who.subject, callerId: who.caller.id, callerName: who.caller.name,
                        actionName: name, input: args, requestOptions,
                    });
                    const text = typeof out.data === 'string' ? out.data : JSON.stringify(out.data, null, 2);
                    return { content: [{ type: 'text', text }], structuredContent: { app: out.app, action: out.action, status: out.status } };
                } catch (e) {
                    const detail = e.detail || e.message || 'the call failed';
                    return { content: [{ type: 'text', text: String(detail).slice(0, 500) }], isError: true };
                }
    }

    /** A 2026-07-28 request: headers checked against the body (openvibe-sdk/mcp), then served with resultType on every result. */
    async function serveModern({ req, res, who, id, method, params }) {
        const versions = [...MODERN_VERSIONS, ...SUPPORTED_VERSIONS];
        const refused = mcpKit.checkRequest({ header: (name) => req.get(name), method, params, versions: MODERN_VERSIONS, supported: versions });
        if (refused) return failHttp(res, refused.status, id, refused.error.code, refused.error.message, refused.error.data);
        try {
            if (method === 'server/discover') {
                return ok(res, id, mcpKit.discoverResult({ serverInfo: SERVER_INFO, capabilities: { tools: {} }, instructions: INSTRUCTIONS, versions, ttlMs: DISCOVER_TTL_MS }));
            }
            if (method === 'tools/list') return ok(res, id, mcpKit.listResult('tools', await listTools(who), { ttlMs: TOOLS_TTL_MS, cacheScope: 'private' }));
            if (method === 'tools/call') return ok(res, id, mcpKit.complete(await callTool(who, params)));
            if (method.startsWith('notifications/')) return send(res, 202, undefined);
            const unknown = mcpKit.methodNotFound(method);
            return failHttp(res, unknown.status, id, unknown.error.code, unknown.error.message);
        } catch (e) {
            return failRpc(res, id, JSONRPC_ERRORS.internal, String(e.message || 'the server failed').slice(0, 300));
        }
    }
}

module.exports = { createMcpHandler, toTools, PROTOCOL_VERSION, SUPPORTED_VERSIONS, MODERN_VERSIONS, SERVER_INFO, PUBLIC_PERSON_TOOL, MY_TRUST_TOOL };
