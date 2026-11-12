'use strict';

/**
 * OpenVibe.Events → one feed.
 *
 * The feed reads events, not each site: a public event that says something happened becomes one row
 * (migrations/0080_feed.sql), in the same item shape every other source uses. Pull, not a webhook:
 * Network already signs its own service tokens for Events (server/developer/event-relay.js), so the
 * feed needs no operator step to start, survives a restart with its cursor in feed_state, and starts
 * at the head on a fresh database (the public API collectors fill the look-back).
 *
 * Only public envelopes enter the feed; a `subject` or `internal` event never does. A topic that
 * names a private or unlisted thing carries an internal visibility, so filtering here also drops it.
 * The mapper is pure (eventToItems) so the recorded-input tests cover every kind.
 */
const crypto = require('crypto');
const { serviceAuth, assertValid } = require('openvibe-contracts');
const store = require('./store');

const CURSOR_KEY = 'events_cursor';
const TOKEN_TTL_S = 300;
const PAGE = 200;
const MAX_PAGES = 20;

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const https = (v) => {
    try {
        const u = new URL(String(v));
        return u.protocol === 'https:' ? u.href.slice(0, 2000) : null;
    } catch { return null; }
};
const userOf = (ref) => (ref && ref.type === 'user' && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(ref.id)) ? String(ref.id) : null);
const idOf = (event, payload, ...keys) => {
    for (const k of keys) {
        const v = payload && payload[k];
        if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(v)) return v;
        if (Number.isSafeInteger(v) && v >= 0) return String(v);
    }
    return String((event.subject && event.subject.id) || event.event_id);
};
const urlOf = (payload) => https(payload && (payload.canonical_url || payload.url || payload.href || (payload.media && payload.media.page)));
const mediaOf = (payload) => {
    const p = payload || {};
    const m = p.media && typeof p.media === 'object' ? p.media : p;
    const thumb = https(m.thumb || m.thumbnail_url || m.poster_url || m.picture_url);
    if (!thumb) return null;
    const w = Number(p.width || m.width), h = Number(p.height || m.height);
    return { thumb, ratio: Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : 16 / 9,
        ...(Number(m.duration_seconds || p.duration_seconds) > 0 ? { length: Number(m.duration_seconds || p.duration_seconds) } : {}) };
};
const originOf = (event, subject) => (event.actor && event.actor.type === 'ai' ? 'ai' : (subject ? 'user' : 'system'));
const countsOf = (payload, extra = {}) => {
    const c = payload && (payload.counts || payload.stats) || {};
    const out = { ...extra };
    for (const k of ['views', 'likes', 'comments', 'watchers', 'people']) {
        const n = Number(c[k]);
        if (Number.isSafeInteger(n) && n >= 0) out[k] = n;
    }
    return out;
};

const SITE = { live: 'Live', 'media-hub': 'Video', media: 'Media', games: 'Games', blog: 'Blog', wiki: 'Wiki', news: 'News', chat: 'Chat', deals: 'Deals', space: 'Space', rundown: 'Live', today: 'Today' };

