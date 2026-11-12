'use strict';
const pageLinks = require('../frame/page-links');
// ═══════════════════════════════════════════════════════════════
// Public profiles (plan T21 step 3): one page per person on the Network, and the same data as JSON for every site.
//
//   GET /@:username                    HTML: picture, name, bio, member since, what they wear, the items they own
//   GET /api/v1/profiles/:username     JSON, public and CORS-open (server/public-cors.js): profile@1 below
//
// Items come from OpenVibe.Inventory's public reads (GET /api/v1/kinds, /people/:subject/items and /equipped) with the
// Network's own service token (svc:network, audience openvibe.inventory), kept 60 s per person, so a busy profile costs
// Inventory one read a minute. Inventory down: the profile still answers, with its items marked unavailable.
// Badges come the same way from OpenVibe.Quest (GET /api/v1/profiles/:subject/badges, audience openvibe.quest), and
// achievements from OpenVibe.Play's public read (GET /api/v1/people/:subject/achievements): every game's unlocks, so a
// profile is the person's Steam-style page wherever they play.
//
// Who has one: a real account (not anonymous, banned, merged into another or deleted); anyone else is a 404. An old
// username answers 301 to the current one. A person can hide theirs (users.profile_public = 0, the account hub's Edit
// Profile card): the page then shows only their name and picture, is not indexed, and the JSON says private: true.
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const usernames = require('../identity/usernames');
const glyphs = require('openvibe-shared/glyphs');
const { siteForHost, fullName } = require('../frame/sites');

