'use strict';
// What is happening on the network right now, for the front door (plan T11, D93): who is live on OpenVibe.Live, the
// newest public pastes on OpenVibe.Community and the newest posts on OpenVibe.Blog. Each comes from the service's own
// public API over loopback (fixed first-party addresses, never a URL anyone can choose), and the home page never waits
// for them: it renders what is known, and a read older than a minute starts one refresh in the background. A service
// that does not answer within two seconds simply contributes nothing this round.
const TTL_MS = 60_000;
const TIMEOUT_MS = 2000;

const SOURCES = {
    live: process.env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000',
    community: process.env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200',
    blog: process.env.OV_BLOG_INTERNAL_URL || 'http://127.0.0.1:4810',
};
const PUBLIC = { live: 'https://openvibe.live', community: 'https://openvibe.community', blog: 'https://openvibe.blog' };

let state = { at: 0, version: 0, live: [], pastes: [], posts: [] };
let inflight = null;
// Tests switch the reads off; the page then shows the "nothing live" state.
let enabled = process.env.HOME_ACTIVITY !== 'off' && process.env.NODE_ENV !== 'test';

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const abs = (base, u) => { try { const x = new URL(String(u || ''), base); return /^https:$/.test(x.protocol) ? x.href : null; } catch { return null; } };

async function getJson(url, fetchImpl) {
    try {
        const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

function liveStreams(body) {
    const rows = body && Array.isArray(body.streams) ? body.streams : [];
    return rows
        .filter((s) => s && s.is_live && !s.is_nsfw && s.username)
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

function publicPastes(body) {
    const rows = body && Array.isArray(body.pastes) ? body.pastes : [];
    return rows
        .filter((p) => p && p.visibility === 'public' && !p.is_nsfw && !p.burn_after_read && p.slug)
        .map((p) => ({
            title: clip(p.title || 'Untitled paste', 70),
            url: `${PUBLIC.community}/p/${encodeURIComponent(p.slug)}`,
            kind: p.type === 'screenshot' ? 'Screenshot' : (p.language && p.language !== 'text' ? p.language : 'Text'),
            summary: clip(p.ai_summary || '', 110),
        }))
        .slice(0, 4);
}

function blogPosts(body) {
    const rows = body && Array.isArray(body.items) ? body.items : [];
    return rows
        .filter((i) => i && i.url && abs(PUBLIC.blog, i.url))
        .map((i) => ({ title: clip(i.title || 'Untitled', 80), url: abs(PUBLIC.blog, i.url), summary: clip(i.summary || '', 120), date: i.date_published || null }))
        .slice(0, 3);
}

/** One refresh of every source; a source that fails keeps its last good list. */
async function refresh({ fetch: fetchImpl = globalThis.fetch } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
        const [live, pastes, posts] = await Promise.all([
            getJson(`${SOURCES.live}/api/streams`, fetchImpl),
            getJson(`${SOURCES.community}/api/pastes?limit=12`, fetchImpl),
            getJson(`${SOURCES.blog}/feed.json`, fetchImpl),
        ]);
        state = {
            at: Date.now(),
            version: state.version + 1,
            live: live ? liveStreams(live) : state.live,
            pastes: pastes ? publicPastes(pastes) : state.pastes,
            posts: posts ? blogPosts(posts) : state.posts,
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
    peek, refresh, liveStreams, publicPastes, blogPosts,
    /** Tests: switch the background reads on or off. */
    setEnabled(on) { enabled = Boolean(on); },
    /** Tests: replace the snapshot. */
    _set(s) { state = { at: Date.now(), version: state.version + 1, live: [], pastes: [], posts: [], ...s }; },
};
