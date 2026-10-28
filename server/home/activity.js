'use strict';
// What is happening on the network right now, for the front door (plan T11, D93): who is live on OpenVibe.Live and its
// latest recordings (watched on OpenVibe.Video), the newest public pastes on OpenVibe.Community, the newest posts on
// OpenVibe.Blog, and the newest jobs and coupon codes OpenVibe.Search holds for OpenVibe.Work and OpenVibe.Coupons. Each
// comes from the service's own public API over loopback (fixed first-party addresses, never a URL anyone can choose), and
// the home page never waits for them: it renders what is known, and a read older than a minute starts one refresh in
// the background. A service that does not answer within two seconds simply contributes nothing this round.
//
// The same refresh reads two numbers Network knows itself (configure()): how many accounts exist and how many of the
// public services answered their last health check. Nothing here is estimated: a number nobody could read is left out.
const contracts = require('openvibe-contracts');

const TTL_MS = 60_000;
const TIMEOUT_MS = 2000;

const origin = (id, fallback) => { const m = contracts.services.get(id); return (m && m.internalOrigin) || fallback; };
const SOURCES = {
    live: process.env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000',
    community: process.env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200',
    blog: process.env.OV_BLOG_INTERNAL_URL || 'http://127.0.0.1:4810',
    search: process.env.OV_SEARCH_INTERNAL_URL || origin('search', 'http://127.0.0.1:4710'),
};
const PUBLIC = { live: 'https://openvibe.live', video: 'https://openvibe.video', community: 'https://openvibe.community', blog: 'https://openvibe.blog', work: 'https://openvibe.work', coupons: 'https://openvibe.coupons' };

