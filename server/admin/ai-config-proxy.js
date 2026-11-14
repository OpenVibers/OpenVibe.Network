'use strict';
/**
 * The owner's platform settings proxy (AI Exchange D11 S3; /home/workstation/openvibe/plan-state-2026-10-22/
 * ai-exchange/OWNER-SETTINGS.md): the admin panel's AI tab reads and changes every service's openvibe-shared/config
 * namespaces from here, and AI's provider registry through AI's own admin API.
 *
 *   GET    /api/admin/ai/config/services                         the services and their internal URLs
 *   GET    /api/admin/ai/config/:service                         every config namespace of that service
 *   GET    /api/admin/ai/config/:service/:namespace              one namespace (common.config-namespace@1)
 *   GET    /api/admin/ai/config/:service/:namespace/history      its revisions
 *   POST   /api/admin/ai/config/:service/:namespace              apply common.config-change@1
 *   POST   /api/admin/ai/config/:service/:namespace/rollback     roll back to a revision
 *   PUT    /api/admin/ai/config/:service/:namespace/secrets/:key set a secret (common.config-secret-put@1)
 *   DELETE /api/admin/ai/config/:service/:namespace/secrets/:key remove a secret
 *   POST   /api/admin/ai/config/:service/:namespace/test/:key    the service tries the stored value (Setup's Test)
 *   GET|POST /api/admin/ai/config/providers                      AI's provider registry (ai.provider.manage)
 *   PATCH  /api/admin/ai/config/providers/:key                   one provider
 *   PUT|DELETE /api/admin/ai/config/providers/:key/key           its write-only key (bound to the provider origin)
 *
 * Every route is owner only. Each call goes to the service's /internal/config with Network's own service token for
 * openvibe.<service> and the matching <service>.config.manage capability; the owner's usr_ id travels in
 * X-OV-Subject, the way Network already vouches for a person to Bot (server/registry/machines.js). A secret write, or
 * a change to a key whose schema says x-danger, needs the session's auth_time within ten minutes; otherwise the answer
 * is 403 config.fresh_required and the panel sends the owner through sign-in and back to /admin#ai. When fresh,
 * X-OV-Fresh: 1 goes to the service.
 *
 * Network keeps no value: the body is forwarded and dropped, never written to a table or a log, and the audit row
 * names only the service, namespace, key, action and revision. Every secret write and every danger change raises an
 * operator alert, again with names and never a value. A test keeps its outcome as an ai_config_test audit row (the
 * service's one-line answer, which openvibe-shared scrubs of every secret, and a one-way digest of what it tried),
 * so the owner's Setup tab (server/admin/setup.js) can say "Not working" after a reload; the Audit tab redacts it
 * for anyone but the owner, like every config row.
 *
 * test/ai-config-proxy.test.js
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const { requireOwner } = require('../auth/owner-guard');
const { reauthUrl } = require('../auth/reauth');
const alerts = require('../operator/alerts');
const { isFreshSignIn } = require('../identity/reauth');

// The nine AI Exchange services (D11), then every other service that holds an owner input (the Setup tab,
// 2026-11-07). A service that has not mounted openvibe-shared/config's routes yet answers 404 or does not answer;
// the panel says it "has not published settings yet".
const SERVICES = ['ai', 'billing', 'services', 'watch', 'bench', 'report', 'host', 'codes', 'actor',
    'chat', 'connect', 'deals', 'work', 'sources', 'design', 'domains', 'media', 'run', 'mail'];
const LABELS = {
    ai: 'OpenVibe.AI', billing: 'OpenVibe.Billing', services: 'OpenVibe.Services', watch: 'OpenVibe.Watch',
    bench: 'OpenVibe.Bench', report: 'OpenVibe.Report', host: 'OpenVibe.Host', codes: 'OpenVibe.Codes',
    actor: 'OpenVibe.Actor', chat: 'OpenVibe.Chat', connect: 'OpenVibe Connect', deals: 'OpenVibe.Deals',
    work: 'OpenVibe.Work', sources: 'OpenVibe.Sources', design: 'OpenVibe.Design', domains: 'OpenVibe.Domains',
    media: 'OpenVibe.Media', run: 'OpenVibe.Run', mail: 'OpenVibe.Mail',
};
const TEST_TIMEOUT_MS = 20000;   // the service gives its tester 15 s; this leaves it time to answer
const TEST_MESSAGE_MAX = 300;
const FRESH_S = 10 * 60;
const WRITES_PER_HOUR = 60;
const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const NAMESPACE_RE = /^[a-z][a-z0-9-]{1,39}(\.[a-z0-9_-]+)+$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const ACCESS = new Set(['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED']);
const SECRET_FIELDS = new Set(['api_key', 'secret', 'token', 'password', 'client_secret', 'access_token', 'authorization']);

/** A refusal this proxy owns (the upstream's own refusals are relayed with their body). */
class ProxyError extends Error {
    constructor(status, code, detail, extra = {}) {
        super(detail);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

const label = (service) => LABELS[service] || `OpenVibe.${String(service || '').replace(/^./, (c) => c.toUpperCase())}`;
const jsonType = (type) => /^application\/([a-z.+-]+\+)?json\b/i.test(String(type || ''));

function signInUrl(config = {}) {
    const base = String(config.baseUrl || config.loginUrl || 'https://openvibe.network').replace(/\/+$/, '');
    const login = String(config.loginUrl || base).replace(/\/+$/, '');
    return reauthUrl(login, `${base}/admin#ai`);
}

/** The session's real sign-in time, the OIDC auth_time Network's signToken puts on every session token. The rule is
 * reauth's isFreshSignIn (auth_time within ten minutes, never a renewal and never a QR session carrying an
 * old source time), so the owner settings and the email and Locker checks use the same policy. */
function isFresh(req, now = Date.now()) {
    return isFreshSignIn(req.tokenClaims, now);
}

/** The x-danger annotation of a key, from the namespace schema. */
function dangerOf(summary, key) {
    const props = summary && summary.schema && summary.schema.properties;
    return !!(props && props[key] && props[key]['x-danger']);
}

/** A safe provider row: no value-looking field ever leaves this proxy, even if AI one day returns one by mistake. */
function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const out = {};
    for (const [k, v] of Object.entries(p)) {
        if (SECRET_FIELDS.has(k.toLowerCase())) continue;
        out[k] = v;
    }
    const access = String(out.provider_access || (out.metadata && out.metadata.provider_access) || 'UNVERIFIED').toUpperCase();
    out.provider_access = ACCESS.has(access) ? access : 'UNVERIFIED';
    return out;
}

/** Replace a secret value anywhere in a string-shaped answer (a service must never echo it; if one does, it stops here). */
function redact(value, secret) {
    if (!secret || String(secret).length < 4) return value;
    if (typeof value === 'string') return value.split(String(secret)).join('[redacted]');
    if (Array.isArray(value)) return value.map((v) => redact(v, secret));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, secret)]));
    return value;
}

