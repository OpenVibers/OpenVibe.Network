'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — Channel points "what changed since I last looked" (ask 273).
//
// The ledger lives on OpenVibe.Live (channel_points_log, per streamer); Network reads it through
// Live's internal GET /internal/channel-points/changes with a Network service token carrying
// live.channel_points.read, and shapes it like every other currency:
//
//   changes({ live, subject, streamerId, since, limit })
//     → { currency, streamer, balance, since, moves, parts, net, cursor, next_since, read_cursor }
//
// One move per Live log row, oldest first: { id, streamer_id, at, delta, part, label, reason }.
// `parts` sums the window into earned / spent / received / sent and `net` is their total. `since`
// is a Live log id from an earlier answer; omitted, the person's own stored read state answers
// ("since I last looked"); with neither, the window starts at the first move. The read state is
// Network's own (channel_points_reads, per person per streamer); a cursor only needs to be a
// positive Live log id, and it only moves forward. markRead() stores it.
//
// The buckets: watching, chatting, following and bonus games arrive as earned, refunds back as
// received; redemptions and media requests consume as spent, anything else leaving as sent. Every
// move keeps Live's raw reason, so the bar always shows Live's own words beside the bucket.
//
// There is no subject parameter: the caller's Network subject is the only account read, so another
// person's points are unreachable.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const TIMEOUT_MS = 2500;

const LABELS = {
    watch: 'for watching the stream',
    chat: 'for chat activity',
    follow: 'for the follow',
    'bonus game': 'for the bonus game',
};

function partOf({ delta, reason }) {
    const r = String(reason || '');
    if (delta > 0) return /^(refund|returned)/i.test(r) ? 'received' : 'earned';
    return /(redeem|media)/i.test(r) ? 'spent' : 'sent';
}

function labelFor(reason) {
    const r = String(reason || '');
    if (LABELS[r]) return LABELS[r];
    if (/^redeem /i.test(r)) return 'for a channel reward';
    if (/^refund /i.test(r)) return 'returned';
    return r || 'channel points';
}

/** Live's answer, or an error with .status/.code. `live` is { url, token }. */
async function askLive(live, { subject, streamerId, since, limit }) {
    if (!live || !live.url) {
        const e = new Error('Live is not configured');
        e.status = 502; e.code = 'channel_points.unavailable';
        throw e;
    }
    const qs = new URLSearchParams({ network_user_id: subject });
    if (streamerId != null) qs.set('streamer_id', String(streamerId));
    if (since != null && since !== '') qs.set('since_id', String(since));
    if (limit != null) qs.set('limit', String(limit));
    let r;
    try {
        r = await fetch(`${live.url.replace(/\/+$/, '')}/internal/channel-points/changes?${qs}`, {
            headers: { Accept: 'application/json', ...(live.token ? { Authorization: `Bearer ${live.token}` } : {}) },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        const e = new Error('Live is unreachable');
        e.status = 502; e.code = 'channel_points.unavailable';
        throw e;
    }
    const body = await r.json().catch(() => null);
    if (r.status === 404) {
        const e = new Error('no linked live account');
        e.status = 404; e.code = 'channel_points.unlinked';
        throw e;
    }
    if (!r.ok || !body || body.ok !== true) {
        const e = new Error((body && (body.error || body.message)) || 'Live cannot say');
        e.status = r.status === 400 ? 400 : 502; e.code = 'channel_points.unavailable';
        throw e;
    }
    return body;
}

function badCursor(message = 'since must be a channel-points move id') {
    const e = new Error(message);
    e.status = 422; e.code = 'channel_points.invalid_cursor';
    return e;
}

function positiveInt(v, what) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw badCursor(`${what} is a channel-points move id`);
    return n;
}

async function readCursor(db, userId, streamerId) {
    const row = await db.prepare('SELECT last_seen_tx AS cursor FROM channel_points_reads WHERE user_id = ? AND streamer_id = ?').get(userId, streamerId);
    return row ? Number(row.cursor) : null;
}

async function changes(db, { live, userId, subject, streamerId, since = null, limit = DEFAULT_LIMIT } = {}) {
    if (!subject) {
        const e = new Error('the person has no Network subject');
        e.status = 500; e.code = 'channel_points.unavailable';
        throw e;
    }
    const streamer = positiveInt(streamerId, 'streamer');
    const n = Number(limit);
    const take = Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;

    let start = null;
    if (since != null && since !== '') {
        start = positiveInt(since, 'since');
    } else {
        const stored = await readCursor(db, userId, streamer);
        if (stored) start = stored;
    }

    const body = await askLive(live, { subject, streamerId: streamer, since: start || undefined, limit: take });
    const parts = { earned: 0, spent: 0, received: 0, sent: 0 };
    const moves = [];
    for (const m of body.moves || []) {
        const delta = Number(m.delta);
        if (!Number.isSafeInteger(delta) || delta === 0) continue;
        const part = partOf({ delta, reason: m.reason });
        parts[part] += delta;
        moves.push({
            id: Number(m.id), streamer_id: Number(m.streamer_id), at: m.at, delta, part,
            label: labelFor(m.reason), reason: m.reason || null,
        });
    }
    const net = parts.earned + parts.spent + parts.received + parts.sent;
    return {
        currency: 'channel-points', streamer,
        balance: body.balance == null ? null : Number(body.balance),
        since: start,
        moves, parts, net,
        cursor: moves.length ? moves[moves.length - 1].id : (start || null),
        next_since: body.next_since == null ? null : Number(body.next_since),
        read_cursor: await readCursor(db, userId, streamer),
    };
}

/** Store "I looked" for one channel: the cursor is a positive Live log id and only moves forward. */
async function markRead(db, userId, streamerId, cursor) {
    const streamer = positiveInt(streamerId, 'streamer');
    const at = positiveInt(cursor, 'cursor');
    const stored = await readCursor(db, userId, streamer);
    if (stored != null && at < stored) {
        const e = new Error('the read cursor only moves forward');
        e.status = 409; e.code = 'channel_points.stale_read';
        throw e;
    }
    await db.prepare(`INSERT INTO channel_points_reads (user_id, streamer_id, last_seen_tx, updated_at) VALUES (?, ?, ?, ov_now())
        ON CONFLICT (user_id, streamer_id) DO UPDATE SET last_seen_tx = EXCLUDED.last_seen_tx, updated_at = EXCLUDED.updated_at`)
        .run(userId, streamer, at);
    return { currency: 'channel-points', streamer, read_cursor: at };
}

module.exports = { changes, markRead };
