'use strict';
/**
 * "X is live" fan-out, shared by the two ways a go-live reaches Network:
 *
 *   POST /internal/events/stream-live   Live's direct call (server/internal/routes.js), with the
 *                                       follower list in the body (follower_network_ids)
 *   live.stream.started via Events      server/notifications/events-consumer.js; the followers are
 *                                       read from Live with a service token (./live-followers.js)
 *
 * Both claim the same persisted per-streamer announcement window (stream_live_announcements, keyed
 * by the streamer's NETWORK user id), so while Live still makes the direct call and Network also
 * consumes the event, whichever arrives first announces and the other is skipped as `cooldown`.
 */

/** One fan-out per streamer per `stream_live_cooldown_min` (60) and at most `stream_live_daily_cap` (8) per 24h. */
function ensureAnnouncements(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS stream_live_announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, streamer_key TEXT NOT NULL, stream_id TEXT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS idx_sla_key ON stream_live_announcements(streamer_key, sent_at DESC)`);
}

function setting(db, key) {
    if (typeof db.getSetting === 'function') return db.getSetting(key);
    try { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; } catch { return null; }
}

/**
 * Claim the announcement for a streamer, or say why not. `force` (admin/manual) bypasses the
 * cooldown, never the daily cap. Returns { ok: true } or { skipped: true, reason, ... }.
 */
function claimAnnouncement(db, { streamerKey, streamId, force = false, now = Date.now() }) {
    try { ensureAnnouncements(db); } catch { /* exists */ }
    const key = String(streamerKey).toLowerCase();
    const cooldownMin = Math.max(1, parseInt(setting(db, 'stream_live_cooldown_min'), 10) || 60);
    const dailyCap = Math.max(1, parseInt(setting(db, 'stream_live_daily_cap'), 10) || 8);
    const last = db.prepare('SELECT sent_at FROM stream_live_announcements WHERE streamer_key = ? ORDER BY sent_at DESC, id DESC LIMIT 1').get(key);
    const today = db.prepare("SELECT COUNT(*) AS c FROM stream_live_announcements WHERE streamer_key = ? AND sent_at > datetime('now','-1 day')").get(key)?.c || 0;
    const lastMs = last ? new Date(String(last.sent_at).replace(' ', 'T') + 'Z').getTime() : 0;
    const sinceMin = last ? (now - lastMs) / 60000 : Infinity;
    if (today >= dailyCap) return { skipped: true, reason: 'daily-cap', announced_today: today, cap: dailyCap };
    if (!force && sinceMin < cooldownMin) return { skipped: true, reason: 'cooldown', next_allowed_at: new Date(lastMs + cooldownMin * 60000).toISOString() };
    db.prepare('INSERT INTO stream_live_announcements (streamer_key, stream_id) VALUES (?, ?)').run(key, streamId != null ? String(streamId) : null);
    db.prepare("DELETE FROM stream_live_announcements WHERE sent_at < datetime('now','-7 days')").run();
    return { ok: true };
}

/** People who asked for every go-live on the network (preference category stream_live_all). */
function allLiveSubscribers(db) {
    return db.prepare("SELECT user_id FROM notification_preferences WHERE category = 'stream_live_all' AND enabled = 1").all().map(r => r.user_id);
}

/** The STREAM_LIVE notification (category 'stream' from openvibe-shared, so the person's mute and email choice apply). */
function streamLiveNotification({ username, displayName, avatarUrl, senderId, stream, url }) {
    const name = displayName || username;
    const title = (stream && stream.title) || 'Started streaming';
    return {
        type: 'STREAM_LIVE',
        title: `${name} is live!`,
        message: title,
        icon: '🔴',
        sender_id: senderId || null,
        sender_name: name,
        sender_avatar: avatarUrl || null,
        service: 'live',
        url: url || `https://openvibe.live/${encodeURIComponent(username)}`,
        rich_content: {
            thumbnail: avatarUrl || null,
            context: {
                stream_id: stream ? stream.id : null,
                username,
                title,
                protocol: (stream && stream.protocol) || null,
                ...(stream && stream.event_id ? { event_id: stream.event_id } : {}),
            },
        },
    };
}

module.exports = { ensureAnnouncements, claimAnnouncement, allLiveSubscribers, streamLiveNotification };
