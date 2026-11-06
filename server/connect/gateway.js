'use strict';
/**
 * The gateway (Compute plan E7): one person's agents act in the person's other apps through here.
 *
 * Every call goes through the same five steps, in this order:
 *
 *   1. the grant: what this caller may do in this app (read, or read and write);
 *   2. the schema: the input is checked against the action's JSON Schema;
 *   3. the request: the fixed request of the definition, to the app's fixed API host only, through
 *      the egress guard, with the credential from the vault and nothing from the input;
 *   4. the answer: redacted, so nothing that looks like a secret leaves;
 *   5. the log: who, which action, when, and whether it worked. The input of a write action is never
 *      written.
 *
 * A send, a delete and a pay action asks the person first, whatever the grant says (server/connect/
 * approvals.js). The limits (120 calls a minute for one person in one app, and a daily cap) are
 * checked before anything is sent.
 */
const vault = require('./vault');
const callers = require('./callers');
const approvals = require('./approvals');
const egress = require('./egress');
const redact = require('./redact');
const schema = require('./schema');
const registry = require('./apps');
const { newId } = require('./ids');

const ASK_FIRST = ['send', 'delete', 'pay'];
const USER_AGENT = 'OpenVibe-Connect/1.0';

class GatewayError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail || code; }
}
const fail = (status, code, detail) => { throw new GatewayError(status, code, detail); };

const nowIso = () => new Date().toISOString();

/** The app and the action behind one action name ('github.issue.create'). */
function findAction(defs, name) {
    for (const def of defs) {
        if (!name.startsWith(def.key + '.')) continue;
        const action = (def.actions || []).find((a) => a.name === name);
        if (action) return { def, action };
    }
    return null;
}

/** The names of the input fields the action knows about. */
const fieldNames = (action) => Object.keys((action.input && action.input.properties) || {});

/** A path: '{owner}' becomes the value of owner, encoded for a path. */
function interpolatePath(template, input, names) {
    const path = String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name) => {
        if (!names.includes(name)) return whole;
        const value = input[name];
        if (value === undefined || value === null || value === '') fail(422, 'connect.invalid_input', `${name} is missing`);
        if (String(value) === '.' || String(value) === '..') fail(422, 'connect.invalid_input', `${name} may not be "." or ".."`);
        return encodeURIComponent(String(value));
    });
    if (/\{[a-zA-Z0-9_]+\}/.test(path)) {
        const missing = /\{([a-zA-Z0-9_]+)\}/.exec(path);
        if (missing && names.includes(missing[1])) fail(422, 'connect.invalid_input', `${missing[1]} is missing`);
    }
    return path;
}

/** A value from the input: '{name}' alone keeps its type, inside a string it becomes text. */
function interpolate(value, input, names, depth = 0) {
    if (depth > 8) return value;
    if (typeof value === 'string') {
        const whole = /^\{([a-zA-Z0-9_]+)\}$/.exec(value);
        if (whole && names.includes(whole[1])) {
            const v = input[whole[1]];
            return v === undefined ? undefined : v;
        }
        return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole2, name) => {
            if (!names.includes(name)) return whole2;
            const v = input[name];
            return v === undefined || v === null ? '' : String(v);
        });
    }
    if (Array.isArray(value)) return value.map((v) => interpolate(v, input, names, depth + 1)).filter((v) => v !== undefined);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const next = interpolate(v, input, names, depth + 1);
            if (next !== undefined) out[k] = next;
        }
        return out;
    }
    return value;
}

/** The request of one action: the definition's fixed request, with the input put in its place. */
function buildRequest(def, action, input, credentials) {
    const names = fieldNames(action);
    const req = action.request;
    const path = interpolatePath(req.path, input, names);
    const query = interpolate(req.query || {}, input, names) || {};
    const bodyValue = interpolate(req.body, input, names);
    const headers = Object.assign({}, def.headers || {}, {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
    });
    if (bodyValue !== undefined && bodyValue !== null && !(typeof bodyValue === 'object' && !Object.keys(bodyValue).length)) {
        headers['Content-Type'] = 'application/json';
    }
    for (const field of def.auth.fields || []) {
        const value = credentials[field.name];
        if (!value) fail(409, 'connect.no_credential', `the credential for ${def.name} is missing`);
        if (field.where === 'header') headers[field.header] = field.scheme ? `${field.scheme} ${value}` : value;
        else if (field.where === 'query') query[field.param] = value;
        else fail(500, 'connect.bad_definition', 'a credential has no place to go');
    }
    const body = bodyValue === undefined || bodyValue === null ? null : JSON.stringify(bodyValue);
    return { method: req.method, path, query, headers, body };
}

