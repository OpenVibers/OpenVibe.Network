'use strict';
/**
 * The owner's Setup tab (OWNER-SETUP-AND-ADMIN-CLARITY-DESIGN, 2026-11-07, section 1): one checklist of everything
 * only the owner can give the network — keys, accounts, caps — and the few things to do elsewhere (legal
 * registrations, DNSSEC at the registrar, a provider top-up).
 *
 *   GET  /api/admin/setup                 every row, grouped, Needed first, with the counted summary
 *   POST /api/admin/setup/tasks/:key      { done } marks one of Network's own to-dos done (or not done)
 *
 * Owner only on every route. Setup holds no value: a key row is a field of the owning service's config namespace
 * that carries x-owner-input (openvibe-shared 4.125.0), read through the owner settings proxy's caller
 * (server/admin/ai-config-proxy.js) with Network's token and the owner in X-OV-Subject. Saving, removing and testing
 * a key go through that proxy's routes, with its fresh sign-in rule, vault, audit and alerts. The state of a row:
 *   Needed       unset, and x-required-for names what waits on it
 *   Not working  set, and its last test (an ai_config_test audit row for the value set now) failed
 *   Connected    set, and not failing (tested and passed, or not tested yet); a to-do marked done
 *   Optional     unset, and nothing waits on it
 * The to-dos are Network's own namespace, network.setup (openvibe-shared/config), so marking one done is a revision
 * with its actor, history and rollback like any other setting.
 *
 * test/setup.test.js
 */
const express = require('express');
const config = require('openvibe-shared/config');
const { requireOwner } = require('../auth/owner-guard');
const siteConfig = require('./site-config');
const { createServiceCaller, SERVICES, label, triedDigest } = require('./ai-config-proxy');

const NAMESPACE = 'network.setup';
const LIST_TIMEOUT_MS = 4000;
const TESTS_READ = 1000;
const STATES = ['needed', 'not_working', 'connected', 'optional'];
const STATE_RANK = Object.fromEntries(STATES.map((s, i) => [s, i]));
// The groups and their order come with openvibe-shared (config.OWNER_INPUT_GROUPS, 4.125.0). The same list is here
// for a Network still pinned to an older release; a row with a group neither knows lands in "Other".
const GROUPS = config.OWNER_INPUT_GROUPS || Object.freeze({
    money: 'Money', 'ai-providers': 'AI providers', gpus: 'GPUs', voices: 'Voices', 'chat-apps': 'Chat apps',
    'sign-in-apps': 'Sign-in apps', 'data-sources': 'Data sources', 'design-publishing': 'Design and publishing',
    domains: 'Domains', email: 'Email', legal: 'Legal and registrations',
});
const GROUP_IDS = Object.keys(GROUPS);
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

const DONE = Object.freeze({
    type: ['object', 'null'],
    additionalProperties: false,
    properties: {
        done_at: { type: 'string', maxLength: 40, title: 'Done on', description: 'When the owner marked it done, as an ISO date and time.' },
        done_by: { type: 'string', maxLength: 80, title: 'Done by', description: 'The username of the person who marked it done (the owner).' },
    },
});
const task = (title, description, ownerInput, requiredFor) => ({
    ...DONE, title, description, 'x-owner-input': ownerInput, ...(requiredFor ? { 'x-required-for': requiredFor } : {}),
});

/**
 * Network's own to-dos: things only the owner can do, somewhere else, that have no key to store. Each value is
 * { done_at, done_by } once marked done.
 */
