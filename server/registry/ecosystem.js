'use strict';
/**
 * Ecosystem registry (roadmap Wave 2, implementation plan §5.1).
 *
 * What exists, what each service can do, and whether it is up — built from the versioned manifests in
 * openvibe-contracts (services, capabilities, user-module namespaces, contract catalog) instead of route
 * maps hard-coded into each product. Health is polled here and every value says when it was checked;
 * nothing is presented as live without a timestamp.
 *
 *   GET /.well-known/openvibe                       platform descriptor
 *   GET /api/v1/registry/services[?status=]         manifests + health
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

// Where each running service answers health checks from this host (manifests carry the public origin).
const INTERNAL = {
    network: 'http://127.0.0.1:4000', live: 'http://127.0.0.1:3000', media: 'http://127.0.0.1:4100',
    tools: 'http://127.0.0.1:4001', games: 'http://127.0.0.1:8000', community: 'http://127.0.0.1:4200',
    events: 'http://127.0.0.1:4300',
};
const POLL_MS = 60 * 1000;

function createEcosystemRegistry({ issuer, internalOverrides = {}, fetchImpl = globalThis.fetch, pollMs = POLL_MS } = {}) {
    const internal = { ...INTERNAL, ...internalOverrides };
    const health = new Map();   // id -> { status: up|down|unknown, http_status, latency_ms, checked_at }
    let timer = null;

    async function checkOne(m) {
        const base = internal[m.id];
        const path = m.ready || m.health;
        if (m.status === 'placeholder' || !base || !path) {
            health.set(m.id, { status: m.status === 'placeholder' ? 'not-running' : 'unknown', checked_at: new Date().toISOString() });
            return;
        }
        const t0 = Date.now();
        try {
            const res = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(3000) });
            health.set(m.id, { status: res.ok ? 'up' : 'down', http_status: res.status, latency_ms: Date.now() - t0, checked_at: new Date().toISOString() });
        } catch (err) {
            health.set(m.id, { status: 'down', error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable', checked_at: new Date().toISOString() });
        }
    }
    const pollAll = () => Promise.all(contracts.services.manifests.map(checkOne));
    function start() {
        if (timer) return;
        const loop = async () => { try { await pollAll(); } catch { /* one bad poll never stops the loop */ } timer = setTimeout(loop, pollMs); if (timer.unref) timer.unref(); };
        loop();
    }
    function stop() { if (timer) clearTimeout(timer); timer = null; }

    const withHealth = (m) => ({ ...m, runtime: health.get(m.id) || { status: 'unknown', checked_at: null } });

    function descriptor() {
        return {
            name: 'OpenVibe',
            issuer,
            jwks_uri: `${issuer}/api/.well-known/jwks`,
            token_endpoint: `${issuer}/oauth/token`,
            openid_configuration: `${issuer}/oauth/.well-known/openid-configuration`,
            registry: `${issuer}/api/v1/registry`,
            contracts: { package: 'openvibe-contracts', version: contractsPkg.version, repository: 'https://github.com/OpenVibers/OpenVibe.Contracts', catalog: `${issuer}/api/v1/registry/contracts` },
            services: contracts.services.manifests.map(m => ({ id: m.id, status: m.status, origin: m.publicOrigin || null })),
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

    return { router, start, stop, pollAll, health, descriptor };
}

module.exports = { createEcosystemRegistry, INTERNAL };
