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
    remove() { const p = this.parent; if (!p) return; const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); }
    get childNodes() { return this.children.slice(); }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    fire(t, ev = {}) { (this.listeners[t] || []).forEach((fn) => fn(ev)); }
    focus() {} select() {} play() { return Promise.resolve(); }
    get classList() { const n = this; return { toggle: (c, on) => { n.className = on ? `${n.className} ${c}` : n.className.replace(c, ''); }, contains: (c) => n.className.split(' ').includes(c) }; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
    querySelectorAll(sel) {
        if (sel === '.mc-role-set input') return this.all((n) => n.tagName === 'INPUT' && n.parent && n.parent.className === 'mc-role' && n.parent.parent && n.parent.parent.className.split(' ').includes('mc-role-set'));
        if (sel === '.mc-role input') return this.all((n) => n.tagName === 'INPUT' && n.parent && n.parent.className === 'mc-role');
        if (sel === '.mc-role-input') return this.all((n) => n.tagName === 'INPUT' && String(n.className || '').split(' ').includes('mc-role-input'));
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
        console, Date, Number, String, Set, Math, JSON, Promise, URLSearchParams, location: { search: '' },
        navigator: { clipboard: { writeText: async () => {} } },
        setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval: () => { timers = []; },
        setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
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
assert.match(CORE, /hash === 'pair' \? 'machines'/, '#pair opens Machines');
assert.match(CORE, /if \(routeSection === 'machines' && hash === 'pair'\) setTimeout\(\(\) => mcPair\(\), 0\)/, '#pair starts pairing');
assert.match(CORE, /if \(id === 'machines' && typeof loadMachines === 'function'\) loadMachines\(\);/, 'it loads when opened');
assert.ok(NOT_FOUND.ACCOUNT_HUB_PATHS.includes('/machines'), '/machines is the account hub, not a 404');

(async () => {
    // ── Two machines: the online one first, its roles as switches ──
    let machines = [
        { id: 'dev_A', kind: 'onboard', online: false, name: 'Old laptop', os: 'Linux', last_seen_at: ago(120), roles: [], running: [] },
        { id: 'dev_B', kind: 'onboard', online: true, name: 'Studio PC', os: 'Windows 11', node_version: '0.31.0', roles: ['codes.worker'], running: [{ title: 'Fix the WHIP reconnect' }], fleet: [{ agent: 'muse', installed: true, signed_in: true }], fleet_at: new Date().toISOString() },
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
    // 11-12: every coding agent Codes runs, with the machine's own report of each; Muse's setup stays on the card.
    assert.match(cards[0].textContent, /Muse CodeSigned in on this machine\.Ready.*muse login.*--plan-logins.*install.ps1/, 'ready and Windows setup on its card');
    assert.match(cards[0].textContent, /Claude Code.*Codex.*OpenCode.*Command Code.*MiniMax Code.*Muse Code.*DeepSeek.*Aider/, 'every agent Codes runs');
    assert.match(cards[0].textContent, /Start a task here.*Set up agents on Codes/, 'the way to openvibe.codes');
    const noCard = { querySelector: () => null };
    assert.match(p.sandbox.mcAgentsBlock(noCard, { online: true, roles: ['codes.worker'], fleet: [{ agent: 'muse', installed: true, signed_in: false }] }).textContent, /Muse Code[^]*?Sign in/);
    assert.match(p.sandbox.mcAgentsBlock(noCard, { online: true, roles: ['codes.worker'], fleet: [{ agent: 'muse', installed: false, signed_in: false }] }).textContent, /Muse Code[^]*?Not installed/);
    assert.match(p.sandbox.mcAgentsBlock(noCard, { online: true, roles: [] }).textContent, /Run my coding tasks here/, 'a computer that does not run coding tasks offers to');
    assert.match(p.sandbox.mcAgentsBlock(noCard, { online: true, roles: ['codes.worker'] }).textContent, /has not listed its coding apps yet/);
    assert.match(p.sandbox.mcAgentsBlock(noCard, { online: true, roles: ['codes.worker'], fleet: [{ agent: 'muse', installed: true, signed_in: true }], fleet_at: ago(30) }).textContent, /Last reported 30 min ago/, 'an old reading says how old it is');
    assert.match(cards[1].textContent, /Offline · seen 2 h ago/);
    // 2026-11-12: the card in plain words, what it does for you apart from what it does for other people.
    assert.match(cards[0].textContent, /For you.*For others/, 'two separate tabs');
    assert.match(cards[0].textContent, /Run my coding tasks.*Give my agents a browser here.*Use the AI models on this computer/);
    assert.ok(!/Desk host|Codes worker|AI host/.test(cards[0].textContent), 'no catalogue jargon on the card');
    const boxes = cards[0].querySelectorAll('.mc-role-input');
    assert.deepStrictEqual(boxes.map((b) => [b.value, b.checked]), [['codes.worker', true], ['desks.host', false]], 'a switch per role, the machine\'s own on');

    // A role switch saves the whole set.
    boxes[1].checked = true; boxes[1].fire('change');
    await flush();
    assert.deepStrictEqual(p.calls.find((c) => c[0] === 'PUT'), ['PUT', '/api/v1/machines/dev_B/roles', { roles: ['codes.worker', 'desks.host'] }]);
    assert.match(p.ids['mc-status'].textContent, /picks this up within a minute/);
    // "Use the AI models on this computer" is the role and the owner's yes, saved together.
    const ai = cards[0].all((n) => n.tagName === 'INPUT' && /-ai$/.test(n.getAttribute('id') || ''))[0];
    ai.checked = true; ai.fire('change');
    await flush(); await flush();
    const puts = p.calls.filter((c) => c[0] === 'PUT');
    assert.ok(puts[puts.length - 1][2].roles.includes('ai.host'), 'the role');
    assert.deepStrictEqual(p.calls.find((c) => /\/ai-models$/.test(c[1])), ['POST', '/api/v1/machines/dev_B/ai-models', { on: true }], 'and the owner\'s yes');

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

    // ── The owner's controls (the removed page's): two switches that read Bot's state, the live screen, its
    // links, and the machine's desks. Each is a call to Network's hub route, which calls Bot as the person. ──
    const switchMachine = {
        id: 'dev_C', kind: 'onboard', online: true, name: 'Desk PC', roles: [], running: [],
        controls: {
            computer: true, agent_computer: true, watch_probe: false, level: 'ask', probe: true,
            screen: { available: true, live: false },
            desk: { available: true, screen: true, named: true, running: 1, max: 2, kinds: ['browser'] },
        },
    };
    p = page({ answers: (m, url, body) => {
        if (url === '/api/v1/machines/roles') return { roles: ROLES };
        if (m === 'GET' && url === '/api/v1/machines') return { machines: [switchMachine] };
        if (m === 'POST' && /\/agent-computer$/.test(url)) { switchMachine.controls.agent_computer = body.on; return { machine: switchMachine }; }
        if (m === 'POST' && /\/watch-probe$/.test(url)) { switchMachine.controls.watch_probe = body.on; return { machine: switchMachine }; }
        if (m === 'POST' && /\/screen$/.test(url)) return { machine_id: 'dev_C', streaming: true, seconds: 600, desk: body.desk };
        if (m === 'GET' && /\/screen$/.test(url)) return { machine_id: 'dev_C', live: false, state: 'off', online: true };
        if (m === 'DELETE' && /\/screen$/.test(url)) return { stopped: true };
        if (m === 'GET' && /\/shares$/.test(url)) return { machine_id: 'dev_C', shares: [{ id: 'shr_abc', label: 'Staff room', control: false, desk: 'main' }] };
        if (m === 'DELETE' && /\/shares\/shr_abc$/.test(url)) return { revoked: true };
        if (m === 'GET' && /\/desks$/.test(url)) return { machine_id: 'dev_C', desks: [{ desk: 'desk-a', kind: 'browser', width: 1280, height: 720 }], max_desks: 2 };
        if (m === 'POST' && /\/desks\/desk-a\/stop$/.test(url)) return { stopped: 'desk-a' };
        if (m === 'POST' && /\/desks\/desk-a\/live$/.test(url)) return { machine_id: 'dev_C', desk: 'desk-a', seconds: 1800, channel_url: 'https://openvibe.live/@ana' };
        return {};
    } });
    await p.sandbox.loadMachines();
    const card = p.ids['mc-list'].children[0];
    assert.match(card.textContent, /Let my agents use this computer/);
    assert.match(card.textContent, /Let my watches check things from here/);
    // For other people: lending browsers needs a locked box for each; this computer has none, so it cannot.
    const lend = card.all((n) => n.tagName === 'INPUT' && /-lend$/.test(n.getAttribute('id') || ''))[0];
    assert.ok(lend && lend.disabled === true, 'no sandbox, no lending');
    assert.match(card.textContent, /cannot lend them.*--desk-host --shared/);
    const switches = card.all((n) => n.tagName === 'INPUT' && /-(agent|watch)$/.test(n.getAttribute('id') || ''));
    assert.deepStrictEqual(switches.map((b) => b.checked), [true, false], 'the switches start from Bot\'s own state');
    switches[0].checked = false; switches[0].fire('change');
    await flush();
    assert.deepStrictEqual(p.calls.find((c) => /\/agent-computer$/.test(c[1])), ['POST', '/api/v1/machines/dev_C/agent-computer', { on: false }], 'the agent switch saves on the person\'s click');

    const button = (text) => card.all((n) => n.tagName === 'BUTTON' && new RegExp(text).test(n.textContent))[0];
    button('Show my screen').fire('click');
    await flush();
    assert.deepStrictEqual(p.calls.find((c) => c[0] === 'POST' && /\/screen$/.test(c[1])), ['POST', '/api/v1/machines/dev_C/screen', { desk: 'main' }], 'ten minutes by the server\'s default');
    assert.ok(p.calls.some((c) => c[0] === 'GET' && /\/screen$/.test(c[1])), 'the picture waits for the machine to publish');
    button('Stop showing my screen').fire('click');
    await flush();
    assert.ok(p.calls.some((c) => c[0] === 'DELETE' && /\/screen$/.test(c[1])), 'Stop reaches the machine');

    button('Screen links').fire('click');
    await flush();
    assert.ok(p.calls.some((c) => c[0] === 'GET' && /\/shares$/.test(c[1])));
    assert.match(card.textContent, /Staff room/);
    const shareRevoke = card.all((n) => n.tagName === 'BUTTON' && n.parent && n.parent.className === 'mc-share-row')[0];
    shareRevoke.fire('click');
    await flush();
    assert.ok(p.calls.some((c) => c[0] === 'DELETE' && c[1] === '/api/v1/machines/dev_C/shares/shr_abc'), 'revoking one link');

    button('See its desks').fire('click');
    await flush();
    assert.ok(p.calls.some((c) => c[0] === 'GET' && /\/desks$/.test(c[1])));
    assert.match(card.textContent, /desk-a.*browser.*1280×720/);
    card.all((n) => n.tagName === 'BUTTON' && n.textContent === 'Stop')[0].fire('click');
    await flush();
    assert.ok(p.calls.some((c) => c[0] === 'POST' && c[1] === '/api/v1/machines/dev_C/desks/desk-a/stop'), 'a desk stops from here');
    button('Go live with this desk').fire('click');
    await flush();
    assert.ok(p.calls.some((c) => c[0] === 'POST' && c[1] === '/api/v1/machines/dev_C/desks/desk-a/live'), 'the Live channel takes the desk with its warning first');
    assert.match(card.textContent, /openvibe\.live\/@ana/);

    // ── For other people: a shared desk host lends its browsers on the owner's click ──
    const lender = { id: 'dev_D', kind: 'server', online: true, name: 'ov-node-01', roles: ['desks.host'], running: [],
        controls: { computer: true, agent_computer: false, watch_probe: false, shared_desks: false, ai_models: false, level: 'trusted', probe: false,
            screen: { available: false, live: false }, desk: { available: true, sandboxed: true, max: 7 }, ai: { available: true, models: 2, offered: true } } };
    p = page({ answers: (m, url, body) => {
        if (url === '/api/v1/machines/roles') return { roles: ROLES };
        if (m === 'GET' && url === '/api/v1/machines') return { machines: [lender] };
        if (m === 'POST' && /\/shared-desks$/.test(url)) { lender.controls.shared_desks = body.on; return { machine: lender }; }
        return {};
    } });
    await p.sandbox.loadMachines();
    const lcard = p.ids['mc-list'].children[0];
    assert.match(lcard.textContent, /Lend browsers to other people\u2019s agents.*Up to 7 browsers at once/);
    assert.match(lcard.textContent, /Its AI models answer other people too/);
    const lendBox = lcard.all((n) => n.tagName === 'INPUT' && /-lend$/.test(n.getAttribute('id') || ''))[0];
    assert.ok(lendBox.disabled !== true, 'a sandboxed computer may lend');
    lendBox.checked = true; lendBox.fire('change');
    await flush();
    assert.deepStrictEqual(p.calls.find((c) => /\/shared-desks$/.test(c[1])), ['POST', '/api/v1/machines/dev_D/shared-desks', { on: true }]);
    assert.match(p.ids['mc-status'].textContent, /lends browsers to other people\u2019s agents/);

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

    // §Y.1 A3 (11-13): a machine's system shows its maker's mark. Apple, Linux, Windows and Android are brand glyphs
    // (fa-brands): written as fa-solid they resolved to nothing and the cards showed a blank.
    {
        const { sandbox } = page({ answers: {} });
        const cls = (os) => sandbox.mcOsIcon(os).className;
        assert.strictEqual(cls('macOS 15.2'), 'fa-brands fa-apple');
        assert.strictEqual(cls('darwin'), 'fa-brands fa-apple', 'darwin is a Mac');
        assert.strictEqual(cls('Ubuntu 24.04 (linux)'), 'fa-brands fa-linux');
        assert.strictEqual(cls('Windows 11'), 'fa-solid fa-laptop', 'Windows has no mark on purpose: a laptop');
        assert.strictEqual(cls('Android 16'), 'fa-brands fa-android');
        assert.strictEqual(cls(''), 'fa-solid fa-laptop', 'an unknown system is a laptop');
        assert.ok(!/fa-solid fa-(apple|linux|windows|android)/.test(SRC), 'no brand mark is ever written as fa-solid');
    }
    // The pairing panel stays closed until "Pair a machine" (its own display:grid outranked the hidden attribute).
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public/css/my.css'), 'utf8'), /\.mc-pair\[hidden\] \{ display: none; \}/);
    console.log('my machines: state, running, roles as switches saved whole, rename, a second press to revoke, pairing that watches for the machine, empty and signed out');
})().catch((e) => { console.error(e); process.exit(1); });
