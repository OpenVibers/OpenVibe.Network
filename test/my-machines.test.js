'use strict';
// Your machines on /my#machines and /machines (plan L34). my/machines.js on a tiny DOM, with Network's machines hub
// answered by hand: each machine shows its state, what it runs and its roles as switches; a switch saves the whole
// set; Rename saves on Enter; Revoke asks a second time in the page; "Pair a machine" shows the code and the command
// and watches for the machine to arrive; no machines, and signed out, each say so.
//   node test/my-machines.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/my/machines.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public/my.html'), 'utf8');
const CORE = fs.readFileSync(path.join(__dirname, '..', 'public/js/my/core.js'), 'utf8');
const NOT_FOUND = require('../server/not-found');

class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this.hidden = false; this.listeners = {}; this._text = ''; this.disabled = false; this.checked = false; this.value = ''; this.parent = null; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? Object.assign(new Node('#text'), { _text: k }) : k; n.parent = this; this.children.push(n); } }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    replaceWith(n) { const p = this.parent; if (!p) return; const i = p.children.indexOf(this); p.children[i] = n; n.parent = p; }
    get childNodes() { return this.children.slice(); }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    fire(t, ev = {}) { (this.listeners[t] || []).forEach((fn) => fn(ev)); }
    focus() {} select() {}
    get classList() { const n = this; return { toggle: (c, on) => { n.className = on ? `${n.className} ${c}` : n.className.replace(c, ''); }, contains: (c) => n.className.split(' ').includes(c) }; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
    querySelectorAll(sel) {
        if (sel === '.mc-role input') return this.all((n) => n.tagName === 'INPUT' && n.parent && n.parent.className === 'mc-role');
        return [];
    }
}

function page({ answers }) {
    const ids = { 'mc-list': new Node('div'), 'mc-status': new Node('p'), 'mc-pair': new Node('div'), 'mc-pair-btn': new Node('button'), settings: new Node('h2') };
    ids['mc-pair'].hidden = true;
    const calls = [];
    let timers = [];
    const sandbox = {
        document: { getElementById: (id) => ids[id] || null, createElement: (t) => new Node(t), querySelectorAll: (sel) => (sel === '[data-machine]' ? ids['mc-list'].all((n) => n.getAttribute('data-machine')) : []) },
        console, Date, Number, String, Set, Math, JSON, Promise,
        navigator: { clipboard: { writeText: async () => {} } },
        setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval: () => { timers = []; },
        apiFetch: async (p, o = {}) => { calls.push([o.method || 'GET', p, o.body ? JSON.parse(o.body) : null]); const a = answers(o.method || 'GET', p, o.body ? JSON.parse(o.body) : null); if (a instanceof Error) throw a; return a; },
    };
    vm.runInNewContext(SRC, sandbox);
    return { ids, sandbox, calls, tick: async () => { await Promise.all(timers.map((fn) => fn())); } };
}
const flush = () => new Promise((r) => setImmediate(r));
const ROLES = [{ id: 'codes.worker', name: 'Codes worker', shows: 'Runs your coding jobs.' }, { id: 'desks.host', name: 'Desk host', shows: 'Hosts desks.' }, { id: 'ai.host', name: 'AI host', shows: 'Serves your own models.' }];
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();

// ── The page: a Machines section in Settings, reached at /machines too, its script loaded ──
assert.ok(HTML.includes('id="sec-machines"') && HTML.includes("showSection('machines',this)"), 'a Machines section and tab');
assert.ok(HTML.indexOf('<script src="/js/my/machines.js" defer>') > 0, 'its script');
assert.match(CORE, /'\/machines': 'machines'/, 'the /machines address opens it');
assert.match(CORE, /if \(id === 'machines' && typeof loadMachines === 'function'\) loadMachines\(\);/, 'it loads when opened');
assert.ok(NOT_FOUND.ACCOUNT_HUB_PATHS.includes('/machines'), '/machines is the account hub, not a 404');

