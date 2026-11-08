'use strict';
/**
 * Receipts on the account home (/my, plan OpenVibe_Seven_Domains_Plan R2 item 13): the receipt-category summaries
 * Inbox AI keeps for the person's mailbox, as the "Receipts" card under Needs you.
 *
 *   GET /api/v1/me/receipts → { enabled, receipts: [{ thread_id, message_id, merchant, subject, summary,
 *                                received_at }] }
 *
 * Mail owns the mailbox, the opt-in and the rows: this route only hands the person's own token to Mail's
 * GET /api/v1/me/mail/receipts, the way My reads Billing and the other services the person already uses. With Inbox
 * AI off (or no mailbox) Mail answers `enabled: false` and no receipts, and the card asks to turn it on. If Mail is
 * away the route answers 502 and the card stays out; it never invents a receipt.
 */
const express = require('express');

const TIMEOUT_MS = 2_500;
const MAX = 200;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const text = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/** One receipt Mail may hand over, or null. Everything is bounded: this crosses two services and a page. */
function receiptOf(row) {
    if (!row || typeof row !== 'object') return null;
    const threadId = text(row.thread_id, 128);
    if (!ID_RE.test(threadId)) return null;
    const messageId = text(row.message_id, 128);
    return {
        thread_id: threadId,
        message_id: ID_RE.test(messageId) ? messageId : null,
        merchant: text(row.merchant, 160) || 'Receipt',
        subject: text(row.subject, 200),
        summary: text(row.summary, 240),
        received_at: text(row.received_at, 40) || null,
    };
}

function router({ requireAuth, mailUrl, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
    const r = express.Router();
    r.get('/', requireAuth, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        if (!req.user || req.user.is_anon) return res.json({ enabled: false, receipts: [] });
        const token = req.token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!mailUrl || !token) return res.status(502).json({ error: 'mail.unavailable' });
        try {
            const answer = await fetchImpl(`${String(mailUrl).replace(/\/+$/, '')}/api/v1/me/mail/receipts`, {
                headers: { accept: 'application/json', authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(timeoutMs),
            });
            const body = answer.ok ? await answer.json().catch(() => null) : null;
            if (!body) return res.status(502).json({ error: 'mail.unavailable' });
            const rows = Array.isArray(body.receipts) ? body.receipts : [];
            // An older Mail has no `enabled` yet: its rows can still be shown, but an empty answer is not a setting.
            const enabled = typeof body.enabled === 'boolean' ? body.enabled : rows.length > 0;
            const receipts = enabled ? rows.map(receiptOf).filter(Boolean).slice(0, MAX) : [];
            return res.json({ enabled, receipts });
        } catch {
            return res.status(502).json({ error: 'mail.unavailable' });
        }
    });
    return r;
}

module.exports = { router, receiptOf };
