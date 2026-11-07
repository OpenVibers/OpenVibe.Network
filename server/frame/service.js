'use strict';
// ═══════════════════════════════════════════════════════════════
// OpenVibe Frame data: what the navbar and footer of every site show.
//
//   GET /api/frame?host=<hostname>     public, CORS *, max-age=600, ETag
//   GET /api/frame/pulse               public, CORS *, max-age=30: { live_now, watching, sites, views_7d, live, updated }
//   POST /api/frame/menu-click         public, CORS *, text/plain, max 512 bytes, 60/min per IP: one menu click counted
//   → { updated, nav: [{ id, name, url, icon, tagline, group, of? }], open sites, most used first (of: a product
//                                                                      on its own domain, served by that site)
//       next: { [siteId]: [siteId, …] },                              up to 6 places people go next
//       discover_ids: [siteId, …],                                    the open sites, ordered for discovery
//       menu: { beacon },                                             where the shared menu sends its clicks
//       groups: [{ id, name }],                                       the launcher's sections, in order
//       soon: [{ id, name, url, icon, state }],                       state: internal | placeholder
//       footer: { blurb, discover: [{ name, url }], popular: [{ name, url }], legal: { terms, privacy, dmca } } }
//
// Ranking: page views and visitors from each service's own analytics (last 7 days) plus signed-in
// cross-site history, refreshed every 30 minutes and kept in the database so a restart or an
// unreachable service never reorders the network at random. Only totals cross the wire.
// Copy: once a day OpenVibe.AI (network.site_copy) may write a blurb per site and pick "discover"
// links BY ID from a list we supply; ids resolve to our own URLs here, text is stripped, length-capped
// and screened. AI unreachable, failing or answering badly → the last good copy stays (kept in
// frame_cache across restarts), or the hand-written copy when there has never been one.
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const { SITES, siteForHost, GROUPS, groupOf, PRODUCTS, ICON_ALIAS, MENU_LINE, MENU_NAME, fullName } = require('./sites');
const toolsCatalog = require('../domains/catalog');

const RANK_MS = 30 * 60_000, COPY_MS = 24 * 60 * 60_000;
const BANNED = /\b(free|\$0|no ads|ad[- ]free|no cost|gratis)\b|https?:|www\.|[<>{}]/i;
const BASE_WEIGHT = { live: 7, tools: 6, space: 5, community: 4, games: 3, media: 2, network: 1 };   // cold-start order only
const MENU_BEACON = 'https://openvibe.network/api/frame/menu-click';
const MENU_SECTIONS = new Set(['places', 'here', 'next', 'discover', 'you', 'tools', 'recent', 'all', 'back', 'live']);
// The shared menu's item kinds (openvibe-shared/search.js siteItem, toolRow, …) plus the 'open' impression beacon it
// may send later. The count itself is stored by section and destination, not by kind.
const MENU_KINDS = new Set(['site', 'page', 'action', 'results', 'tool', 'family', 'you', 'dock', 'live', 'recent', 'history', 'result', 'open']);

// Shared 4.128.0's hand-picked "Next from <site>" relations (search.js NEXT_OF), the seed for a site without moves
// yet. Product ids (pics, download) are dropped: `next` carries site ids only.
const NEXT_SEED = {
    live: ['media-hub', 'community', 'chat', 'tools', 'bot', 'vip'],
    'media-hub': ['live', 'pics', 'community', 'download'],
    community: ['live', 'chat', 'tools', 'space'],
    chat: ['live', 'community', 'media-hub', 'games'],
    tools: ['live', 'community', 'download', 'chat'],
    network: ['live', 'media-hub', 'community', 'design'],
    games: ['live', 'casino', 'quest', 'chat'],
    bot: ['live', 'actor', 'codes', 'run'],
    pics: ['media-hub', 'download', 'live', 'design'],
    download: ['pics', 'media-hub', 'tools', 'zone'],
    design: ['space', 'website', 'pics', 'network'],
    space: ['website', 'design', 'community', 'domains'],
};

// History service names that are not Frame site ids. 'media' is what Video's pages wrote (the brief's mapping);
// 'pastes' is Community's. The URL host is the fallback, so a service whose id differs (openre → stream) still maps.
const HISTORY_SITE = { pastes: 'community', media: 'media-hub', video: 'media-hub', 'media-hub': 'media-hub', openre: 'stream', download: 'media-hub', pics: 'media-hub', homes: 'rent' };

