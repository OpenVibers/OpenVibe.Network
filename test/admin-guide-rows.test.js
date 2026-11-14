'use strict';
// The guided setup finishes things in place (11-14): a key step carries its Setup rows (drawn with their field, Save
// and "Where to get it"), a service that did not answer says why in plain words, the Agents step names
// OpenVibe.Actor, "What is left" counts what waits, and a switch with a default never waits on the owner.
//   node test/admin-guide-rows.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rules = require('../public/js/admin/guide-rules.js');

const row = (id, state, extra = {}) => ({ id, state, title: id, service_name: 'OpenVibe.Domains', group: 'domains', ...extra });
const setup = {
    services: [
        { service: 'domains', name: 'OpenVibe.Domains', answered: true },
        { service: 'connect', name: 'OpenVibe Connect', answered: false, status: 401, why: 'OpenVibe Connect did not accept Network\'s sign-in for it (401).' },
    ],
    groups: [{ id: 'domains', label: 'Domains', rows: [
        row('domains/r/porkbun_api_key', 'needed', { required_for: 'Porkbun domains' }),
        row('domains/r/porkbun_secret_api_key', 'needed', { required_for: 'Porkbun domains' }),
        row('domains/r/cloudflare', 'optional'),
        row('domains/r/default_on', 'connected'),
    ] }],
    rows: [],
};
const out = rules.build({ setup, ai: null, machines: [], progress: { skipped: [], seen: ['welcome'] } });
const byId = Object.fromEntries(out.steps.map((s) => [s.id, s]));

const svc = byId.services;
assert.strictEqual(svc.items.length, 1);
assert.match(svc.items[0].text, /OpenVibe Connect: its settings could not be read/);
assert.match(svc.items[0].why, /401/, 'the reason travels with it');
assert.strictEqual(svc.reread, true, 'and the step can read again');

const dom = byId['keys-domains'];
assert.deepStrictEqual(dom.rows, ['domains/r/porkbun_api_key', 'domains/r/porkbun_secret_api_key', 'domains/r/cloudflare', 'domains/r/default_on'], 'waiting rows first, then optional, then set');
assert.strictEqual(dom.count, 2);
assert.deepStrictEqual(dom.items, [], 'no list of links: the rows are the step');

assert.match(byId.agents.plain, /OpenVibe\.Actor \(openvibe\.actor\)/);
assert.strictEqual(byId.agents.open.href, 'https://openvibe.actor');

const left = byId.finish.items.find((i) => i.step === 'keys-domains');
assert.strictEqual(left.text, 'Domains · 2 waiting');

// The page side: the guide draws the rows through setup.js (no innerHTML of its own), and reads again after a save.
const guide = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'guide.js'), 'utf8');
const setupJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'setup.js'), 'utf8');
assert.ok(guide.includes('setupRowsInto(ol, g)') && guide.includes("addEventListener('ov-setup-changed'"));
assert.ok(setupJs.includes("new CustomEvent('ov-setup-changed')") && setupJs.includes('function setupRowsInto('));
assert.ok(setupJs.includes('<span class="setup-label">'), 'a row leads with what it does');

// The server side: a switch with a default is set by it; Connect is asked for with its own audience.
const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'admin', 'setup.js'), 'utf8');
assert.ok(/const byDefault = !set && type === 'boolean' && typeof prop.default === 'boolean';/.test(server));
assert.ok(/function whyDown\(a\)/.test(server));
const cfg = fs.readFileSync(path.join(__dirname, '..', 'server', 'config.js'), 'utf8');
assert.ok(/audience: process\.env\.OV_CONNECT_AUDIENCE \|\| 'openvibe\.website'/.test(cfg));
console.log('admin-guide-rows: rows in place, reasons in words, Actor named, counts left, defaults set, Connect\'s audience');
