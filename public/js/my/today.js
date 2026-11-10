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
    'media-hub': ['Video', 'fa-play', 'https://openvibe.video'], video: ['Video', 'fa-play', 'https://openvibe.video'],
    download: ['Download', 'fa-folder', 'https://openvibe.download'], cam: ['Cam', 'fa-camera', 'https://openvibe.cam'],
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

    // Notifications and Go live are the hero's actions (renderActions); this row says who else is live.
    const out = [];
    if (!people.length && live && live.anyone_live > 0) out.push(tdEl('a', 'td-chip', [tdIcon('fa-circle-play'), ` ${tdNum(live.anyone_live)} live on OpenVibe now`], { href: 'https://openvibe.live/' }));
    chips.replaceChildren(...out);
    chips.hidden = out.length === 0;
}

/**
 * The hero's actions (11-07): one tap to what you do most, from this page. Messages and Ask Vibe open in place, in the
 * Dock (navbar.js), and are plain links where it is not there; a count shows on Notifications when you have some.
 */
function renderActions(unread) {
    const nav = document.getElementById('me-acts');
    if (!nav) return;
    const hero = document.getElementById('page-header');
    const color = currentUser && /^#[0-9a-f]{6}$/i.test(String(currentUser.profile_color || '')) ? currentUser.profile_color : null;
    if (hero && color && hero.style && hero.style.setProperty) hero.style.setProperty('--me', color);
    const streamer = !!(currentUser && currentUser.role && currentUser.role !== 'user');
    const count = unread && Number(unread.count) > 0 ? Number(unread.count) : 0;
    const dock = (tab) => () => { try { const nb = globalThis.OpenVibeNavbar; if (nb && nb.openDock) { nb.openDock(tab); return true; } } catch (e) { /* the link works */ } return false; };
    const acts = [
        streamer ? ['Go live', 'fa-tower-broadcast', 'https://openvibe.live/broadcast', 'live'] : ['Watch live', 'fa-circle-play', 'https://openvibe.live/', 'live'],
        ['Messages', 'fa-comment-dots', 'https://openvibe.chat/messages', 'chat', dock('chats')],
        ['Ask Vibe', 'fa-wand-magic-sparkles', 'https://openvibe.chat/', 'vibe', dock('vibe')],
        ['Your files', 'fa-folder', 'https://openvibe.download/files', 'files'],
        ['Codes', 'fa-code', 'https://openvibe.codes/', 'codes'],
        ['Wallet', 'fa-wallet', '/wallet', 'wallet'],
        ['Notifications', 'fa-bell', '#notifications', 'bell', () => { const bell = document.querySelector('[data-ov-bell], .openvibe-navbar-bell, #openvibe-notif-btn'); if (bell) { bell.click(); return true; } showSection('notifications'); return true; }, count],
        ['Settings', 'fa-gear', '#settings', 'gear'],
    ];
    nav.replaceChildren(...acts.map(([label, icon, href, tone, open, n]) => {
        const a = tdEl('a', 'me-act', [tdEl('span', 'me-act-ic', [tdIcon(icon)]), tdEl('span', 'me-act-t', [label])], { href, 'data-tone': tone });
        if (n) { a.append(tdEl('b', 'me-act-n', [n > 99 ? '99+' : String(n)])); a.setAttribute('aria-label', `${label}, ${n} new`); }
        if (open) a.addEventListener('click', (e) => { if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) return; if (open() && e && e.preventDefault) e.preventDefault(); });
        return a;
    }));
}

/**
 * Your status beside your name (11-07): a mirror of the dot presence.js (openvibe-shared 4.131.0) draws on your picture
 * in the bar, and one tap opens its picker. Hidden until presence.js has drawn the dot, so it never offers a picker that
 * is not there.
 */
function renderStatus() {
    const btn = document.getElementById('me-status');
    if (!btn || btn.getAttribute('data-wired')) return;
    btn.setAttribute('data-wired', '1');
    const sync = () => {
        const P = globalThis.OpenVibePresence;
        const dot = document.querySelector('.ovp-wrap .ovp-dot');
        const img = document.getElementById('openvibe-avatar-btn');
        if (!P || !dot) { btn.hidden = true; return; }
        btn.hidden = false;
        btn.setAttribute('data-state', dot.getAttribute('data-state') || 'online');
        const t = btn.querySelector('[data-me-status-t]');
        if (t) t.textContent = (img && img.getAttribute('title')) || 'Online';
    };
    btn.addEventListener('click', () => { try { globalThis.OpenVibePresence.open(); } catch (e) { /* not loaded */ } });
    const mount = document.getElementById('navbar-mount');
    if (mount && typeof MutationObserver !== 'undefined') new MutationObserver(sync).observe(mount, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'title'] });
    sync();
}

