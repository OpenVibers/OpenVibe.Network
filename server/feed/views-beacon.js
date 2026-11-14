'use strict';
/**
 * POST /api/v1/feed/views — the feed's cards a person actually saw, counted as views (plan §AA.36, §AC.5: "add view count
 * to this feed and everything in the feed … so you can see analytics … like Twitter does").
 *
 *   body { ids: ["f:<service>:<type>:<id>", …], session? }   up to 20 card ids, as the feed gave them
 *   → 202 { sent }   (a beacon: always 202 for well-formed input; what Media counted is its business)
 *
 * The card id already names its source, so nothing is looked up here: each id becomes one `preview` view in
 * OpenVibe.Media's one view store (POST /api/v1/views, at its internal address), the same store every card's
 * counts.views is read from. Media drops bots and repeats inside its window and stores no IP or user agent; the
 * optional `session` (the page's own random id) is passed so one person scrolling past twice counts once.
 * Browsers send it with navigator.sendBeacon (text/plain is accepted for that).
 */
const config = require('../config');

const ID_RE = /^f:([a-z][a-z0-9-]{1,39}):([a-z][a-z0-9_]{1,39}):([A-Za-z0-9_.:-]{1,80})$/;
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_IDS = 20;

function mediaUrl() {
    const s = config.services && config.services.media;
    return String((s && s.internalUrl) || 'http://127.0.0.1:4100').replace(/\/+$/, '');
}

/** The views one body names, or null when it names none. */
function viewsOf(body) {
    let b = body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return null; } }
    if (!b || typeof b !== 'object' || !Array.isArray(b.ids)) return null;
    const session = typeof b.session === 'string' && SESSION_RE.test(b.session) ? b.session : undefined;
    const seen = new Set();
    const events = [];
    for (const raw of b.ids.slice(0, MAX_IDS)) {
        const m = ID_RE.exec(String(raw || ''));
        if (!m || seen.has(m[0])) continue;
        seen.add(m[0]);
        events.push({ ref: { service: m[1], kind: m[2], id: m[3], site: m[1] }, how: 'preview', seconds: 1, ...(session ? { session } : {}) });
    }
    return events.length ? events : null;
}

function handler({ fetchImpl = globalThis.fetch } = {}) {
    return async (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        const events = viewsOf(req.body);
        if (!events) return res.status(400).json({ error: 'ids must be feed card ids', code: 'feed.seen_ids' });
        res.status(202).json({ sent: events.length });
        try {
            await fetchImpl(`${mediaUrl()}/api/v1/views`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }),
                redirect: 'error', signal: AbortSignal.timeout(3000),
            });
        } catch { /* a beacon: a Media outage loses these views, never the page */ }
    };
}

module.exports = { handler, viewsOf, ID_RE };