const hostOfUrl = (url) => { try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; } };
const hostOfValue = (value) => {
    const s = String(value || '').trim();
    if (!s) return '';
    try { return new URL(s.includes('://') ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};
/** The open site a hostname belongs to, including products served on their own domains (openvibe.pics → media-hub). */
function siteForDestination(hostname) {
    const h = hostOfValue(hostname);
    if (!h) return null;
    const site = siteForHost(h);
    if (site) return site;
    const product = PRODUCTS.find((p) => h === p.host || h.endsWith('.' + p.host));
    return product ? SITES.find((s) => s.id === product.of) || null : null;
}
/** A user_history row's Frame site id: service alias first, the site id itself, then the row's URL host. */
function historySiteId(service, url) {
    const key = String(service || '').toLowerCase();
    if (HISTORY_SITE[key]) return HISTORY_SITE[key];
    if (SITES.some((s) => s.id === key && s.status === 'open')) return key;
    const site = siteForDestination(hostOfUrl(url));
    return site ? site.id : null;
}

/**
 * Footer copy comes from OpenVibe.AI's network.site_copy workflow (roadmap Wave 13, ADR-015), called with a
 * self-signed Network service token (sub svc:network, aud openvibe.ai, cap ai.run.create, ns network.*).
 * There is no other source: Live's /internal/ai/site-copy is no longer called.
 */
function aiSiteCopy({ privateKey, issuer, aiUrl }) {
    const { serviceAuth } = require('openvibe-contracts');
    let cached = null;
    function token() {
        const now = Math.floor(Date.now() / 1000);
        if (cached && cached.exp - 60 > now) return cached.token;
        const claims = { iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.ai'], cap: ['ai.run.create', 'ai.run.read'], ns: ['network.*'], iat: now, exp: now + 300, jti: `tok_${require('crypto').randomBytes(12).toString('hex')}` };
        cached = { token: serviceAuth.signServiceToken(claims, privateKey), exp: claims.exp };
        return cached.token;
    }
    return async function run(body) {
        const r = await fetch(`${aiUrl}/api/v1/runs?wait=90000`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify({ workflow: 'network.site_copy', input: body }),
            signal: AbortSignal.timeout(100_000),
        });
        if (!r.ok) return null;
        const j = await r.json().catch(() => null);
        const run = j && j.run;
        if (!run || run.status !== 'succeeded' && run.status !== 'cached' || !run.output || !Array.isArray(run.output.sites)) return null;
        // ai.run@1: the model that answered is provenance.model (null for a cached or unresolved run);
        // run.route is the provider route { key, version }. There is no top-level run.model.
        const prov = run.provenance && typeof run.provenance === 'object' ? run.provenance : {};
        const route = run.route && typeof run.route === 'object' ? run.route.key : prov.route;
        return { sites: run.output.sites, model: prov.model || route || 'openvibe.ai' };
    };
}

async function createFrameService(db, config, analytics, { privateKey = null, issuer = null, selfToken = () => null, aiUrl = process.env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700' } = {}) {
    const fromAi = privateKey && issuer ? aiSiteCopy({ privateKey, issuer, aiUrl: String(aiUrl).replace(/\/+$/, '') }) : null;
    // frame_cache and frame_hits are migrations/NNNN_*.sql (plan T2). The old chrome_cache/chrome_hits
    // rename was a SQLite-only step and is not repeated here.
    const bump = db.prepare("INSERT INTO frame_hits (day, host, hits) VALUES (substring(ov_now(), 1, 10), ?, 1) ON CONFLICT(day, host) DO UPDATE SET hits = frame_hits.hits + 1");
    const load = async (k) => { try { const r = await db.prepare('SELECT value, updated_at FROM frame_cache WHERE key = ?').get(k); return r ? { value: JSON.parse(r.value), at: Date.parse(r.updated_at + 'Z') || 0 } : null; } catch { return null; } };
    const save = async (k, v) => await db.prepare('INSERT INTO frame_cache (key, value, updated_at) VALUES (?, ?, ov_now()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = ov_now()').run(k, JSON.stringify(v));

    const savedRank = await load('rank') || {};
    let rank = savedRank.value || { scores: {}, tools: [] };
    let rankedAt = savedRank.value ? savedRank.at || null : null;
    let copy = (await load('copy') || {}).value || { sites: {} };
    let version = Date.now();
    const openIds = () => new Set(SITES.filter((s) => s.status === 'open').map((s) => s.id));
    /** Only open sites, never the site itself, at most six; drops duplicates and anything from an older seed. */
    function cleanNext(map) {
        const ids = openIds(); const out = {};
        for (const [from, list] of Object.entries(map && typeof map === 'object' ? map : {})) {
            if (!ids.has(from)) continue;
            const seen = new Set([from]); const keep = [];
            for (const id of Array.isArray(list) ? list : []) {
                if (!ids.has(id) || seen.has(id)) continue;
                seen.add(id); keep.push(id); if (keep.length >= 6) break;
            }
            if (keep.length) out[from] = keep;
        }
        return out;
    }
    /** The hand-picked graph, plus this site's group when the seed leaves room: every open site gets a list before
     *  the first move is counted, so the menu's "Next from here" is never empty on a cold network. */
    function seedNext() {
        const ids = openIds(); const map = {};
        for (const site of SITES.filter((s) => s.status === 'open')) {
            const out = []; const seen = new Set([site.id]);
            const add = (id) => { if (out.length < 6 && ids.has(id) && !seen.has(id)) { seen.add(id); out.push(id); } };
            for (const id of NEXT_SEED[site.id] || []) add(id);
            for (const s of SITES) if (s.status === 'open' && groupOf(s.id) === groupOf(site.id)) add(s.id);
            map[site.id] = out;
        }
        return map;
    }
    let nextMap = cleanNext((await load('next') || {}).value) || seedNext();
    if (!Object.keys(nextMap).length) nextMap = seedNext();
    let discover = (await load('discover') || {}).value || null;
    if (!discover || !Array.isArray(discover.ids)) discover = { ids: null, at: null, seed: 0 };   // filled from the frame order below
    let menuOpensSeen = 0;   // 'open' beacons, until the client sends them; an impression estimate, never stored by person

    const svcUrl = (name, fallback) => (config.services && config.services[name] && config.services[name].internalUrl) || fallback;
    async function getJson(url, headers, timeoutMs = 6000) {
        try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); return r.ok ? await r.json() : null; } catch { return null; }
    }

    async function refreshRank() {
        const scores = Object.assign({}, rank.scores);
        // Live runs its own navbar and its own analytics: ask it for totals (live.analytics.read, totals only).
        const liveToken = selfToken('openvibe.live', ['live.analytics.read']);
        const live = liveToken ? await getJson(`${svcUrl('live', 'http://127.0.0.1:3000')}/internal/analytics-summary?days=7`, { Authorization: `Bearer ${liveToken}` }) : null;
        if (live && live.summary) scores.live = Math.round(Number(live.summary.total_pageviews) || 0);
        // Everything else: the navbar's page-view beacon, summed per site over 7 days.
        let tools = rank.tools || [];
        try {
            const rows = await db.prepare("SELECT host, SUM(hits)::bigint AS n FROM frame_hits WHERE day >= substring(datetime('now', '-7 days'), 1, 10) GROUP BY host").all();
            const perSite = {}; const perTool = new Map();
            const { catalog } = toolsCatalog.peek();
            const toolOfHost = new Map();
            for (const t of catalog.tools) for (const h of [t.hosts && t.hosts.canonical, t.hosts && t.hosts.short, ...((t.hosts && t.hosts.aliases) || [])]) if (h) toolOfHost.set(h, t.id);
            for (const r of rows) {
                const site = siteForHost(r.host) || (toolOfHost.has(r.host) ? { id: 'tools' } : null);
                if (!site) continue;
                perSite[site.id] = (perSite[site.id] || 0) + r.n;
                const tool = toolOfHost.get(r.host); if (tool) perTool.set(tool, (perTool.get(tool) || 0) + r.n);
            }
            for (const [id, n] of Object.entries(perSite)) if (id !== 'live') scores[id] = Math.round(id === 'network' ? n * 0.5 : n);   // the account desk is not a destination
            if (perTool.size) tools = [...perTool.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(x => x[0]);
        } catch { /* */ }
        // Signed-in history is a second opinion that also covers hosts without the shared navbar. Service names that
        // differ from site ids are mapped (Video's 'media' → media-hub, Community's 'pastes' → community), and two
        // services on one site add up instead of overwriting each other.
        try {
            const bySvc = await db.prepare("SELECT service, COUNT(*) AS n, COUNT(DISTINCT user_id) AS u FROM user_history WHERE created_at > datetime('now', '-14 days') GROUP BY service").all();
            for (const r of bySvc) {
                const id = historySiteId(r.service, null) || (SITES.some((s) => s.id === r.service) ? r.service : null);
                if (!id) continue;
                scores[id + ':history'] = (scores[id + ':history'] || 0) + Number(r.n) + 5 * Number(r.u);
            }
        } catch { /* table appears on first history write */ }
        rank = { scores, tools };
        await save('rank', rank);
        // The menu's "next" graph and the discovery order are refreshed with the ranking, kept in frame_cache too.
        try { nextMap = await refreshNext(); await save('next', nextMap); } catch { /* keep the last graph */ }
        try { discover = await refreshDiscover(); await save('discover', discover); } catch { /* keep the last order */ }
        version = Date.now(); rankedAt = Date.now();
    }

    /** Signed-in cross-site moves, last 30 days: consecutive history rows of one person on different services, mapped
     *  to Frame sites. Up to six destinations per site, by distinct people first and move count second. Observed moves
     *  lead; Shared's hand-picked relations fill a cold site and then this site's group fills any remaining room. */
    async function refreshNext() {
        const rows = await db.prepare("SELECT user_id, service, url FROM user_history WHERE created_at > datetime('now', '-30 days') ORDER BY user_id, updated_at, id").all();
        const ids = openIds(); const pairs = new Map();
        let lastUser = null, previous = null;
        for (const r of rows) {
            const user = String(r.user_id);
            if (user !== lastUser) { lastUser = user; previous = null; }
            const site = historySiteId(r.service, r.url);
            const current = site && ids.has(site) ? site : null;
            if (previous && current && previous !== current) {
                const key = previous + '>' + current;
                let pair = pairs.get(key);
                if (!pair) { pair = { from: previous, to: current, people: new Set(), moves: 0 }; pairs.set(key, pair); }
                pair.people.add(user); pair.moves++;
            }
            // An unmapped row breaks the chain: live → an unknown service → community is not a live → community move.
            previous = current;
        }
        const byFrom = new Map();
        for (const pair of pairs.values()) {
            if (!byFrom.has(pair.from)) byFrom.set(pair.from, []);
            byFrom.get(pair.from).push(pair);
        }
        const seed = seedNext(); const map = {};
        for (const site of SITES.filter((s) => s.status === 'open')) {
            const out = []; const seen = new Set([site.id]);
            const add = (id) => { if (out.length < 6 && ids.has(id) && !seen.has(id)) { seen.add(id); out.push(id); } };
            const moved = (byFrom.get(site.id) || []).sort((a, b) => b.people.size - a.people.size || b.moves - a.moves || a.to.localeCompare(b.to));
            for (const pair of moved) add(pair.to);
            for (const id of seed[site.id] || []) add(id);
            map[site.id] = out;
        }
        return cleanNext(map);
    }

    // ── Discovery: Thompson sampling on menu clicks ────────────────────────────────────────────────────────────────
    // The client does not send impressions yet. They are estimated from the menu's opens: every navbar page view is a
    // chance to open the menu (frame_hits, 30 days), the menu shows two Discover places, and the estimate is spread
    // evenly over the open sites. A click on a place raises its Beta(1 + clicks, 1 + misses) posterior, so places that
    // are clicked when shown come up more often; every site still has a positive chance and everyone stays in the list.
    // A later `kind: 'open'` beacon can report the real opens; until then menuOpensSeen is 0 and the estimate decides.
    function mulberry32(a) {
        return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    }
    function sampleGamma(k, rnd) {
        if (k < 1) return sampleGamma(k + 1, rnd) * Math.pow(rnd() || 1e-12, 1 / k);
        const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
        for (;;) {
            let x, v;
            do { let u = 0, w = 0; while (u === 0) u = rnd(); while (w === 0) w = rnd(); x = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); v = 1 + c * x; } while (v <= 0);
            v = v * v * v;
            const u = rnd();
            if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
        }
    }
    const sampleBeta = (a, b, rnd) => { const x = sampleGamma(a, rnd), y = sampleGamma(b, rnd); return x + y > 0 ? x / (x + y) : 0.5; };
    async function refreshDiscover() {
        let clicks = new Map(), totalClicks = 0;
        try {
            const rows = await db.prepare("SELECT to_site, SUM(n)::bigint AS n FROM menu_clicks WHERE section = 'discover' AND day >= substring(datetime('now', '-30 days'), 1, 10) GROUP BY to_site").all();
            for (const r of rows) { const n = Number(r.n) || 0; if (n > 0) { clicks.set(r.to_site, n); totalClicks += n; } }
        } catch { /* migration not applied yet, or no clicks */ }
        const open = orderedOpen();
        if (!totalClicks) return { ids: open.map((s) => s.id), at: Date.now(), seed: 0, impressions: 0 };
        let opens = menuOpensSeen;
        try { const r = await db.prepare("SELECT COALESCE(SUM(hits), 0)::bigint AS n FROM frame_hits WHERE day >= substring(datetime('now', '-30 days'), 1, 10)").get(); opens = Math.max(opens, Number(r && r.n) || 0); } catch { /* */ }
        opens = Math.max(opens, totalClicks);
        const impressions = Math.max(1, Math.round(opens * 2 / Math.max(1, open.length)));
        const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
        const rnd = mulberry32(seed);
        const scored = open.map((s, i) => {
            const n = clicks.get(s.id) || 0;
            return { id: s.id, i, score: sampleBeta(1 + n, 1 + Math.max(0, impressions - n), rnd) };
        }).sort((a, b) => b.score - a.score || a.i - b.i);
        return { ids: scored.map((x) => x.id), at: Date.now(), seed, impressions };
    }

    const scoreOf = (id) => (rank.scores[id] || 0) + 3 * (rank.scores[id + ':history'] || 0);
    function orderedOpen() {
        const open = SITES.filter(s => s.status === 'open');
        // Real use decides, compared raw: normalising by one service's own analytics scale made Live's tens of
        // thousands of page views flatten every other site to nearly zero, so the cold-start BASE_WEIGHT decided the
        // order and Video (openvibe.video) sat under Tools, Community and Space despite 2,687 hits in 7 days (11-07).
        // The base weight now only breaks ties between sites with equal use and orders a network with no use yet.
        return open.map(s => ({ s, score: scoreOf(s.id), base: BASE_WEIGHT[s.id] || 0 }))
            .sort((a, b) => b.score - a.score || b.base - a.base).map(x => x.s);
    }

    function linkPool() {
        const { catalog } = toolsCatalog.peek();
        const pool = new Map();
        for (const s of SITES.filter(x => x.status === 'open')) pool.set('site:' + s.id, { name: fullName(s), url: `https://${s.host}/`, about: s.tagline });
        for (const f of catalog.families) if (f.path) pool.set('family:' + f.id, { name: f.name, url: 'https://openvibe.tools' + f.path, about: f.tagline });
        for (const t of catalog.tools) pool.set('tool:' + t.id, { name: t.name, url: t.url, about: t.tagline });
        return pool;
    }
    function popularTools(limit) {
        const { catalog } = toolsCatalog.peek();
        const byId = new Map(catalog.tools.map(t => [t.id, t]));
        const seed = ['yt', 'convert', 'mergepdf', 'jsonfmt', 'mp3', 'dns', 'whois', 'compress'];
        return [...new Set([...(rank.tools || []), ...seed])].map(id => byId.get(id)).filter(Boolean).slice(0, limit).map(t => ({ name: t.name, url: t.url }));
    }

    async function refreshCopy() {
        if (!fromAi) return;
        const pool = linkPool();
        const popular = new Set(popularTools(12).map(t => t.url));
        const links = [...pool.entries()].filter(([id, l]) => !id.startsWith('tool:') || popular.has(l.url)).map(([id, l]) => ({ id, name: l.name, about: l.about }));
        const body = { sites: SITES.filter(s => s.status === 'open').map(s => ({ id: s.id, name: fullName(s), what: s.what, popular: s.id === 'tools' ? popularTools(6).map(t => t.name) : [] })), links };
        let j = null;
        try { j = await fromAi(body); } catch { j = null; }
        if (!j || !Array.isArray(j.sites)) return;   // keep the last good copy
        const next = {};
        for (const row of j.sites) {
            const site = SITES.find(s => s.id === row.id); if (!site) continue;
            const blurb = String(row.blurb || '').replace(/\s+/g, ' ').trim();
            const picks = (Array.isArray(row.picks) ? row.picks : []).filter(id => pool.has(id) && id !== 'site:' + site.id).slice(0, 4);
            if (blurb.length < 20 || blurb.length > 170 || BANNED.test(blurb)) continue;      // screened out: the hand-written copy stays
            next[site.id] = { blurb, picks };
        }
        if (Object.keys(next).length) { copy = { sites: next, model: String(j.model || '').slice(0, 60) }; await save('copy', copy); version = Date.now(); }
    }

    function payloadFor(hostname) {
        const site = siteForHost(hostname) || SITES.find(s => s.id === 'network');
        const open = orderedOpen(); const pool = linkPool();
        const ai = copy.sites[site.id];
        const footerDiscover = (ai ? ai.picks.map(id => pool.get(id)) : open.filter(s => s.id !== site.id).slice(0, 4).map(s => pool.get('site:' + s.id))).filter(Boolean).map(l => ({ name: l.name, url: l.url }));
        // Legal documents live on the site's own apex, so each domain answers for itself, once it serves them: a site
        // whose /privacy does not answer gets the network-wide documents here instead of three links that 404.
        const legalBase = legalOwn.get(site.host) === false ? 'https://openvibe.network' : `https://${site.host}`;
        const next = cleanNext(nextMap);
        const discoverIds = discover && Array.isArray(discover.ids) && discover.ids.length ? discover.ids.filter(id => open.some(s => s.id === id)) : open.map(s => s.id);
        return {
            updated: new Date(version).toISOString(), site: { id: site.id, name: site.name, host: site.host, status: site.status, state: site.state },
            // Every open site, most used first, each followed by the products it serves on their own domains (`of`).
            nav: open.flatMap(s => [s, ...PRODUCTS.filter(p => p.of === s.id)]).map(s => ({ id: s.id, name: MENU_NAME[s.id] || s.name, url: `https://${s.host}/`, icon: ICON_ALIAS[s.icon] || s.icon, tagline: MENU_LINE[s.id] || s.tagline, group: groupOf(s.id), ...(s.of ? { of: s.of } : {}) })),
            // The menu's data: where people go next from each open site (totals only, no person), the fair discovery
            // order, and the click beacon (Shared sends it only when this object is present).
            next, discover_ids: discoverIds,
            menu: { beacon: MENU_BEACON },
            groups: GROUPS.map(g => ({ id: g.id, name: g.name })),
            // state: 'internal' (runs on loopback, the domain still shows a placeholder) or 'placeholder' (planned).
            soon: SITES.filter(s => s.status === 'soon').map(s => ({ id: s.id, name: s.name, url: `https://${s.host}/`, icon: s.icon, state: s.state })),
            footer: { blurb: (ai && ai.blurb) || site.what, ai: !!ai, discover: footerDiscover, popular: popularTools(8), legal: { terms: legalBase + '/terms', privacy: legalBase + '/privacy', dmca: legalBase + '/dmca' } },
        };
    }

    const router = express.Router();
    const cache = new Map();
    router.get('/', (req, res) => {
        const host = String(req.query.host || '').toLowerCase().slice(0, 255);
        const site = siteForHost(host) || { id: 'network' };
        let e = cache.get(site.id);
        if (!e || e.version !== version) { const body = JSON.stringify(payloadFor(host)); e = { version, body, etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 18) + '"' }; cache.set(site.id, e); }
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=600, stale-while-revalidate=86400', ETag: e.etag, 'Content-Type': 'application/json; charset=utf-8' });
        if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
        res.send(e.body);
    });

    // GET /api/frame/pulse — the network right now, for the footer's live line (openvibe-shared footer.js; owner,
    // 2026-10-27: "update and improve the footer so it feels more alive and has some stats"): streams live on
    // OpenVibe.Live and the people watching them (Live's public list), the open sites, and last week's page views across
    // them (the ranking's totals). Numbers only; public, CORS *, cached 30 s. A part Live does not answer is null.
    let pulse = null;
    let pulseAt = 0;
    let pulseInflight = null;
    /** Public live streams only: Live's list is public, but a row marked unlisted/private never reaches a navbar. */
    const publicLive = (st) => {
        if (!st || typeof st !== 'object') return false;
        if (st.visibility && String(st.visibility).toLowerCase() !== 'public') return false;
        if (st.is_public === false || st.unlisted === true || st.is_unlisted === true || st.listed === false) return false;
        return true;
    };
    const viewersOf = (st) => Math.max(0, Number(st.total_viewer_count != null ? st.total_viewer_count : st.viewer_count) || 0);
    async function readPulse() {
        const d = await getJson(`${svcUrl('live', 'http://127.0.0.1:3000')}/api/streams`);
        const streams = d && Array.isArray(d.streams) ? d.streams.filter(publicLive) : null;
        const live = streams ? streams.filter((st) => /^[A-Za-z0-9_-]{1,40}$/.test(String(st.username || ''))).slice(0, 8).map((st) => {
            const avatar = /^https:\/\//i.test(String(st.avatar_url || '')) ? String(st.avatar_url).slice(0, 500) : null;
            return {
                name: String(st.display_name || st.username || st.title || '').replace(/\s+/g, ' ').trim().slice(0, 100) || st.username,
                url: `https://openvibe.live/@${encodeURIComponent(st.username)}`,
                viewers: viewersOf(st),
                ...(avatar ? { avatar } : {}),
            };
        }) : null;
        const views = Object.entries(rank.scores || {}).filter(([k]) => !k.includes(':')).reduce((a, [, n]) => a + (Number(n) || 0), 0);
        return {
            live_now: streams ? streams.length : null,
            watching: streams ? streams.reduce((a, st) => a + viewersOf(st), 0) : null,
            sites: orderedOpen().length,
            views_7d: views > 0 ? Math.round(views) : null,
            live,
            updated: new Date().toISOString(),
        };
    }
    router.get('/pulse', async (req, res) => {
        if (!pulse || Date.now() - pulseAt > 30_000) {
            pulseInflight = pulseInflight || readPulse().then((p) => { pulse = p; pulseAt = Date.now(); }).catch(() => {}).finally(() => { pulseInflight = null; });
            await pulseInflight;
        }
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120', 'Content-Type': 'application/json; charset=utf-8' });
        res.send(JSON.stringify(pulse || { live_now: null, watching: null, sites: orderedOpen().length, views_7d: null, live: null, updated: null }));
    });

    // GET /api/frame/suggest?q=&owner=&limit= — the navbar's magnifier (openvibe-shared search.js): OpenVibe.Search's
    // suggestions, asked through Network because every site's connect-src already lets the navbar reach
    // openvibe.network, and 33 of them refused search.openvibe.network (2026-10-28). Anonymous, as the browser's own call
    // would be (public, published documents only); the person's address goes along so Search's per-person limit stays
    // per person. Answers are kept 30 s; Search not answering is an empty list, never an error.
    const suggested = new Map();
    router.get('/suggest', async (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30', 'Content-Type': 'application/json; charset=utf-8' });
        const q = String(req.query.q || '').trim().slice(0, 100);
        const owner = /^[a-z0-9-]{1,40}$/.test(String(req.query.owner || '')) ? String(req.query.owner) : '';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
        if (!q) return res.send('{"suggestions":[]}');
        const key = `${owner}|${limit}|${q.toLowerCase()}`;
        const kept = suggested.get(key);
        if (kept && Date.now() - kept.at < 30_000) return res.send(kept.body);
        const u = new URL('/api/v1/suggest', svcUrl('search', 'http://127.0.0.1:4710'));
        u.searchParams.set('q', q);
        u.searchParams.set('limit', String(limit));
        if (owner) u.searchParams.set('owner', owner);
        const d = await getJson(u.href, req.ip ? { 'X-Forwarded-For': req.ip } : undefined);
        const body = JSON.stringify({ suggestions: d && Array.isArray(d.suggestions) ? d.suggestions : [] });
        if (d) {
            if (suggested.size >= 2000) suggested.clear();
            suggested.set(key, { at: Date.now(), body });
        }
        res.send(body);
    });

    // GET /api/frame/query?q=&scopes=&freshness=&depth=&limit=&owner=&type= — the navbar's full results (openvibe-shared
    // search.js, Enter): OpenVibe.Search's fabric (Contracts 0.225.0 search.fabric.query), asked through Network for the same
    // connect-src reason as /suggest. The restricted CORS above lets only OpenVibe's own sites send a person's token: with
    // one, Search answers as that person (their own scope, paid web providers within the daily caps) and nothing is kept;
    // without, it answers as anyone and the answer is kept 60 s. Search not answering is an empty answer, never an error.
    const SCOPES = new Set(['network', 'mine', 'web', 'news', 'images', 'video', 'products', 'people', 'places', 'code']);
    const queried = new Map();
    router.get('/query', async (req, res) => {
        res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Authorization, Origin' });
        const q = String(req.query.q || '').trim().slice(0, 200);
        const empty = '{"results":[],"groups":{},"answer":null,"citations":[],"route":{"explain":[],"cost_usd":0},"next_cursor":null}';
        if (!q) { res.set('Cache-Control', 'no-store'); return res.send(empty); }
        const scopes = String(req.query.scopes || 'network').split(',').map((x) => x.trim()).filter((x) => SCOPES.has(x)).slice(0, 10);
        const u = new URL('/api/v1/query', svcUrl('search', 'http://127.0.0.1:4710'));
        u.searchParams.set('q', q);
        u.searchParams.set('scopes', (scopes.length ? scopes : ['network']).join(','));
        for (const k of ['freshness', 'depth', 'limit', 'owner', 'type', 'cursor']) {
            const v = String(req.query[k] || '');
            if (v && /^[A-Za-z0-9_=-]{1,512}$/.test(v)) u.searchParams.set(k, v);
        }
        const auth = /^Bearer [A-Za-z0-9._~+/=-]{20,4096}$/.test(String(req.headers.authorization || '')) ? String(req.headers.authorization) : '';
        const headers = { ...(req.ip ? { 'X-Forwarded-For': req.ip } : {}), ...(auth ? { Authorization: auth } : {}) };
        if (auth) {
            res.set('Cache-Control', 'private, no-store');
            const d = await getJson(u.href, headers, 25000);
            return res.send(d ? JSON.stringify(d) : empty);
        }
        res.set('Cache-Control', 'public, max-age=60');
        const key = u.search.toLowerCase();
        const kept = queried.get(key);
        if (kept && Date.now() - kept.at < 60_000) return res.send(kept.body);
        const d = await getJson(u.href, headers, 25000);
        const body = d ? JSON.stringify(d) : empty;
        if (d) {
            if (queried.size >= 1000) queried.clear();
            queried.set(key, { at: Date.now(), body });
        }
        res.send(body);
    });

    // POST /api/frame/hit — one anonymous count for the calling page's host. The host comes from the
    // browser-set Origin header (never the body) and must be one of ours or a registered tool domain.
    const recent = new Map();   // ip → [count, windowStart]: 40/min is plenty for a person, useless for stuffing
    router.post('/hit', async (req, res) => {
        // sendBeacon is a no-cors request: without CORP cross-origin the browser logs every beacon's
        // (empty) answer as blocked on every page of every site (the count itself was never affected).
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' });
        try {
            const ua = String(req.headers['user-agent'] || '');
            let host = ''; try { host = new URL(String(req.headers.origin || '')).hostname.toLowerCase(); } catch { /* */ }
            const now = Date.now(); const k = req.ip || ''; const w = recent.get(k);
            if (!w || now - w[1] > 60_000) recent.set(k, [1, now]); else w[0]++;
            if (recent.size > 5000) recent.clear();
            const known = host && (siteForHost(host) || toolsCatalog.peek().catalog.tools.some(t => t.hosts && (t.hosts.canonical === host || t.hosts.short === host)));
            if (known && (recent.get(k) || [0])[0] <= 40 && !/bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python|node|go-http/i.test(ua)) await bump.run(host);
        } catch { /* counting must never fail a page */ }
        res.status(204).end();
    });

    // POST /api/frame/menu-click — the shared menu's anonymous click count (openvibe-shared/search.js beacon):
    // { host, section, pos, to, kind }, text/plain from navigator.sendBeacon, at most 512 bytes, 60/minute per IP.
    // Only an OpenVibe host the Frame knows is counted; there is no cookie, token or person in the request or the
    // table. `kind: 'open'` is accepted for a future impression beacon and only raises the in-memory estimate.
    const MENU_MAX = 512, MENU_PER_MIN = 60;
    const menuRecent = new Map();   // ip → [count, windowStart]
    const menuParser = express.text({ type: () => true, limit: '8kb' });
    const menuHeaders = (res) => res.set({
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
        'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store',
    });
    router.options('/menu-click', (req, res) => { menuHeaders(res); res.status(204).end(); });
    router.post('/menu-click', menuParser, async (req, res) => {
        menuHeaders(res);
        const now = Date.now(), ip = req.ip || ''; const win = menuRecent.get(ip);
        if (!win || now - win[1] > 60_000) menuRecent.set(ip, [1, now]); else win[0]++;
        if (menuRecent.size > 5000) menuRecent.clear();
        if ((menuRecent.get(ip) || [0])[0] > MENU_PER_MIN) { res.set('Retry-After', '60'); return res.status(429).json({ ok: false, error: 'Too many menu clicks' }); }
        let body;
        try {
            if (req.body && typeof req.body === 'object') {
                if (Buffer.byteLength(JSON.stringify(req.body)) > MENU_MAX) return res.status(413).json({ ok: false, error: 'Body too large' });
                body = req.body;
            } else {
                const text = typeof req.body === 'string' ? req.body : '';
                if (Buffer.byteLength(text, 'utf8') > MENU_MAX) return res.status(413).json({ ok: false, error: 'Body too large' });
                body = JSON.parse(text);
            }
        } catch { return res.status(400).json({ ok: false, error: 'Invalid JSON' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ ok: false, error: 'Invalid body' });
        const section = String(body.section || '').toLowerCase();
        if (!MENU_SECTIONS.has(section)) return res.status(400).json({ ok: false, error: 'Unknown section' });
        const source = siteForDestination(body.host);
        if (!source) return res.status(400).json({ ok: false, error: 'Unknown host' });
        const kind = String(body.kind || 'click').toLowerCase();
        if (!MENU_KINDS.has(kind)) return res.status(400).json({ ok: false, error: 'Unknown kind' });
        if (kind === 'open') { menuOpensSeen++; return res.status(204).end(); }
        const destination = siteForDestination(body.to);
        if (!destination) return res.status(400).json({ ok: false, error: 'Unknown destination' });
        const pos = Number(body.pos);
        if (!Number.isInteger(pos) || pos < -1 || pos > 500) return res.status(400).json({ ok: false, error: 'Invalid position' });
        const bucket = pos < 0 ? 'unknown' : pos <= 1 ? '1-2' : pos <= 5 ? '3-6' : '7+';
        try {
            await db.prepare("INSERT INTO menu_clicks (day, section, to_site, pos_bucket, n) VALUES (substring(ov_now(), 1, 10), ?, ?, ?, 1) ON CONFLICT(day, section, to_site, pos_bucket) DO UPDATE SET n = menu_clicks.n + 1").run(section, destination.id, bucket);
        } catch (err) {
            console.warn('[Frame] menu-click: could not count:', err.message);
            return res.status(500).json({ ok: false, error: 'Could not count' });
        }
        res.status(204).end();
    });
    // body-parser's 8 kb ceiling, for a body larger than the 512-byte rule.
    router.use((err, req, res, next) => {
        if (!err || !/entity\.too\.large/.test(String(err.type || ''))) return next(err);
        menuHeaders(res); res.status(413).json({ ok: false, error: 'Body too large' });
    });

    // ── Which sites serve their own legal documents ──────────────────────────────────────────────────────────────
    // A site's footer links to its own /terms, /privacy and /dmca (openvibe-shared/legal, wording by its manifest's
    // legalProfile). On 11-02 ten open sites did not serve them, so their footers' legal links answered 404. Every open
    // site's /privacy is asked once a day (GET, no redirects, 5 s); a site that does not answer 200 gets openvibe.network's
    // documents until it does. Before the first answer a site keeps its own links, as before.
    const legalOwn = new Map();   // host → true (serves them) | false (does not)
    async function probeLegal({ fetchImpl = fetch } = {}) {
        let changed = false;
        await Promise.all(orderedOpen().map(async (s) => {
            let ok;
            try {
                const r = await fetchImpl(`https://${s.host}/privacy`, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'OpenVibe.Network frame (legal links)', accept: 'text/html' } });
                ok = r.status === 200;
                if (r.body && typeof r.body.cancel === 'function') r.body.cancel().catch(() => {});
            } catch { return; }   // no answer: keep what was known
            if (legalOwn.get(s.host) !== ok) { legalOwn.set(s.host, ok); changed = true; }
        }));
        if (changed) version = Date.now();
        return Object.fromEntries(legalOwn);
    }

    let timers = [];
    async function start() {
        const rankAge = Date.now() - ((await load('rank') || {}).at || 0), copyAge = Date.now() - ((await load('copy') || {}).at || 0);
        const t1 = setTimeout(() => refreshRank().catch(() => {}), rankAge > RANK_MS ? 8000 : RANK_MS - rankAge); t1.unref();
        const i1 = setInterval(() => refreshRank().catch(() => {}), RANK_MS); i1.unref();
        const t2 = setTimeout(() => refreshCopy().catch(() => {}), copyAge > COPY_MS ? 60_000 : COPY_MS - copyAge); t2.unref();
        const i2 = setInterval(() => refreshCopy().catch(() => {}), COPY_MS); i2.unref();
        const t3 = setTimeout(() => probeLegal().catch(() => {}), 45_000); t3.unref();
        const i3 = setInterval(() => probeLegal().catch(() => {}), 24 * 3600 * 1000); i3.unref();
        timers = [t1, i1, t2, i2, t3, i3];
    }
    /** Graceful stop: no further rank or copy refreshes. */
    function stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

    /** The open sites in navbar order (most used first), and when that use was last counted (ms, or null: cold start). */
    function ranking() {
        return { at: rankedAt, order: orderedOpen().map(s => s.id), everyMs: RANK_MS };
    }

    return { router, start, stop, refreshRank, refreshCopy, probeLegal, payloadFor, ranking, _state: () => ({ rank, copy }) };
}

module.exports = { createFrameService, BANNED };
