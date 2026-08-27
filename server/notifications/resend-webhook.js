'use strict';
// ═══════════════════════════════════════════════════════════════
// Resend delivery webhooks (Svix-signed). Bounces and complaints suppress further mail
// to the address; a hard bounce also clears the verified flag so the user has to
// re-confirm after fixing it. Configure in Resend: Webhooks → https://openvibe.network/api/webhooks/resend
// and paste the signing secret (whsec_…) into site_settings.resend_webhook_secret.
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');

function verifySvix(secret, headers, rawBody) {
    const id = headers['svix-id'], ts = headers['svix-timestamp'], sig = headers['svix-signature'];
    if (!id || !ts || !sig) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;            // 5-min replay window
    const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
    const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
    return String(sig).split(' ').some(part => {
        const v = part.split(',')[1];
        if (!v || v.length !== expected.length) return false;
        try { return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)); } catch { return false; }
    });
}

module.exports = function resendWebhook() {
    const router = express.Router();
    router.post('/resend', express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
        const db = req.app.locals.db;
        const secret = db.getSetting('resend_webhook_secret');
        const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
        if (!secret) { console.warn('[Resend webhook] received but resend_webhook_secret is not configured — ignored'); return res.status(503).json({ ok: false }); }
        if (!verifySvix(secret, req.headers, raw)) return res.status(401).json({ ok: false, error: 'bad signature' });
        let evt; try { evt = JSON.parse(raw); } catch { return res.status(400).json({ ok: false }); }
        const type = String(evt?.type || '');
        const to = [].concat(evt?.data?.to || []).map(s => String(s).toLowerCase());
        if (!to.length) return res.json({ ok: true });
        if (type === 'email.bounced' || type === 'email.complained') {
            const reason = type === 'email.complained' ? 'complaint' : (evt?.data?.bounce?.message || evt?.data?.bounce?.type || 'bounce');
            const stmt = db.prepare("UPDATE users SET email_bounced_at = CURRENT_TIMESTAMP, email_bounce_reason = ?, email_verified = CASE WHEN ? = 'complaint' THEN email_verified ELSE 0 END WHERE LOWER(email) = ?");
            let n = 0;
            for (const addr of to) n += stmt.run(String(reason).slice(0, 200), type === 'email.complained' ? 'complaint' : 'bounce', addr).changes;
            console.warn(`[Resend webhook] ${type} for ${to.join(',')} — ${n} account(s) suppressed`);
            try { db.prepare("INSERT INTO email_delivery_log (email_type, recipient, subject, status, error_message, metadata) VALUES (?, ?, ?, 'failed', ?, ?)").run(`webhook:${type}`, to[0], null, String(reason).slice(0, 200), JSON.stringify({ event: type })); } catch { /* */ }
        }
        res.json({ ok: true });
    });
    return router;
};
