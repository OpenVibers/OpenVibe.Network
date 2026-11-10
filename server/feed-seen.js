'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ids, validate } = require('openvibe-contracts');
const eventRelay = require('./developer/event-relay');
const subjects = require('./identity/subjects');

const EVENT_TYPE = 'network.feed.seen';

function envelope(subject, at) {
    const ms = Date.parse(at);
    const env = {
        event_id: ids.newId('event', ms), event_type: EVENT_TYPE, version: 1, source: 'network',
        actor: { type: 'user', id: subject }, timestamp: new Date(ms).toISOString(), visibility: 'subject',
        subject: { type: 'user', id: subject }, payload: { seen_at: new Date(ms).toISOString() },
    };
    const v = validate('events.event-envelope@1', env);
    if (!v.valid) throw new Error(`feed-seen: invalid event envelope: ${(v.errors || []).map(e => e.message).join('; ')}`);
    return env;
}

function router({ requireAuth }) {
    const r = express.Router();
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    r.use(requireAuth);
    r.use(rateLimit({ windowMs: 60_000, max: 60, keyGenerator: (req) => String(req.user?.id || req.ip) }));
    r.get('/', async (req, res) => {
        const row = await req.app.locals.db.prepare('SELECT feed_seen_at FROM user_preferences WHERE user_id = ?').get(req.user.id);
        res.json({ seen_at: row?.feed_seen_at ? new Date(row.feed_seen_at).toISOString() : null });
    });
    r.put('/', async (req, res) => {
        const db = req.app.locals.db;
        const at = new Date().toISOString();
        const subject = await subjects.ensureUserSubject(db, req.user);
        await db.tx(async () => {
            await db.prepare(`INSERT INTO user_preferences (user_id, feed_seen_at, updated_at) VALUES (?, ?, ov_now())
                ON CONFLICT (user_id) DO UPDATE SET feed_seen_at = EXCLUDED.feed_seen_at, updated_at = ov_now()`)
                .run(req.user.id, at);
            await eventRelay.writerFor(db).enqueue(envelope(subject, at), { traceparent: req.headers.traceparent || null });
        });
        const live = eventRelay.outboxFor(db); if (live) live.kick();
        res.json({ seen_at: at });
    });
    return r;
}

module.exports = { router, envelope, EVENT_TYPE };
