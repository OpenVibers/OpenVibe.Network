'use strict';
/**
 * FOLLOW notifications from Network's own follow graph (roadmap WS-E task 3, ADR-020, ADR-030). A follow that
 * starts, made on any site, through the API or by Live's write-through (network.follows.write), tells the
 * followed person once: setFollow calls this inside its transaction (server/identity/follows.js setNotifier).
 * Live stopped pushing its own FOLLOW notification for follows Network took; it still pushes one for a follow
 * that stays Live-only (FOLLOWS_AUTHORITY unset, or a side with no Network subject).
 *
 * The notification service applies the recipient's social preference, their blocks (actor_subject) and the
 * one-an-hour dedupe per sender. The link is the follower's channel, as Live's was.
 */
const { channelUrl } = require('./stream-live');

function followNotifier(notifications) {
    return async (db, { follower, type, target }) => {
        if (type !== 'channel') return null;
        const who = db.prepare('SELECT id, username, display_name, avatar_url, is_anon FROM users WHERE subject_id = ?');
        const f = await who.get(follower);
        const t = await who.get(target);
        if (!f || !t || t.is_anon) return null;
        const name = f.display_name || f.username || 'Someone';
        return await notifications.create({
            user_id: t.id, type: 'FOLLOW', title: 'New Follower', message: `${name} followed you`,
            url: f.username ? channelUrl(f.username) : 'https://openvibe.live/', service: 'live',
            sender_id: f.id, sender_name: name, sender_avatar: f.avatar_url || null, actor_subject: follower,
        });
    };
}

module.exports = { followNotifier };
