'use strict';
/**
 * The machines hub (plan L34, step M2): a person's machines on openvibe.network/machines.
 *
 * Bot stays the registry of the machines. Network fronts it: every route here calls Bot's machines API as the
 * person (with a service token of Network's own, naming the person in X-OV-Subject), so Bot checks that the
 * machine is that person's own and answers as the authority it is. Nothing of the machine is stored here.
 *
 *   GET    /api/v1/machines             network.machines.read   → { machines: [machine] }
 *   GET    /api/v1/machines/roles       network.machines.read   → { roles: [role] }          (the catalogue)
 *   GET    /api/v1/machines/:id         network.machines.read   → { machine }
 *   POST   /api/v1/machines/pairings    network.machines.manage → 201 { pairing }
 *   PATCH  /api/v1/machines/:id         network.machines.manage → { machine }                (a new name)
 *   PUT    /api/v1/machines/:id/roles   network.machines.manage → { machine }                (the whole set)
 *   POST   /api/v1/machines/:id/revoke  network.machines.manage → { machine }
 *   POST   /internal/machines/status    network.node.manage    → 202                        (Bot's report)
 *
 * Who may call: the person, with their own session; or an app holding the capability with the person's
 * consent — the token names the person in on_behalf_of, and the person's grant for the capability must still be
 * approved. A machine that is not that person's is not there at all (404, never 403), so nobody can probe whose
 * machine an id is.
 *
 * The events (through OpenVibe.Events, server/developer/event-relay.js): network.machine.online and
 * .offline (Bot's report of a machine's state, once per change), .paired (the machine redeemed its code),
 * .roles_changed and .revoked (the person's own changes).
 */
const express = require('express');
const crypto = require('crypto');
const { capabilities, http, ids, serviceAuth, validate } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');

const READ = 'network.machines.read';
const MANAGE = 'network.machines.manage';
/** The capability Network holds at Bot: it acts for a person, and Bot checks the machine is that person's. */
const BOT_CAP = 'bot.machine.manage';
const SELF_AUDIENCE = 'openvibe.network';
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MACHINE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const PRINCIPAL = /^nod_[0-9A-HJKMNP-TV-Z]{26}$/;
const KINDS = new Set(['onboard', 'bridge', 'server']);
const TOKEN_TTL_S = 300;

/**
 * The catalogue of machine roles while the pinned contracts are older than 0.258.0. Keep it in step with the
 * products' manifests (registry.service-manifest@1's machineRoles), which is where the catalogue lives from
 * that release on: each product declares the roles it installs, and the hub shows the union.
 */
const LOCAL_ROLES = [
    { id: 'codes.worker', name: 'Codes worker', installs: 'the Codes job runner (the coding agent and the job sandbox)', shows: 'Runs your coding jobs, such as a task you start on openvibe.codes.' },
    { id: 'desks.host', name: 'Desk host', installs: 'the desk sandbox (a private browser desk for every session)', shows: "Hosts desks for agents, yours and other people's." },
    { id: 'ai.host', name: 'AI host', installs: "the local model server (Ollama, LM Studio) as OpenVibe Node's ai plugin", shows: 'Serves your own AI models, on your own machine.' },
    { id: 'bot.robot', name: 'Robot', installs: 'the robot drivers the profile asks for', shows: 'Drives a robot, and takes its commands.' },
];

/** The roles the products declare (Contracts 0.258.0), or the local copy while the pin is older. */
function catalogue() {
    let declared = [];
    try {
        const contracts = require('openvibe-contracts');
        declared = (contracts.services.manifests || []).flatMap((m) => (Array.isArray(m.machineRoles) ? m.machineRoles : []));
    } catch { /* the catalogue is the local copy */ }
    return declared.length ? declared : LOCAL_ROLES;
}

/** The role ids, in the catalogue's order. */
const roleIds = () => catalogue().map((r) => r.id);

/** Whether the catalogue has that role. */
const isKnownRole = (id) => roleIds().includes(String(id || ''));

/**
 * The roles of a request, checked: a list of ids, each in the catalogue. A role outside it is refused here as
 * well as by Bot, so the person is told before anything is called. → the ids, or null when one is unknown.
 */
function normaliseRoles(list) {
    if (!Array.isArray(list)) return null;
    const want = roleIds();
    const out = [];
    for (const raw of list) {
        const id = String(raw || '');
        if (!want.includes(id)) return null;
        if (!out.includes(id)) out.push(id);
    }
    return want.filter((id) => out.includes(id));
}