const esc = seo.esc;
const SITE = 'https://openvibe.network';
const SPACE_SITE = 'https://openvibe.space';
const COMMUNITY_SITE = 'https://openvibe.community';
const INVENTORY_SITE = 'https://openvibe.my/inventory';
const QUEST_SITE = 'https://openvibe.quest';
const GAMES_ACHIEVEMENTS = 'https://openvibe.games/achievements#game-';
const RECENT_ACHIEVEMENTS = 6;   // per game on the page; the rest is on the game's row on OpenVibe.Games
const AUDIENCE = 'openvibe.inventory';
const ITEMS_TTL_MS = 60_000;
const KINDS_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 4000;
const PUBLIC_PLACE_TIMEOUT_MS = 2000;
const PUBLIC_PLACE_TTL_MS = 5 * 60_000;
const MAX_ITEMS = 400;   // two pages of Inventory's 200; the rest is one link away on OpenVibe.Inventory
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const NAME_FX_RE = /^name-fx-[a-z]{2,24}$/;   // live.name_effect.css@1 tokens (openvibe-shared items.css)
const RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const profileUrl = (username) => `${SITE}/@${encodeURIComponent(username)}`;
const avatarUrl = (username, size = 160) => `${SITE}/avatar/${encodeURIComponent(username)}?s=${size}`;
const itemUrl = (definitionId) => `${INVENTORY_SITE}/${encodeURIComponent(definitionId)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const rarityRank = (r) => Math.max(0, RARITY.indexOf(r));

/** 'YYYY-MM-DD …' → 'October 2026' (null when the date is unusable). */
function monthOf(ts) {
    const m = /^(\d{4})-(\d{2})/.exec(String(ts || ''));
    return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

function createPublicProfiles({ db, selfToken = () => null, inventoryUrl = 'http://127.0.0.1:5030', questUrl = 'http://127.0.0.1:4980', playUrl = 'http://127.0.0.1:5040', liveUrl = 'http://127.0.0.1:3000', communityUrl = 'http://127.0.0.1:4200', spaceUrl = 'http://127.0.0.1:4940', fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = console } = {}) {
    const base = String(inventoryUrl).replace(/\/+$/, '');
    const itemsCache = new Map();   // subject → { at, value }
    const badgesCache = new Map();  // subject → { at, value }
    const achievementsCache = new Map();  // subject → { at, value }
    const placesCache = new Map();         // username → { at, value }
    const liveBase = String(liveUrl).replace(/\/+$/, '');
    const communityBase = String(communityUrl).replace(/\/+$/, '');
    const spaceBase = String(spaceUrl).replace(/\/+$/, '');
    let kindsHit = null;
    let lastWarn = '';

    async function inventoryGet(path) {
        const token = selfToken(AUDIENCE, ['inventory.item.read']);
        const r = await fetchImpl(`${base}/api/v1${path}`, {
            headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!r.ok) throw new Error(`answered ${r.status}`);
        return await r.json();
    }

    async function kinds() {
        if (kindsHit && now() - kindsHit.at < KINDS_TTL_MS) return kindsHit.value;
        const out = await inventoryGet('/kinds');
        const value = new Map((out.kinds || []).map((k) => [k.id, k]));
        kindsHit = { at: now(), value };
        return value;
    }

    /** A person's Quest badges, newest first: [{ id, name, awarded_at }], or { unavailable: true } while Quest cannot answer. */
    async function badgesOf(subject) {
        if (!SUBJECT_RE.test(String(subject || ''))) return { badges: [] };
        const hit = badgesCache.get(subject);
        if (hit && now() - hit.at < ITEMS_TTL_MS) return hit.value;
        let value;
        try {
            const token = selfToken('openvibe.quest', ['quest.badge.read']);
            const r = await fetchImpl(`${String(questUrl).replace(/\/+$/, '')}/api/v1/profiles/${subject}/badges`, {
                headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!r.ok) throw new Error(`answered ${r.status}`);
            const body = await r.json();
            const badges = (Array.isArray(body.badges) ? body.badges : [])
                .filter((b) => b && typeof b.id === 'string' && typeof b.name === 'string')
                .map((b) => ({
                    id: b.id.slice(0, 64), name: b.name.slice(0, 60), awarded_at: typeof b.awarded_at === 'string' ? b.awarded_at : null,
                    // The site whose quest awards it (Quest #173): the badge shows that site's icon.
                    site: typeof b.site === 'string' && /^[a-z0-9][a-z0-9.-]{2,60}$/.test(b.site) ? b.site : null,
                    // Its picture (Quest #174): a glyph for what it was earned for, drawn only if Shared knows the name.
                    icon: typeof b.icon === 'string' && glyphs.NAMES.includes(b.icon) ? b.icon : null,
                }))
                .sort((a, b) => String(b.awarded_at || '').localeCompare(String(a.awarded_at || '')));
            value = { badges };
        } catch (err) {
            const m = `OpenVibe.Quest: ${err.message}`;
            if (m !== lastWarn) { lastWarn = m; log.warn(`[Profiles] ${m}`); }
            return { badges: [], unavailable: true };
        }
        badgesCache.set(subject, { at: now(), value });
        if (badgesCache.size > 2000) badgesCache.delete(badgesCache.keys().next().value);
        return value;
    }

    /** A person's achievements in every game (Play), newest game first: { total, games: [{ title, name, count, recent }] }. */
    async function achievementsOf(subject) {
        if (!SUBJECT_RE.test(String(subject || ''))) return { total: 0, games: [] };
        const hit = achievementsCache.get(subject);
        if (hit && now() - hit.at < ITEMS_TTL_MS) return hit.value;
        let value;
        try {
            const r = await fetchImpl(`${String(playUrl).replace(/\/+$/, '')}/api/v1/people/${subject}/achievements`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (r.status === 404) value = { total: 0, games: [] };
            else {
                if (!r.ok) throw new Error(`answered ${r.status}`);
                const body = await r.json();
                const games = (Array.isArray(body.titles) ? body.titles : []).filter((t) => t && typeof t.title === 'string' && Array.isArray(t.achievements)).map((t) => ({
                    title: t.title.slice(0, 64), name: String(t.name || t.title).slice(0, 80), count: t.achievements.length,
                    url: `${GAMES_ACHIEVEMENTS}${encodeURIComponent(t.title.slice(0, 64))}`,
                    recent: t.achievements.slice(0, RECENT_ACHIEVEMENTS).filter((a) => a && typeof a.name === 'string').map((a) => ({ name: a.name.slice(0, 80), description: String(a.description || '').slice(0, 200), unlocked_at: typeof a.unlocked_at === 'string' ? a.unlocked_at : null })),
                }));
                value = { total: games.reduce((n, g) => n + g.count, 0), games };
            }
        } catch (err) {
            const m = `OpenVibe.Play: ${err.message}`;
            if (m !== lastWarn) { lastWarn = m; log.warn(`[Profiles] ${m}`); }
            return { total: 0, games: [], unavailable: true };
        }
        achievementsCache.set(subject, { at: now(), value });
        if (achievementsCache.size > 2000) achievementsCache.delete(achievementsCache.keys().next().value);
        return value;
    }

    /** What a public profile shows from other services: items (Inventory), badges (Quest), achievements (Play), together. */
    async function wearsOf(subject) {
        const [inv, quest, play] = await Promise.all([itemsOf(subject), badgesOf(subject), achievementsOf(subject)]);
        return { ...inv, badges: quest.badges, badgesUnavailable: !!quest.unavailable, achievements: play };
    }

    /** A person's items and what they wear, or { unavailable: true } while Inventory cannot answer. */
    async function itemsOf(subject) {
        if (!SUBJECT_RE.test(String(subject || ''))) return { items: [], showcase: [], total: 0, more: false };
        const hit = itemsCache.get(subject);
        if (hit && now() - hit.at < ITEMS_TTL_MS) return hit.value;
        let value;
        try {
            const [kindMap, worn] = await Promise.all([kinds(), inventoryGet(`/people/${subject}/equipped`)]);
            const instances = [];
            const definitions = {};
            let cursor = null;
            let more = false;
            do {
                const page = await inventoryGet(`/people/${subject}/items?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
                instances.push(...(page.instances || []));
                Object.assign(definitions, page.definitions || {});
                cursor = page.next_cursor || null;
                more = !!cursor && instances.length >= MAX_ITEMS;
            } while (cursor && instances.length < MAX_ITEMS);
            const kindOf = (id) => kindMap.get(id) || { id, name: id };
            const items = instances.filter((i) => definitions[i.definition_id]).map((i) => {
                const d = definitions[i.definition_id];
                return { instance_id: i.id, definition_id: d.id, name: d.name, rarity: RARITY_LABEL[d.rarity] ? d.rarity : 'common', kind: d.kind, kind_name: kindOf(d.kind).name, art: d.art || {}, acquired_at: i.acquired_at || null, url: itemUrl(d.id) };
            });
            const byInstance = new Map(items.map((i) => [i.instance_id, i]));
            const showcase = [];
            for (const [key, slot] of Object.entries((worn && worn.slots) || {})) {
                const item = byInstance.get(slot.instance_id);
                if (item) showcase.push({ slot: key.split(':')[1] || key, ...item });
            }
            const order = [...kindMap.keys()];
            showcase.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
            value = { items, showcase, total: items.length, more };
            lastWarn = '';
        } catch (err) {
            const m = `OpenVibe.Inventory: ${err.message}`;
            if (m !== lastWarn) { lastWarn = m; log.warn(`[Profiles] ${m}`); }
            return { items: [], showcase: [], total: 0, more: false, unavailable: true };
        }
        itemsCache.set(subject, { at: now(), value });
        if (itemsCache.size > 2000) itemsCache.delete(itemsCache.keys().next().value);
        return value;
    }

    async function publicJson(url) {
        const r = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PUBLIC_PLACE_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`answered ${r.status}`);
        return await r.json();
    }

    function plainHtml(s) {
        return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    }

    async function livePlace(username) {
        const pathName = encodeURIComponent(username);
        const [state, channel] = await Promise.all([
            publicJson(`${liveBase}/api/streams/channel/${pathName}/live`),
            publicJson(`${liveBase}/api/streams/channel/${pathName}?vodLimit=3&vodOrderBy=newest&clipLimit=1`),
        ]);
        const ch = state.channel || channel.channel;
        if (!ch || typeof ch.username !== 'string') return null;
        const streams = Array.isArray(state.streams) ? state.streams : [];
        return {
            live: { title: ch.display_name || ch.username, username: ch.username, is_live: streams.length > 0, url: `https://openvibe.live/@${encodeURIComponent(ch.username)}` },
            videos: (Array.isArray(channel.vods) ? channel.vods : []).filter((v) => v && v.visibility === 'public' && (v.id || v.vod_id) && (v.title || v.name)).slice(0, 3).map((v) => ({
                // Video's watch page by its public id (Track U); /v/<number> 301s there for a recording without one yet.
                title: String(v.title || v.name).slice(0, 100), url: /^[A-Za-z0-9_-]{11}$/.test(String(v.watch_id || ''))
                    ? `https://openvibe.video/watch?v=${v.watch_id}` : `https://openvibe.video/v/${encodeURIComponent(v.id || v.vod_id)}`,
                // The date tells apart recordings that share a title ("JapaneseOldGuy's Stream" three times).
                date: Number.isFinite(Date.parse(v.created_at)) ? new Date(v.created_at).toISOString().slice(0, 10) : null,
                // Its picture (the network's own media host only) and its length, so a card shows the video, not its name alone.
                thumb: /^https:\/\/openvibe\.media\/[^\s"'<>]+$/.test(String(v.thumbnail_url || '')) ? String(v.thumbnail_url) : null,
                seconds: Number.isFinite(Number(v.duration_seconds)) && Number(v.duration_seconds) > 0 ? Math.round(Number(v.duration_seconds)) : null,
            })),
        };
    }

    async function communityPlaces(username) {
        const body = await publicJson(`${communityBase}/api/pastes/by-user/${encodeURIComponent(username)}?limit=10`);
        return (Array.isArray(body.pastes) ? body.pastes : []).filter((p) => p && p.visibility === 'public' && typeof p.slug === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(p.slug) && typeof p.title === 'string' && p.title
            // A screenshot an avatar upload left behind keeps its default title: not something the person shared.
            && !(p.type === 'screenshot' && p.title === 'Avatar upload')).slice(0, 3).map((p) => ({
            title: String(p.title).slice(0, 100), url: `${COMMUNITY_SITE}/p/${encodeURIComponent(p.slug)}`,
            // What it is, in a word: a picture, or the language it is written in.
            kind: p.type === 'screenshot' || p.language === 'image' ? 'Picture' : (typeof p.language === 'string' && /^[A-Za-z0-9+#. -]{1,24}$/.test(p.language) && p.language !== 'text' ? p.language : 'Paste'),
        }));
    }

    async function spacePlaces(username) {
        const url = `${spaceBase}/spaces?q=${encodeURIComponent(username)}`;
        const r = await fetchImpl(url, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(PUBLIC_PLACE_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`answered ${r.status}`);
        const html = await r.text();
        const out = [];
        for (const [, card] of html.matchAll(/<article class="sp-card">([\s\S]*?)<\/article>/g)) {
            const owner = /<footer><span>by @([^<]+)<\/span>/.exec(card);
            if (!owner || owner[1].toLowerCase() !== username.toLowerCase()) continue;
            const href = /<a class="sp-card-main" href="\/spaces\/([a-z0-9][a-z0-9_-]{0,79})">/.exec(card);
            const badge = /<span class="sp-card-badge[^\"]*">([^<]+)<\/span>/.exec(card);
            const title = /<h3>([\s\S]*?)<\/h3>/.exec(card);
            if (!href || !title || !badge || plainHtml(badge[1]) !== 'Published') continue;
            out.push({ title: plainHtml(title[1]).slice(0, 100), url: `${SPACE_SITE}/spaces/${encodeURIComponent(href[1])}` });
        }
        return out.slice(0, 8);
    }

    async function placesOf(username, choices = {}) {
        const hit = placesCache.get(username);
        let all = hit && now() - hit.at < PUBLIC_PLACE_TTL_MS ? hit.value : null;
        if (!all) {
            const [live, community, spaces] = await Promise.all([
                livePlace(username).catch(() => null), communityPlaces(username).catch(() => []), spacePlaces(username).catch(() => []),
            ]);
            all = { live: live?.live || null, videos: live?.videos || [], spaces: spaces || [], community: community || [] };
            placesCache.set(username, { at: now(), value: all });
        }
        const value = {
            ...(choices.live === false ? {} : (all.live ? { live: all.live } : {})),
            ...(choices.media === false ? {} : { videos: all.videos }),
            spaces: choices.space === false ? [] : all.spaces,
            community: choices.community === false ? [] : all.community,
        };
        if (placesCache.size > 2000) placesCache.delete(placesCache.keys().next().value);
        return value;
    }

    /** → { moved: current } | { user } | null */
    async function find(name) {
        const rec = await usernames.lookup(db, name);
        if (!rec) return null;
        if (rec.renamed) return { moved: rec.current };
        const u = await db.prepare(`SELECT id, username, display_name, bio, public_page_bio, public_page_links, public_page_places, profile_color, created_at, subject_id, profile_public,
            is_anon, merged_into, deleted_at FROM users WHERE id = ?`).get(rec.network_id);
        if (!u || Number(u.is_anon) || u.merged_into || u.deleted_at) return null;
        return { user: u };
    }

    async function pageOf(u) {
        let links = [], choices = { live: true, media: true, space: true, community: true };
        try { links = typeof u.public_page_links === 'string' ? JSON.parse(u.public_page_links) : (u.public_page_links || []); } catch {}
        try { choices = { ...choices, ...(typeof u.public_page_places === 'string' ? JSON.parse(u.public_page_places) : (u.public_page_places || {})) }; } catch {}
        const places = Number(u.profile_public) ? await placesOf(u.username, choices) : { spaces: [], community: [], videos: [] };
        return { username: u.username, display_name: u.display_name || u.username, avatar_url: avatarUrl(u.username), profile_url: `${SITE}/@${encodeURIComponent(u.username)}`, bio: Number(u.profile_public) ? String(u.public_page_bio || '').slice(0, 280) : '', links: Number(u.profile_public) && Array.isArray(links) ? links.slice(0, 8) : [], places };
    }

    /** profile@1: what every site may show about a person. */
    async function profileOf(u) {
        const out = {
            username: u.username,
            display_name: u.display_name || u.username,
            avatar_url: avatarUrl(u.username),
            profile_url: profileUrl(u.username),
            private: !Number(u.profile_public),
            level: await require('../levels/store').total(db, u.id),
        };
        if (out.private) return out;
        const inv = await wearsOf(u.subject_id);
        const counts = new Map();
        for (const i of inv.items) counts.set(i.kind, { kind: i.kind, name: i.kind_name, count: ((counts.get(i.kind) || {}).count || 0) + 1 });
        return Object.assign(out, {
            bio: String(u.bio || '').slice(0, 500),
            color: COLOR_RE.test(String(u.profile_color || '')) ? u.profile_color : null,
            member_since: String(u.created_at || '').slice(0, 10) || null,
            showcase: inv.showcase.map((i) => ({ slot: i.slot, kind: i.kind, kind_name: i.kind_name, definition_id: i.definition_id, name: i.name, rarity: i.rarity, art: i.art, url: i.url })),
            items: { count: inv.total, more: inv.more, by_kind: [...counts.values()], unavailable: !!inv.unavailable },
            inventory_url: SUBJECT_RE.test(String(u.subject_id || '')) ? `${INVENTORY_SITE}/u/${u.subject_id}` : null,
            badges: inv.badges,
            ...(inv.badgesUnavailable ? { badges_unavailable: true } : {}),
            achievements: { total: inv.achievements.total, games: inv.achievements.games, ...(inv.achievements.unavailable ? { unavailable: true } : {}) },
        });
    }

    /** GET /@:username (server/index.js mounts it with its own rate limit). */
    async function pageHandler(req, res, next) {
        try {
            if (String(req.hostname || '').toLowerCase() === 'openvibe.my') {
                return res.redirect(301, `${SITE}/@${encodeURIComponent(String(req.params.username || ''))}`);
            }
            const found = await find(req.params.username);
            if (!found) return next();   // the shared 404 page
            if (found.moved) return res.redirect(301, `/@${encodeURIComponent(found.moved)}`);
            const u = found.user;
            if (String(req.params.username) !== String(u.username)) return res.redirect(301, `/@${encodeURIComponent(u.username)}`);
            const [inv, page] = await Promise.all([Number(u.profile_public) ? wearsOf(u.subject_id) : null, pageOf(u)]);
            res.set('Content-Type', 'text/html; charset=utf-8');
            res.set('Cache-Control', cache.htmlHeaders({ maxAge: 60 }));
            // A person's public profile lives on openvibe.network (the owner, 11-08: "OpenVibe.My is for users' stuff,
            // the profiles should be on .Network"). openvibe.my is the person's own hub: /@name there moves here.
            res.send(renderPage(u, inv, SITE, page.places, await require('../levels/store').total(db, u.id)));
        } catch (err) { next(err); }
    }

    const api = express.Router();
    api.get('/:username', async (req, res, next) => {
        try {
            const found = await find(req.params.username);
            res.set('Cache-Control', 'public, max-age=60');
            if (!found) return res.status(404).json({ error: 'not_found' });
            if (found.moved) return res.status(301).set('Location', `/api/v1/profiles/${encodeURIComponent(found.moved)}`).json({ moved_to: found.moved });
            res.json({ profile: await profileOf(found.user) });
        } catch (err) { next(err); }
    });

    // Stable public-page JSON read. It intentionally contains only fields already visible while signed out.
    const pageApi = async (req, res, next) => {
        try {
            const found = await find(req.params.handle);
            res.set('Cache-Control', 'public, max-age=60');
            if (!found) return res.status(404).json({ error: 'not_found' });
            if (found.moved) return res.status(301).set('Location', `/api/v1/people/@${encodeURIComponent(found.moved)}/page`).json({ moved_to: found.moved });
            if (req.params.handle !== found.user.username) return res.status(301).set('Location', `/api/v1/people/@${encodeURIComponent(found.user.username)}/page`).json({ moved_to: found.user.username });
            res.json({ person: await pageOf(found.user) });
        } catch (err) { next(err); }
    };

    return { pageHandler, pageApi, api, find, pageOf, profileOf, itemsOf, badgesOf, achievementsOf };
}

// ── The page ───────────────────────────────────────────────────

/** The item's picture: a Media image, or its emoji, on a square tinted by rarity. */
function art(i, size = 'md') {
    const a = i.art || {};
    if (a.media_id && /^[A-Za-z0-9_-]{1,80}$/.test(String(a.media_id))) {
        return `<span class="pf-art pf-art-${size} r-${i.rarity}"><img src="https://openvibe.media/o/${esc(a.media_id)}" alt="" loading="lazy" width="64" height="64"></span>`;
    }
    return `<span class="pf-art pf-art-${size} r-${i.rarity}" aria-hidden="true">${esc(String(a.emoji || '◆').slice(0, 8))}</span>`;
}
const rarityBadge = (r) => `<span class="pf-rarity r-${esc(r)}">${esc(RARITY_LABEL[r] || r)}</span>`;

/** "Nov 7, 2026" from an ISO day, in the page's own words (no locale surprises on the server). */
function monthDay(day) {
    const [y, m, d] = String(day).split('-').map(Number);
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[m - 1] ? `${names[m - 1]} ${d}, ${y}` : '';
}

// The mark of each kind of place (24 px line icons, the stroke in the text's colour).
const PLACE_ICON = {
    live: '<path d="M12 12v.01M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
    video: '<rect x="3" y="5.5" width="13" height="13" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>',
    site: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/>',
    paste: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
    picture: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L20 17"/>',
};
const placeIcon = (kind) => `<span class="pf-place-i pf-place-i--${kind}" aria-hidden="true"><svg viewBox="0 0 24 24">${PLACE_ICON[kind]}</svg></span>`;
const clock = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
/** One place as a card: what it is (its picture, or the mark of its kind), its name, and a line that says the kind. */
const placeCard = ({ url, media, title, line, cls = '' }) => `<li class="pf-place${cls ? ` ${cls}` : ''}"><a href="${esc(url)}">${media}<span class="pf-place-t"><strong>${title}</strong><span>${line}</span></span></a></li>`;

function publicPlacesHtml(places) {
    const cards = [];
    if (places.live) cards.push(placeCard({ url: places.live.url, media: placeIcon('live'), cls: places.live.is_live ? 'is-live' : '',
        title: `@${esc(places.live.username || places.live.title)}`, line: places.live.is_live ? '<span class="pf-live">Live now</span>' : 'Live channel' }));
    for (const video of places.videos || []) cards.push(placeCard({ url: video.url, cls: 'pf-place--video',
        media: video.thumb ? `<span class="pf-place-pic"><img src="${esc(video.thumb)}?w=320&amp;fmt=webp" alt="" loading="lazy" decoding="async" width="96" height="54">${video.seconds ? `<b>${esc(clock(video.seconds))}</b>` : ''}</span>` : placeIcon('video'),
        title: esc(video.title), line: `Video${video.date ? ` · ${esc(monthDay(video.date))}` : ''}${!video.thumb && video.seconds ? ` · ${esc(clock(video.seconds))}` : ''}` }));
    for (const space of places.spaces || []) cards.push(placeCard({ url: space.url, media: placeIcon('site'), title: esc(space.title), line: 'Published site' }));
    for (const paste of places.community || []) cards.push(placeCard({ url: paste.url, media: placeIcon(paste.kind === 'Picture' ? 'picture' : 'paste'), title: esc(paste.title),
        line: paste.kind && paste.kind !== 'Paste' ? `${esc(paste.kind)} · Community paste` : 'Community paste' }));
    if (!cards.length) return '';
    return `<section class="pf-section" aria-labelledby="pf-places"><h2 id="pf-places">On OpenVibe</h2><ul class="pf-places">${cards.join('')}</ul></section>`;
}

function showcaseHtml(inv, name) {
    if (!inv.showcase.length) return '';
    return `<section class="pf-section" aria-labelledby="pf-wearing"><h2 id="pf-wearing">Wearing</h2>
<ul class="pf-showcase">${inv.showcase.map((i) => `<li class="pf-worn r-${esc(i.rarity)}"><a href="${esc(i.url)}">${art(i, 'lg')}<span class="pf-worn-body"><span class="pf-kind">${esc(i.kind_name)}</span><span class="pf-name">${esc(i.name)}</span>${rarityBadge(i.rarity)}</span></a></li>`).join('')}</ul>
<p class="pf-note">What ${esc(name)} shows in chat, on stream overlays and here.</p></section>`;
}

/** Quest badges: one chip each, newest first, linking to the quests that award them. */
function badgesHtml(inv) {
    if (!inv.badges || !inv.badges.length) return '';
    return `<section class="pf-section" aria-labelledby="pf-badges"><h2 id="pf-badges">Badges <span class="pf-count">${inv.badges.length}</span></h2>
<ul class="pf-badges">${inv.badges.map((b) => {
        // Each badge wears its own picture (what it was earned for); the medal only when it has none.
        const site = b.site ? siteForHost(b.site) : null;
        const when = b.awarded_at && monthOf(b.awarded_at) ? monthOf(b.awarded_at) : '';
        const title = `${when ? `Earned ${when}` : 'Earned'} on OpenVibe.Quest${site ? `: an ${fullName(site)} quest` : ''}`;
        const ic = b.icon ? `<span class="pf-badge-ic is-glyph" aria-hidden="true">${glyphs.svg(b.icon)}</span>` : '<span class="pf-badge-ic" aria-hidden="true">🏅</span>';
        return `<li><a class="pf-badge" href="${QUEST_SITE}/" title="${esc(title)}">${ic}<span>${esc(b.name)}</span>${when ? `<small>${esc(when)}</small>` : ''}</a></li>`;
    }).join('')}</ul></section>`;
}

/** Games: each game the person played with its achievements (newest first), Steam-style; links to the game's row on OpenVibe.Games. */
function gamesHtml(inv) {
    const a = inv.achievements;
    if (!a || !a.games.length) return '';
    return `<section class="pf-section" aria-labelledby="pf-games"><h2 id="pf-games">Games <span class="pf-count">${a.games.length}</span></h2>
<ul class="pf-games">${a.games.map((g) => `<li class="pf-game"><a class="pf-game-head" href="${esc(g.url)}"><span class="pf-game-name">${esc(g.name)}</span><span class="pf-game-n">${esc(plural(g.count, 'achievement', 'achievements'))}</span></a>
<ul class="pf-ach">${g.recent.map((x) => `<li title="${esc(x.description || x.name)}"><span aria-hidden="true">🏆</span> ${esc(x.name)}${x.unlocked_at && monthOf(x.unlocked_at) ? ` <small>${esc(monthOf(x.unlocked_at))}</small>` : ''}</li>`).join('')}</ul></li>`).join('')}</ul></section>`;
}

/** Break opportunities in a run-together name (CrackheadCarl → Crackhead<wbr>Carl): on escaped text, letters only. */
const softBreaks = (escaped) => escaped.replace(/([a-z])([A-Z])/g, '$1<wbr>$2');

function itemsHtml(inv, u) {
    const name = esc(u.display_name || u.username);
    if (inv.unavailable) return `<section class="pf-section" aria-labelledby="pf-items"><h2 id="pf-items">Items</h2><p class="pf-empty">The items could not be loaded just now. They are safe on <a href="${INVENTORY_SITE}/">OpenVibe.Inventory</a>; try again in a minute.</p></section>`;
    if (!inv.items.length) return `<section class="pf-section" aria-labelledby="pf-items"><h2 id="pf-items">Items</h2><p class="pf-empty">${name} has no items yet. Items come from streaming, chatting and playing on OpenVibe sites. <a href="${INVENTORY_SITE}/items">See what there is</a>.</p></section>`;
    const groups = new Map();
    for (const i of inv.items) {
        if (!groups.has(i.kind)) groups.set(i.kind, { name: i.kind_name, list: [] });
        groups.get(i.kind).list.push(i);
    }
    const worn = new Set(inv.showcase.map((i) => i.instance_id));
    const sorted = [...groups.values()].sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name));
    const all = SUBJECT_RE.test(String(u.subject_id || '')) ? `${INVENTORY_SITE}/u/${u.subject_id}` : `${INVENTORY_SITE}/`;
    return `<section class="pf-section" aria-labelledby="pf-items"><h2 id="pf-items">Items <span class="pf-count">${inv.more ? `${inv.total}+` : inv.total}</span></h2>
${sorted.map((g) => {
        g.list.sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || a.name.localeCompare(b.name));
        return `<h3 class="pf-kind-head">${esc(g.name)} <span class="pf-count">${g.list.length}</span></h3>
<ul class="pf-grid">${g.list.map((i) => `<li class="pf-card r-${esc(i.rarity)}${worn.has(i.instance_id) ? ' is-worn' : ''}"><a href="${esc(i.url)}" title="${esc(`${i.name} · ${RARITY_LABEL[i.rarity]}`)}">${art(i)}<span class="pf-card-name">${softBreaks(esc(i.name))}</span>${rarityBadge(i.rarity)}${worn.has(i.instance_id) ? '<span class="pf-worn-tag">Worn</span>' : ''}</a></li>`).join('')}</ul>`;
    }).join('\n')}
<p class="pf-note"><a href="${esc(all)}">${inv.more ? 'Every item' : 'This inventory'} on OpenVibe.Inventory</a> · <a href="${INVENTORY_SITE}/items">Every item there is</a></p></section>`;
}

function renderPage(u, inv, origin = SITE, places = { spaces: [], community: [], videos: [] }, level = null) {
    const canonicalUrl = `${origin}/@${encodeURIComponent(u.username)}`;
    const name = u.display_name || u.username;
    const isPublic = !!inv;
    // What they wear shows on the profile itself: the name effect on their name (items.css), the hat on the picture.
    const worn = (kind) => (isPublic ? inv.showcase.find((i) => i.kind === kind) : null);
    const fx = worn('live.name_effect');
    const fxClass = fx && NAME_FX_RE.test(String((fx.art || {}).token || '')) ? fx.art.token : null;
    const hat = worn('live.hat');
    const hatGlyph = hat && (hat.art || {}).emoji ? String(hat.art.emoji).slice(0, 8) : null;
    // A community badge they wear (the Workshop, network.badge): its reviewed image before their name.
    const badge = worn('network.badge');
    const badgeId = badge && /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String((badge.art || {}).media_id || '')) ? badge.art.media_id : null;
    const color = COLOR_RE.test(String(u.profile_color || '')) ? u.profile_color : '#3b82f6';
    const since = monthOf(u.created_at);
    const bio = isPublic ? String(u.public_page_bio || u.bio || '').trim().slice(0, 280) : '';
    let publicLinks = [];
    try { publicLinks = typeof u.public_page_links === 'string' ? JSON.parse(u.public_page_links) : (u.public_page_links || []); } catch {}
    const indexable = isPublic && (!!String(u.public_page_bio || '').trim() || (Array.isArray(publicLinks) && publicLinks.length > 0));
    const title = `${name} (@${u.username}) · OpenVibe`;
    const description = !isPublic
        ? `${name} on OpenVibe. This profile is private.`
        : (bio ? bio.slice(0, 155) : `${name}'s profile on OpenVibe${inv.total ? `: ${plural(inv.total, 'item', 'items')}` : ''}${inv.showcase.length ? `, wearing ${inv.showcase.slice(0, 3).map((i) => i.name).join(', ')}` : ''}.`);
    const stats = isPublic ? [
        since ? `<li><span class="pf-stat-k">Member since</span><span class="pf-stat-v">${esc(since)}</span></li>` : '',
        inv.badges && inv.badges.length ? `<li><span class="pf-stat-k">Badges</span><span class="pf-stat-v">${inv.badges.length}</span></li>` : '',
        inv.achievements && inv.achievements.total ? `<li><span class="pf-stat-k">Achievements</span><span class="pf-stat-v">${inv.achievements.total}</span></li>` : '',
        inv.unavailable ? '' : `<li><span class="pf-stat-k">Items</span><span class="pf-stat-v">${inv.more ? `${inv.total}+` : inv.total}</span></li>`,
        inv.items.length ? `<li><span class="pf-stat-k">Rarest</span><span class="pf-stat-v">${esc(RARITY_LABEL[inv.items.reduce((best, i) => (rarityRank(i.rarity) > rarityRank(best) ? i.rarity : best), 'common')])}</span></li>` : '',
    ].join('') : '';
    const ld = isPublic ? seo.jsonLdTag({
        '@context': 'https://schema.org', '@type': 'ProfilePage', url: canonicalUrl, name: title,
        ...(String(u.created_at || '').length >= 10 ? { dateCreated: String(u.created_at).slice(0, 10) } : {}),
        mainEntity: { '@type': 'Person', name, alternateName: `@${u.username}`, image: avatarUrl(u.username, 256), url: canonicalUrl, ...(bio ? { description: bio } : {}) },
    }) : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonicalUrl)}">
