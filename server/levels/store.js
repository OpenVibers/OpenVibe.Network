'use strict';
const { levelOf, reasons, reasonName } = require('openvibe-contracts').levels;
const ACTIVE = 'COALESCE(u.is_anon, 0) = 0 AND COALESCE(u.is_banned, 0) = 0 AND u.deleted_at IS NULL AND u.merged_into IS NULL';
const PERSON_DAILY = 10000;
const SERVICE_DAILY = 1000000;
function fail(status, code) { const e = new Error(code); e.status = status; e.code = code; throw e; }
async function total(db, userId) {
    const row = await db.prepare('SELECT xp, level, leaderboard FROM person_levels WHERE user_id = ?').get(userId);
    const xp = Number(row?.xp || 0);
    return { xp, ...levelOf(xp) };
}
/** Caller owns the transaction. The service quota and person rows serialize concurrent awards. */
async function append(db, { user_id, service, reason, amount, idempotency_key, at, backfill = false }) {
    if (!reasons[reason] || !Number.isSafeInteger(amount) || amount < 1 || amount > (backfill ? 1000000000000 : PERSON_DAILY)) fail(400, 'levels.invalid_award');
    if (typeof idempotency_key !== 'string' || !idempotency_key.length || idempotency_key.length > 200) fail(400, 'levels.invalid_key');
    const user = await db.prepare(`SELECT u.id FROM users u WHERE u.id = ? AND ${ACTIVE}`).get(user_id);
    if (!user) fail(404, 'levels.person_not_found');
    const duplicate = await db.prepare('SELECT 1 FROM experience_events WHERE service = ? AND idempotency_key = ?').get(service, idempotency_key);
    if (duplicate) fail(409, 'levels.duplicate');
    if (!backfill) {
        const quota = await db.prepare(`INSERT INTO experience_service_days(service, day, amount) VALUES (?, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, ?)
            ON CONFLICT(service, day) DO UPDATE SET amount = experience_service_days.amount + EXCLUDED.amount
            WHERE experience_service_days.amount + EXCLUDED.amount <= ? RETURNING amount`).get(service, amount, SERVICE_DAILY);
        if (!quota) fail(429, 'levels.service_daily_limit');
    }
    await db.prepare('INSERT INTO person_levels(user_id) VALUES (?) ON CONFLICT DO NOTHING').run(user_id);
    const current = await db.prepare('SELECT xp FROM person_levels WHERE user_id = ? FOR UPDATE').get(user_id);
    if (!backfill) {
        const today = await db.prepare("SELECT COALESCE(SUM(amount), 0) AS amount FROM experience_events WHERE user_id = ? AND earned_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'").get(user_id);
        if (Number(today.amount) + amount > PERSON_DAILY) fail(429, 'levels.person_daily_limit');
    }
    const xp = Number(current.xp) + amount;
    if (xp > 1000000000000) fail(429, 'levels.total_limit');
    const added = await db.prepare(`INSERT INTO experience_events(user_id, service, reason, amount, idempotency_key, earned_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?::timestamptz, CURRENT_TIMESTAMP)) ON CONFLICT DO NOTHING RETURNING id`).get(user_id, service, reason, amount, idempotency_key, at || null);
    if (!added) fail(409, 'levels.duplicate');
    await db.prepare('UPDATE person_levels SET xp = ?, level = ? WHERE user_id = ?').run(xp, levelOf(xp).level, user_id);
    return { xp, ...levelOf(xp) };
}
async function award(db, service, body) {
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(body.subject || '')) fail(400, 'levels.invalid_subject');
    if (typeof body.idempotency_key !== 'string' || body.idempotency_key.length > 160) fail(400, 'levels.invalid_key');
    const user = await db.prepare('SELECT id FROM users WHERE subject_id = ?').get(body.subject);
    if (!user) fail(404, 'levels.person_not_found');
    await db.tx(() => append(db, { user_id: user.id, service, reason: body.reason, amount: body.amount, idempotency_key: body.idempotency_key }));
    return person(db, user.id);
}
async function person(db, userId) {
    const progress = await total(db, userId);
    const rank = await db.prepare(`WITH ranked AS (SELECT u.id, ROW_NUMBER() OVER (ORDER BY COALESCE(l.xp, 0) DESC, u.id) AS rank
        FROM users u LEFT JOIN person_levels l ON l.user_id = u.id WHERE ${ACTIVE} AND COALESCE(l.leaderboard, true)) SELECT rank FROM ranked WHERE id = ?`).get(userId);
    const recent = await db.prepare('SELECT reason, amount, earned_at FROM experience_events WHERE user_id = ? ORDER BY earned_at DESC, id DESC LIMIT 5').all(userId);
    return { ...progress, rank: rank ? Number(rank.rank) : null, recent: recent.map(e => ({ name: reasonName(e.reason), amount: Number(e.amount), at: new Date(e.earned_at).toISOString() })) };
}
async function byUsername(db, username) {
    const user = await db.prepare(`SELECT u.id FROM users u WHERE LOWER(u.username) = LOWER(?) AND ${ACTIVE}`).get(username);
    if (!user) fail(404, 'levels.person_not_found');
    return person(db, user.id);
}
async function batch(db, subjects) {
    if (!Array.isArray(subjects) || subjects.length > 100 || subjects.some(s => !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(s))) fail(400, 'levels.invalid_batch');
    if (!subjects.length) return { levels: {} };
    const rows = await db.prepare(`SELECT u.subject_id, COALESCE(l.level, 1) AS level FROM users u LEFT JOIN person_levels l ON l.user_id = u.id WHERE ${ACTIVE} AND u.subject_id IN (${subjects.map(() => '?').join(',')})`).all(...subjects);
    return { levels: Object.fromEntries(rows.map(r => [r.subject_id, r.level])) };
}
async function board(db, userId) {
    async function period(weekly) {
        const score = weekly ? 'COALESCE(w.xp, 0)' : 'COALESCE(l.xp, 0)';
        const rows = await db.prepare(`WITH ranked AS (
            SELECT u.id, u.subject_id AS subject, u.username, COALESCE(l.level, 1) AS level, ${score} AS xp,
            ROW_NUMBER() OVER (ORDER BY ${score} DESC, u.id) AS rank
            FROM users u LEFT JOIN person_levels l ON l.user_id = u.id
            ${weekly ? "LEFT JOIN (SELECT user_id, SUM(amount) AS xp FROM experience_events WHERE earned_at >= date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' GROUP BY user_id) w ON w.user_id = u.id" : ''}
            WHERE ${ACTIVE} AND u.subject_id IS NOT NULL AND COALESCE(l.leaderboard, true)
        ) SELECT * FROM ranked WHERE rank <= 50 OR ABS(rank - (SELECT rank FROM ranked WHERE id = ?)) <= 5 ORDER BY rank`).all(userId || 0);
        const me = rows.find(r => Number(r.id) === Number(userId));
        const clean = r => ({ subject: r.subject, username: r.username, level: Number(r.level), xp: Number(r.xp), rank: Number(r.rank) });
        return { top: rows.filter(r => Number(r.rank) <= 50).map(clean), me: me ? clean(me) : null, around: me ? rows.filter(r => Math.abs(Number(r.rank) - Number(me.rank)) <= 5).map(clean) : [] };
    }
    return { all_time: await period(false), week: await period(true) };
}
module.exports = { total, append, award, person, byUsername, batch, board, ACTIVE, PERSON_DAILY, SERVICE_DAILY };
