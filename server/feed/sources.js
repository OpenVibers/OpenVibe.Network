'use strict';

/**
 * The public API collectors: the activity that has no Events topic of its own, read on a due basis.
 *
 * The feed never calls a site while a person is reading it (server/feed/api.js reads feed_items only).
 * These jobs fill that table:
 *   - OpenVibe.Community: GET /api/v1/activity (public, direct query, no Pulse store) → posts, pastes,
 *     accepted submissions and their counts. Community's own writes are not Events topics with words.
 *   - OpenVibe.Today: GET /api/v1/events → one event card per scheduled stream or event.
 *   - OpenVibe.Network: its own users (never HTTP) → one grouped member card per day.
 *   - OpenVibe.Quest: /api/v1/profiles/:subject/badges for people recently active in the feed.
 *   - OpenVibe.Play: /api/v1/achievements/feed → public unlock cards.
 *   - OpenVibe.Meme: /api/v1/entries → public meme entries.
 *   - OpenVibe.Pics: /api/v1/gallery → public pictures.
 *   - OpenVibe.Live: /api/streams (live now), /api/content/feed (recordings and clips),
 *     /api/rundown/streams (rundown episodes); creator watch summaries from Network's own analytics.
 *   - OpenVibe.Space: /api/v1/apps/gallery → public spaces.
 *   - OpenVibe.Work: /api/v1/jobs → new jobs (one grouped card per hour at read time).
 *   - OpenVibe.Deals: /api/v1/offers → new deals.
 *   - OpenVibe.News: /api/v1/stories → published stories.
 *   - OpenVibe.Report: /api/v1/stats → one report card per day, with Network's own online peak.
 *
 * Due-ness lives in feed_source_runs, so a restart does not skip a source and two processes do not
 * both fetch one. A minute timer only checks those rows.
 */
