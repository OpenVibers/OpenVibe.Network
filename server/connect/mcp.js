'use strict';
/**
 * The MCP server (Compute plan E7): https://connect.openvibe.network/mcp, streamable HTTP.
 *
 * One JSON-RPC call per request, the MCP Streamable HTTP transport, protocol version 2025-06-18:
 *
 *   initialize            what this server is and what it can do
 *   notifications/initialized   (no answer)
 *   ping                  (no answer needed, but answered)
 *   tools/list            the actions of the apps this person connected and this caller was granted
 *   tools/call            one action, through the gateway
 *
 * The caller is the person's own token, a key they made on the Apps page, or a service acting for them.
 * A caller with no grant sees no tools at all: the list is what this caller may do, not what the
 * person owns.
 *
 * The tools are the actions, named as they are (github.issue.create). A tool that fails answers with
 * isError and a short line; nothing secret is ever in the answer.
 */
const { resolveCaller } = require('./auth');

const PROTOCOL_VERSION = '2025-06-18';
// The versions this server speaks. The client's own version is echoed when it is one of these, so a
// newer client is not told it is talking to an older server than it is.
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
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
function createMcpHandler({ db, config, gateway, publicKey = null, issuer = null, requestOptions = {} } = {}) {
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

        try {
            if (method === 'initialize') {
                const asked = String(params.protocolVersion || '');
                return ok(res, id, {
                    protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                    instructions: 'The tools here act in the person\'s own apps, with the person\'s own credentials. A send, a delete or a pay action asks the person first and waits.',
                });
            }
            if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
                return send(res, 202, undefined);
            }
            if (method === 'ping') return ok(res, id, {});
            if (method === 'tools/list') {
                const actions = await gateway.listActions({ subject: who.subject, callerId: who.caller.id });
                return ok(res, id, { tools: toTools(actions) });
            }
            if (method === 'tools/call') {
                const name = String(params.name || '');
                const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
                try {
                    const out = await gateway.call({
                        subject: who.subject, callerId: who.caller.id, callerName: who.caller.name,
                        actionName: name, input: args, requestOptions,
                    });
                    const text = typeof out.data === 'string' ? out.data : JSON.stringify(out.data, null, 2);
                    return ok(res, id, { content: [{ type: 'text', text }], structuredContent: { app: out.app, action: out.action, status: out.status } });
                } catch (e) {
                    const detail = e.detail || e.message || 'the call failed';
                    return ok(res, id, { content: [{ type: 'text', text: String(detail).slice(0, 500) }], isError: true });
                }
            }
            return failRpc(res, id, JSONRPC_ERRORS.method, `unknown method ${method}`);
        } catch (e) {
            return failRpc(res, id, JSONRPC_ERRORS.internal, String(e.message || 'the server failed').slice(0, 300));
        }
    };
}

module.exports = { createMcpHandler, toTools, PROTOCOL_VERSION, SUPPORTED_VERSIONS, SERVER_INFO };