/**
 * On OpenVibe now: what the sites themselves put forward (the menu cards, frame.menu-card@1 from /api/frame) — the
 * week's trending videos, new worlds, who is live. Real entries only; a card with no entries stays out.
 */
function renderNet(frame) {
    const box = document.getElementById('td-net');
    const wrap = document.getElementById('td-net-cards');
    if (!box || !wrap) return;
    const now = Date.now();
    // Card order: live first; otherwise age score (newer is higher) plus engagement score
    // (views + replies + viewers, capped at 100). Rows with no relative age retain a declared window.
    const cards = ((frame && frame.cards) || []).filter((c) => c && Array.isArray(c.items) && c.items.some((it) => tdSafeUrl(it.url))).map((c) => {
        const live = c.site === 'live' && /live/i.test(c.title || '');
        const rows = c.items.filter((it) => tdSafeUrl(it.url)).map((it) => {
            const age = String(it.meta || '').match(/(\d+)\s*(m|min|h|d|w)\s*ago/i);
            const ageMs = age ? Number(age[1]) * ({ m: 60000, min: 60000, h: 3600000, d: 86400000, w: 604800000 }[age[2].toLowerCase()]) : null;
            const engagement = [...String(it.meta || '').matchAll(/(\d+)\s*(?:views?|replies|viewers?)/gi)].reduce((n, m) => n + Number(m[1]), 0);
            return { ...it, ageMs, engagement };
        });
        const newest = rows.reduce((min, it) => it.ageMs != null ? Math.min(min, it.ageMs) : min, Infinity);
        const score = rows.reduce((n, it) => n + Math.min(100, it.engagement), 0);
        const rank = live ? Infinity : (newest === Infinity ? 0 : 100 - Math.min(100, newest / 3600000)) + score;
        return { ...c, live, rows, newest, rank };
    }).sort((a, b) => b.rank - a.rank).slice(0, 3);
    wrap.replaceChildren(...cards.map((c) => {
        const site = TD_SITES[c.site] || [c.site || 'OpenVibe', 'fa-globe', null];
        // One row per thing: the same title by the same person folds into one, whatever address each copy has (a
        // channel's streams each have their own page: "iZoR_One's Stream" four times was one channel, 2026-11-10).
        const grouped = new Map();
        for (const row of c.rows.sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity))) {
            const key = `${String(row.title || '').trim().toLowerCase()}\u0000${row.person || row.author || ''}`;
            const old = grouped.get(key);
            if (old) old.count++;
            else grouped.set(key, { ...row, count: 1 });
        }
        const stale = c.newest !== Infinity && c.newest > 7 * 86400000;
        const visibleRows = [...grouped.values()].slice(0, stale ? 2 : 5);
        // A ranked card (no row has an age: "most watched this week") says its window once, in its head, not on every row.
        const ranked = c.newest === Infinity;
        const streams = /^(live|media-hub|video)$/.test(String(c.site || ''));
        const list = tdEl('ol', 'td-net-list', visibleRows.map((it, i) => {
            const src = it.image && tdSafeUrl(it.image.src);
            const when = ranked ? '' : String(it.meta || '').match(/\d+\s*(?:m|min|h|d|w)\s*ago/i)?.[0] || 'recently';
            const times = it.count > 1 ? (streams ? `${it.count} streams this week` : `${it.count} times`) : '';
            const detail = [times, when].filter(Boolean).join(' · ');
            return tdEl('li', '', [tdEl('a', 'td-net-row', [
                tdEl('span', 'td-net-i', [String(i + 1)]),
                src ? tdEl('img', 'td-net-thumb', null, { src, alt: '', width: 64, height: 36, loading: 'lazy', decoding: 'async' }) : null,
                tdEl('span', 'td-net-t', [tdEl('b', '', [String(it.title || '')]), detail ? tdEl('small', '', [detail]) : null]),
            ], { href: tdSafeUrl(it.url) })]);
        }));
        const more = c.more && tdSafeUrl(c.more.url) ? tdEl('a', 'td-more', [String(c.more.label || 'More')], { href: tdSafeUrl(c.more.url) }) : null;
        return tdEl('section', 'td-box td-net-card', [
            // The head's second line: the site, then the ranking window, or for a card nothing new reached in a week how long
            // it has been quiet (muted: it explains why the card is short; it is not news).
            tdEl('div', 'td-net-h', [tdEl('span', 'td-site-ic', [tdIcon(site[1])]), tdEl('span', 'td-net-ht', [tdEl('b', '', [String(c.title || site[0])]),
                tdEl('small', '', [site[0], ranked ? tdEl('span', 'td-net-when', [` · ${c.window || 'most watched this week'}`]) : null,
                    stale ? tdEl('span', 'td-net-quiet', [` · quiet for ${Math.floor(c.newest / 86400000)} days`]) : null])]), more]),
            list,
        ], { 'data-site': String(c.site || '') });
    }));
    box.hidden = cards.length === 0;
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
    line.replaceChildren();
    if (t) {
        // The server makes the words (billing.money-reason@1). The raw key never reaches this line:
        // an undeclared reason already reads "for something on <site>".
        const phrase = t.reason_text || `for something on ${t.reason_site || 'OpenVibe'}`;
        line.append(document.createTextNode(`${t.delta > 0 ? '+' : ''}${tdNum(t.delta)} `));
        if (t.reason_subject && t.reason_subject.url) {
            const a = document.createElement('a');
            a.href = t.reason_subject.url; a.textContent = phrase; a.target = '_blank'; a.rel = 'noopener';
            line.append(a);
        } else line.append(document.createTextNode(phrase));
        line.append(document.createTextNode(` · ${tdAgo(t.created_at)}`));
    }
    line.hidden = !t;
    box.hidden = false;
}

