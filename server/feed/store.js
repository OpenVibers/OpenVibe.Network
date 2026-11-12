'use strict';

/**
 * The feed store — pure SQL over feed_items (migrations/0080_feed.sql).
 *
 * One row per source item, keyed by (service, type, id). Re-recording the same source refreshes its
 * words, link and picture; provenance (when it happened, who it is about) is what the first record
 * said unless the source says `touch` (a wiki page edited again, a busy chat hour still filling).
 *
 * Live is the exception: a dropped connection starts a new Live session (a new stream id) but it is
 * the same broadcast. upsertLiveItem keeps one item for the same person (or channel URL) and title
 * within six hours and moves its time to the newest start.
 *
 * Privacy is a property of the row: only 'public' or 'followers' exists here. listItems() never
 * returns a followers item to anyone but its author or a follower, and never returns a test
 * account's item (users.is_test), whatever the source said.
 */
const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
const COLUMNS = 'id, source_service, source_type, source_id, kind, title, text, url, site, site_name, actor_subject, actor_name, origin, visibility, picture_url, preview_url, media_ratio, media_length, counts, live_now, label, starts_at, occurred_at, trend';

const iso = (v) => {
    if (v == null || v === '') return null;
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const ms = (v) => { const t = Date.parse(String(v == null ? '' : v)); return Number.isFinite(t) ? t : NaN; };
const countsJson = (v) => {
    if (!v || typeof v !== 'object') return '{}';
    const out = {};
    for (const k of ['views', 'likes', 'comments', 'watchers', 'people']) {
        const n = Number(v[k]);
        if (Number.isSafeInteger(n) && n >= 0) out[k] = n;
    }
    return JSON.stringify(out);
};

/** → { item, created } */
async function upsertItem(db, it) {
    const at = iso(it.occurred_at) || new Date().toISOString();
    const key = [it.source_service, it.source_type, String(it.source_id)];
    const find = db.prepare(`SELECT ${COLUMNS} FROM feed_items WHERE source_service = ? AND source_type = ? AND source_id = ?`);
    return await db.tx(async () => {
        const had = await find.get(...key);
        const values = [
            String(it.kind), String(it.title || '').slice(0, 300), it.text == null ? null : String(it.text).slice(0, 300),
            String(it.url), String(it.site || it.source_service).slice(0, 40), String(it.site_name || it.site || it.source_service).slice(0, 40),
            it.actor_subject || null, it.actor_name ? String(it.actor_name).slice(0, 80) : null, it.origin || 'user',
            it.visibility === 'followers' ? 'followers' : 'public',
            it.picture_url || null, it.preview_url || null,
            Number.isFinite(Number(it.media_ratio)) && Number(it.media_ratio) > 0 ? Number(it.media_ratio) : null,
            Number.isFinite(Number(it.media_length)) && Number(it.media_length) >= 0 ? Math.round(Number(it.media_length)) : null,
            countsJson(it.counts), it.live_now === true, it.trend && typeof it.trend === 'object' ? JSON.stringify(it.trend) : null, it.label || null, iso(it.starts_at), at,
        ];
        if (had) {
            const moving = it.touch === true;
            await db.prepare(`UPDATE feed_items SET kind = ?, title = ?, text = ?, url = ?, site = ?, site_name = ?,
                    actor_subject = COALESCE(actor_subject, ?), actor_name = COALESCE(actor_name, ?), origin = ?, visibility = ?,
                    picture_url = ?, preview_url = ?, media_ratio = ?, media_length = ?, counts = ?, live_now = ?, trend = ?, label = ?, starts_at = ?,
                    occurred_at = CASE WHEN ? THEN ? ELSE occurred_at END, updated_at = now()
                WHERE source_service = ? AND source_type = ? AND source_id = ?`)
                .run(...values.slice(0, 19), moving ? true : false, at, ...key);
            return { item: await find.get(...key), created: false };
        }
        await db.prepare(`INSERT INTO feed_items (source_service, source_type, source_id, kind, title, text, url, site, site_name,
                actor_subject, actor_name, origin, visibility, picture_url, preview_url, media_ratio, media_length, counts, live_now, trend, label, starts_at, occurred_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(...key, ...values);
        return { item: await find.get(...key), created: true };
    });
}

/** A live.stream.started item: one row per broadcast, not per reconnect. → { item, created } */
async function upsertLiveItem(db, it) {
    const key = [it.source_service, it.source_type, String(it.source_id)];
    const find = db.prepare(`SELECT ${COLUMNS} FROM feed_items WHERE source_service = ? AND source_type = ? AND source_id = ?`);
    return await db.tx(async () => {
        const had = await find.get(...key);
        if (had) return { item: had, created: false };
        const at = ms(it.occurred_at);
        const actor = it.actor_subject || null;
        if (Number.isFinite(at)) {
            const candidates = actor
                ? await db.prepare(`SELECT ${COLUMNS} FROM feed_items WHERE source_service = 'live' AND source_type = 'stream'
                        AND title = ? AND ((actor_subject IS NOT NULL AND actor_subject = ?) OR url = ?)
                        ORDER BY occurred_at DESC, id DESC`).all(it.title, actor, it.url)
                : await db.prepare(`SELECT ${COLUMNS} FROM feed_items WHERE source_service = 'live' AND source_type = 'stream'
                        AND title = ? AND url = ? ORDER BY occurred_at DESC, id DESC`).all(it.title, it.url);
            let prior = null; let priorAt = -Infinity;
            for (const c of candidates) {
                const t = ms(c.occurred_at);
                if (Number.isFinite(t) && t <= at && at - t <= LIVE_WINDOW_MS && t > priorAt) { prior = c; priorAt = t; }
            }
            if (prior) {
                if (at > priorAt) await db.prepare('UPDATE feed_items SET occurred_at = ?, updated_at = now() WHERE id = ?').run(iso(it.occurred_at), prior.id);
                return { item: await db.prepare(`SELECT ${COLUMNS} FROM feed_items WHERE id = ?`).get(prior.id), created: false };
            }
        }
        return await upsertItem(db, it);
    });
}

async function removeItem(db, service, type, id) {
    const r = await db.prepare('DELETE FROM feed_items WHERE source_service = ? AND source_type = ? AND source_id = ?').run(service, type, String(id));
    return Number(r.changes || 0);
}

/** Remove every item a source no longer lists (a gallery page, a recordings feed): the kept ids survive. */
async function removeMissing(db, service, type, keepIds) {
    const keep = new Set([...keepIds].map(String));
    const rows = await db.prepare('SELECT source_id FROM feed_items WHERE source_service = ? AND source_type = ?').all(service, type);
    let removed = 0;
    for (const row of rows) if (!keep.has(String(row.source_id))) removed += await removeItem(db, service, type, row.source_id);
    return removed;
}

/** What a person follows: their active targets (the channel targets Network's follow graph keeps). */
async function followedSubjects(db, subject) {
    if (!subject) return [];
    const rows = await db.prepare("SELECT target_id FROM user_follows WHERE follower_subject = ? AND active = 1 AND target_type = 'channel'").all(subject);
    return [...new Set(rows.map((r) => String(r.target_id)).filter((x) => /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(x)))];
}

/**
 * What the person opens: the services in their recent cross-site history (server/history/routes.js),
 * most used first. A small affinity boost, never a filter.
 */
async function affinityServices(db, userId) {
    if (!userId) return new Map();
    const rows = await db.prepare('SELECT service, COUNT(*) AS n FROM user_history WHERE user_id = ? AND service IS NOT NULL GROUP BY service ORDER BY n DESC LIMIT 12').all(userId);
    return new Map(rows.map((r) => [String(r.service), Number(r.n) || 0]));
}

/**
 * Newest first, keyset-paginated by (occurred_at, id). Filters:
 *   opts.kind, opts.site, opts.q        the chips and the search
 *   opts.followed, opts.following       the person's follow graph
 *   opts.before                         [at, id] of the last row already read
 *   opts.viewerSubject                  the signed-in reader (their own followers items)
 *   opts.since                          only this recent (the collectors read the last 7 days)
 * → { rows, hasMore }
 */
async function listItems(db, { kind = '', site = '', q = '', followed = [], following = false, before = null, viewerSubject = null, limit = 40, since = null, skipBursts = [] } = {}) {
    const where = [];
    const args = [];
    // A burst an earlier page showed as one card (its kind, site and UTC hour, no person): its rows are not read again.
    for (const b of (skipBursts || []).slice(0, 8)) {
        const from = new Date(`${b.hour}:00:00.000Z`);
        if (Number.isNaN(from.getTime())) continue;
        where.push('NOT (i.kind = ? AND i.site = ? AND i.actor_subject IS NULL AND i.occurred_at >= ? AND i.occurred_at < ?)');
        args.push(b.kind, b.site, from.toISOString(), new Date(from.getTime() + 3600_000).toISOString());
    }
    if (kind) { where.push('i.kind = ?'); args.push(kind); }
    if (site) { where.push('i.site = ?'); args.push(site); }
    if (q) { where.push('(i.title ILIKE ? OR i.text ILIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    if (since) { where.push('i.occurred_at >= ?'); args.push(since); }
    if (following) {
        if (!followed.length) return { rows: [], hasMore: false };
        where.push(`i.actor_subject IN (${followed.map(() => '?').join(', ')})`);
        args.push(...followed);
    }
    if (viewerSubject) {
        const list = followed.length ? followed.map(() => '?').join(', ') : null;
        where.push(`(i.visibility = 'public' OR (i.visibility = 'followers' AND (i.actor_subject = ?${list ? ` OR i.actor_subject IN (${list})` : ''})))`);
        args.push(viewerSubject, ...followed);
    } else {
        where.push("i.visibility = 'public'");
    }
    // A test account's activity never reaches a public feed, signed in or not (users.is_test; the same
    // rule as Network's stats and home). The actor's own row still shows them their own item.
    where.push(`(i.actor_subject IS NULL OR i.actor_subject = ? OR NOT EXISTS (
        SELECT 1 FROM users u WHERE u.subject_id = i.actor_subject AND COALESCE(u.is_test, 0) = 1))`);
    args.push(viewerSubject);
    if (before) { where.push('(i.occurred_at < ? OR (i.occurred_at = ? AND i.id < ?))'); args.push(before[0], before[0], Number(before[1])); }
    const rows = await db.prepare(`SELECT ${COLUMNS} FROM feed_items i WHERE ${where.join(' AND ')}
        ORDER BY i.occurred_at DESC, i.id DESC LIMIT ?`).all(...args, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { rows, hasMore };
}

/** How many public rows a burst holds: one site's rows of one kind with no person, in one UTC hour ('2026-11-12T17'). */
async function countBulk(db, { kind, site, hour }) {
    if (!/^\d{4}-\d\d-\d\dT\d\d$/.test(String(hour || ''))) return 0;
    const from = new Date(`${hour}:00:00.000Z`).toISOString();
    const to = new Date(Date.parse(from) + 3600_000).toISOString();
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM feed_items WHERE kind = ? AND site = ? AND actor_subject IS NULL
        AND visibility = 'public' AND occurred_at >= ? AND occurred_at < ?`).get(kind, site, from, to);
    return Number(row && row.n) || 0;
}

/**
 * Where the burst a page ended in begins, when the rest of it is only that burst: the oldest row of one site's run of
 * one kind with no person in the same UTC hour, older than `before`, with no other public row between them. Null when
 * something else sits in that span (a person's post is never skipped).
 */
async function burstStart(db, { kind, site, before }) {
    const at = String(before && before[0] || '');
    const hour = new Date(at).toISOString().slice(0, 13);
    const from = new Date(`${hour}:00:00.000Z`).toISOString();
    const first = await db.prepare(`SELECT MIN(occurred_at) AS at FROM feed_items WHERE kind = ? AND site = ? AND actor_subject IS NULL
        AND visibility = 'public' AND occurred_at >= ? AND occurred_at < ?`).get(kind, site, from, at);
    if (!first || !first.at) return null;
    const other = await db.prepare(`SELECT 1 FROM feed_items WHERE visibility = 'public' AND occurred_at >= ? AND occurred_at < ?
        AND NOT (kind = ? AND site = ? AND actor_subject IS NULL) LIMIT 1`).get(first.at, at, kind, site);
    return other ? null : iso(first.at);
}

module.exports = { upsertItem, upsertLiveItem, removeItem, removeMissing, followedSubjects, affinityServices, listItems, countBulk, burstStart, iso, ms };