/** One machine as the hub shows it (network.machine@1): what Bot said, and nothing else. */
function machineOf(m) {
    const out = {
        id: String(m.id || ''),
        kind: KINDS.has(m.kind) ? m.kind : 'onboard',
        online: m.online === true,
        roles: Array.isArray(m.roles) ? m.roles.filter((r) => typeof r === 'string') : [],
        running: Array.isArray(m.running) ? m.running : [],
    };
    if (typeof m.name === 'string' && m.name) out.name = m.name;
    if (typeof m.os === 'string' && m.os) out.os = m.os;
    if (typeof m.last_seen_at === 'string' && m.last_seen_at) out.last_seen_at = m.last_seen_at;
    if (typeof m.node_version === 'string' && m.node_version) out.node_version = m.node_version;
    if (typeof m.node_id === 'string' && PRINCIPAL.test(m.node_id)) out.principal_id = m.node_id;
    return out;
}

/**
 * Network's own service token for Bot: sub svc:network, audience openvibe.bot, cap bot.machine.manage. Network
 * is the token issuer, so it signs its own five-minute token instead of asking itself for one (the same way the
 * events relay publishes under svc:network).
 */
function createBotClient({ baseUrl, privateKey, issuer, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    let cached = null;
    function token() {
        const iat = Math.floor(now() / 1000);
        if (cached && cached.exp - 60 > iat) return cached.token;
        const claims = {
            iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.bot'], cap: [BOT_CAP],
            iat, exp: iat + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
        };
        cached = { token: serviceAuth.signServiceToken(claims, privateKey), exp: claims.exp };
        return cached.token;
    }
    /**
     * One call to Bot, as the person. Bot's own refusals are passed through (404 for a machine that is not the
     * person's, 422 for a role it does not know, 403 for a missing capability); anything else is an outage.
     */
    async function call(method, path, body, subject) {
        let res;
        try {
            res = await fetchImpl(`${baseUrl}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token()}`, Accept: 'application/json',
                    'X-OV-Subject': subject, ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(8000),
            });
        } catch (e) {
            throw Object.assign(new Error(`Bot did not answer for the machine: ${e.message}`), { status: 503, code: 'registry.bot_unavailable' });
        }
        const out = await res.json().catch(() => null);
        if (!res.ok || !out) {
            const code = (out && out.code) || 'registry.bot_unavailable';
            const status = res.status >= 400 && res.status < 600 ? res.status : 503;
            throw Object.assign(new Error((out && (out.detail || out.error)) || `Bot answered ${res.status}`), { status, code });
        }
        return out;
    }
    return {
        list: (subject) => call('GET', '/api/v1/machines', null, subject),
        get: (subject, id) => call('GET', `/api/v1/machines/${encodeURIComponent(id)}`, null, subject),
        rename: (subject, id, name) => call('PATCH', `/api/v1/machines/${encodeURIComponent(id)}`, { name }, subject),
        roles: (subject, id, roles) => call('PUT', `/api/v1/machines/${encodeURIComponent(id)}/roles`, { roles }, subject),
        revoke: (subject, id) => call('POST', `/api/v1/machines/${encodeURIComponent(id)}/revoke`, {}, subject),
        pairing: (subject) => call('POST', '/api/v1/machines/pairings', {}, subject),
    };
}

/** The problem a route answers with: the status and the code, in the estate's shape. */
class MachineError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/**
 * The event envelope for a machine event (events.event-envelope@1). Only the ids, the owner and when: never a
 * credential, a hash or an address.
 */
function envelope(type, { actor, subject, payload, at }) {
    return {
        event_id: ids.newId('event', Date.parse(at)), event_type: type, version: 1, source: 'network',
        actor, timestamp: at, visibility: 'internal', subject, payload,
    };
}

/**
 * Publish a machine event into the outbox (OpenVibe.Events). The payload contracts are Contracts 0.258.0; while
 * the pin is older they are written by hand and checked by the tests, and the contract check turns on with the pin.
 */
async function publish(db, type, { actor, subject, payload, at }) {
    const env = envelope(type, { actor, subject, payload, at });
    const v = validate('events.event-envelope@1', env);
    if (!v.valid) throw new Error(`machines: bad event ${JSON.stringify((v.errors || []).slice(0, 3))}`);
    await eventRelay.writerFor(db).enqueue(db, env);
    return env;
}

/**
 * The guard for a hub route: the person's own session, or a token that names a person and holds the capability.
 *
 * The capabilities network.machines.read and network.machines.manage are new in Contracts 0.258.0, which this
 * checkout does not pin yet, so the capability is checked by name (capabilities.grants is a plain string check)
 * and the token is verified here. When the pin moves, the contracts' own guard (principals.guard) takes over and
 * this one goes with it.
 */
