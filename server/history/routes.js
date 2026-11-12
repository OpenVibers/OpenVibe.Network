'use strict';
// ═══════════════════════════════════════════════════════════════
// Cross-site history — one timeline per account of what it touched anywhere on the network
// (a tool on openvibe.tools, a stream on openvibe.live, a paste on openvibe.community, a game).
// Written by the shared history.js browser module through the navbar, read back by the
// navbar's "Recently used" rows and the History tab on the account page.
//
// Privacy: nothing is stored for anonymous sessions; the user can pause recording
// (users.history_paused) and delete single entries or everything. Entries carry only what
// the page told us — a type, a title, a URL and an optional small meta object — never
// request bodies or anything from other accounts.
// ═══════════════════════════════════════════════════════════════
const express = require('express');

const MAX_PER_USER = 20000;          // oldest rows beyond this are trimmed on write
const DEDUPE_WINDOW_MIN = 60;       // same URL within this window bumps the entry instead of adding one
const TYPES = new Set(['tool', 'stream', 'vod', 'clip', 'paste', 'game', 'page', 'post', 'account', 'theme', 'download', 'chat', 'thread', 'video', 'document', 'conversation']);
const SERVICE_LABELS = {
    live: 'Live', tools: 'Tools', games: 'Games', media: 'Media', network: 'Network', community: 'Community', space: 'Space',
    chat: 'Chat', codes: 'Codes', blog: 'Blog', wiki: 'Wiki', news: 'News', reviews: 'Reviews', tips: 'Tips',
    vip: 'VIP', trade: 'Trade', host: 'Host', deals: 'Deals', coupons: 'Coupons', openre: 'Restream',
};

async function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

/** Only http(s) URLs on the network's own domains are recorded; everything else is dropped. */
function allowedUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const h = u.hostname.toLowerCase();
    if (!/(^|\.)openvibe\.[a-z]+$/.test(h) && !/(^|\.)openre\.stream$/.test(h) && h !== 'localhost' && !/^127\./.test(h)) return null;
    u.hash = '';
    // Strip tokens / codes that pages sometimes carry in the query string.
    for (const k of ['token', 'code', 'state', 'access_token', 'ov_token', 'key']) u.searchParams.delete(k);
    return u.toString().slice(0, 2000);
}

function serviceFromUrl(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        const m = h.match(/^(?:(.+)\.)?openvibe\.([a-z]+)$/) || h.match(/^(?:(.+)\.)?(openre)\.stream$/);
        return m ? { service: m[2], sub: m[1] && m[1] !== 'www' ? m[1] : null } : { service: null, sub: null };
    } catch { return { service: null, sub: null }; }
}

// Times leave with their zone (the column holds UTC as "YYYY-MM-DD HH:MM:SS", which a browser reads as its local time:
// west of UTC every visit looked hours ahead and said "just now", 2026-11-12).
const isoUtc = (t) => (typeof t === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(t) ? `${t.replace(' ', 'T')}Z` : t);

function rowOut(r) {
    let meta = null;
    try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { meta = null; }
    return {
        id: r.id, type: r.type, title: r.title, url: r.url, icon: r.icon, image_url: r.image_url || null, service: r.service, sub: r.sub,
        service_label: r.sub ? `${r.sub}.${SERVICE_LABELS[r.service] || r.service || ''}` : (SERVICE_LABELS[r.service] || r.service || null),
        meta, hits: r.hits, created_at: isoUtc(r.created_at), updated_at: isoUtc(r.updated_at),
    };
}

