'use strict';
// The account home, "You, today" (plan L43; the owner, 10-31: "I hate this dashboard… redo the whole thing"). my/today.js
// runs here on a tiny DOM with sample answers from each API:
// - Now: the people you follow who are live, a notifications chip, Go live only for a streamer;
// - Continue: the newest history, one card per address, https only;
// - Your sites: ranked by your own use (pins, history counts, recents), Network itself left out, two to try that you
//   have not used; Your money from /api/coins; your numbers;
// - an empty block stays out, and no API answer breaks the page.
// It also checks the page: no Quick Access grid, no email beside your name, Settings below.
//   node test/my-today.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/my/today.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public/my.html'), 'utf8');
const PROFILE = fs.readFileSync(path.join(__dirname, '..', 'public/js/my/profile.js'), 'utf8');
const BOOT = fs.readFileSync(path.join(__dirname, '..', 'public/js/my/boot.js'), 'utf8');
const TOOLS = fs.readFileSync(path.join(__dirname, '..', 'public/js/my/tools.js'), 'utf8');

class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this.hidden = false; this.listeners = {}; this._text = ''; this.style = {}; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    append(...kids) { for (const k of kids) this.children.push(typeof k === 'string' ? Object.assign(new Node('#text'), { _text: k }) : k); }
    prepend(k) { this.children.unshift(k); }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    remove() {}
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    click() { (this.listeners.click || []).forEach((fn) => fn({})); }
    scrollIntoView() { this.scrolled = true; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get href() { return this.attrs.href; }
    get classList() { const n = this; return { add: (c) => { n.className += ` ${c}`; } }; }
    all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
}

function page() {
    const ids = {};
    for (const [, id] of HTML.matchAll(/id="((?:td-|user-greeting|today|coins|settings)[a-z-]*)"/g)) ids[id] = new Node('div');
    const shown = [];
    const sandbox = {
        document: { getElementById: (id) => ids[id] || null, createElement: (t) => new Node(t), querySelector: () => null },
        console, Date, Number, String, Map, Set, Math, JSON, Promise,
        currentUser: { role: 'user' },
        showSection: (id) => shown.push(id),
        isAnonSession: () => false,
    };
    vm.runInNewContext(SRC, sandbox);
    return { ids, sandbox, shown };
}
const links = (n) => n.all((c) => c.tagName === 'A').map((a) => a.href);
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

// ── The page: no Quick Access grid, no email next to your name, Settings below ──
assert.ok(!/Quick Access|showcase-grid|quick-access/.test(HTML), 'the Quick Access grid is gone');
assert.ok(!/buildDashboardShowcase/.test(TOOLS + BOOT), 'and its builder');
assert.match(HTML, /id="today"/);
assert.ok(HTML.indexOf('id="today"') < HTML.indexOf('id="settings"') && HTML.indexOf('id="settings"') < HTML.indexOf('class="section-tabs"'), 'You, today first, then Settings');
assert.ok(!/user\.email \? ' · '/.test(PROFILE), 'the email is not beside your name (this page may be on a stream)');
assert.match(BOOT, /loadToday\(\)/, 'boot starts it');
assert.match(HTML, /id="coins"/, 'the navbar\'s OpenCoins chip (/my#coins) lands on Your money');

