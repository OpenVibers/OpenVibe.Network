'use strict';

/**
 * GET /api/v1/feed — one feed for all of OpenVibe (feed.item@1).
 *
 *   GET /api/v1/feed?kind=&site=&q=&following=1&cursor=&limit=
 *   GET /api/v1/feed/search?q=&cursor=&limit=
 *   GET /api/v1/feed/examples
 *   GET /api/v1/feed/wall?limit=&cursor=          the menu's older wall, the same rows and ids
 *
 * Signed out returns public items only; signed in reads the person's follows (Following) and ranks
 * For you by follows, what they open (Network's cross-site history) and freshness. A private or
 * follower-only item never reaches a signed-out answer, and never anyone but its author or a follower.
 * The menu asks the same handler through /api/frame/feed (server/frame/service.js); Community's
 * /api/v1/feed proxies it, so the menu and Pulse show the same ids.
 */
const express = require('express');
const store = require('./store');
const { cardOf, foldCards, rankCards, searchMatches, searchExamples, wallItem, bulkId, BULK_WORD } = require('./card');
const { createFeedSources } = require('./sources');
const { createEffects } = require('./effects');
const { createEventsPull } = require('./events');
const session = require('../auth/session');

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const KINDS = ['post', 'pic', 'clip', 'video', 'live', 'stream', 'rundown', 'quest', 'member', 'chat', 'event', 'wiki', 'update', 'work', 'deal', 'news', 'report', 'poll', 'game', 'meme', 'paste', 'episode', 'space', 'avatar', 'banner', 'follow', 'site'];
const SITE_RE = /^[a-z0-9][a-z0-9:-]{0,39}$/;
// A cursor is [occurred_at, id] and, from 11-12, the bursts the pages before already showed ("deal|deals|2026-11-12T18"):
// the next page leaves their rows out, so a Deals poll is one card however many pages it spans.
const BURST_KEY = /^(deal|news|event)\|[a-z][a-z0-9-]{0,30}\|\d{4}-\d\d-\d\dT\d\d$/;
const encodeCursor = ([at, id], done = []) => Buffer.from(JSON.stringify([new Date(at).toISOString(), Number(id), ...(done.length ? [done.slice(0, 8)] : [])])).toString('base64url');
const decodeCursor = (v) => {
    if (!v || typeof v !== 'string' || v.length > 1200) return null;
    try {
        const [at, id, done] = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
        if (typeof at !== 'string' || !Number.isSafeInteger(id) || id <= 0) return null;
        const kept = Array.isArray(done) ? done.filter((k) => typeof k === 'string' && BURST_KEY.test(k)).slice(0, 8) : [];
        return Object.assign([at, id], { done: kept });
    } catch { return null; }
};
const burstsOf = (keys) => keys.map((k) => { const [kind, site, hour] = k.split('|'); return { kind, site, hour }; });
const problem = (res, status, code, detail) => res.status(status).json({ type: `https://openvibe.network/problems/${code}`, title: status === 401 ? 'Unauthorized' : 'Bad request', status, code, detail });

/** The person asking, when they carry a live session (Bearer or page cookie); never a service token. */
async function viewerOf(req, { db, publicKey, config }) {
    try {
        const token = session.sessionToken(req);
        if (!token) return null;
        const v = await session.verifySession(token, { db, publicKey, config });
        if (!v || !v.user) return null;
        return { id: v.user.id, subject: v.user.subject_id || null };
    } catch { return null; }
}

/**
 * The people the rows name, in one query: their name, their picture, their username (handle) and their
 * level (feed.item@1 1.1.0). The level is the one the leaderboard shows — person_levels.level, one for
 * a person who has no row yet — and null for a person who hides it from the leaderboard (the same rule
 * server/profile/card.js follows).
 */
async function actorsFor(db, rows) {
    const subjects = [...new Set(rows.map((r) => r.actor_subject).filter((s) => /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(s || ''))))];
    if (!subjects.length) return new Map();
    const users = await db.prepare(`SELECT u.subject_id, u.display_name, u.username, u.avatar_url,
            COALESCE(l.level, 1) AS level, l.leaderboard
        FROM users u LEFT JOIN person_levels l ON l.user_id = u.id
        WHERE u.subject_id IN (${subjects.map(() => '?').join(', ')})`).all(...subjects);
    return new Map(users.map((u) => [u.subject_id, {
        name: u.display_name || u.username,
        avatar: u.avatar_url || null,
        handle: String(u.username || '').match(/^[A-Za-z0-9_.-]{1,40}$/) ? String(u.username) : null,
        // A person who hides their level from the leaderboard sends null; the level is never guessed.
        level: u.leaderboard === false ? null : Math.min(1000, Math.max(1, Number(u.level) || 1)),
    }]));
}