const TASKS_SCHEMA = Object.freeze({
    title: 'Owner to-dos',
    description: 'Things only the owner can do outside OpenVibe, with no key to keep: registrations, records at the registrar and top-ups. Mark one done when it is.',
    type: 'object',
    additionalProperties: false,
    properties: {
        provider_topup: task('Top up the prepaid AI balances',
            'Some AI providers run on a prepaid balance. When one runs out, OpenVibe pauses that provider and uses the next one. Mark it done after a top-up.',
            { group: 'money', unlocks: 'Keeps the AI providers that run on a prepaid balance answering.', get_it_at: 'https://openvibe.exchange/console/providers', get_it_how: 'Open Providers in the AI console, see which balance is low, and top it up on that provider\'s own site.' }),
        dnssec_records: task('Add the DNSSEC records at the registrar',
            'Signs OpenVibe\'s domains so nobody can answer for them with false addresses. Cloudflare makes one DS record per domain; it works once the registrar has it.',
            { group: 'domains', unlocks: 'Protects every OpenVibe domain from forged DNS answers.', get_it_at: 'https://developers.cloudflare.com/dns/dnssec/', get_it_how: 'Turn on DNSSEC for each domain in Cloudflare (DNS, then Settings), then copy its DS record to the registrar.' }),
        ncmec_registration: task('Register with NCMEC\'s CyberTipline',
            'Registers OpenVibe as a service that reports child sexual abuse material to NCMEC, which US law asks of any site people upload to. Mark it done once NCMEC confirms.',
            { group: 'legal', unlocks: 'Lets OpenVibe report child abuse imagery to the authorities, as the law requires.', get_it_at: 'https://www.missingkids.org/gethelpnow/cybertipline', get_it_how: 'Follow the link for electronic service providers and ask for an ESP account for OpenVibe.' },
            'Reporting abuse imagery as US law requires'),
        csam_scanning: task('Turn on CSAM scanning',
            'Cloudflare compares every image OpenVibe serves with known child abuse imagery and tells you when one matches. It needs the NCMEC registration; nothing changes for people.',
            { group: 'legal', unlocks: 'Finds known child abuse imagery among the pictures OpenVibe serves, so it can be removed and reported.', get_it_at: 'https://developers.cloudflare.com/cache/reference/csam-scanning/', get_it_how: 'In the Cloudflare dashboard open Caching, then Configuration, and turn on the CSAM Scanning Tool with the email NCMEC has.' },
            'Finding known abuse imagery'),
        dmca_agent: task('Name a DMCA agent',
            'Registers the person who receives copyright takedown notices with the US Copyright Office. Without it, OpenVibe can lose the protection the law gives it for what people upload.',
            { group: 'legal', unlocks: 'Keeps OpenVibe protected when someone uploads what they do not own.', get_it_at: 'https://dmca.copyright.gov/osp/', get_it_how: 'Make an account, register OpenVibe as a service provider and name the agent. It costs $6 and is renewed every three years.' },
            'Safe harbour for what people upload'),
        public_suffix_list: task('Add people\'s site domain to the Public Suffix List',
            'Tells browsers that each subdomain where a person\'s own site lives belongs to someone different, so one person\'s site can never read another\'s cookies.',
            { group: 'legal', unlocks: 'Keeps people\'s own sites from reading each other\'s cookies in every browser.', get_it_at: 'https://github.com/publicsuffix/list/wiki/Guidelines', get_it_how: 'Open a pull request to the list\'s private section and add the _psl TXT record it asks for at the registrar.' }),
    },
});

const byDb = new WeakMap();
/** Network's own to-do store (openvibe-shared/config, namespace network.setup), one per database handle. */
async function tasksStore(db, log = console) {
    if (byDb.has(db)) return byDb.get(db);
    const ready = config.createConfigStore({
        db, service: 'network', namespace: NAMESPACE, schema: TASKS_SCHEMA,
        log: { info: () => {}, warn: (m) => (log.warn || log.log || (() => {})).call(log, `[Setup] ${m}`), error: (m) => (log.error || log.warn || (() => {})).call(log, `[Setup] ${m}`) },
    });
    byDb.set(db, ready);
    try { return await ready; } catch (err) { byDb.delete(db); throw err; }
}

const isSet = (value, secret) => {
    if (secret) return !!(value && typeof value === 'object' && value.redacted === true && typeof value.fingerprint === 'string');
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
};
const groupOf = (g) => (GROUP_IDS.includes(g) ? g : 'other');
const groupLabel = (g) => (g === 'other' ? 'Other' : GROUPS[g]);
const text = (v, max = 500) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const httpsUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };
const day = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };

/** The latest test of each key (an ai_config_test audit row), newest first wins. */
async function latestTests(db) {
    const out = new Map();
    let rows = [];
    try {
        rows = await db.prepare("SELECT details, created_at FROM audit_log WHERE action = 'ai_config_test' ORDER BY id DESC LIMIT ?").all(TESTS_READ);
    } catch { rows = []; }
    for (const r of rows) {
        let d;
        try { d = JSON.parse(r.details); } catch { continue; }
        if (!d || typeof d !== 'object') continue;
        const id = `${d.service}|${d.namespace}|${d.key}`;
        if (out.has(id)) continue;
        out.set(id, {
            passed: d.passed === true, message: text(d.message, 300), at: text(d.tested_at, 40) || (r.created_at ? new Date(r.created_at).toISOString() : null),
            tried: typeof d.tried === 'string' ? d.tried : null,
        });
    }
    return out;
}

/**
 * Whether a key is a secret. The summary classifies every schema property from openvibe-shared 4.125.0; a service on
 * an older release leaves an unset key out, and then a bound key, a writeOnly one or a key/token/secret/password name
 * is taken for a secret, so its value goes to the write-only route rather than a plain field.
 */
function isSecretKey(ns, key, prop) {
    const cls = ns.classification ? ns.classification[key] : undefined;
    if (cls) return cls === 'secret';
    return typeof prop['x-bind'] === 'string' || prop.writeOnly === true || /(^|[._-])(api_?key|key|token|secret|password)$/i.test(key);
}

/** One key row from a field with x-owner-input. */
function keyRow(service, ns, key, prop, tests) {
    const owner = prop['x-owner-input'];
    const secret = isSecretKey(ns, key, prop);
    const pinned = Array.isArray(ns.pins) && ns.pins.includes(key);
    const pinEnv = pinned && ns.pin_env ? ns.pin_env[key] || null : null;
    const value = ns.values ? ns.values[key] : undefined;
    const marker = ns.secret_markers ? ns.secret_markers[key] : null;
    const set = isSet(value, secret);
    const types = [].concat(prop.type || 'string');
    const type = types.find((t) => t !== 'null') || 'string';
    let test = tests.get(`${service}|${ns.namespace}|${key}`) || null;
    // A test is about the value it tried: once that key holds another value, its old answer no longer counts.
    if (test && set && test.tried && test.tried !== triedDigest(service, ns.namespace, key, value, marker)) test = null;
    if (!set) test = null;
    const requiredFor = text(prop['x-required-for'], 200) || null;
    // A switch with a default is On or Off already: it never "needs" the owner (Chat's channel switches default to On and
    // were listed as waiting, 11-14).
    const byDefault = !set && type === 'boolean' && typeof prop.default === 'boolean';
    let state;
    if (byDefault) state = 'connected';
    else if (!set) state = requiredFor ? 'needed' : 'optional';
    else if (test && !test.passed) state = 'not_working';
    else state = 'connected';
    return {
        id: `${service}/${ns.namespace}/${key}`, kind: 'key', service, service_name: label(service), namespace: ns.namespace, key,
        group: groupOf(owner.group), title: text(prop.title, 120) || key, description: text(prop.description, 600),
        unlocks: text(owner.unlocks, 300), get_it_at: httpsUrl(owner.get_it_at), get_it_how: text(owner.get_it_how, 300) || null,
        required_for: requiredFor, testable: owner.test === true, secret, type, unit: text(prop['x-unit'], 20) || null,
        example: secret ? null : (['string', 'number', 'boolean'].includes(typeof prop['x-example']) ? prop['x-example'] : null),
        danger: prop['x-danger'] === true, pinned, pin_env: pinEnv,
        set, hint: marker && marker.hint ? marker.hint : null, set_at: day(marker && marker.set_at),
        value: byDefault ? prop.default : !secret && set && ['string', 'number', 'boolean'].includes(typeof value) ? value : null,
        by_default: byDefault,
        state, last_test: test ? { passed: test.passed, message: test.message, at: test.at } : null,
    };
}