/** Your sites: the ones you use most (history counts, then the switcher's pins and recents), and what to try next. */
function renderSites(hist, sites, tryNext) {
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
    // Try next from Report's similar-use answer (server/home/try-next.js): two sites the person does not already use,
    // each with the reason it is there. A failed read keeps the old fixed list, and a true empty answer shows nothing.
    const fromApi = tryNext && Array.isArray(tryNext.items) ? tryNext.items.filter((item) => item && tdSafeUrl(item.url) && !mine.includes(item.id) && !counts.has(item.id)).slice(0, 2) : [];
    const tries = fromApi.length
        ? fromApi.map((item) => ({ id: item.id, name: item.name, url: item.url, reason: item.reason }))
        : TD_TRY.filter(([id]) => !mine.includes(id) && !counts.has(id)).slice(0, 2).map(([id, what, why]) => {
            const [, , url] = TD_SITES[id];
            return { id, name: what, url, reason: why };
        });
    const tryBox = document.getElementById('td-try');
    const tryRows = tries.map((item) => {
        const known = TD_SITES[item.id];
        const icon = known ? known[1] : 'fa-globe';
        const url = tdSafeUrl(item.url) || (known ? known[2] : null);
        if (!url) return null;
        const name = String(item.name || (known && known[0]) || item.id || '');
        return tdEl('a', 'td-try', [tdEl('span', 'td-site-ic', [tdIcon(icon)]), tdEl('span', 'td-try-t', [tdEl('b', '', [name]), tdEl('small', '', [String(item.reason || '')])])], { href: url });
    }).filter(Boolean);
    tryBox.replaceChildren(...tryRows);
    tryBox.hidden = tryRows.length === 0;
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
    const box = document.getElementById('td-nums');
    if (box) box.hidden = cells.length === 0;
}


/* ── Needs you (plan OpenVibe_Seven_Domains_Plan §4) ─────────────────────────────────────────────
   The Action Center's waiting bucket, above the hero. One button per item, its primary action:
   approve/retry go through POST /api/v1/me/actions/:service/:id/:action; open is the item's page.
   A waiting row is plain text (title, summary) from the authority, so it is built with DOM nodes. */
const NY_ICONS = { actor: 'fa-robot', codes: 'fa-code', ai: 'fa-wand-magic-sparkles', domains: 'fa-globe', network: 'fa-shield-halved', run: 'fa-terminal' };

function nyHref(item) {
    if (item && item.service === 'network') return '#approvals';
    const href = String((item && item.href) || '');
    return /^https:\/\//.test(href) ? href : '#approvals';
}