/** One public envelope → { items, remove } (never anything for an internal or subject event). */
function eventToItems(event) {
    if (!event || typeof event !== 'object' || event.visibility !== 'public') return { items: [], remove: [] };
    const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const at = store.iso(event.timestamp) || new Date().toISOString();
    const actor = event.actor && event.actor.type === 'user' ? userOf(event.actor) : null;
    const subject = userOf(event.subject) || actor;
    const source = String(event.source || '');
    const type = String(event.event_type || '');
    const item = (over) => ({
        source_service: over.service || source, source_type: over.type, source_id: over.id, kind: over.kind,
        title: clean(over.title, 300), text: clean(over.text, 280), url: over.url,
        site: over.service || source, site_name: SITE[over.service || source] || over.service || source,
        actor_subject: over.subject === undefined ? subject : over.subject,
        actor_name: null, origin: over.origin || originOf(event, subject), visibility: 'public',
        picture_url: over.media && over.media.thumb, preview_url: over.media && over.media.preview,
        media_ratio: over.media && over.media.ratio, media_length: over.media && over.media.length,
        counts: over.counts || {}, live_now: over.live_now === true, label: over.label || null,
        starts_at: over.starts_at || null, occurred_at: over.at || at, touch: over.touch === true,
    });

    if (type === 'live.stream.started') {
        const channel = p.channel && typeof p.channel === 'object' ? p.channel : {};
        const url = https(channel.url) || (channel.username ? `https://openvibe.live/@${encodeURIComponent(channel.username)}` : null);
        if (!url) return { items: [], remove: [] };
        const who = userOf(channel.subject) || actor;
        const name = clean(channel.display_name || channel.username, 80) || 'A channel';
        return { items: [item({ service: 'live', type: 'stream', id: idOf(event, p, 'stream_id') || String(channel.username || 'live'), kind: 'live',
            title: p.title ? `${name} went live: ${clean(p.title, 160)}` : `${name} went live`, url,
            subject: who, at: p.started_at || at, live_now: true })], remove: [] };
    }
    if (type === 'mediahub.video.published') {
        const url = urlOf(p);
        if (!url) return { items: [], remove: [] };
        return { items: [item({ service: 'media-hub', type: 'video', id: idOf(event, p, 'video_id'), kind: 'video',
            title: clean(p.title, 160) || 'A video', text: p.description || p.excerpt, url, media: mediaOf(p), counts: countsOf(p) })], remove: [] };
    }
    if (type === 'mediahub.picture.uploaded') {
        const url = urlOf(p);
        if (!url) return { items: [], remove: [] };
        return { items: [item({ service: 'media-hub', type: 'picture', id: idOf(event, p, 'picture_id'), kind: 'pic',
            title: clean(p.title || p.caption, 160) || 'A picture', url, media: mediaOf(p), counts: countsOf(p) })], remove: [] };
    }
    if (type === 'games.world.published') {
        const url = urlOf(p);
        if (!url) return { items: [], remove: [] };
        return { items: [item({ service: 'games', type: 'world', id: idOf(event, p, 'world_id'), kind: 'game',
            title: clean(p.title, 160) || 'A new world', text: p.description, url, media: mediaOf(p) })], remove: [] };
    }
    if (type === 'games.skill.leveled') {
        const url = https(p.url) || 'https://openvibe.games/';
        const level = Number(p.level);
        return { items: [item({ service: 'games', type: 'level', id: `${subject || idOf(event, p, 'game')}:${Number.isSafeInteger(level) ? level : idOf(event, p, 'level')}`, kind: 'game',
            title: `Reached level ${Number.isSafeInteger(level) ? level : '?'} in ${clean(p.game_name || p.world || 'a game', 80)}`, url, at })], remove: [] };
    }
    if (type === 'blog.post.published' || type === 'wiki.page.published' || type === 'wiki.page.updated' || type === 'news.story.published' || type === 'news.story.updated') {
        const url = urlOf(p);
        if (!url) return { items: [], remove: [] };
        const service = type.startsWith('blog') ? 'blog' : type.startsWith('wiki') ? 'wiki' : 'news';
        const kind = service === 'blog' ? 'update' : service === 'wiki' ? 'wiki' : 'news';
        const title = service === 'blog'
            ? (p.blog ? `New post on the ${clean(p.blog.handle || p.blog, 60)} blog` : 'New post on an OpenVibe blog')
            : service === 'wiki' ? (clean(p.title, 160) || `Wiki: ${clean(p.space, 40)} / ${clean(p.slug, 60)}`)
                : `News: ${clean(p.topic, 60) || clean(p.title, 120) || 'a new story'}`;
        return { items: [item({ service, type: service === 'news' ? 'story' : 'post', id: idOf(event, p, `${service}_id`, 'page_id', 'post_id'), kind,
            title, text: p.description || p.excerpt || p.summary, url, media: mediaOf(p), counts: countsOf(p),
            ...(type.endsWith('.updated') ? { touch: true } : {}) })], remove: [] };
    }
    if (type === 'wiki.page.deleted' || type === 'wiki.page.unpublished') {
        return { items: [], remove: [{ service: 'wiki', type: 'post', id: idOf(event, p, 'page_id') }] };
    }
    if (type === 'news.story.unpublished' || type === 'news.story.retracted') {
        return { items: [], remove: [{ service: 'news', type: 'story', id: idOf(event, p, 'story_id') }] };
    }
    if (type === 'chat.room.message.created') {
        const room = p.room && typeof p.room === 'object' ? p.room : {};
        const slug = clean(room.slug, 64);
        const when = store.iso(p.created_at) || at;
        if (!slug) return { items: [], remove: [] };
        const hour = String(when).slice(0, 13);
        return { items: [item({ service: 'chat', type: 'hour', id: `${slug}:${hour}`, kind: 'chat',
            title: `A busy hour in #${clean(room.name || slug, 60)}`, text: '1 message', url: `https://openvibe.chat/r/${encodeURIComponent(slug)}`,
            subject: null, at: `${hour}:00:00.000Z`, counts: { comments: 1 } })], remove: [] };
    }
    if (type === 'deals.offer.created' || type === 'deals.offer.updated') {
        const url = urlOf(p);
        if (!url) return { items: [], remove: [] };
        return { items: [item({ service: 'deals', type: 'offer', id: idOf(event, p, 'offer_id'), kind: 'deal',
            title: clean(p.title, 160) || 'A deal', text: p.description || p.excerpt, url, media: mediaOf(p), counts: countsOf(p),
            ...(type.endsWith('.updated') ? { touch: true } : {}) })], remove: [] };
    }
    if (type === 'deals.offer.expired') return { items: [], remove: [{ service: 'deals', type: 'offer', id: idOf(event, p, 'offer_id') }] };
    if (type === 'space.deploy.activated') {
        const url = urlOf(p);
        if (!url) return { items: [], remove: [] };
        return { items: [item({ service: 'space', type: 'space', id: idOf(event, p, 'deploy_id'), kind: 'space',
            title: clean(p.name || p.title, 160) || 'A new space', text: p.description, url })], remove: [] };
    }
    return { items: [], remove: [] };
}

