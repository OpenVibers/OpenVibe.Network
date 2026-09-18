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

const MAX_PER_USER = 2000;          // oldest rows beyond this are trimmed on write
const DEDUPE_WINDOW_MIN = 10;       // same URL within this window bumps the entry instead of adding one
const TYPES = new Set(['tool', 'stream', 'vod', 'clip', 'paste', 'game', 'page', 'post', 'account', 'theme', 'download', 'chat']);
const SERVICE_LABELS = {
    live: 'Live', tools: 'Tools', games: 'Games', media: 'Media', network: 'Network', community: 'Community',
    chat: 'Chat', codes: 'Codes', blog: 'Blog', wiki: 'Wiki', news: 'News', reviews: 'Reviews', tips: 'Tips',
    vip: 'VIP', trade: 'Trade', host: 'Host', deals: 'Deals', coupons: 'Coupons', openre: 'OpenRe.Stream',
};

function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            service TEXT,
            sub TEXT,
            type TEXT NOT NULL DEFAULT 'page',
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            icon TEXT,
            meta TEXT,
            hits INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_history_user_time ON user_history(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_user_history_user_url ON user_history(user_id, url);
    `);
    const cols = db.prepare('PRAGMA table_info(users)').all();
    if (!cols.find(c => c.name === 'history_paused')) {
        try { db.exec('ALTER TABLE users ADD COLUMN history_paused INTEGER DEFAULT 0'); } catch { /* exists */ }
    }
}

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

function rowOut(r) {
    let meta = null;
    try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { meta = null; }
    return {
        id: r.id, type: r.type, title: r.title, url: r.url, icon: r.icon, service: r.service, sub: r.sub,
        service_label: r.sub ? `${r.sub}.${SERVICE_LABELS[r.service] || r.service || ''}` : (SERVICE_LABELS[r.service] || r.service || null),
        meta, hits: r.hits, created_at: r.created_at, updated_at: r.updated_at,
    };
}

function createHistoryRoutes(db, requireAuth) {
    ensureSchema(db);
    const router = express.Router();
    router.use(requireAuth);

    // Anonymous sessions have no history: nothing to read, nothing recorded.
    router.use((req, res, next) => {
        if (req.user?.is_anon) return res.status(403).json({ error: 'History is only kept for signed-in accounts' });
        next();
    });

    router.get('/', (req, res) => {
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const where = ['user_id = ?']; const params = [req.user.id];
        if (req.query.service) { where.push('service = ?'); params.push(String(req.query.service).slice(0, 32)); }
        if (req.query.type) { where.push('type = ?'); params.push(String(req.query.type).slice(0, 32)); }
        if (req.query.q) { where.push('(title LIKE ? OR url LIKE ?)'); const q = `%${String(req.query.q).slice(0, 80)}%`; params.push(q, q); }
        const rows = db.prepare(`SELECT * FROM user_history WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
        const total = db.prepare(`SELECT COUNT(*) AS c FROM user_history WHERE ${where.join(' AND ')}`).get(...params)?.c || 0;
        const paused = !!db.prepare('SELECT history_paused FROM users WHERE id = ?').get(req.user.id)?.history_paused;
        const services = db.prepare('SELECT service, COUNT(*) AS c FROM user_history WHERE user_id = ? GROUP BY service ORDER BY c DESC').all(req.user.id)
            .map(r => ({ service: r.service, label: SERVICE_LABELS[r.service] || r.service, count: r.c }));
        res.set('Cache-Control', 'no-store');
        res.json({ items: rows.map(rowOut), total, paused, services });
    });

    router.post('/', (req, res) => {
        const u = db.prepare('SELECT history_paused FROM users WHERE id = ?').get(req.user.id);
        if (u?.history_paused) return res.json({ ok: true, paused: true });
        const url = allowedUrl(req.body?.url);
        if (!url) return res.status(400).json({ error: 'A URL on the OpenVibe network is required' });
        const type = TYPES.has(String(req.body?.type)) ? String(req.body.type) : 'page';
        const title = String(req.body?.title || '').trim().slice(0, 200) || url;
        const TYPE_ICONS = { tool: 'fa-screwdriver-wrench', stream: 'fa-tower-broadcast', vod: 'fa-clapperboard', clip: 'fa-scissors', paste: 'fa-paste', game: 'fa-gamepad', page: 'fa-file-lines', post: 'fa-comments', account: 'fa-user', theme: 'fa-palette', download: 'fa-download', chat: 'fa-comment' };
        const icon = /^fa-[a-z0-9-]{1,40}$/.test(String(req.body?.icon || '')) ? String(req.body.icon) : (TYPE_ICONS[type] || null);
        const inf = serviceFromUrl(url);
        const service = String(req.body?.service || inf.service || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || null;
        const sub = String(req.body?.sub || inf.sub || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48) || null;
        let meta = null;
        if (req.body?.meta && typeof req.body.meta === 'object') {
            const s = JSON.stringify(req.body.meta);
            if (s.length <= 1000) meta = s;
        }
        const recent = db.prepare(`SELECT id FROM user_history WHERE user_id = ? AND url = ? AND updated_at > datetime('now', '-${DEDUPE_WINDOW_MIN} minutes')`).get(req.user.id, url);
        if (recent) {
            db.prepare('UPDATE user_history SET hits = hits + 1, title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, recent.id);
            return res.json({ ok: true, id: recent.id, merged: true });
        }
        const r = db.prepare('INSERT INTO user_history (user_id, service, sub, type, title, url, icon, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(req.user.id, service, sub, type, title, url, icon, meta);
        // Trim: keep the newest MAX_PER_USER rows.
        db.prepare(`DELETE FROM user_history WHERE user_id = ? AND id NOT IN (SELECT id FROM user_history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ${MAX_PER_USER})`).run(req.user.id, req.user.id);
        res.status(201).json({ ok: true, id: r.lastInsertRowid });
    });

    router.put('/settings', (req, res) => {
        const paused = req.body?.paused ? 1 : 0;
        db.prepare('UPDATE users SET history_paused = ? WHERE id = ?').run(paused, req.user.id);
        res.json({ ok: true, paused: !!paused });
    });

    router.delete('/', (req, res) => {
        const r = db.prepare('DELETE FROM user_history WHERE user_id = ?').run(req.user.id);
        res.json({ ok: true, deleted: r.changes });
    });

    router.delete('/:id', (req, res) => {
        const r = db.prepare('DELETE FROM user_history WHERE id = ? AND user_id = ?').run(parseInt(req.params.id, 10) || 0, req.user.id);
        if (!r.changes) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createHistoryRoutes, ensureSchema, allowedUrl, serviceFromUrl, SERVICE_LABELS, TYPES };
