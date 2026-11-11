'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — OpenCoins "what changed since I last looked" (ask 273).
//
//   changes(db, userId, { currency, since, limit })
//     → { currency, balance, since, moves, parts, net, cursor, next_since, read_cursor }
//
// One move per coin_transactions row of the person, oldest first: { id, at, delta, part, reason }.
// `parts` sums the window's moves into earned / spent / received / sent and `net` is their total —
// what the bar needs for a gain or a loss with its reason. `since` is a transaction id from an
// earlier answer; omitted, the person's own stored read state answers ("since I last looked"); with
// neither, the window starts at the person's first move. `cursor` is the newest move seen (or the
// head when the window is empty) and `next_since` pages the moves; parts and net always cover the
// whole window. markRead() stores the read state (monotonic: looking backwards is refused).
//
// The buckets: earnings this ledger's reasons name (quests, fun, requests filled, merges and
// migrations) arrive as earned, anything else incoming as received; money leaving for another
// person or out of the system (tips, gifts, transfers, refunds, a deleted account's sweep) is
// sent, money consumed (redemptions, spends) is spent. Every move keeps its raw reason, so the bar
// always shows the ledger's own words beside the bucket.
//
// There is no subject parameter: the caller's user id is the only account read, so another
// person's balance is unreachable.
// ═══════════════════════════════════════════════════════════════

const money = require('../money/reasons');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const WINDOW_TXN_CAP = 5000;

/** Incoming earnings this ledger names, versus anything else arriving. */
const EARNED_RE = /^(quest:|fun:|migration:|account_merge|Media request:)/;
/** Outgoing to another person or out of the system, versus consumed. */
const SENT_RE = /(tip|gift|transfer|sent|refund|account_deleted)/i;

function partOf({ delta, reason }) {
    const r = String(reason || '');
    if (delta > 0) return EARNED_RE.test(r) ? 'earned' : 'received';
    return SENT_RE.test(r) ? 'sent' : 'spent';
}

async function txnById(db, since) {
    const id = Number(since);
    if (!Number.isInteger(id) || id <= 0) throw badCursor();
    const row = await db.prepare('SELECT id, created_at FROM coin_transactions WHERE id = ?').get(id);
    if (!row) throw badCursor();
    return row;
}

function badCursor() {
    const e = new Error('since must be a transaction id from this list');
    e.status = 422; e.code = 'coins.invalid_cursor';
    return e;
}

function badCurrency() {
    const e = new Error('currency is opencoins');
    e.status = 422; e.code = 'coins.invalid_currency';
    return e;
}

async function readCursor(db, userId, currency) {
    const row = await db.prepare('SELECT last_seen_tx AS cursor FROM coin_balance_reads WHERE user_id = ? AND currency = ?').get(userId, currency);
    return row ? Number(row.cursor) : null;
}

async function changes(db, userId, { currency = 'opencoins', since = null, limit = DEFAULT_LIMIT } = {}) {
    if (currency !== 'opencoins') throw badCurrency();
    const n = Number(limit);
    const take = Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;

    let start = null;
    if (since != null && since !== '') {
        start = await txnById(db, since);
    } else {
        const stored = await readCursor(db, userId, currency);
        if (stored) start = await txnById(db, stored);
    }

    let where = 'WHERE user_id = ?';
    const args = [userId];
    if (start) {
        where += ' AND (created_at, id) > (?, ?)';
        args.push(start.created_at, start.id);
    }
    const ids = await db.prepare(`SELECT id FROM coin_transactions ${where} ORDER BY id ASC LIMIT ?`).all(...args, WINDOW_TXN_CAP + 1);
    const truncated = ids.length > WINDOW_TXN_CAP;
    const windowIds = (truncated ? ids.slice(0, WINDOW_TXN_CAP) : ids).map((r) => Number(r.id));
    const { getBalance } = require('./wallet');
    const balance = await getBalance(db, userId);
    if (!windowIds.length) {
        const head = await db.prepare('SELECT id FROM coin_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
        return {
            currency, balance, since: start ? Number(start.id) : null, moves: [],
            parts: { earned: 0, spent: 0, received: 0, sent: 0 }, net: 0,
            cursor: head ? Number(head.id) : null, next_since: null, read_cursor: await readCursor(db, userId, currency),
        };
    }

    const holes = windowIds.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT id, app_id, delta, reason, ref, created_at FROM coin_transactions
        WHERE id IN (${holes}) ORDER BY id ASC`).all(...windowIds);

    const parts = { earned: 0, spent: 0, received: 0, sent: 0 };
    const moves = [];
    for (const r of rows) {
        const delta = Number(r.delta);
        if (!Number.isSafeInteger(delta) || delta === 0) continue;
        const part = partOf({ delta, reason: r.reason });
        parts[part] += delta;
        const d = money.describeRow(r);
        moves.push({
            id: Number(r.id), at: r.created_at, delta, part,
            label: d.text, subject: d.subject, reason_key: d.key, reason: r.reason || null,
        });
    }
    const net = parts.earned + parts.spent + parts.received + parts.sent;
    const page = moves.slice(0, take);
    return {
        currency, balance,
        since: start ? Number(start.id) : null,
        moves: page,
        parts, net,
        cursor: moves.length ? moves[moves.length - 1].id : (start ? Number(start.id) : null),
        next_since: moves.length > take ? page[page.length - 1].id : null,
        read_cursor: await readCursor(db, userId, currency),
        ...(truncated ? { truncated: true } : {}),
    };
}

/** Store "I looked": the cursor must name a real transaction and may only move forward. */
async function markRead(db, userId, { currency = 'opencoins', cursor } = {}) {
    if (currency !== 'opencoins') throw badCurrency();
    const at = await txnById(db, cursor);
    const stored = await db.prepare('SELECT last_seen_tx AS cursor FROM coin_balance_reads WHERE user_id = ? AND currency = ?').get(userId, currency);
    if (stored != null) {
        const prev = await txnById(db, stored.cursor);
        if (at.created_at < prev.created_at || (at.created_at === prev.created_at && at.id < prev.id)) {
            const e = new Error('the read cursor only moves forward');
            e.status = 409; e.code = 'coins.stale_read';
            throw e;
        }
    }
    await db.prepare(`INSERT INTO coin_balance_reads (user_id, currency, last_seen_tx, updated_at) VALUES (?, ?, ?, ov_now())
        ON CONFLICT (user_id, currency) DO UPDATE SET last_seen_tx = EXCLUDED.last_seen_tx, updated_at = EXCLUDED.updated_at`)
        .run(userId, currency, at.id);
    return { currency, read_cursor: Number(at.id) };
}

module.exports = { changes, markRead };