function hubGuard(capability, { db, publicKey, issuer, requireAuth }) {
    return async function hubGuardMiddleware(req, res, next) {
        const auth = String(req.headers.authorization || '');
        if (auth.startsWith('Bearer ')) {
            // A service or app token (Network's own issuer signed it). Anything else — the person's own session
            // token, for one — is not one, and the session guard below decides.
            const r = serviceAuth.verifyServiceToken(auth.slice(7).trim(), { publicKey, issuer, audience: SELF_AUDIENCE });
            if (r.ok) {
                const claims = r.claims;
                if (!capabilities.grants(claims.cap || [], capability)) {
                    return http.sendProblem(res, 403, 'capability.denied', { detail: `${capability} not granted` });
                }
                const person = String(claims.on_behalf_of || '');
                if (!SUBJECT.test(person)) {
                    return http.sendProblem(res, 403, 'capability.owner_denied', { detail: 'the token names no person to act for' });
                }
                // The person's consent: an app's grant for this capability must still be approved. A service
                // token (a run token) holds its own grant, checked when it was minted.
                const appId = String(claims.sub || '').replace(/^app:/, '');
                if (claims.actor_type === 'app') {
                    const database = typeof db === 'function' ? db(req) : db;
                    const grant = await database.prepare('SELECT status FROM dev_grants WHERE app_id = ? AND capability = ?').get(appId, capability);
                    if (!grant || grant.status !== 'approved') {
                        return http.sendProblem(res, 403, 'capability.owner_denied', { detail: 'the person did not consent to this' });
                    }
                }
                req.hub = {
                    kind: claims.actor_type === 'app' ? 'app' : 'service',
                    sub: claims.sub,
                    subject: person,
                    actor: claims.actor_type === 'app'
                        ? { type: 'app', id: appId }
                        : { type: 'service', id: String(claims.sub || '').replace(/^svc:/, '') },
                };
                return next();
            }
        }
        return requireAuth(req, res, next);
    };
}

/**
 * The routes of the hub (plan L34, step M2).
 *
 *   bot          the client for Bot's machines API (createBotClient)
 *   requireAuth  the person's session guard
 *   publicKey    Network's public key (the app tokens are signed by Network)
 *   issuer       Network's issuer (the same string its tokens carry)
 */