/**
 * A service's summary as common.config-namespace@1 reads it. The pinned-keys member is accepted as the object the
 * first 4.110 builds returned and normalised to the contract's array; `kek` and `secrets` are carried beside the
 * validated summary (the tab's vault row needs the KEK id) but are not part of it.
 */
/** The four-character hint, the date and the fingerprint of each secret: what Setup shows ("••••a1b2 · set 3 Nov"). */
function secretMarkers(secrets) {
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return {};
    const out = {};
    for (const [key, m] of Object.entries(secrets)) {
        if (!KEY_RE.test(key) || !m || typeof m !== 'object') continue;
        out[key] = {
            hint: typeof m.hint === 'string' && m.hint.length <= 4 ? m.hint : null,
            set_at: typeof m.set_at === 'string' ? m.set_at.slice(0, 40) : null,
            fingerprint: typeof m.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(m.fingerprint) ? m.fingerprint : null,
            bound_to: typeof m.bound_to === 'string' ? m.bound_to.slice(0, 200) : null,
        };
    }
    return out;
}

/**
 * A one-way digest of the value a test tried: of the secret's marker fingerprint, or of a plain value. A later change
 * to that key gives another digest, so an old failure stops counting; the digest is neither the value nor its marker.
 */
function triedDigest(service, namespace, key, value, marker) {
    const fp = (marker && marker.fingerprint) || (value && typeof value === 'object' && value.redacted === true ? value.fingerprint : null);
    const what = fp ? `secret:${fp}` : `value:${JSON.stringify(value === undefined ? null : value)}`;
    return crypto.createHash('sha256').update(`ov-setup-test|${service}|${namespace}|${key}|${what}`).digest('hex').slice(0, 32);
}

/** What a namespace answer carries beside the validated summary: env names of pins and the secrets' markers. */
function extrasOf(extra) {
    const out = {};
    if (extra.pin_env) out.pin_env = extra.pin_env;
    const markers = secretMarkers(extra.secrets);
    if (Object.keys(markers).length) out.secret_markers = markers;
    return out;
}

