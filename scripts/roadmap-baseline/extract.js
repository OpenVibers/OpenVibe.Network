'use strict';
/**
 * Static extractors for the Wave 0 baseline (docs/roadmap-baseline/).
 *
 * Every function here reads source text only — nothing is executed, required or connected to.
 * The results are line-level pattern matches, so they are an inventory to review, not proof of
 * behaviour: a route string inside a comment still counts, and a route built at runtime does not.
 */
const fs = require('fs');
const path = require('path');

const SOURCE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.sql']);
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'public', 'dist', 'data', 'scratch', '.git', 'coverage', 'browser-extension', 'hardware']);

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(full, out);
        } else if (SOURCE_EXT.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

const isTestFile = (rel) => /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]s$/.test(rel);

// ── Tables ────────────────────────────────────────────────────────────────
const TABLE_RE = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?\s*(?:\(|USING\b)/gi;

function extractTables(text) {
    const out = [];
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        TABLE_RE.lastIndex = 0;
        let m;
        while ((m = TABLE_RE.exec(line))) out.push({ table: m[1], line: i + 1 });
    });
    return out;
}

// ── Express-style routes and mounts ───────────────────────────────────────
const ROUTE_RE = /\b(\w+)\.(get|post|put|patch|delete|all)\(\s*(['"`])(\/[^'"`]*)\3/g;
const MOUNT_RE = /\b(\w+)\.use\(\s*(['"`])(\/[^'"`]*)\2\s*,\s*([^\n]*)/g;
// `const x = require('./x')`, `const x = require('./x').create(...)`, `const { a, b } = require('./x')`
const REQUIRE_ASSIGN_RE = /\b(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const INLINE_REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/;
// Receivers that are clearly not HTTP routers (Map#get with a path-like key etc.).
const NOT_ROUTERS = new Set(['map', 'cache', 'headers', 'params', 'searchParams', 'url', 'Map', 'store', 'config', 'settings', 'res', 'req']);

function extractRoutes(text) {
    const out = [];
    text.split('\n').forEach((line, i) => {
        ROUTE_RE.lastIndex = 0;
        let m;
        while ((m = ROUTE_RE.exec(line))) {
            if (NOT_ROUTERS.has(m[1])) continue;
            out.push({ method: m[2].toUpperCase(), path: m[4], line: i + 1 });
        }
    });
    return out;
}

function extractMounts(text) {
    const requires = {};
    let m;
    REQUIRE_ASSIGN_RE.lastIndex = 0;
    while ((m = REQUIRE_ASSIGN_RE.exec(text))) {
        const names = m[1].startsWith('{') ? m[1].slice(1, -1).split(',').map(n => n.split(':').pop().trim()).filter(Boolean) : [m[1]];
        for (const n of names) requires[n] = m[2];
    }
    const out = [];
    text.split('\n').forEach((line, i) => {
        MOUNT_RE.lastIndex = 0;
        while ((m = MOUNT_RE.exec(line))) {
            const rest = m[4];
            const inline = rest.match(INLINE_REQUIRE_RE);
            let spec = inline ? inline[1] : null;
            if (!spec) {
                // The router is the last argument that traces back to a require(): `r`, `svc.router`,
                // `createRoutes(db, ...)`. Middleware (rateLimit(...), requireAuth) comes first.
                const idents = (rest.match(/\b\w+\b/g) || []).filter(t => requires[t]);
                if (idents.length) spec = requires[idents[idents.length - 1]];
            }
            out.push({ prefix: m[3], spec, line: i + 1 });
        }
    });
    return out;
}

function resolveModule(fromFile, spec) {
    if (!spec) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const c of [base, base + '.js', base + '.ts', path.join(base, 'index.js'), path.join(base, 'routes.js')]) {
        try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
    }
    return null;
}

function joinPath(prefix, p) {
    if (!prefix || prefix === '/') return p;
    if (p === '/') return prefix;
    return prefix.replace(/\/$/, '') + p;
}

/**
 * Compose mount prefixes: a file mounted at /api/x by index.js gets /api/x in front of each of its
 * routes; a file mounted by nobody is a root (prefix ''). Cycles are cut.
 */
function computePrefixes(mountsByFile) {
    const parents = {};  // child -> [{parent, prefix}]
    for (const [file, mounts] of Object.entries(mountsByFile)) {
        for (const mt of mounts) {
            if (!mt.target) continue;
            (parents[mt.target] ||= []).push({ parent: file, prefix: mt.prefix });
        }
    }
    const memo = {};
    function prefixesOf(file, seen = new Set()) {
        if (memo[file]) return memo[file];
        if (seen.has(file)) return [''];
        seen.add(file);
        const ps = parents[file];
        const result = !ps ? [''] : [...new Set(ps.flatMap(({ parent, prefix }) =>
            prefixesOf(parent, seen).map(pp => joinPath(pp, prefix))))];
        memo[file] = result;
        return result;
    }
    return { prefixesOf, isMounted: (f) => Boolean(parents[f]) };
}

// ── Raw http.Server routing (OpenVibe.Games) ──────────────────────────────
const URL_EQ_RE = /\burl\s*===\s*'(\/[^']*)'/g;
const URL_STARTS_RE = /\burl\.startsWith\(\s*'(\/[^']*)'\s*\)/g;
const METHOD_RE = /req\.method\s*===\s*'([A-Z]+)'/;

function extractRawRoutes(text) {
    const out = [];
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        const window = lines.slice(i, i + 3).join(' ');
        const mm = window.match(METHOD_RE);
        for (const [re, suffix] of [[URL_EQ_RE, ''], [URL_STARTS_RE, '*']]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(line))) out.push({ method: mm ? mm[1] : 'ANY', path: m[1] + suffix, line: i + 1 });
        }
    });
    return out;
}

