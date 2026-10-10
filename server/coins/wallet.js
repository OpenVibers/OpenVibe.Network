'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — OpenCoins Wallet Core
// Atomic wallet operations backed by database transactions.
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

async function assertUser(db, userId, label = 'user_id') {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new WalletError(400, { error: `invalid_${label}` });
    }
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) {
        throw new WalletError(404, { error: 'user_not_found', [label]: id });
    }
    return id;
}

async function getBalance(db, userId) {
    const row = await db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId);
    return row ? row.balance : 0;
}

async function balanceAfterTx(db, tx) {
    const row = await db.prepare(
        'SELECT COALESCE(SUM(delta), 0)::bigint AS bal FROM coin_transactions WHERE user_id = ? AND id <= ?'
    ).get(tx.user_id, tx.id);
    return row.bal;
}

async function findByIdempotencyKey(db, key) {
    if (!key) return null;
    return await db.prepare('SELECT * FROM coin_transactions WHERE idempotency_key = ?').get(key);
}

/**
 * Apply a signed delta to a user's wallet inside the caller's transaction.
 * Inserts the coin_transactions row and updates the wallets row.
 * Throws WalletError(409, insufficient_funds) on overdraft.
 * @returns {number} the new balance
 */
async function applyDelta(db, { user_id, app_id, delta, reason, ref, idempotency_key }) {
    await db.prepare('INSERT INTO wallets (user_id, balance) VALUES(?, 0) ON CONFLICT DO NOTHING').run(user_id);
    // The balance moves with one conditional UPDATE: of two concurrent spends of one wallet exactly one
    // succeeds even at the same starting balance (decision 1, plan T2). The WHERE keeps it from going
    // negative and RETURNING-less: the caller's transaction sees its own write below.
    const moved = (await db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ov_now() WHERE user_id = ? AND balance + ? >= 0').run(delta, user_id, delta)).changes;
    if (!moved) {
        throw new WalletError(409, { error: 'insufficient_funds', balance: await getBalance(db, user_id) });
    }
    await db.prepare(`
        INSERT INTO coin_transactions (user_id, app_id, delta, reason, ref, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(user_id, app_id || null, delta, reason || null, ref || null, idempotency_key || null);
    return await getBalance(db, user_id);
}

/**
 * Credit (sign=+1) or debit (sign=-1) a wallet. Atomic + idempotent.
 * @returns {{ balance: number, deduped: boolean }}
 */
async function creditOrDebit(db, sign, { user_id, app_id, amount, reason, ref, idempotency_key }) {
    if (!isPositiveInt(amount)) {
        throw new WalletError(400, { error: 'invalid_amount', message: 'amount must be a positive integer' });
    }
    if (!idempotency_key || typeof idempotency_key !== 'string') {
        throw new WalletError(400, { error: 'missing_idempotency_key' });
    }
    const uid = await assertUser(db, user_id);

    const run = db.txFn(async () => {
        const existing = await findByIdempotencyKey(db, idempotency_key);
        if (existing) {
            return { balance: await balanceAfterTx(db, existing), deduped: true };
        }
        const balance = await applyDelta(db, {
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

async function credit(db, opts) {
    return await creditOrDebit(db, +1, opts);
}

async function debit(db, opts) {
    return await creditOrDebit(db, -1, opts);
}

/**
 * Atomic transfer between two Network users.
 * Stores two rows: the debit side carries the idempotency_key,
 * the credit side carries `${idempotency_key}:in`.
 * @returns {{ from_balance: number, to_balance: number, deduped: boolean }}
 */
async function transfer(db, { from_user_id, to_user_id, app_id, amount, reason, ref, idempotency_key }) {
    if (!isPositiveInt(amount)) {
        throw new WalletError(400, { error: 'invalid_amount', message: 'amount must be a positive integer' });
    }
    if (!idempotency_key || typeof idempotency_key !== 'string') {
        throw new WalletError(400, { error: 'missing_idempotency_key' });
    }
    const fromId = await assertUser(db, from_user_id, 'from_user_id');
    const toId = await assertUser(db, to_user_id, 'to_user_id');
    if (fromId === toId) {
        throw new WalletError(400, { error: 'invalid_transfer', message: 'from_user_id and to_user_id must differ' });
    }

    const inKey = `${idempotency_key}:in`;
    const run = db.txFn(async () => {
        const existingOut = await findByIdempotencyKey(db, idempotency_key);
        if (existingOut) {
            const existingIn = await findByIdempotencyKey(db, inKey);
            return {
                from_balance: await balanceAfterTx(db, existingOut),
                to_balance: existingIn ? await balanceAfterTx(db, existingIn) : await getBalance(db, toId),
                deduped: true,
            };
        }
        const from_balance = await applyDelta(db, {
            user_id: fromId, app_id, delta: -amount, reason, ref, idempotency_key,
        });
        const to_balance = await applyDelta(db, {
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
