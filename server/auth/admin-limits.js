'use strict';

// ═══════════════════════════════════════════════════════════════
// Admin action rate limits.
//
// Admins run the network day-to-day but some actions are abusable at volume
// (mass notifications, etc.). Those get a per-admin cooldown. The OWNER is
// always exempt. Add a new limit by dropping one entry in ADMIN_LIMITS and
// calling checkAdminLimit()/recordAdminAction() around the action.
// ═══════════════════════════════════════════════════════════════

const { isOwner } = require('./owner-guard');

const HOUR = 60 * 60 * 1000;

// action key -> cooldown window (ms). One successful action per window per admin.
const ADMIN_LIMITS = {
    broadcast: 6 * HOUR,   // global notification to all users
};

let _ensured = false;
function ensureTable(db) {
    if (_ensured) return;
    db.exec(`CREATE TABLE IF NOT EXISTS admin_rate_limits (
        user_id INTEGER NOT NULL,
        action  TEXT    NOT NULL,
        last_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, action)
    )`);
    _ensured = true;
}

function humanizeMs(ms) {
    const mins = Math.ceil(ms / 60000);
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `${hrs}h ${rem}m` : `${hrs} hour${hrs === 1 ? '' : 's'}`;
}

// Check (without consuming) whether `user` may perform `action` now.
// Returns { ok:true } or { ok:false, retryMs, retryHuman }. Owners always ok.
function checkAdminLimit(db, user, action) {
    if (isOwner(user)) return { ok: true };
    const windowMs = ADMIN_LIMITS[action];
    if (!windowMs) return { ok: true };
    ensureTable(db);
    const row = db.prepare('SELECT last_at FROM admin_rate_limits WHERE user_id = ? AND action = ?').get(user.id, action);
    if (row && row.last_at) {
        const elapsed = Date.now() - row.last_at;
        if (elapsed < windowMs) {
            const retryMs = windowMs - elapsed;
            return { ok: false, retryMs, retryHuman: humanizeMs(retryMs) };
        }
    }
    return { ok: true };
}

// Start the cooldown after a successful action. No-op for owners / unlimited actions.
function recordAdminAction(db, user, action) {
    if (isOwner(user)) return;
    if (!ADMIN_LIMITS[action]) return;
    ensureTable(db);
    db.prepare(`INSERT INTO admin_rate_limits (user_id, action, last_at) VALUES (?, ?, ?)
                ON CONFLICT(user_id, action) DO UPDATE SET last_at = excluded.last_at`)
        .run(user.id, action, Date.now());
}

module.exports = { ADMIN_LIMITS, checkAdminLimit, recordAdminAction, humanizeMs };
