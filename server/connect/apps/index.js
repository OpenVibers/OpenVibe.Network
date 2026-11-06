'use strict';
/**
 * The catalogue (phase 1): ten app definitions, one file each, loaded here.
 *
 * A definition says: the auth kind (what the person has to paste), the walkthrough with its links, the
 * test call, and the actions — each with a name, a JSON Schema for its input, a risk level and the
 * fixed request it makes. The API host is part of the definition: a request may only go to that host,
 * never to a host that came out of the input.
 *
 * New apps are new files and reviews (a changed file is a changed capability).
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const RISKS = ['read', 'write', 'send', 'delete', 'pay'];
const AUTH_KINDS = ['token', 'api_key', 'bot_token', 'byok_link'];

function loadDir(dir = DIR) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js').sort();
    const out = [];
    for (const file of files) {
        const def = require(path.join(dir, file));
        out.push(def);
    }
    return out;
}

/** The definition is checked when it is loaded: a mistake here is a mistake in a capability. */
function validateDefinition(def) {
    const problems = [];
    if (!def || typeof def !== 'object') return ['the definition is not an object'];
    if (!/^[a-z][a-z0-9_]*$/.test(String(def.key || ''))) problems.push('key must be a lowercase name');
    if (!def.name) problems.push('name is missing');
    if (!def.auth || !AUTH_KINDS.includes(def.auth.kind)) problems.push(`auth.kind must be one of ${AUTH_KINDS.join(', ')}`);
    if (!Array.isArray(def.walkthrough) || !def.walkthrough.length) problems.push('the walkthrough has no steps');
    for (const [i, step] of (def.walkthrough || []).entries()) {
        if (!step.title || !step.text) problems.push(`walkthrough step ${i + 1} has no title or text`);
        if (step.link && !/^https:\/\//.test(step.link)) problems.push(`walkthrough step ${i + 1} has a link that is not https`);
    }
    const byok = def.auth && def.auth.kind === 'byok_link';
    if (!byok) {
        if (!def.apiHost || !/^[a-z0-9.-]+$/.test(String(def.apiHost || ''))) problems.push('apiHost must be a host name');
        if (!def.test || !def.test.method || !def.test.path) problems.push('the test call is missing');
        if (!Array.isArray(def.auth.fields) || !def.auth.fields.length) problems.push('auth has no fields');
    }
    const names = new Set();
    for (const action of def.actions || []) {
        if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(String(action.name || ''))) problems.push(`the action name "${action.name}" is not app.action`);
        if (names.has(action.name)) problems.push(`the action name "${action.name}" is used twice`);
        names.add(action.name);
        if (!RISKS.includes(action.risk)) problems.push(`the action "${action.name}" has an unknown risk "${action.risk}"`);
        if (!action.input || action.input.type !== 'object') problems.push(`the action "${action.name}" has no object schema for its input`);
        if (!action.request || !action.request.method || !action.request.path) problems.push(`the action "${action.name}" has no request`);
        if (action.request && String(action.request.path).includes('://')) problems.push(`the action "${action.name}" names a URL; the host is fixed by the app`);
    }
    return problems;
}

let cached = null;

/** The catalogue: the ten definitions, by key, checked once. */
function all() {
    if (cached) return cached;
    const defs = loadDir();
    const problems = [];
    for (const def of defs) {
        for (const p of validateDefinition(def)) problems.push(`${def.key || '?'}: ${p}`);
    }
    if (problems.length) throw new Error(`the Connect catalogue is broken: ${problems.join(' | ')}`);
    cached = defs;
    return defs;
}

/** One app by its key, or null. */
function get(key) {
    return all().find((d) => d.key === key) || null;
}

/** The apps as the catalogue shows them: the key, the name, the blurb, the auth kind and the links. */
function summaries() {
    return all().map((d) => ({
        key: d.key, name: d.name, vendor: d.vendor, blurb: d.blurb, docsUrl: d.docsUrl || null,
        auth_kind: d.auth.kind, auth_label: d.auth.label, auth_hint: d.auth.hint || null,
        scopes: d.auth.scopes || [], byok: d.byok || null,
        actions: (d.actions || []).map((a) => ({ name: a.name, title: a.title, risk: a.risk, description: a.description || '' })),
    }));
}

module.exports = { all, get, summaries, validateDefinition, RISKS, AUTH_KINDS };