(async () => {
    // ── Two machines: the online one first, its roles as switches ──
    let machines = [
        { id: 'dev_A', kind: 'onboard', online: false, name: 'Old laptop', os: 'Linux', last_seen_at: ago(120), roles: [], running: [] },
        { id: 'dev_B', kind: 'onboard', online: true, name: 'Studio PC', os: 'Windows 11', node_version: '0.31.0', roles: ['codes.worker'], running: [{ title: 'Fix the WHIP reconnect' }] },
    ];
    let p = page({ answers: (m, url, body) => {
        if (url === '/api/v1/machines/roles') return { roles: ROLES };
        if (m === 'GET' && url === '/api/v1/machines') return { machines };
        if (m === 'PUT') return { machine: { ...machines[1], roles: body.roles } };
        if (m === 'PATCH') return { machine: { ...machines[1], name: body.name } };
        if (m === 'POST' && /revoke$/.test(url)) return { machine: { ...machines[0] } };
        return {};
    } });
    await p.sandbox.loadMachines();
    const cards = p.ids['mc-list'].children;
    assert.deepStrictEqual(cards.map((c) => c.getAttribute('data-machine')), ['dev_B', 'dev_A'], 'online first');
    assert.match(cards[0].textContent, /Studio PC.*Online.*Windows 11 · Node 0\.31\.0/);
    assert.match(cards[0].textContent, /Fix the WHIP reconnect/, 'what it runs');
    assert.match(cards[1].textContent, /Offline · seen 2 h ago/);
    const boxes = cards[0].querySelectorAll('.mc-role input');
    assert.deepStrictEqual(boxes.map((b) => [b.value, b.checked]), [['codes.worker', true], ['desks.host', false], ['ai.host', false]], 'a switch per role, the machine\'s own on');

    // A switch saves the whole set.
    boxes[2].checked = true; boxes[2].fire('change');
    await flush();
    assert.deepStrictEqual(p.calls.find((c) => c[0] === 'PUT'), ['PUT', '/api/v1/machines/dev_B/roles', { roles: ['codes.worker', 'ai.host'] }]);
    assert.match(p.ids['mc-status'].textContent, /picks this up at its next check-in/);

    // Rename on Enter.
    const rename = cards[0].all((n) => n.tagName === 'BUTTON' && /Rename/.test(n.textContent))[0];
    rename.fire('click');
    const input = cards[0].all((n) => n.className === 'mc-rename')[0];
    input.value = 'Edit bay'; input.fire('keydown', { key: 'Enter' });
    await flush();
    assert.deepStrictEqual(p.calls.find((c) => c[0] === 'PATCH'), ['PATCH', '/api/v1/machines/dev_B', { name: 'Edit bay' }]);

    // Revoke asks again, in the page; "Keep it" puts things back; "Revoke for good" revokes.
    const acts = cards[1].all((n) => n.className === 'mc-acts')[0];
    acts.children.find((n) => /Revoke/.test(n.textContent)).fire('click');
    assert.match(acts.textContent, /stops working for you at once/);
    acts.children.find((n) => /Keep it/.test(n.textContent)).fire('click');
    assert.ok(!p.calls.some((c) => /revoke$/.test(c[1])), 'nothing revoked on the first press');
    acts.children.find((n) => /Revoke/.test(n.textContent)).fire('click');
    acts.children.find((n) => /for good/.test(n.textContent)).fire('click');
    await flush();
    assert.ok(p.calls.some((c) => c[0] === 'POST' && c[1] === '/api/v1/machines/dev_A/revoke'), 'revoked on the second');

    // ── Pairing: the code and the command, then the machine arriving ──
    machines = [];
    p = page({ answers: (m, url) => {
        if (url === '/api/v1/machines/roles') return { roles: ROLES };
        if (m === 'POST' && url === '/api/v1/machines/pairings') return { pairing: { code: 'K7Q-4PX', installer: 'curl -fsSL https://openvibe.network/node/install | sh -s -- K7Q-4PX', expires_at: new Date(Date.now() + 600000).toISOString() } };
        if (m === 'GET' && url === '/api/v1/machines') return { machines };
        return {};
    } });
    await p.sandbox.loadMachines();
    assert.match(p.ids['mc-list'].textContent, /No machines yet\./, 'none yet: what pairing is for');
    await p.sandbox.mcPair();
    assert.strictEqual(p.ids['mc-pair'].hidden, false);
    assert.match(p.ids['mc-pair'].textContent, /K7Q-4PX/);
    assert.match(p.ids['mc-pair'].textContent, /curl -fsSL/);
    assert.match(p.ids['mc-pair'].textContent, /Waiting for your machine/);
    machines = [{ id: 'dev_N', kind: 'onboard', online: true, name: 'New box', roles: [], running: [] }];
    await p.tick(); await flush();
    assert.strictEqual(p.ids['mc-pair'].hidden, true, 'it arrived');
    assert.match(p.ids['mc-status'].textContent, /New box is paired/);

    // ── Signed out ──
    p = page({ answers: (m, url) => (url === '/api/v1/machines/roles' ? { roles: [] } : Object.assign(new Error('sign in'), { status: 401 })) });
    await p.sandbox.loadMachines();
    assert.match(p.ids['mc-list'].textContent, /Sign in to see your machines/);

    console.log('my machines: state, running, roles as switches saved whole, rename, a second press to revoke, pairing that watches for the machine, empty and signed out');
})().catch((e) => { console.error(e); process.exit(1); });
