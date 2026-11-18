'use strict';
/**
 * All of OpenVibe in two tools (plan §AD.26 item 2; the owner, 11-17, sending Cloudflare's Code Mode MCP, "2,600 tools in
 * 2": "Analyze and use to improve openvibe"): https://connect.openvibe.network/mcp/all.
 *
 *   search  { query, limit? }  the tools that match, from the person's own apps (Connect's actions, with this caller's
 *                              grants) and from OpenVibe's public MCP servers (Tools' catalogue, Design, Vision), each as a
 *                              typed signature to call from a script
 *   execute { code }           a JavaScript script, run in openvibe-sdk/code-mode's sandbox (no files, network or
 *                              processes; 30 s, 30 calls, 64 MB), whose only way out is `await tools.<name>(input)` for
 *                              the names search answered; only what it returns (8 KB) and its console lines come back
 *
 * A call from a script is the same call as one made directly: Connect's actions go through the gateway with this caller's
 * grants, so a send, a delete or a pay action still asks the person first. The public servers are called anonymously,
 * so a script reaches only their public tools and no token ever leaves Network for them.
 *
 *   createCodeMode({ servers, fetchImpl, now, log }) → { tools(), call(who, params, own) }
 *     servers: [{ prefix, url }]   each one's tools are named `<prefix>.<name>`; the list is kept 10 minutes
 *     own: { list() → [tool], call({ name, arguments }) → MCP result }   Connect's own tools for this caller
 */
const cm = require('openvibe-sdk/code-mode');

const SEARCH = {
    name: 'search',
    description: 'Find OpenVibe tools by words: your own connected apps (send, read, create …), OpenVibe.Tools\' catalogue (convert, '
        + 'measure, generate, look up), Design\'s rules and page audits, Vision\'s image tools. Answers each tool\'s typed signature, to call from execute.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 300 }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['query'], additionalProperties: false },
    annotations: { title: 'Find OpenVibe tools', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const EXECUTE = {
    name: 'execute',
    description: 'Run JavaScript that calls OpenVibe tools: `const r = await tools.<name>(input)` for any name search found (several in one '
        + 'script, in a loop or in parallel). It runs in a sandbox: no files, network or processes, 30 s and 30 calls. Return only what you need '
        + '(8 KB at most); console.log lines come back too. A send, a delete or a pay action asks the person first, as when called directly.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', maxLength: 20000 } }, required: ['code'], additionalProperties: false },
    annotations: { title: 'Run a script over OpenVibe tools', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
const TTL_MS = 10 * 60 * 1000;
const NAME = /^[a-z][a-z0-9_]{0,20}$/;

function textOf(result) {
    if (!result || typeof result !== 'object') return String(result == null ? '' : result);
    return (Array.isArray(result.content) ? result.content : []).filter((c) => c && c.type === 'text').map((c) => String(c.text || '')).join('\n');
}
/** An MCP result as a script's value: its structured part, else its text read as JSON, else the text. */
function valueOf(result) {
    if (result && result.structuredContent != null) return result.structuredContent;
    const text = textOf(result);
    try { return JSON.parse(text); } catch { return text; }
}

function createCodeMode({ servers = [], fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
    const remote = servers.filter((x) => x && NAME.test(String(x.prefix || '')) && /^https?:\/\//.test(String(x.url || '')));
    const kept = new Map();   // prefix → { at, tools }

    async function rpc(server, method, params) {
        const res = await fetchImpl(server.url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const raw = await res.text();
        // A server may answer as an event stream: its data line is the reply.
        const json = /^\s*\{/.test(raw) ? raw : ((/^data: ?(\{.*\})$/m.exec(raw) || [])[1] || '');
        let j = null; try { j = JSON.parse(json); } catch { j = null; }
        if (!res.ok || !j) throw new Error(`${server.prefix} answered ${res.status}`);
        if (j.error) throw new Error(`${server.prefix}: ${String(j.error.message || 'an error').slice(0, 200)}`);
        return j.result;
    }
    async function remoteTools(server) {
        const k = kept.get(server.prefix);
        if (k && now() - k.at < TTL_MS) return k.tools;
        try {
            const r = await rpc(server, 'tools/list', {});
            const tools = (Array.isArray(r && r.tools) ? r.tools : []).filter((t) => t && typeof t.name === 'string' && t.name)
                .slice(0, 400).map((t) => ({ name: `${server.prefix}.${t.name}`, description: String(t.description || '').slice(0, 600), inputSchema: t.inputSchema || { type: 'object' } }));
            kept.set(server.prefix, { at: now(), tools });
            return tools;
        } catch (err) {
            if (log && log.warn) log.warn(`[mcp/all] ${server.prefix} did not list its tools: ${String(err && err.message).slice(0, 160)}`);
            return k ? k.tools : [];
        }
    }
    async function catalog(own) {
        const mine = await own.list().catch(() => []);
        const theirs = await Promise.all(remote.map(remoteTools));
        return [...mine.map((t) => ({ name: t.name, description: t.description || t.title || '', inputSchema: t.inputSchema || { type: 'object' } })), ...theirs.flat()];
    }
    async function callOne(name, input, own) {
        const server = remote.find((x) => name.startsWith(`${x.prefix}.`));
        const result = server
            ? await rpc(server, 'tools/call', { name: name.slice(server.prefix.length + 1), arguments: input || {} })
            : await own.call({ name, arguments: input || {} });
        if (result && result.isError) return { ok: false, error: textOf(result).slice(0, 500) || 'the tool failed' };
        return { ok: true, value: valueOf(result) };
    }
    const answer = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

    return {
        tools: () => [SEARCH, EXECUTE],
        async call(who, params, own) {
            const name = String((params && params.name) || '');
            const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
            if (name === 'search') {
                const query = String(args.query || '').slice(0, 300);
                const found = cm.searchTools(await catalog(own), query, Number(args.limit) || 12);
                if (!found.length) return answer(`Nothing matches "${query}". Try other words, or fewer.`);
                return answer(found.map((f) => `${f.signature}\n  ${f.description}`).join('\n\n'));
            }
            if (name === 'execute') {
                const code = String(args.code || '');
                if (!code.trim()) return answer('Send the script ({ code }).', true);
                const defs = await catalog(own);
                const out = await cm.runCode(code, { tools: defs.map((d) => d.name), call: async (kind, toolName, payload) => (kind === 'tool' ? callOne(toolName, payload, own) : { ok: false, error: 'no functions here' }) });
                return answer({ ok: out.ok, ...(out.ok ? { value: out.value } : { error: out.error }), logs: (out.logs || []).slice(0, 40), calls: out.calls, ms: out.ms }, !out.ok);
            }
            return answer(`There is no tool ${name} here: use search, then execute.`, true);
        },
    };
}

module.exports = { createCodeMode, SEARCH, EXECUTE };