/**
 * Why a service's settings could not be read, in words an owner can act on (11-14, the owner: "what do you mean
 * connect? This doesn't explain").
 */
function whyDown(a) {
    const name = label(a.service);
    const status = Number(a.status) || 0;
    if (status === 401) return `${name} did not accept Network's sign-in for it (401). Its token audience or signing key differs from what Network sends; it needs a fix on the server, not a key from you.`;
    if (status === 403) return `${name} answered, but Network's token lacks the right to manage its settings (403, ${a.code || 'capability denied'}).`;
    if (status === 404) return `${name} is running but has no owner settings yet (404): there is nothing to set up there.`;
    if (status === 503 && a.code === 'config.service_unavailable') return `Network has no address for ${name}.`;
    if (status === 502) return `${name} is not running or did not answer in time.`;
    return `${name} answered ${status || 'nothing'}${a.detail ? `: ${String(a.detail).slice(0, 160)}` : ''}.`;
}

/** One of Network's own to-dos. */
function taskRow(key, prop, value) {
    const owner = prop['x-owner-input'];
    const done = value && typeof value === 'object' && value.done_at ? { at: day(value.done_at), by: text(value.done_by, 80) || null } : null;
    const requiredFor = text(prop['x-required-for'], 200) || null;
    return {
        id: `network/${NAMESPACE}/${key}`, kind: 'task', service: 'network', service_name: 'OpenVibe.Network', namespace: NAMESPACE, key,
        group: groupOf(owner.group), title: prop.title, description: prop.description, unlocks: owner.unlocks,
        get_it_at: httpsUrl(owner.get_it_at), get_it_how: owner.get_it_how || null, required_for: requiredFor,
        testable: false, secret: false, set: !!done, done, state: done ? 'connected' : requiredFor ? 'needed' : 'optional', last_test: null,
    };
}

const byState = (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]
    || (GROUP_IDS.indexOf(a.group) + 1 || 99) - (GROUP_IDS.indexOf(b.group) + 1 || 99)
    || a.service_name.localeCompare(b.service_name) || a.title.localeCompare(b.title);

/**
 * The checklist: rows sorted Needed, Not working, Connected, Optional; groups ordered by their most urgent row
 * (so the page opens on what needs the owner), then by the design's order. The counts add up to the rows.
 */
function checklist(rows) {
    const sorted = [...rows].sort(byState);
    const counts = { needed: 0, not_working: 0, connected: 0, optional: 0, total: rows.length };
    for (const r of rows) counts[r.state] += 1;
    const groups = new Map();
    for (const r of sorted) {
        if (!groups.has(r.group)) groups.set(r.group, { id: r.group, label: groupLabel(r.group), rows: [], counts: { needed: 0, not_working: 0, connected: 0, optional: 0 } });
        const g = groups.get(r.group);
        g.rows.push(r);
        g.counts[r.state] += 1;
    }
    const rank = (g) => Math.min(...g.rows.map((r) => STATE_RANK[r.state]));
    const order = (id) => (GROUP_IDS.indexOf(id) + 1) || 99;
    const list = [...groups.values()].sort((a, b) => rank(a) - rank(b) || order(a.id) - order(b.id));
    const empty = GROUP_IDS.filter((id) => !groups.has(id)).map((id) => ({ id, label: GROUPS[id] }));
    return { rows: sorted, groups: list, empty_groups: empty, counts };
}