// ── WebSockets ────────────────────────────────────────────────────────────
const WSS_RE = /new\s+(?:WebSocket\.Server|WebSocketServer|WebSocket\.WebSocketServer)\s*\(/;
const WS_PATH_RE = /['"`](\/ws\/[\w\-/]*|\/ws)['"`]/g;

function extractWebSockets(text) {
    const servers = [];
    const paths = [];
    text.split('\n').forEach((line, i) => {
        if (WSS_RE.test(line)) servers.push({ line: i + 1 });
        WS_PATH_RE.lastIndex = 0;
        let m;
        while ((m = WS_PATH_RE.exec(line))) paths.push({ path: m[1], line: i + 1 });
    });
    return { servers, paths };
}

// ── Environment variable names ───────────────────────────────────────────
// process.env.X, plus env.X / env['X'] for code that receives the environment as a parameter (Games).
const ENV_RE = /\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)|\b(?:process\.)?env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g;

function extractEnv(text) {
    const names = new Set();
    let m;
    ENV_RE.lastIndex = 0;
    while ((m = ENV_RE.exec(text))) names.add(m[1] || m[2]);
    return [...names];
}

/** Names that carry credentials. Classification only — values are never read. */
function isSecretName(name) {
    if (/PUBLIC|_PATH$|_FILE$|_DIR$|_TTL|_MS$|_SECONDS$|_MINUTES$|_ID$|_URL$|_HOST$|_PORT$|_MODE$|_ENABLED$|_LIMIT$/.test(name)
        && !/WEBHOOK_URL$|SECRET|PASSWORD|PRIVATE/.test(name)) return false;
    return /SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|CREDENTIAL|(^|_)KEY($|_)|APIKEY|WEBHOOK|COOKIE/.test(name);
}

// ── Cross-service calls ──────────────────────────────────────────────────
const SERVICE_PORTS = { 4000: 'network', 4001: 'tools', 4100: 'media', 3000: 'live', 8000: 'games' };
for (let p = 4010; p <= 4016; p++) SERVICE_PORTS[p] = 'tools';

function envTarget(name) {
    const m = name.match(/^(?:OV_)?(NETWORK|MEDIA|LIVE|TOOLS|GAMES|COMMUNITY)_(?:INTERNAL_)?(?:URL|API_URL|BASE_URL|ORIGIN)$/);
    return m ? m[1].toLowerCase() : null;
}

const PATH_TARGETS = [
    [/\/oauth\/token\b/, 'network'], [/\/api\/auth\/me\b/, 'network'], [/\/api\/\.well-known\/jwks/, 'network'],
    [/\/internal\/(coins|notifications|events)\b/, 'network'], [/\/api\/v1\/\$\{/, 'media'],
];

const HTTP_CLIENT_RE = /\bfetch\(|\bhttps?\.request\(|\bhttps?\.get\(|\baxios\b|\bgot\(|\bundici\b|egress\.\w+\(/;

function extractOutbound(text, selfService) {
    if (!HTTP_CLIENT_RE.test(text)) return null;
    const targets = new Map(); // service -> [{via, line}]
    const add = (svc, via, line) => {
        if (!svc || svc === selfService) return;
        if (!targets.has(svc)) targets.set(svc, []);
        targets.get(svc).push({ via, line });
    };
    text.split('\n').forEach((line, i) => {
        let m;
        const envRe = /\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)/g;
        while ((m = envRe.exec(line))) add(envTarget(m[1]), m[1], i + 1);
        // Config indirection: config.networkInternalUrl, cfg.media.url, liveInternalUrl, ...
        const identRe = /\b(network|media|live|tools|games|community)(Internal)?(Url|URL|Base|Origin)\b|\b(network|media|live|tools|games|community)\.(url|internalUrl|baseUrl|apiUrl)\b/gi;
        while ((m = identRe.exec(line))) add((m[1] || m[4]).toLowerCase(), m[0], i + 1);
        if (/webhook_?url/i.test(line)) add('webhook', 'webhook_url (per-app, configured in DB)', i + 1);
        // Contract paths that only one service serves (CONTRACTS.md), for URLs built from config objects.
        for (const [re, svc] of PATH_TARGETS) if (re.test(line)) add(svc, line.match(re)[0], i + 1);
        const portRe = /(?:127\.0\.0\.1|localhost):(\d{4,5})/g;
        while ((m = portRe.exec(line))) add(SERVICE_PORTS[m[1]], `:${m[1]}`, i + 1);
    });
    if (!targets.size) return null;
    const auth = [];
    if (/X-Internal-Key|INTERNAL_API_KEY|x-internal-key/.test(text)) auth.push('internal-key');
    if (/MEDIA_API_KEY|X-Media-Key|x-api-key/i.test(text)) auth.push('api-key');
    if (/Authorization['"]?\s*:\s*[`'"]Bearer|Bearer \$\{/.test(text)) auth.push('bearer');
    if (/createHmac\(/.test(text)) auth.push('hmac');
    if (/client_secret|OAUTH_CLIENT_SECRET/.test(text)) auth.push('oauth-client');
    return {
        targets: [...targets.entries()].map(([service, refs]) => ({ service, refs })),
        auth: auth.length ? auth : ['none-detected'],
        timeout: /AbortSignal\.timeout|\btimeout\s*:|AbortController/.test(text),
        retry: /\bretr(y|ies|ied)\b|\battempts?\b|backoff/i.test(text),
    };
}

// ── Background jobs ──────────────────────────────────────────────────────
const JOB_RE = /jobs\.(every|singleFlight)\(\s*['"]([^'"]+)['"](?:\s*,\s*([\d_]+))?/g;
const INTERVAL_RE = /\bsetInterval\(/;

function extractJobs(text) {
    const out = [];
    text.split('\n').forEach((line, i) => {
        JOB_RE.lastIndex = 0;
        let m;
        while ((m = JOB_RE.exec(line))) {
            out.push({ kind: m[1] === 'every' ? 'jobs.every' : 'jobs.singleFlight', name: m[2],
                intervalMs: m[3] ? Number(m[3].replace(/_/g, '')) : null, line: i + 1 });
        }
        if (INTERVAL_RE.test(line) && !/clearInterval/.test(line)) {
            const lit = line.match(/,\s*([\d_]+)\s*(?:\*\s*([\d_]+))?\s*(?:\*\s*([\d_]+))?\s*\)/);
            let ms = null;
            if (lit) ms = [lit[1], lit[2], lit[3]].filter(Boolean).reduce((a, b) => a * Number(b.replace(/_/g, '')), 1);
            out.push({ kind: 'setInterval', name: null, intervalMs: ms, line: i + 1 });
        }
    });
    return out;
}

module.exports = {
    walk, isTestFile, extractTables, extractRoutes, extractMounts, resolveModule, computePrefixes,
    joinPath, extractRawRoutes, extractWebSockets, extractEnv, isSecretName, envTarget,
    extractOutbound, extractJobs, SERVICE_PORTS,
};
