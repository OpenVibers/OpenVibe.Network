'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — OpenCoins Wallet API (user-facing)
// Mounted at /api/coins. Auth: Bearer user JWT (requireAuth).
// Mutations (credit/debit/transfer) are server-to-server only —
// see /internal/coins/* in server/internal/routes.js.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const wallet = require('./wallet');
const config = require('../config');

const VIBES_TIMEOUT_MS = 2000;

module.exports = function createCoinsRoutes(db, requireAuth, opts = {}) {
    const router = express.Router();
    const billingUrl = String(opts.billingUrl || (config.services && config.services.billing && config.services.billing.internalUrl) || '').replace(/\/+$/, '');

    /** The person's Vibes (OpenVibe.Billing's spendable balance), asked with their own token; null when Billing can't say. */
    async function vibesOf(req) {
        const auth = req.headers.authorization;
        if (!billingUrl || !auth || !/^Bearer /i.test(auth)) return null;
        try {
            const r = await fetch(`${billingUrl}/api/me/vibes`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(VIBES_TIMEOUT_MS) });
            if (!r.ok) return null;
            const v = Number((await r.json()).credit);
            return Number.isFinite(v) ? v : null;
        } catch { return null; }
    }

    // ── GET /api/coins/me[?with=vibes] ───────────────────────
    // → { balance }, or with=vibes { balance, vibes }: the navbar's two balances in one request on every site, since
    // every site's connect-src allows openvibe.network and none allowed billing.openvibe.network (2026-10-28: Vibes
    // never showed beside OpenCoins). vibes is null when Billing can't answer within two seconds.
    router.get('/me', requireAuth, async (req, res) => {
        const balance = await wallet.getBalance(db, req.user.id);
        if (req.query.with !== 'vibes') return res.json({ balance });
        res.set('Cache-Control', 'private, no-store');
        res.json({ balance, vibes: await vibesOf(req) });
    });

    // ── GET /api/coins/me/history?limit=50&offset=0 ──────────
    // → { transactions: [{ id, app_id, delta, reason, created_at }] }
    router.get('/me/history', requireAuth, async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const transactions = await db.prepare(`
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