function normaliseSummary(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { summary: raw, extra: {} };
    const summary = { ...raw };
    const extra = {};
    if (summary.pins && !Array.isArray(summary.pins) && typeof summary.pins === 'object') {
        extra.pin_env = Object.fromEntries(Object.entries(summary.pins).map(([k, p]) => [k, p && (p.env || p.name) || null]));
        summary.pins = Object.keys(summary.pins);
    }
    if (summary.kek !== undefined) { extra.kek = summary.kek; delete summary.kek; }
    if (summary.secrets !== undefined) { extra.secrets = summary.secrets; delete summary.secrets; }
    // A response from before 4.110 has no sealed/pins/schema. It is not this contract's answer: keeping the tab empty
    // is the honest state, and the UI says the service has not adopted the settings store yet.
    return { summary, extra };
}

/**
 * The one outbound call site of the owner settings (the proxy below and the Setup tab, server/admin/setup.js): a
 * service internal URL from operator config, a fixed /internal or /api path, Network's own token for openvibe.<service>
 * and the owner's usr_ id in X-OV-Subject.
 */
function createServiceCaller(opts = {}) {
    const log = opts.log || console;
    const state = (req) => ({
        db: opts.db || req.app.locals.db,
        services: opts.services || (req.app.locals.config && req.app.locals.config.services) || {},
        selfToken: opts.selfToken || req.app.locals.selfToken,
        notificationService: opts.notificationService || req.app.locals.notificationService,
        config: opts.config || req.app.locals.config || {},
    });

    async function callService(req, service, pathName, { method = 'GET', body = null, cap = `${service}.config.manage`, fresh = false, secret = null, timeout = 8000 } = {}) {
        const st = state(req);
        const entry = st.services && st.services[service];
        const base = entry && entry.internalUrl;
        if (!base) throw new ProxyError(503, 'config.service_unavailable', `${label(service)} is not configured`);
        let token = null;
        try { token = typeof st.selfToken === 'function' ? st.selfToken((entry && entry.audience) || `openvibe.${service}`, [cap]) : null; } catch { token = null; }
        if (!token) throw new ProxyError(503, 'config.token_unavailable', `Network cannot mint a token for ${label(service)}`);
        const subject = String((req.user && req.user.subject_id) || '');
        if (!SUBJECT_RE.test(subject)) throw new ProxyError(403, 'config.actor_required', 'the owner has no usr_ subject');
        const headers = { accept: 'application/json', authorization: `Bearer ${token}`, 'x-ov-subject': subject };
        if (fresh) headers['x-ov-fresh'] = '1';
        if (body !== null) headers['content-type'] = 'application/json';
        let upstream;
        try {
            upstream = await fetch(`${String(base).replace(/\/+$/, '')}${pathName}`, {
                method,
                headers,
                redirect: 'error',   // a service's answer is the answer: never follow it to another address
                ...(body !== null ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(timeout),
            });
        } catch (err) {
            // The message can carry the URL; it never carries a body.
            log.warn(`[AiConfig] ${service} ${method} ${pathName}: ${err && err.name === 'TimeoutError' ? 'timed out' : 'did not answer'}`);
            throw new ProxyError(502, 'config.service_unavailable', `${label(service)} did not answer`);
        }
        const type = upstream.headers.get('content-type') || '';
        const text = await upstream.text();
        let answer = null;
        if (text) {
            if (jsonType(type)) { try { answer = JSON.parse(text); } catch { answer = null; } }
            if (answer === null) answer = { error: text.slice(0, 500) };
        }
        return { status: upstream.status, answer: secret ? redact(answer, secret) : answer };
    }

    /**
     * Every namespace of one service, validated as common.config-namespace@1: { answered, namespaces, warnings, vault }.
     * A service that is not reachable, or has no /internal/config yet, is { answered: false, status, detail }.
     */
    async function serviceNamespaces(req, service, { timeout = 8000 } = {}) {
        let out;
        try { out = await callService(req, service, '/internal/config', { timeout }); } catch (err) {
            if (err instanceof ProxyError) return { answered: false, status: err.status, code: err.code, detail: err.message };
            throw err;
        }
        if (out.status < 200 || out.status >= 300) {
            const a = out.answer && typeof out.answer === 'object' ? out.answer : {};
            return { answered: false, status: out.status, code: a.code || 'config.service_refused', detail: a.detail || a.error || `${label(service)} answered ${out.status}` };
        }
        const raw = out.answer && Array.isArray(out.answer.namespaces) ? out.answer.namespaces : [];
        const namespaces = [];
        const warnings = [];
        let vault = null;
        for (const item of raw) {
            const { summary, extra } = normaliseSummary(item);
            const checked = contracts.validate('common.config-namespace@1', summary);
            if (!checked.valid || summary.service !== service) {
                warnings.push({ service, namespace: summary && typeof summary.namespace === 'string' ? summary.namespace : null, reason: 'invalid-summary', detail: checked.valid ? `the summary is for ${summary.service}` : checked.errors.slice(0, 4).map((e) => `${e.path} ${e.message}`).join('; ') });
                continue;
            }
            namespaces.push({ ...summary, ...extrasOf(extra) });
            if (vault === null && typeof summary.sealed === 'boolean') vault = { sealed: summary.sealed, kek: extra.kek !== undefined ? extra.kek : null };
        }
        return { answered: true, namespaces, warnings, vault: vault || { sealed: null, kek: null } };
    }

    return { state, callService, serviceNamespaces };
}

function createAiConfigProxy(opts = {}) {
    const r = express.Router();
    const log = opts.log || console;
    const now = opts.now || (() => Date.now());
    const writesPerHour = opts.writesPerHour || Number(process.env.AI_CONFIG_WRITES_PER_HOUR) || WRITES_PER_HOUR;
    const { state, callService, serviceNamespaces } = createServiceCaller(opts);

    // Owner only on every route, even if a caller mounts this router without its own guard.
    r.use(requireOwner);

    // 60 writes an hour for the owner: a person cannot accidentally (or maliciously) rewrite the platform's settings
    // faster than that. Reads are not limited; the response says how long to wait.
    r.use(rateLimit({
        windowMs: 60 * 60 * 1000,
        limit: writesPerHour,
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method),
        keyGenerator: (req) => `ai-config:${req.user && req.user.id != null ? req.user.id : req.ip}`,
        handler: (_req, res) => send(res, 429, { ok: false, error: 'Too many settings changes this hour. Try again later.', code: 'config.rate_limited' }),
    }));

    function send(res, status, body) {
        res.set('Cache-Control', 'no-store');
        return res.status(status).json(body);
    }
    function fail(res, err) {
        if (err instanceof ProxyError) return send(res, err.status, { ok: false, error: err.message, code: err.code, ...err.extra });
        log.error(`[AiConfig] ${err && err.message ? err.message.split('\n')[0].slice(0, 200) : 'failed'}`);
        return send(res, 500, { ok: false, error: 'The settings request failed', code: 'config.internal' });
    }
    const upstreamFailed = (res, service, out) => {
        const answer = out.answer && typeof out.answer === 'object' ? out.answer : {};
        return send(res, out.status, {
            ok: false,
            error: answer.detail || answer.error || `${label(service)} refused the change`,
            code: answer.code || 'config.service_refused',
            ...(answer.errors ? { errors: answer.errors } : {}),
        });
    };

    /** The audit row: names, revision and action only — never a value, never a reason that could hold one. */
    async function audit(req, { service, namespace, keys, action, revision = null }) {
        const st = state(req);
        if (!st.db || !req.user) return;
        const list = [...new Set((keys || []).filter(Boolean))];
        const details = { service, namespace, action, revision, keys: list, ...(list.length === 1 ? { key: list[0] } : {}) };
        try {
            await st.db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
                .run(req.user.id, 'ai_config_change', JSON.stringify(details));
        } catch (err) {
            log.warn(`[AiConfig] audit row failed: ${err.message}`);
        }
    }

    /** A test's outcome, for the Setup tab: names, the one-line answer and what was tried; never a value. */
    async function recordTest(req, details) {
        const st = state(req);
        if (!st.db || !req.user) return;
        try {
            await st.db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
                .run(req.user.id, 'ai_config_test', JSON.stringify(details));
        } catch (err) {
            log.warn(`[AiConfig] test row failed: ${err.message}`);
        }
    }

    /**
     * One operator alert per change, for the owner and OPERATOR_ALERT_USERNAMES: the same notification type Host's
     * alerts use, so it reaches the bell and web push and no block hides it. It names the service, namespace, key,
     * action and actor; a value is never in it.
     */
    async function announce(req, { service, namespace, keys, action }) {
        const st = state(req);
        if (!st.notificationService || typeof st.notificationService.create !== 'function' || !st.db) return;
        const who = req.user && req.user.username ? req.user.username : String((req.user && req.user.subject_id) || 'owner');
        const list = [...new Set((keys || []).filter(Boolean))];
        const message = `${label(service)} · ${namespace} · ${list.join(', ')} · ${action} by @${who}`.slice(0, 500);
        let users = [];
        try { users = await alerts.operatorUserIds(st.db); } catch { users = []; }
        for (const uid of users) {
            try {
                await st.notificationService.create({
                    user_id: uid, type: 'OPERATOR_ALERT', category: 'admin', service: 'network', priority: 'high',
                    icon: '⚠️', silent: false, title: `AI settings changed: ${label(service)}`.slice(0, 120), message,
                    rich_content: { kind: 'ai_config_change', service, namespace, keys: list, action, actor: req.user && req.user.subject_id || null },
                });
            } catch (err) {
                log.warn(`[AiConfig] operator alert failed: ${err.message}`);
            }
        }
    }

    const namespaceOf = (req, service) => {
        const ns = String(req.params.namespace || '');
        if (!NAMESPACE_RE.test(ns) || !ns.startsWith(`${service}.`)) {
            throw new ProxyError(404, 'config.namespace_not_found', `no configuration namespace ${ns || '(none)'} for ${label(service)}`);
        }
        return ns;
    };
    const serviceOf = (req) => {
        const service = String(req.params.service || '');
        if (!SERVICES.includes(service)) throw new ProxyError(404, 'config.service_not_found', 'no such service');
        return service;
    };
    const keyOf = (req) => {
        const key = String(req.params.key || '');
        if (!KEY_RE.test(key)) throw new ProxyError(400, 'config.bad_request', 'that is not a configuration key');
        return key;
    };

    // ── The services (the owner's tab lists each one and its vault state) ──
    r.get('/services', (req, res) => {
        const st = state(req);
        const out = SERVICES.map((service) => {
            const entry = st.services && st.services[service] || {};
            return { service, name: label(service), internal_url: entry.internalUrl || null, capability: `${service}.config.manage` };
        });
        send(res, 200, { ok: true, services: out });
    });

    r.get('/compute/status', async (req, res) => {
        try {
            const out = await callService(req, 'run', '/internal/config/compute-status');
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, 'run', out);
            send(res, 200, { ok: true, compute: out.answer });
        } catch (err) { fail(res, err); }
    });

    // ── AI's provider registry (its own admin API, ai.provider.manage) ──
    const providerPath = (suffix = '') => `/api/v1/providers${suffix}`;
    async function providerCall(req, method, pathName, body = null, { fresh = false, secret = null } = {}) {
        return await callService(req, 'ai', pathName, { method, body, cap: 'ai.provider.manage', fresh, secret });
    }
    // ── The owner's inference configuration (AI's console read models, owner only here) ──
    // Reads ride on ai.usage.read at AI (the same gate the console section uses); writes ride on
    // ai.provider.manage. Nothing here carries a key: AI stores keys itself (vault) and answers
    // with key presence and hints only; the proxy strips any secret-looking field it sees.
    const ownerInfPath = (suffix = '') => `/api/v1/admin/console/owner-inference${suffix}`;
    async function ownerInfCall(req, method, pathName, body = null, { cap = 'ai.provider.manage' } = {}) {
        return await callService(req, 'ai', pathName, { method, body, cap });
    }

    r.get('/owner-inference', async (req, res) => {
        try {
            const out = await ownerInfCall(req, 'GET', ownerInfPath(), null, { cap: 'ai.usage.read' });
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, 'ai', out);
            send(res, 200, { ok: true, config: out.answer });
        } catch (err) { fail(res, err); }
    });

    for (const [path, aiPath, action] of [
        ['/owner-inference/spend-caps', '/spend-caps', 'provider.spend_cap'],
        ['/owner-inference/routing', '/routing', 'owner_routing.update'],
        ['/owner-inference/economy', '/economy', 'owner_economy.update'],
        ['/owner-inference/providers', '/providers', 'provider.control'],
        ['/owner-inference/rules', '/rules', 'owner_inference.rules'],
        ['/owner-inference/endpoint', '/endpoint', 'provider.endpoint'],
    ]) {
        r.post(path, async (req, res) => {
            try {
                const body = req.body && typeof req.body === 'object' ? req.body : {};
                if (body.api_key !== undefined || body.secret !== undefined) throw new ProxyError(422, 'config.secret_write_only', 'send the key to its own write-only route, never here');
                const out = await ownerInfCall(req, 'POST', ownerInfPath(aiPath), body);
                if (out.status < 200 || out.status >= 300) return upstreamFailed(res, 'ai', out);
                const key = String(body.provider_key || body.capability || 'owner-inference');
                await audit(req, { service: 'ai', namespace: 'ai.owner-inference', keys: [key], action, revision: null });
                send(res, 200, { ok: true, config: out.answer });
            } catch (err) { fail(res, err); }
        });
    }

    // The confirmed readings bundled with the AI release enter the price book as pending changes; the owner
    // accepts each one in the price book, never here.
    r.post('/owner-inference/pricebook/propose', async (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const proposals = Array.isArray(body.proposals) ? body.proposals : [];
            if (!proposals.length) throw new ProxyError(422, 'config.invalid', 'no confirmed readings to propose');
            const out = await callService(req, 'ai', '/api/v1/admin/console/pricebook/proposals', { method: 'POST', body: { proposals }, cap: 'ai.provider.manage' });
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, 'ai', out);
            await audit(req, { service: 'ai', namespace: 'ai.pricebook', keys: ['proposals'], action: 'price_changes.proposed', revision: null });
            send(res, 200, { ok: true, result: out.answer });
        } catch (err) { fail(res, err); }
    });

    r.get('/providers', async (req, res, next) => {
        try {
            const out = await providerCall(req, 'GET', providerPath());
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, 'ai', out);
            const list = Array.isArray(out.answer && out.answer.providers) ? out.answer.providers.map(sanitizeProvider) : [];
            send(res, 200, { ok: true, providers: list });
        } catch (err) { fail(res, err); }
    });

    r.post('/providers', async (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            if (!body.key) throw new ProxyError(400, 'config.bad_request', 'a provider needs a key');
            if (body.api_key !== undefined || body.secret !== undefined) throw new ProxyError(422, 'config.secret_write_only', 'send the key to its own write-only route, never here');
            const out = await providerCall(req, 'POST', providerPath(), body);
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, 'ai', out);
            await audit(req, { service: 'ai', namespace: 'ai.providers', keys: [body.key], action: 'provider.create', revision: null });
            send(res, out.status, { ok: true, provider: sanitizeProvider(out.answer && out.answer.provider) });
        } catch (err) { fail(res, err); }
    });

    r.patch('/providers/:key', async (req, res) => {
        try {
            const key = keyOf(req);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            if (body.api_key !== undefined || body.secret !== undefined) throw new ProxyError(422, 'config.secret_write_only', 'send the key to its own write-only route, never here');
            const out = await providerCall(req, 'PATCH', providerPath(`/${encodeURIComponent(key)}`), body);
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, 'ai', out);
            await audit(req, { service: 'ai', namespace: 'ai.providers', keys: [key], action: 'provider.update', revision: null });
            send(res, 200, { ok: true, provider: sanitizeProvider(out.answer && out.answer.provider) });
        } catch (err) { fail(res, err); }
    });

    /** A provider key: AI's ai.provider_keys namespace (secret, bound to the provider's origin) and its secret_ref. */
    async function providerSecret(req, res, action) {
        const key = keyOf(req);
        const st = state(req);
        if (!isFresh(req, now())) {
            return send(res, 403, {
                ok: false, error: "Confirm it's you to change keys and money settings", code: 'config.fresh_required',
                sign_in_url: signInUrl(st.config),
            });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        if (action === 'put' && (typeof body.value !== 'string' || !body.value)) {
            throw new ProxyError(400, 'config.bad_request', 'the key is empty');
        }
        const secret = action === 'put' ? body.value : null;
        const out = await callService(req, 'ai', `/internal/config/ai.provider_keys/secrets/${encodeURIComponent(key)}`, {
            method: action === 'put' ? 'PUT' : 'DELETE',
            body: action === 'put' ? { value: body.value, reason: String(body.reason || 'provider key from the admin panel').slice(0, 500) } : { reason: String(body.reason || 'provider key removed from the admin panel').slice(0, 500) },
            fresh: true, secret,
        });
        if (out.status < 200 || out.status >= 300) return upstreamFailed(res, 'ai', out);
        // The provider now reads that namespace instead of env:NAME (or stops reading one).
        const patch = await providerCall(req, 'PATCH', providerPath(`/${encodeURIComponent(key)}`), { secret_ref: action === 'put' ? `vault:${key}` : null });
        if (patch.status < 200 || patch.status >= 300) return upstreamFailed(res, 'ai', patch);
        await audit(req, { service: 'ai', namespace: 'ai.provider_keys', keys: [key], action: action === 'put' ? 'secret.put' : 'secret.delete', revision: out.answer && out.answer.revision });
        await announce(req, { service: 'ai', namespace: 'ai.provider_keys', keys: [key], action: action === 'put' ? 'secret.put' : 'secret.delete' });
        send(res, 200, { ok: true, marker: out.answer });
    }

    r.put('/providers/:key/key', async (req, res) => { try { await providerSecret(req, res, 'put'); } catch (err) { fail(res, err); } });
    r.delete('/providers/:key/key', async (req, res) => { try { await providerSecret(req, res, 'delete'); } catch (err) { fail(res, err); } });

    // ── A service's configuration namespaces ──
    async function listNamespaces(req, res) {
        try {
            const service = serviceOf(req);
            const got = await serviceNamespaces(req, service);
            if (!got.answered) {
                return send(res, got.status >= 400 ? got.status : 502, { ok: false, error: got.detail, code: got.code });
            }
            send(res, 200, { ok: true, service, namespaces: got.namespaces, warnings: got.warnings, vault: got.vault });
        } catch (err) { fail(res, err); }
    }
    // The service called "services" would collide with GET /services (the list of services) if it were asked for as
    // /services, so the list of its namespaces is at /service/services. Every other service works at both.
    r.get('/service/:service', listNamespaces);
    r.get('/:service', listNamespaces);

    r.get('/:service/:namespace', async (req, res) => {
        try {
            const service = serviceOf(req);
            const namespace = namespaceOf(req, service);
            const out = await callService(req, service, `/internal/config/${encodeURIComponent(namespace)}`);
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, service, out);
            const { summary, extra } = normaliseSummary(out.answer);
            const checked = contracts.validate('common.config-namespace@1', summary);
            if (!checked.valid || summary.service !== service || summary.namespace !== namespace) {
                return send(res, 200, {
                    ok: true, service, namespace: null,
                    warnings: [{ service, namespace, reason: 'invalid-summary', detail: checked.valid ? 'the summary names another namespace' : checked.errors.slice(0, 4).map((e) => `${e.path} ${e.message}`).join('; ') }],
                    vault: { sealed: null, kek: null },
                });
            }
            send(res, 200, { ok: true, service, namespace: { ...summary, ...extrasOf(extra) }, warnings: [], vault: { sealed: summary.sealed, kek: extra.kek !== undefined ? extra.kek : null } });
        } catch (err) { fail(res, err); }
    });

    r.get('/:service/:namespace/history', async (req, res) => {
        try {
            const service = serviceOf(req);
            const namespace = namespaceOf(req, service);
            const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            const out = await callService(req, service, `/internal/config/${encodeURIComponent(namespace)}/history${q}`);
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, service, out);
            send(res, out.status, out.answer);
        } catch (err) { fail(res, err); }
    });

    r.post('/:service/:namespace/rollback', async (req, res) => {
        try {
            const service = serviceOf(req);
            const namespace = namespaceOf(req, service);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const out = await callService(req, service, `/internal/config/${encodeURIComponent(namespace)}/rollback`, { method: 'POST', body });
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, service, out);
            const revision = out.answer && Number.isInteger(out.answer.revision) ? out.answer.revision : null;
            await audit(req, { service, namespace, keys: [], action: 'config.rollback', revision });
            send(res, out.status, out.answer);
        } catch (err) { fail(res, err); }
    });

    r.post('/:service/:namespace', async (req, res) => {
        try {
            const service = serviceOf(req);
            const namespace = namespaceOf(req, service);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const checked = contracts.validate('common.config-change@1', body);
            if (!checked.valid) throw new ProxyError(400, 'config.bad_request', 'the change is not valid', { errors: checked.errors.slice(0, 8) });

            // The schema and classification decide what is dangerous and what may never travel through POST.
            const current = await callService(req, service, `/internal/config/${encodeURIComponent(namespace)}`);
            if (current.status < 200 || current.status >= 300) return upstreamFailed(res, service, current);
            const { summary } = normaliseSummary(current.answer);
            if (!summary || summary.namespace !== namespace || !summary.schema) {
                return send(res, 502, {
                    ok: false, error: `${label(service)} did not answer with a usable settings summary`, code: 'config.invalid_summary',
                    warnings: [{ service, namespace, reason: 'invalid-summary', detail: 'the service did not return this namespace\'s schema' }],
                });
            }
            const props = summary.schema.properties || {};
            const touched = body.merge === true ? [...new Set([...Object.keys(body.values || {}), ...((body.unset) || [])])] : Object.keys(props);
            const classification = summary.classification || {};
            const secretKeys = touched.filter((k) => classification[k] === 'secret');
            if (secretKeys.length) {
                throw new ProxyError(422, 'config.secret_write_only', `${secretKeys.join(', ')} ${secretKeys.length === 1 ? 'is a secret' : 'are secrets'}: use the write-only secret route`);
            }
            const danger = touched.filter((k) => dangerOf(summary, k));
            if (danger.length && !isFresh(req, now())) {
                return send(res, 403, {
                    ok: false, error: "Confirm it's you to change keys and money settings", code: 'config.fresh_required',
                    sign_in_url: signInUrl(state(req).config),
                });
            }
            const out = await callService(req, service, `/internal/config/${encodeURIComponent(namespace)}`, {
                method: 'POST', body, fresh: danger.length > 0,
            });
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, service, out);
            const revision = out.answer && Number.isInteger(out.answer.revision) ? out.answer.revision : null;
            await audit(req, { service, namespace, keys: touched, action: 'config.change', revision });
            if (danger.length) await announce(req, { service, namespace, keys: danger, action: 'config.danger_change' });
            send(res, out.status, out.answer);
        } catch (err) { fail(res, err); }
    });

    /**
     * Setup's Test: the service's tester tries the stored value with the provider (openvibe-shared 4.125.0's test hook)
     * and answers { ok, message } in one line. The outcome is kept as an audit row with a digest of what was tried
     * (triedDigest), so a later change to that key makes it stale. No fresh sign-in:
     * a test changes nothing and shows nothing of the value. It counts against the hourly write allowance.
     */
    r.post('/:service/:namespace/test/:key', async (req, res) => {
        try {
            const service = serviceOf(req);
            const namespace = namespaceOf(req, service);
            const key = keyOf(req);
            let tried = null;
            const current = await callService(req, service, `/internal/config/${encodeURIComponent(namespace)}`);
            if (current.status >= 200 && current.status < 300) {
                const { summary, extra } = normaliseSummary(current.answer);
                const value = summary && summary.values ? summary.values[key] : undefined;
                tried = triedDigest(service, namespace, key, value, secretMarkers(extra.secrets)[key]);
            }
            const out = await callService(req, service, `/internal/config/${encodeURIComponent(namespace)}/test/${encodeURIComponent(key)}`, {
                method: 'POST', body: {}, timeout: TEST_TIMEOUT_MS,
            });
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, service, out);
            const answer = out.answer && typeof out.answer === 'object' ? out.answer : {};
            const passed = answer.ok === true;
            const message = String(answer.message == null ? '' : answer.message).replace(/\s+/g, ' ').trim().slice(0, TEST_MESSAGE_MAX)
                || (passed ? 'It works.' : 'It did not work.');
            const testedAt = new Date(now()).toISOString();
            await recordTest(req, { service, namespace, key, passed, message, tried, tested_at: testedAt });
            send(res, 200, { ok: true, passed, message, tested_at: testedAt });
        } catch (err) { fail(res, err); }
    });

    r.put('/:service/:namespace/secrets/:key', async (req, res) => {
        try {
            const service = serviceOf(req);
            const namespace = namespaceOf(req, service);
            const key = keyOf(req);
            if (!isFresh(req, now())) {
                return send(res, 403, {
                    ok: false, error: "Confirm it's you to change keys and money settings", code: 'config.fresh_required',
                    sign_in_url: signInUrl(state(req).config),
                });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const checked = contracts.validate('common.config-secret-put@1', body);
            if (!checked.valid) throw new ProxyError(400, 'config.bad_request', 'the secret is not valid', { errors: checked.errors.slice(0, 8) });
            const out = await callService(req, service, `/internal/config/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(key)}`, {
                method: 'PUT', body, fresh: true, secret: body.value,
            });
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, service, out);
            await audit(req, { service, namespace, keys: [key], action: 'secret.put', revision: null });
            await announce(req, { service, namespace, keys: [key], action: 'secret.put' });
            send(res, out.status, out.answer);
        } catch (err) { fail(res, err); }
    });

    r.delete('/:service/:namespace/secrets/:key', async (req, res) => {
        try {
            const service = serviceOf(req);
            const namespace = namespaceOf(req, service);
            const key = keyOf(req);
            if (!isFresh(req, now())) {
                return send(res, 403, {
                    ok: false, error: "Confirm it's you to change keys and money settings", code: 'config.fresh_required',
                    sign_in_url: signInUrl(state(req).config),
                });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const out = await callService(req, service, `/internal/config/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(key)}`, {
                method: 'DELETE', body: { reason: String(body.reason || 'removed from the admin panel').slice(0, 500) }, fresh: true,
            });
            if (out.status < 200 || out.status >= 300) return upstreamFailed(res, service, out);
            await audit(req, { service, namespace, keys: [key], action: 'secret.delete', revision: null });
            await announce(req, { service, namespace, keys: [key], action: 'secret.delete' });
            send(res, out.status, out.answer);
        } catch (err) { fail(res, err); }
    });

    return r;
}

module.exports = {
    createAiConfigProxy, createServiceCaller, SERVICES, LABELS, label, FRESH_S, WRITES_PER_HOUR, signInUrl, isFresh, dangerOf,
    normaliseSummary, secretMarkers, triedDigest, sanitizeProvider, redact, ProxyError,
};
