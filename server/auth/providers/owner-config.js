'use strict';
/**
 * Network's own owner settings, answered in process (plan §AB.20).
 *
 * Every other service's settings reach Network's admin panel over its own /internal/config with a service token for
 * `<service>.config.manage`. Network cannot mint one for itself — Contracts says network uses its own admin config
 * routes, not the proxy capability (openvibe-contracts/test/run.js) — so the proxy dispatches `network` here instead
 * of over the network: the same openvibe-shared/config handlers, the same shapes, the same fresh-sign-in rule, just
 * without a hop (and without a token it is not allowed to have).
 *
 *   const out = await local(app, req, '/internal/config/network.signin', { method: 'POST', body })
 *   → { status, answer }
 */
const configNs = require('./config');
const presets = require('./presets');
const { isFreshSignIn } = require('../../identity/reauth');

const BASE = '/internal/config';
const byApp = new WeakMap();

async function handlersFor(app, req) {
    const db = app.locals.db;
    const base = String((app.locals.config || {}).baseUrl || 'https://openvibe.network');
    const store = await configNs.forDb(db, base);
    const key = store.namespace;
    const cache = byApp.get(app) || new Map();
    byApp.set(app, cache);
    if (cache.has(key)) return cache.get(key);
    const routes = require('openvibe-shared/config').adminRoutes([store], {
        basePath: BASE,
        // The proxy has already refused anyone but the owner, with its own rate limiter and audit.
        requireAdmin: (_q, _s, next) => next(),
        actor: (q) => (q.user && q.user.subject_id ? { type: 'user', id: String(q.user.subject_id) } : null),
        requireFresh: (q) => String((q.headers && q.headers['x-ov-fresh']) || '') === '1' && isFreshSignIn(q.tokenClaims),
        // Setup's Test on a provider's row: one cheap read of that provider's own sign-in service (server/auth/providers/
        // internal.js), never a token exchange and never a value echoed back.
        test: async ({ namespace, key: testKey }) => {
            if (namespace !== configNs.NAMESPACE) return null;
            const providerId = String(testKey).split('.')[0];
            if (!presets.BY_ID.has(providerId)) return null;
            return await require('./internal').testProvider({ db, baseUrl: base, providerId });
        },
        log: { info: (m) => console.log(`[SignIn] ${m}`), warn: (m) => console.warn(`[SignIn] ${m}`), error: (m) => console.error(`[SignIn] ${m}`) },
    });
    cache.set(key, routes);
    return routes;
}

/** A minimal response the shared handlers can write to: status, JSON body, no socket. */
function capture() {
    const out = { status: 200, headers: {}, text: '' };
    const res = {
        set statusCode(v) { out.status = v; },
        get statusCode() { return out.status; },
        headersSent: false,
        setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
        getHeader(k) { return out.headers[String(k).toLowerCase()]; },
        status(v) { out.status = v; return res; },
        json(body) { out.text = JSON.stringify(body); out.status = out.status || 200; return res; },
        end(chunk) { if (chunk !== undefined) out.text += String(chunk); return res; },
        write(chunk) { out.text += String(chunk); return true; },
    };
    return { res, out };
}

/** Dispatch one /internal/config request in process. `pathName` is the full path the proxy would have fetched. */
async function local(app, req, pathName, { method = 'GET', body = null } = {}) {
    const routes = await handlersFor(app, req);
    const fake = Object.create(req);
    fake.url = String(pathName);
    fake.method = String(method).toUpperCase();
    fake.body = body === null ? undefined : body;
    // The shared handlers read req.params for the namespace and the key (an Express router fills these; here the
    // path is known, so it is split the same way).
    const rest = new URL(fake.url, 'http://x').pathname.slice(BASE.length + 1).split('/').filter(Boolean);
    fake.params = {};
    if (rest.length >= 1) fake.params.namespace = decodeURIComponent(rest[0]);
    if (rest.length === 3) fake.params.key = decodeURIComponent(rest[2]);
    fake.query = Object.fromEntries(new URL(fake.url, 'http://x').searchParams);
    const { res, out } = capture();
    await new Promise((resolve) => {
        const done = () => resolve();
        const finish = res.end.bind(res);
        res.end = (chunk) => { finish(chunk); done(); return res; };
        try { routes.handle(fake, res, done); } catch { done(); }
    });
    let answer = null;
    try { answer = out.text ? JSON.parse(out.text) : null; } catch { answer = { error: String(out.text).slice(0, 500) }; }
    return { status: out.status, answer };
}

module.exports = { local, handlersFor, BASE };