// An approval is never one tap from here: the hub shows a line, and a step may delete, spend or send. Review opens the
// approval itself (what exactly runs, Approve or Decline). Try again stays one tap: it only repeats what already ran.
function nyButton(item, action) {
    const label = action === 'approve' ? 'Review' : action === 'retry' ? 'Try again' : 'Open';
    if (action !== 'retry') {
        const href = nyHref(item);
        const a = document.createElement('a');
        a.className = 'ny-btn';
        a.setAttribute('href', href);
        a.href = href;
        a.textContent = label;
        if (a.getAttribute('href').startsWith('#')) {
            a.addEventListener('click', (e) => { e.preventDefault(); showSection(a.getAttribute('href').slice(1)); });
        } else {
            a.target = '_blank';
            a.rel = 'noopener';
        }
        return a;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ny-btn';
    b.textContent = label;
    b.addEventListener('click', () => nyDo(item, action, b));
    return b;
}

async function nyDo(item, action, button) {
    if (!item || !item.service || !item.id) return;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = action === 'retry' ? 'Trying…' : 'Approving…';
    try {
        await apiFetch(`/api/v1/me/actions/${encodeURIComponent(item.service)}/${encodeURIComponent(item.id)}/${action}`, { method: 'POST' });
        const row = button.closest('.ny-item');
        if (row) row.remove();
        const left = document.querySelectorAll('#needs-you-list .ny-item').length;
        const box = document.getElementById('needs-you');
        const sub = document.getElementById('needs-you-sub');
        if (sub) sub.textContent = left ? `${left} more waiting` : '';
        if (!left && box) box.hidden = true;
        if (typeof toast === 'function') toast(action === 'retry' ? 'Trying it again' : 'Approved', 'success');
    } catch (err) {
        button.disabled = false;
        button.textContent = label;
        if (typeof toast === 'function') toast(err && err.message ? err.message : 'That did not go through', 'error');
    }
}

function renderNeedsYou(doc) {
    const box = document.getElementById('needs-you');
    const list = document.getElementById('needs-you-list');
    if (!box || !list) return;
    const items = doc && doc.buckets && Array.isArray(doc.buckets.waiting) ? doc.buckets.waiting : [];
    if (!items.length) { box.hidden = true; list.replaceChildren(); return; }
    const sub = document.getElementById('needs-you-sub');
    if (sub) sub.textContent = `${items.length} thing${items.length === 1 ? '' : 's'} waiting`;
    list.replaceChildren(...items.map((item) => {
        const row = document.createElement('article');
        row.className = 'ny-item';
        const icon = document.createElement('span');
        icon.className = 'ny-ic';
        const i = document.createElement('i');
        i.className = `fa-solid ${NY_ICONS[item.service] || 'fa-circle-exclamation'}`;
        i.setAttribute('aria-hidden', 'true');
        icon.append(i);
        const body = document.createElement('div');
        body.className = 'ny-body';
        const title = document.createElement('h3');
        title.textContent = item.title || 'Something needs you';
        body.append(title);
        if (item.summary) {
            const summary = document.createElement('p');
            summary.textContent = item.summary;
            body.append(summary);
        }
        // The agent by its name; a raw id (agt_…, app_…) says nothing to a person, so it is left out.
        if (item.agent && !/^(agt|app|svc|usr)[_0-9A-HJKMNP-TV-Z]{20,}$/i.test(String(item.agent))) {
            const meta = document.createElement('span');
            meta.className = 'ny-meta';
            meta.textContent = item.agent;
            body.append(meta);
        }
        const actions = Array.isArray(item.actions) ? item.actions : [];
        const primary = actions.includes('approve') ? 'approve' : actions.includes('retry') ? 'retry' : 'open';
        row.append(icon, body, nyButton(item, primary));
        return row;
    }));
    box.hidden = false;
}

async function loadToday() {
    if (!document.getElementById('today')) return;
    renderGreeting();
    if (typeof isAnonSession === 'function' && isAnonSession()) return;   // a guest identity keeps no history, follows or coins
    const quiet = (p) => p.catch(() => null);
    renderActions(null);
    renderStatus();
    const [acts, live, hist, coins, last, unread, sites, nodes, frame, tryNext] = await Promise.all([
        quiet(apiFetch('/api/v1/me/actions')),
        quiet(apiFetch('/api/v1/me/live-follows')),
        quiet(apiFetch('/api/history?limit=30')),
        quiet(apiFetch('/api/coins/me?with=vibes')),
        quiet(apiFetch('/api/coins/me/history?limit=1')),
        quiet(apiFetch('/api/notifications/unread-count')),
        quiet(apiFetch('/api/themes/me/sites')),
        quiet(apiFetch('/api/v1/me/nodes')),
        quiet(apiFetch('/api/frame?host=openvibe.network')),
        quiet(apiFetch('/api/v1/me/try-next?limit=3')),
    ]);
    globalThis.__tdUnread = unread;
    renderNeedsYou(acts);
    renderActions(unread);
    renderNet(frame);
    renderNow(live, unread);
    renderContinue(hist);
    renderMoney(coins, last);
    renderSites(hist, sites, tryNext);
    renderStuff(live, hist, nodes);
    document.getElementById('today').classList.add('td-ready');
}
