/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): "You, today" (plan L43, 2026-10-31).
   The owner: "I hate this dashboard… redo the whole thing considering everything we have now and what's useful".
   What is happening for you right now, then what you were doing, your money, your sites ranked by your own use, and
   your numbers; the settings follow below. Every block is real data, and a block with nothing in it is left out.
   Classic script, global scope: my/core.js's apiFetch and showSection; my/boot.js calls loadToday(). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// [label, icon, address] for each site the history knows.
const TD_SITES = {
    live: ['Live', 'fa-tower-broadcast', 'https://openvibe.live'], tools: ['Tools', 'fa-screwdriver-wrench', 'https://openvibe.tools'],
    games: ['Games', 'fa-gamepad', 'https://openvibe.games'], media: ['Media', 'fa-photo-film', 'https://openvibe.media'],
    network: ['Network', 'fa-circle-nodes', 'https://openvibe.network'], community: ['Community', 'fa-users', 'https://openvibe.community'],
    space: ['Space', 'fa-shapes', 'https://openvibe.space'], chat: ['Chat', 'fa-comments', 'https://openvibe.chat'],
    codes: ['Codes', 'fa-code', 'https://openvibe.codes'], blog: ['Blog', 'fa-pen-nib', 'https://openvibe.blog'],
    wiki: ['Wiki', 'fa-book-open', 'https://openvibe.wiki'], news: ['News', 'fa-newspaper', 'https://openvibe.news'],
    reviews: ['Reviews', 'fa-star', 'https://openvibe.reviews'], tips: ['Tips', 'fa-hand-holding-heart', 'https://openvibe.tips'],
    vip: ['VIP', 'fa-crown', 'https://openvibe.vip'], trade: ['Trade', 'fa-chart-line', 'https://openvibe.trade'],
    host: ['Host', 'fa-server', 'https://openvibe.host'], deals: ['Deals', 'fa-tags', 'https://openvibe.deals'],
    coupons: ['Coupons', 'fa-ticket', 'https://openvibe.coupons'], openre: ['Restream', 'fa-share-nodes', 'https://openre.stream'],
    design: ['Design', 'fa-palette', 'https://openvibe.design'], report: ['Report', 'fa-chart-column', 'https://openvibe.report'],
};
// What to try next, most used across the network first, each with the reason it is worth a look.
const TD_TRY = [
    ['live', 'Go live from your browser', 'No OBS and no follower minimum'],
    ['tools', 'Free tools, no sign-up', 'Hundreds of them, each open and simple'],
    ['games', 'Play in your browser', 'Quick games, alone or with friends'],
    ['design', 'Make your own look', 'Themes and icons that follow you everywhere'],
    ['chat', 'One inbox for every site', 'Messages from Live, Games and the rest'],
    ['codes', 'Code with AI in the cloud', 'Bring your own Claude Code, Codex and more'],
    ['wiki', 'Look anything up', 'An open wiki the community keeps'],
    ['news', 'The news, briefly', 'Many sources on one page'],
];

