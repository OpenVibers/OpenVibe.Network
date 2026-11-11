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
    set href(v) { this.attrs.href = String(v); }
    get classList() { const n = this; return { add: (c) => { n.className += ` ${c}`; } }; }
    all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
}

function page() {
    const ids = {};
    for (const [, id] of HTML.matchAll(/id="((?:td-|me-|page-header|user-greeting|needs-you|today|coins|settings)[a-z-]*)"/g)) ids[id] = new Node('div');
    const shown = [];
    const sandbox = {
        document: { getElementById: (id) => ids[id] || null, createElement: (t) => new Node(t), createTextNode: (t) => Object.assign(new Node('#text'), { _text: String(t) }), querySelector: () => null },
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
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/my.css'), 'utf8');
assert.ok(HTML.indexOf('<div class="settings">') < HTML.indexOf('class="section-tabs"') && HTML.indexOf('class="section-tabs"') < HTML.indexOf('id="sec-anon"'), 'the settings are one block: the tabs, then every section');
assert.match(CSS, /@media \(min-width:1000px\)\{[\s\S]*\.settings\{display:grid;grid-template-columns:208px minmax\(0,1fr\)/, 'on a computer the tabs are a sidebar beside the open section (L43)');

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
    assert.ok(!/live on OpenVibe now/.test(chips.textContent), 'not "who else is live" while people you follow are');

    // The hero's actions (11-07): one tap to what you do most; Go live for a streamer, the count on Notifications.
    p.sandbox.renderActions({ count: 3 });
    const acts = p.ids['me-acts'];
    assert.deepStrictEqual(acts.children.map((a) => a.children[1].textContent), ['Go live', 'Messages', 'Ask Vibe', 'Your files', 'Codes', 'Wallet', 'Notifications', 'Settings']);
    assert.deepStrictEqual(links(acts).slice(0, 5), ['https://openvibe.live/broadcast', 'https://openvibe.chat/messages', 'https://openvibe.chat/', 'https://openvibe.download/files', 'https://openvibe.codes/'], 'every action is a real link first');
    assert.match(acts.textContent, /Notifications3/, 'the unread count on Notifications');
    p.sandbox.currentUser = { role: 'user' };
    p.sandbox.renderActions({ count: 0 });
    assert.strictEqual(acts.children[0].children[1].textContent, 'Watch live', 'a viewer watches');
    assert.ok(!/Notifications\d/.test(acts.textContent), 'no zero count');
    p.sandbox.currentUser = { role: 'streamer' };

    // On OpenVibe now: the sites' own cards, https entries and pictures only, an empty card left out.
    p.sandbox.renderNet({ cards: [
        { id: 'trending', site: 'media-hub', title: 'Trending', items: [
            { title: 'A walk', url: 'https://openvibe.video/v/1', meta: '9 views this week', image: { src: 'https://openvibe.media/t/1.jpg?w=640', w: 640, h: 360 } },
            { title: 'No picture', url: 'https://openvibe.video/v/2', image: { src: 'javascript:alert(1)' } },
            { title: 'Bad', url: 'javascript:alert(1)', image: { src: 'https://openvibe.media/t/3.jpg' } },
        ], more: { label: 'Watch more', url: 'https://openvibe.video/' } },
        { id: 'empty', site: 'games', title: 'Nothing', items: [] },
    ] });
    assert.strictEqual(p.ids['td-net'].hidden, false);
    assert.deepStrictEqual(links(p.ids['td-net-cards']), ['https://openvibe.video/', 'https://openvibe.video/v/1', 'https://openvibe.video/v/2']);
    assert.match(p.ids['td-net-cards'].textContent, /TrendingVideo/);
    const thumbs = p.ids['td-net-cards'].all((c) => c.tagName === 'IMG');
    assert.strictEqual(thumbs.length, 1, 'only an https picture is drawn');
    assert.deepStrictEqual(
        ['src', 'alt', 'width', 'height', 'loading', 'decoding'].map((k) => thumbs[0].getAttribute(k)),
        ['https://openvibe.media/t/1.jpg?w=640', '', '64', '36', 'lazy', 'async'],
        'a 64x36 lazy thumbnail with empty alt');
    assert.strictEqual(p.ids['td-net-cards'].all((c) => c.tagName === 'OL')[0].children[0].children[0].children.map((c) => c.className).join(','), 'td-net-i,td-net-thumb,td-net-t', 'number, picture, then the title');
    p.sandbox.renderNet({ cards: [
        { id: 'forum', site: 'community', title: 'New in the forum', items: [{ title: 'Old thread', url: 'https://openvibe.community/t/1', meta: '18d ago' }] },
        { id: 'video', site: 'media-hub', title: 'Trending · Video', items: [{ title: 'Fresh clip', url: 'https://openvibe.video/v/1', meta: '1d ago · 12 views' }] },
        { id: 'live', site: 'live', title: 'Live now', items: [{ title: 'On air', url: 'https://openvibe.live/@a', meta: '1 viewers' }] },
    ] });
    const ordered = p.ids['td-net-cards'].children;
    assert.deepStrictEqual(ordered.map((c) => c.attrs['data-site']), ['live', 'media-hub', 'community'], 'live leads, then fresh video, then stale forum');
    assert.match(ordered[1].textContent, /1d ago/, 'a row states its age');
    assert.match(ordered[2].textContent, /quiet for 18 days/, 'stale cards say why they are quiet, in the head');
    assert.strictEqual(ordered[2].all((c) => c.className === 'td-net-quiet').length, 1, 'muted, beside the site');
    assert.strictEqual(ordered[2].all((c) => c.tagName === 'LI').length, 1, 'stale card keeps its newest row');
    p.sandbox.renderNet({ cards: [{ id: 'streams', site: 'live', title: 'Most watched', items: [
        { title: 'Same stream', url: 'https://openvibe.live/@a', meta: '1d ago' },
        { title: 'Same stream', url: 'https://openvibe.live/@a', meta: '2d ago' },
    ] }] });
    assert.match(p.ids['td-net-cards'].textContent, /2 streams this week/, 'same title and person fold into one row');
    // A ranked card (no ages): each copy of a stream has its own address and still folds; the window is said once, in the head.
    p.sandbox.renderNet({ cards: [{ id: 'trend', site: 'media-hub', title: 'Trending', window: 'most watched this week', items: [
        { title: "iZoR_One's Stream", url: 'https://openvibe.video/v/1' }, { title: "iZoR_One's Stream", url: 'https://openvibe.video/v/2' },
        { title: 'LOTFX Live Trading', url: 'https://openvibe.video/v/3' }, { title: "iZoR_One's Stream", url: 'https://openvibe.video/v/4' },
    ] }] });
    const trend = p.ids['td-net-cards'].children[0];
    assert.strictEqual(trend.all((c) => c.tagName === 'LI').length, 2, 'four rows of two things: two rows');
    assert.strictEqual((trend.textContent.match(/most watched this week/g) || []).length, 1, 'the window once, in the head');
    assert.match(trend.textContent, /3 streams this week/, 'the folded row says how many');
    p.sandbox.renderNet(null);
    assert.strictEqual(p.ids['td-net'].hidden, true, 'no cards: the block stays out');

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

    p.sandbox.renderMoney({ balance: 1240, vibes: 30 }, { transactions: [{ delta: 20, reason: 'quest:go-live', reason_text: 'for the quest Go live',
        reason_subject: { name: 'Go live', url: 'https://openvibe.quest/quests/go-live' }, created_at: ago(90) }] });
    assert.deepStrictEqual([p.ids.coins.hidden, p.ids['td-coins'].textContent, p.ids['td-vibes'].textContent, p.ids['td-vibes-row'].hidden], [false, (1240).toLocaleString(), '30', false]);
    assert.match(p.ids['td-money-last'].textContent, /^\+20 for the quest Go live · 1 h ago$/);
    assert.strictEqual(p.ids['td-money-last'].all((c) => c.tagName === 'A')[0].href, 'https://openvibe.quest/quests/go-live', 'the reason links to the quest');
    p.sandbox.renderMoney({ balance: 1240 }, { transactions: [{ delta: 5, reason: 'nobody:declared-this', reason_site: 'OpenVibe.Fun', created_at: ago(90) }] });
    assert.match(p.ids['td-money-last'].textContent, /^\+5 for something on OpenVibe.Fun · 1 h ago$/);
    assert.doesNotMatch(p.ids['td-money-last'].textContent, /nobody|declared-this/);

    p.sandbox.renderStuff({ following: 14 }, { total: 230 }, { nodes: [{ id: 1 }, { id: 2, revoked_at: 'x' }] });
    assert.match(p.ids['td-stuff-row'].textContent, /14following/);
    assert.match(p.ids['td-stuff-row'].textContent, /1machines/, 'revoked machines do not count');
    p.ids['td-stuff-row'].children.find((c) => /history/.test(c.textContent)).click();
    assert.deepStrictEqual(p.shown, ['history'], 'your history opens below');

    p.sandbox.renderMachineSummary({ machines: [{ name: 'Studio PC', online: true }, { name: 'Laptop', online: false }, { id: 'revoked', revoked_at: 'x', online: true }] });
    assert.strictEqual(p.ids['td-machines-count'].textContent, '2 paired');
    assert.strictEqual(p.ids['td-machines-state'].textContent, '1 online now · Studio PC');

    // ── Needs you (plan §4): the Action Center's waiting items, one button each, above the hero ──
    p = page();
    assert.ok(HTML.indexOf('id="page-header"') < HTML.indexOf('id="needs-you"'), 'the person is first');
    assert.ok(HTML.indexOf('id="needs-you"') < HTML.indexOf('id="me-acts"'), 'actions follow Needs you');
    p.sandbox.renderNeedsYou({ buckets: { waiting: [
        { service: 'network', id: 'cnf_1', kind: 'approval', title: 'Run a command', summary: 'Trip planner asks to run a command', agent: 'Trip planner', href: 'https://openvibe.network/my#approvals', actions: ['approve', 'decline', 'open'] },
        { service: 'actor', id: 'tsk_1', kind: 'agent_task', title: 'Find three cheap flights', summary: 'Read 4 pages', href: 'https://openvibe.actor/tasks/tsk_1', actions: ['open'] },
    ] } }, { confirmations: [{ id: 'cnf_1', capability: 'computer.command', details: { command: 'rm -rf /tmp/actor-gate-proof', reason: 'Clean up a test file', arguments: { raw: true } }, resources: [{ type: 'machine', name: 'devprobe' }] }] });
    assert.strictEqual(p.ids['needs-you'].hidden, false);
    assert.strictEqual(p.ids['needs-you-sub'].textContent, '2 things waiting');
    const rows = p.ids['needs-you-list'].children;
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].all((c) => c.tagName === 'BUTTON').length, 2, 'inline approve and decline');
    assert.strictEqual(rows[0].all((c) => c.tagName === 'H3')[0].textContent, 'Run a command on devprobe');
    assert.match(rows[0].textContent, /rm -rf \/tmp\/actor-gate-proof/);
    assert.doesNotMatch(rows[0].textContent, /"arguments"|\[object Object\]/, 'structured arguments stay hidden');
    assert.match(rows[0].textContent, /Details/);
    assert.strictEqual(rows[1].all((c) => c.tagName === 'A')[0].href, 'https://openvibe.actor/tasks/tsk_1', 'an open item links its page');
    // An agent known only by its id is not shown by it; Try again stays one tap.
    p.sandbox.renderNeedsYou({ buckets: { waiting: [
        { service: 'actor', id: 'apr_1', kind: 'approval', title: 'Run a command', agent: 'agt01M6VEKFK36XWYB3CSY1RE60YN', href: 'https://openvibe.actor/me/approvals/apr_1', actions: ['approve', 'open'] },
        { service: 'actor', id: 'tsk_2', kind: 'agent_task', title: 'Summarise the inbox', href: 'https://openvibe.actor/tasks/tsk_2', actions: ['retry', 'open'] },
        // An approval of one of the new kinds (plan HO1): the kind in plain words, the agent by its name, and
        // the approval's own page. Review opens it; the hub never approves with one tap.
        { service: 'actor', id: 'apr_publish', kind: 'approval', title: 'Publish your post on openvibe.blog', summary: 'publishing for others to see · Weekly digest', agent: 'Vibe', href: 'https://openvibe.actor/me/approvals/apr_publish', actions: ['approve', 'decline', 'open'] },
    ] } });
    const two = p.ids['needs-you-list'].children;
    assert.ok(!/agt01M6/.test(two[0].textContent), 'a raw agent id is left out');
    assert.strictEqual(two[0].all((c) => c.tagName === 'A')[0].href, 'https://openvibe.actor/me/approvals/apr_1', 'Review opens the approval');
    assert.strictEqual(two[1].all((c) => c.tagName === 'BUTTON')[0].textContent, 'Try again');
    assert.match(two[2].textContent, /publishing for others to see/, 'the kind of the act is in plain words');
    assert.match(two[2].textContent, /Weekly digest/, 'the thread it came from');
    assert.match(two[2].textContent, /Vibe/, 'the agent by its name');
    assert.strictEqual(two[2].all((c) => c.tagName === 'A')[0].href, 'https://openvibe.actor/me/approvals/apr_publish');
    assert.strictEqual(two[2].all((c) => c.tagName === 'BUTTON').length, 0, 'no one-tap approve on an approval');
    p.sandbox.renderNeedsYou({ buckets: { waiting: [] } });
    assert.strictEqual(p.ids['needs-you'].hidden, true, 'an empty queue leaves the section out');

    // ── Nothing to show: each block stays out; a new account gets "Start here" ──
    p = page();
    p.sandbox.renderNow({ live: [], following: 0, anyone_live: 4 }, { count: 0 });
    assert.strictEqual(p.ids['td-now'].hidden, true, 'nobody you follow is live: no Live now row');
    assert.match(p.ids['td-chips'].textContent, /4 live on OpenVibe now/, 'but who else is, in one chip');
    assert.ok(!/Go live|notification/.test(p.ids['td-chips'].textContent), 'the chips only say who else is live');
    p.sandbox.renderContinue(null);
    assert.strictEqual(p.ids['td-continue'].hidden, true);
    p.sandbox.renderSites(null, null);
    assert.deepStrictEqual([p.ids['td-sites'].hidden, p.ids['td-sites-h'].textContent, links(p.ids['td-try']).length], [false, 'Start here', 2]);
    p.sandbox.renderMoney(null, null);
    assert.strictEqual(p.ids.coins.hidden, true, 'no coins answer: no money block');
    p.sandbox.renderStuff(null, null, null);
    assert.strictEqual(p.ids['td-stuff-row'].children.length, 0);
    assert.strictEqual(p.ids['td-nums'].hidden, true, 'nothing to count: Your numbers stays out');

    // ── Every API down: the page still draws ──
    p = page();
    p.sandbox.apiFetch = () => Promise.reject(Object.assign(new Error('down'), { status: 503 }));
    await p.sandbox.loadToday();
    assert.ok(/td-ready/.test(p.ids.today.className), 'drawn');
    assert.ok(p.ids['td-greeting'] === undefined && /Good|Up late/.test(p.ids['user-greeting'].textContent), 'with a greeting');

    console.log('my today: live follows, continue, your sites by your own use, money and numbers; empty blocks stay out; APIs down still draws');
})().catch((e) => { console.error(e); process.exit(1); });
