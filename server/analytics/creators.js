'use strict';
/**
 * Creator analytics (roadmap WS-E task 6; Contracts 0.68.0 live.stream.ended `stats`,
 * network.creator-analytics-result@1, network.analytics.creator.read).
 *
 * Built from events, not from Live's tables: every live.stream.ended (Network's Events consumer,
 * server/notifications/events-consumer.js) becomes one creator_streams row, keyed by the stream id, so a
 * redelivery replaces rather than adds. Only counts are kept, per stream and per creator subject: never who
 * watched or chatted, no IP address, no viewer or chatter id (ADR-021; test/creator-analytics.test.js checks
 * the columns). Rows older than 400 days are pruned.
 *
 *   GET /api/v1/creators/:creator/analytics?days=1-365   (:creator = usr_ subject or username)
 *       everyone: streams, stream seconds and peak viewers, daily and per stream (the last 100)
 *       the creator (signed in), or a service with network.analytics.creator.read (Live's dashboards):
 *       also average viewers, unique chatters, messages and watch minutes (`full: true`)
 */
const express = require('express');
const { http } = require('openvibe-contracts');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const KEEP_DAYS = 400;
const COLUMNS = ['stream_id', 'creator_subject', 'title', 'category', 'started_at', 'ended_at', 'duration_seconds',
    'peak_viewers', 'avg_viewers', 'unique_chatters', 'messages', 'watch_minutes', 'received_at'];

function ensureSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS creator_streams (
        stream_id        INTEGER PRIMARY KEY,
        creator_subject  TEXT NOT NULL,
        title            TEXT,
        category         TEXT,
        started_at       TEXT NOT NULL,
        ended_at         TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        peak_viewers     INTEGER,
        avg_viewers      REAL,
        unique_chatters  INTEGER,
        messages         INTEGER,
        watch_minutes    INTEGER,
        received_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_creator_streams_creator ON creator_streams(creator_subject, started_at);`);
}

const int = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);

/** One live.stream.ended envelope → 'analytics:recorded' | 'ignored:<why>'. Inside the consumer's inbox claim. */
function record(db, event, { now = new Date().toISOString() } = {}) {
    ensureSchema(db);
    if (event.source !== 'live') return 'ignored:source';
    const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const creator = p.channel && p.channel.subject && p.channel.subject.id;
    const streamId = Number(p.stream_id);
    if (!SUBJECT_RE.test(String(creator || '')) || !Number.isSafeInteger(streamId) || streamId < 1) return 'ignored:payload';
    const started = Date.parse(p.started_at); const ended = Date.parse(p.ended_at);
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return 'ignored:times';
    const s = p.stats && typeof p.stats === 'object' ? p.stats : {};
    db.prepare(`INSERT INTO creator_streams (stream_id, creator_subject, title, category, started_at, ended_at, duration_seconds, peak_viewers, avg_viewers, unique_chatters, messages, watch_minutes, received_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(stream_id) DO UPDATE SET creator_subject = excluded.creator_subject, title = excluded.title, category = excluded.category,
                    started_at = excluded.started_at, ended_at = excluded.ended_at, duration_seconds = excluded.duration_seconds,
                    peak_viewers = excluded.peak_viewers, avg_viewers = excluded.avg_viewers, unique_chatters = excluded.unique_chatters,
                    messages = excluded.messages, watch_minutes = excluded.watch_minutes, received_at = excluded.received_at`)
        .run(streamId, creator, p.title == null ? null : String(p.title).slice(0, 300), p.category == null ? null : String(p.category).slice(0, 100),
            new Date(started).toISOString(), new Date(ended).toISOString(), int(p.duration_seconds) ?? Math.round((ended - started) / 1000),
            int(s.peak_viewers), Number.isFinite(Number(s.avg_viewers)) && Number(s.avg_viewers) >= 0 ? Math.round(Number(s.avg_viewers) * 10) / 10 : null,
            int(s.unique_chatters), int(s.messages), int(s.watch_minutes), now);
    db.prepare('DELETE FROM creator_streams WHERE ended_at < ?').run(new Date(Date.parse(now) - KEEP_DAYS * 86400000).toISOString());
    return 'analytics:recorded';
}

/** network.creator-analytics-result@1 for a creator over `days`; `full` adds the audience figures. */
function query(db, creator, { days = 30, full = false, now = Date.now() } = {}) {
    ensureSchema(db);
    const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    const since = new Date(now - d * 86400000).toISOString();
    const rows = db.prepare('SELECT * FROM creator_streams WHERE creator_subject = ? AND started_at >= ? ORDER BY started_at DESC').all(creator, since);
    const pick = (r) => {
        const o = { stream_id: r.stream_id, title: r.title, category: r.category, started_at: r.started_at, ended_at: r.ended_at, duration_seconds: r.duration_seconds };
        if (r.peak_viewers != null) o.peak_viewers = r.peak_viewers;
        if (full) for (const k of ['avg_viewers', 'unique_chatters', 'messages', 'watch_minutes']) if (r[k] != null) o[k] = r[k];
        return o;
    };
    const add = (acc, r) => {
        acc.streams += 1; acc.stream_seconds += r.duration_seconds || 0; acc.peak_viewers = Math.max(acc.peak_viewers, r.peak_viewers || 0);
        if (full) {
            acc.unique_chatters += r.unique_chatters || 0; acc.messages += r.messages || 0; acc.watch_minutes += r.watch_minutes || 0;
            acc._avgWeighted += (r.avg_viewers || 0) * (r.duration_seconds || 0);
        }
        return acc;
    };
    const blank = () => ({ streams: 0, stream_seconds: 0, peak_viewers: 0, ...(full ? { unique_chatters: 0, messages: 0, watch_minutes: 0, _avgWeighted: 0 } : {}) });
    const finish = (acc) => {
        if (full) { acc.avg_viewers = acc.stream_seconds ? Math.round((acc._avgWeighted / acc.stream_seconds) * 10) / 10 : 0; delete acc._avgWeighted; }
        return acc;
    };
    const totals = finish(rows.reduce(add, blank()));
    const byDay = new Map();
    for (const r of rows) {
        const day = r.started_at.slice(0, 10);
        byDay.set(day, add(byDay.get(day) || blank(), r));
    }
    const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, acc]) => ({ day, ...finish(acc) }));
    return { creator, days: d, full: !!full, totals, daily, streams: rows.slice(0, 100).map(pick) };
}

function viewerOf(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.cookies && req.cookies.ov_token);
    if (!token) return null;
    try {
        const out = require('../auth/session').verifySession(token, { db: req.app.locals.db, publicKey: req.app.locals.publicKey, config: req.app.locals.config });
        return out && out.user ? out.user : null;
    } catch { return null; }
}

/** Routes; fullGuard = principals.guard('network.analytics.creator.read', { legacy: false }). */
function router({ fullGuard }) {
    const r = express.Router();
    r.use(http.middleware());
    r.get('/:creator/analytics', (req, res) => {
        const db = req.app.locals.db;
        const key = String(req.params.creator || '');
        const u = SUBJECT_RE.test(key) ? db.prepare('SELECT subject_id, is_anon FROM users WHERE subject_id = ?').get(key)
            : NAME_RE.test(key) ? db.prepare('SELECT subject_id, is_anon FROM users WHERE username = ? COLLATE NOCASE').get(key) : null;
        if (!u || u.is_anon || !SUBJECT_RE.test(String(u.subject_id || ''))) return http.sendProblem(res, 404, 'analytics.unknown_creator', { detail: 'no such creator', ctx: req.ov });
        const answer = (full) => res.set('Cache-Control', full ? 'private, no-store' : 'public, max-age=60').json(query(db, u.subject_id, { days: req.query.days, full }));
        const viewer = viewerOf(req);
        if (viewer) return answer(viewer.subject_id === u.subject_id);
        const h = String(req.headers.authorization || '');
        if (h.startsWith('Bearer ')) return fullGuard(req, res, () => answer(true));   // a service token: full, or refused
        return answer(false);
    });
    return r;
}

module.exports = { ensureSchema, record, query, router, COLUMNS, KEEP_DAYS };