function tdEl(tag, cls, kids, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => { if (c != null) n.append(c); });
    return n;
}
const tdIcon = (name) => tdEl('i', `fa-solid ${name}`, [], { 'aria-hidden': 'true' });
function tdAgo(at) {
    const t = Date.parse(at && !/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? String(at).replace(' ', 'T') + 'Z' : at);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const tdNum = (n) => Number(n || 0).toLocaleString();
const tdSafeUrl = (u) => (/^https:\/\//.test(String(u || '')) ? String(u) : null);

/** The greeting above your name, by your own clock. */
function renderGreeting() {
    const h = new Date().getHours();
    const el = document.getElementById('user-greeting');
    if (el) el.textContent = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Now: the people you follow who are live, your unread notifications, and Go live for a streamer. */
function renderNow(live, unread) {
    const box = document.getElementById('td-now');
    const rail = document.getElementById('td-live');
    const chips = document.getElementById('td-chips');
    const people = (live && live.live) || [];
    rail.replaceChildren(...people.map((p) => {
        const thumb = tdEl('span', 'td-thumb', [tdEl('span', 'td-live-dot', ['LIVE'])]);
        const src = tdSafeUrl(p.thumbnail);
        if (src) { const img = tdEl('img', '', [], { src, alt: '', loading: 'lazy', decoding: 'async' }); img.onerror = () => img.remove(); thumb.prepend(img); }
        if (p.viewers) thumb.append(tdEl('span', 'td-viewers', [tdIcon('fa-eye'), ` ${tdNum(p.viewers)}`]));
        return tdEl('a', 'td-live', [thumb, tdEl('span', 'td-live-name', [p.name || p.username]), tdEl('span', 'td-live-title', [p.title || ''])], { href: p.url });
    }));
    box.hidden = people.length === 0;
    const sub = document.getElementById('td-now-sub');
    if (sub) sub.textContent = people.length ? `${people.length} of the ${tdNum(live.following)} you follow` : '';

    const out = [];
    const count = unread && Number(unread.count);
    if (count > 0) {
        const b = tdEl('button', 'td-chip td-chip-hot', [tdIcon('fa-bell'), ` ${tdNum(count)} new notification${count === 1 ? '' : 's'}`], { type: 'button' });
        b.addEventListener('click', () => { const bell = document.querySelector('[data-ov-bell], .openvibe-navbar-bell, #openvibe-notif-btn'); if (bell) bell.click(); else showSection('notifications'); });
        out.push(b);
    }
    const role = currentUser && currentUser.role;
    if (role && role !== 'user') out.push(tdEl('a', 'td-chip', [tdIcon('fa-tower-broadcast'), ' Go live'], { href: 'https://openvibe.live/broadcast' }));
    if (!people.length && live && live.anyone_live > 0) out.push(tdEl('a', 'td-chip', [tdIcon('fa-circle-play'), ` ${tdNum(live.anyone_live)} live on OpenVibe now`], { href: 'https://openvibe.live/' }));
    chips.replaceChildren(...out);
    chips.hidden = out.length === 0;
}

/** Continue: the newest things you opened across the sites (Network history), one card per address. */
function renderContinue(hist) {
    const box = document.getElementById('td-continue');
    const list = document.getElementById('td-continue-list');
    const seen = new Set();
    const items = ((hist && hist.items) || []).filter((it) => { const u = tdSafeUrl(it.url); if (!u || seen.has(u)) return false; seen.add(u); return true; }).slice(0, 10);
    list.replaceChildren(...items.map((it) => {
        const site = TD_SITES[it.service] || [it.service_label || 'OpenVibe', 'fa-globe'];
        const icon = /^fa-[a-z0-9-]+$/.test(String(it.icon || '')) ? it.icon : site[1];
        return tdEl('a', 'td-card td-cont', [
            tdEl('span', 'td-cont-ic', [tdIcon(icon)]),
            tdEl('span', 'td-cont-t', [it.title || it.url]),
            tdEl('span', 'td-cont-m', [`${it.service_label || site[0]} · ${tdAgo(it.updated_at || it.created_at)}`]),
        ], { href: it.url });
    }));
    box.hidden = items.length === 0;
}

/** Your money: OpenCoins and Vibes, with the last change. */
function renderMoney(coins, last) {
    const box = document.getElementById('coins');   // the navbar's OpenCoins chip links to /my#coins
    if (!coins || coins.balance == null) { box.hidden = true; return; }
    document.getElementById('td-coins').textContent = tdNum(coins.balance);
    const vibes = document.getElementById('td-vibes-row');
    vibes.hidden = coins.vibes == null;
    if (coins.vibes != null) document.getElementById('td-vibes').textContent = tdNum(typeof coins.vibes === 'object' ? coins.vibes.balance : coins.vibes);
    const t = last && last.transactions && last.transactions[0];
    const line = document.getElementById('td-money-last');
    line.textContent = t ? `${t.delta > 0 ? '+' : ''}${tdNum(t.delta)} ${t.reason ? `for ${String(t.reason).replace(/_/g, ' ')}` : ''} · ${tdAgo(t.created_at)}` : '';
    line.hidden = !t;
    box.hidden = false;
}

/** Your sites: the ones you use most (history counts, then the switcher's pins and recents), and two to try. */
function renderSites(hist, sites) {
    const box = document.getElementById('td-sites');
    const grid = document.getElementById('td-sites-grid');
    const counts = new Map();
    ((sites && sites.pinned) || []).forEach((id) => counts.set(id, (counts.get(id) || 0) + 1000));
    ((hist && hist.services) || []).forEach((s) => counts.set(s.service, (counts.get(s.service) || 0) + Number(s.count || 0)));
    ((sites && sites.recent) || []).forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (8 - i)));
    const ranked = [...counts.entries()].filter(([id]) => TD_SITES[id] && id !== 'network').sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
    const mine = ranked.length > 4 ? ranked.slice(0, ranked.length - (ranked.length % 4)) : ranked;   // whole rows of four; All sites has the rest
    grid.replaceChildren(...mine.map((id) => {
        const [label, icon, url] = TD_SITES[id];
        return tdEl('a', 'td-site', [tdEl('span', 'td-site-ic', [tdIcon(icon)]), tdEl('span', '', [label])], { href: url });
    }));
    grid.hidden = mine.length === 0;
    const tries = TD_TRY.filter(([id]) => !mine.includes(id) && !counts.has(id)).slice(0, 2);
    const tryBox = document.getElementById('td-try');
    tryBox.replaceChildren(...tries.map(([id, what, why]) => {
        const [, icon, url] = TD_SITES[id];
        return tdEl('a', 'td-try', [tdEl('span', 'td-site-ic', [tdIcon(icon)]), tdEl('span', 'td-try-t', [tdEl('b', '', [what]), tdEl('small', '', [why])])], { href: url });
    }));
    tryBox.hidden = tries.length === 0;
    document.getElementById('td-sites-h').textContent = mine.length ? 'Your sites' : 'Start here';
    box.hidden = mine.length === 0 && tries.length === 0;
}

/** Your numbers: follows, machines and history; the full picture is on openvibe.report/you (the link beside them). */
function renderStuff(live, hist, nodes) {
    const row = document.getElementById('td-stuff-row');
    const cells = [];
    const add = (n, label, act) => {
        if (!(n > 0)) return;
        const kids = [tdEl('b', '', [tdNum(n)]), tdEl('span', '', [label])];
        if (!act) return cells.push(tdEl('span', 'td-stat', kids));
        const b = tdEl('button', 'td-stat', kids, { type: 'button' });
        b.addEventListener('click', act);
        cells.push(b);
    };
    add(live && live.following, 'following');
    add(nodes && nodes.nodes && nodes.nodes.filter((n) => !n.revoked_at).length, 'machines', () => { showSection('machines'); document.getElementById('settings').scrollIntoView({ behavior: 'smooth' }); });
    add(hist && hist.total, 'pages in your history', () => { showSection('history'); document.getElementById('settings').scrollIntoView({ behavior: 'smooth' }); });
    row.replaceChildren(...cells);
}

async function loadToday() {
    if (!document.getElementById('today')) return;
    renderGreeting();
    if (typeof isAnonSession === 'function' && isAnonSession()) return;   // a guest identity keeps no history, follows or coins
    const quiet = (p) => p.catch(() => null);
    const [live, hist, coins, last, unread, sites, nodes] = await Promise.all([
        quiet(apiFetch('/api/v1/me/live-follows')),
        quiet(apiFetch('/api/history?limit=30')),
        quiet(apiFetch('/api/coins/me?with=vibes')),
        quiet(apiFetch('/api/coins/me/history?limit=1')),
        quiet(apiFetch('/api/notifications/unread-count')),
        quiet(apiFetch('/api/themes/me/sites')),
        quiet(apiFetch('/api/v1/me/nodes')),
    ]);
    renderNow(live, unread);
    renderContinue(hist);
    renderMoney(coins, last);
    renderSites(hist, sites);
    renderStuff(live, hist, nodes);
    document.getElementById('today').classList.add('td-ready');
}
