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
 * so a script reaches only their public tools.
 *
 * OpenVibe's own apps (2026-11-18, ./first-party.js): when this caller holds a grant in OpenVibe Design or Vision, their
 * tools run as the person, with a delegated person token minted for that one call and service (SDK 0.187). A read grant
 * reaches only the tools marked read-only; a destructive one asks the person first; each call is in the Connect log.
 * The token goes to that service's /mcp only and never to the script.
 *
 *   createCodeMode({ servers, fetchImpl, now, log }) → { tools(), call(who, params, own) }
 *     servers: [{ prefix, url }]   each one's tools are named `<prefix>.<name>`; the list is kept 10 minutes
 *     own: { list() → [tool], call({ name, arguments }) → MCP result }   Connect's own tools for this caller
 */
const cm = require('openvibe-sdk/code-mode');

const SEARCH = {
    name: 'search',
    description: 'Find OpenVibe tools by words: your own connected apps (send, read, create …), OpenVibe.Tools\' catalogue (convert, '
        + 'measure, generate, look up), Design\'s rules and page audits, Vision\'s image tools, Finance\'s read-only money tools (accounts, months, bills, '
        + 'goals, what if). Answers each tool\'s typed signature, to call from execute.',
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

function createCodeMode({ servers = [], fetchImpl = globalThis.fetch, now = Date.now, log = console, firstParty = null } = {}) {
    const { FIRST_PARTY, isFirstParty } = require('./first-party');
    const remote = servers.filter((x) => x && NAME.test(String(x.prefix || '')) && /^https?:\/\//.test(String(x.url || '')));
    const kept = new Map();   // prefix → { at, tools }

    async function rpc(server, method, params, token = null) {
        const res = await fetchImpl(server.url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(token ? 120000 : 20000),
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
                .slice(0, 400).map((t) => ({ name: `${server.prefix}.${t.name}`, description: String(t.description || '').slice(0, 600), inputSchema: t.inputSchema || { type: 'object' }, annotations: t.annotations && typeof t.annotations === 'object' ? t.annotations : {} }));
            kept.set(server.prefix, { at: now(), tools });
            return tools;
        } catch (err) {
            if (log && log.warn) log.warn(`[mcp/all] ${server.prefix} did not list its tools: ${String(err && err.message).slice(0, 160)}`);
            return k ? k.tools : [];
        }
    }
    /** This caller's grant in each first-party app it may use, for one request. */
    async function grantsFor(who) {
        const out = {};
        if (!firstParty || !who) return out;
        for (const s of remote) if (isFirstParty(s.prefix)) out[s.prefix] = await firstParty.grantOf(who, s.prefix).catch(() => null);
        return out;
    }
    async function catalog(own, who = null) {
        const mine = await own.list().catch(() => []);
        const theirs = await Promise.all(remote.map(remoteTools));
        const grants = await grantsFor(who);
        const said = (t, prefix) => {
            const level = grants[prefix];
            if (!level) return t.description;
            const read = t.annotations && t.annotations.readOnlyHint;
            return `${t.description} [Runs as you in ${FIRST_PARTY[prefix].name}${!read && level !== 'write' ? '; this key may only read there, so it refuses' : t.annotations && t.annotations.destructiveHint ? '; asks the person first' : ''}.]`;
        };
        return [...mine.map((t) => ({ name: t.name, description: t.description || t.title || '', inputSchema: t.inputSchema || { type: 'object' } })),
            ...theirs.flatMap((list, i) => list.map((t) => ({ name: t.name, description: said(t, remote[i].prefix), inputSchema: t.inputSchema })))];
    }
    /** A first-party tool as the person: the grant, read-only tools for a read grant, ask first, one token per call. */
    async function asPerson(server, name, input, who, level) {
        const prefix = server.prefix;
        const short = name.slice(prefix.length + 1);
        const def = (await remoteTools(server)).find((t) => t.name === name);
        const ann = (def && def.annotations) || {};
        const risk = ann.readOnlyHint ? 'read' : ann.destructiveHint ? 'delete' : 'write';
        if (risk !== 'read' && level !== 'write') {
            return { ok: false, error: `this key may only read in ${FIRST_PARTY[prefix].name}, and ${short} changes things: the person can give it read and write on the Apps page` };
        }
        if (ann.destructiveHint) {
            const asked = await firstParty.ask(who, prefix, short, input);
            if (!asked.ok) { await firstParty.log(who, prefix, short, risk, false, 403); return { ok: false, error: asked.error }; }
        }
        const token = await firstParty.token(who, prefix, level);
        if (!token) return { ok: false, error: `${FIRST_PARTY[prefix].name} could not be used as the person just now` };
        let result;
        try { result = await rpc(server, 'tools/call', { name: short, arguments: input || {} }, token); } catch (err) {
            await firstParty.log(who, prefix, short, risk, false, 502);
            throw err;
        }
        await firstParty.log(who, prefix, short, risk, !(result && result.isError), result && result.isError ? 422 : 200);
        return result;
    }
    async function callOne(name, input, own, who = null) {
        const server = remote.find((x) => name.startsWith(`${x.prefix}.`));
        let result;
        if (server && firstParty && who && isFirstParty(server.prefix)) {
            const level = await firstParty.grantOf(who, server.prefix);
            result = level ? await asPerson(server, name, input, who, level) : await rpc(server, 'tools/call', { name: name.slice(server.prefix.length + 1), arguments: input || {} });
            if (result && result.ok === false) return result;
        } else {
            result = server
                ? await rpc(server, 'tools/call', { name: name.slice(server.prefix.length + 1), arguments: input || {} })
                : await own.call({ name, arguments: input || {} });
        }
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
                const found = cm.searchTools(await catalog(own, who), query, Number(args.limit) || 12);
                if (!found.length) return answer(`Nothing matches "${query}". Try other words, or fewer.`);
                return answer(found.map((f) => `${f.signature}\n  ${f.description}`).join('\n\n'));
            }
            if (name === 'execute') {
                const code = String(args.code || '');
                if (!code.trim()) return answer('Send the script ({ code }).', true);
                const defs = await catalog(own, who);
                const out = await cm.runCode(code, { tools: defs.map((d) => d.name), call: async (kind, toolName, payload) => (kind === 'tool' ? callOne(toolName, payload, own, who) : { ok: false, error: 'no functions here' }) });
                return answer({ ok: out.ok, ...(out.ok ? { value: out.value } : { error: out.error }), logs: (out.logs || []).slice(0, 40), calls: out.calls, ms: out.ms }, !out.ok);
            }
            return answer(`There is no tool ${name} here: use search, then execute.`, true);
        },
    };
}

module.exports = { createCodeMode, SEARCH, EXECUTE };