const EMPTY = { live: [], liveCount: 0, recordings: [], pastes: [], posts: [], jobs: [], codes: [], counts: {} };
let state = { at: 0, version: 0, ...EMPTY };
let inflight = null;
// Tests switch the reads off; the page then shows the "nothing live" state.
let enabled = process.env.HOME_ACTIVITY !== 'off' && process.env.NODE_ENV !== 'test';
// Network's own numbers (server/index.js): accounts() → a count, services() → { up, live }.
let readers = {};

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
// An empty value is no URL (new URL('', base) is the base itself: a stream with no thumbnail drew openvibe.live's home
// page as its picture, a blank box, instead of falling back to the streamer's avatar).
const abs = (base, u) => { if (u == null || String(u).trim() === '') return null; try { const x = new URL(String(u), base); return /^https:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const onHost = (u, host) => { try { const x = new URL(String(u || '')); return x.protocol === 'https:' && x.hostname === host ? x.href : null; } catch { return null; } };

// The front door is the network's most public page, so it is stricter than the services it quotes: an item whose words
// read as adult content is left out, and AI words that describe a person (looks, clothing, a guessed gender) are never
// repeated here (the owner's rule for public AI text). Such an item still lives on its own site; it is just not featured.
const ADULT = /(^|[^\w])18\s*\+|\b(adults?[- ]only|adult[- ](industry|content|work|entertainment)|nsfw|xxx|porn\w*|onlyfans|escorts?|webcam (models?|creators?|girls?)|cam ?girls?|sugar (daddy|baby)|nude\w*|sexy)\b/i;
const LOOKS = /\b(man|woman|men|women|girl|boy|guy|lady|ladies|gentleman|blond(e|es)?|brunette|redhead|beard(ed)?|hair\w*|wearing|dressed|outfit|shirtless|bikini|lingerie|cleavage|his|her|he|she)\b/i;

async function getJson(url, fetchImpl) {
    try {
        const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

function liveRows(body) {
    const rows = body && Array.isArray(body.streams) ? body.streams : [];
    return rows.filter((s) => s && s.is_live && !s.is_nsfw && s.username);
}

function liveStreams(body) {
    return liveRows(body)
        .map((s) => ({
            name: clip(s.display_name || s.username, 40),
            title: clip(s.ai_title || s.title || `${s.username} is live`, 90),
            url: `${PUBLIC.live}/@${encodeURIComponent(s.username)}`,
            thumb: abs(PUBLIC.live, s.thumbnail_url),
            avatar: abs(PUBLIC.live, s.avatar_url),
            viewers: Math.max(0, Number(s.total_viewer_count ?? s.viewer_count) || 0),
            category: clip(s.category || '', 24),
        }))
        .sort((a, b) => b.viewers - a.viewers)
        .slice(0, 4);
}

/** "1h 53m", "28 min": how long a recording runs. */
function runtime(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s >= 3600) { const m = Math.floor((s % 3600) / 60); return `${Math.floor(s / 3600)}h${m ? ` ${m}m` : ''}`; }
    return `${Math.max(1, Math.round(s / 60))} min`;
}

// The latest recordings worth opening: public, ready, at least ten minutes long, one per channel, so the row is a few
// different streams rather than one stream's parts. Each opens on OpenVibe.Video, where recordings are watched.
const MIN_RECORDING_S = 600;
function recordings(body) {
    const rows = body && Array.isArray(body.vods) ? body.vods : [];
    const seen = new Set();
    const out = [];
    for (const v of rows) {
        if (!v || !v.id || !v.username || v.status !== 'ready' || v.is_nsfw || v.visibility !== 'public' || v.is_public === false) continue;
        if ((Number(v.duration_seconds ?? v.duration) || 0) < MIN_RECORDING_S || seen.has(v.username)) continue;
        const title = clip(v.title || '', 80);
        if (!title || ADULT.test(title)) continue;
        seen.add(v.username);
        // What happens in it (Live's AI overview), one line, only when it names nobody's looks (public AI text).
        const about = clip(String(v.ai_overview || '').split(/(?<=[.!?])\s/)[0] || '', 120);
        out.push({
            title,
            url: `${PUBLIC.video}/v/${encodeURIComponent(v.id)}`,
            thumb: onHost(v.thumbnail_url, 'openvibe.media'),
            channel: clip(v.display_name || v.username, 40),
            length: runtime(v.duration_seconds ?? v.duration),
            seconds: Math.round(Number(v.duration_seconds ?? v.duration) || 0),
            avatar: onHost(v.avatar_url, 'openvibe.media'),
            views: Math.max(0, Number(v.view_count) || 0),
            at: Date.parse(v.created_at) || null,
            about: about && !LOOKS.test(about) && !ADULT.test(about) ? about : '',
        });
        if (out.length === 4) break;
    }
    return out;
}

function publicPastes(body) {
    const rows = body && Array.isArray(body.pastes) ? body.pastes : [];
    return rows
        .filter((p) => p && p.visibility === 'public' && !p.is_nsfw && !p.burn_after_read && p.slug)
        .filter((p) => !ADULT.test(`${p.title || ''} ${p.ai_summary || ''}`) && !LOOKS.test(p.title || ''))
        .map((p) => {
            const shot = p.type === 'screenshot';
            // A screenshot's summary is an AI description of a picture, so it can describe a person: only a text or code
            // paste's summary is quoted, and only when it names nobody's looks.
            const summary = shot || LOOKS.test(p.ai_summary || '') ? '' : clip(p.ai_summary || '', 110);
            return {
                title: clip(p.title || 'Untitled paste', 70),
                url: `${PUBLIC.community}/p/${encodeURIComponent(p.slug)}`,
                kind: shot ? 'Screenshot' : (p.language && p.language !== 'text' ? p.language : 'Text'),
                summary,
                shot: shot ? onHost(p.screenshot_url, 'openvibe.media') : null,
                by: clip(p.display_name || p.username || '', 40),
                avatar: onHost(p.avatar_url, 'openvibe.media'),
                views: Math.max(0, Number(p.views ?? p.unique_views) || 0),
                likes: Math.max(0, Number(p.likes) || 0),
                at: Date.parse(p.created_at) || null,
            };
        })
        .slice(0, 4);
}

function blogPosts(body) {
    const rows = body && Array.isArray(body.items) ? body.items : [];
    return rows
        .filter((i) => i && i.url && abs(PUBLIC.blog, i.url))
        .map((i) => ({ title: clip(i.title || 'Untitled', 80), url: abs(PUBLIC.blog, i.url), summary: clip(i.summary || '', 120), date: i.date_published || null }))
        .slice(0, 3);
}

// OpenVibe.Search documents (newest first when the query has no words): only public, indexable ones with a canonical
// address on the owning site.
function searchDocs(body, host) {
    const rows = body && Array.isArray(body.results) ? body.results : [];
    return rows.filter((d) => d && d.visibility === 'public' && d.indexable !== false && d.title && onHost(d.canonical_url, host));
}

function jobs(body) {
    return searchDocs(body, 'openvibe.work')
        .filter((d) => !ADULT.test(`${d.title} ${d.summary || ''}`))
        .map((d) => {
            const f = d.facets || {};
            const where = clip(f.location || d.summary || '', 48);
            const board = d.provenance && d.provenance[0] && d.provenance[0].label ? clip(d.provenance[0].label, 30) : '';
            return { title: clip(d.title, 90), url: onHost(d.canonical_url, 'openvibe.work'), where: f.remote ? (where ? `Remote · ${where}` : 'Remote') : where, board };
        })
        .slice(0, 4);
}

function coupons(body) {
    return searchDocs(body, 'openvibe.coupons')
        .filter((d) => !ADULT.test(d.title))
        .map((d) => {
            // Coupons titles read "CODE — what it takes off": the code is shown as a chip, the rest as the line.
            const m = /^(\S{2,32})\s+—\s+(.+)$/.exec(String(d.title).trim());
            return { code: m ? clip(m[1], 32) : '', title: clip(m ? m[2] : d.title, 90), url: onHost(d.canonical_url, 'openvibe.coupons') };
        })
        .slice(0, 4);
}

async function readCount(fn) {
    if (typeof fn !== 'function') return null;
    try { const v = await fn(); return v == null ? null : v; } catch { return null; }
}

/** One refresh of every source; a source that fails keeps its last good list. */
async function refresh({ fetch: fetchImpl = globalThis.fetch } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
        const q = (owner, type) => `${SOURCES.search}/api/v1/search?owner=${owner}&type=${type}&limit=12`;
        const [live, vods, pastes, posts, work, codes, accounts, services] = await Promise.all([
            getJson(`${SOURCES.live}/api/streams`, fetchImpl),
            getJson(`${SOURCES.live}/api/vods?limit=40`, fetchImpl),
            getJson(`${SOURCES.community}/api/pastes?limit=12`, fetchImpl),
            getJson(`${SOURCES.blog}/feed.json`, fetchImpl),
            getJson(q('work', 'job'), fetchImpl),
            getJson(q('coupons', 'coupon'), fetchImpl),
            readCount(readers.accounts),
            readCount(readers.services),
        ]);
        const counts = { ...state.counts };
        if (Number.isFinite(Number(accounts)) && Number(accounts) > 0) counts.accounts = Number(accounts);
        if (services && Number(services.live) > 0) counts.services = { up: Math.max(0, Number(services.up) || 0), live: Number(services.live) };
        state = {
            at: Date.now(),
            version: state.version + 1,
            live: live ? liveStreams(live) : state.live,
            liveCount: live ? liveRows(live).length : state.liveCount,
            recordings: vods ? recordings(vods) : state.recordings,
            pastes: pastes ? publicPastes(pastes) : state.pastes,
            posts: posts ? blogPosts(posts) : state.posts,
            jobs: work ? jobs(work) : state.jobs,
            codes: codes ? coupons(codes) : state.codes,
            counts,
        };
        return state;
    })().finally(() => { inflight = null; });
    return inflight;
}

/** What is known now; starts a background refresh when it is older than a minute. */
function peek() {
    if (enabled && Date.now() - state.at > TTL_MS && !inflight) refresh().catch(() => {});   // floating-ok: refresh catches its own reads
    return state;
}

module.exports = {
    peek, refresh, liveStreams, recordings, publicPastes, blogPosts, jobs, coupons, runtime, ADULT, LOOKS,
    /** server/index.js: Network's own numbers, read on each refresh ({ accounts: async () => n, services: () => ({ up, live }) }). */
    configure(r) { readers = { ...readers, ...(r || {}) }; },
    /** Tests: switch the background reads on or off. */
    setEnabled(on) { enabled = Boolean(on); },
    /** Tests: replace the snapshot. */
    _set(s) { state = { at: Date.now(), version: state.version + 1, ...EMPTY, ...s }; },
};