function createSetupRoutes(opts = {}) {
    const r = express.Router();
    const log = opts.log || console;
    const now = opts.now || (() => Date.now());
    const caller = createServiceCaller(opts);
    r.use(requireOwner);

    const send = (res, status, body) => { res.set('Cache-Control', 'no-store'); return res.status(status).json(body); };
    const dbOf = (req) => opts.db || req.app.locals.db;

    r.get('/', async (req, res) => {
        try {
            const db = dbOf(req);
            const services = opts.services || SERVICES;
            const [answers, tests, store] = await Promise.all([
                Promise.all(services.map(async (service) => {
                    try { return { service, ...(await caller.serviceNamespaces(req, service, { timeout: LIST_TIMEOUT_MS })) }; } catch (err) {
                        log.warn(`[Setup] ${service}: ${err && err.message ? String(err.message).split('\n')[0].slice(0, 160) : 'failed'}`);
                        return { service, answered: false, detail: `${label(service)} did not answer` };
                    }
                })),
                latestTests(db),
                tasksStore(db, log),
            ]);
            const rows = [];
            const reach = [];
            for (const a of answers) {
                let count = 0;
                for (const ns of a.answered ? a.namespaces : []) {
                    const props = ns.schema && ns.schema.properties && typeof ns.schema.properties === 'object' ? ns.schema.properties : {};
                    for (const [key, prop] of Object.entries(props)) {
                        if (!prop || typeof prop !== 'object' || !prop['x-owner-input'] || typeof prop['x-owner-input'] !== 'object') continue;
                        rows.push(keyRow(a.service, ns, key, prop, tests));
                        count += 1;
                    }
                }
                reach.push({
                    service: a.service, name: label(a.service), answered: !!a.answered,
                    ...(a.answered ? {} : { status: Number(a.status) || null, code: a.code || null, why: whyDown(a) }),
                    namespaces: a.answered ? a.namespaces.length : 0, rows: count,
                    // In plain words, as the AI tab says it: a service that has no settings to show yet.
                    note: !a.answered || !a.namespaces.length ? `${label(a.service)} has not published settings yet.` : (count ? null : `${label(a.service)} asks nothing of you yet.`),
                });
            }
            const values = store.get();
            for (const [key, prop] of Object.entries(TASKS_SCHEMA.properties)) rows.push(taskRow(key, prop, values[key]));
            send(res, 200, { ok: true, generated_at: new Date(now()).toISOString(), ...checklist(rows), services: reach });
        } catch (err) {
            log.error(`[Setup] ${err && err.message ? String(err.message).split('\n')[0].slice(0, 200) : 'failed'}`);
            send(res, 500, { ok: false, error: 'Setup could not be read', code: 'setup.internal' });
        }
    });

    r.post('/tasks/:key', async (req, res) => {
        try {
            const key = String(req.params.key || '');
            if (!KEY_RE.test(key) || !Object.prototype.hasOwnProperty.call(TASKS_SCHEMA.properties, key)) return send(res, 404, { ok: false, error: 'No such to-do', code: 'setup.task_not_found' });
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            if (typeof body.done !== 'boolean') return send(res, 400, { ok: false, error: 'Say done: true or false', code: 'setup.bad_request' });
            const db = dbOf(req);
            const store = await tasksStore(db, log);
            const actor = siteConfig.actorOf(req.user);
            const title = TASKS_SCHEMA.properties[key].title;
            if (!body.done && store.get(key) == null) return send(res, 200, { ok: true, row: taskRow(key, TASKS_SCHEMA.properties[key], null) });
            const snap = body.done
                ? await store.apply({ [key]: { done_at: new Date(now()).toISOString(), done_by: String(req.user.username || '').slice(0, 80) } }, { merge: true, actor, reason: `Marked done: ${title}` })
                : await store.apply({}, { merge: true, unset: [key], actor, reason: `Marked not done: ${title}` });
            try {
                await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
                    .run(req.user.id, 'setup_task', JSON.stringify({ key, done: body.done, revision: snap && snap.revision }));
            } catch (err) { log.warn(`[Setup] audit row failed: ${err.message}`); }
            send(res, 200, { ok: true, row: taskRow(key, TASKS_SCHEMA.properties[key], store.get(key)) });
        } catch (err) {
            log.error(`[Setup] ${err && err.message ? String(err.message).split('\n')[0].slice(0, 200) : 'failed'}`);
            send(res, 500, { ok: false, error: 'The to-do could not be saved', code: 'setup.internal' });
        }
    });

    return r;
}

module.exports = { createSetupRoutes, checklist, keyRow, taskRow, isSecretKey, tasksStore, latestTests, TASKS_SCHEMA, NAMESPACE, GROUPS, STATES };
