'use strict';
/** Public menu day counts from Report's /api/v1/stats. Report currently has daily new accounts;
 * unsupported daily stream, post and video counts stay null until Report publishes them. */
const express = require('express');

const DAY = 86_400_000;
const TTL = 5 * 60_000;
const count = (v) => Number.isSafeInteger(Number(v)) && Number(v) >= 0 && v != null ? Number(v) : null;

function createToday({ reportUrl, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    let cached = null, at = 0, inflight = null;
    async function read() {
        const base = String(reportUrl || 'http://127.0.0.1:5080').replace(/\/$/, '');
        const get = async (days) => {
            const r = await fetchImpl(`${base}/api/v1/stats?days=${days}`, { signal: AbortSignal.timeout(5000) });
            return r.ok ? await r.json() : null;
        };
        // Report normalises all windows except 7, 30 and 90 days to 30; use its 30-day series and select 14 dates.
        const fourteen = await get(30).catch(() => null);
        const today = new Date(now()).toISOString().slice(0, 10);
        const people = new Map((fourteen && fourteen.accounts && fourteen.accounts.daily || []).map((x) => [x.day, count(x.n)]));
        const activity = new Map((fourteen && fourteen.activity_daily || []).map((x) => [x.day, x]));
        const series = Array.from({ length: 14 }, (_, i) => {
            const day = new Date(Date.parse(`${today}T00:00:00Z`) - (13 - i) * DAY).toISOString().slice(0, 10);
            const a = activity.get(day) || {};
            return { day, people: people.get(day) ?? null, streams: count(a.streams), posts: count(a.posts), new_videos: count(a.new_videos) };
        });
        const a = activity.get(today) || {};
        return { day: today, people_today: series[13].people,
            streams_today: count(a.streams),
            posts_today: count(a.posts), new_videos_today: count(a.new_videos), series, updated_at: new Date(now()).toISOString() };
    }
    async function get() {
        if (cached && now() - at < TTL) return cached;
        inflight = inflight || read().then((value) => { cached = value; at = now(); return value; }).finally(() => { inflight = null; });
        return await inflight;
    }
    const router = express.Router();
    router.get('/', async (_req, res) => {
        try {
            const value = await get();
            res.set({ 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*',
                'Cross-Origin-Resource-Policy': 'cross-origin' }).json(value);
        } catch (err) {
            console.error('[FrameToday] read:', err);
            res.status(503).json({ error: 'frame.today_unavailable' });
        }
    });
    return { router, get };
}

module.exports = { createToday };
