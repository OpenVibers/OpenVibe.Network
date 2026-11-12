'use strict';
// ═══════════════════════════════════════════════════════════════
// OpenVibe Frame data: what the navbar and footer of every site show.
//
//   GET /api/frame?host=<hostname>     public, CORS *, max-age=600, ETag
//   GET /api/frame/pulse               public, CORS *, max-age=30: { live_now, watching, sites, views_7d, live, updated }
//   GET /api/frame/commands?site=&q=   the composer's / menu: site commands, network defaults, a person's own
//   GET /api/frame/mentions?q=&site=   the composer's @ menu: public people, the person's agents, places (max 8)
//   GET /api/frame/feed, /api/frame/wall  the menu's Feed and wall: Community's /api/v1/feed and /api/v1/pulse, relayed
//   GET|POST|PUT /api/frame/wallet/…   the wallet sheet's fixed Billing/Inventory paths, relayed (bearer, or the ov_token cookie; no cache)
//   POST /api/frame/menu-click         public, CORS *, text/plain, max 512 bytes, 60/min per IP: one menu click counted
//   → { updated, nav: [{ id, name, url, icon, tagline, group, of? }], open sites, most used first (of: a product
//                                                                      on its own domain, served by that site)
//       next: { [siteId]: [siteId, …] },                              up to 6 places people go next
//       discover_ids: [siteId, …],                                    the open sites, ordered for discovery
//       menu: { beacon },                                             where the shared menu sends its clicks
//       cards: [frame.menu-card@1, …],                                each open site's cards, at most 12, Live first
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
const { isExtensionOrigin } = require('../auth/extension-origin');
const express = require('express');
const crypto = require('crypto');
const { SITES, LISTED, LISTED_SITES, siteForHost, GROUPS, groupOf, PRODUCTS, MERGED_PRODUCTS, ICON_ALIAS, MENU_LINE, MENU_NAME, fullName } = require('./sites');
const { createMenuCards } = require('./menu-cards');
const { createFrameChoices } = require('./choices');
const { createFrameAsk } = require('./ask');
const { read: readCommands } = require('./commands');
const { createFrameMentions } = require('./mentions');
const seen = require('./seen');
const toolsCatalog = require('../domains/catalog');

const RANK_MS = 30 * 60_000, COPY_MS = 24 * 60 * 60_000;
// One number for "how many places the network lists": the menu, its tile count, pulse.sites and online.sites.
// 53 open sites (Network the front door included) plus Pics and Download, the two domains Video serves as entries.
const LISTED_TOTAL = LISTED.filter((s) => s.status === 'open').length;
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
    const product = PRODUCTS.concat(MERGED_PRODUCTS).find((p) => h === p.host || h.endsWith('.' + p.host));
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

