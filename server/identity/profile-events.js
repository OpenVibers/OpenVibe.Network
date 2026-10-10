'use strict';
/**
 * network.user.updated (Contracts 0.43.0; roadmap WS-B task 2): a person's whole current profile after every
 * change other services may know about: username, display name, picture, colour, role or ban.
 *
 * No write path has to remember it. PostgreSQL triggers on `users` record each change in user_profile_changes
 * within the change's own transaction, so a rename, a role grant, a ban or a profile edit from anywhere
 * (admin routes, the API, an import, a hand-run SQL) is never missed. drain() turns those rows into events:
 * per person, it raises users.profile_revision by one, builds the payload from the row as it is now, puts
 * the envelope in network_event_outbox (relayed to OpenVibe.Events by server/developer/event-relay.js) and
 * deletes the rows, all in one transaction. Several quick changes to one person become one event naming
 * everything that changed. A new account ('created') is announced once it has its subject id, and the
 * first boot with this module announces every existing account once.
 *
 * Anonymous (guest) accounts are never announced. Roles outside the staff map's four are sent as 'user'.
 */
const { ids, validate } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');

const EVENT_TYPE = 'network.user.updated';
const ROLES = ['user', 'streamer', 'global_mod', 'admin'];
const FIELDS = ['username', 'display_name', 'avatar_url', 'profile_color', 'role', 'is_banned'];
const NAME = { is_banned: 'banned' };

/**
 * The table and the two users triggers are migrations/NNNN_*.sql (plan T2). What is left is the data
 * work: an account nothing has recorded yet — one the import brought in, or one from before this module
 * existed — is announced once ('created'), so consumers can build their projection of everyone, not only
 * of people who change something later. Idempotent: once announced, the row exists and profile_revision
 * has moved.
 */
async function ensureSchema(db) {
    await db.prepare(`INSERT INTO user_profile_changes (user_id, changed, at)
        SELECT u.id, 'created', ? FROM users u
        WHERE COALESCE(u.is_anon, 0) = 0 AND COALESCE(u.profile_revision, 0) = 0
          AND NOT EXISTS (SELECT 1 FROM user_profile_changes c WHERE c.user_id = u.id)`).run(Date.now());
    eventRelay.writerFor(db);
}

/** The payload for one users row (its current state). */
function payloadOf(u, revision, changed) {
    return {
        subject: { type: 'user', id: u.subject_id }, network_user_id: u.id, revision,
        username: String(u.username).slice(0, 64), display_name: u.display_name ? String(u.display_name).slice(0, 120) : null,
        avatar_url: u.avatar_url ? String(u.avatar_url).slice(0, 500) : null, profile_color: u.profile_color ? String(u.profile_color).slice(0, 32) : null,
        role: ROLES.includes(u.role) ? u.role : 'user', banned: !!u.is_banned, changed,
    };
}

/** Turn recorded changes into events. → how many events were queued */
async function drain(db, { limit = 500 } = {}) {
    const rows = await db.prepare('SELECT id, user_id, changed FROM user_profile_changes ORDER BY id LIMIT ?').all(limit);
    if (!rows.length) return 0;
    const byUser = new Map();
    for (const r of rows) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r); }
    let queued = 0;
    for (const [userId, list] of byUser) {
        await db.tx(async () => {
            const del = db.prepare('DELETE FROM user_profile_changes WHERE id = ?');
            const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
            // A deleted, guest or not-yet-subject account: nothing to announce (a subject assignment is an update
            // of subject_id, which the created event waits for below).
            if (!u || u.is_anon || !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(u.subject_id || ''))) {
                if (!u || u.is_anon) for (const r of list) await del.run(r.id);
                return;
            }
            const changed = [...new Set(list.flatMap((r) => r.changed.split(' ').filter(Boolean)))];
            const revision = (Number(u.profile_revision) || 0) + 1;
            await db.prepare('UPDATE users SET profile_revision = ? WHERE id = ?').run(revision, u.id);
            const ms = Date.now();
            const env = {
                event_id: ids.newId('event', ms), event_type: EVENT_TYPE, version: 1, source: 'network',
                actor: { type: 'system', id: 'network' }, timestamp: new Date(ms).toISOString(), visibility: 'internal',
                subject: { type: 'user', id: u.subject_id, revision }, payload: payloadOf(u, revision, changed),
            };
            const v = validate('events.event-envelope@1', env);
            const pv = validate('network.user.updated@1', env.payload);
            if (!v.valid || !pv.valid) throw new Error(`profile-events: bad event for user ${u.id}: ${JSON.stringify((v.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
            await eventRelay.writerFor(db).enqueue(env);
            for (const r of list) await del.run(r.id);
            queued++;
        });
    }
    if (queued) { const live = eventRelay.outboxFor(db); if (live) live.kick(); }
    return queued;
}

let timer = null;
async function start(db, { intervalMs = 3000, log = console } = {}) {
    if (timer) return;
    await ensureSchema(db);
    timer = setInterval(async () => { try { await drain(db); } catch (err) { log.warn && log.warn('[Profile events]', err.message); } }, intervalMs);
    if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { EVENT_TYPE, ensureSchema, drain, start, stop, payloadOf };
