'use strict';

// ═══════════════════════════════════════════════════════════════
// Notification digests — hourly/daily/weekly summaries.
// A category with a digest preference is never emailed one by one:
// this job groups its unread, undismissed notifications and sends one
// email when the period is due, then marks them emailed. Critical
// notifications never wait here (the queue emails them at once).
// Quiet hours always win: no digest is sent inside them.
// ═══════════════════════════════════════════════════════════════

const { inQuiet, zoned, rowToConfig } = require('./quiet-hours');

const DIGEST_PERIODS = new Set(['hourly', 'daily', 'weekly']);
const HOUR_MS = 60 * 60 * 1000;
const MORNING_MIN = 8 * 60;          // 08:00 local; daily and weekly wait for it
const DAILY_GAP_MS = 23 * HOUR_MS;
const WEEKLY_GAP_MS = 6.5 * 24 * HOUR_MS;
const LIST_LIMIT = 20;

/** A stored text timestamp (ov_now() or ISO) as milliseconds, or null. */
function parseStamp(value) {
    if (!value) return null;
    const text = String(value);
    const ms = Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) ? ms : null;
}

/** ov_now()'s shape: UTC 'YYYY-MM-DD HH:MM:SS'. */
function stamp(ms) {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Whether `period` is due at `nowMs`, reading the last run in the person's own zone. */
function digestDue(period, lastSentAt, nowMs, tz) {
    const last = parseStamp(lastSentAt);
    if (period === 'hourly') return last == null || nowMs - last >= HOUR_MS;
    const local = zoned(nowMs, tz);
    if (local.minute < MORNING_MIN) return false;           // not before 08:00 local
    if (period === 'daily') {
        if (last != null && nowMs - last < DAILY_GAP_MS) return false;
        // One a day: a run earlier the same local day is not repeated.
        return last == null || zoned(last, tz).day !== local.day;
    }
    if (period === 'weekly') return last == null || nowMs - last >= WEEKLY_GAP_MS;
    return false;
}

/**
 * Run every due digest. `now` may be a Date, an ISO string or milliseconds (tests move the clock).
 * Dependencies are explicit so tests and the server share the same code:
 *   runDigests(Date.now(), { db, notificationService, emailService })
 * Returns { sent, skipped }; one person's failure never stops the run.
 */
async function runDigests(now = Date.now(), { db, notificationService, emailService } = {}) {
    if (!db || !notificationService || !emailService) throw new TypeError('runDigests: db, notificationService and emailService are required');
    const nowMs = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : Number(now);
    if (!Number.isFinite(nowMs)) throw new TypeError('runDigests: invalid now');

    await emailService.ready;
    if (emailService.isEnabled === false) return { sent: 0, skipped: 0 };

    const rows = await db.prepare(`
        SELECT n.id, n.user_id, n.type, n.category, n.priority, n.title, n.message, n.service, n.url, n.created_at,
               u.email, u.username, u.display_name, u.email_verified, u.email_bounced_at,
               p.digest AS digest_period,
               q.enabled AS quiet_enabled, q.start_min AS quiet_start, q.end_min AS quiet_end, q.tz AS quiet_tz,
               r.last_sent_at
          FROM notifications n
          JOIN notification_preferences p ON p.user_id = n.user_id AND p.category = n.category
          JOIN users u ON u.id = n.user_id
          LEFT JOIN notification_quiet_hours q ON q.user_id = n.user_id
          LEFT JOIN notification_digest_runs r ON r.user_id = n.user_id AND r.period = p.digest
         WHERE n.is_emailed = 0 AND n.is_dismissed = 0 AND n.is_read = 0
           AND p.enabled = 1 AND p.digest IN ('hourly', 'daily', 'weekly')
           AND n.priority != 'critical'
         ORDER BY n.user_id, n.created_at ASC, n.seq ASC
    `).all();
    if (!rows.length) return { sent: 0, skipped: 0 };

    const users = new Map();
    for (const row of rows) {
        const key = String(row.user_id);
        let entry = users.get(key);
        if (!entry) {
            entry = {
                user: row,
                quiet: row.quiet_tz == null
                    ? rowToConfig(null)
                    : rowToConfig({ enabled: row.quiet_enabled, start_min: row.quiet_start, end_min: row.quiet_end, tz: row.quiet_tz }),
                periods: new Map(),
                lastSent: new Map(),
            };
            users.set(key, entry);
        }
        if (!entry.periods.has(row.digest_period)) entry.periods.set(row.digest_period, []);
        entry.periods.get(row.digest_period).push(row);
        entry.lastSent.set(row.digest_period, row.last_sent_at);
    }

    const markEmailed = db.prepare('UPDATE notifications SET is_emailed = 1 WHERE id = ? AND is_emailed = 0');
    const upsertRun = db.prepare(`
        INSERT INTO notification_digest_runs (user_id, period, last_sent_at)
        VALUES (?, ?, ?)
        ON CONFLICT (user_id, period) DO UPDATE SET last_sent_at = excluded.last_sent_at
    `);

    let sent = 0;
    let skipped = 0;
    for (const entry of users.values()) {
        const user = entry.user;
        try {
            // Quiet hours always win; critical items never reach this query.
            if (inQuiet(entry.quiet, nowMs)) { skipped++; continue; }
            // The same deliverability rules as the queue: a real address, not bouncing, verified.
            if (!user.email || user.email_bounced_at || !Number(user.email_verified)) { skipped++; continue; }

            for (const [period, items] of entry.periods) {
                try {
                    if (!digestDue(period, entry.lastSent.get(period), nowMs, entry.quiet.tz)) continue;
                    const cap = notificationService.emailCaps ? await notificationService.emailCaps(user.user_id) : null;
                    if (cap === 'user-cap' || cap === 'global-cap') { skipped++; continue; }
                    const ok = await emailService.sendDigestEmail({
                        to: user.email,
                        username: user.display_name || user.username,
                        userId: user.user_id,
                        period,
                        items: items.slice(0, LIST_LIMIT),
                        total: items.length,
                    });
                    if (!ok) { skipped++; continue; }
                    await db.tx(async () => {
                        for (const item of items) await markEmailed.run(item.id);
                        await upsertRun.run(user.user_id, period, stamp(nowMs));
                    });
                    sent++;
                } catch (err) {
                    skipped++;
                    console.warn(`[Digest] ${period} for user ${user.user_id} failed:`, err.message);
                }
            }
        } catch (err) {
            skipped++;
            console.warn(`[Digest] user ${user.user_id} failed:`, err.message);
        }
    }
    if (sent) console.log(`[Digest] sent ${sent} digest(s), skipped ${skipped}`);
    return { sent, skipped };
}

module.exports = { runDigests, digestDue, DIGEST_PERIODS, parseStamp, stamp, LIST_LIMIT };
