'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — OpenCoins Wallet API (user-facing)
// Mounted at /api/coins. Auth: Bearer user JWT (requireAuth).
// Mutations (credit/debit/transfer) are server-to-server only —
// see /internal/coins/* in server/internal/routes.js.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const wallet = require('./wallet');

module.exports = function createCoinsRoutes(db, requireAuth) {
    const router = express.Router();

    // ── GET /api/coins/me ────────────────────────────────────
    // → { balance }
    router.get('/me', requireAuth, (req, res) => {
        res.json({ balance: wallet.getBalance(db, req.user.id) });
    });

    // ── GET /api/coins/me/history?limit=50&offset=0 ──────────
    // → { transactions: [{ id, app_id, delta, reason, created_at }] }
    router.get('/me/history', requireAuth, (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const transactions = db.prepare(`
            SELECT id, app_id, delta, reason, created_at
            FROM coin_transactions
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `).all(req.user.id, limit, offset);
        res.json({ transactions });
    });

    return router;
};
