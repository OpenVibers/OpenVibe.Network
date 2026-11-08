'use strict';
/**
 * Privacy-limited trust signals for accounts and anonymous guests.
 *
 *   GET /internal/identity/resolve?subject_id=usr_…&trust=1
 *
 * The usual projection plus `trust`:
 *
 *   kind                account or guest
 *   age_band            coarse age bucket
 *   account_age_hours   account age, whole hours (kept for existing readers)
 *   account_age_days    account age, whole days (kept for existing readers)
 *   passkey             a Locker passkey backup exists (server/locker/keys.js, kind 'passkey')
 *   linked_accounts     how many site accounts are linked (never which ones)
 *   active_30d          the account is at least 30 days old and was seen in the last 30 days
 *   verified            passkey, a linked account, or 30 days with activity
 *   verified_by         the facts behind `verified`
 *
 * Guest signals are aggregate counts only. Nothing private leaves: no IP, email, last-seen timestamp, service user id,
 * or linked-account identities. The existing internal projection only asks for signals when `trust=1`.
 */
const { createdMs } = require('./subjects');

const DAY = 86_400_000;
const HOUR = 3_600_000;

function ageBand(ageMs) {
    if (ageMs < HOUR) return 'under_1h';
    if (ageMs < DAY) return 'under_1d';
    if (ageMs < 7 * DAY) return 'under_7d';
    if (ageMs < 30 * DAY) return 'under_30d';
    return '30d_plus';
}

function count(row) {
    const n = Number(row && row.n);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * trustSignals(db, subjectId, { now }): privacy-limited facts for a live account or guest, or null if unknown.
 * `now` is injectable so a test can age an account without waiting.
 */
async function trustSignals(db, subjectId, { now = Date.now() } = {}) {
    if (typeof subjectId !== 'string') return null;
    if (/^gst_[0-9A-HJKMNP-TV-Z]{26}$/.test(subjectId)) {
        const guest = await db.prepare('SELECT id, anon_number, first_seen FROM anon_users WHERE subject_id = ?').get(subjectId);
        if (!guest) return null;
        const ageMs = Math.max(0, now - createdMs(guest.first_seen));
        const networks = await db.prepare('SELECT COUNT(*) AS n FROM anon_ip_log WHERE anon_id = ?').get(guest.id);
        const recentGuests = await db.prepare(`SELECT DISTINCT other.anon_id, guest.first_seen
            FROM anon_ip_log mine
            JOIN anon_ip_log other ON other.ip = mine.ip AND other.anon_id <> mine.anon_id
            JOIN anon_users guest ON guest.id = other.anon_id
            WHERE mine.anon_id = ?`).all(guest.id);
        const recentGuestCount = recentGuests.filter((row) => {
            const firstSeen = createdMs(row.first_seen);
            return firstSeen >= now - DAY && firstSeen <= now;
        }).length;
        const converted = await db.prepare(`SELECT 1 AS ok FROM users
            WHERE anon_number = ? AND COALESCE(is_anon, 0) = 0 LIMIT 1`).get(guest.anon_number);
        return {
            kind: 'guest',
            age_band: ageBand(ageMs),
            age_hours: Math.floor(ageMs / HOUR),
            age_days: Math.floor(ageMs / DAY),
            networks_seen: count(networks),
            guests_from_same_networks_24h: recentGuestCount,
            converted: Boolean(converted),
        };
    }
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subjectId)) return null;
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
        kind: 'account',
        age_band: ageBand(ageMs),
        account_age_hours: Math.floor(ageMs / HOUR),
        account_age_days: Math.floor(ageMs / DAY),
        passkey: Boolean(passkey),
        linked_accounts: count(linked),
        active_30d: active30,
        email_verified: Number(user.email_verified) === 1,
        verified: verifiedBy.length > 0,
        verified_by: verifiedBy,
    };
}

module.exports = { trustSignals, ageBand };
