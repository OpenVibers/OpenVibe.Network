'use strict';
/**
 * The Events delivery operator view (roadmap WS-F task 3): Network's admin reads OpenVibe.Events'
 * dead-letter queue and replays deliveries through Events' own operator API, with a self-signed
 * 5-minute service token (sub svc:network, aud openvibe.events, cap events.delivery.admin; Network
 * is the token issuer). Owner-only; every replay is written to audit_log.
 *
 *   GET  /api/admin/events/deliveries?status=dead|failed|pending|delivered&subscription_id=&after_seq=&limit=
 *   POST /api/admin/events/replay      { subscription_id, event_ids: [...] } or { subscription_id, from_seq }
 *
 * Off (503) without OV_EVENTS_INTERNAL_URL.
 */
const crypto = require('crypto');
const express = require('express');
const { serviceAuth, assertValid } = require('openvibe-contracts');
const { requireOwner } = require('../auth/owner-guard');

const TTL_S = 300;
const SUB_RE = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;
const EVT_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;

function createEventsOps({ db, eventsUrl, privateKey, issuer, fetchImpl = globalThis.fetch }) {
    const base = String(eventsUrl || '').replace(/\/+$/, '');
    let cached = null;
    function token() {
        const now = Math.floor(Date.now() / 1000);
        if (cached && cached.exp - 60 > now) return cached.token;
        const claims = {
            iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.events'], cap: ['events.delivery.admin'],
            iat: now, exp: now + TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
        };
        assertValid('identity.service-token-claims@1', claims);
        cached = { token: serviceAuth.signServiceToken(claims, privateKey), exp: claims.exp };
        return cached.token;
    }
    async function call(method, path, body) {
        const res = await fetchImpl(`${base}${path}`, {
            method, headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
    }

    const r = express.Router();
    r.use(requireOwner);
    r.use((req, res, next) => (base ? next() : res.status(503).json({ ok: false, error: 'OV_EVENTS_INTERNAL_URL is not set' })));
    r.get('/deliveries', async (req, res) => {
        const q = new URLSearchParams();
        const status = ['dead', 'failed', 'pending', 'delivered'].includes(req.query.status) ? req.query.status : 'dead';
        q.set('status', status);
        if (SUB_RE.test(String(req.query.subscription_id || ''))) q.set('subscription_id', req.query.subscription_id);
        const after = parseInt(req.query.after_seq, 10);
        if (Number.isSafeInteger(after) && after > 0) q.set('after_seq', String(after));
        q.set('limit', String(Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)));
        try {
            const out = await call('GET', `/api/v1/deliveries?${q}`);
            res.set('Cache-Control', 'private, no-store');
            res.status(out.status === 200 ? 200 : 502).json(out.status === 200 ? { ok: true, ...out.data } : { ok: false, error: `Events answered ${out.status}`, detail: out.data && (out.data.detail || out.data.title) });
        } catch (err) {
            res.status(502).json({ ok: false, error: `Events did not answer: ${err.message}` });
        }
    });
    r.post('/replay', express.json({ limit: '64kb' }), async (req, res) => {
        const b = req.body || {};
        if (!SUB_RE.test(String(b.subscription_id || ''))) return res.status(400).json({ ok: false, error: 'subscription_id is required' });
        const ids = Array.isArray(b.event_ids) ? b.event_ids.map(String) : null;
        const fromSeq = Number.isSafeInteger(b.from_seq) && b.from_seq >= 0 ? b.from_seq : null;
        if ((ids === null) === (fromSeq === null)) return res.status(400).json({ ok: false, error: 'pass exactly one of event_ids or from_seq' });
        if (ids && (!ids.length || ids.length > 1000 || !ids.every((id) => EVT_RE.test(id)))) return res.status(400).json({ ok: false, error: 'event_ids: 1 to 1000 event ids' });
        try {
            const out = await call('POST', '/api/v1/deliveries/replay', ids ? { subscription_id: b.subscription_id, event_ids: ids } : { subscription_id: b.subscription_id, from_seq: fromSeq });
            if (out.status !== 200) return res.status(out.status === 404 ? 404 : 502).json({ ok: false, error: `Events answered ${out.status}`, detail: out.data && (out.data.detail || out.data.title) });
            db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(req.user.id, 'events_replay',
                JSON.stringify({ subscription_id: b.subscription_id, event_ids: ids ? ids.slice(0, 50) : undefined, event_count: ids ? ids.length : undefined, from_seq: fromSeq ?? undefined, queued: out.data.queued }));
            res.json({ ok: true, queued: out.data.queued });
        } catch (err) {
            res.status(502).json({ ok: false, error: `Events did not answer: ${err.message}` });
        }
    });
    return r;
}

module.exports = { createEventsOps };