const ONLINE_TTL_MS = 30_000;
const SITE_TEXT = (v, max) => String(v == null ? '' : v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
/** An https link on an OpenVibe domain (apex or any subdomain), or null. */
const openvibeLink = (v) => {
    const raw = String(v == null ? '' : v).trim();
    if (!raw || raw.length > 400) return null;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    // The host must be one the manifests own (each site's domain, from the same list the Frame serves), or a
    // page on openvibe.network. A lookalike (openvibe.live.example.com) is not an OpenVibe domain.
    return siteForHost(host) || host === 'openvibe.network' || host.endsWith('.openvibe.network') ? raw : null;
};
const STRIP_ICON = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A site's declared strip items: at most three, text only, an https link on an OpenVibe domain, a number or a line. */
function stripOf(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list.slice(0, 3) : []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const label = SITE_TEXT(raw.label, 24);
        const link = openvibeLink(raw.link);
        if (!label || !link || !STRIP_ICON.test(String(raw.icon || ''))) continue;
        const item = { label, icon: String(raw.icon), link };
        const n = Number(raw.count);
        const line = SITE_TEXT(raw.line, 40);
        if (raw.count !== undefined && Number.isInteger(n) && n >= 0) item.value = n;
        else if (line) item.line = line;
        else continue;   // neither a number nor a line: not a strip item
        out.push(item);
    }
    return out;
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

async function createFrameService(db, config, analytics, { privateKey = null, issuer = null, selfToken = () => null, aiUrl = null, requireAuth = null, person = null, today = null, now = Date.now, sites = SITES, places = LISTED, mentionLimit = 120 } = {}) {
    const services = (config && config.services) || {};
    aiUrl = aiUrl || (services.ai && services.ai.internalUrl) || process.env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700';
    const choices = createFrameChoices({
        aiUrl, now,
        exchangeUrl: (services.exchange && services.exchange.internalUrl) || 'http://127.0.0.1:5150',
        reportUrl: (services.report && services.report.internalUrl) || 'http://127.0.0.1:5080',
    });
    const ask = createFrameAsk({
        aiUrl, now, requireAuth, sheet: choices,
        searchUrl: (services.search && services.search.internalUrl) || 'http://127.0.0.1:4710',
    });
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
    // The menu's network cards (frame.menu-cards@1): fetched from every open site every five minutes, kept in
    // frame_cache across restarts. A failed site keeps its last good card for 30 minutes; GET /api/frame carries
    // at most twelve, Live first while anyone is live, then the Frame's own ranking.
    const menuCards = createMenuCards({
        sites: () => LISTED_SITES.filter((s) => s.status === 'open'),
        rankOf: () => orderedOpen().map((s) => s.id),
        load: () => load('menu-cards'),
        save: (v) => save('menu-cards', v),
        onChange: () => { version = Date.now(); },
    });
    await menuCards.init();
    const openIds = () => new Set(LISTED_SITES.filter((s) => s.status === 'open').map((s) => s.id));
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
        for (const site of LISTED_SITES.filter((s) => s.status === 'open')) {
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

    // The composer's Reach (composer-post-ask-do.md, R3): the site's slash commands and the @ menu. Both
    // read a person's session when one is sent (Bearer or the Network cookie) and answer as a signed-out
    // visitor otherwise; neither keeps a person's own answer.
    const sessionAuth = require('../auth/session');
    async function defaultPerson(req) {
        const token = sessionAuth.sessionToken(req);
        if (!token) return null;
        const publicKey = req.app && req.app.locals && req.app.locals.publicKey;
        if (!publicKey || !config || !config.jwt || !config.jwt.issuer) return null;
        try { const out = await sessionAuth.verifySession(token, { db, publicKey, config }); return out && !out.error ? out.user : null; } catch { return null; }
    }
    const personOf = typeof person === 'function' ? person : defaultPerson;
    const mentions = createFrameMentions({
        db, sites: places, siteForHost, fullName, now, perMinute: mentionLimit,
        liveUrl: svcUrl('live', 'http://127.0.0.1:3000'),
    });

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
        for (const site of LISTED_SITES.filter((s) => s.status === 'open')) {
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
        const open = LISTED_SITES.filter(s => s.status === 'open');
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
        for (const s of LISTED_SITES.filter(x => x.status === 'open')) pool.set('site:' + s.id, { name: fullName(s), url: s.url || `https://${s.host}/`, about: s.tagline });
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
        const body = { sites: LISTED_SITES.filter(s => s.status === 'open').map(s => ({ id: s.id, name: fullName(s), what: s.what, popular: s.id === 'tools' ? popularTools(6).map(t => t.name) : [] })), links };
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
            // Every listed place, most used first, each followed by the products it serves on their own domains (`of`).
            // Media, Homes and Bench are merged sections, not entries; Pics and Download are entries after Video.
            nav: open.flatMap(s => [s, ...PRODUCTS.filter(p => p.of === s.id)]).map(s => ({ id: s.id, name: MENU_NAME[s.id] || s.name, url: s.url || `https://${s.host}/`, icon: ICON_ALIAS[s.icon] || s.icon, tagline: MENU_LINE[s.id] || s.tagline, group: groupOf(s.id), ...(s.of ? { of: s.of } : {}) })),
            // The menu's data: where people go next from each open site (totals only, no person), the fair discovery
            // order, and the click beacon (Shared sends it only when this object is present).
            next, discover_ids: discoverIds,
            menu: { beacon: MENU_BEACON },
            // The network's cards: each open site's published frame.menu-card@1, at most twelve, Live first while
            // anyone is live, then the site's place in this Frame's ranking. Empty cards are not sent.
            cards: menuCards.cards(),
            groups: GROUPS.map(g => ({ id: g.id, name: g.name })),
            // state: 'internal' (runs on loopback, the domain still shows a placeholder) or 'placeholder' (planned).
            soon: LISTED.filter(s => s.status === 'soon').map(s => ({ id: s.id, name: s.name, url: s.url || `https://${s.host}/`, icon: s.icon, state: s.state })),
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
    // Live's public list, held 30 s and shared by /pulse and /online. Null when Live does not answer.
    let liveAt = 0;
    let liveValue = null;
    async function readLive(nowMs = now()) {
        if (liveAt && nowMs - liveAt < 30_000) return liveValue;
        const d = await getJson(`${svcUrl('live', 'http://127.0.0.1:3000')}/api/streams`);
        const streams = d && Array.isArray(d.streams) ? d.streams.filter(publicLive) : null;
        liveValue = streams ? {
            channels: streams.length,
            watching: streams.reduce((a, st) => a + viewersOf(st), 0),
            list: streams.filter((st) => /^[A-Za-z0-9_-]{1,40}$/.test(String(st.username || ''))).slice(0, 8).map((st) => {
                const avatar = /^https:\/\//i.test(String(st.avatar_url || '')) ? String(st.avatar_url).slice(0, 500) : null;
                return {
                    name: String(st.display_name || st.username || st.title || '').replace(/\s+/g, ' ').trim().slice(0, 100) || st.username,
                    url: `https://openvibe.live/@${encodeURIComponent(st.username)}`,
                    viewers: viewersOf(st),
                    ...(avatar ? { avatar } : {}),
                };
            }),
        } : null;
        liveAt = nowMs;
        return liveValue;
    }
    async function readPulse() {
        const live = await readLive();
        const views = Object.entries(rank.scores || {}).filter(([k]) => !k.includes(':')).reduce((a, [, n]) => a + (Number(n) || 0), 0);
        return {
            live_now: live ? live.channels : null,
            watching: live ? live.watching : null,
            sites: LISTED_TOTAL,
            views_7d: views > 0 ? Math.round(views) : null,
            live: live ? live.list : null,
            updated: new Date().toISOString(),
        };
    }
    router.get('/pulse', async (req, res) => {
        if (!pulse || Date.now() - pulseAt > 30_000) {
            pulseInflight = pulseInflight || readPulse().then((p) => { pulse = p; pulseAt = Date.now(); }).catch(() => {}).finally(() => { pulseInflight = null; });
            await pulseInflight;
        }
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120', 'Content-Type': 'application/json; charset=utf-8' });
        res.send(JSON.stringify(pulse || { live_now: null, watching: null, sites: LISTED_TOTAL, views_7d: null, live: null, updated: null }));
    });

    // ── GET /api/frame/online — who is on the network, and a few counts (owner, 2026-11-10) ────────────────────────
    // The footer strip on every site mounts from this one read. Members are signed-in people whose presence
    // heartbeat arrived on any site in the last thirty minutes; one who hides their status is counted but never
    // named. Guests are distinct anonymous visitors, counted from the page-view beacon as a keyed hash of the
    // address and the browser's user agent — held in memory for thirty minutes, never written anywhere, and only
    // ever returned as a number (server/frame/seen.js). Live is the first three public channels, empty when none.
    // Counts open the thing they count; a service that does not publish a count contributes no item. A site's own
    // strip items come from its manifest entry and are returned only for that site (?site=), validated hard.
    // Public, CORS *, cached 30 s here and at the edge. Nothing personal: a named person carries their name,
    // their @username, their picture and the site's name, and a guest carries nothing.
    /** The joiners count and whatever a service already publishes for today; an item with no source is left out. */
    async function countsOf(nowMs) {
        const out = [];
        try {
            const since = new Date(nowMs - 7 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
            const r = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE COALESCE(is_anon, 0) = 0 AND COALESCE(is_banned, 0) = 0 AND COALESCE(deleted_at, '') = '' AND COALESCE(is_test, 0) = 0 AND created_at >= ?").get(since);
            const n = r ? Number(r.n) : NaN;
            if (Number.isFinite(n) && n >= 0) out.push({ id: 'joined', label: 'Joined this week', value: n, icon: 'members', url: 'https://openvibe.network/stats' });
        } catch { /* the count is optional */ }
        // Report's daily activity (the same read /api/v1/frame/today makes): today's videos and posts, when it has them.
        const t = today ? await Promise.resolve().then(() => today()).catch(() => null) : null;
        if (t && Number.isSafeInteger(t.new_videos_today) && t.new_videos_today >= 0) out.push({ id: 'videos', label: 'Videos today', value: t.new_videos_today, icon: 'video', url: 'https://openvibe.video/' });
        if (t && Number.isSafeInteger(t.posts_today) && t.posts_today >= 0) out.push({ id: 'posts', label: 'Threads and pastes today', value: t.posts_today, icon: 'clipboard', url: 'https://openvibe.community/' });
        return out;
    }
    let onlineBase = null;
    let onlineBaseAt = 0;
    let onlineInflight = null;
    async function readOnlineBase(nowMs) {
        if (onlineBase && nowMs - onlineBaseAt < ONLINE_TTL_MS) return onlineBase;
        onlineInflight = onlineInflight || (async () => {
            const snap = seen.snapshot(nowMs);
            const subjects = [...snap.members.keys()];
            let rows = [];
            if (subjects.length) {
                try {
                    rows = await db.prepare(`SELECT u.username, u.display_name, u.subject_id, u.is_test, p.show_status, p.state
                        FROM person_presence p JOIN users u ON u.subject_id = p.subject_id
                        WHERE p.subject_id = ANY(?) AND COALESCE(u.is_banned, 0) = 0 AND COALESCE(u.deleted_at, '') = ''`).all(subjects);
                } catch { rows = []; }
            }
            const bySubject = new Map(rows.map((r) => [r.subject_id, r]));
            const testSeen = rows.filter((r) => Number(r.is_test)).length;
            const visible = [];
            for (const [subject, entry] of snap.members) {
                const r = bySubject.get(subject);
                // A test account (the probes) is never a public member: it is counted out, not just unnamed.
                if (!r || Number(r.is_test)) continue;
                // The person's own presence choice decides whether they may be named: the "Show my status"
                // switch off, or Invisible, means counted among members and never in the list.
                if (!Number(r.show_status) || r.state === 'invisible') continue;
                const username = String(r.username || '').slice(0, 40);
                if (!username) continue;
                const name = SITE_TEXT(r.display_name || username, 60) || username;
                const at = entry.site ? SITES.find((s) => s.id === entry.site) : null;
                visible.push({ name, username, avatar: `https://openvibe.network/avatar/${encodeURIComponent(username)}?s=64`, site: at ? at.name : null, at: entry.at });
            }
            visible.sort((a, b) => b.at - a.at);
            const live = await readLive(nowMs);
            const views = Object.entries(rank.scores || {}).filter(([k]) => !k.includes(':')).reduce((a, [, n]) => a + (Number(n) || 0), 0);
            const members = Math.max(0, snap.members.size - testSeen);
            onlineBase = {
                members,
                guests: snap.guests,
                total: members + snap.guests,
                visible,
                counts: await countsOf(nowMs),
                live: live ? { channels: live.channels, watching: live.watching, first: live.list.slice(0, 3).map((s) => ({ name: s.name, url: s.url })) } : { channels: 0, watching: 0, first: [] },
                sites: LISTED_TOTAL,
                views_7d: views > 0 ? Math.round(views) : null,
                updated: new Date(nowMs).toISOString(),
            };
            onlineBaseAt = nowMs;
            return onlineBase;
        })().finally(() => { onlineInflight = null; });
        return await onlineInflight;
    }
    /** The site an asking footer means: its site id (the icon name) or its service id (openre is the site `stream`). */
    const siteAsked = (asked) => {
        const id = /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(asked || '').toLowerCase()) ? String(asked).toLowerCase() : '';
        return id ? SITES.find((s) => s.id === id || s.service === id) || null : null;
    };
    async function onlineFor(asked, nowMs = now()) {
        const base = await readOnlineBase(nowMs);
        const site = siteAsked(asked);
        return {
            updated: base.updated,
            members: base.members,
            guests: base.guests,
            total: base.total,
            people: base.visible.slice(0, 60).map(({ name, username, avatar, site: at }) => ({ name, username, avatar, site: at })),
            more: Math.max(0, base.visible.length - 60),
            live: base.live,
            counts: base.counts,
            items: site ? stripOf(site.strip) : [],
            sites: base.sites,
            views_7d: base.views_7d,
        };
    }
    const onlineCache = new Map();   // site id ('' for none) → { at, body }
    router.get('/online', async (req, res) => {
        // One answer per site, held 30 s: the key is the site's own id, so ?site=openre and ?site=stream share one.
        const site = (siteAsked(req.query.site) || {}).id || '';
        const nowMs = now();
        let e = onlineCache.get(site);
        if (!e || nowMs - e.at >= ONLINE_TTL_MS) {
            try {
                e = { at: nowMs, body: JSON.stringify(await onlineFor(site, nowMs)) };
            } catch {
                e = null;
            }
            if (e) {
                if (onlineCache.size >= 200) onlineCache.clear();
                onlineCache.set(site, e);
            }
        }
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120', 'Content-Type': 'application/json; charset=utf-8' });
        res.send(e ? e.body : JSON.stringify({ updated: null, members: null, guests: null, total: null, people: [], more: 0, live: null, counts: [], items: [], sites: LISTED_TOTAL, views_7d: null }));
    });

    // GET /api/frame/feed?kind=&site=&q=&following=1&cursor=&limit= and GET /api/frame/wall?limit=&after=&for= — the menu's Feed and wall
    // (openvibe-shared ov-home.js) on every site, asked through Network because every site's connect-src lets the navbar
    // reach openvibe.network, and the sites' policies refused openvibe.community (11-09: the Feed fell back to its old
    // sections everywhere but five sites). Community's /api/v1/feed and /api/v1/pulse answer; the person's Bearer token
    // goes along when the menu sends one (a personal wall, the composer's can_post), never a cookie. Anonymous answers are
    // kept 30 s per query; personal ones are not kept. Community not answering is an empty page, never an error.
    const relayed = new Map();
    // Community's feed kinds (server/pulse/feed.js KINDS; #310 added wiki, quest, chat, event and member).
    const FEED_KINDS = ['live', 'stream', 'clip', 'video', 'pic', 'post', 'meme', 'game', 'update', 'wiki', 'quest', 'chat', 'event', 'member'];
    async function relay(req, res, path, params) {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization', 'Vary': 'Authorization', 'Content-Type': 'application/json; charset=utf-8' });
        const auth = /^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/.test(String(req.get('authorization') || '')) ? req.get('authorization') : '';
        const u = new URL(path, svcUrl('community', 'http://127.0.0.1:4200'));
        Object.entries(params).forEach(([k, v]) => { if (v) u.searchParams.set(k, v); });
        const key = `${path}?${u.searchParams}`;
        if (!auth) {
            const kept = relayed.get(key);
            if (kept && Date.now() - kept.at < 30_000) { res.set('Cache-Control', 'public, max-age=30'); return res.send(kept.body); }
        }
        const d = await getJson(u.href, auth ? { Authorization: auth, Accept: 'application/json' } : { Accept: 'application/json' });
        if (path === '/api/v1/feed/search' && (!d || !Array.isArray(d.items))) return res.status(503).send('{"error":"feed search unavailable"}');
        const body = JSON.stringify(path === '/api/v1/feed/examples'
            ? (d && Array.isArray(d.examples) ? d : { examples: [] })
            : (d && Array.isArray(d.items) ? d : { items: [], next_cursor: null }));
        if (!auth && d) {
            if (relayed.size >= 500) relayed.clear();
            relayed.set(key, { at: Date.now(), body });
        }
        res.set('Cache-Control', auth ? 'private, no-store' : 'public, max-age=30');
        return res.send(body);
    }
    const qCursor = (v) => (/^[A-Za-z0-9._~=-]{1,300}$/.test(String(v || '')) ? String(v) : '');
    const qLimit = (v, max) => String(Math.min(Math.max(parseInt(v, 10) || 20, 1), max));
    router.options(['/feed', '/feed/search', '/feed/examples', '/wall', '/status', '/posts', '/attachments'], (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Max-Age': '600' });
        res.status(204).end();
    });
    // POST /api/frame/status — the menu composer's post (Community's POST /api/v1/me/status), for the same reason: only
    // with the person's Bearer token, a JSON body of at most 8 KB, Community's answer and status passed back as they are.
    router.post('/status', express.json({ limit: '8kb' }), async (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
        const auth = /^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/.test(String(req.get('authorization') || '')) ? req.get('authorization') : '';
        if (!auth) return res.status(401).send('{"error":"sign in to post"}');
        try {
            const r = await fetch(new URL('/api/v1/me/status', svcUrl('community', 'http://127.0.0.1:4200')).href, {
                method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(req.body || {}), signal: AbortSignal.timeout(8000),
            });
            const text = await r.text();
            return res.status(r.status).send(text.slice(0, 64 * 1024));
        } catch { return res.status(502).send('{"error":"Community did not answer"}'); }
    });
    // The feed's filters pass through: a site (a service id), words (q, at most 80 characters, one line) and the
    // signed-in person's follows (following=1 only with their Bearer token: Community answers 401 without one).
    const qSite = (v) => (/^[a-z0-9][a-z0-9:-]{0,39}$/.test(String(v || '')) ? String(v) : '');
    const qWords = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    // POST /api/frame/attachments and POST /api/frame/posts — the Feed's composer with pictures (the owner, 11-09: "you
    // can make posts and put images"): a picture goes to Community's status space (multipart `file`, one image, at most
    // 8 MB, Community stores it in Media as the person's), then the post names it with its alt text. Same rules as
    // /status: only with the person's Bearer token, never a cookie; Community's answer and status passed back as they are.
    const sendOn = async (req, res, path, body, contentType) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
        const auth = /^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/.test(String(req.get('authorization') || '')) ? req.get('authorization') : '';
        if (!auth) return res.status(401).send('{"error":"sign in to post"}');
        try {
            const r = await fetch(new URL(path, svcUrl('community', 'http://127.0.0.1:4200')).href, {
                method: 'POST', headers: { Authorization: auth, 'Content-Type': contentType, Accept: 'application/json' },
                body, signal: AbortSignal.timeout(20000),
            });
            const text = await r.text();
            return res.status(r.status).send(text.slice(0, 64 * 1024));
        } catch { return res.status(502).send('{"error":"Community did not answer"}'); }
    };
    router.post('/attachments', express.raw({ type: (req) => /^multipart\/form-data; *boundary=/i.test(String(req.headers['content-type'] || '')), limit: '8500kb' }), (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
            res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
            return res.status(400).json({ error: 'Send one picture as multipart form data (the field "file")' });
        }
        return sendOn(req, res, '/api/v1/spaces/status/attachments', req.body, String(req.get('content-type')));
    });
    router.post('/posts', express.json({ limit: '8kb' }), (req, res) => sendOn(req, res, '/api/v1/posts', JSON.stringify(req.body || {}), 'application/json'));

    router.get('/feed', (req, res) => relay(req, res, '/api/v1/feed', {
        kind: FEED_KINDS.includes(String(req.query.kind || '')) ? String(req.query.kind) : '',
        site: qSite(req.query.site), q: qWords(req.query.q),
        following: /^(1|true)$/.test(String(req.query.following || '')) ? '1' : '',
        cursor: qCursor(req.query.cursor), limit: qLimit(req.query.limit, 40),
    }));
    router.get('/feed/search', (req, res) => relay(req, res, '/api/v1/feed/search', {
        q: qWords(req.query.q),
    }));
    router.get('/feed/examples', (req, res) => relay(req, res, '/api/v1/feed/examples', {}));
    router.get('/wall', (req, res) => relay(req, res, '/api/v1/pulse', {
        limit: qLimit(req.query.limit, 50), after: qCursor(req.query.after), cursor: qCursor(req.query.cursor),
        for: req.query.for === 'me' ? 'me' : '', origin: ['user', 'ai', 'system', 'all'].includes(String(req.query.origin || '')) ? String(req.query.origin) : '',
    }));

    // ── The wallet sheet's money and items (openvibe-shared ov-wallet.js) ──────────────────────────────────────
    // Every site's connect-src allows openvibe.network and refuses billing./inventory.openvibe.network, so the
    // sheet asks these fixed paths here and nothing else. Only the person's Bearer token goes upstream, never a
    // cookie; bodies are JSON of at most 8 KB; redirects are not followed; Billing's and Inventory's status and
    // body come back as they are. Nothing personal is kept, and no query is forwarded except a page limit/cursor.
    const walletAuth = (req) => (/^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/.test(String(req.get('authorization') || '')) ? req.get('authorization') : '');
    // A site that signs people in with its own cookie has no token to hand the navbar; its page asks with
    // credentials: 'include' and the person's Network session cookie (ov_token) comes along. That token goes upstream
    // as the Bearer (never the cookie itself), only from an origin the CORS allow-list already let through (or none:
    // Network's own pages), never from an extension page, and a write needs an Origin: a cross-site form post carries
    // a foreign one and the allow-list refuses it before this runs. The answer keeps the allow-list's echoed Origin with
    // credentials (a '*' would make the browser drop it). Openvibe-shared 4.173's chips and sheet use it (2026-11-09:
    // 4.170's chips sat at "…" on every such site).
    const OV_TOKEN = /^[A-Za-z0-9._~+/=-]{10,4096}$/;
    const cookieToken = (req) => {
        const parsed = req.cookies && req.cookies.ov_token;
        const raw = typeof parsed === 'string' ? parsed : ((String(req.get('cookie') || '').match(/(?:^|;\s*)ov_token=([^;]+)/) || [])[1] || '');
        return OV_TOKEN.test(raw) ? raw : '';
    };
    function walletRelay(service, method, upstream) {
        const upstreamPath = typeof upstream === 'function' ? upstream : () => upstream;
        return async (req, res) => {
            const bearer = walletAuth(req);
            const origin = String(req.get('origin') || '');
            const fromCookie = !bearer && cookieToken(req) && !isExtensionOrigin(origin) && (method === 'GET' || origin) ? `Bearer ${cookieToken(req)}` : '';
            res.set({ 'Vary': 'Authorization, Origin, Cookie', 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8' });
            if (!fromCookie) res.set('Access-Control-Allow-Origin', '*');
            const path = upstreamPath(req);
            if (!path) return res.status(404).send('{"error":"not found"}');
            const auth = bearer || fromCookie;
            if ((path.startsWith('/api/v1/me/') || path.startsWith('/api/wallet/changes')) && !auth) return res.status(401).send('{"error":"sign in to open your wallet"}');
            const fallback = service === 'billing' ? 'http://127.0.0.1:4600' : service === 'network' ? config.internalUrl || 'http://127.0.0.1:4000' : 'http://127.0.0.1:5030';
            const u = new URL(path, svcUrl(service, fallback));
            if (method === 'GET') {
                const limit = String(req.query.limit || '');
                if (/^\d{1,3}$/.test(limit)) u.searchParams.set('limit', String(Math.min(Math.max(Number(limit), 1), 100)));
                if (path === '/api/wallet/changes') {
                    const patterns = { since_vibes: /^txn_[0-9A-HJKMNP-TV-Z]{26}$/, since_opencoins: /^[1-9]\d{0,15}$/, streamer: /^[1-9]\d{0,15}$/, since_channel_points: /^[1-9]\d{0,15}$/ };
                    for (const [name, pattern] of Object.entries(patterns)) {
                        const value = String(req.query[name] || '');
                        if (pattern.test(value)) u.searchParams.set(name, value);
                    }
                } else {
                    const cursor = String(req.query.cursor || '');
                    if (/^[A-Za-z0-9._~=-]{1,300}$/.test(cursor)) u.searchParams.set('cursor', cursor);
                }
            }
            const headers = { Accept: 'application/json', ...(auth ? { Authorization: auth } : {}) };
            const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(8000) };
            if (method !== 'GET') { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(req.body || {}); }
            try {
                const r = await fetch(u.href, init);
                const text = await r.text();
                return res.status(r.status).send(text.slice(0, 64 * 1024));
            } catch { return res.status(502).send('{"error":"The wallet service did not answer"}'); }
        };
    }
    const walletJson = express.json({ limit: '8kb' });
    const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/, ITEM = /^itd_[0-9A-HJKMNP-TV-Z]{26}$/;
    router.options('/wallet/*', (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT', 'Access-Control-Max-Age': '600' });
        res.status(204).end();
    });
    // Billing: the three balances and the sheet's two checkouts. All personal, all no-store.
    router.get('/wallet/api/v1/me/wallet', walletRelay('billing', 'GET', '/api/v1/me/wallet'));
    // Ask 273: every site reads and marks the same per-currency change window through Network.
    router.get('/wallet/changes', walletRelay('network', 'GET', '/api/wallet/changes'));
    router.put('/wallet/changes/read', walletJson, walletRelay('network', 'PUT', '/api/wallet/changes/read'));
    router.post('/wallet/api/v1/me/vibes/buy', walletJson, walletRelay('billing', 'POST', '/api/v1/me/vibes/buy'));
    router.post('/wallet/api/v1/me/wallet/topups', walletJson, walletRelay('billing', 'POST', '/api/v1/me/wallet/topups'));
    // Inventory: the store, the person's items, and the equipped slots (worn or not).
    router.get('/wallet/api/v1/me/items', walletRelay('inventory', 'GET', '/api/v1/me/items'));
    router.get('/wallet/api/v1/people/:id/equipped', walletRelay('inventory', 'GET',
        (req) => (USR.test(String(req.params.id || '')) ? `/api/v1/people/${req.params.id}/equipped` : null)));
    router.put('/wallet/api/v1/me/equipped', walletJson, walletRelay('inventory', 'PUT', '/api/v1/me/equipped'));
    router.get('/wallet/api/v1/store', walletRelay('inventory', 'GET', '/api/v1/store'));
    router.post('/wallet/api/v1/store/:id/buy', walletJson, walletRelay('inventory', 'POST',
        (req) => (ITEM.test(String(req.params.id || '')) ? `/api/v1/store/${req.params.id}/buy` : null)));
    router.get('/wallet/api/v1/kinds', walletRelay('inventory', 'GET', '/api/v1/kinds'));

    // ── The Dock's Agents tab (openvibe-shared dock-agent.js, dock-timeline.js and dock-actor.js) ───────────────
    // The Dock runs on every OpenVibe site, and every site's connect-src allows openvibe.network and refuses
    // openvibe.codes and openvibe.actor (2026-11-09: 49 sites logged 1-4 refusals at 1280). These fixed paths are
    // the Dock's reads and its controls: the person's Bearer token goes upstream and never a cookie, the
    // bodies are JSON of at most 8 KB, redirects are not followed, and Codes' and Actor's status and answer come
    // back as they are. Nothing is kept: every answer is the person's own.
    // The Dock's Code tab (the Vibe place's Code part) reads and writes the person's coding tasks the same way:
    // /codes-tasks (list, start) and /codes-tasks/:id/stop, straight through to Codes' person tasks API.
    const dockAuth = (req) => (/^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/.test(String(req.get('authorization') || '')) ? req.get('authorization') : '');
    const DOCK_ID = /^[A-Za-z0-9._~:-]{1,160}$/;
    const dockId = (v) => (DOCK_ID.test(String(v || '')) ? String(v) : '');
    function dockRelay(service, method, upstream, { image = false, maxBytes = 64 * 1024 } = {}) {
        const upstreamPath = typeof upstream === 'function' ? upstream : () => upstream;
        const fallback = service === 'codes' ? 'http://127.0.0.1:4900' : 'http://127.0.0.1:4950';
        return async (req, res) => {
            res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, no-store' });
            const auth = dockAuth(req);
            if (!auth) return res.status(401).json({ error: 'sign in to use the Dock' });
            const path = upstreamPath(req);
            if (!path) return res.status(404).json({ error: 'not found' });
            const headers = { Accept: image ? 'image/jpeg, image/webp' : 'application/json', Authorization: auth };
            const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) };
            if (method !== 'GET') { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(req.body || {}); }
            try {
                const r = await fetch(new URL(path, svcUrl(service, fallback)).href, init);
                if (image) {
                    const bytes = Buffer.from(await r.arrayBuffer());
                    res.set('Content-Type', String(r.headers.get('content-type') || 'application/octet-stream').slice(0, 80));
                    return res.status(r.status).send(bytes);
                }
                const text = await r.text();
                res.set('Content-Type', 'application/json; charset=utf-8');
                if (Buffer.byteLength(text) > maxBytes) return res.status(502).json({ error: 'The Dock service answer was too large' });
                return res.status(r.status).send(text);
            } catch { return res.status(502).json({ error: 'The Dock service did not answer' }); }
        };
    }
    const dockJson = express.json({ limit: '8kb' });
    router.options(['/agent-view', '/agent-view/*', '/agent/*', '/agents/*', '/codes-agents/*', '/tasks/*', '/actor', '/actor/*', '/codes-tasks', '/codes-tasks/*', '/codes-runs/*', '/agent-runs/*'], (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', 'Access-Control-Max-Age': '600' });
        res.status(204).end();
    });
    // OpenVibe.Codes: the person's agent stream, its last still, and the four controls.
    router.get('/agent-view', dockRelay('codes', 'GET', '/api/v1/me/agent-view'));
    router.get('/agent-view/frame', dockRelay('codes', 'GET', '/api/v1/me/agent-view/frame', { image: true }));
    for (const what of ['pause', 'curtain', 'mute', 'end']) router.post(`/agent-view/${what}`, dockJson, dockRelay('codes', 'POST', `/api/v1/me/agent-view/${what}`));
    // OpenVibe.Actor: the one timeline behind the Dock, the approvals answered in the mode that owns them, the
    // kill switch, and the task hand-off the timeline's Take over / Give it back buttons use.
    router.get('/agent/timeline', dockRelay('actor', 'GET', (req) => {
        const q = new URLSearchParams();
        const mode = String(req.query.mode || '');
        if (/^[a-z]{1,20}$/.test(mode)) q.set('mode', mode);
        if (/^(1|true)$/.test(String(req.query.needs_you || ''))) q.set('needs_you', '1');
        const cursor = String(req.query.cursor || '');
        if (/^[A-Za-z0-9._~=-]{1,300}$/.test(cursor)) q.set('cursor', cursor);
        if (String(req.query.scope || '') === 'shared') q.set('scope', 'shared');
        return '/api/v1/agent/timeline' + (q.toString() ? '?' + q.toString() : '');
    }));
    router.post('/agent/approvals/:product/:id/decide', dockJson, dockRelay('actor', 'POST', (req) => {
        const product = String(req.params.product || ''), id = dockId(req.params.id);
        return /^[a-z][a-z0-9_-]{0,39}$/.test(product) && id ? `/api/v1/agent/approvals/${encodeURIComponent(product)}/${encodeURIComponent(id)}/decide` : null;
    }));
    router.post('/agent/kill-switch', dockJson, dockRelay('actor', 'POST', '/api/v1/agent/kill-switch'));
    for (const what of ['takeover', 'giveback']) router.post(`/tasks/:id/${what}`, dockJson, dockRelay('actor', 'POST', (req) => (dockId(req.params.id) ? `/api/v1/tasks/${encodeURIComponent(req.params.id)}/${what}` : null)));
    // OpenVibe.Actor's block at the top of the tab: your Actor, its first ask, and one line to tell it something.
    router.get('/actor', dockRelay('actor', 'GET', '/api/v1/me/actor'));
    for (const what of ['pause', 'resume', 'tell']) router.post(`/actor/${what}`, dockJson, dockRelay('actor', 'POST', `/api/v1/me/actor/${what}`));
    for (const what of ['answer', 'decline']) router.post(`/actor/asks/:id/${what}`, dockJson, dockRelay('actor', 'POST', (req) => (dockId(req.params.id) ? `/api/v1/me/actor/asks/${encodeURIComponent(req.params.id)}/${what}` : null)));
    // One owner's agent sheet on any site. Actor checks ownership and capabilities; the relay accepts only its
    // fixed ID shapes and passes the person's Bearer upstream. The larger answer includes up to 100 work records.
    const AGENT_ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
    const MEMORY_ID = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/;
    const agentPath = (req, tail = '') => AGENT_ID.test(String(req.params.id || '')) ? `/api/v1/me/agents/${req.params.id}${tail}` : null;
    router.get('/agents/:id/sheet', dockRelay('actor', 'GET', (req) => {
        const path = agentPath(req);
        return path ? `${path}?view=sheet` : null;
    }, { maxBytes: 512 * 1024 }));
    router.get('/codes-agents/:id/sheet', dockRelay('codes', 'GET', (req) =>
        /^[a-z][a-z0-9-]{0,63}$/.test(String(req.params.id || '')) ? `/api/v1/me/agents/${req.params.id}/sheet` : null,
    { maxBytes: 512 * 1024 }));
    router.patch('/agents/:id', dockJson, dockRelay('actor', 'PATCH', (req) => agentPath(req)));
    router.post('/agents/:id/memory', dockJson, dockRelay('actor', 'POST', (req) => agentPath(req, '/memory')));
    router.patch('/agents/:id/memory/:mem', dockJson, dockRelay('actor', 'PATCH', (req) => MEMORY_ID.test(String(req.params.mem || '')) ? agentPath(req, `/memory/${req.params.mem}`) : null));
    router.delete('/agents/:id/memory/:mem', dockRelay('actor', 'DELETE', (req) => MEMORY_ID.test(String(req.params.mem || '')) ? agentPath(req, `/memory/${req.params.mem}`) : null));
    // OpenVibe.Codes' person tasks API (the Dock's Code tab): the latest tasks running first, one start, one stop.
    // ?limit= is the list's cap (the Dock asks with 8); the stop's id is a tsk_ id, anything else is not a task.
    const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
    router.get('/codes-tasks', dockRelay('codes', 'GET', (req) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
        return `/api/v1/me/tasks?limit=${limit}`;
    }));
    router.post('/codes-tasks', dockJson, dockRelay('codes', 'POST', '/api/v1/tasks'));
    router.post('/codes-tasks/:id/stop', dockJson, dockRelay('codes', 'POST', (req) => (TASK_ID.test(String(req.params.id || '')) ? `/api/v1/tasks/${req.params.id}/stop` : null)));
    // A task card follows its AG-UI run through Network. Codes authorizes the bearer on both reads; the
    // stream forwards only SSE and its id so a reconnect can resume at the last event.
    const RUN_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}(?:~[1-9][0-9]*)?$/;
    router.get('/codes-runs/:id', dockRelay('codes', 'GET', (req) => RUN_ID.test(String(req.params.id || ''))
        ? `/api/v1/runs/${encodeURIComponent(req.params.id)}` : null, { maxBytes: 512 * 1024 }));
    router.get('/agent-runs/actor/:id', dockRelay('actor', 'GET', (req) => RUN_ID.test(String(req.params.id || ''))
        ? `/api/v1/runs/${encodeURIComponent(req.params.id)}` : null, { maxBytes: 512 * 1024 }));
    const runEvents = (service) => async (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, no-store', 'Vary': 'Authorization' });
        const auth = dockAuth(req);
        const id = String(req.params.id || '');
        if (!auth) return res.status(401).json({ error: 'sign in to follow the run' });
        if (!RUN_ID.test(id)) return res.status(404).json({ error: 'not found' });
        const last = String(req.get('last-event-id') || '0');
        if (!/^\d{1,16}$/.test(last)) return res.status(400).json({ error: 'invalid event id' });
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        try {
            const upstream = await fetch(new URL(`/api/v1/runs/${encodeURIComponent(id)}/events`, svcUrl(service, service === 'codes' ? 'http://127.0.0.1:4900' : 'http://127.0.0.1:4950')).href, {
                headers: { Authorization: auth, Accept: 'text/event-stream', 'Last-Event-ID': last }, redirect: 'manual', signal: abort.signal
            });
            if (!upstream.ok || !String(upstream.headers.get('content-type') || '').startsWith('text/event-stream')) {
                return res.status(upstream.status).json({ error: 'run stream unavailable' });
            }
            res.status(200).set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
            res.flushHeaders();
            for await (const chunk of upstream.body) {
                if (abort.signal.aborted) break;
                if (!res.write(chunk)) await new Promise((resolve) => {
                    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                    res.once('drain', done); res.once('close', done);
                });
            }
            res.end();
        } catch { if (!res.headersSent) res.status(502).json({ error: 'run stream unavailable' }); else res.end(); }
    };
    router.get('/codes-runs/:id/events', runEvents('codes'));
    router.get('/agent-runs/actor/:id/events', runEvents('actor'));

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

    // GET /api/frame/choices?task=chat|agent|code|image|research — the composer's Model sheet (composer-post-ask-do.md,
    // R1): AI's choices for the person (their token forwarded; signed out, the OpenVibe group only), every OpenVibe row
    // enriched from Exchange's directory with its maker, price per million in and out, speed, rating and page.
    // Same CORS and caching as /query: the person's token means a fresh private answer; signed out it is kept 60 s.
    router.get('/choices', async (req, res) => {
        res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Authorization, Origin' });
        const task = String(req.query.task || 'chat').toLowerCase().slice(0, 20);
        const auth = /^Bearer [A-Za-z0-9._~+/=-]{20,4096}$/.test(String(req.headers.authorization || '')) ? String(req.headers.authorization) : '';
        const got = await choices.get(task, { token: auth.slice(7), signedIn: Boolean(auth) });
        if (got.error) { res.set('Cache-Control', 'no-store'); return res.status(400).json({ error: got.detail, code: 'frame.task_invalid' }); }
        res.set('Cache-Control', got.cache ? 'public, max-age=60' : 'private, no-store');
        res.send(JSON.stringify(got.body));
    });

    // GET /api/frame/commands?site=<host>&q= — the composer's slash commands (composer-post-ask-do.md, R3):
    // every site's /ask, /do, /remind and /timer, the site's own from its manifest, and a signed-in person's
    // saved snippets. Site commands come first, a name appears once, and q filters by name or hint.
    // Signed out the answer is public and held 60 s; signed in it is the person's own and never kept.
    const commandHeld = new Map();
    router.get('/commands', async (req, res) => {
        res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Authorization, Origin' });
        const site = String(req.query.site || '').slice(0, 255);
        const q = String(req.query.q || '').slice(0, 50);
        const user = await personOf(req).catch(() => null);
        let prefs = null;
        if (user && user.id != null) {
            try { const row = await db.prepare('SELECT composer_prefs FROM user_preferences WHERE user_id = ?').get(user.id); prefs = row ? row.composer_prefs : null; } catch { prefs = null; }
        }
        if (user) {
            res.set('Cache-Control', 'private, no-store');
        } else {
            const key = `${site.toLowerCase()}|${q.toLowerCase()}`;
            const kept = commandHeld.get(key);
            res.set('Cache-Control', 'public, max-age=60');
            if (kept && now() - kept.at < 60_000) return res.send(kept.body);
            const body = JSON.stringify(readCommands({ site, q, prefs: null, sites, siteForHost }));
            if (commandHeld.size >= 500) commandHeld.clear();
            commandHeld.set(key, { at: now(), body });
            return res.send(body);
        }
        res.send(JSON.stringify(readCommands({ site, q, signedIn: true, prefs, sites, siteForHost })));
    });

    // GET /api/frame/mentions?q=&site= — the composer's @ menu (composer-post-ask-do.md, R3): public people
    // first, then the person's own agents from the agent directory, then OpenVibe's places (open sites and
    // Live's public channels). At most eight; signed out it is public people only. Rate-limited per actor in
    // memory (a signed-in subject, or a hash of the address), never an email or a private account field.
    router.get('/mentions', async (req, res) => {
        res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Authorization, Origin' });
        const user = await personOf(req).catch(() => null);
        const allowed = mentions.allow(mentions.actorKey(req, user));
        if (!allowed.ok) {
            res.set({ 'Cache-Control': 'private, no-store', 'Retry-After': String(allowed.retryAfter) });
            return res.status(429).json({ error: 'Too many mention searches: try again in a minute', code: 'frame.mentions_rate_limited' });
        }
        const got = await mentions.get({ q: String(req.query.q || '').slice(0, 50), site: String(req.query.site || '').slice(0, 255), user });
        res.set('Cache-Control', user ? 'private, no-store' : 'public, max-age=60');
        res.send(JSON.stringify(got.body));
    });

    // POST /api/frame/ask — one question, answered on the chosen model with the Search Fabric's results for the
    // chosen scopes, streamed on Network's runs. Signed in only; the person's own token pays. The run's events are at
    // /api/v1/runs/:id/events (mounted in server/index.js), replayable from Last-Event-ID.
    router.post('/ask', ...ask.ask);

    // GET /api/frame/query/providers — the Sources popover's web ladder: Search's offers (provider, scopes, price,
    // availability, today's use), asked through Network for the same connect-src reason as /query. Same CORS and
    // caching: a person's token goes along and nothing is kept; signed out the offers are kept 60 s.
    const providerOffers = new Map();
    router.get('/query/providers', async (req, res) => {
        res.set({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Authorization, Origin' });
        const auth = /^Bearer [A-Za-z0-9._~+/=-]{20,4096}$/.test(String(req.headers.authorization || '')) ? String(req.headers.authorization) : '';
        const u = new URL('/api/v1/query/providers', svcUrl('search', 'http://127.0.0.1:4710'));
        const headers = { ...(req.ip ? { 'X-Forwarded-For': req.ip } : {}), ...(auth ? { Authorization: auth } : {}) };
        if (auth) {
            res.set('Cache-Control', 'private, no-store');
            const d = await getJson(u.href, headers, 10000);
            return res.send(JSON.stringify(d || { providers: [] }));
        }
        res.set('Cache-Control', 'public, max-age=60');
        const kept = providerOffers.get('offers');
        if (kept && Date.now() - kept.at < 60_000) return res.send(kept.body);
        const d = await getJson(u.href, headers, 10000);
        const body = JSON.stringify(d || { providers: [] });
        providerOffers.set('offers', { at: Date.now(), body });
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
            const at = now(); const k = req.ip || ''; const w = recent.get(k);
            if (!w || at - w[1] > 60_000) recent.set(k, [1, at]); else w[0]++;
            if (recent.size > 5000) recent.clear();
            const known = host && (siteForHost(host) || toolsCatalog.peek().catalog.tools.some(t => t.hosts && (t.hosts.canonical === host || t.hosts.short === host)));
            if (known && (recent.get(k) || [0])[0] <= 40 && !seen.isBot(ua)) {
                // The strip's guest count comes from this same beacon, never from a new call: a distinct address +
                // user agent in the last thirty minutes is one guest (in memory only). `?in=1` marks a signed-in
                // browser, which is counted as a member by its heartbeat instead, and it forgets any guest entry it
                // left earlier in the window.
                if (/^(1|true)$/.test(String(req.query.in || ''))) seen.forgetGuest(req.ip, ua, now());
                else seen.seenGuest(req.ip, ua, now());
                await bump.run(host);
            }
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
        await menuCards.start();
        timers = [t1, i1, t2, i2, t3, i3];
    }
    /** Graceful stop: no further rank or copy refreshes. */
    function stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; menuCards.stop(); try { ask._close(); } catch { /* already closed */ } }

    /** The open sites in navbar order (most used first), and when that use was last counted (ms, or null: cold start). */
    function ranking() {
        return { at: rankedAt, order: orderedOpen().map(s => s.id), everyMs: RANK_MS };
    }

    return { router, runsRouter: ask.router, start, stop, refreshRank, refreshCopy, probeLegal, refreshCards: menuCards.refresh, cards: menuCards.cards, payloadFor, ranking, online: onlineFor, _state: () => ({ rank, copy, cards: menuCards._state() }) };
}

module.exports = { createFrameService, BANNED, stripOf, openvibeLink };
