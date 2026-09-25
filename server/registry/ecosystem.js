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
 *   GET /api/v1/registry/topics[?service=&producer=&consumer=&prefix=]
 *                                                   event topics: producers, consumers, payload contract
 *   GET /api/v1/registry/topics/:topic
 *   GET /api/v1/registry/releases                   what each running service runs (its /release.json,
 *                                                   polled on loopback with health) and the libraries'
 *                                                   current releases, with contracts/sdk/shared drift
 *   GET /api/v1/registry/health                     one line per service: status, checked_at
 *   GET /api/v1/registry/search?q=                  services, capabilities, topics and contracts by text
 *   GET /api/v1/registry/categories[/:id]           services grouped by what they are (site, platform,
 *                                                   library, repository, planned), each rule stated
 *   GET /api/v1/registry/featured                   public sites that are up, most used first (the navbar's
 *                                                   usage ranking), with when that use was counted
 *   GET /contracts/<domain>/<name>.v<N>.json        the schema at its $id URL
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const contractsPkg = require('openvibe-contracts/package.json');
const { exposureOf, publicOriginOf, libraries } = require('./exposure');
const { buildTopics, eventsOf } = require('./topics');
const { driftOf } = require('./versions');
const { SITES } = require('../frame/sites');

// Where each running service answers health checks from this host: its manifest's `internalOrigin`
// (openvibe-contracts ≥ 0.42.0, WS-C task 1). OV_<ID>_INTERNAL_URL overrides any of them (internalFromEnv
// below), validated as a loopback http(s) URL: the environment half of "manifests plus validated overrides".
const INTERNAL = Object.fromEntries(contracts.services.manifests.filter((m) => m.internalOrigin).map((m) => [m.id, m.internalOrigin]));
const POLL_MS = 60 * 1000;
// Readiness and liveness paths come from the manifests (`ready`, `health`); these maps are for a manifest
// that lacks one and stay empty (test/registry-ecosystem.test.js).
const READY_PATHS = {};
const HEALTH_PATHS = {};

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

/**
 * OV_<ID>_INTERNAL_URL (e.g. OV_EVENTS_INTERNAL_URL, OV_AI_INTERNAL_URL) for each manifest id, when it is a
 * loopback http(s) URL: health is polled on this host only. Anything else is ignored (and reported).
 */