/** Apply mapped rows; a chat hour grows instead of duplicating. */
async function apply(db, mapped) {
    let n = 0;
    for (const it of mapped.items) {
        if (it.source_service === 'chat' && it.source_type === 'hour') {
            const had = await db.prepare('SELECT counts, text FROM feed_items WHERE source_service = ? AND source_type = ? AND source_id = ?').get('chat', 'hour', it.source_id);
            if (had) {
                const messages = Math.max(0, Number(had.counts && had.counts.comments) || 0) + 1;
                await db.prepare("UPDATE feed_items SET text = ?, counts = ?, updated_at = now() WHERE source_service = 'chat' AND source_type = 'hour' AND source_id = ?")
                    .run(`${messages} messages`, JSON.stringify({ comments: messages }), it.source_id);
                continue;
            }
        }
        await store.upsertItem(db, it);
        n++;
    }
    for (const r of mapped.remove) await store.removeItem(db, r.service, r.type, r.id);
    return n;
}

function tokenSource({ privateKey, issuer }) {
    let cached = null;
    return () => {
        const now = Math.floor(Date.now() / 1000);
        if (cached && cached.exp - 60 > now) return cached.token;
        const claims = { iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.events'],
            cap: ['events.event.read'], iat: now, exp: now + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}` };
        assertValid('identity.service-token-claims@1', claims);
        cached = { token: serviceAuth.signServiceToken(claims, privateKey), exp: claims.exp };
        return cached.token;
    };
}

function createEventsPull({ db, eventsUrl, privateKey, issuer, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    const base = String(eventsUrl || '').replace(/\/+$/, '');
    const token = privateKey && issuer ? tokenSource({ privateKey, issuer }) : null;
    let timer = null;
    let running = null;

    async function get(params) {
        const u = new URL('/api/v1/events', base);
        for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
        const res = await fetchImpl(u.href, { headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`Events ${res.status}`);
        return await res.json();
    }
    const saved = async () => {
        const row = await db.prepare('SELECT value FROM feed_state WHERE key = ?').get(CURSOR_KEY);
        return row && row.value && typeof row.value.cursor === 'string' ? row.value.cursor : null;
    };
    const save = async (cursor) => {
        await db.prepare(`INSERT INTO feed_state (key, value, updated_at) VALUES (?, ?, now())
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`).run(CURSOR_KEY, JSON.stringify({ cursor, at: new Date(now()).toISOString() }));
    };

    /** Read pages after the saved cursor. A fresh feed starts at the head (the API collectors cover the look-back). */
    async function pullOnce({ pages = MAX_PAGES } = {}) {
        if (!base || !token) return { skipped: 'events not configured' };
        let cursor = await saved();
        if (!cursor) {
            const head = await get({ limit: '1' });
            if (typeof head.latest_cursor === 'string') { await save(head.latest_cursor); return { bootstrapped: true }; }
            return { bootstrapped: false };
        }
        let created = 0, seen = 0;
        for (let i = 0; i < pages; i++) {
            const out = await get({ topic: '*', after: cursor, limit: String(PAGE) });
            const events = Array.isArray(out.events) ? out.events : [];
            for (const row of events) {
                seen++;
                const mapped = eventToItems(row && row.event);
                created += await apply(db, mapped);
            }
            if (typeof out.next_cursor === 'string') { cursor = out.next_cursor; await save(cursor); }
            if (!events.length || !out.next_cursor) break;
        }
        return { seen, created };
    }

    function start({ every = 20_000 } = {}) {
        if (timer || !base || !token) return;
        const tick = () => { if (!running) running = pullOnce().catch((err) => log.warn && log.warn('[Feed events]', err.message)).finally(() => { running = null; }); };
        timer = setInterval(tick, every);
        if (timer.unref) timer.unref();
        const first = setTimeout(tick, 2500);
        if (first.unref) first.unref();
        timer.first = first;
    }
    function stop() {
        if (timer) clearInterval(timer);
        if (timer && timer.first) clearTimeout(timer.first);
        timer = null;
    }
    return { pullOnce, start, stop, eventToItems, apply };
}

module.exports = { eventToItems, apply, createEventsPull, SITE };