(async () => {
    // ── Everything at once ──
    let p = page();
    p.sandbox.currentUser = { role: 'streamer' };
    p.sandbox.renderNow({ live: [
        { username: 'goosely', name: 'Goosely', title: 'Geese at dawn', viewers: 9, thumbnail: 'https://openvibe.live/t/g.jpg', url: 'https://openvibe.live/@goosely' },
        { username: 'maticus', name: 'Maticus', title: 'LOOI', viewers: 0, thumbnail: 'javascript:alert(1)', url: 'https://openvibe.live/@maticus' },
    ], following: 14, anyone_live: 5 }, { count: 3 });
    assert.strictEqual(p.ids['td-now'].hidden, false);
    assert.deepStrictEqual(links(p.ids['td-live']), ['https://openvibe.live/@goosely', 'https://openvibe.live/@maticus']);
    assert.strictEqual(p.ids['td-live'].all((c) => c.tagName === 'IMG').length, 1, 'only an https thumbnail is shown');
    assert.strictEqual(p.ids['td-now-sub'].textContent, '2 of the 14 you follow');
    const chips = p.ids['td-chips'];
    assert.match(chips.textContent, /3 new notifications/);
    assert.match(chips.textContent, /Go live/, 'a streamer can go live from here');
    assert.ok(!/live on OpenVibe now/.test(chips.textContent), 'not "who else is live" while people you follow are');

    p.sandbox.renderContinue({ items: [
        { title: 'Geese at dawn', url: 'https://openvibe.live/@goosely', service: 'live', service_label: 'Live', updated_at: ago(5) },
        { title: 'Geese at dawn', url: 'https://openvibe.live/@goosely', service: 'live', updated_at: ago(50) },
        { title: 'My theme', url: 'https://openvibe.design/themes/mine', service: 'design', icon: 'fa-palette', updated_at: ago(130) },
        { title: 'Odd', url: 'javascript:alert(1)', service: 'live', updated_at: ago(1) },
    ] });
    assert.deepStrictEqual(links(p.ids['td-continue-list']), ['https://openvibe.live/@goosely', 'https://openvibe.design/themes/mine'], 'one card per address, https only');
    assert.match(p.ids['td-continue-list'].textContent, /Live · 5 min ago/);
    assert.match(p.ids['td-continue-list'].textContent, /2 h ago/);

    p.sandbox.renderSites(
        { services: [{ service: 'network', count: 99 }, { service: 'live', count: 40 }, { service: 'tools', count: 12 }, { service: 'nope', count: 9 }] },
        { pinned: ['design'], recent: ['games', 'live'] });
    assert.deepStrictEqual(links(p.ids['td-sites-grid']), ['https://openvibe.design', 'https://openvibe.live', 'https://openvibe.tools', 'https://openvibe.games'], 'pins first, then your own use; Network and unknown sites left out');
    const tries = links(p.ids['td-try']);
    assert.strictEqual(tries.length, 2, 'two to try');
    assert.ok(!tries.some((u) => /live|tools|games|design/.test(u)), 'none you already use');
    assert.strictEqual(p.ids['td-sites-h'].textContent, 'Your sites');

    p.sandbox.renderMoney({ balance: 1240, vibes: 30 }, { transactions: [{ delta: 20, reason: 'watch_time', created_at: ago(90) }] });
    assert.deepStrictEqual([p.ids.coins.hidden, p.ids['td-coins'].textContent, p.ids['td-vibes'].textContent, p.ids['td-vibes-row'].hidden], [false, (1240).toLocaleString(), '30', false]);
    assert.match(p.ids['td-money-last'].textContent, /^\+20 for watch time · 1 h ago$/);

    p.sandbox.renderStuff({ following: 14 }, { total: 230 }, { nodes: [{ id: 1 }, { id: 2, revoked_at: 'x' }] });
    assert.match(p.ids['td-stuff-row'].textContent, /14following/);
    assert.match(p.ids['td-stuff-row'].textContent, /1machines/, 'revoked machines do not count');
    p.ids['td-stuff-row'].children.find((c) => /history/.test(c.textContent)).click();
    assert.deepStrictEqual(p.shown, ['history'], 'your history opens below');

    // ── Nothing to show: each block stays out; a new account gets "Start here" ──
    p = page();
    p.sandbox.renderNow({ live: [], following: 0, anyone_live: 4 }, { count: 0 });
    assert.strictEqual(p.ids['td-now'].hidden, true, 'nobody you follow is live: no Live now row');
    assert.match(p.ids['td-chips'].textContent, /4 live on OpenVibe now/, 'but who else is, in one chip');
    assert.ok(!/Go live|notification/.test(p.ids['td-chips'].textContent), 'no Go live for a viewer, no zero count');
    p.sandbox.renderContinue(null);
    assert.strictEqual(p.ids['td-continue'].hidden, true);
    p.sandbox.renderSites(null, null);
    assert.deepStrictEqual([p.ids['td-sites'].hidden, p.ids['td-sites-h'].textContent, links(p.ids['td-try']).length], [false, 'Start here', 2]);
    p.sandbox.renderMoney(null, null);
    assert.strictEqual(p.ids.coins.hidden, true, 'no coins answer: no money block');
    p.sandbox.renderStuff(null, null, null);
    assert.strictEqual(p.ids['td-stuff-row'].children.length, 0);

    // ── Every API down: the page still draws ──
    p = page();
    p.sandbox.apiFetch = () => Promise.reject(Object.assign(new Error('down'), { status: 503 }));
    await p.sandbox.loadToday();
    assert.ok(/td-ready/.test(p.ids.today.className), 'drawn');
    assert.ok(p.ids['td-greeting'] === undefined && /Good|Up late/.test(p.ids['user-greeting'].textContent), 'with a greeting');

    console.log('my today: live follows, continue, your sites by your own use, money and numbers; empty blocks stay out; APIs down still draws');
})().catch((e) => { console.error(e); process.exit(1); });
