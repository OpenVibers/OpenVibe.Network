'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — OpenCoins Wallet Core
// Atomic wallet operations backed by better-sqlite3 transactions.
// user_id here is ALWAYS the Network (SSO) user id.
//
// Idempotency: every mutation carries an idempotency_key stored on
// its coin_transactions row (UNIQUE). Replaying a key returns the
// original result without re-applying the mutation. Balances only
// ever change through coin_transactions rows, so the balance right
// after transaction N equals SUM(delta) of the user's rows with
// id <= N — which is how replays reconstruct the original result.
// ═══════════════════════════════════════════════════════════════

class WalletError extends Error {
    constructor(status, body) {
        super(body.error || 'wallet_error');
        this.status = status;
        this.body = body;
    }
}

function isPositiveInt(value) {
    return Number.isInteger(value) && value > 0;
}

function assertUser(db, userId, label = 'user_id') {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new WalletError(400, { error: `invalid_${label}` });
    }
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) {
        throw new WalletError(404, { error: 'user_not_found', [label]: id });
    }
    return id;
}

function getBalance(db, userId) {
    const row = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);
    return row ? row.balance : 0;
}

function balanceAfterTx(db, tx) {
    const row = db.prepare(
        'SELECT COALESCE(SUM(delta), 0) AS bal FROM coin_transactions WHERE user_id = ? AND id <= ?'
    ).get(tx.user_id, tx.id);
    return row.bal;
}

function findByIdempotencyKey(db, key) {
    if (!key) return null;
    return db.prepare('SELECT * FROM coin_transactions WHERE idempotency_key = ?').get(key);
}

/**
 * Apply a signed delta to a user's wallet inside the caller's transaction.
 * Inserts the coin_transactions row and updates the wallets row.
 * Throws WalletError(409, insufficient_funds) on overdraft.
 * @returns {number} the new balance
 */
function applyDelta(db, { user_id, app_id, delta, reason, ref, idempotency_key }) {
    db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)').run(user_id);
    const balance = getBalance(db, user_id);
    const next = balance + delta;
    if (next < 0) {
        throw new WalletError(409, { error: 'insufficient_funds', balance });
    }
    db.prepare(`
        INSERT INTO coin_transactions (user_id, app_id, delta, reason, ref, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(user_id, app_id || null, delta, reason || null, ref || null, idempotency_key || null);
    db.prepare('UPDATE wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(next, user_id);
    return next;
}

/**
 * Credit (sign=+1) or debit (sign=-1) a wallet. Atomic + idempotent.
 * @returns {{ balance: number, deduped: boolean }}
 */
function creditOrDebit(db, sign, { user_id, app_id, amount, reason, ref, idempotency_key }) {
    if (!isPositiveInt(amount)) {
        throw new WalletError(400, { error: 'invalid_amount', message: 'amount must be a positive integer' });
    }
    if (!idempotency_key || typeof idempotency_key !== 'string') {
        throw new WalletError(400, { error: 'missing_idempotency_key' });
    }
    const uid = assertUser(db, user_id);

    const run = db.transaction(() => {
        const existing = findByIdempotencyKey(db, idempotency_key);
        if (existing) {
            return { balance: balanceAfterTx(db, existing), deduped: true };
        }
        const balance = applyDelta(db, {
            user_id: uid,
            app_id,
            delta: sign * amount,
            reason,
            ref,
            idempotency_key,
        });
        return { balance, deduped: false };
    });
    return run();
}

function credit(db, opts) {
    return creditOrDebit(db, +1, opts);
}

function debit(db, opts) {
    return creditOrDebit(db, -1, opts);
}

/**
 * Atomic transfer between two Network users.
 * Stores two rows: the debit side carries the idempotency_key,
 * the credit side carries `${idempotency_key}:in`.
 * @returns {{ from_balance: number, to_balance: number, deduped: boolean }}
 */
function transfer(db, { from_user_id, to_user_id, app_id, amount, reason, ref, idempotency_key }) {
    if (!isPositiveInt(amount)) {
        throw new WalletError(400, { error: 'invalid_amount', message: 'amount must be a positive integer' });
    }
    if (!idempotency_key || typeof idempotency_key !== 'string') {
        throw new WalletError(400, { error: 'missing_idempotency_key' });
    }
    const fromId = assertUser(db, from_user_id, 'from_user_id');
    const toId = assertUser(db, to_user_id, 'to_user_id');
    if (fromId === toId) {
        throw new WalletError(400, { error: 'invalid_transfer', message: 'from_user_id and to_user_id must differ' });
    }

    const inKey = `${idempotency_key}:in`;
    const run = db.transaction(() => {
        const existingOut = findByIdempotencyKey(db, idempotency_key);
        if (existingOut) {
            const existingIn = findByIdempotencyKey(db, inKey);
            return {
                from_balance: balanceAfterTx(db, existingOut),
                to_balance: existingIn ? balanceAfterTx(db, existingIn) : getBalance(db, toId),
                deduped: true,
            };
        }
        const from_balance = applyDelta(db, {
            user_id: fromId, app_id, delta: -amount, reason, ref, idempotency_key,
        });
        const to_balance = applyDelta(db, {
            user_id: toId, app_id, delta: amount, reason, ref, idempotency_key: inKey,
        });
        return { from_balance, to_balance, deduped: false };
    });
    return run();
}

module.exports = {
    WalletError,
    getBalance,
    credit,
    debit,
    transfer,
};
