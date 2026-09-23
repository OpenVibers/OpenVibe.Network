'use strict';
/**
 * Ecosystem registry (roadmap Wave 2, implementation plan §5.1).
 *
 * What exists, what each service can do, and whether it is up — built from the versioned manifests in
 * openvibe-contracts (services, capabilities, user-module namespaces, contract catalog) instead of route
 * maps hard-coded into each product. Health is polled here and every value says when it was checked;
 * nothing is presented as live without a timestamp. Whether a service's public domain serves it, or it
 * runs on loopback only, is Network's exposure overlay (./exposure.js): the manifests say maturity.
 *
 *   GET /.well-known/openvibe                       platform descriptor
 *   GET /api/v1/registry/services[?status=&state=]  manifests + exposure + health
 *   GET /api/v1/registry/services/:id
 *   GET /api/v1/registry/domains/:domain            which service answers for a host
 *   GET /api/v1/registry/capabilities[?owner=]      capability manifests
 *   GET /api/v1/registry/capabilities/:id
 *   GET /api/v1/registry/namespaces                 user-module namespaces
 *   GET /api/v1/registry/contracts                  contract catalog
 *   GET /api/v1/registry/topics                     event topics (Events, Wave 3)
 *   GET /contracts/<domain>/<name>.v<N>.json        the schema at its $id URL
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const contractsPkg = require('openvibe-contracts/package.json');
const { exposureOf, publicOriginOf } = require('./exposure');

// Where each running service answers health checks from this host (manifests carry the public origin).
const INTERNAL = {
    network: 'http://127.0.0.1:4000', live: 'http://127.0.0.1:3000', media: 'http://127.0.0.1:4100',
    tools: 'http://127.0.0.1:4001', games: 'http://127.0.0.1:8000', community: 'http://127.0.0.1:4200',
    events: 'http://127.0.0.1:4300', billing: 'http://127.0.0.1:4600',
    // Assigned ports of services that are placeholders or new; a placeholder is never polled.
    chat: 'http://127.0.0.1:4400', openre: 'http://127.0.0.1:4500', tips: 'http://127.0.0.1:4610', vip: 'http://127.0.0.1:4620',
    ai: 'http://127.0.0.1:4700', search: 'http://127.0.0.1:4710', sources: 'http://127.0.0.1:4720', wiki: 'http://127.0.0.1:4800',
    blog: 'http://127.0.0.1:4810', news: 'http://127.0.0.1:4820', reviews: 'http://127.0.0.1:4830', deals: 'http://127.0.0.1:4840',
    coupons: 'http://127.0.0.1:4850', trade: 'http://127.0.0.1:4860', codes: 'http://127.0.0.1:4900', host: 'http://127.0.0.1:4910',
};
const POLL_MS = 60 * 1000;
// Readiness paths of services whose manifest (openvibe-contracts) does not carry `ready` yet. Each
// answers with openvibe-shared/ready's shape; until a service deploys it, its health path is used
// and the row says so (basis: 'health').
const READY_PATHS = { network: '/api/ready', media: '/api/ready', tools: '/api/ready', ai: '/api/ready' };
// Liveness paths of services whose manifest in the pinned openvibe-contracts has none (AI is a
// placeholder there but runs on loopback; see ./exposure.js).
const HEALTH_PATHS = { ai: '/api/health' };

/** Row status from a readiness body (openvibe-shared/ready shape, or an older ad-hoc one). */
function statusFromReady(res, body) {
    const shared = body && typeof body === 'object' && typeof body.ready === 'boolean' && body.checks && typeof body.checks === 'object';
    if (!shared) return { status: res.ok ? 'up' : 'down', basis: 'ready-legacy' };
    if (!body.ready) return { status: 'down', basis: 'ready' };
    const degraded = Array.isArray(body.degraded) ? body.degraded : [];
    return { status: body.status === 'degraded' || degraded.length ? 'degraded' : 'up', basis: 'ready' };
}

/** What a status row may repeat from a service's readiness body: names, states and times, no free-form detail. */
function readySummary(body) {
    if (!body || typeof body !== 'object' || typeof body.ready !== 'boolean') return null;
    const checks = {};
    for (const [name, c] of Object.entries(body.checks || {}).slice(0, 40)) {
        if (!c || typeof c !== 'object') continue;
        checks[String(name).slice(0, 64)] = {
            status: c.status === 'ok' ? 'ok' : 'fail', required: c.required !== false,
            latency_ms: Number.isFinite(c.latency_ms) ? c.latency_ms : null,
            checked_at: typeof c.checked_at === 'string' ? c.checked_at.slice(0, 40) : null,
            ...(c.error ? { error: String(c.error).slice(0, 200) } : {}),
        };
    }
    const names = (a) => (Array.isArray(a) ? a.map(x => String(x).slice(0, 64)).slice(0, 40) : []);
    return { ready: body.ready, status: String(body.status || (body.ready ? 'ready' : 'not_ready')).slice(0, 20), checked_at: typeof body.checked_at === 'string' ? body.checked_at.slice(0, 40) : null, failed: names(body.failed), degraded: names(body.degraded), checks };
}

