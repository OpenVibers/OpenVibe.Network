'use strict';
/**
 * The crawler behind the security suites (roadmap WS-R task 5): lists every route of the booted
 * Network (walking Express's router stack inside the server process, so a route added later is
 * crawled without anyone listing it), fills route parameters with seeded values, and requests each
 * path as several callers, reporting any response whose body or headers carry a value that caller
 * must never see. Not a test itself (no .test.js); used with test/helpers/boot-server.js.
 *
 * The server runs in a child process, so the route list comes from a preload (routeDumpPreload())
 * that wraps express's app.listen and writes the router stack to a file once the server listens; the
 * preload also refuses every TCP connection off loopback.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Transient connection errors worth one more try on an idempotent request (a pooled socket the server closed). */
const NET_RETRY = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT']);

/** The path an Express 4 layer is mounted at ('' for app-level middleware), or null when it is a pattern. */
function mountPath(layer) {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    let src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\/\?\(\?=\/\|\$\)$/i, '');
    let i = 0;
    src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${(layer.keys[i++] || {}).name || 'param'}`);
    src = src.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
    return /[\\^$()|[\]*+?]/.test(src) ? null : src;
}

/** Every route of an Express app: [{ path, methods }] ('_all' for mounted middleware with a path). */
function listAppRoutes(app) {
    const out = [];
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
                for (const p of [].concat(layer.route.path)) if (typeof p === 'string') out.push({ path: prefix + p, methods });
            } else if (layer.handle && Array.isArray(layer.handle.stack)) {
                const mp = mountPath(layer);
                if (mp !== null) walk(layer.handle.stack, prefix + mp);
            } else {
                const mp = mountPath(layer);
                if (mp) out.push({ path: prefix + mp, methods: ['_all'] });
            }
        }
    };
    walk(app._router.stack, '');
    const seen = new Set();
    return out.filter((r) => { const k = `${r.methods.join(',')} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Source of a preload for the child server: once app.listen() is listening, writes the route list
 * (listAppRoutes) as JSON to process.env.OV_ROUTE_DUMP. Also keeps the process from reaching anything
 * but loopback (as boot-server's own guard does), whatever client library connects.
 */
function routeDumpPreload() {
    return `'use strict';
const path = require('path');
const express = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'express'))});
const { listAppRoutes } = require(${JSON.stringify(__filename)});
const listen = express.application.listen;
express.application.listen = function (...args) {
    const app = this;
    const server = listen.apply(app, args);
    server.once('listening', () => {
        try { require('fs').writeFileSync(process.env.OV_ROUTE_DUMP, JSON.stringify(listAppRoutes(app))); } catch (e) { console.error('route dump failed', e.message); }
    });
    return server;
};
// No traffic off the machine by any client (fetch, http(s), undici, discord.js, ws): every TCP
// connect to something other than loopback fails the way an unreachable host does.
const net = require('net');
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    let o = args[0];
    if (Array.isArray(o)) o = o[0];
    if (o && typeof o === 'object' && o.path) return realConnect.apply(this, args);
    const host = String((o && typeof o === 'object') ? (o.host || o.hostname || 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost')).replace(/^\\[|\\]$/g, '');
    const port = (o && typeof o === 'object') ? o.port : args[0];
    if (process.env.OV_CONNECT_LOG) { try { require('fs').appendFileSync(process.env.OV_CONNECT_LOG, host + ' ' + port + '\\n'); } catch { /* */ } }
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return realConnect.apply(this, args);
    process.nextTick(() => this.destroy(Object.assign(new Error('test: no egress to ' + host), { code: 'ECONNREFUSED' })));
    return this;
};
`;
}

/** Writes the preload into `dir` and returns the env that loads it: { NODE_OPTIONS, OV_ROUTE_DUMP, OV_CONNECT_LOG } (every TCP connect is logged as 'host port'). */
function routeDumpEnv(dir) {
    const file = path.join(dir, 'route-dump-preload.js');
    fs.writeFileSync(file, routeDumpPreload());
    return { NODE_OPTIONS: `--require ${file}`, OV_ROUTE_DUMP: path.join(dir, 'routes.json'), OV_CONNECT_LOG: path.join(dir, 'connects.log') };
}

/** The route list the child wrote (waits briefly for it). */
async function readRoutes(dumpFile) {
    for (let i = 0; i < 50; i++) {
        try { return JSON.parse(fs.readFileSync(dumpFile, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('the server never wrote its route list');
}

/** Concrete paths for a template: candidate i of every parameter, for each i (no cross product). */
function expand(template, values) {
    const names = [];
    const t = `/${template.replace(/^\/+/, '')}`.replace(/\*/g, 'x').replace(/:([A-Za-z0-9_]+)\??(\([^)]*\))?/g, (m, n) => { names.push(n); return `:${n}`; });
    if (!names.length) return [t];
    const lists = names.map((n) => values(n));
    const width = Math.max(...lists.map((l) => l.length));
    const paths = new Set();
    for (let i = 0; i < width; i++) {
        let j = 0;
        paths.add(t.replace(/:([A-Za-z0-9_]+)/g, () => { const l = lists[j++]; return encodeURIComponent(String(l[Math.min(i, l.length - 1)])); }));
    }
    return [...paths];
}

/** Every path for `method` ('get', or a write method): each route expanded, also with `query` appended, plus `extra`. */
function pathsFor(routes, values, { method = 'get', query = '', extra = [] } = {}) {
    const paths = new Set();
    for (const r of routes) {
        if (!r.methods.includes(method) && !r.methods.includes('_all')) continue;
        for (const p of expand(r.path, values)) {
            paths.add(p);
            if (query && !p.includes('?')) paths.add(`${p}?${query}`);
        }
    }
    for (const p of extra) paths.add(p);
    return [...paths];
}

/** The forms of a secret worth looking for: as is, URL-encoded, base64 and base64url. */
function forms(value) {
    const v = String(value);
    const out = new Set([v, encodeURIComponent(v)]);
    if (v.length >= 12) {
        out.add(Buffer.from(v).toString('base64').replace(/=+$/, ''));
        out.add(Buffer.from(v).toString('base64url'));
    }
    return [...out];
}

/** Which of `needles` ({ label: value }) `text` + `headers` carry: [{ label, where }]. */
function leaks(res, needles) {
    const found = [];
    const h = res.headers;
    const headerText = [...(h && typeof h.entries === 'function' ? h.entries() : Object.entries(h || {}))].map(([k, v]) => `${k}: ${v}`).join('\n');
    for (const [label, value] of Object.entries(needles)) {
        if (!value) continue;
        for (const f of forms(value)) {
            if (res.text && res.text.includes(f)) { found.push({ label, where: 'body' }); break; }
            if (headerText.includes(f)) { found.push({ label, where: 'headers' }); break; }
        }
    }
    return found;
}

/**
 * Requests every path as every caller ({ who: headers }) with `method` (and `body` for writes).
 * `needlesFor(who)` names what that caller must never see. Resolves { found, answered, statuses, byPath }.
 */
async function crawl(base, paths, people, needlesFor, { method = 'GET', body, concurrency = 8 } = {}) {
    const found = [];
    const statuses = {};
    const byPath = {};
    let answered = 0;
    let n = 0;
    const nextIp = () => { n++; return `198.19.${(n >> 8) & 255}.${n & 255}`; };   // the API limiter counts per address
    for (const [who, headers] of Object.entries(people)) {
        const needles = needlesFor(who);
        const queue = [...paths];
        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (queue.length) {
                const p = queue.shift();
                const h = { 'x-forwarded-for': nextIp(), ...headers };
                let b;
                if (body !== undefined) { if (typeof body === 'string') b = body; else { b = JSON.stringify(body); h['content-type'] = 'application/json'; } }
                // The server closes a pooled connection after its 5 s keep-alive. With test files in parallel a crawl can
                // outrun that between requests, and undici then hands back a socket the server just closed ("fetch failed",
                // status 0), which used to fail `answered` spuriously. Retry that race on a GET (no side effects); a write
                // stays single-shot so a retry can never duplicate it.
                const retriable = method === 'GET';
                let r;
                for (let attempt = 0; ; attempt++) {
                    try {
                        const res = await fetch(base + p, { method, headers: h, body: b, redirect: 'manual' });
                        r = { status: res.status, headers: res.headers, text: await res.text() };
                        break;
                    } catch (e) {
                        if (!retriable || attempt >= 2 || !NET_RETRY.has(e?.cause?.code)) { r = { status: 0, text: '', headers: {} }; break; }
                        await new Promise((res) => setTimeout(res, 250));
                    }
                }
                if (r.status) answered++;
                const cls = r.status ? `${String(r.status)[0]}xx` : 'none';
                statuses[cls] = (statuses[cls] || 0) + 1;
                (byPath[`${who} ${method} ${p}`] = r.status);
                for (const l of leaks(r, needles)) found.push(`${who}: ${method} ${p} → ${r.status} carries ${l.label} in its ${l.where}`);
            }
        }));
    }
    return { found, answered, statuses, byPath };
}

module.exports = { mountPath, listAppRoutes, routeDumpPreload, routeDumpEnv, readRoutes, expand, pathsFor, forms, leaks, crawl };