const store = require('./store');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const QUEST_RECENT_MS = 14 * DAY;
const QUEST_CHECK_MS = 24 * 60 * MINUTE;

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const https = (u) => {
    try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href.slice(0, 2000) : null; } catch { return null; }
};
const subject = (v) => (/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(v || '')) ? String(v) : null);
const sqlFrom = (v) => {
    const t = Date.parse(String(v == null ? '' : v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const siteName = (id) => ({ live: 'Live', today: 'Today', network: 'Network', quest: 'Quest', play: 'Games', games: 'Games', meme: 'Meme', pics: 'Pics', space: 'Space', work: 'Work', deals: 'Deals', news: 'News', report: 'Report', community: 'Community' })[id] || id;

function createFeedSources({ db, config = {}, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, presence = null } = {}) {
    const feed = config.feed || {};
    const urls = {
        community: String(feed.communityUrl || (config.services && config.services.community && config.services.community.internalUrl) || 'https://openvibe.community').replace(/\/+$/, ''),
        today: String(feed.todayUrl || 'https://openvibe.today').replace(/\/+$/, ''),
        quest: String(feed.questUrl || 'https://openvibe.quest').replace(/\/+$/, ''),
        play: String(feed.playUrl || 'https://openvibe.games').replace(/\/+$/, ''),
        meme: String(feed.memeUrl || 'https://openvibe.meme').replace(/\/+$/, ''),
        pics: String(feed.picsUrl || 'https://openvibe.pics').replace(/\/+$/, ''),
        live: String(feed.liveUrl || (config.services && config.services.live && config.services.live.internalUrl) || 'https://openvibe.live').replace(/\/+$/, ''),
        space: String(feed.spaceUrl || 'https://openvibe.space').replace(/\/+$/, ''),
        work: String(feed.workUrl || 'https://openvibe.work').replace(/\/+$/, ''),
        deals: String(feed.dealsUrl || 'https://openvibe.deals').replace(/\/+$/, ''),
        news: String(feed.newsUrl || 'https://openvibe.news').replace(/\/+$/, ''),
        blog: String(feed.blogUrl || 'https://openvibe.blog').replace(/\/+$/, ''),
        wiki: String(feed.wikiUrl || 'https://openvibe.wiki').replace(/\/+$/, ''),
        report: String(feed.reportUrl || 'https://openvibe.report').replace(/\/+$/, ''),
    };
    let timer = null;
    let running = null;

    async function getJson(url, { timeoutMs = 10000 } = {}) {
        const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        return await res.json();
    }
    async function getText(url, { timeoutMs = 10000 } = {}) {
        const res = await fetchImpl(url, { headers: { accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        return await res.text();
    }

    /** A Live channel's person: the one Network account with that username, cached. */
    async function personOf(handle) {
        const key = clean(handle, 64).toLowerCase();
        if (!key) return null;
        const hit = await db.prepare('SELECT subject_id FROM feed_channel_people WHERE handle = ?').get(key);
        if (hit) return hit.subject_id;
        const rows = await db.prepare('SELECT subject_id FROM users WHERE lower(username) = ? AND subject_id IS NOT NULL AND COALESCE(is_test, 0) = 0 LIMIT 2').all(key);
        const one = rows.length === 1 ? subject(rows[0].subject_id) : null;
        if (one) await db.prepare('INSERT INTO feed_channel_people (handle, subject_id) VALUES (?, ?) ON CONFLICT (handle) DO UPDATE SET subject_id = excluded.subject_id, updated_at = now()').run(key, one);
        return one;
    }

    async function upsert(it) { return await store.upsertItem(db, it); }

    // ── Community ─────────────────────────────────────────────
    /** Community's public activity, read directly from its tables: no Pulse store, no second pipeline. */
    async function communityActivity() {
        const since = new Date(now() - 30 * DAY).toISOString();
        const out = await getJson(`${urls.community}/api/v1/activity?since=${encodeURIComponent(since)}&limit=1000`);
        let created = 0;
        for (const a of (Array.isArray(out.items) ? out.items : [])) {
            const id = clean(a && a.id, 120);
            const url = https(a && a.url);
            const title = clean(a && a.title, 300);
            if (!id || !url || !title) continue;
            const type = clean(a.type, 40) || 'post';
            const kind = a.kind || (type === 'paste' ? (a.picture_url ? 'pic' : 'paste') : type === 'thread' || type === 'status' ? 'post' : 'post');
            const r = await upsert({
                source_service: 'community', source_type: type, source_id: id, kind,
                title, text: clean(a.text, 280), url, site: 'community', site_name: 'Community',
                actor_subject: subject(a.actor), actor_name: clean(a.actor_name, 80) || null,
                origin: a.origin === 'ai' ? 'ai' : (a.origin === 'system' ? 'system' : 'user'),
                visibility: a.visibility === 'followers' ? 'followers' : 'public',
                picture_url: https(a.picture_url), media_ratio: Number(a.media_ratio) > 0 ? Number(a.media_ratio) : null,
                counts: a.counts && typeof a.counts === 'object' ? a.counts : {}, occurred_at: sqlFrom(a.at) || new Date().toISOString(),
            });
            if (r.created) created++;
        }
        return created;
    }

    // ── Today ─────────────────────────────────────────────────
    async function todayEvents() {
        const at = now();
        const out = await getJson(`${urls.today}/api/v1/events?from=${encodeURIComponent(new Date(at).toISOString())}&to=${encodeURIComponent(new Date(at + 60 * DAY).toISOString())}&limit=100`);
        let created = 0;
        for (const e of (Array.isArray(out.events) ? out.events : [])) {
            if (!e || typeof e.id !== 'string' || !e.id || typeof e.title !== 'string' || !e.title.trim()) continue;
            if (e.visibility !== 'public' || e.status === 'cancelled') continue;
            const starts = Date.parse(String(e.starts_at || ''));
            if (!Number.isFinite(starts) || starts <= at) continue;
            const owner = subject(e.owner_subject);
            const whenLabel = `Starts ${new Date(starts).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
            const r = await upsert({
                source_service: 'today', source_type: 'event', source_id: e.id, kind: 'event',
                title: `Coming up: ${clean(e.title, 140)}`, url: https(e.url) || `${urls.today}/e/${encodeURIComponent(e.id)}`,
                site: 'today', site_name: 'Today', actor_subject: owner, origin: owner ? 'user' : 'system',
                text: [whenLabel, clean(e.description, 220)].filter(Boolean).join(' · '), starts_at: e.starts_at,
                occurred_at: sqlFrom(e.created_at) || new Date(at).toISOString(),
                counts: Number.isSafeInteger(Number(e.attending)) && Number(e.attending) > 0 ? { people: Number(e.attending) } : {},
            });
            if (r.created) created++;
        }
        return created;
    }

    // ── Network members ───────────────────────────────────────
    async function networkMembers() {
        const at = now();
        const rows = await db.prepare(`SELECT substring(created_at, 1, 10) AS day, COUNT(*) AS n FROM users
            WHERE COALESCE(is_test, 0) = 0 AND COALESCE(is_anon, 0) = 0 AND created_at >= ?
            GROUP BY substring(created_at, 1, 10) ORDER BY day DESC LIMIT 7`).all(new Date(at - 7 * DAY).toISOString().slice(0, 10));
        const total = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE COALESCE(is_test, 0) = 0 AND COALESCE(is_anon, 0) = 0').get();
        const today = new Date(at).toISOString().slice(0, 10);
        let created = 0;
        for (const row of rows) {
            const count = Number(row.n);
            const day = String(row.day || '');
            if (!Number.isInteger(count) || count <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
            const r = await upsert({
                source_service: 'network', source_type: 'members', source_id: day, kind: 'member',
                title: day === today ? `${count} ${count === 1 ? 'person' : 'people'} joined today` : `${count} ${count === 1 ? 'person' : 'people'} joined on ${day}`,
                url: `${config.networkUrl || 'https://openvibe.network'}/stats`, site: 'network', site_name: 'Network',
                actor_subject: null, origin: 'system', label: 'System',
                text: Number(total && total.n) > 0 ? `${Number(total.n).toLocaleString('en-US')} people on OpenVibe so far` : '',
                occurred_at: day === today ? new Date(at).toISOString() : `${day}T12:00:00.000Z`,
            });
            if (r.created) created++;
        }
        return created;
    }

    // ── Quest badges ──────────────────────────────────────────
    async function questBadges() {
        const at = now();
        const people = await db.prepare(`SELECT DISTINCT i.actor_subject AS subject FROM feed_items i
            LEFT JOIN feed_quest_people q ON q.subject = i.actor_subject
            WHERE i.actor_subject IS NOT NULL AND i.origin = 'user' AND i.occurred_at >= ?
              AND (q.subject IS NULL OR q.checked_at < ?) ORDER BY i.actor_subject LIMIT 25`)
            .all(new Date(at - QUEST_RECENT_MS).toISOString(), new Date(at - QUEST_CHECK_MS).toISOString());
        let created = 0;
        for (const p of people) {
            const who = subject(p.subject);
            if (!who) continue;
            try {
                const res = await fetchImpl(`${urls.quest}/api/v1/profiles/${encodeURIComponent(who)}/badges`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
                if (res.ok) {
                    const body = await res.json();
                    const recent = (Array.isArray(body.badges) ? body.badges : [])
                        .filter((b) => b && typeof b.id === 'string' && b.id && typeof b.name === 'string' && b.name.trim())
                        .map((b) => ({ ...b, awarded: Date.parse(String(b.awarded_at || '')) }))
                        .filter((b) => Number.isFinite(b.awarded) && at - b.awarded <= QUEST_RECENT_MS)
                        .sort((a, b) => b.awarded - a.awarded).slice(0, 2);
                    for (const b of recent) {
                        const r = await upsert({ source_service: 'quest', source_type: 'badge', source_id: `${who}:${b.id}`, kind: 'quest',
                            title: `Finished a quest: ${clean(b.name, 90)}`, url: `${urls.quest}/`, site: 'quest', site_name: 'Quest',
                            actor_subject: who, origin: 'user', occurred_at: new Date(b.awarded).toISOString(), text: '' });
                        if (r.created) created++;
                    }
                }
            } catch (err) { log.warn && log.warn(`[Feed sources] Quest ${who}:`, err.message); }
            await db.prepare(`INSERT INTO feed_quest_people (subject, checked_at) VALUES (?, now()) ON CONFLICT (subject) DO UPDATE SET checked_at = now()`).run(who);
        }
        return created;
    }

    // ── Play achievements ─────────────────────────────────────
    async function playAchievements() {
        let cursor = null, created = 0;
        const seen = new Set();
        for (let page = 0; page < 20; page++) {
            const url = new URL('/api/v1/achievements/feed', urls.play);
            url.searchParams.set('limit', '100');
            if (cursor) url.searchParams.set('cursor', cursor);
            const out = await getJson(url.href);
            for (const a of (Array.isArray(out.items) ? out.items : [])) {
                const who = subject(a && a.player);
                const game = clean(a && a.title, 64);
                const id = clean(a && a.id, 80);
                const at = sqlFrom(a && a.unlocked_at);
                if (!who || !/^[a-z0-9-]{2,40}$/.test(game) || !/^[a-z0-9_-]{1,64}$/.test(id) || !at) continue;
                const sourceId = `${who}:${game}:${id}`;
                seen.add(sourceId);
                const r = await upsert({ source_service: 'games', source_type: 'achievement', source_id: sourceId, kind: 'game',
                    title: `Unlocked ${clean(a.name, 120)} in ${clean(a.title_name || game, 80)}`,
                    url: `https://openvibe.games/play?game=${encodeURIComponent(game)}`, site: 'games', site_name: 'Games',
                    actor_subject: who, origin: 'user', occurred_at: at, text: clean(a.description, 280) });
                if (r.created) created++;
            }
            cursor = typeof out.next === 'string' && out.next ? out.next : null;
            if (!cursor) break;
        }
        const old = await db.prepare("SELECT source_id FROM feed_items WHERE source_service = 'games' AND source_type = 'achievement'").all();
        for (const row of old) if (!seen.has(String(row.source_id))) await store.removeItem(db, 'games', 'achievement', row.source_id);
        return created;
    }

    // ── Meme entries ──────────────────────────────────────────
    async function memeEntries() {
        let cursor = null, created = 0;
        for (let page = 0; page < 4; page++) {
            const url = new URL('/api/v1/entries', urls.meme);
            url.searchParams.set('limit', '50');
            if (cursor) url.searchParams.set('cursor', cursor);
            const out = await getJson(url.href);
            for (const e of (Array.isArray(out.entries) ? out.entries : [])) {
                const slug = clean(e && e.slug, 100);
                const title = clean(e && e.title, 300);
                if (!slug || !/^[A-Za-z0-9-]+$/.test(slug) || !title || (e.visibility && e.visibility !== 'public')) continue;
                const r = await upsert({ source_service: 'meme', source_type: 'meme', source_id: slug, kind: 'meme', title,
                    url: `${urls.meme}/m/${encodeURIComponent(slug)}`, site: 'meme', site_name: 'Meme',
                    actor_subject: null, origin: 'system', label: 'System',
                    occurred_at: sqlFrom(e.published_at || e.created_at) || new Date(now()).toISOString(),
                    text: clean(e.summary || e.description, 280) });
                if (r.created) created++;
            }
            cursor = typeof out.next_cursor === 'string' && out.next_cursor ? out.next_cursor : null;
            if (!cursor) break;
        }
        return created;
    }

    // ── Pics ──────────────────────────────────────────────────
    async function publicPictures() {
        const seen = new Set();
        let cursor = null, created = 0;
        for (let page = 0; page < 20; page++) {
            const url = new URL('/api/v1/gallery', urls.pics);
            url.searchParams.set('sort', 'new');
            url.searchParams.set('limit', '30');
            if (cursor) url.searchParams.set('cursor', cursor);
            const out = await getJson(url.href);
            for (const p of (Array.isArray(out.pictures) ? out.pictures : [])) {
                const id = clean(p && p.id, 80);
                const links = p && p.links || {};
                if (!/^pic_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) || !p.listed || !https(links.page) || !https(links.thumb)) continue;
                seen.add(id);
                const r = await upsert({ source_service: 'pics', source_type: 'picture', source_id: id, kind: 'pic',
                    title: clean(p.title, 160) || 'Picture on OpenVibe.Pics', url: https(links.page), site: 'pics', site_name: 'Pics',
                    picture_url: https(links.thumb), actor_name: clean(p.author, 80), actor_subject: null, origin: 'user',
                    occurred_at: sqlFrom(p.published_at) || new Date(now()).toISOString(), text: clean(p.description, 280),
                    media_ratio: Number(p.width) > 0 && Number(p.height) > 0 ? Number(p.width) / Number(p.height) : null });
                if (r.created) created++;
            }
            cursor = typeof out.next === 'string' && out.next ? out.next : null;
            if (!cursor) break;
        }
        if (!cursor) await store.removeMissing(db, 'pics', 'picture', seen);
        return created;
    }

    // ── Rundown ───────────────────────────────────────────────
    async function rundownEpisodes() {
        let before = null, created = 0;
        const seen = new Set();
        for (let page = 0; page < 20; page++) {
            const url = new URL('/api/rundown/streams', urls.live);
            if (before) url.searchParams.set('before', before);
            const out = await getJson(url.href);
            for (const s of (Array.isArray(out.streams) ? out.streams : [])) {
                if (!s || s.live || !s.episode || s.episode.audience !== 'public' || !Number.isSafeInteger(Number(s.stream_id)) || Number(s.stream_id) < 1) continue;
                const id = String(s.stream_id);
                const title = clean(s.episode.title || s.title, 160);
                if (!title) continue;
                seen.add(id);
                const prior = await db.prepare("SELECT actor_subject FROM feed_items WHERE source_service = 'live' AND source_type = 'stream' AND source_id = ?").get(id);
                const who = (prior && prior.actor_subject) || await personOf(s.user && s.user.username);
                const r = await upsert({ source_service: 'live', source_type: 'episode', source_id: id, kind: 'rundown',
                    title: `Rundown: ${title}`, url: `${urls.live}/rundown/e/${id}`, site: 'live', site_name: 'Live',
                    actor_subject: who, origin: who ? 'user' : 'system', label: who ? null : 'System',
                    occurred_at: sqlFrom(s.episode.aired_at || s.started_at) || new Date(now()).toISOString(),
                    text: clean(s.episode.logline, 280), picture_url: https(s.thumbnail_url) });
                if (r.created) created++;
            }
            before = typeof out.next === 'string' && out.next ? out.next : null;
            if (!before) break;
        }
        if (!before) await store.removeMissing(db, 'live', 'episode', seen);
        return created;
    }

    // ── Live: on air, recordings and clips ────────────────────
    async function publicContent() {
        const seen = new Set();
        let cursor = null, created = 0;
        const live = await getJson(`${urls.live}/api/streams`);
        const onAir = new Map();
        const liveIds = new Set();
        for (const s of (Array.isArray(live.streams) ? live.streams : [])) {
            const id = Number(s && s.id), channel = clean(s && s.username, 64);
            const started = sqlFrom(s && s.started_at);
            if (!Number.isSafeInteger(id) || id < 1 || !/^[A-Za-z0-9_.-]{1,64}$/.test(channel) || !started) continue;
            if (!onAir.has(channel.toLowerCase())) onAir.set(channel.toLowerCase(), []);
            onAir.get(channel.toLowerCase()).push(Date.parse(started));
            liveIds.add(String(id));
            const name = clean(s.display_name || channel, 80);
            const who = await personOf(channel);
            const r = await store.upsertLiveItem(db, { source_service: 'live', source_type: 'stream', source_id: String(id), kind: 'live',
                title: `${name} went live: ${clean(s.title, 160) || 'a stream'}`, url: `${urls.live}/@${encodeURIComponent(channel)}`,
                site: 'live', site_name: 'Live', actor_name: name, actor_subject: who, origin: 'user',
                occurred_at: started, live_now: true });
            if (r.created) created++;
            await db.prepare("UPDATE feed_items SET live_now = true, updated_at = now() WHERE source_service = 'live' AND source_type = 'stream' AND source_id = ?").run(String(r.item.source_id));
        }
        // Anything no longer on Live's list is a past broadcast, not "live now".
        const onAirRows = await db.prepare("SELECT source_id FROM feed_items WHERE source_service = 'live' AND source_type = 'stream' AND live_now = true").all();
        for (const row of onAirRows) if (!liveIds.has(String(row.source_id))) await db.prepare("UPDATE feed_items SET live_now = false, updated_at = now() WHERE source_service = 'live' AND source_type = 'stream' AND source_id = ?").run(String(row.source_id));
        for (let page = 0; page < 20; page++) {
            const url = new URL('/api/content/feed', urls.live);
            url.searchParams.set('sort', 'new');
            url.searchParams.set('window', 'all');
            url.searchParams.set('limit', '30');
            if (cursor) url.searchParams.set('cursor', cursor);
            const out = await getJson(url.href);
            if (out.partial || (out.sources && (out.sources.vods !== 'ok' || out.sources.clips !== 'ok'))) throw new Error('Live Content feed was partial; retaining prior cards');
            for (const v of (Array.isArray(out.items) ? out.items : [])) {
                if (!v || !['vod', 'clip'].includes(v.kind) || !https(v.href)) continue;
                const id = clean(v.id, 80);
                if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue;
                const type = v.kind === 'vod' ? 'recording' : 'clip';
                const at = sqlFrom(v.created_at);
                if (!at) continue;
                const channel = clean(v.channel && v.channel.username, 64);
                const current = onAir.get(channel.toLowerCase()) || [];
                if (type === 'recording' && current.some((started) => Number.isFinite(started) && Math.abs(Date.parse(at) - started) <= 10 * MINUTE)) continue;
                seen.add(`${type}:${id}`);
                let prior = null;
                if (type === 'recording' && channel) {
                    const candidates = await db.prepare(`SELECT actor_subject, source_id FROM feed_items WHERE source_service = 'live' AND source_type = 'stream'
                        AND lower(url) = lower(?) AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at DESC LIMIT 20`)
                        .all(`${urls.live}/@${encodeURIComponent(channel)}`, new Date(Date.parse(at) - 60 * MINUTE).toISOString(), new Date(Date.parse(at) + 60 * MINUTE).toISOString());
                    prior = candidates.find((row) => !liveIds.has(String(row.source_id))) || null;
                }
                const r = await upsert({ source_service: 'live', source_type: type, source_id: id, kind: type === 'recording' ? 'video' : 'clip',
                    title: `${type === 'recording' ? 'Recording: ' : ''}${clean(v.title, 150) || (type === 'recording' ? 'A stream' : 'A clip')}`,
                    url: https(v.href), site: 'live', site_name: 'Live', picture_url: https(v.thumbnail_url),
                    actor_subject: (prior && prior.actor_subject) || await personOf(channel), actor_name: clean(v.channel && v.channel.display_name, 80),
                    origin: 'user', occurred_at: at, text: clean(v.excerpt, 280),
                    media_length: Number(v.duration_seconds) > 0 ? Number(v.duration_seconds) : null,
                    counts: Number(v.view_count) > 0 ? { views: Number(v.view_count) } : {} });
                if (r.created) created++;
                if (prior) await store.removeItem(db, 'live', 'stream', prior.source_id);
            }
            cursor = typeof out.next === 'string' && out.next ? out.next : null;
            if (!cursor) break;
        }
        if (!cursor) await store.removeMissing(db, 'live', 'recording', new Set([...seen].filter((x) => x.startsWith('recording:')).map((x) => x.split(':')[1])));
        if (!cursor) await store.removeMissing(db, 'live', 'clip', new Set([...seen].filter((x) => x.startsWith('clip:')).map((x) => x.split(':')[1])));
        return created;
    }

    /** "312 people watched Maticus tonight": Network's own creator analytics for the streams that ended. */
    async function watchedTogether() {
        let created = 0;
        const rows = await db.prepare(`SELECT stream_id, creator_subject, title, ended_at, peak_viewers FROM creator_streams
            WHERE ended_at IS NOT NULL AND peak_viewers > 0 AND ended_at >= ? ORDER BY ended_at DESC LIMIT 40`)
            .all(new Date(now() - 7 * DAY).toISOString());
        for (const s of rows) {
            const who = subject(s.creator_subject);
            const name = who ? await db.prepare('SELECT display_name, username FROM users WHERE subject_id = ?').get(who) : null;
            const label = clean(name && (name.display_name || name.username), 60) || 'a creator';
            const peak = Number(s.peak_viewers);
            if (!Number.isSafeInteger(peak) || peak <= 0) continue;
            const ended = sqlFrom(s.ended_at);
            if (!ended) continue;
            const r = await upsert({ source_service: 'live', source_type: 'watched', source_id: String(s.stream_id), kind: 'stream',
                title: `${peak.toLocaleString('en-US')} ${peak === 1 ? 'person' : 'people'} watched ${label} tonight`,
                text: clean(s.title, 220), url: `https://openvibe.live/@${encodeURIComponent((name && name.username) || label)}`,
                site: 'live', site_name: 'Live', actor_subject: who, origin: 'user', occurred_at: ended,
                counts: { watchers: peak } });
            if (r.created) created++;
        }
        return created;
    }

    // ── Spaces ────────────────────────────────────────────────
    async function publicSpaces() {
        const seen = new Set();
        let cursor = null, created = 0;
        for (let page = 0; page < 20; page++) {
            const url = new URL('/api/v1/apps/gallery', urls.space);
            url.searchParams.set('limit', '100');
            if (cursor) url.searchParams.set('cursor', cursor);
            const out = await getJson(url.href);
            for (const s of (Array.isArray(out.spaces) ? out.spaces : [])) {
                const id = clean(s && s.id, 80);
                const at = Number(s && s.published_at);
                if (!/^spc_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) || !Number.isFinite(at) || at <= 0 || !https(s.url)) continue;
                seen.add(id);
                const r = await upsert({ source_service: 'space', source_type: 'space', source_id: id, kind: 'space',
                    title: clean(s.name, 160) || 'New space', url: https(s.url), site: 'space', site_name: 'Space',
                    text: clean(s.description, 280), actor_name: clean(s.owner_name || s.owner_username, 80), actor_subject: null,
                    origin: 'user', occurred_at: new Date(at).toISOString() });
                if (r.created) created++;
            }
            cursor = typeof out.next_cursor === 'string' && out.next_cursor ? out.next_cursor : null;
            if (!cursor) break;
        }
        if (!cursor) await store.removeMissing(db, 'space', 'space', seen);
        return created;
    }

    // ── Work ──────────────────────────────────────────────────
    async function workJobs() {
        const out = await getJson(`${urls.work}/api/v1/jobs?limit=60`);
        let created = 0;
        for (const j of (Array.isArray(out.jobs) ? out.jobs : [])) {
            const id = clean(j && j.id, 100);
            const url = https(j && j.url);
            const title = clean(j && j.title, 180);
            if (!/^job_[A-Za-z0-9]{8,80}$/.test(id) || !url || !title) continue;
            const where = [clean(j.company, 80), clean(j.location, 60), j.remote ? 'Remote' : ''].filter(Boolean).join(' · ');
            const r = await upsert({ source_service: 'work', source_type: 'job', source_id: id, kind: 'work',
                title, text: clean([where, clean(j.excerpt, 200)].filter(Boolean).join(' — '), 280), url,
                site: 'work', site_name: 'Work', actor_subject: null, origin: 'system', label: 'System',
                occurred_at: sqlFrom(j.first_seen_at || j.posted_at) || new Date(now()).toISOString() });
            if (r.created) created++;
        }
        return created;
    }

    /** What an offer costs, as the source's own feed export states it: the price now, the price it
     *  was, the shop that sells it and its picture (feed.item@1 1.1.0: group.items[].price / was / store,
     *  and the card's own picture). A half-stated price is no price at all. */
    function dealFacts(o) {
        const feed = (o && o.feed) || {};
        const price = (feed.price && typeof feed.price === 'object') ? feed.price : {};
        const amount = Number(price.amount);
        const currency = String(price.currency || '').trim().toUpperCase();
        const stated = Number.isFinite(amount) && amount >= 0 && /^[A-Z]{3}$/.test(currency);
        const was = Number(feed.was);
        return {
            price_amount: stated ? amount : null,
            price_currency: stated ? currency : null,
            was_price: Number.isFinite(was) && was >= 0 ? was : null,
            store_name: clean(feed.store, 60) || null,
            picture_url: https(feed.media && feed.media.thumb),
        };
    }

    // ── Deals ─────────────────────────────────────────────────
    async function dealOffers() {
        const out = await getJson(`${urls.deals}/api/v1/offers?limit=40&sort=new`);
        let created = 0;
        for (const o of (Array.isArray(out.offers) ? out.offers : [])) {
            if (!o || o.status === 'expired' || o.expired_at) continue;
            const url = https(o.url);
            const title = clean(o.title, 180);
            if (!url || !title) continue;
            const votes = Number(o.votes);
            const facts = dealFacts(o);
            const r = await upsert({ source_service: 'deals', source_type: 'offer', source_id: clean(o.id, 100), kind: 'deal',
                title, text: clean(o.ai_summary || o.description, 280), url, site: 'deals', site_name: 'Deals',
                actor_subject: null, origin: 'system', label: 'System', media_ratio: null,
                ...facts,
                counts: Number.isSafeInteger(votes) && votes > 0 ? { likes: votes } : {},
                occurred_at: sqlFrom(o.created_at) || new Date(now()).toISOString() });
            if (r.created) created++;
        }
        return created;
    }

    // ── News ──────────────────────────────────────────────────
    async function newsStories() {
        const out = await getJson(`${urls.news}/api/v1/stories?limit=40`);
        let created = 0;
        for (const s of (Array.isArray(out.stories) ? out.stories : [])) {
            const id = clean(s && s.id, 100);
            const url = https(s && (s.url || s.canonical_url));
            const title = clean(s && s.title, 300);
            if (!id || !url || !title || (s.status && s.status !== 'published')) continue;
            const r = await upsert({ source_service: 'news', source_type: 'story', source_id: id, kind: 'news', title,
                text: clean(s.summary || s.excerpt, 280), url, site: 'news', site_name: 'News', actor_subject: null,
                origin: 'system', label: 'System', occurred_at: sqlFrom(s.published_at || s.created_at) || new Date(now()).toISOString() });
            if (r.created) created++;
        }
        return created;
    }

    // ── Blog ──────────────────────────────────────────────────
    /** The blog's public RSS: its written posts, decoded to plain text. */
    async function blogPosts() {
        const xml = await getText(`${urls.blog}/feed.xml`);
        const decode = (s) => String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ').trim();
        const blocks = String(xml).split(/<item[\s>]/i).slice(1);
        let created = 0;
        for (const raw of blocks) {
            const body = raw.split(/<\/item>/i)[0];
            const title = decode((/<title>([\s\S]*?)<\/title>/i.exec(body) || [])[1]);
            const link = decode((/<link>([\s\S]*?)<\/link>/i.exec(body) || [])[1]);
            const date = Date.parse(decode((/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(body) || [])[1]));
            const desc = decode((/<description>([\s\S]*?)<\/description>/i.exec(body) || [])[1]);
            const url = https(link);
            if (!title || !url) continue;
            const r = await upsert({ source_service: 'blog', source_type: 'post', source_id: url, kind: 'update',
                title: clean(title, 300), text: clean(desc, 280), url, site: 'blog', site_name: 'Blog',
                actor_subject: null, origin: 'system', label: 'System',
                occurred_at: Number.isFinite(date) ? new Date(date).toISOString() : new Date(now()).toISOString() });
            if (r.created) created++;
        }
        return created;
    }

    // ── Wiki ──────────────────────────────────────────────────
    /** Wiki's public search for a common word, filtered to pages published in the last 30 days. */
    async function wikiPages() {
        const out = await getJson(`${urls.wiki}/api/v1/search?q=the&limit=50`);
        let created = 0;
        const since = now() - 30 * DAY;
        for (const p of (Array.isArray(out.results) ? out.results : [])) {
            if (!p || p.state !== 'published' || p.visibility !== 'public' || p.noindex) continue;
            const at = sqlFrom(p.revision_published_at || p.published_at || p.updated_at);
            if (!at || Date.parse(at) < since) continue;
            const url = https(p.url);
            const title = clean(p.title, 300);
            if (!url || !title) continue;
            const r = await upsert({ source_service: 'wiki', source_type: 'page', source_id: clean(p.id, 100), kind: 'wiki',
                title, text: '', url, site: 'wiki', site_name: 'Wiki', actor_subject: null, origin: 'system', label: 'System',
                occurred_at: at, touch: true });
            if (r.created) created++;
        }
        return created;
    }

    // ── Report: the online peak and this window's numbers ─────
    async function samplePeak() {
        if (!presence || typeof presence.snapshot !== 'function') return 0;
        const snap = presence.snapshot(now());
        const online = snap.members.size + snap.guests;
        if (!Number.isFinite(online) || online <= 0) return 0;
        const day = new Date(now()).toISOString().slice(0, 10);
        // The day's distinct people beside the peak (seen.today: counts only); the larger count wins, so a restart that
        // empties the memory never lowers it.
        const t = typeof presence.today === 'function' ? presence.today(now()) : null;
        const dayMembers = t && t.day === day ? Number(t.members) || 0 : 0;
        const dayGuests = t && t.day === day ? Number(t.guests) || 0 : 0;
        await db.prepare(`INSERT INTO feed_peaks (day, peak, peak_at, members_day, guests_day) VALUES (?, ?, now(), ?, ?)
            ON CONFLICT (day) DO UPDATE SET peak = GREATEST(feed_peaks.peak, excluded.peak),
                peak_at = CASE WHEN excluded.peak > feed_peaks.peak THEN excluded.peak_at ELSE feed_peaks.peak_at END,
                members_day = GREATEST(feed_peaks.members_day, excluded.members_day),
                guests_day = GREATEST(feed_peaks.guests_day, excluded.guests_day),
                updated_at = now()`).run(day, online, dayMembers, dayGuests);
        return 1;
    }

    async function reportCard() {
        const at = now();
        let stats = null;
        try { stats = await getJson(`${urls.report}/api/v1/stats`); } catch (err) { log.warn && log.warn('[Feed sources] Report stats:', err.message); }
        const day = new Date(at).toISOString().slice(0, 10);
        const peak = await db.prepare('SELECT peak, peak_at, members_day, guests_day FROM feed_peaks WHERE day = ?').get(day);
        let created = 0;
        if (peak && Number(peak.peak) > 0) {
            // The time is not in the words: each reader's own clock says it (feed.item@1 1.2.0 stat.at, openvibe-shared
            // 4.248.0). The side numbers are today's: people (signed in and guests), signed in, page views, new
            // accounts, streaming now. Each is there only when its source answered.
            const todayOf = (daily) => { const d = (Array.isArray(daily) ? daily : []).find((x) => x && x.day === day); return d && Number.isSafeInteger(Number(d.n)) ? Number(d.n) : null; };
            const people = Number(peak.members_day || 0) + Number(peak.guests_day || 0);
            const facts = [
                people > 0 ? { label: 'people today', n: people } : null,
                Number(peak.members_day) > 0 ? { label: 'signed in today', n: Number(peak.members_day) } : null,
                stats ? (todayOf(stats.pageviews_daily) != null ? { label: 'page views today', n: todayOf(stats.pageviews_daily) } : null) : null,
                stats && stats.accounts ? (todayOf(stats.accounts.daily) != null ? { label: 'new accounts today', n: todayOf(stats.accounts.daily) } : null) : null,
                stats && stats.live && Number.isSafeInteger(Number(stats.live.live_now)) ? { label: 'live now', n: Number(stats.live.live_now) } : null,
            ].filter(Boolean);
            const key = `peak:${day}`;
            const r = await upsert({ source_service: 'report', source_type: 'peak', source_id: key, kind: 'report',
                title: `Peak today: ${Number(peak.peak).toLocaleString('en-US')} ${Number(peak.peak) === 1 ? 'person' : 'people'} online at once`,
                text: 'The most people on OpenVibe at once today', url: `${urls.report}/network`, site: 'report', site_name: 'Report',
                actor_subject: null, origin: 'system', label: 'System', counts: { people: Number(peak.peak) },
                occurred_at: new Date(at).toISOString(), touch: true });
            await db.prepare("UPDATE feed_items SET stat = ? WHERE source_service = 'report' AND source_type = 'peak' AND source_id = ?")
                .run(JSON.stringify({ at: new Date(peak.peak_at).toISOString(), facts }), key);
            if (r.created) created++;
        }
        const totals = stats && stats.totals;
        if (totals && Number.isSafeInteger(Number(totals.pageviews))) {
            const pct = Number(totals.change_pct);
            const views = Number(totals.pageviews);
            const r = await upsert({ source_service: 'report', source_type: 'views', source_id: `views:${day}`, kind: 'report',
                title: `${views.toLocaleString('en-US')} page views in the last 30 days`,
                text: [`${Number(totals.sites_open) || 0} sites open`, `${Number(totals.accounts) || 0} accounts`, Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct}% on the 30 days before` : ''].filter(Boolean).join(' · '),
                url: `${urls.report}/`, site: 'report', site_name: 'Report', actor_subject: null, origin: 'system', label: 'System',
                counts: { people: views }, trend: Number.isFinite(pct) ? { direction: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat', pct: Math.abs(pct) } : undefined,
                occurred_at: new Date(at).toISOString(), touch: true });
            if (r.created) created++;
        }
        return created;
    }

    const SOURCES = [
        { name: 'community-activity', every: 2 * MINUTE, run: communityActivity },
        { name: 'today-events', every: 10 * MINUTE, run: todayEvents },
        { name: 'network-members', every: 60 * MINUTE, run: networkMembers },
        { name: 'quest-badges', every: 15 * MINUTE, run: questBadges },
        { name: 'play-achievements', every: 10 * MINUTE, run: playAchievements },
        { name: 'meme-entries', every: 10 * MINUTE, run: memeEntries },
        { name: 'public-pictures', every: 5 * MINUTE, run: publicPictures },
        { name: 'rundown-episodes', every: 10 * MINUTE, run: rundownEpisodes },
        { name: 'public-content', every: 3 * MINUTE, run: publicContent },
        { name: 'watched-together', every: 10 * MINUTE, run: watchedTogether },
        { name: 'public-spaces', every: 10 * MINUTE, run: publicSpaces },
        { name: 'work-jobs', every: 10 * MINUTE, run: workJobs },
        { name: 'deal-offers', every: 10 * MINUTE, run: dealOffers },
        { name: 'news-stories', every: 10 * MINUTE, run: newsStories },
        { name: 'blog-posts', every: 10 * MINUTE, run: blogPosts },
        { name: 'wiki-pages', every: 10 * MINUTE, run: wikiPages },
        { name: 'online-peak', every: 2 * MINUTE, run: samplePeak },
        { name: 'report-card', every: 30 * MINUTE, run: reportCard },
    ];

    async function remember(name, { nextRun, lastRun, error = null }) {
        await db.prepare(`INSERT INTO feed_source_runs (name, next_run_at, last_run_at, last_error) VALUES (?, ?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at, last_error = excluded.last_error`)
            .run(name, nextRun, lastRun, error);
    }

    /** Run every source due now (all with { force: true }). → [{ name, items } | { name, error }] */
    async function runOnce({ force = false } = {}) {
        if (running) return running;
        running = (async () => {
            const at = now();
            const states = new Map((await db.prepare('SELECT * FROM feed_source_runs').all()).map((s) => [s.name, s]));
            const out = [];
            for (const source of SOURCES) {
                const state = states.get(source.name);
                if (!force && state && state.next_run_at && Date.parse(state.next_run_at) > at) continue;
                try {
                    const items = await source.run();
                    await remember(source.name, { nextRun: new Date(at + source.every).toISOString(), lastRun: new Date(at).toISOString() });
                    out.push({ name: source.name, items });
                } catch (err) {
                    log.warn && log.warn(`[Feed sources] ${source.name}:`, err.message);
                    await remember(source.name, { nextRun: new Date(at + source.every).toISOString(), lastRun: new Date(at).toISOString(), error: String(err.message).slice(0, 300) });
                    out.push({ name: source.name, error: err.message });
                }
            }
            return out;
        })().finally(() => { running = null; });
        return await running;
    }

    function start() {
        if (timer) return;
        const tick = () => { runOnce().catch((err) => log.warn && log.warn('[Feed sources]:', err.message)); };
        timer = setInterval(tick, MINUTE);
        if (timer.unref) timer.unref();
        const first = setTimeout(tick, 5000);
        if (first.unref) first.unref();
        timer.first = first;
    }
    function stop() {
        if (timer) clearInterval(timer);
        if (timer && timer.first) clearTimeout(timer.first);
        timer = null;
    }
    async function status() {
        return { sources: SOURCES.map((s) => s.name), runs: await db.prepare('SELECT * FROM feed_source_runs ORDER BY name').all() };
    }

    return { runOnce, start, stop, status, SOURCES: SOURCES.map((s) => s.name), communityActivity, todayEvents, networkMembers, questBadges, playAchievements, memeEntries, publicPictures, rundownEpisodes, publicContent, watchedTogether, publicSpaces, workJobs, dealOffers, newsStories, blogPosts, wikiPages, samplePeak, reportCard };
}

module.exports = { createFeedSources };
