'use strict';
/**
 * Realtime tickets (Contracts 0.61.0 identity.realtime-ticket-claims@1 and network.realtime-ticket-result@1;
 * ADR-005 amendment 2; roadmap WS-E task 3, WS-F task 1).
 *
 *   POST /api/v1/realtime/ticket   → 200 { ticket, expires_at, expires_in, stream_url, topics, subject }
 *
 * The notification badge on every OpenVibe site listens for the signed-in person's
 * network.notification.created events on OpenVibe.Events' /realtime/stream. An EventSource cannot send
 * a header, and events.openvibe.network's cookies are third-party on every other site, so the badge asks
 * here (Bearer Network JWT, or the ov_token cookie on openvibe.network) for a ticket and opens
 * `${stream_url}?topics=network.notification.*&ticket=…`. A ticket opens one stream: every reconnect
 * asks for a new one and resumes with last_event_id.
 *
 * A ticket is an RS256 JWT signed with Network's key: iss <issuer>/realtime, sub the person's usr_
 * subject, aud [openvibe.events], typ and purpose realtime, 120 s, jti rtk_<24 hex>. It is never a
 * session anywhere: other services check the session issuer, refuse a token with typ, and are not its
 * audience (Network's own session guard refuses typ too). Events accepts each jti once. The ticket is
 * never stored or logged, so minting one is not audited (it grants the person nothing beyond their own
 * stream); it is rate-limited instead (server/index.js).
 *
 *   401  no session (requireAuth)            403 realtime.guest  anonymous (guest) sessions
 *   503  realtime.disabled  REALTIME_TICKETS=off: every badge stays on polling
 *   503  realtime.no_subject  the account has no usr_ subject yet (retry later)
 */
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const TTL_S = 120;
const TOPICS = Object.freeze(['network.notification.*']);
const DEFAULT_STREAM_URL = 'https://events.openvibe.network/realtime/stream';

/** The stream URL browsers use: OV_EVENTS_PUBLIC_URL (an origin, or the stream URL itself) or events.openvibe.network. */
function streamUrlFrom(value) {
    const v = String(value || '').trim().replace(/\/+$/, '');
    if (!v) return DEFAULT_STREAM_URL;
    let u;
    try { u = new URL(v); } catch { return DEFAULT_STREAM_URL; }
    if (!/^https?:$/.test(u.protocol) || u.search || u.hash || u.username || u.password) return DEFAULT_STREAM_URL;
    return /\/realtime\/stream$/.test(u.pathname) ? `${u.origin}${u.pathname}` : `${u.origin}/realtime/stream`;
}

/** Sign a ticket for `subject` (usr_). → { ticket, claims } */
function mintTicket({ subject, privateKey, issuer, now = Date.now(), ttlS = TTL_S }) {
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subject))) throw new Error('realtime ticket: subject must be a usr_ id');
    if (!String(privateKey || '').includes('BEGIN')) throw new Error('realtime ticket: an RS256 private key is required');
    const iat = Math.floor(now / 1000);
    const claims = {
        iss: `${String(issuer).replace(/\/+$/, '')}/realtime`, sub: subject, aud: ['openvibe.events'],
        typ: 'realtime', purpose: 'realtime', iat, exp: iat + ttlS, jti: `rtk_${crypto.randomBytes(12).toString('hex')}`,
    };
    return { ticket: jwt.sign(claims, privateKey, { algorithm: 'RS256' }), claims };
}

/**
 * The router mounted at /api/v1/realtime. `enabled` (REALTIME_TICKETS !== 'off') is read per request
 * from `isEnabled()`, so tests and an operator's env change behave the same.
 */
function router({ db, requireAuth, privateKey, issuer, streamUrl, isEnabled = () => process.env.REALTIME_TICKETS !== 'off', now = () => Date.now() }) {
    const r = express.Router();
    const url = streamUrlFrom(streamUrl);
    r.post('/ticket', requireAuth, (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!isEnabled()) return res.status(503).json({ code: 'realtime.disabled', error: 'browser realtime is off; poll instead' });
        const user = req.user;
        if (!user || user.is_anon) return res.status(403).json({ code: 'realtime.guest', error: 'sign in with an account to get a realtime ticket' });
        let subject = user.subject_id;
        try { subject = require('../identity/subjects').ensureUserSubject(db, user) || subject; } catch { /* keep what the row has */ }
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subject || ''))) return res.status(503).json({ code: 'realtime.no_subject', error: 'this account has no subject id yet' });
        if (!String(privateKey || '').includes('BEGIN')) return res.status(503).json({ code: 'realtime.disabled', error: 'no RS256 signing key' });
        const { ticket, claims } = mintTicket({ subject, privateKey, issuer, now: now() });
        res.json({
            ticket, expires_at: new Date(claims.exp * 1000).toISOString(), expires_in: claims.exp - claims.iat,
            stream_url: url, topics: [...TOPICS], subject,
        });
    });
    return r;
}

module.exports = { router, mintTicket, streamUrlFrom, TTL_S, TOPICS, DEFAULT_STREAM_URL };