async function createHistoryRoutes(db, requireAuth) {
    await ensureSchema(db);
    const router = express.Router();
    router.use(requireAuth);

    // Anonymous sessions have no history: nothing to read, nothing recorded.
    router.use((req, res, next) => {
        if (req.user?.is_anon) return res.status(403).json({ error: 'History is only kept for signed-in accounts' });
        next();
    });

    router.get('/', async (req, res) => {
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const cursor = String(req.query.cursor || '');
        const where = ['user_id = ?', "updated_at >= (now() - interval '1 year')::text"]; const params = [req.user.id];
        if (req.query.type || req.query.kind) { where.push('type = ?'); params.push(String(req.query.type || req.query.kind).slice(0, 32)); }
        if (req.query.site || req.query.service) { where.push('service = ?'); params.push(String(req.query.site || req.query.service).slice(0, 32)); }
        if (req.query.day) { where.push(`updated_at >= ? AND updated_at < ?`); const d = String(req.query.day).slice(0, 10); params.push(`${d} 00:00:00`, `${d} 23:59:59`); }
        if (req.query.q) { where.push(`to_tsvector('simple', title) @@ plainto_tsquery('simple', ?)`); params.push(String(req.query.q).slice(0, 120)); }
        const countWhere = where.join(' AND '), countParams = params.slice();
        if (cursor) { try { const c = JSON.parse(Buffer.from(cursor, 'base64url').toString()); where.push('(updated_at, id) < (?, ?)'); params.push(c.t, c.i); } catch { return res.status(400).json({ error: 'Invalid cursor' }); } }
        const rows = await db.prepare(`SELECT * FROM user_history WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, cursor ? 0 : offset);
        const hasMore = rows.length > limit; if (hasMore) rows.pop();
        const last = rows[rows.length - 1];
        const next_cursor = hasMore && last ? Buffer.from(JSON.stringify({ t: last.updated_at, i: last.id })).toString('base64url') : null;
        const total = (await db.prepare(`SELECT COUNT(*) AS c FROM user_history WHERE ${countWhere}`).get(...countParams))?.c || 0;
        const paused = !!(await db.prepare('SELECT history_paused FROM users WHERE id = ?').get(req.user.id))?.history_paused;
        res.set('Cache-Control', 'no-store');
        const prefs = await db.prepare('SELECT history_agents_allowed, history_keep_private, history_keep_mature FROM users WHERE id = ?').get(req.user.id);
        const services = (await db.prepare('SELECT service, COUNT(*) AS c FROM user_history WHERE user_id = ? GROUP BY service ORDER BY c DESC').all(req.user.id))
            .map(r => ({ service: r.service, label: SERVICE_LABELS[r.service] || r.service, count: r.c }));
        res.json({ items: rows.map(rowOut), total, paused, keep_history: !paused, agents_allowed: !!prefs?.history_agents_allowed, keep_private: !!prefs?.history_keep_private, keep_mature: !!prefs?.history_keep_mature, next_cursor, services });
    });

    router.post('/', async (req, res) => {
        const u = await db.prepare('SELECT history_paused FROM users WHERE id = ?').get(req.user.id);
        if (u?.history_paused) return res.json({ ok: true, paused: true });
        const url = allowedUrl(req.body?.url);
        if (!url) return res.status(400).json({ error: 'A URL on the OpenVibe network is required' });
        const type = TYPES.has(String(req.body?.type)) ? String(req.body.type) : 'page';
        if (type === 'page') return res.json({ ok: true, skipped: 'not_a_thing' });
        const privacy = await db.prepare('SELECT history_keep_private, history_keep_mature FROM users WHERE id = ?').get(req.user.id);
        if ((req.body?.private && !privacy?.history_keep_private) || (req.body?.mature && !privacy?.history_keep_mature)) return res.json({ ok: true, skipped: 'private_or_mature' });
        await db.prepare("DELETE FROM user_history WHERE user_id = ? AND updated_at < (now() - interval '1 year')::text").run(req.user.id);
        const title = String(req.body?.title || '').trim().slice(0, 200) || url;
        const TYPE_ICONS = { tool: 'fa-screwdriver-wrench', stream: 'fa-tower-broadcast', vod: 'fa-clapperboard', video: 'fa-clapperboard', clip: 'fa-scissors', paste: 'fa-paste', game: 'fa-gamepad', page: 'fa-file-lines', document: 'fa-file-lines', thread: 'fa-comments', post: 'fa-comments', account: 'fa-user', theme: 'fa-palette', download: 'fa-download', chat: 'fa-comment', conversation: 'fa-comment' };
        const icon = /^fa-[a-z0-9-]{1,40}$/.test(String(req.body?.icon || '')) ? String(req.body.icon) : (TYPE_ICONS[type] || null);
        const imageUrl = allowedUrl(req.body?.image_url || req.body?.picture) || null;
        const inf = serviceFromUrl(url);
        const service = String(req.body?.service || inf.service || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || null;
        const sub = String(req.body?.sub || inf.sub || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48) || null;
        let meta = null;
        if (req.body?.meta && typeof req.body.meta === 'object') {
            const s = JSON.stringify(req.body.meta);
            if (s.length <= 1000) meta = s;
        }
        const recent = await db.prepare(`SELECT id FROM user_history WHERE user_id = ? AND url = ? AND updated_at > datetime('now', '-${DEDUPE_WINDOW_MIN} minutes')`).get(req.user.id, url);
        if (recent) {
            await db.prepare('UPDATE user_history SET hits = hits + 1, title = ?, icon = ?, image_url = ?, updated_at = ov_now() WHERE id = ?').run(title, icon, imageUrl, recent.id);
            return res.json({ ok: true, id: recent.id, merged: true });
        }
        const r = await db.prepare('INSERT INTO user_history (user_id, service, sub, type, title, url, icon, meta, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
            .run(req.user.id, service, sub, type, title, url, icon, meta, imageUrl);
        // Trim: keep the newest MAX_PER_USER rows.
        await db.prepare(`DELETE FROM user_history WHERE user_id = ? AND (updated_at < (now() - interval '1 year')::text OR id NOT IN (SELECT id FROM user_history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ${MAX_PER_USER}))`).run(req.user.id, req.user.id);
        res.status(201).json({ ok: true, id: r.lastInsertRowid });
    });

    router.put('/settings', async (req, res) => {
        const paused = req.body?.keep_history === undefined && req.body?.paused === undefined ? null : (req.body?.keep_history === false || req.body?.paused ? 1 : 0);
        const agents = req.body?.agents_allowed === undefined ? null : (req.body.agents_allowed ? 1 : 0);
        const keepPrivate = req.body?.keep_private === undefined ? null : (req.body.keep_private ? 1 : 0);
        const keepMature = req.body?.keep_mature === undefined ? null : (req.body.keep_mature ? 1 : 0);
        await db.prepare('UPDATE users SET history_paused = COALESCE(?, history_paused), history_agents_allowed = COALESCE(?, history_agents_allowed), history_keep_private = COALESCE(?, history_keep_private), history_keep_mature = COALESCE(?, history_keep_mature) WHERE id = ?').run(paused, agents, keepPrivate, keepMature, req.user.id);
        const settings = await db.prepare('SELECT history_paused, history_agents_allowed, history_keep_private, history_keep_mature FROM users WHERE id = ?').get(req.user.id);
        res.json({ ok: true, paused: !!settings?.history_paused, keep_history: !settings?.history_paused, agents_allowed: !!settings?.history_agents_allowed, keep_private: !!settings?.history_keep_private, keep_mature: !!settings?.history_keep_mature });
    });

    router.delete('/', async (req, res) => {
        const r = await db.prepare('DELETE FROM user_history WHERE user_id = ?').run(req.user.id);
        res.json({ ok: true, deleted: r.changes });
    });

    router.delete('/day/:day', async (req, res) => {
        const d = String(req.params.day).slice(0, 10);
        const r = await db.prepare('DELETE FROM user_history WHERE user_id = ? AND updated_at >= ? AND updated_at < ?').run(req.user.id, `${d} 00:00:00`, `${d} 23:59:59`);
        res.json({ ok: true, deleted: r.changes });
    });
    router.delete('/site/:site', async (req, res) => {
        const r = await db.prepare('DELETE FROM user_history WHERE user_id = ? AND service = ?').run(req.user.id, String(req.params.site).slice(0, 32));
        res.json({ ok: true, deleted: r.changes });
    });
    router.get('/agents/recent', async (req, res) => {
        const allowed = await db.prepare('SELECT history_agents_allowed FROM users WHERE id = ?').get(req.user.id);
        if (!allowed?.history_agents_allowed) return res.status(403).json({ error: 'not_allowed' });
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const rows = await db.prepare('SELECT * FROM user_history WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(req.user.id, limit);
        res.set('Cache-Control', 'no-store').json({ items: rows.map(rowOut) });
    });
    router.get('/find', async (req, res) => {
        const query = String(req.query.q || '').trim().slice(0, 120);
        if (!query) return res.status(400).json({ error: 'q is required' });
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const rows = await db.prepare("SELECT * FROM user_history WHERE user_id = ? AND updated_at >= (now() - interval '1 year')::text AND to_tsvector('simple', title) @@ plainto_tsquery('simple', ?) ORDER BY updated_at DESC, id DESC LIMIT ?").all(req.user.id, query, limit);
        res.set('Cache-Control', 'no-store').json({ query, items: rows.map(rowOut) });
    });
    router.get('/summary', async (req, res) => {
        const days = req.query.period === 'week' ? 7 : 1;
        const rows = await db.prepare(`SELECT type, title FROM user_history WHERE user_id = ? AND updated_at >= (now() - (? * interval '1 day'))::text ORDER BY updated_at DESC LIMIT 50`).all(req.user.id, days);
        const moments = rows.slice(0, 8).map(r => `${r.type} “${r.title}”`);
        const text = moments.length ? `Over the last ${days === 7 ? 'week' : 'day'}, you visited ${moments.join('; ')}.` : 'No recent history.';
        res.set('Cache-Control', 'no-store').json({ period: days === 7 ? 'week' : 'day', items: rows.map(r => ({ kind: r.type, title: r.title })), text });
    });

    router.delete('/:id', async (req, res) => {
        const r = await db.prepare('DELETE FROM user_history WHERE id = ? AND user_id = ?').run(parseInt(req.params.id, 10) || 0, req.user.id);
        if (!r.changes) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createHistoryRoutes, ensureSchema, allowedUrl, serviceFromUrl, SERVICE_LABELS, TYPES };
