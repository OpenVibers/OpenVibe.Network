'use strict';

/**
 * Distinct visitors per site and day, for the open stats and OpenVibe.Report (11-16; the owner on openvibe.report/stats:
 * "a lot of these stats and metrics aren't working": every site but Live showed Visitors —, because the frame beacon
 * counted page views only).
 *
 *   createVisitors({ db, now, load, save }) → {
 *     seen({ ip, ua, host, dnt })   one page view's visitor: counted once per site and day (false when not counted)
 *     byDay(sinceDay)               [{ day, host, n }]: the rolled-up days and today's live count
 *     rollup(today)                 folds every earlier day's hashes into frame_visitor_days and deletes them
 *   }
 *
 * Privacy: a visitor is an HMAC of the day's random salt over the address, the browser and the host. The salt is kept
 * only for its own day (frame_cache, so a restart keeps the count), the hashes only until the day is over, and Do Not
 * Track or Global Privacy Control leave the visitor uncounted (the page view itself is counted as before). Nothing is
 * stored that could be joined to a person, an account or another day.
 */
const crypto = require('crypto');

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

function createVisitors({ db, now = () => Date.now(), load = null, save = null } = {}) {
    let salt = null;   // { day, key }
    let rolling = null;

    async function rollup(today) {
        // One statement: the rows deleted are exactly the rows counted, and a late row for a finished day adds to it.
        await db.prepare(`WITH gone AS (DELETE FROM frame_visitors WHERE day < ? RETURNING day, host)
            INSERT INTO frame_visitor_days (day, host, visitors) SELECT day, host, COUNT(*) FROM gone GROUP BY day, host
            ON CONFLICT (day, host) DO UPDATE SET visitors = frame_visitor_days.visitors + excluded.visitors`).run(today);
    }

    async function saltFor(day) {
        if (salt && salt.day === day) return salt.key;
        let kept = null;
        try { kept = load ? await load('visitor-salt') : null; } catch { kept = null; }
        const v = kept && kept.value;
        if (v && v.day === day && typeof v.key === 'string' && v.key.length >= 32) { salt = { day, key: v.key }; return salt.key; }
        salt = { day, key: crypto.randomBytes(32).toString('hex') };
        try { if (save) await save('visitor-salt', salt); } catch { /* the count still works for this process */ }
        // A new day: yesterday's hashes become a count (once per process per day).
        if (!rolling) rolling = rollup(day).catch(() => {}).finally(() => { rolling = null; });
        return salt.key;
    }

    async function seen({ ip, ua, host, dnt } = {}) {
        if (dnt || !host) return false;
        const day = dayOf(now());
        const key = await saltFor(day);
        const v = crypto.createHmac('sha256', key).update(`${ip || ''}\n${ua || ''}\n${String(host).toLowerCase()}`).digest('base64url').slice(0, 22);
        await db.prepare('INSERT INTO frame_visitors (day, host, v) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(day, String(host).toLowerCase(), v);
        return true;
    }

    async function byDay(since) {
        return db.prepare(`SELECT day, host, visitors::bigint AS n FROM frame_visitor_days WHERE day >= ?
            UNION ALL SELECT day, host, COUNT(*)::bigint AS n FROM frame_visitors WHERE day >= ? GROUP BY day, host`).all(since, since);
    }

    return { seen, byDay, rollup };
}

/** Do Not Track or Global Privacy Control on the request. */
const declined = (req) => String((req.headers && (req.headers.dnt || '')) || '') === '1' || String((req.headers && req.headers['sec-gpc']) || '') === '1';

module.exports = { createVisitors, declined, dayOf };