function createEcosystemRegistry({ issuer, internalOverrides = {}, fetchImpl = globalThis.fetch, pollMs = POLL_MS, readyPaths = READY_PATHS, healthPaths = HEALTH_PATHS, now = () => Date.now() } = {}) {
    const internal = { ...INTERNAL, ...internalOverrides };
    // id -> { status: up|degraded|down|not-running|unknown, basis, reason, http_status, latency_ms, checked_at, ready, release }
    const health = new Map();
    let timer = null;
    let lastPollAt = null;

    async function getJson(url) {
        const t0 = now();
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } });
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        return { res, body, latency: now() - t0 };
    }

    async function releaseOf(base) {
        try {
            const { res, body } = await getJson(`${base}/release.json`);
            if (!res.ok || !body || typeof body.release !== 'string') return { release: null, error: `release.json answered ${res.status}` };
            return { release: body.release.slice(0, 40), released_at: body.released_at || null, booted_at: body.booted_at || null };
        } catch (err) {
            return { release: null, error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
        }
    }

    async function checkOne(m) {
        const at = () => new Date(now()).toISOString();
        const base = internal[m.id];
        // What runs is decided by Network's exposure overlay, not the manifest's maturity label.
        const exp = exposureOf(m.id);
        if (exp.state === 'placeholder' || (exp.state === 'unknown' && m.status === 'placeholder')) { health.set(m.id, { status: 'not-running', reason: 'placeholder', checked_at: at() }); return; }
        if (exp.state === 'library') { health.set(m.id, { status: 'not-running', reason: `library, released ${exp.release}`, checked_at: at() }); return; }
        if (exp.state === 'repository') { health.set(m.id, { status: 'not-running', reason: 'repository, nothing to run', checked_at: at() }); return; }
        const readyPath = m.ready || readyPaths[m.id] || null;
        const healthPath = m.health || healthPaths[m.id] || null;
        if (!healthPath && !readyPath && !(m.domains || []).length) { health.set(m.id, { status: 'not-running', reason: 'no runtime', checked_at: at() }); return; }
        if (!base) { health.set(m.id, { status: 'unknown', reason: 'no internal address known to Network', checked_at: at() }); return; }
        if (!readyPath && !healthPath) { health.set(m.id, { status: 'unknown', reason: 'no health or readiness path in its manifest', checked_at: at() }); return; }
        const releaseP = releaseOf(base);
        let entry;
        try {
            let got = readyPath ? await getJson(`${base}${readyPath}`) : null;
            if (got && got.res.status !== 404) {
                entry = { ...statusFromReady(got.res, got.body), ready: readySummary(got.body) };
            } else {
                // No readiness endpoint (yet): liveness is all that can be said.
                if (!healthPath) throw Object.assign(new Error('readiness endpoint answered 404'), { name: 'NoReadiness' });
                got = await getJson(`${base}${healthPath}`);
                entry = { status: got.res.ok ? 'up' : 'down', basis: 'health', reason: 'liveness only: no readiness endpoint answered', ready: null };
            }
            entry.http_status = got.res.status;
            entry.latency_ms = got.latency;
        } catch (err) {
            entry = { status: 'down', basis: 'unreachable', error: err.name === 'TimeoutError' ? 'timeout' : err.name === 'NoReadiness' ? err.message : 'unreachable', ready: null };
        }
        // Polled on loopback: a running internal service is up there, not at its public domain.
        entry.scope = exp.state === 'live' ? 'public' : 'loopback';
        if (exp.state === 'internal') entry.reason = ['loopback only, no public site yet', entry.reason].filter(Boolean).join('; ');
        entry.release = await releaseP;
        entry.checked_at = at();
        health.set(m.id, entry);
    }
    const pollAll = async () => { await Promise.all(contracts.services.manifests.map(checkOne)); lastPollAt = now(); };
    function start() {
        if (timer) return;
        const loop = async () => { try { await pollAll(); } catch { /* one bad poll never stops the loop */ } timer = setTimeout(loop, pollMs); if (timer.unref) timer.unref(); };
        // First poll a few seconds in: this process is one of the services it checks, and it is not listening yet.
        timer = setTimeout(loop, 5000);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearTimeout(timer); timer = null; }

    /** The row as it stands now: a result older than three poll intervals is 'unknown', never a stale 'up'. */
    function current(id) {
        const h = health.get(id);
        if (!h) return { status: 'unknown', reason: 'not checked yet', checked_at: null };
        const age = now() - Date.parse(h.checked_at);
        if (age > 3 * pollMs) return { ...h, status: 'unknown', reason: `last check is ${Math.round(age / 1000)}s old`, last_status: h.status, stale: true };
        return h;
    }

    // The manifest as published, plus where it can be reached (exposure) and what the last check saw (runtime).
    const withHealth = (m) => ({ ...m, exposure: exposureOf(m.id), runtime: current(m.id) });

    function descriptor() {
        return {
            name: 'OpenVibe',
            issuer,
            jwks_uri: `${issuer}/api/.well-known/jwks`,
            token_endpoint: `${issuer}/oauth/token`,
            openid_configuration: `${issuer}/oauth/.well-known/openid-configuration`,
            registry: `${issuer}/api/v1/registry`,
            contracts: { package: 'openvibe-contracts', version: contractsPkg.version, repository: 'https://github.com/OpenVibers/OpenVibe.Contracts', catalog: `${issuer}/api/v1/registry/contracts` },
            // origin is set only where the public domain serves the service itself; a domain that still
            // serves a placeholder is planned_origin, so a client never routes calls to a placeholder page.
            services: contracts.services.manifests.map((m) => {
                const e = exposureOf(m.id); const origin = publicOriginOf(m);
                return { id: m.id, status: m.status, state: e.state, origin, ...(!origin && m.publicOrigin ? { planned_origin: m.publicOrigin } : {}) };
            }),
        };
    }

    function router() {
        const r = express.Router();
        const cache = (res, s = 60) => res.set('Cache-Control', `public, max-age=${s}`).set('Access-Control-Allow-Origin', '*');
        const notFound = (res, code, detail) => contracts.http.sendProblem(res, 404, code, { detail });

        r.get('/.well-known/openvibe', (_req, res) => cache(res, 300).json(descriptor()));
        r.get('/api/v1/registry', (_req, res) => cache(res).json({ services: '/api/v1/registry/services', capabilities: '/api/v1/registry/capabilities', namespaces: '/api/v1/registry/namespaces', contracts: '/api/v1/registry/contracts', topics: '/api/v1/registry/topics', domains: '/api/v1/registry/domains/:domain' }));
        r.get('/api/v1/registry/services', (req, res) => {
            let list = contracts.services.manifests.map(withHealth);
            if (req.query.status) list = list.filter(m => m.status === String(req.query.status));
            if (req.query.state) list = list.filter(m => m.exposure.state === String(req.query.state));
            cache(res, 30).json({ services: list, contracts_version: contractsPkg.version });
        });
        r.get('/api/v1/registry/services/:id', (req, res) => {
            const m = contracts.services.get(req.params.id);
            if (!m) return notFound(res, 'registry.unknown_service', `no service ${req.params.id}`);
            cache(res, 30).json({ ...withHealth(m), capability_details: m.capabilities.map(id => contracts.capabilities.get(id)).filter(Boolean) });
        });
        r.get('/api/v1/registry/domains/:domain', (req, res) => {
            const d = String(req.params.domain).toLowerCase();
            const m = contracts.services.manifests.find(x => (x.domains || []).includes(d));
            if (!m) return notFound(res, 'registry.unknown_domain', `no service claims ${d}`);
            cache(res).json({ domain: d, service: withHealth(m) });
        });
        r.get('/api/v1/registry/capabilities', (req, res) => {
            let list = contracts.capabilities.manifests;
            if (req.query.owner) list = list.filter(c => c.owner === String(req.query.owner));
            cache(res).json({ capabilities: list });
        });
        r.get('/api/v1/registry/capabilities/:id', (req, res) => {
            const c = contracts.capabilities.get(req.params.id);
            if (!c) return notFound(res, 'registry.unknown_capability', `no capability ${req.params.id}`);
            cache(res).json(c);
        });
        r.get('/api/v1/registry/namespaces', (_req, res) => cache(res).json({ namespaces: contracts.modules.namespaces }));
        r.get('/api/v1/registry/contracts', (_req, res) => cache(res).json({ version: contractsPkg.version, contracts: contracts.catalog.map(c => ({ ...c, $id: contracts.schema(c.id).$id })) }));
        r.get('/api/v1/registry/topics', (_req, res) => cache(res).json({ topics: [], note: 'Durable event topics are published by OpenVibe.Events (roadmap Wave 3).' }));
        r.get(/^\/contracts\/([a-z0-9-]+)\/([a-z0-9-]+\.v\d+)\.json$/, (req, res) => {
            const file = `${req.params[0]}/${req.params[1]}.json`;
            const entry = contracts.catalog.find(c => c.schema === file);
            if (!entry) return notFound(res, 'registry.unknown_contract', `no contract ${file}`);
            cache(res, 3600).type('application/schema+json').send(JSON.stringify(contracts.schema(entry.id), null, 2));
        });
        return r;
    }

    return { router, start, stop, pollAll, health, current, descriptor, lastPollAt: () => lastPollAt, pollMs, internal };
}

module.exports = { createEcosystemRegistry, INTERNAL, READY_PATHS, HEALTH_PATHS, statusFromReady, readySummary };
