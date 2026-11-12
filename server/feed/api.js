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
const { cardOf, foldCards, rankCards, searchMatches, searchExamples, wallItem } = require('./card');
const { createFeedSources } = require('./sources');
const { createEventsPull } = require('./events');
const session = require('../auth/session');

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const KINDS = ['post', 'pic', 'clip', 'video', 'live', 'stream', 'rundown', 'quest', 'member', 'chat', 'event', 'wiki', 'update', 'work', 'deal', 'news', 'report', 'poll', 'game', 'meme', 'paste', 'episode', 'space', 'avatar', 'banner', 'follow', 'site'];
const SITE_RE = /^[a-z0-9][a-z0-9:-]{0,39}$/;
const encodeCursor = ([at, id]) => Buffer.from(JSON.stringify([new Date(at).toISOString(), Number(id)])).toString('base64url');
const decodeCursor = (v) => {
    if (!v || typeof v !== 'string' || v.length > 400) return null;
    try {
        const [at, id] = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
        return typeof at === 'string' && Number.isSafeInteger(id) && id > 0 ? [at, id] : null;
    } catch { return null; }
};
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

async function actorsFor(db, rows) {
    const subjects = [...new Set(rows.map((r) => r.actor_subject).filter((s) => /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(s || ''))))];
    if (!subjects.length) return new Map();
    const users = await db.prepare(`SELECT subject_id, display_name, username, avatar_url FROM users WHERE subject_id IN (${subjects.map(() => '?').join(', ')})`).all(...subjects);
    return new Map(users.map((u) => [u.subject_id, { name: u.display_name || u.username, avatar: u.avatar_url || null }]));
}

function createFeedApi({ db, config = {}, privateKey = null, issuer = null, publicKey = '', fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, presence = null, startCollectors = true } = {}) {
    const sources = createFeedSources({ db, config, fetchImpl, now, log, presence });
    const events = createEventsPull({ db, eventsUrl: config.eventsInternalUrl, privateKey, issuer, fetchImpl, log, now });
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
            kind, site, q, followed, following, before, viewerSubject: viewer && viewer.subject,
            limit: Math.min(400, want * 6 + 40), since: new Date(now() - 60 * 86400000).toISOString(),
        });
        const actors = await actorsFor(db, read.rows);
        let cards = read.rows.map((r) => cardOf(r, actors.get(r.actor_subject) || null));
        if (q) cards = cards.filter((c) => searchMatches(c, q));
        cards = foldCards(cards, now());
        cards = rankCards(cards, { followed: new Set(followed), affinity, now: now() });
        const items = cards.slice(0, want);
        const last = read.rows[read.rows.length - 1];
        const next = read.hasMore && last ? encodeCursor([last.occurred_at, last.id]) : null;
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
            const cards = foldCards(read.rows.map((r) => cardOf(r, actors.get(r.actor_subject) || null)).filter((c) => searchMatches(c, q)), now());
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