/** The credential of every field an app needs, opened from the vault. */
async function credentialsFor(db, def, subject, config) {
    const out = {};
    for (const field of def.auth.fields || []) {
        const value = await vault.open(db, subject, def.key, field.name, { config });
        if (!value) return null;   // the app is not connected (or a field is missing)
        out[field.name] = value;
    }
    return out;
}

/** The apps this person has connected: every field of the app is there. */
async function connectedApps(db, subject, defs, config) {
    const out = [];
    for (const def of defs) {
        if (!def.auth.fields || !def.auth.fields.length) continue;   // a BYOK link holds nothing here
        const creds = await credentialsFor(db, def, subject, config);
        if (creds) out.push(def);
    }
    return out;
}

function createGateway({ db, config, defs = null, limiter = null, approvalWaitMs = approvals.DEFAULT_WAIT_MS, defaultRequestOptions = null } = {}) {
    const catalogue = defs || registry.all();

    /** The actions this caller may use: the apps this person connected and this caller was granted. */
    async function listActions({ subject, callerId }) {
        const grants = await callers.grantsOf(db, callerId);
        const connected = await connectedApps(db, subject, catalogue, config);
        const tools = [];
        for (const def of connected) {
            const level = grants[def.key];
            if (!level) continue;   // no grant: this caller sees nothing of this app
            for (const action of def.actions || []) {
                if (action.risk !== 'read' && level !== 'write') continue;
                tools.push({
                    name: action.name,
                    description: action.description || action.title || action.name,
                    inputSchema: action.input,
                    risk: action.risk,
                    app: def.key,
                });
            }
        }
        return tools;
    }

    /** The log: who, which action, when, and whether it worked. */
    async function writeLog({ subject, callerId, callerName, app, action, risk, ok, status = null, errorCode = null, input = null, at = nowIso() }) {
        // The input of a write action is never written.
        const kept = risk === 'read' && input ? JSON.stringify(input).slice(0, 2000) : null;
        await db.prepare(`INSERT INTO connect_log (id, subject, caller_id, caller_name, app, action, risk, ok, status, error_code, input, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(newId('clg'), subject, callerId, String(callerName || '').slice(0, 100), app, action, risk, ok ? 1 : 0, status, errorCode, kept, at);
    }

    /** The log of this person, newest first. */
    async function listLog({ subject, limit = 100 }) {
        const rows = await db.prepare('SELECT * FROM connect_log WHERE subject = ? ORDER BY created_at DESC LIMIT ?').all(subject, Math.min(Number(limit) || 100, 500));
        return rows.map((r) => ({
            id: r.id, caller_id: r.caller_id, caller_name: r.caller_name, app: r.app, action: r.action,
            risk: r.risk, ok: Number(r.ok) === 1, status: r.status, error_code: r.error_code, created_at: r.created_at,
        }));
    }

    /**
     * One call. → { app, action, status, data } or throws a GatewayError.
     */
    async function call({ subject, callerId, callerName, actionName, input = {}, requestOptions: perCall = {} }) {
        const requestOptions = Object.assign({}, defaultRequestOptions || {}, perCall || {});
        const found = findAction(catalogue, String(actionName || ''));
        if (!found) fail(404, 'connect.unknown_action', 'no such action');
        const { def, action } = found;

        // 1. the grant
        const level = await callers.grantOf(db, callerId, def.key);
        const needed = action.risk === 'read' ? 'read' : 'write';
        if (!level || (needed === 'write' && level !== 'write')) {
            fail(403, 'connect.not_granted', `${callerName || 'this caller'} may not ${action.name}`);
        }

        // 2. the schema
        const check = schema.validate(action.input, input);
        if (!check.valid) fail(422, 'connect.invalid_input', schema.describe(check));

        // the limits
        if (limiter) {
            const limit = await limiter.check(db, subject, def.key);
            if (!limit.ok) {
                await writeLog({ subject, callerId, callerName, app: def.key, action: action.name, risk: action.risk, ok: false, status: 429, errorCode: limit.code });
                const err = new GatewayError(429, limit.code, limit.code === 'connect.rate_limited' ? 'too many calls for this app in this minute' : 'the daily cap for this app is reached');
                err.retryAfter = limit.retryAfter;
                throw err;
            }
        }

        // send, delete and pay ask first
        let approval = null;
        if (ASK_FIRST.includes(action.risk)) {
            const rules = await approvals.rulesOf(db, subject);
            if (!rules.has(`${def.key}.${action.name}`)) {
                approval = await approvals.request(db, {
                    subject, callerId, app: def.key, action: action.name,
                    summary: approvals.summaryOf(def, action, input), input,
                });
                const decided = await approvals.wait(db, approval.id, { timeoutMs: approvalWaitMs });
                if (decided.state !== 'approved') {
                    await writeLog({ subject, callerId, callerName, app: def.key, action: action.name, risk: action.risk, ok: false, status: 403, errorCode: decided.state === 'denied' ? 'connect.approval_denied' : 'connect.approval_required' });
                    fail(403, decided.state === 'denied' ? 'connect.approval_denied' : 'connect.approval_required',
                        decided.state === 'denied' ? 'the person said no' : 'the person has not approved this one');
                }
            }
        }

        // 3. the request
        const credentials = await credentialsFor(db, def, subject, config);
        if (!credentials) fail(409, 'connect.not_connected', `${def.name} is not connected`);
        const built = buildRequest(def, action, input, credentials);
        if (limiter) await limiter.record(db, subject, def.key);

        let res;
        try {
            res = await egress.request(def, { ...built, ...requestOptions });
        } catch (e) {
            const status = e.status || 502;
            await writeLog({ subject, callerId, callerName, app: def.key, action: action.name, risk: action.risk, ok: false, status, errorCode: e.code || 'connect.request_failed' });
            if (e instanceof GatewayError) throw e;
            throw new GatewayError(status, e.code || 'connect.request_failed', e.message);
        }

        // 4. the answer, redacted
        let data = res.body;
        try { data = JSON.parse(res.body); } catch { /* not JSON: the text stands */ }
        const safe = redact.redact(data, Object.values(credentials));

        if (res.status >= 400) {
            await writeLog({ subject, callerId, callerName, app: def.key, action: action.name, risk: action.risk, ok: false, status: res.status, errorCode: 'connect.app_error' });
            const err = new GatewayError(502, 'connect.app_error', `${def.name} answered ${res.status}`);
            err.appStatus = res.status;
            err.data = safe;
            throw err;
        }

        // 5. the log
        await writeLog({ subject, callerId, callerName, app: def.key, action: action.name, risk: action.risk, ok: true, status: res.status, input });
        await callers.touch(db, callerId);
        return { app: def.key, action: action.name, risk: action.risk, status: res.status, data: safe };
    }

    /**
     * The walkthrough's test call: it uses the credential the person is about to paste, and it is made
     * before anything is stored. A refused test call stores nothing.
     */
    async function test({ subject, appKey, credential, label = 'default', requestOptions: perCall = {} }) {
        const requestOptions = Object.assign({}, defaultRequestOptions || {}, perCall || {});
        const def = catalogue.find((d) => d.key === appKey);
        if (!def) fail(404, 'connect.unknown_app', 'no such app');
        if (!def.test) fail(400, 'connect.no_test_call', 'this app has no test call');
        const fields = def.auth.fields || [];
        const credentials = {};
        for (const field of fields) {
            if (field.name === 'default') credentials[field.name] = credential;
            else credentials[field.name] = credential && credential[field.name] ? credential[field.name] : null;
        }
        for (const [name, value] of Object.entries(credentials)) {
            if (!value) fail(422, 'connect.invalid_credential', `the ${name} is missing`);
        }
        const names = [];
        const built = buildRequest({ ...def, actions: [] }, { input: { properties: {} }, request: def.test }, {}, credentials);
        const res = await egress.request(def, { ...built, ...requestOptions });
        let data = res.body;
        try { data = JSON.parse(res.body); } catch { /* the text stands */ }
        const safe = redact.redact(data, Object.values(credentials));
        if (res.status >= 400) {
            const err = new GatewayError(400, 'connect.test_failed', `${def.name} answered ${res.status}: the credential was refused`);
            err.appStatus = res.status;
            err.data = safe;
            throw err;
        }
        return { ok: true, status: res.status, data: safe, summary: def.test.summary || null };
    }

    return { call, test, listActions, listLog, connectedApps, writeLog, catalogue };
}

module.exports = { createGateway, findAction, buildRequest, interpolate, interpolatePath, GatewayError, ASK_FIRST };
