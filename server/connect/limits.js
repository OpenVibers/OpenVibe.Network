'use strict';
/**
 * The limits: 120 calls a minute for one person in one app, and a daily cap on top.
 *
 * The minute window is counted in the process (it is a short window, and a restart may forgive a
 * second of it). The daily cap is counted in the table, so it survives a restart and is the same for
 * every process behind the load balancer.
 */
const DEFAULT_PER_MINUTE = 120;
const DEFAULT_DAILY_CAP = 2000;

class LimitError extends Error {
    constructor(status, code, detail, retryAfter) { super(detail || code); this.status = status; this.code = code; this.detail = detail || code; this.retryAfter = retryAfter; }
}

function createLimiter({ perMinute = DEFAULT_PER_MINUTE, dailyCap = DEFAULT_DAILY_CAP, now = () => Date.now() } = {}) {
    const windows = new Map();
    const keyOf = (subject, app) => `${subject}|${app}`;

    return {
        perMinute,
        dailyCap,

        /**
         * May this person make one more call in this app now?
         * → { ok: true, remaining } | { ok: false, code, retryAfter }
         */
        async check(db, subject, app) {
            const t = now();
            const key = keyOf(subject, app);
            const cutoff = t - 60000;
            const hits = (windows.get(key) || []).filter((x) => x > cutoff);
            if (hits.length >= perMinute) {
                const retryAfter = Math.max(1, Math.ceil((hits[0] + 60000 - t) / 1000));
                windows.set(key, hits);
                return { ok: false, code: 'connect.rate_limited', retryAfter };
            }
            const day = new Date(t).toISOString().slice(0, 10);
            const row = await db.prepare('SELECT calls FROM connect_usage_daily WHERE subject = ? AND app = ? AND day = ?')
                .get(subject, app, day);
            const used = Number((row && row.calls) || 0);
            if (used >= dailyCap) {
                return { ok: false, code: 'connect.daily_cap', retryAfter: Math.max(1, Math.ceil((new Date(day + 'T00:00:00Z').getTime() + 86400000 - t) / 1000)) };
            }
            return { ok: true, remaining: perMinute - hits.length - 1 };
        },

        /** One call has been made: it counts in the minute window and in the day's counter. */
        async record(db, subject, app) {
            const t = now();
            const key = keyOf(subject, app);
            const cutoff = t - 60000;
            const hits = (windows.get(key) || []).filter((x) => x > cutoff);
            hits.push(t);
            windows.set(key, hits);
            const day = new Date(t).toISOString().slice(0, 10);
            await db.prepare(`INSERT INTO connect_usage_daily (subject, app, day, calls) VALUES (?, ?, ?, 1)
                              ON CONFLICT (subject, app, day) DO UPDATE SET calls = connect_usage_daily.calls + 1`)
                .run(subject, app, day);
            return { used: hits.length };
        },

        /** Forget the windows (a test, and a restart of the process). */
        reset() { windows.clear(); },
    };
}

module.exports = { createLimiter, LimitError, DEFAULT_PER_MINUTE, DEFAULT_DAILY_CAP };
