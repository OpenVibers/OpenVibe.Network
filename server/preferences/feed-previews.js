'use strict';

/**
 * The account-level Feed preview choice: `feed_previews: 'on' | 'wifi' | 'off'`, default 'on'.
 *
 * The shared menu (openvibe-shared ov-home.js watchPreview) reads it from GET /api/auth/me's
 * `preferences.feed_previews` (and the theme answer carries it too) and stops autoplaying a Feed preview on
 * 'off', or on a metered connection on 'wifi'. It is stored in user_preferences.site_prefs beside the labels
 * and the site switcher, so it follows the account to every site without a new column or migration.
 */
const VALUES = ['on', 'wifi', 'off'];
const DEFAULT = 'on';

async function rawPrefs(db, userId) {
    try {
        const row = await db.prepare('SELECT site_prefs FROM user_preferences WHERE user_id = ?').get(userId);
        if (!row || !row.site_prefs) return {};
        const parsed = JSON.parse(row.site_prefs);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
}

/** The person's choice, or 'on' when they never set one (a missing row, an old value, a broken JSON). */
async function read(db, userId) {
    const prefs = await rawPrefs(db, userId);
    return VALUES.includes(String(prefs.feed_previews)) ? String(prefs.feed_previews) : DEFAULT;
}

/** Set the choice, keeping every other site_prefs key. Returns the value stored. */
async function write(db, userId, value) {
    const next = String(value || '');
    if (!VALUES.includes(next)) throw Object.assign(new Error('feed_previews must be on, wifi or off'), { status: 400 });
    const current = await rawPrefs(db, userId);
    await db.prepare(`INSERT INTO user_preferences (user_id, site_prefs, updated_at) VALUES (?, ?, ov_now())
            ON CONFLICT(user_id) DO UPDATE SET site_prefs = excluded.site_prefs, updated_at = ov_now()`)
        .run(userId, JSON.stringify({ ...current, feed_previews: next }));
    return next;
}

module.exports = { read, write, VALUES, DEFAULT };