function internalFromEnv(env = process.env) {
    const out = {}; const ignored = [];
    for (const m of contracts.services.manifests) {
        const name = `OV_${m.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_INTERNAL_URL`;
        const v = env[name];
        if (!v) continue;
        try {
            const u = new URL(String(v));
            if ((u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) { out[m.id] = `${u.protocol}//${u.host}`; continue; }
        } catch { /* fall through */ }
        ignored.push(name);
    }
    return { overrides: out, ignored };
}

// What each category means; categoryOf() applies it. Derived from Network's exposure overlay and its site
// list (server/frame/sites.js), never set by hand per service.
const CATEGORIES = [
    { id: 'site', name: 'Sites', rule: 'a product people use in a browser: it has an entry in the network\'s site list (server/frame/sites.js), open in the navigation once its public domain serves it' },
    { id: 'platform', name: 'Platform services', rule: 'runs (publicly or on loopback) but is not a site people visit: other services call it' },
    { id: 'library', name: 'Libraries', rule: 'exposure library: a released package other code installs' },
    { id: 'repository', name: 'Repositories', rule: 'exposure repository: code with CI, neither released nor run' },
    { id: 'planned', name: 'Planned', rule: 'exposure placeholder: charter only, nothing runs' },
];
function categoryOf(m) {
    const e = exposureOf(m.id);
    if (e.state === 'library') return 'library';
    if (e.state === 'repository') return 'repository';
    if (e.state === 'placeholder' || (e.state === 'unknown' && m.status === 'placeholder')) return 'planned';
    return SITES.some(s => s.service === m.id) ? 'site' : 'platform';
}

function createEcosystemRegistry({ issuer, internalOverrides = {}, fetchImpl = globalThis.fetch, pollMs = POLL_MS, readyPaths = READY_PATHS, healthPaths = HEALTH_PATHS, now = () => Date.now(), ranking = null } = {}) {
    const internal = { ...INTERNAL, ...internalOverrides };
    let rankingOf = ranking;
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
            // registry.release-manifest@1 (openvibe-shared/release): the commit, when it was made and booted,
            // and the installed openvibe-contracts / openvibe-* package versions (names and x.y.z only).
            const packages = {};
            if (body.packages && typeof body.packages === 'object') {
                for (const [k, v] of Object.entries(body.packages).slice(0, 10)) if (/^openvibe-[a-z-]{1,30}$/.test(k) && /^\d+\.\d+\.\d+/.test(String(v))) packages[k] = String(v).slice(0, 20);
            }
            const ver = (v) => (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v.slice(0, 20) : null);
            return { release: body.release.slice(0, 40), released_at: body.released_at || null, booted_at: body.booted_at || null, contracts_version: ver(body.contracts_version), packages };
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

    // The manifest as published, with the event types Network observed it producing or consuming merged
    // in (./topics.js; `observed` names them), plus where it can be reached (exposure) and what the last
    // check saw (runtime).
    const withHealth = (m) => {
        const ev = eventsOf(m);
        return { ...m, eventsProduced: ev.eventsProduced, eventsConsumed: ev.eventsConsumed, ...(ev.observed ? { observed: ev.observed } : {}), exposure: exposureOf(m.id), runtime: current(m.id) };
    };

    /** Each service's running release (from the health poll) and drift against the libraries' releases. */
    function releases() {
        const libs = libraries();
        const services = contracts.services.manifests.map((m) => {
            const e = exposureOf(m.id);
            if (e.state === 'library') return null;
            const h = current(m.id);
            const r = h.release && typeof h.release === 'object' ? h.release : null;
            const row = { id: m.id, state: e.state, status: h.status, checked_at: h.checked_at || null, release: r ? r.release : null };
            if (!r || !r.release) { row.error = (r && r.error) || h.reason || null; return row; }
            Object.assign(row, { released_at: r.released_at, booted_at: r.booted_at, contracts_version: r.contracts_version || null, packages: r.packages || {} });
            // How far the deployed commit is behind the repository's main branch (./deploy-drift.js).
            const dd = require('./deploy-drift').current(m.id);
            if (dd) row.main = { state: dd.state, behind_by: dd.behind_by ?? null, since: dd.since || null, head: dd.main || null, checked_at: dd.checked_at, ...(dd.error ? { error: dd.error } : {}) };
            row.drift = {};
            for (const l of libs) {
                const installed = l.package === 'openvibe-contracts' ? r.contracts_version : (r.packages || {})[l.package];
                if (installed) row.drift[l.package] = { installed, latest: l.release, state: driftOf(installed, l.release) };
            }
            return row;
        }).filter(Boolean);
        const behind = services.filter(s => s.drift && Object.values(s.drift).some(d => d.state === 'behind')).map(s => s.id);
        // Deployed behind main for more than a day (WS-S task 7).
        const dayAgo = now() - 24 * 3600e3;
        const undeployed = services.filter(s => s.main && s.main.state === 'behind' && s.main.since && Date.parse(s.main.since) < dayAgo).map(s => s.id);
        return { checked_at: lastPollAt ? new Date(lastPollAt).toISOString() : null, poll_interval_s: Math.round(pollMs / 1000), libraries: libs, services, behind, undeployed };
    }

    /** Services grouped by category, each with its maturity, exposure and last check. */
    function categories() {
        const rowOf = (m) => { const h = current(m.id); return { id: m.id, name: m.name || m.id, status: m.status, state: exposureOf(m.id).state, origin: publicOriginOf(m), runtime: h.status, checked_at: h.checked_at || null }; };
        return CATEGORIES.map((c) => {
            const services = contracts.services.manifests.filter(m => categoryOf(m) === c.id).map(rowOf);
            return { ...c, count: services.length, services };
        });
    }

    /**
     * Featured: the sites whose public domain serves them and whose last check (not stale) was up or degraded,
     * in the navbar's usage order (server/frame/service.js: page views over 7 days plus signed-in history
     * over 14, recounted every 30 minutes). The hub does not feature itself. Nothing is picked by hand.
     */
    function featured() {
        const r = typeof rankingOf === 'function' ? rankingOf() : null;
        const open = SITES.filter(s => s.status === 'open');
        const order = r && Array.isArray(r.order) ? r.order : open.map(s => s.id);
        const bySite = new Map(open.map(s => [s.id, s]));
        const list = [];
        for (const siteId of order) {
            const site = bySite.get(siteId);
            if (!site || site.service === 'network') continue;
            const m = contracts.services.get(site.service);
            if (!m) continue;
            const h = current(m.id);
            if (h.status !== 'up' && h.status !== 'degraded') continue;
            list.push({ rank: list.length + 1, id: m.id, name: m.name || m.id, site: site.name, origin: publicOriginOf(m) || `https://${site.host}`, tagline: site.tagline, status: h.status, checked_at: h.checked_at });
        }
        const at = r && r.at ? r.at : null;
        const every = (r && r.everyMs) || 30 * 60 * 1000;
        return {
            derivation: 'Sites whose public domain serves the service itself and whose last health check (at most three poll intervals old) was up or degraded, ordered by use: page views over the last 7 days (the shared navbar\'s anonymous count, and Live\'s own analytics) plus signed-in cross-site history over 14 days, the order the network navigation uses. The hub itself is not listed; nothing is featured by hand.',
            ordered_by: at ? 'usage' : 'site list order (no use counted yet)',
            ranked_at: at ? new Date(at).toISOString() : null,
            stale: !at || now() - at > 4 * every,
            checked_at: lastPollAt ? new Date(lastPollAt).toISOString() : null,
            featured: list,
        };
    }

    function descriptor() {
        return {
            name: 'OpenVibe',
            issuer,
            jwks_uri: `${issuer}/api/.well-known/jwks`,
            token_endpoint: `${issuer}/oauth/token`,
            openid_configuration: `${issuer}/.well-known/openid-configuration`,
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
        r.get('/api/v1/registry', (_req, res) => cache(res).json({ services: '/api/v1/registry/services', capabilities: '/api/v1/registry/capabilities', namespaces: '/api/v1/registry/namespaces', contracts: '/api/v1/registry/contracts', topics: '/api/v1/registry/topics', releases: '/api/v1/registry/releases', health: '/api/v1/registry/health', search: '/api/v1/registry/search?q=', domains: '/api/v1/registry/domains/:domain', categories: '/api/v1/registry/categories', featured: '/api/v1/registry/featured' }));
        r.get('/api/v1/registry/categories', (_req, res) => cache(res, 30).json({ categories: categories(), checked_at: lastPollAt ? new Date(lastPollAt).toISOString() : null }));
        r.get('/api/v1/registry/categories/:id', (req, res) => {
            const c = categories().find(x => x.id === String(req.params.id));
            if (!c) return notFound(res, 'registry.unknown_category', `no category ${req.params.id}; categories: ${CATEGORIES.map(x => x.id).join(', ')}`);
            cache(res, 30).json(c);
        });
        r.get('/api/v1/registry/featured', (_req, res) => cache(res, 60).json(featured()));
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
        r.get('/api/v1/registry/topics', (req, res) => {
            const built = buildTopics();
            let list = built.topics;
            const q = (k) => (req.query[k] ? String(req.query[k]).toLowerCase().slice(0, 100) : null);
            const svc = q('service'), producer = q('producer'), consumer = q('consumer'), prefix = q('prefix');
            if (svc) list = list.filter(t => t.services.includes(svc));
            if (producer) list = list.filter(t => t.producers.some(p => p.service === producer));
            if (consumer) list = list.filter(t => t.consumers.some(c => c.service === consumer));
            if (prefix) list = list.filter(t => t.topic.startsWith(prefix));
            cache(res).json({ topics: list, patterns: built.patterns, contracts_version: contractsPkg.version, delivery: 'OpenVibe.Events: subscribe with POST /api/v1/subscriptions { topic_pattern, endpoint }' });
        });
        r.get('/api/v1/registry/topics/:topic', (req, res) => {
            const t = buildTopics().topics.find(x => x.topic === String(req.params.topic));
            if (!t) return notFound(res, 'registry.unknown_topic', `no topic ${req.params.topic}`);
            cache(res).json(t);
        });
        r.get('/api/v1/registry/releases', (_req, res) => cache(res, 30).json(releases()));
        r.get('/api/v1/registry/health', (_req, res) => {
            const services = contracts.services.manifests.map((m) => { const h = current(m.id); return { id: m.id, state: exposureOf(m.id).state, status: h.status, checked_at: h.checked_at || null, ...(h.stale ? { stale: true } : {}) }; });
            const summary = {};
            for (const s of services) summary[s.status] = (summary[s.status] || 0) + 1;
            cache(res, 30).json({ checked_at: lastPollAt ? new Date(lastPollAt).toISOString() : null, summary, services });
        });
        r.get('/api/v1/registry/search', (req, res) => {
            const q = String(req.query.q || '').toLowerCase().trim().slice(0, 100);
            if (q.length < 2) return contracts.http.sendProblem(res, 400, 'registry.bad_query', { detail: 'q must be at least 2 characters' });
            const hit = (...fields) => fields.some(f => typeof f === 'string' && f.toLowerCase().includes(q));
            const services = contracts.services.manifests.filter(m => hit(m.id, m.name, m.notes, ...(m.domains || []))).map(m => ({ id: m.id, name: m.name, status: m.status, state: exposureOf(m.id).state }));
            const capabilities = contracts.capabilities.manifests.filter(c => hit(c.id, c.description, c.owner)).slice(0, 50).map(c => ({ id: c.id, owner: c.owner, status: c.status, visibility: c.visibility }));
            const topics = buildTopics().topics.filter(t => hit(t.topic)).slice(0, 50).map(t => ({ topic: t.topic, status: t.status, producers: t.producers.map(p => p.service) }));
            const found = contracts.catalog.filter(c => hit(c.id, c.owner)).slice(0, 50).map(c => ({ id: c.id, version: c.version, owner: c.owner, status: c.status }));
            cache(res).json({ q, services, capabilities, topics, contracts: found });
        });
        // Event payload contracts sit one level deeper (events/payloads/<event_type>.v<N>.json).
        r.get(/^\/contracts\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)\/([a-z0-9_.-]+\.v\d+)\.json$/, (req, res) => {
            const file = `${req.params[0]}/${req.params[1]}.json`;
            const entry = contracts.catalog.find(c => c.schema === file);
            if (!entry) return notFound(res, 'registry.unknown_contract', `no contract ${file}`);
            cache(res, 3600).type('application/schema+json').send(JSON.stringify(contracts.schema(entry.id), null, 2));
        });
        return r;
    }

    return { router, start, stop, pollAll, health, current, descriptor, categories, featured, releases, setRanking: (fn) => { rankingOf = fn; }, lastPollAt: () => lastPollAt, pollMs, internal };
}

module.exports = { createEcosystemRegistry, INTERNAL, READY_PATHS, HEALTH_PATHS, CATEGORIES, categoryOf, internalFromEnv, statusFromReady, readySummary };