function routers({ bot, requireAuth, publicKey, issuer, db = (req) => req.app.locals.db, now = () => Date.now() }) {
    const hub = express.Router();
    hub.use(http.middleware());
    const read = hubGuard(READ, { db, publicKey, issuer, requireAuth });
    const manage = hubGuard(MANAGE, { db, publicKey, issuer, requireAuth });

    /** The person the call acts for: the app's token names them, or the session is theirs. */
    async function subjectOf(req) {
        if (req.hub) return req.hub.subject;
        const { ensureUserSubject } = require('../identity/subjects');
        const sid = await ensureUserSubject(req.app.locals.db, req.user);
        if (!SUBJECT.test(String(sid || ''))) throw new MachineError(403, 'registry.guest', 'sign in with an account to see your machines');
        return sid;
    }
    /** Who changed it: the person, or the app that acts with their consent. */
    const actorOf = (req, subject) => (req.hub && req.hub.actor ? req.hub.actor : { type: 'user', id: subject });

    /**
     * The machine the route names. A machine's id is Bot's own (dev_ and 26 characters), so anything else never
     * reaches Bot: the hub answers as it answers for a machine that is not there.
     */
    const machineId = (req) => {
        const id = String((req.params && req.params.id) || '');
        if (!MACHINE.test(id)) throw new MachineError(404, 'registry.machine_not_found', 'there is no such machine');
        return id;
    };

    const send = async (res, fn) => {
        try { return await fn(); } catch (e) {
            if (e instanceof MachineError) return http.sendProblem(res, e.status, e.code, { detail: e.message });
            if (e && e.status && e.code) return http.sendProblem(res, e.status, e.code, { detail: e.message });
            console.error('[machines]', e.message);
            return http.sendProblem(res, 500, 'registry.failed', { detail: 'the machines could not be read or changed' });
        }
    };

    // The catalogue, so the page can show what a machine may do for the network.
    hub.get('/roles', read, async (req, res) => await send(res, async () => {
        res.set('Cache-Control', 'private, no-store');
        res.json({ roles: catalogue() });
    }));

    // The person's machines: Bot's list, as the hub shows them.
    hub.get('/', read, async (req, res) => await send(res, async () => {
        res.set('Cache-Control', 'private, no-store');
        const subject = await subjectOf(req);
        const out = await bot.list(subject);
        const machines = (out && Array.isArray(out.machines) ? out.machines : []).map(machineOf);
        res.json({ machines });
    }));

    hub.get('/:id', read, async (req, res) => await send(res, async () => {
        res.set('Cache-Control', 'private, no-store');
        const subject = await subjectOf(req);
        const out = await bot.get(subject, machineId(req));
        res.json({ machine: machineOf(out && out.machine) });
    }));

    // A one-time code to pair a machine with the person's account, and the command to run on it. The code is
    // shown once here and never again.
    hub.post('/pairings', manage, express.json({ limit: '8kb' }), async (req, res) => await send(res, async () => {
        res.set('Cache-Control', 'private, no-store');
        const subject = await subjectOf(req);
        const out = await bot.pairing(subject);
        const p = (out && out.pairing) || {};
        res.status(201).json({ pairing: {
            code: String(p.code || ''), expires_at: p.expires_at, installer: String(p.installer || ''),
            ...(p.pairing_id ? { pairing_id: p.pairing_id } : {}),
        } });
    }));

    // A new name for the machine.
    hub.patch('/:id', manage, express.json({ limit: '8kb' }), async (req, res) => await send(res, async () => {
        res.set('Cache-Control', 'private, no-store');
        const subject = await subjectOf(req);
        const name = typeof (req.body || {}).name === 'string' ? (req.body.name).trim().slice(0, 80) : '';
        if (!name) throw new MachineError(422, 'registry.invalid_machine_name', 'a name is 1 to 80 characters');
        const out = await bot.rename(subject, machineId(req), name);
        res.json({ machine: machineOf(out && out.machine) });
    }));

    // The machine's roles for the network: the whole set, not a change. A role outside the catalogue is refused.
    hub.put('/:id/roles', manage, express.json({ limit: '8kb' }), async (req, res) => await send(res, async () => {
        res.set('Cache-Control', 'private, no-store');
        const subject = await subjectOf(req);
        const roles = normaliseRoles((req.body || {}).roles);
        if (!roles) throw new MachineError(422, 'registry.unknown_role', 'that is not a machine role');
        const id = machineId(req);
        const out = await bot.roles(subject, id, roles);
        const machine = machineOf(out && out.machine);
        await publish(req.app.locals.db, 'network.machine.roles_changed', {
            actor: actorOf(req, subject),
            subject: { type: 'machine', id: machine.id },
            payload: { machine_id: machine.id, owner: subject, roles: machine.roles, at: new Date(now()).toISOString() },
            at: new Date(now()).toISOString(),
        });
        res.json({ machine });
    }));

    // The machine is no longer the person's: its credential dies at Bot, and its principal on Network with it.
    hub.post('/:id/revoke', manage, express.json({ limit: '8kb' }), async (req, res) => await send(res, async () => {
        res.set('Cache-Control', 'private, no-store');
        const subject = await subjectOf(req);
        const id = machineId(req);
        const out = await bot.revoke(subject, id);
        const machine = machineOf(out && out.machine);
        const at = new Date(now()).toISOString();
        const reason = typeof (req.body || {}).reason === 'string' ? (req.body.reason).trim().slice(0, 500) : '';
        await publish(req.app.locals.db, 'network.machine.revoked', {
            actor: actorOf(req, subject),
            subject: { type: 'machine', id: machine.id },
            payload: {
                machine_id: machine.id, owner: subject, at,
                ...(machine.principal_id ? { principal_id: machine.principal_id } : {}),
                ...(reason ? { reason } : {}),
            },
            at,
        });
        res.json({ machine });
    }));

    return { hub };
}

/**
 * Bot's report of a machine's state (POST /internal/machines/status, network.node.manage — the capability Bot
 * already holds for the pairing authority). Each change is published once as network.machine.online or
 * network.machine.offline; Bot reports a change, not a heartbeat, so the event says what changed.
 */
function internalRouters({ guard, now = () => Date.now() }) {
    const internal = express.Router();
    internal.post('/machines/status', guard, express.json({ limit: '8kb' }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const body = req.body || {};
        const machineId = String(body.machine_id || '');
        const owner = String(body.owner || '');
        if (!MACHINE.test(machineId) || !SUBJECT.test(owner)) {
            return http.sendProblem(res, 400, 'registry.invalid_machine_status', { detail: 'machine_id and owner are required' });
        }
        const at = new Date(now()).toISOString();
        const online = body.online === true;
        const payload = { machine_id: machineId, owner, at };
        if (PRINCIPAL.test(String(body.principal_id || ''))) payload.principal_id = String(body.principal_id);
        await publish(req.app.locals.db, online ? 'network.machine.online' : 'network.machine.offline', {
            actor: { type: 'service', id: 'bot' },
            subject: { type: 'machine', id: machineId },
            payload, at,
        });
        res.status(202).json({ ok: true });
    });
    return { internal };
}

module.exports = { catalogue, roleIds, isKnownRole, normaliseRoles, machineOf, createBotClient, hubGuard, routers, internalRouters, publish, READ, MANAGE, BOT_CAP, LOCAL_ROLES };