function createFeedApi({ db, config = {}, privateKey = null, issuer = null, publicKey = '', fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, presence = null, startCollectors = true } = {}) {
    const sources = createFeedSources({ db, config, fetchImpl, now, log, presence });
    const events = createEventsPull({ db, eventsUrl: config.eventsInternalUrl, privateKey, issuer, fetchImpl, log, now });
    // The name effect a person wears (actor.fx): asked of OpenVibe.Inventory by the feed's own server,
    // so no site needs Inventory in its connect-src. Inventory down leaves the cards without one.
    const effects = createEffects({ baseUrl: (config.feed && config.feed.inventoryUrl) || '', fetchImpl, now });
    let started = false;

    const headers = (req, res) => {
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization',
            Vary: 'Authorization',
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': req.get('authorization') ? 'private, no-store' : 'public, max-age=30',
        });
    };

    async function page(req, { wall = false } = {}) {
        const kind = KINDS.includes(String(req.query.kind || '')) ? String(req.query.kind) : '';
        const site = SITE_RE.test(String(req.query.site || '')) ? String(req.query.site) : '';
        const q = clean(req.query.q, 80);
        const following = /^(1|true|yes|on)$/i.test(String(req.query.following || ''));
        const want = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 40);
        const viewer = await viewerOf(req, { db, publicKey, config });
        if (following && !viewer) return { error: 'sign_in' };
        const followed = viewer && viewer.subject ? await store.followedSubjects(db, viewer.subject) : [];
        const affinity = viewer ? await store.affinityServices(db, viewer.id) : new Map();
        const before = decodeCursor(String(req.query.cursor || ''));

        const read = await store.listItems(db, {
            kind, site, q, followed, following, before, viewerSubject: viewer && viewer.subject, skipBursts: before ? burstsOf(before.done || []) : [],
            limit: Math.min(400, want * 6 + 40), since: new Date(now() - 60 * 86400000).toISOString(),
        });
        const actors = await actorsFor(db, read.rows);
        // The name effect each of them wears: one Inventory read for the page, kept a minute.
        const tokens = await effects.effects([...actors.keys()]);
        for (const [subject, actor] of actors) {
            const token = tokens.get(subject);
            if (token) actor.fx = token;
        }
        let cards = read.rows.map((r) => cardOf(r, actors.get(r.actor_subject) || null));
        // The one view store (Media): counts.views and counts.engaged for every card, batched, and only here —
        // a Media outage leaves the source's own counts. The source's like/comment counts are kept. The feed.item@1
        // schema has no ref field, so the ref is built beside the cards, never added to one.
        try {
            const held = cards.map((card, i) => ({
                counts: card.counts,
                ref: { service: read.rows[i].source_service, kind: read.rows[i].source_type, id: String(read.rows[i].source_id),
                    ...(read.rows[i].actor_subject ? { creator: String(read.rows[i].actor_subject) } : {}) },
            }));
            await require('../views/counts').attachCounts(held);
            held.forEach((h, i) => { cards[i].counts = h.counts; });
        } catch { /* a card without a count */ }
        if (q) cards = cards.filter((c) => searchMatches(c, q));
        cards = foldCards(cards, now());
        // A burst's card counts the whole hour, not just the rows this page read (11-12: three "112 new deals").
        for (const card of cards.filter((c) => c.bulk)) {
            const b = card.bulk;
            delete card.bulk;
            let n = card.group ? card.group.count : 1;
            try { n = Math.max(n, await store.countBulk(db, b)); } catch { /* the page's own count */ }
            if (n < 2) continue;
            if (!card.group) card.group = { count: n, items: [{ id: card.id, url: card.url, title: card.title, media: card.media }] };
            card.id = bulkId(b.kind, b.site, b.hour);
            card.title = `${n.toLocaleString('en-US')} new ${b.many}`;
            card.group.count = n;
            card.counts = { ...card.counts, people: n };
        }
        cards = rankCards(cards, { followed: new Set(followed), affinity, now: now() });
        const items = cards.slice(0, want);
        // The next page starts at the newest row whose card this page did not show (it used to start after every row
        // read, so the cards past the first `want` were never seen); a row of a shown burst or group counts as shown.
        const shown = new Set();
        for (const c of items) { shown.add(c.id); for (const it of (c.group && c.group.items) || []) shown.add(it.id); }
        const rowShown = (r) => {
            const hour = r.occurred_at ? new Date(r.occurred_at).toISOString().slice(0, 13) : '';
            return shown.has(`f:${r.source_service}:${r.source_type}:${r.source_id}`)
                || (!r.actor_subject && BULK_WORD[r.kind] && shown.has(bulkId(r.kind, r.site, hour)))
                || (r.kind === 'work' && shown.has(`g:work:${hour}`));
        };
        const firstOut = read.rows.findIndex((r) => !rowShown(r));
        const edge = firstOut > 0 ? read.rows[firstOut - 1] : read.rows[read.rows.length - 1];
        // The bursts shown so far ride in the cursor while the next page can still meet their rows (an hour that has not
        // ended before the cursor's time).
        const edgeAt = edge ? new Date(edge.occurred_at).toISOString() : '';
        const done = [...new Set([...(before ? before.done || [] : []),
            ...items.filter((c) => /^g:(deal|news|event):/.test(c.id)).map((c) => c.id.slice(2).replace(/:/, '|').replace(/:(?=\d{4}-)/, '|'))])]
            .filter((k) => BURST_KEY.test(k) && `${k.split('|')[2]}:00:00.000Z` < edgeAt).slice(-8);
        const next = (firstOut > 0 || read.hasMore) && edge ? encodeCursor([edge.occurred_at, edge.id], done) : null;
        if (wall) return { items: items.map(wallItem), next_cursor: next };
        return { items, next_cursor: next };
    }

    async function apiPage(req, res, opts) {
        headers(req, res);
        const out = await page(req, opts);
        if (out.error === 'sign_in') return problem(res, 401, 'feed.sign_in_required', 'Sign in to see the people you follow');
        return res.json(out);
    }

    const handleFeed = (req, res, next) => apiPage(req, res).catch(next);
    const handleWall = (req, res, next) => apiPage(req, res, { wall: true }).catch(next);
    const handleExamples = async (req, res, next) => {
        try {
            headers(req, res);
            const read = await store.listItems(db, { limit: 100, since: new Date(now() - 7 * 86400000).toISOString() });
            const actors = await actorsFor(db, read.rows);
            res.json({ examples: searchExamples(read.rows.map((r) => cardOf(r, actors.get(r.actor_subject) || null))) });
        } catch (err) { next(err); }
    };
    const handleSearch = async (req, res, next) => {
        try {
            headers(req, res);
            const q = clean(req.query.q, 80);
            if (!q) return problem(res, 400, 'feed.search_required', 'Enter a search term');
            const want = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 40);
            const viewer = await viewerOf(req, { db, publicKey, config });
            const followed = viewer && viewer.subject ? await store.followedSubjects(db, viewer.subject) : [];
            const read = await store.listItems(db, { q, followed, viewerSubject: viewer && viewer.subject, limit: 400, since: new Date(now() - 365 * 86400000).toISOString() });
            const actors = await actorsFor(db, read.rows);
            const cards = foldCards(read.rows.map((r) => cardOf(r, actors.get(r.actor_subject) || null)).filter((c) => searchMatches(c, q)), now()).map(({ bulk, ...c }) => c);
            res.json({ items: rankCards(cards, { followed: new Set(followed), now: now() }).slice(0, want), next_cursor: null });
        } catch (err) { next(err); }
    };
    const router = express.Router();
    router.get('/', handleFeed);
    router.get('/wall', handleWall);
    router.get('/examples', handleExamples);
    router.get('/search', handleSearch);
    router.options('*', (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '600' });
        res.status(204).end();
    });

    function start() {
        if (started || !startCollectors) return;
        started = true;
        sources.start();
        events.start();
    }
    function stop() { sources.stop(); events.stop(); }

    return { router, page, handleFeed, handleWall, handleSearch, handleExamples, start, stop, sources, events, viewerOf };
}

module.exports = { createFeedApi, viewerOf, actorsFor, encodeCursor, decodeCursor, KINDS };
