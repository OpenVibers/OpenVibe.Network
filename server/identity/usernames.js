'use strict';
/**
 * Username history (roadmap WS-B task 6, D01).
 *
 * Usernames are chosen at registration and, since 2026-09-24, can be changed only by staff (admin →
 * Users → Rename). Every rename is kept in username_history, so:
 *   - openvibe.live answers /@old with a 301 to /@new for renamed channels (never for a bare /old,
 *     which stays a 404: channel URLs are /@username only);
 *   - GET /api/v1/users/renamed/:name tells any site the current name for an old one;
 *   - an old name stays reserved for RESERVE_DAYS, so nobody can take it over and inherit the
 *     person's links, mentions and reputation. Only the person who held it may take it back.
 */

const NAME_RE = /^[A-Za-z0-9_]{3,24}$/;
const RESERVE_DAYS = 180;
const SYSTEM_NAMES = new Set(['live', 'system', 'openvibelivebot']);

function ensureSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS username_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        old_username TEXT NOT NULL,
        new_username TEXT NOT NULL,
        changed_by   INTEGER,
        changed_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_username_history_old ON username_history(old_username COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_username_history_user ON username_history(user_id);`);
}

/** Whether `name` is an old username someone other than `exceptUserId` gave up within RESERVE_DAYS. */
function isReserved(db, name, exceptUserId = null) {
    ensureSchema(db);
    const row = db.prepare(`SELECT user_id FROM username_history WHERE old_username = ? COLLATE NOCASE
        AND changed_at > datetime('now', ?) ORDER BY id DESC LIMIT 1`).get(String(name), `-${RESERVE_DAYS} days`);
    return Boolean(row && row.user_id !== exceptUserId);
}

/** Why `name` cannot be used, or null. */
function problemWith(db, name, userId = null) {
    if (!NAME_RE.test(name)) return 'Usernames are 3-24 letters, numbers and underscores';
    if (/^anon/i.test(name)) return 'Usernames cannot start with "anon"';
    if (SYSTEM_NAMES.has(name.toLowerCase())) return 'That name is reserved by the system';
    const taken = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(name);
    if (taken && taken.id !== userId) return 'That username is taken';
    if (isReserved(db, name, userId)) return `That name belonged to someone else in the last ${RESERVE_DAYS} days`;
    return null;
}

/**
 * Rename a user. A display name that was just the old username (any capitalisation) follows it.
 * @returns {{ from: string, to: string }}
 */
function rename(db, userId, newName, { actorId = null } = {}) {
    ensureSchema(db);
    const to = String(newName || '').trim();
    return db.transaction(() => {
        const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(userId);
        if (!user) throw Object.assign(new Error('No such user'), { status: 404 });
        if (to === user.username) throw Object.assign(new Error('That is already the username'), { status: 400 });
        const problem = problemWith(db, to, user.id);
        if (problem) throw Object.assign(new Error(problem), { status: 409 });
        db.prepare('INSERT INTO username_history (user_id, old_username, new_username, changed_by) VALUES (?, ?, ?, ?)').run(user.id, user.username, to, actorId);
        const followDisplay = !user.display_name || user.display_name.toLowerCase() === user.username.toLowerCase();
        db.prepare(`UPDATE users SET username = ?${followDisplay ? ', display_name = ?' : ''}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(...(followDisplay ? [to, to, user.id] : [to, user.id]));
        return { from: user.username, to };
    })();
}

/** The current username for an old one, or null (never for a name that is someone's current name). */
function renamedTo(db, oldName) {
    ensureSchema(db);
    if (!NAME_RE.test(String(oldName || ''))) return null;
    if (db.prepare('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)').get(oldName)) return null;
    const row = db.prepare(`SELECT u.username FROM username_history h JOIN users u ON u.id = h.user_id
        WHERE h.old_username = ? COLLATE NOCASE ORDER BY h.id DESC LIMIT 1`).get(oldName);
    return row ? row.username : null;
}

/** A user's past usernames, newest first. */
function historyOf(db, userId) {
    ensureSchema(db);
    return db.prepare('SELECT old_username, new_username, changed_at FROM username_history WHERE user_id = ? ORDER BY id DESC').all(userId);
}

module.exports = { ensureSchema, isReserved, problemWith, rename, renamedTo, historyOf, RESERVE_DAYS, NAME_RE };
