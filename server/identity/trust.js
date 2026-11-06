'use strict';
/**
 * Plan E5: the trust facts OpenVibe.AI needs to scale the free allowance, on the existing identity read.
 *
 *   GET /internal/identity/resolve?subject_id=usr_…&trust=1
 *
 * The usual projection plus `trust`:
 *
 *   account_age_hours   how long the account has existed
 *   account_age_days    the same, whole days
 *   passkey             a Locker passkey backup exists (server/locker/keys.js, kind 'passkey')
 *   linked_accounts     how many site accounts are linked (never which ones)
 *   active_30d          the account is at least 30 days old and was seen in the last 30 days
 *   verified            passkey, a linked account, or 30 days with activity
 *   verified_by         the facts behind `verified`
 *
 * Nothing private leaves: no email, no service user ids, no last-seen timestamp. A service reads this only with
 * identity.subject.resolve, and only when it asks (`trust=1`); the normal projection stays as cheap as it was.
 */
const { createdMs } = require('./subjects');

const DAY = 86_400_000;

function count(row) {
    const n = Number(row && row.n);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * trustSignals(db, subjectId, { now }): the facts for one person, or null when the subject is not a live user.
 * `now` is injectable so a test can age an account without waiting.
 */
async function trustSignals(db, subjectId, { now = Date.now() } = {}) {
    if (typeof subjectId !== 'string' || !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subjectId)) return null;
    const user = await db.prepare('SELECT id, subject_id, created_at, last_seen, email_verified, deleted_at FROM users WHERE subject_id = ?').get(subjectId);
    if (!user || user.deleted_at) return null;
    const born = createdMs(user.created_at);
    const ageMs = Math.max(0, now - born);
    const linked = await db.prepare('SELECT COUNT(*) AS n FROM linked_accounts WHERE user_id = ?').get(user.id);
    const passkey = await db.prepare("SELECT 1 AS ok FROM locker_key_backups WHERE subject = ? AND kind = 'passkey' LIMIT 1").get(subjectId);
    const seen = user.last_seen ? createdMs(user.last_seen) : null;
    const active30 = ageMs >= 30 * DAY && seen != null && now - seen <= 30 * DAY;
    const verifiedBy = [];
    if (passkey) verifiedBy.push('passkey');
    if (count(linked)) verifiedBy.push('linked_account');
    if (active30) verifiedBy.push('30_days_active');
    return {
        account_age_hours: Math.floor(ageMs / 3_600_000),
        account_age_days: Math.floor(ageMs / DAY),
        passkey: Boolean(passkey),
        linked_accounts: count(linked),
        active_30d: active30,
        email_verified: Number(user.email_verified) === 1,
        verified: verifiedBy.length > 0,
        verified_by: verifiedBy,
    };
}

module.exports = { trustSignals };
