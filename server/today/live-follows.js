'use strict';
/**
 * The people you follow who are live now: the "Now" row of your account home (/my, plan L43, 2026-10-31).
 *
 *   GET /api/v1/me/live-follows → { live: [{ username, name, title, viewers, thumbnail, avatar, url, since }],
 *                                   following, anyone_live }
 *
 * Follows are Network's (subjects); who is live is Live's public stream list, read from Live's internal address and
 * kept for ten seconds, so a hundred open account pages ask Live once. When Live does not answer, nobody is live:
 * the home leaves the row out rather than failing.
 */
const express = require('express');

const TTL_MS = 10_000;
const TIMEOUT_MS = 2_500;
const MAX = 12;
let held = { at: 0, streams: [] };
let pending = null;

/** Live's public list of live streams (ten seconds old at most), or [] when Live is away. */
async function liveStreams(liveUrl, { fetchImpl = fetch, now = Date.now } = {}) {
    if (held.at && now() - held.at < TTL_MS) return held.streams;
    if (pending) return pending;
    pending = (async () => {
        try {
            const r = await fetchImpl(`${liveUrl}/api/streams`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            const body = r.ok ? await r.json() : null;
            held = { at: now(), streams: Array.isArray(body && body.streams) ? body.streams : [] };
        } catch {
            held = { at: now(), streams: [] };
        } finally {
            pending = null;
        }
        return held.streams;
    })();
    return pending;
}

const text = (v, n) => String(v == null ? '' : v).slice(0, n);
const httpsUrl = (v) => (/^https:\/\/[^\s"'<>]+$/.test(String(v || '')) ? String(v) : null);

function router({ requireAuth, liveUrl, publicLive = 'https://openvibe.live', fetchImpl } = {}) {
    const r = express.Router();
    r.get('/', requireAuth, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        if (!req.user || req.user.is_anon) return res.json({ live: [], following: 0, anyone_live: 0 });
        const db = req.app.locals.db;
        const me = await db.prepare('SELECT subject_id FROM users WHERE id = ?').get(req.user.id);
        const follows = me && me.subject_id ? await db.prepare(`SELECT LOWER(u.username) AS username FROM user_follows f JOIN users u ON u.subject_id = f.target_id
            WHERE f.active = 1 AND f.follower_subject = ? AND f.target_type = 'channel'`).all(me.subject_id) : [];
        const followed = new Set(follows.map((f) => f.username));
        const streams = await liveStreams(liveUrl, { fetchImpl });
        const seen = new Set();
        const live = [];
        for (const s of streams) {
            const name = String(s && s.username || '').toLowerCase();
            if (!followed.has(name) || seen.has(name) || live.length >= MAX) continue;
            seen.add(name);
            live.push({
                username: text(s.username, 64),
                name: text(s.display_name || s.username, 80),
                title: text(s.ai_title || s.title, 140),
                viewers: Math.max(0, Number(s.total_viewer_count != null ? s.total_viewer_count : s.viewer_count) || 0),
                thumbnail: httpsUrl(s.thumbnail_url) || (String(s.thumbnail_url || '').startsWith('/') ? publicLive + s.thumbnail_url : null),
                avatar: httpsUrl(s.avatar_url),
                url: `${publicLive}/@${encodeURIComponent(String(s.username || ''))}`,
                since: text(s.started_at, 40) || null,
            });
        }
        res.json({ live, following: followed.size, anyone_live: new Set(streams.map((s) => String(s && s.username || '').toLowerCase())).size });
    });
    return r;
}

/** Tests: forget what Live said. */
function forget() { held = { at: 0, streams: [] }; pending = null; }

module.exports = { router, liveStreams, forget };