${indexable ? '' : '<meta name="robots" content="noindex">'}
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonicalUrl)}">
<meta property="og:image" content="${esc(avatarUrl(u.username, 256))}">
<meta property="profile:username" content="${esc(u.username)}">
<link rel="alternate" type="application/json" href="/api/v1/profiles/${esc(encodeURIComponent(u.username))}">
${require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: '/assets' })}
<meta name="color-scheme" content="dark light">
<script src="/shared/theme-loader.js" defer></script>
${fxClass ? '<link rel="stylesheet" href="/shared/items.css">' : ''}
${ld}
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg-primary:#0a0f1c;--bg-secondary:#101828;--bg-card:#0f172a;--border:#1f2d47;--accent:#3b82f6;--text-primary:#e6edf7;--text-secondary:#96a7c2;--text-muted:#7386a3;
--r-common:#94a3b8;--r-uncommon:#22c55e;--r-rare:#3b82f6;--r-epic:#a855f7;--r-legendary:#f59e0b}
html,body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
a{color:var(--accent)}
.pf{max-width:1040px;margin:0 auto;padding:20px 16px 48px}
.pf-hero{position:relative;border:1px solid var(--border);border-radius:18px;overflow:hidden;background:var(--bg-secondary)}
.pf-banner{height:96px;background:linear-gradient(120deg,color-mix(in srgb,var(--pf-color) 70%,transparent),color-mix(in srgb,var(--pf-color) 18%,transparent) 60%,transparent),var(--bg-card)}
.pf-head{display:flex;gap:20px;align-items:flex-end;padding:0 24px 20px;margin-top:-52px;flex-wrap:wrap}
.pf-pic{position:relative;flex:none}.pf-hat{position:absolute;top:-22px;left:50%;transform:translateX(-50%) rotate(-12deg);font-size:40px;line-height:1;filter:drop-shadow(0 3px 4px rgba(0,0,0,.45));pointer-events:none}
.pf-avatar{width:112px;height:112px;border-radius:50%;object-fit:cover;border:4px solid var(--bg-secondary);box-shadow:0 0 0 2px var(--pf-color);background:var(--bg-card);flex:none}
.pf-who{flex:1;min-width:200px;padding-top:56px}
.pf-who h1{margin:0;font-size:clamp(1.5rem,4vw,2.1rem);line-height:1.15;overflow-wrap:anywhere}
.pf-name-badge{width:.85em;height:.85em;margin-right:.25em;vertical-align:-.08em;border-radius:6px;object-fit:contain}
.pf-handle{margin:.2em 0 0;color:var(--text-secondary)}.pf-places a .pf-live{display:inline-flex;align-items:center;gap:6px;color:var(--live-red,#e5484d);font-weight:700}.pf-live::before{content:'';width:8px;height:8px;border-radius:50%;background:currentColor}
.pf-bio{margin:0;padding:0 24px 18px;color:var(--text-primary);line-height:1.6;white-space:pre-line;overflow-wrap:anywhere;max-width:72ch}
.pf-stats{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0 24px 22px}
.pf-stats li{display:flex;flex-direction:column;gap:2px;padding:8px 14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card);min-width:110px}
.pf-stat-k{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)}
.pf-stat-v{font-weight:700}
.pf-private{margin:0;padding:0 24px 24px;color:var(--text-secondary)}
.pf-section{margin-top:28px}
.pf-section h2{font-size:1.15rem;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.pf-kind-head{font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);margin:20px 0 10px;display:flex;align-items:center;gap:8px}
.pf-count{font-size:.75rem;font-weight:700;padding:.1rem .5rem;border-radius:999px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--text-primary);letter-spacing:0;text-transform:none}
.pf-showcase{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.pf-worn a{display:flex;gap:14px;align-items:center;padding:14px;border-radius:14px;text-decoration:none;color:inherit;border:1px solid color-mix(in srgb,var(--rc) 45%,var(--border));background:linear-gradient(135deg,color-mix(in srgb,var(--rc) 14%,var(--bg-secondary)),var(--bg-secondary))}
.pf-worn a:hover,.pf-worn a:focus-visible{border-color:var(--rc)}
.pf-worn-body{display:flex;flex-direction:column;gap:3px;min-width:0}
.pf-kind{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)}
.pf-name{font-weight:700;overflow-wrap:anywhere}
.pf-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
.pf-card a{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 10px;border-radius:12px;border:1px solid var(--border);border-bottom:3px solid var(--rc);background:var(--bg-secondary);text-decoration:none;color:inherit;text-align:center;height:100%}
.pf-card a:hover,.pf-card a:focus-visible{border-color:var(--rc);background:color-mix(in srgb,var(--rc) 8%,var(--bg-secondary))}
.pf-card-name{font-size:.85rem;font-weight:600;overflow-wrap:anywhere}
.pf-worn-tag{position:absolute;top:6px;right:6px;font-size:.62rem;font-weight:700;padding:.05rem .4rem;border-radius:999px;background:var(--accent-strong, var(--accent, #3472d8));color:var(--on-accent-strong, var(--on-accent,#fff))}
.pf-art{display:inline-flex;align-items:center;justify-content:center;border-radius:12px;background:radial-gradient(circle at 50% 35%,color-mix(in srgb,var(--rc) 30%,transparent),color-mix(in srgb,var(--rc) 8%,var(--bg-card)));flex:none;overflow:hidden}
.pf-art-md{width:56px;height:56px;font-size:28px}.pf-art-lg{width:68px;height:68px;font-size:34px}
.pf-art img{width:100%;height:100%;object-fit:cover}
.pf-rarity{font-size:.68rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:color-mix(in srgb,var(--rc) 70%,var(--text-primary))}
.r-common{--rc:var(--r-common)}.r-uncommon{--rc:var(--r-uncommon)}.r-rare{--rc:var(--r-rare)}.r-epic{--rc:var(--r-epic)}.r-legendary{--rc:var(--r-legendary)}
.pf-badges{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.pf-badge{display:inline-flex;align-items:center;gap:8px;padding:7px 14px 7px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--r-legendary) 40%,var(--border));background:color-mix(in srgb,var(--r-legendary) 10%,var(--bg-secondary));color:var(--text-primary);text-decoration:none;font-weight:600;font-size:.88rem}
.pf-badge:hover,.pf-badge:focus-visible{border-color:var(--r-legendary)}
.pf-badge small{font-weight:500;color:var(--text-muted);font-size:.75rem}
.pf-badge-ic{font-size:1.05rem}.pf-badge-ic.is-glyph{display:inline-grid;place-items:center;width:20px;height:20px;flex:none;color:color-mix(in srgb,var(--r-legendary) 72%,var(--text-primary))}.pf-badge-ic.is-glyph svg{width:17px;height:17px}
.pf-games{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:12px}
.pf-game{border:1px solid var(--border);border-radius:14px;background:var(--bg-secondary);padding:12px 14px;min-width:0}
.pf-game-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline;text-decoration:none;color:inherit;margin-bottom:8px}
.pf-game-name{font-weight:700;overflow-wrap:anywhere}.pf-game-n{font-size:.8rem;color:var(--text-muted);flex:none}
.pf-ach{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr);gap:4px;font-size:.88rem}
.pf-ach li{overflow-wrap:anywhere}.pf-ach small{color:var(--text-muted);font-size:.75rem}
.pf-empty{color:var(--text-secondary);padding:18px;border:1px dashed var(--border);border-radius:12px;margin:0}
.pf-note{color:var(--text-secondary);font-size:.85rem;margin:12px 0 0}
.pf-links{display:flex;flex-wrap:wrap;gap:10px;list-style:none;margin:0 0 18px;padding:0 24px}.pf-links a{display:inline-flex;min-height:44px;align-items:center;padding:8px 14px;border:1px solid var(--border);border-radius:999px;color:var(--text-primary);text-decoration:none}
@media(max-width:600px){.pf-links{display:grid;padding:0 24px}.pf-links a{justify-content:center;min-height:50px;border-radius:14px;font-weight:650}}
.pf-places{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:12px;list-style:none;padding:0;margin:0}.pf-places li{min-width:0}.pf-places a{display:flex;align-items:center;gap:12px;min-height:72px;padding:10px 14px 10px 10px;transition:border-color .15s ease,transform .15s ease;border:1px solid var(--border);border-radius:14px;background:var(--bg-secondary);color:var(--text-primary);text-decoration:none;overflow-wrap:anywhere}.pf-places a:hover{border-color:color-mix(in srgb,var(--accent,#3b82f6) 55%,var(--border))}.pf-places a:active{transform:scale(.99)}.pf-place-t{display:grid;gap:3px;min-width:0}.pf-place-t strong{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.pf-place-t>span{font-size:.82rem;color:var(--text-secondary)}.pf-place-i{display:grid;place-items:center;flex:none;width:52px;height:52px;border-radius:14px;background:color-mix(in srgb,var(--accent,#3b82f6) 13%,transparent);color:var(--accent-text,var(--accent,#3b82f6))}.pf-place-i svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.pf-place-i--live{background:color-mix(in srgb,var(--live-red,#e5484d) 14%,transparent);color:var(--live-red,#e5484d)}.pf-place.is-live a{border-color:color-mix(in srgb,var(--live-red,#e5484d) 55%,var(--border))}.pf-place-i--site{background:color-mix(in srgb,var(--success,#34d399) 13%,transparent);color:var(--success-text,var(--success,#34d399))}.pf-place-i--paste,.pf-place-i--picture{background:color-mix(in srgb,#a78bfa 15%,transparent);color:#a78bfa}.pf-place-pic{position:relative;flex:none;width:96px;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--bg-primary)}.pf-place-pic img{display:block;width:100%;height:100%;object-fit:cover}.pf-place-pic b{position:absolute;right:4px;bottom:4px;padding:1px 5px;border-radius:6px;background:rgba(0,0,0,.72);color:#fff;font-size:.68rem;font-weight:700;font-variant-numeric:tabular-nums}
@media (max-width:560px){.pf-head{padding:0 16px 16px;gap:14px}.pf-avatar{width:92px;height:92px}.pf-hat{font-size:32px;top:-18px}.pf-who{padding-top:0;min-width:100%}.pf-bio,.pf-stats,.pf-private{padding-left:16px;padding-right:16px}.pf-grid{grid-template-columns:repeat(auto-fill,minmax(112px,1fr))}.pf-badge small{display:none}.pf-badge{padding:6px 12px 6px 9px}}
</style>
</head>
<body>
<div id="navbar-mount"></div>
${require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Sign in', href: '/login' }, { label: 'Inventory', href: `${INVENTORY_SITE}/` }] })}
<main class="pf" id="main" style="--pf-color:${esc(color)}">
<section class="pf-hero" aria-label="Profile">
<div class="pf-banner" aria-hidden="true"></div>
<div class="pf-head">
<div class="pf-pic"><img class="pf-avatar" src="${esc(avatarUrl(u.username))}" alt="" width="112" height="112">${hatGlyph ? `<span class="pf-hat" title="${esc(hat.name)}" aria-hidden="true">${esc(hatGlyph)}</span>` : ''}</div>
<div class="pf-who">${level ? `<p><a href="https://openvibe.quest/levels">Level ${level.level}</a> · ${level.xp} experience <progress aria-label="Experience to next level" value="${level.into}" max="${level.span}"></progress></p>` : ''}<h1>${badgeId ? `<img class="pf-name-badge" src="https://openvibe.media/o/${badgeId}" alt="" title="${esc(badge.name)}" width="32" height="32">` : ''}${fxClass ? `<span class="ov-fx ${fxClass}" title="${esc(fx.name)}">${esc(name)}</span>` : esc(name)}</h1><p class="pf-handle">@${esc(u.username)}</p></div>
</div>
${bio ? `<p class="pf-bio">${esc(bio)}</p>` : ''}
${isPublic && Array.isArray(publicLinks) && publicLinks.length ? `<nav aria-label="${esc(name)}'s links"><ul class="pf-links">${publicLinks.slice(0, 8).map((link) => { let href = ''; try { const parsed = new URL(link.url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) href = parsed.href; } catch {} return href ? `<li><a rel="me noopener noreferrer" href="${esc(href)}">${esc(String(link.label || '').slice(0, 40))}</a></li>` : ''; }).join('')}</ul></nav>` : ''}
${isPublic ? `<ul class="pf-stats">${stats}</ul>` : '<p class="pf-private">This profile is private.</p>'}
</section>
${isPublic ? publicPlacesHtml(places) : ''}
${isPublic ? showcaseHtml(inv, name) + badgesHtml(inv) + gamesHtml(inv) + itemsHtml(inv, u) : ''}
</main>
${require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact' })}
<script src="/shared/navbar.js" defer></script>
<script src="/js/account-safety.js" defer></script>
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:location.origin,links:${JSON.stringify(pageLinks.NETWORK)}});}catch(e){}});</script>
</body>
</html>`;
}

module.exports = { createPublicProfiles, renderPage, monthOf, SUBJECT_RE, PUBLIC_PLACE_TIMEOUT_MS, PUBLIC_PLACE_TTL_MS };
